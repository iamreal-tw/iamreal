// Command iamreal-verify re-verifies a log file, or a published proof log
// directory with its record hash lists and fingerprint file, by default the
// one published at https://data.iamreal.tw/ with its CRL archive: whether
// the proof log as a whole is valid, the result of each record, and the state
// of every card and account (spec/record-rules.md). See README.md.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

// Exit codes.
const (
	exitAllValid = 0 // the file is valid and every record is valid
	exitInvalid  = 1 // the file is broken, a record is invalid, the CRL archive's index differs from its files, a record hash list or the fingerprint file has a problem, or the card state file is broken or has a card that differs
	exitError    = 2 // the check could not be made
)

// testOptions is set only in a build with the tag iamrealtest
// (testissuers.go): options that let a test use throwaway issuer keys. The
// program built as README.md says has no such option.
var testOptions func(fs *flag.FlagSet) func(*deps) error

func main() {
	// An interrupted command removes what it downloaded too.
	interrupted := make(chan os.Signal, 1)
	signal.Notify(interrupted, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-interrupted
		removeTempDirs()
		os.Exit(exitError)
	}()
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, deps{newVerifier, openArchive(crl.MOICAKeys)}))
}

// deps makes the verifier and opens the CRL archive. Tests replace them to
// use test issuer keys; the program uses only MOICA's.
type deps struct {
	verifier func(verifier.Config) (prooflog.ProofVerifier, error)
	// archive opens the archive directory dir: reading only its index if
	// trustIndex, otherwise rebuilding the index from the files. When
	// rebuilding, it also returns every difference between the index and
	// the rebuilt one; the archive is that of the rebuilt index.
	archive func(files crlFiles, trustIndex bool, progress func(name string)) (prooflog.CRLArchive, []crl.IndexMismatch, error)
}

func newVerifier(cfg verifier.Config) (prooflog.ProofVerifier, error) { return verifier.New(cfg) }

// openArchive opens an archive whose CRLs are checked under keys.
func openArchive(keys func() ([]crl.NamedKey, error)) func(crlFiles, bool, func(string)) (prooflog.CRLArchive, []crl.IndexMismatch, error) {
	return func(files crlFiles, trustIndex bool, progress func(string)) (prooflog.CRLArchive, []crl.IndexMismatch, error) {
		if trustIndex {
			a, err := crl.ReadArchiveIndex(files.dir)
			if err != nil {
				return nil, nil, err
			}
			return archive{a}, nil, nil
		}
		k, err := keys()
		if err != nil {
			return nil, nil, err
		}
		var a *crl.Archive
		var diffs []crl.IndexMismatch
		if files.remote {
			// One file at a time, from the URL (crlFiles).
			a, diffs, err = crl.RebuildArchiveOf(files.index, files.hasIndex, files.files, k, progress)
		} else {
			a, diffs, err = crl.RebuildArchive(files.dir, k, progress)
		}
		if err != nil {
			return nil, nil, err
		}
		return archive{a}, diffs, nil
	}
}

// archive is a crl.Archive as prooflog.CRLArchive: crl/ imports nothing of the
// repository, so its dates are strings.
type archive struct{ a *crl.Archive }

func (c archive) CRLDates(issuer, smtRoot string) ([]verifier.Date, error) {
	ds, err := c.a.CRLDates(issuer, smtRoot)
	if err != nil {
		return nil, err
	}
	out := make([]verifier.Date, len(ds))
	for i, d := range ds {
		if out[i], err = verifier.ParseDate(d); err != nil {
			return nil, fmt.Errorf("CRL archive: date %q: %v", d, err)
		}
	}
	return out, nil
}

// noArchive is the CRL archive when none is given: no root is recognized,
// so every record that verifies gets `root`.
type noArchive struct{}

func (noArchive) CRLDates(string, string) ([]verifier.Date, error) { return nil, nil }

