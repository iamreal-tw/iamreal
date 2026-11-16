// Command iamreal-verify re-verifies a roster file: whether the file as a
// whole is valid, the result of each record, and the state of every card and
// account (spec/roster-rules.md). See README.md.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// Exit codes.
const (
	exitAllValid = 0 // the file is valid and every record is valid
	exitInvalid  = 1 // the file is broken, or a record is invalid
	exitError    = 2 // the check could not be made
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, deps{newVerifier, openArchive(crl.MOICAKeys)}))
}

// deps makes the verifier and opens the CRL archive. Tests replace them to
// use test issuer keys; the program uses only MOICA's.
type deps struct {
	verifier func(verifier.Config) (roster.ProofVerifier, error)
	// archive opens the archive directory dir: reading only its index if
	// trustIndex, otherwise rebuilding the index from the files.
	archive func(dir string, trustIndex bool, progress func(name string)) (roster.CRLArchive, error)
}

func newVerifier(cfg verifier.Config) (roster.ProofVerifier, error) { return verifier.New(cfg) }

// openArchive opens an archive whose CRLs are checked under keys.
func openArchive(keys func() ([]crl.NamedKey, error)) func(string, bool, func(string)) (roster.CRLArchive, error) {
	return func(dir string, trustIndex bool, progress func(string)) (roster.CRLArchive, error) {
		if trustIndex {
			a, err := crl.ReadArchiveIndex(dir)
			if err != nil {
				return nil, err
			}
			return archive{a}, nil
		}
		k, err := keys()
		if err != nil {
			return nil, err
		}
		a, err := crl.RebuildArchive(dir, k, progress)
		if err != nil {
			return nil, err
		}
		return archive{a}, nil
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
	archiveDir := fs.String("crl-archive", "", "`directory` of the CRL archive, with its index "+crl.IndexFileName+"; without it no root is recognized")
	trustIndex := fs.Bool("crl-trust-index", false, "read only the archive's index, without checking it against the CRL files")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: iamreal-verify -bb <bb> -crs <dir> [flags] <roster file | ->")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return exitError
	}
	if fs.NArg() != 1 || *bb == "" || *crs == "" {
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
	data, err := readInput(fs.Arg(0))
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	if *trustIndex && *archiveDir == "" {
		fmt.Fprintln(stderr, "iamreal-verify: -crl-trust-index needs -crl-archive")
		return exitError
	}
	v, err := d.verifier(verifier.Config{BB: *bb, CRSDir: *crs, Timeout: *timeout})
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
	}
	var crls roster.CRLArchive = noArchive{}
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
		if crls, err = d.archive(*archiveDir, *trustIndex, progress); err != nil {
			fmt.Fprintf(stderr, "iamreal-verify: CRL archive: %v\n", err)
			return exitError
		}
	}
	rep, err := roster.Check(data, r, v, crls)
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %v\n", err)
		return exitError
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
	if rep.Broken != nil {
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
	p.f("roster file: valid\nrecords: %d\nhead: %s\n", rep.Records, rep.Head)
	if len(rep.State.Records) > 0 {
		p.f("\nrecords:\n")
	}
	for _, res := range rep.State.Records {
		if res.Valid {
			p.f("  %d valid %s\n", res.Seq, res.Kind)
		} else if res.Detail != "" {
			p.f("  %d invalid %s (%s)\n", res.Seq, res.Reason, res.Detail)
		} else {
			p.f("  %d invalid %s\n", res.Seq, res.Reason)
		}
	}
	for _, s := range rep.State.Scopes {
		p.f("\nscope %s\n  cards:\n", s.ScopeString)
		for _, c := range s.Cards {
			current := "none"
			if c.Current != nil {
				current = *c.Current
			}
			p.f("    %s  current %s  last card proof %s\n", c.ScopedID, current, c.LastCardProof)
		}
		p.f("  accounts:\n")
		for _, a := range s.Accounts {
			p.f("    %s\n", a.Username)
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
// spec/vectors/roster-rules.json ("results", "state").
type jsonReport struct {
	Valid   bool         `json:"valid"`
	Line    int          `json:"line,omitempty"`
	Code    string       `json:"code,omitempty"`
	Head    string       `json:"head,omitempty"`
	Results []jsonResult `json:"results,omitempty"`
	State   *[]jsonScope `json:"state,omitempty"`
}

type jsonResult struct {
	Seq    uint64 `json:"seq"`
	Valid  bool   `json:"valid"`
	Kind   string `json:"kind,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type jsonCard struct {
	ScopedID      string  `json:"scoped_id"`
	Current       *string `json:"current"`
	LastCardProof string  `json:"last_card_proof"`
}

type jsonAccountCard struct {
	ScopedID      string `json:"scoped_id"`
	LastCardProof string `json:"last_card_proof"`
}

type jsonAccount struct {
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
		out.Valid, out.Head = true, rep.Head
		out.Results = []jsonResult{}
		for _, res := range rep.State.Records {
			out.Results = append(out.Results, jsonResult{res.Seq, res.Valid, res.Kind, res.Reason})
		}
		scopes := []jsonScope{}
		for _, s := range rep.State.Scopes {
			js := jsonScope{ScopeString: s.ScopeString, Cards: []jsonCard{}, Accounts: []jsonAccount{}}
			for _, c := range s.Cards {
				js.Cards = append(js.Cards, jsonCard{c.ScopedID, c.Current, c.LastCardProof.String()})
			}
			for _, a := range s.Accounts {
				ja := jsonAccount{Username: a.Username, Cards: []jsonAccountCard{}}
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
