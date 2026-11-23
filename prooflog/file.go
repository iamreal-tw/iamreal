// Package proof log is the reference implementation of the record rules
// (spec/record-rules.md): it checks a log file as a whole, applies the
// rules to each record in order, and computes the state of every card and
// account.
package prooflog

import (
	"bytes"
	"fmt"

	"github.com/iamreal-tw/iamreal/verifier"
)

// Codes of a broken log file (spec/record-rules.md, "Input").
const (
	CodeLine = "line" // the line is not well formed
	CodeSeq  = "seq"  // the seq of the n-th line is not n
)

// Broken says where a log file first fails: the line number, counting
// from 1, and the code.
type Broken struct {
	Line int
	Code string
	Err  error // what was wrong, for people; not part of the result
}

func (b *Broken) Error() string {
	return fmt.Sprintf("line %d: %s: %v", b.Line, b.Code, b.Err)
}

// ReadFile checks a log file as a whole. Lines are checked one at a time,
// in order; for each line the checks run in the order line, seq, and the
// first failure ends the check. For a valid file it returns the records and
// the proof log fingerprint of all of them (EmptyFingerprint for the empty
// file); for a broken one, where it breaks.
func ReadFile(data []byte, r verifier.ProofLog) (records []*verifier.Record, fingerprint string, broken *Broken) {
	fingerprint = EmptyFingerprint
	for i, n := 0, 1; i < len(data); n++ {
		end := len(data)
		if j := bytes.IndexByte(data[i:], '\n'); j >= 0 {
			end = i + j + 1
		}
		rec, broken := ReadLine(data[i:end], r, n)
		if broken != nil {
			return nil, "", broken
		}
		records = append(records, rec)
		fingerprint = NextFingerprint(fingerprint, rec.Hash())
		i = end
	}
	return records, fingerprint, nil
}

// ReadLine checks one line of a log file: line is its bytes up to and
// including its LF, and n its number (from 1). The checks run in the order
// line, seq, as in ReadFile, which calls it for every line. The server calls
// it for each record it appends, so that it writes only lines that keep the
// file valid.
func ReadLine(line []byte, r verifier.ProofLog, n int) (*verifier.Record, *Broken) {
	rec, err := verifier.ParseLine(line, r)
	switch {
	case err != nil:
		return nil, &Broken{Line: n, Code: CodeLine, Err: err}
	case rec.Seq != uint64(n):
		return nil, &Broken{Line: n, Code: CodeSeq, Err: fmt.Errorf("seq %d on line %d", rec.Seq, n)}
	}
	return rec, nil
}