func run(args []string, stdout, stderr io.Writer, d deps) int {
	fs := flag.NewFlagSet("iamreal-verify", flag.ContinueOnError)
	fs.SetOutput(stderr)
	bb := fs.String("bb", "", "path of the `bb` 6.0.0 executable (required)")
	crs := fs.String("crs", "", "`directory` holding "+verifier.CRSFile+" (required)")
	timeout := fs.Duration("timeout", verifier.DefaultTimeout, "time one `bb verify` may take before the proof counts as rejected")
	kind := fs.String("proof-log", "production", "whose accepted scopes apply: production or test")
	asJSON := fs.Bool("json", false, "print the result as JSON")
	data := fs.String("data", defaultData, "`URL or directory` of the published files, without a log file: the log directory under proof-log/, the CRL archive under crl/")
	archiveDir := fs.String("crl-archive", "", "`directory` of the CRL archive, with its index "+crl.IndexFileName+", for a log file or directory; without it no root is recognized")
	trustIndex := fs.Bool("crl-trust-index", false, "read only the archive's index, without checking it against the CRL files")
	cardState := fs.String("card-state", "", "`date` (YYYY-MM-DD) of the card state file to compare, for a log directory; by default that of the fingerprint file's last line")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: iamreal-verify -bb <bb> -crs <dir> [flags] [log file | log directory | -]")
		fs.PrintDefaults()
	}
	var applyTestOptions func(*deps) error
	if testOptions != nil {
		applyTestOptions = testOptions(fs)
	}
	if err := fs.Parse(args); err != nil {
		return exitError
	}
	if applyTestOptions != nil {
		if err := applyTestOptions(&d); err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
			return exitError
		}
	}
	if fs.NArg() > 1 || *bb == "" || *crs == "" {
		fs.Usage()
		return exitError
	}
	var r verifier.ProofLog
	switch *kind {
	case "production":
		r = verifier.Production
	case "test":
		r = verifier.Test
	default:
		fmt.Fprintf(stderr, "iamreal-verify: -proof-log %q: want production or test\n", *kind)
		return exitError
	}
	given := map[string]bool{} // the flags given on the command line
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	// What to read: a log file or directory with -crl-archive, or else
	// the published files at -data.
	var input string
	var dirSrc source // the log directory, if the proof log is one
	var crlSrc source // the CRL archive at -data, if read from there
	without := everyFileWithoutCount
	if fs.NArg() == 1 {
		if given["data"] {
			fmt.Fprintln(stderr, "iamreal-verify: -data reads the proof log from the published files: give it or a log file, not both")
			return exitError
		}
		input = fs.Arg(0)
		if input != "-" {
			if info, err := os.Stat(input); err == nil && info.IsDir() {
				dirSrc = dirSource(input)
			}
		}
	} else {
		if *archiveDir != "" {
			fmt.Fprintln(stderr, "iamreal-verify: -crl-archive goes with a log file; with -data the archive is its crl/")
			return exitError
		}
		src, err := openSource(*data)
		if err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: -data: %v\n", err)
			return exitError
		}
		dirSrc, crlSrc, without = src.sub("proof-log"), src.sub("crl"), noneWithoutCount
		fmt.Fprintf(stderr, "iamreal-verify: reading the published files at %s\n", src)
	}
	var cardStateDate *verifier.Date // the date asked for by -card-state
	if *cardState != "" {
		if dirSrc == nil {
			fmt.Fprintln(stderr, "iamreal-verify: -card-state goes with a log directory or -data: a log file has no fingerprint file")
			return exitError
		}
		date, err := verifier.ParseDate(*cardState)
		if err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: -card-state %q: %v\n", *cardState, err)
			return exitError
		}
		cardStateDate = &date
	}
	if *trustIndex && *archiveDir == "" && crlSrc == nil {
		fmt.Fprintln(stderr, "iamreal-verify: -crl-trust-index needs -crl-archive")
		return exitError
	}
	var proofLogFile []byte
	var pub *publishedProofLog
	var err error
	if dirSrc != nil {
		if pub, err = readPublished(dirSrc, without); err == nil {
			proofLogFile = pub.data
			switch {
			case pub.published != nil:
				fmt.Fprintf(stderr, "iamreal-verify: %s: %d record(s) published; later records are not checked\n", fingerprintsFileName, *pub.published)
			case without == noneWithoutCount:
				fmt.Fprintf(stderr, "iamreal-verify: %s does not say how many records are published: none is checked\n", fingerprintsFileName)
			default:
				fmt.Fprintf(stderr, "iamreal-verify: %s does not say how many records are published: checking every log file there is\n", fingerprintsFileName)
			}
		}
	} else {
		proofLogFile, err = readInput(input)
	}
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	files := crlFiles{dir: *archiveDir} // the CRL archive: the directory given, or what -data has
	var archiveProblems []string
	if crlSrc != nil {
		made, cleanup, err := crlSrc.crlArchive(*trustIndex, stderr)
		if err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: CRL archive: %v\n", err)
			return exitError
		}
		defer cleanup()
		files = made
	}
	archive := files.dir
	// Before the index is rebuilt, as it always was: a `bb` or a CRS that
	// cannot be used is said before the minutes of rebuilding, and, now that
	// the files of a URL are downloaded as the index is rebuilt, before
	// they are downloaded too.
	v, err := d.verifier(verifier.Config{BB: *bb, CRSDir: *crs, Timeout: *timeout})
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	var crls prooflog.CRLArchive = noArchive{}
	var diffs []crl.IndexMismatch
	switch {
	case archive == "":
		fmt.Fprintln(stderr, "iamreal-verify: no CRL archive (-crl-archive): no root is recognized, so check 3 (root) fails for every record that verifies")
	case *trustIndex:
		fmt.Fprintln(stderr, "iamreal-verify: trusting the CRL archive's index without checking it against the CRLs")
	default:
		fmt.Fprintln(stderr, "iamreal-verify: rebuilding the CRL archive's index from its CRLs")
	}
	if archive != "" {
		progress := func(name string) { fmt.Fprintf(stderr, "iamreal-verify: CRL %s\n", name) }
		if crls, diffs, err = d.archive(files, *trustIndex, progress); err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: CRL archive: %v\n", err)
			return exitError
		}
		// What reading the files found on the way (a file of a URL whose
		// content is not what its name says): known only now that each was
		// read as the index was rebuilt.
		if files.problems != nil {
			archiveProblems = files.problems()
			for _, p := range archiveProblems {
				fmt.Fprintf(stderr, "iamreal-verify: CRL archive: %s\n", p)
			}
		}
		// The rebuilt index is the one that counts (spec/revocation-tree.md,
		// "Re-verifying with the index"): report every difference and go on.
		for _, m := range diffs {
			fmt.Fprintf(stderr, "iamreal-verify: CRL archive: %s\n", m)
		}
		if len(diffs) > 0 {
			fmt.Fprintf(stderr, "iamreal-verify: CRL archive: %d difference(s) between %s and the CRL files; continuing with the index rebuilt from the files\n", len(diffs), crl.IndexFileName)
		}
	}
	var rep *prooflog.Report
	if pub != nil && pub.broken != nil {
		rep = &prooflog.Report{Broken: pub.broken}
	} else if rep, err = prooflog.Check(proofLogFile, r, v, crls); err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	// The record hash lists and the fingerprint file of a valid proof log
	// directory: each is checked against the records; every problem is
	// reported.
	var dirProblems []string
	if pub != nil && rep.Broken == nil {
		records, _, _ := prooflog.ReadFile(proofLogFile, r) // valid: Check read it
		listProblems, lists, err := checkHashLists(dirSrc, pub, records)
		if err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
			return exitError
		}
		fpProblems := checkFingerprints(pub, records)
		dirProblems = append(listProblems, fpProblems...)
		for _, p := range dirProblems {
			fmt.Fprintf(stderr, "iamreal-verify: %s\n", p)
		}
		if len(listProblems) == 0 {
			fmt.Fprintf(stderr, "iamreal-verify: %s/: %d list(s), every list is the proof log's\n", prooflog.HashListDir, lists)
		}
		if len(fpProblems) == 0 {
			fmt.Fprintf(stderr, "iamreal-verify: %s: %d line(s), every fingerprint is the proof log's\n", fingerprintsFileName, len(splitLines(pub.fingerprints.data)))
		}
		// The card state file of a date, against the states computed.
		csProblems, csSummary, err := checkCardState(dirSrc, pub, r, rep, cardStateDate)
		if err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
			return exitError
		}
		for _, p := range csProblems {
			fmt.Fprintf(stderr, "iamreal-verify: %s\n", p)
		}
		if csSummary != "" {
			fmt.Fprintf(stderr, "iamreal-verify: %s\n", csSummary)
		}
		dirProblems = append(dirProblems, csProblems...)
	}
	if *asJSON {
		err = writeJSON(stdout, rep)
	} else {
		err = writeText(stdout, rep)
	}
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	if rep.Broken != nil || len(diffs) > 0 || len(archiveProblems) > 0 || len(dirProblems) > 0 {
		return exitInvalid
	}
	for _, res := range rep.State.Records {
		if !res.Valid {
			return exitInvalid
		}
	}
	return exitAllValid
}

