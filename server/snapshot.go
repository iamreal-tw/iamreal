package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

// The published roster (spec/record.md, "The published roster"): the
// roster files and record hash lists come from roster.DirectoryFiles.
const fingerprintsFileName = "fingerprints.jsonl"

var (
	rosterFilePattern = regexp.MustCompile(`^[0-9]{16}\.jsonl$`)
	hashListPattern   = regexp.MustCompile(`^[0-9]{16}\.txt$`)
)

// snapshotConfig is what the daily snapshot needs.
type snapshotConfig struct {
	Store  store.Store
	Roster verifier.Roster
	CRLDir string               // the CRL mirror
	OutDir string               // the roster directory to publish into
	Proofs roster.ProofVerifier // the real verifier: every proof is verified again
	Keys   []crl.NamedKey       // the issuer keys the CRLs are checked with
	Today  verifier.Date        // the date in Taiwan, for fingerprints.jsonl
	Out    io.Writer            // what was published
	Err    io.Writer            // progress and problems
}

// Exit codes of the snapshot.
const (
	snapshotPublished = 0 // published, or nothing new to publish today
	snapshotRefused   = 1 // something is wrong with the roster, the archive or the published files; nothing was written
	snapshotError     = 2 // the check could not be made
)

// snapshot recomputes the whole roster as a re-verifier would, and
// publishes it only if every record is valid (ADR-0014): every proof is
// verified again with bb, and the CRL archive's index is rebuilt from the
// CRL files. Then it writes the roster directory, one file per 1,000
// records, and its record hash lists, and adds today's line to
// fingerprints.jsonl, after the card state file of today (the states this
// re-verification computed), which iamreal-verify asks for with the line.
//
// A full file or list already published is never written again; it must
// have the same bytes. Nothing is written if anything is wrong, and the exit code
// says why.
func snapshot(c snapshotConfig) int {
	refuse := func(format string, args ...any) int {
		fmt.Fprintf(c.Err, "snapshot: "+format+"\n", args...)
		fmt.Fprintln(c.Err, "snapshot: nothing was published")
		return snapshotRefused
	}
	fail := func(err error) int {
		fmt.Fprintf(c.Err, "snapshot: %v\n", err)
		return snapshotError
	}

	// The roster file: every record, in order, up to the count read first.
	// The server may append while this runs; those records wait for the
	// next snapshot.
	count, err := c.Store.Count()
	if err != nil {
		return fail(err)
	}
	var all []*verifier.Record
	var file []byte
	fingerprints := []string{roster.EmptyFingerprint} // fingerprints[n]: of the first n records
	for first := uint64(1); first <= count; first += roster.LinesPerFile {
		records, err := c.Store.Records(first, min(first+roster.LinesPerFile-1, count))
		if err != nil {
			return fail(err)
		}
		for _, r := range records {
			all = append(all, r)
			file = append(file, r.Line()...)
			fingerprints = append(fingerprints, roster.NextFingerprint(fingerprints[len(fingerprints)-1], r.Hash()))
		}
	}

	// The CRL archive, rebuilt from its files.
	fmt.Fprintln(c.Err, "snapshot: rebuilding the CRL archive's index from its CRLs")
	archive, diffs, err := crl.RebuildArchive(c.CRLDir, c.Keys, func(name string) { fmt.Fprintf(c.Err, "snapshot: CRL %s\n", name) })
	if err != nil {
		return fail(fmt.Errorf("CRL archive: %w", err))
	}
	if len(diffs) > 0 {
		for _, d := range diffs {
			fmt.Fprintf(c.Err, "snapshot: CRL archive: %s\n", d)
		}
		return refuse("the CRL archive's index differs from its CRL files in %d place(s)", len(diffs))
	}

	// The rules, with every proof verified again.
	fmt.Fprintf(c.Err, "snapshot: re-verifying %d records\n", len(all))
	rep, err := roster.Check(file, c.Roster, c.Proofs, &crlIndex{archive: archive})
	if err != nil {
		return fail(err)
	}
	if rep.Broken != nil {
		return refuse("the roster is broken at line %d: %s (%v)", rep.Broken.Line, rep.Broken.Code, rep.Broken.Err)
	}
	invalid := 0
	for _, res := range rep.State.Records {
		if !res.Valid {
			invalid++
			fmt.Fprintf(c.Err, "snapshot: record %d is invalid: %s %s\n", res.Seq, res.Reason, res.Detail)
		}
	}
	if invalid > 0 {
		return refuse("%d invalid record(s)", invalid)
	}

	// What is already published must be the beginning of what is published
	// now.
	lines, err := readFingerprints(filepath.Join(c.OutDir, fingerprintsFileName))
	if err != nil {
		return refuse("%s: %v", fingerprintsFileName, err)
	}
	newLine := fingerprintLine{Date: c.Today, Count: uint64(len(all)), Fingerprint: rep.Fingerprint}
	for i, fl := range lines {
		if fl.Count > uint64(len(all)) || fl.Fingerprint != fingerprints[fl.Count] {
			return refuse("%s line %d (%s, %d records) is not a fingerprint of this roster", fingerprintsFileName, i+1, fl.Date, fl.Count)
		}
	}
	if len(lines) > 0 {
		last := lines[len(lines)-1]
		if last.Date == c.Today {
			if last == newLine {
				fmt.Fprintf(c.Out, "already published today: %d records, fingerprint %s\n", newLine.Count, newLine.Fingerprint)
				return snapshotPublished
			}
			return refuse("%s already has a line for %s (%d records); a date appears at most once", fingerprintsFileName, c.Today, last.Count)
		}
		if last.Date > c.Today {
			return refuse("%s has a line for %s, after today (%s)", fingerprintsFileName, last.Date, c.Today)
		}
	}
	files, err := planDirectoryFiles(c.OutDir, roster.DirectoryFiles(all))
	if err != nil {
		return refuse("%v", err)
	}

	// Write: the roster files and their lists first, then the fingerprint
	// line that covers them.
	if err := os.MkdirAll(filepath.Join(c.OutDir, roster.HashListDir), 0o755); err != nil {
		return fail(err)
	}
	for _, f := range files {
		if err := writeFileAtomic(filepath.Join(c.OutDir, filepath.FromSlash(f.Name)), f.Data); err != nil {
			return fail(err)
		}
	}
	// The card state file of today, before today's line (ADR-0027): the
	// states of the re-verification just made, which are the ones this
	// snapshot publishes the roster by. iamreal-verify reports a line
	// whose date has no card state file.
	if err := os.MkdirAll(filepath.Join(c.OutDir, roster.CardStateDir), 0o755); err != nil {
		return fail(err)
	}
	if err := writeFileAtomic(filepath.Join(c.OutDir, filepath.FromSlash(roster.CardStateName(c.Today))), roster.CardStateFile(rep.Cards)); err != nil {
		return fail(err)
	}
	var fingerprintFile []byte
	for _, fl := range lines {
		fingerprintFile = append(fingerprintFile, fl.line()...)
	}
	fingerprintFile = append(fingerprintFile, newLine.line()...)
	if err := writeFileAtomic(filepath.Join(c.OutDir, fingerprintsFileName), fingerprintFile); err != nil {
		return fail(err)
	}
	fmt.Fprintf(c.Out, "published %s: %d records, fingerprint %s\n", c.Today, newLine.Count, newLine.Fingerprint)
	return snapshotPublished
}

