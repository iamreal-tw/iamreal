package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

// The published roster (spec/record.md, "The published roster").
const (
	linesPerFile  = 1000
	headsFileName = "heads.jsonl"
)

// rosterFileName is the name of the file of the roster directory that
// starts with the record of seq first.
func rosterFileName(first uint64) string { return fmt.Sprintf("%016d.jsonl", first) }

var rosterFilePattern = regexp.MustCompile(`^[0-9]{16}\.jsonl$`)

// snapshotConfig is what the daily snapshot needs.
type snapshotConfig struct {
	Store  store.Store
	Roster verifier.Roster
	CRLDir string               // the CRL mirror
	OutDir string               // the roster directory to publish into
	Proofs roster.ProofVerifier // the real verifier: every proof is verified again
	Keys   []crl.NamedKey       // the issuer keys the CRLs are checked with
	Today  verifier.Date        // the date in Taiwan, for heads.jsonl
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
// records, and adds today's line to heads.jsonl.
//
// A full file already published is never written again; it must have the
// same bytes. Nothing is written if anything is wrong, and the exit code
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

	// The roster file: every record, in order.
	count, _, err := c.Store.Head()
	if err != nil {
		return fail(err)
	}
	var lines [][]byte
	var hashes []string
	for first := uint64(1); first <= count; first += linesPerFile {
		records, err := c.Store.Records(first, first+linesPerFile-1)
		if err != nil {
			return fail(err)
		}
		for _, r := range records {
			lines = append(lines, r.Line())
			hashes = append(hashes, r.Hash())
		}
	}
	file := bytes.Join(lines, nil)

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
	fmt.Fprintf(c.Err, "snapshot: re-verifying %d records\n", len(lines))
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
	heads, err := readHeads(filepath.Join(c.OutDir, headsFileName))
	if err != nil {
		return refuse("%s: %v", headsFileName, err)
	}
	newLine := headsLine{Date: c.Today, Count: uint64(len(lines)), Head: rep.Head}
	for i, h := range heads {
		if h.Count > uint64(len(lines)) || (h.Count > 0 && h.Head != hashes[h.Count-1]) || (h.Count == 0 && h.Head != verifier.GenesisPrev) {
			return refuse("%s line %d (%s, %d records) is not a head of this roster", headsFileName, i+1, h.Date, h.Count)
		}
	}
	if len(heads) > 0 {
		last := heads[len(heads)-1]
		if last.Date == c.Today {
			if last == newLine {
				fmt.Fprintf(c.Out, "already published today: %d records, head %s\n", newLine.Count, newLine.Head)
				return snapshotPublished
			}
			return refuse("%s already has a line for %s (%d records); a date appears at most once", headsFileName, c.Today, last.Count)
		}
		if last.Date > c.Today {
			return refuse("%s has a line for %s, after today (%s)", headsFileName, last.Date, c.Today)
		}
	}
	files, err := planRosterFiles(c.OutDir, lines)
	if err != nil {
		return refuse("%v", err)
	}

	// Write: the roster files first, then the heads line that covers them.
	if err := os.MkdirAll(c.OutDir, 0o755); err != nil {
		return fail(err)
	}
	for _, f := range files {
		if err := writeFileAtomic(filepath.Join(c.OutDir, f.name), f.content); err != nil {
			return fail(err)
		}
	}
	var headsFile []byte
	for _, h := range heads {
		headsFile = append(headsFile, h.line()...)
	}
	headsFile = append(headsFile, newLine.line()...)
	if err := writeFileAtomic(filepath.Join(c.OutDir, headsFileName), headsFile); err != nil {
		return fail(err)
	}
	fmt.Fprintf(c.Out, "published %s: %d records, head %s\n", c.Today, newLine.Count, newLine.Head)
	return snapshotPublished
}

type rosterFile struct {
	name    string
	content []byte
}

// planRosterFiles returns the files of the roster directory to write for
// these lines, leaving out those already there with the same bytes. A file
// already there must be the beginning of the file it will be (the last
// file grows until it is full); any other file of the directory's form is
// an error, since the roster only grows.
func planRosterFiles(dir string, lines [][]byte) ([]rosterFile, error) {
	want := map[string][]byte{}
	var order []string
	for first := 0; first < len(lines); first += linesPerFile {
		name := rosterFileName(uint64(first + 1))
		want[name] = bytes.Join(lines[first:min(first+linesPerFile, len(lines))], nil)
		order = append(order, name)
	}
	entries, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	have := map[string][]byte{}
	for _, e := range entries {
		if !rosterFilePattern.MatchString(e.Name()) {
			continue
		}
		if _, ok := want[e.Name()]; !ok {
			return nil, fmt.Errorf("%s is published but is not a file of this roster", e.Name())
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		if !bytes.HasPrefix(want[e.Name()], b) {
			return nil, fmt.Errorf("%s is published with other bytes than this roster's", e.Name())
		}
		have[e.Name()] = b
	}
	var out []rosterFile
	for _, name := range order {
		if !bytes.Equal(have[name], want[name]) {
			out = append(out, rosterFile{name, want[name]})
		}
	}
	return out, nil
}

// headsLine is one line of heads.jsonl (spec/record.md, "Heads file").
type headsLine struct {
	Date  verifier.Date
	Count uint64
	Head  string
}

func (h headsLine) line() []byte {
	return fmt.Appendf(nil, `{"date":"%s","count":%d,"head":"%s"}`+"\n", h.Date, h.Count, h.Head)
}

var headsLinePattern = regexp.MustCompile(`^\{"date":"([0-9-]{10})","count":([0-9]{1,16}),"head":"([0-9a-f]{64})"\}\n$`)

// readHeads reads heads.jsonl, checking that every line is in its one
// spelling, that dates increase and that counts do not decrease. A missing
// file has no lines.
func readHeads(path string) ([]headsLine, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []headsLine
	for n := 1; len(data) > 0; n++ {
		end := bytes.IndexByte(data, '\n') + 1
		if end == 0 {
			end = len(data)
		}
		raw := data[:end]
		data = data[end:]
		m := headsLinePattern.FindSubmatch(raw)
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
		h := headsLine{d, count, string(m[3])}
		if !bytes.Equal(h.line(), raw) {
			return nil, fmt.Errorf("line %d is not in its one spelling", n)
		}
		if len(out) > 0 {
			prev := out[len(out)-1]
			if h.Date <= prev.Date {
				return nil, fmt.Errorf("line %d: date %s is not after %s", n, h.Date, prev.Date)
			}
			if h.Count < prev.Count {
				return nil, fmt.Errorf("line %d: count %d is less than %d", n, h.Count, prev.Count)
			}
		}
		out = append(out, h)
	}
	return out, nil
}