func readInput(name string) ([]byte, error) {
	if name == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(name)
}

func writeText(w io.Writer, rep *prooflog.Report) error {
	p := &printer{w: w}
	if rep.Broken != nil {
		p.f("log file: broken at line %d: %s (%v)\n", rep.Broken.Line, rep.Broken.Code, rep.Broken.Err)
		return p.err
	}
	p.f("log file: valid\nrecords: %d\nfingerprint: %s\n", rep.Records, rep.Fingerprint)
	if len(rep.State.Records) > 0 {
		p.f("\nrecords:\n")
	}
	for _, res := range rep.State.Records {
		if res.Valid {
			var kinds []string
			for _, k := range res.Kinds {
				kinds = append(kinds, k.Platform+" "+k.Kind)
			}
			p.f("  %d valid %s\n", res.Seq, strings.Join(kinds, ", "))
		} else if res.Detail != "" {
			p.f("  %d invalid %s (%s)\n", res.Seq, res.Reason, res.Detail)
		} else {
			p.f("  %d invalid %s\n", res.Seq, res.Reason)
		}
	}
	for _, s := range rep.State.Scopes {
		p.f("\nscope %s\n  cards:\n", s.ScopeString)
		for _, c := range s.Cards {
			p.f("    %s  last card proof %s  ordinal %d\n", c.ScopedID, c.LastCardProof, c.Ordinal)
			if len(c.Accounts) == 0 {
				p.f("      no account\n")
			}
			for _, a := range c.Accounts {
				p.f("      %s %s\n", a.Platform, a.Username)
			}
		}
		p.f("  accounts:\n")
		for _, a := range s.Accounts {
			p.f("    %s %s\n", a.Platform, a.Username)
			for _, c := range a.Cards {
				p.f("      %s  last card proof %s\n", c.ScopedID, c.LastCardProof)
			}
		}
	}
	return p.err
}