// planDirectoryFiles returns the roster files and record hash lists to
// write, leaving out those already there with the same bytes. A file
// already there must be the beginning of the file it will be (the last
// file and its list grow until they are full); any other file of the
// directory's form is an error, since the roster only grows.
func planDirectoryFiles(dir string, parts []roster.DirectoryPart) ([]roster.File, error) {
	var files []roster.File
	for _, p := range parts {
		files = append(files, p.RosterFile, p.HashList)
	}
	want := map[string][]byte{}
	for _, f := range files {
		want[f.Name] = f.Data
	}
	have := map[string][]byte{}
	for _, sub := range []struct {
		dir     string
		pattern *regexp.Regexp
	}{{"", rosterFilePattern}, {roster.HashListDir, hashListPattern}} {
		entries, err := os.ReadDir(filepath.Join(dir, sub.dir))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
		for _, e := range entries {
			if !sub.pattern.MatchString(e.Name()) {
				continue
			}
			name := path.Join(sub.dir, e.Name())
			if _, ok := want[name]; !ok {
				return nil, fmt.Errorf("%s is published but is not a file of this roster", name)
			}
			b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
			if err != nil {
				return nil, err
			}
			if !bytes.HasPrefix(want[name], b) {
				return nil, fmt.Errorf("%s is published with other bytes than this roster's", name)
			}
			have[name] = b
		}
	}
	var out []roster.File
	for _, f := range files {
		if !bytes.Equal(have[f.Name], f.Data) {
			out = append(out, f)
		}
	}
	return out, nil
}

// fingerprintLine is one line of fingerprints.jsonl (spec/record.md,
// "Fingerprint file").
type fingerprintLine struct {
	Date        verifier.Date
	Count       uint64
	Fingerprint string
}

func (fl fingerprintLine) line() []byte {
	return fmt.Appendf(nil, `{"date":"%s","count":%d,"fingerprint":"%s"}`+"\n", fl.Date, fl.Count, fl.Fingerprint)
}

var fingerprintLinePattern = regexp.MustCompile(`^\{"date":"([0-9-]{10})","count":([0-9]{1,16}),"fingerprint":"([0-9a-f]{64})"\}\n$`)

// readFingerprints reads fingerprints.jsonl, checking that every line is in
// its one spelling, that dates increase and that counts do not decrease. A
// missing file has no lines.
func readFingerprints(path string) ([]fingerprintLine, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []fingerprintLine
	for n := 1; len(data) > 0; n++ {
		end := bytes.IndexByte(data, '\n') + 1
		if end == 0 {
			end = len(data)
		}
		raw := data[:end]
		data = data[end:]
		m := fingerprintLinePattern.FindSubmatch(raw)
		if m == nil {
			return nil, fmt.Errorf("line %d is not in the form of the spec", n)
		}
		d, err := verifier.ParseDate(string(m[1]))
		if err != nil {
			return nil, fmt.Errorf("line %d: %v", n, err)
		}
		count, err := strconv.ParseUint(string(m[2]), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("line %d: %v", n, err)
		}
		fl := fingerprintLine{d, count, string(m[3])}
		if !bytes.Equal(fl.line(), raw) {
			return nil, fmt.Errorf("line %d is not in its one spelling", n)
		}
		if len(out) > 0 {
			prev := out[len(out)-1]
			if fl.Date <= prev.Date {
				return nil, fmt.Errorf("line %d: date %s is not after %s", n, fl.Date, prev.Date)
			}
			if fl.Count < prev.Count {
				return nil, fmt.Errorf("line %d: count %d is less than %d", n, fl.Count, prev.Count)
			}
		}
		out = append(out, fl)
	}
	return out, nil
}
