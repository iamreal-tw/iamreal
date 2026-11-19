package main

// The published roster (spec/record.md, "The published roster"): a roster
// directory, cut every 1,000 lines, its record hash lists and its
// fingerprint file.

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

const (
	fingerprintsFileName = "fingerprints.jsonl"
	// codeDirectory is the code of a roster directory that breaks the
	// rules of the directory itself. The spec says such a directory is
	// broken "like a malformed line" but gives it no code of its own.
	codeDirectory = "directory"
)

// rosterFilePattern matches the names of the files of a roster directory:
// 16 decimal digits and ".jsonl". Other files of the directory
// (fingerprints.jsonl among them) are not part of the roster file.
var rosterFilePattern = regexp.MustCompile(`^[0-9]{16}\.jsonl$`)

// hashListPattern matches the names of the record hash lists in
// roster.HashListDir.
var hashListPattern = regexp.MustCompile(`^[0-9]{16}\.txt$`)

// readDirectory reads a roster directory and returns the roster file, the
// concatenation of its files in name order. If the directory breaks the
// rules of the cut, it returns where: the line where the offending file
// starts or should start, and the code "directory".
//
// The rules: the file that follows the first b records is named b in 16
// digits; every file holds exactly 1,000 lines but the last, which holds 1
// to 1,000; there is no empty file. Lines are counted by LF, plus one for
// bytes after the last LF; a file whose lines are not well formed is then
// found by the checks of the roster file.
func readDirectory(dir string) ([]byte, *roster.Broken, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, err
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && rosterFilePattern.MatchString(e.Name()) {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	broken := func(line int, format string, args ...any) ([]byte, *roster.Broken, error) {
		return nil, &roster.Broken{Line: line, Code: codeDirectory, Err: fmt.Errorf(format, args...)}, nil
	}
	var file []byte
	for i, name := range names {
		before := i * roster.LinesPerFile
		first := before + 1
		if want := roster.RosterFileName(uint64(before)); name != want {
			return broken(first, "the file that starts at line %d is %s, not %s", first, name, want)
		}
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, nil, err
		}
		lines := bytes.Count(b, []byte("\n"))
		if len(b) > 0 && b[len(b)-1] != '\n' {
			lines++
		}
		last := i == len(names)-1
		switch {
		case lines == 0:
			return broken(first, "%s is empty", name)
		case !last && lines != roster.LinesPerFile:
			return broken(first, "%s has %d lines, not %d", name, lines, roster.LinesPerFile)
		case last && lines > roster.LinesPerFile:
			return broken(first, "%s has %d lines, more than %d", name, lines, roster.LinesPerFile)
		}
		file = append(file, b...)
	}
	return file, nil, nil
}