type printer struct {
	w   io.Writer
	err error
}

func (p *printer) f(format string, args ...any) {
	if p.err == nil {
		_, p.err = fmt.Fprintf(p.w, format, args...)
	}
}

// The JSON output has the shape of spec/vectors/record.json ("files") and
// spec/vectors/record-rules.json ("results", "state", "ordinals"), without
// the items of a card's state that the output does not list
// (proofs_on_last_date, slots).
type jsonReport struct {
	Valid       bool           `json:"valid"`
	Line        int            `json:"line,omitempty"`
	Code        string         `json:"code,omitempty"`
	Fingerprint string         `json:"fingerprint,omitempty"`
	Results     []jsonResult   `json:"results,omitempty"`
	State       *[]jsonScope   `json:"state,omitempty"`
	Ordinals    *[]jsonOrdinal `json:"ordinals,omitempty"`
}

// jsonOrdinal is a card of the output with its ordinal; the list is in
// ascending order of ordinal.
type jsonOrdinal struct {
	ScopeString string `json:"scope_string"`
	ScopedID    string `json:"scoped_id"`
	Ordinal     int    `json:"ordinal"`
}

type jsonResult struct {
	Seq    uint64     `json:"seq"`
	Valid  bool       `json:"valid"`
	Kinds  []jsonKind `json:"kinds,omitempty"`
	Reason string     `json:"reason,omitempty"`
}

