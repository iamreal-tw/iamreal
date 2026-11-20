package main

// The published roster (spec/record.md, "The published roster"): a roster
// directory, cut every 1,000 lines, its record hash lists and its
// fingerprint file. A re-verifier checks the roster up to the count of the
// fingerprint file's last line; records after it are not published yet.

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
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

// publishedRoster is a roster directory as read by readPublished.
type publishedRoster struct {
	// data is the roster file: the roster files concatenated in name
	// order, without the records after the published count.
	data []byte
	// broken is where the directory breaks the rules of the cut, if it
	// does; data is then nil.
	broken *roster.Broken
	// fingerprints is the fingerprint file; nil if fingerprintsMissing.
	fingerprints        []byte
	fingerprintsMissing bool
	// count is how many records the fingerprint file says are published
	// (publishedCount), if countKnown. Without it every roster file there
	// is was read.
	count      uint64
	countKnown bool
	// files is the number of roster files read.
	files int
	// cut is true if the last file read holds records after count: they
	// are not in data, and its record hash list is checked up to count.
	cut bool
}

// readPublished reads the roster directory at src. The fingerprint file
// says how many records are published (its last line's count,
// publishedCount), and so which roster files there are: the file that
// follows the first b records is named b in 16 digits, for every b below
// the count in steps of 1,000. Nothing is listed, so src can be a URL.
// Without a count (no fingerprint file, or no line of it as the spec
// writes it) it reads every roster file there is, from the first until one
// is missing; checkFingerprints reports why.
//
// The cut: every file holds exactly 1,000 lines but the last, which holds
// 1 to 1,000; there is no empty file; with a count, every file below it is
// there. Lines are counted by LF, plus one for bytes after the last LF; a
// file whose lines are not well formed is then found by the checks of the
// roster file. A last file with fewer records than the count is not a
// break of the cut: checkFingerprints reports the count.
func readPublished(src source) (*publishedRoster, error) {
	p := &publishedRoster{}
	fp, err := src.get(fingerprintsFileName)
	switch {
	case errors.Is(err, errNotFound):
		p.fingerprintsMissing = true
	case err != nil:
		return nil, err
	default:
		p.fingerprints = fp
		p.count, p.countKnown = publishedCount(fp)
	}
	broken := func(line uint64, format string, args ...any) (*publishedRoster, error) {
		p.data, p.broken = nil, &roster.Broken{Line: int(line), Code: codeDirectory, Err: fmt.Errorf(format, args...)}
		return p, nil
	}
	// The files there are, from the first until one is missing. With a
	// count, a file below it that is missing breaks the directory where
	// it should start, unless a file before it already did.
	var files [][]byte
	missing := false
	for before := uint64(0); !p.countKnown || before < p.count; before += roster.LinesPerFile {
		b, err := src.get(roster.RosterFileName(before))
		if errors.Is(err, errNotFound) {
			missing = p.countKnown
			break
		}
		if err != nil {
			return nil, err
		}
		files = append(files, b)
	}
	p.files = len(files)
	for i, b := range files {
		before := uint64(i) * roster.LinesPerFile
		name := roster.RosterFileName(before)
		lines := bytes.Count(b, []byte("\n"))
		if len(b) > 0 && b[len(b)-1] != '\n' {
			lines++
		}
		switch last := i == len(files)-1 && !missing; {
		case lines == 0:
			return broken(before+1, "%s is empty", name)
		case !last && lines != roster.LinesPerFile:
			return broken(before+1, "%s has %d lines, not %d", name, lines, roster.LinesPerFile)
		case last && lines > roster.LinesPerFile:
			return broken(before+1, "%s has %d lines, more than %d", name, lines, roster.LinesPerFile)
		}
		if p.countKnown && before+roster.LinesPerFile > p.count {
			// The file that holds record count: keep its lines up to it.
			keep, end := p.count-before, 0
			for n := uint64(0); n < keep; n++ {
				i := bytes.IndexByte(b[end:], '\n')
				if i < 0 {
					end = len(b)
					break
				}
				end += i + 1
			}
			p.cut = end < len(b)
			b = b[:end]
		}
		p.data = append(p.data, b...)
	}
	if missing {
		before := uint64(len(files)) * roster.LinesPerFile
		return broken(before+1, "%s, the file that starts at line %d, is missing", roster.RosterFileName(before), before+1)
	}
	return p, nil
}

// publishedCount returns how many records a fingerprint file says are
// published: the largest count of its lines that are as the spec writes
// them, if any is. In a fingerprint file without problems that is the
// count of its last line. In one with problems, every line that can be
// read is then checked against the records it names, and each problem is
// reported on its own line: a count that decreases on line 2, not a count
// beyond the roster on line 1.
func publishedCount(fp []byte) (uint64, bool) {
	var count uint64
	known := false
	for len(fp) > 0 {
		end := bytes.IndexByte(fp, '\n') + 1
		if end == 0 {
			end = len(fp)
		}
		if fl, err := parseFingerprintLine(fp[:end]); err == nil {
			count, known = max(count, fl.Count), true
		}
		fp = fp[end:]
	}
	return count, known
}

// checkHashLists checks the record hash list of every roster file read
// against the roster's records: it is in roster.HashListDir with the bytes
// written from the records; for a file cut at the count, its lines up to
// the count are. It returns every problem, one per list, in name order,
// and the number of lists.
func checkHashLists(src source, p *publishedRoster, records []*verifier.Record) ([]string, int, error) {
	var problems []string
	parts := roster.DirectoryFiles(records)
	for i, part := range parts {
		want := part.HashList
		got, err := src.get(want.Name)
		switch {
		case errors.Is(err, errNotFound):
			problems = append(problems, want.Name+" is missing")
			continue
		case err != nil:
			return nil, 0, err
		}
		ok := bytes.Equal(got, want.Data)
		if p.cut && i == len(parts)-1 {
			ok = bytes.HasPrefix(got, want.Data)
		}
		if !ok {
			problems = append(problems, want.Name+" is not the record hash list of the roster")
		}
	}
	return problems, len(parts), nil
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
func checkFingerprints(p *publishedRoster, records []*verifier.Record) []string {
	if p.fingerprintsMissing {
		return []string{fingerprintsFileName + " is missing"}
	}
	data := p.fingerprints
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
	return problems
}

// fingerprintLines is the number of lines of a fingerprint file.
func fingerprintLines(data []byte) int {
	n := bytes.Count(data, []byte("\n"))
	if len(data) > 0 && data[len(data)-1] != '\n' {
		n++
	}
	return n
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
