// Command iamreal-verify re-verifies a roster file, or a published roster
// directory with its record hash lists and fingerprint file, by default the
// one published at https://data.iamreal.tw/ with its CRL archive: whether
// the roster as a whole is valid, the result of each record, and the state
// of every card and account (spec/roster-rules.md). See README.md.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// Exit codes.
const (
	exitAllValid = 0 // the file is valid and every record is valid
	exitInvalid  = 1 // the file is broken, a record is invalid, the CRL archive's index differs from its files, or a record hash list or the fingerprint file has a problem
	exitError    = 2 // the check could not be made
)

// testOptions is set only in a build with the tag iamrealtest
// (testissuers.go): options that let a test use throwaway issuer keys. The
// program built as README.md says has no such option.
var testOptions func(fs *flag.FlagSet) func(*deps) error

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, deps{newVerifier, openArchive(crl.MOICAKeys)}))
}

// deps makes the verifier and opens the CRL archive. Tests replace them to
// use test issuer keys; the program uses only MOICA's.
type deps struct {
	verifier func(verifier.Config) (roster.ProofVerifier, error)
	// archive opens the archive directory dir: reading only its index if
	// trustIndex, otherwise rebuilding the index from the files. When
	// rebuilding, it also returns every difference between the index and
	// the rebuilt one; the archive is that of the rebuilt index.
	archive func(dir string, trustIndex bool, progress func(name string)) (roster.CRLArchive, []crl.IndexMismatch, error)
}

func newVerifier(cfg verifier.Config) (roster.ProofVerifier, error) { return verifier.New(cfg) }

// openArchive opens an archive whose CRLs are checked under keys.
func openArchive(keys func() ([]crl.NamedKey, error)) func(string, bool, func(string)) (roster.CRLArchive, []crl.IndexMismatch, error) {
	return func(dir string, trustIndex bool, progress func(string)) (roster.CRLArchive, []crl.IndexMismatch, error) {
		if trustIndex {
			a, err := crl.ReadArchiveIndex(dir)
			if err != nil {
				return nil, nil, err
			}
			return archive{a}, nil, nil
		}
		k, err := keys()
		if err != nil {
			return nil, nil, err
		}
		a, diffs, err := crl.RebuildArchive(dir, k, progress)
		if err != nil {
			return nil, nil, err
		}
		return archive{a}, diffs, nil
	}
}