type jsonKind struct {
	Platform string `json:"platform"`
	Kind     string `json:"kind"`
}

type jsonListAccount struct {
	Platform string `json:"platform"`
	Username string `json:"username"`
}

type jsonCard struct {
	ScopedID      string            `json:"scoped_id"`
	LastCardProof string            `json:"last_card_proof"`
	Accounts      []jsonListAccount `json:"accounts"`
}

type jsonAccountCard struct {
	ScopedID      string `json:"scoped_id"`
	LastCardProof string `json:"last_card_proof"`
}

type jsonAccount struct {
	Platform string            `json:"platform"`
	Username string            `json:"username"`
	Cards    []jsonAccountCard `json:"cards"`
}

type jsonScope struct {
	ScopeString string        `json:"scope_string"`
	Cards       []jsonCard    `json:"cards"`
	Accounts    []jsonAccount `json:"accounts"`
}

func writeJSON(w io.Writer, rep *prooflog.Report) error {
	out := jsonReport{}
	if rep.Broken != nil {
		out.Line, out.Code = rep.Broken.Line, rep.Broken.Code
	} else {
		out.Valid, out.Fingerprint = true, rep.Fingerprint
		out.Results = []jsonResult{}
		for _, res := range rep.State.Records {
			jr := jsonResult{Seq: res.Seq, Valid: res.Valid, Reason: res.Reason}
			for _, k := range res.Kinds {
				jr.Kinds = append(jr.Kinds, jsonKind{k.Platform, k.Kind})
			}
			out.Results = append(out.Results, jr)
		}
		scopes := []jsonScope{}
		ordinals := []jsonOrdinal{}
		for _, s := range rep.State.Scopes {
			js := jsonScope{ScopeString: s.ScopeString, Cards: []jsonCard{}, Accounts: []jsonAccount{}}
			for _, c := range s.Cards {
				jc := jsonCard{ScopedID: c.ScopedID, LastCardProof: c.LastCardProof.String(), Accounts: []jsonListAccount{}}
				for _, a := range c.Accounts {
					jc.Accounts = append(jc.Accounts, jsonListAccount{a.Platform, a.Username})
				}
				js.Cards = append(js.Cards, jc)
				ordinals = append(ordinals, jsonOrdinal{s.ScopeString, c.ScopedID, c.Ordinal})
			}
			for _, a := range s.Accounts {
				ja := jsonAccount{Platform: a.Platform, Username: a.Username, Cards: []jsonAccountCard{}}
				for _, c := range a.Cards {
					ja.Cards = append(ja.Cards, jsonAccountCard{c.ScopedID, c.LastCardProof.String()})
				}
				js.Accounts = append(js.Accounts, ja)
			}
			scopes = append(scopes, js)
		}
		out.State = &scopes
		sort.Slice(ordinals, func(i, j int) bool { return ordinals[i].Ordinal < ordinals[j].Ordinal })
		out.Ordinals = &ordinals
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		return errors.New("writing JSON: " + err.Error())
	}
	return nil
}
