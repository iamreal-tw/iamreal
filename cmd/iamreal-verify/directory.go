package main

// The published roster (spec/record.md, "The published roster"): a roster
// directory, cut every 1,000 lines, and its heads file.

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

const (
	linesPerFile  = 1000
	headsFileName = "heads.jsonl"
	// codeDirectory is the code of a roster directory that breaks the
	// rules of the directory itself. The spec says such a directory is
	// broken "like a malformed line" but gives it no code of its own.
	codeDirectory = "directory"
)

// rosterFilePattern matches the names of the files of a roster directory:
// 16 decimal digits and ".jsonl". Other files of the directory (heads.jsonl
// among them) are not part of the roster file.
var rosterFilePattern = regexp.MustCompile(`^[0-9]{16}\.jsonl$`)

// readDirectory reads a roster directory and returns the roster file, the
// concatenation of its files in name order. If the directory breaks the
// rules of the cut, it returns where: the line where the offending file
// starts or should start, and the code "directory".
//
// The rules: the file that starts with the record of seq s is named s in
// 16 digits; every file holds exactly 1,000 lines but the last, which holds
// 1 to 1,000; there is no empty file. Lines are counted by LF, plus one for
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
		first := i*linesPerFile + 1
		if want := fmt.Sprintf("%016d.jsonl", first); name != want {
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
		case !last && lines != linesPerFile:
			return broken(first, "%s has %d lines, not %d", name, lines, linesPerFile)
		case last && lines > linesPerFile:
			return broken(first, "%s has %d lines, more than %d", name, lines, linesPerFile)
		}
		file = append(file, b...)
	}
	return file, nil, nil
}

// headsLine is one line of the heads file.
type headsLine struct {
	Date  verifier.Date
	Count uint64
	Head  string
}

func (h headsLine) line() []byte {
	return fmt.Appendf(nil, `{"date":"%s","count":%d,"head":"%s"}`+"\n", h.Date, h.Count, h.Head)
}

var headsLinePattern = regexp.MustCompile(`^\{"date":"([0-9-]{10})","count":([0-9]{1,16}),"head":"([0-9a-f]{64})"\}\n$`)

// checkHeads checks the heads file of a roster directory against the
// roster's records: every line is the template filled in (one spelling),
// dates increase, counts do not decrease, and each line's head is the
// record hash of the record with seq = count (64 zeros for count 0). It
// returns every problem, one per line at most, in order. A missing heads
// file is one problem.
func checkHeads(dir string, records []*verifier.Record) ([]string, int, error) {
	data, err := os.ReadFile(filepath.Join(dir, headsFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return []string{headsFileName + " is missing"}, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	var problems []string
	var prev *headsLine
	n := 0
	for len(data) > 0 {
		n++
		end := bytes.IndexByte(data, '\n') + 1
		if end == 0 {
			end = len(data)
		}
		raw := data[:end]
		data = data[end:]
		h, err := parseHeadsLine(raw)
		if err == nil {
			err = h.check(prev, records)
		}
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s line %d: %v", headsFileName, n, err))
			continue
		}
		prev = &h
	}
	return problems, n, nil
}

// parseHeadsLine reads a line of the heads file, including its LF, in its
// one spelling.
func parseHeadsLine(raw []byte) (headsLine, error) {
	m := headsLinePattern.FindSubmatch(raw)
	if m == nil {
		return headsLine{}, errors.New("not the template of the spec")
	}
	d, err := verifier.ParseDate(string(m[1]))
	if err != nil {
		return headsLine{}, fmt.Errorf("date: %v", err)
	}
	count, err := strconv.ParseUint(string(m[2]), 10, 64)
	if err != nil {
		return headsLine{}, fmt.Errorf("count: %v", err)
	}
	h := headsLine{d, count, string(m[3])}
	if !bytes.Equal(h.line(), raw) {
		return headsLine{}, errors.New("not in its one spelling")
	}
	return h, nil
}

// check checks h against the line before it (nil for the first) and the
// roster's records.
func (h headsLine) check(prev *headsLine, records []*verifier.Record) error {
	if prev != nil && h.Date <= prev.Date {
		return fmt.Errorf("date %s is not after %s", h.Date, prev.Date)
	}
	if prev != nil && h.Count < prev.Count {
		return fmt.Errorf("count %d is less than %d", h.Count, prev.Count)
	}
	if h.Count > uint64(len(records)) {
		return fmt.Errorf("count %d, but the roster has %d records", h.Count, len(records))
	}
	want := verifier.GenesisPrev
	if h.Count > 0 {
		want = records[h.Count-1].Hash()
	}
	if h.Head != want {
		return fmt.Errorf("head %s is not the record hash of record %d, %s", h.Head, h.Count, want)
	}
	return nil
}