// archive is a crl.Archive as roster.CRLArchive: crl/ imports nothing of the
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
	kind := fs.String("roster", "production", "whose accepted scopes apply: production or test")
	asJSON := fs.Bool("json", false, "print the result as JSON")
	data := fs.String("data", defaultData, "`URL or directory` of the published files, without a roster file: the roster directory under roster/, the CRL archive under crl/")
	archiveDir := fs.String("crl-archive", "", "`directory` of the CRL archive, with its index "+crl.IndexFileName+", for a roster file or directory; without it no root is recognized")
	trustIndex := fs.Bool("crl-trust-index", false, "read only the archive's index, without checking it against the CRL files")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: iamreal-verify -bb <bb> -crs <dir> [flags] [roster file | roster directory | -]")
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
	var r verifier.Roster
	switch *kind {
	case "production":
		r = verifier.Production
	case "test":
		r = verifier.Test
	default:
		fmt.Fprintf(stderr, "iamreal-verify: -roster %q: want production or test\n", *kind)
		return exitError
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	// What to read: a roster file or directory with -crl-archive, or else
	// the published files at -data.
	var input string
	var dirSrc source // the roster directory, if the roster is one
	var crlSrc source // the CRL archive at -data, if read from there
	if fs.NArg() == 1 {
		if set["data"] {
			fmt.Fprintln(stderr, "iamreal-verify: -data reads the roster from the published files: give it or a roster file, not both")
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
			fmt.Fprintln(stderr, "iamreal-verify: -crl-archive goes with a roster file; with -data the archive is its crl/")
			return exitError
		}
		src, err := openSource(*data)
		if err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: -data: %v\n", err)
			return exitError
		}
		dirSrc, crlSrc = src.sub("roster"), src.sub("crl")
		fmt.Fprintf(stderr, "iamreal-verify: reading the published files at %s\n", src)
	}
	if *trustIndex && *archiveDir == "" && crlSrc == nil {
		fmt.Fprintln(stderr, "iamreal-verify: -crl-trust-index needs -crl-archive")
		return exitError
	}
	var rosterFile []byte
	var pub *publishedRoster
	var err error
	if dirSrc != nil {
		if pub, err = readPublished(dirSrc); err == nil {
			rosterFile = pub.data
			switch {
			case pub.countKnown:
				fmt.Fprintf(stderr, "iamreal-verify: %s: %d record(s) published; later records are not checked\n", fingerprintsFileName, pub.count)
			default:
				fmt.Fprintf(stderr, "iamreal-verify: %s does not say how many records are published: checking every roster file there is\n", fingerprintsFileName)
			}
		}
	} else {
		rosterFile, err = readInput(input)
	}
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	if crlSrc != nil {
		dir, cleanup, err := archiveFrom(crlSrc, *trustIndex, stderr)
		if err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: CRL archive: %v\n", err)
			return exitError
		}
		defer cleanup()
		*archiveDir = dir
	}
	v, err := d.verifier(verifier.Config{BB: *bb, CRSDir: *crs, Timeout: *timeout})
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	var crls roster.CRLArchive = noArchive{}
	var diffs []crl.IndexMismatch
	switch {
	case *archiveDir == "":
		fmt.Fprintln(stderr, "iamreal-verify: no CRL archive (-crl-archive): no root is recognized, so check 3 (root) fails for every record that verifies")
	case *trustIndex:
		fmt.Fprintln(stderr, "iamreal-verify: trusting the CRL archive's index without checking it against the CRLs")
	default:
		fmt.Fprintln(stderr, "iamreal-verify: rebuilding the CRL archive's index from its CRLs")
	}
	if *archiveDir != "" {
		progress := func(name string) { fmt.Fprintf(stderr, "iamreal-verify: CRL %s\n", name) }
		if crls, diffs, err = d.archive(*archiveDir, *trustIndex, progress); err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: CRL archive: %v\n", err)
			return exitError
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
	var rep *roster.Report
	if pub != nil && pub.broken != nil {
		rep = &roster.Report{Broken: pub.broken}
	} else if rep, err = roster.Check(rosterFile, r, v, crls); err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	// The record hash lists and the fingerprint file of a valid roster
	// directory: each is checked against the records; every problem is
	// reported.
	var dirProblems []string
	if pub != nil && rep.Broken == nil {
		records, _, _ := roster.ReadFile(rosterFile, r) // valid: Check read it
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
			fmt.Fprintf(stderr, "iamreal-verify: %s/: %d list(s), every list is the roster's\n", roster.HashListDir, lists)
		}
		if len(fpProblems) == 0 {
			fmt.Fprintf(stderr, "iamreal-verify: %s: %d line(s), every fingerprint is the roster's\n", fingerprintsFileName, fingerprintLines(pub.fingerprints))
		}
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
	if rep.Broken != nil || len(diffs) > 0 || len(dirProblems) > 0 {
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

func writeText(w io.Writer, rep *roster.Report) error {
	p := &printer{w: w}
	if rep.Broken != nil {
		p.f("roster file: broken at line %d: %s (%v)\n", rep.Broken.Line, rep.Broken.Code, rep.Broken.Err)
		return p.err
	}
	p.f("roster file: valid\nrecords: %d\nfingerprint: %s\n", rep.Records, rep.Fingerprint)
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
			p.f("    %s  last card proof %s\n", c.ScopedID, c.LastCardProof)
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
// spec/vectors/roster-rules.json ("results", "state"), without the items of
// a card's state that the output does not list (proofs_on_last_date, slots).
type jsonReport struct {
	Valid       bool         `json:"valid"`
	Line        int          `json:"line,omitempty"`
	Code        string       `json:"code,omitempty"`
	Fingerprint string       `json:"fingerprint,omitempty"`
	Results     []jsonResult `json:"results,omitempty"`
	State       *[]jsonScope `json:"state,omitempty"`
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

func writeJSON(w io.Writer, rep *roster.Report) error {
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
		for _, s := range rep.State.Scopes {
			js := jsonScope{ScopeString: s.ScopeString, Cards: []jsonCard{}, Accounts: []jsonAccount{}}
			for _, c := range s.Cards {
				jc := jsonCard{ScopedID: c.ScopedID, LastCardProof: c.LastCardProof.String(), Accounts: []jsonListAccount{}}
				for _, a := range c.Accounts {
					jc.Accounts = append(jc.Accounts, jsonListAccount{a.Platform, a.Username})
				}
				js.Cards = append(js.Cards, jc)
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
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		return errors.New("writing JSON: " + err.Error())
	}
	return nil
}