// checkHashLists checks the record hash lists of a roster directory against
// the roster's records: every list is in roster.HashListDir with the bytes
// written from the records, and there is no list without a roster file. It
// returns every problem, one per list, in name order, and the number of
// lists.
func checkHashLists(dir string, records []*verifier.Record) ([]string, int, error) {
	want := map[string][]byte{}
	for _, p := range roster.DirectoryFiles(records) {
		want[path.Base(p.HashList.Name)] = p.HashList.Data
	}
	listDir := filepath.Join(dir, roster.HashListDir)
	entries, err := os.ReadDir(listDir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, 0, err
	}
	found := map[string]bool{}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && hashListPattern.MatchString(e.Name()) {
			found[e.Name()] = true
			names = append(names, e.Name())
		}
	}
	for name := range want {
		if !found[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	var problems []string
	for _, name := range names {
		listPath := path.Join(roster.HashListDir, name)
		w, ok := want[name]
		switch {
		case !ok:
			problems = append(problems, listPath+" has no roster file")
		case !found[name]:
			problems = append(problems, listPath+" is missing")
		default:
			got, err := os.ReadFile(filepath.Join(listDir, name))
			if err != nil {
				return nil, 0, err
			}
			if !bytes.Equal(got, w) {
				problems = append(problems, listPath+" is not the record hash list of the roster")
			}
		}
	}
	return problems, len(names), nil
}

// fingerprintLine is one line of the fingerprint file.
type fingerprintLine struct {
	Date        verifier.Date
	Count       uint64
	Fingerprint string
}

func (fl fingerprintLine) line() []byte {
	return fmt.Appendf(nil, `{"date":"%s","count":%d,"fingerprint":"%s"}`+"\n", fl.Date, fl.Count, fl.Fingerprint)
}

var fingerprintLinePattern = regexp.MustCompile(`^\{"date":"([0-9-]{10})","count":([0-9]{1,16}),"fingerprint":"([0-9a-f]{64})"\}\n$`)

// checkFingerprints checks the fingerprint file of a roster directory
// against the roster's records: every line is the template filled in (one
// spelling), dates increase, counts do not decrease, and each line's
// fingerprint is the roster fingerprint of the first count records. It
// returns every problem, one per line at most, in order, and the number of
// lines. A missing fingerprint file is one problem.
func checkFingerprints(dir string, records []*verifier.Record) ([]string, int, error) {
	data, err := os.ReadFile(filepath.Join(dir, fingerprintsFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return []string{fingerprintsFileName + " is missing"}, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	fingerprints := make([]string, 0, len(records)+1)
	fingerprints = append(fingerprints, roster.EmptyFingerprint)
	for _, r := range records {
		fingerprints = append(fingerprints, roster.NextFingerprint(fingerprints[len(fingerprints)-1], r.Hash()))
	}
	var problems []string
	var prev *fingerprintLine
	n := 0
	for len(data) > 0 {
		n++
		end := bytes.IndexByte(data, '\n') + 1
		if end == 0 {
			end = len(data)
		}
		raw := data[:end]
		data = data[end:]
		fl, err := parseFingerprintLine(raw)
		if err == nil {
			err = fl.check(prev, fingerprints)
		}
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s line %d: %v", fingerprintsFileName, n, err))
			continue
		}
		prev = &fl
	}
	return problems, n, nil
}

// parseFingerprintLine reads a line of the fingerprint file, including its
// LF, in its one spelling.
func parseFingerprintLine(raw []byte) (fingerprintLine, error) {
	m := fingerprintLinePattern.FindSubmatch(raw)
	if m == nil {
		return fingerprintLine{}, errors.New("not the template of the spec")
	}
	d, err := verifier.ParseDate(string(m[1]))
	if err != nil {
		return fingerprintLine{}, fmt.Errorf("date: %v", err)
	}
	count, err := strconv.ParseUint(string(m[2]), 10, 64)
	if err != nil {
		return fingerprintLine{}, fmt.Errorf("count: %v", err)
	}
	fl := fingerprintLine{d, count, string(m[3])}
	if !bytes.Equal(fl.line(), raw) {
		return fingerprintLine{}, errors.New("not in its one spelling")
	}
	return fl, nil
}

// check checks fl against the line before it (nil for the first) and the
// roster fingerprints of the roster: fingerprints[c] is that of the first c
// records.
func (fl fingerprintLine) check(prev *fingerprintLine, fingerprints []string) error {
	if prev != nil && fl.Date <= prev.Date {
		return fmt.Errorf("date %s is not after %s", fl.Date, prev.Date)
	}
	if prev != nil && fl.Count < prev.Count {
		return fmt.Errorf("count %d is less than %d", fl.Count, prev.Count)
	}
	if fl.Count >= uint64(len(fingerprints)) {
		return fmt.Errorf("count %d, but the roster has %d records", fl.Count, len(fingerprints)-1)
	}
	if want := fingerprints[fl.Count]; fl.Fingerprint != want {
		return fmt.Errorf("fingerprint %s is not the roster fingerprint of the first %d records, %s", fl.Fingerprint, fl.Count, want)
	}
	return nil
}
