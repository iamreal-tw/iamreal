// Package roster is the reference implementation of the roster rules
// (spec/roster-rules.md): it checks a roster file as a whole, applies the
// rules to each record in order, and computes the state of every card and
// account.
package roster

import (
	"bytes"
	"fmt"

	"github.com/iamreal-tw/iamreal/verifier"
)

// Codes of a broken roster file (spec/roster-rules.md, "Input").
const (
	CodeLine = "line" // the line is not well formed
	CodeSeq  = "seq"  // the seq of the n-th line is not n
	CodePrev = "prev" // prev is not the record hash of the line before
)

// Broken says where a roster file first fails: the line number, counting
// from 1, and the code.
type Broken struct {
	Line int
	Code string
	Err  error // what was wrong, for people; not part of the result
}

func (b *Broken) Error() string {
	return fmt.Sprintf("line %d: %s: %v", b.Line, b.Code, b.Err)
}

// ReadFile checks a roster file as a whole. Lines are checked one at a time,
// in order; for each line the checks run in the order line, seq, prev, and
// the first failure ends the check. For a valid file it returns the records
// and the head (the record hash of the last record, or 64 zeros for the empty
// file); for a broken one, where it breaks.
func ReadFile(data []byte, r verifier.Roster) (records []*verifier.Record, head string, broken *Broken) {
	head = verifier.GenesisPrev
	for i, n := 0, 1; i < len(data); n++ {
		end := len(data)
		if j := bytes.IndexByte(data[i:], '\n'); j >= 0 {
			end = i + j + 1
		}
		rec, broken := ReadLine(data[i:end], r, n, head)
		if broken != nil {
			return nil, "", broken
		}
		records = append(records, rec)
		head = rec.Hash()
		i = end
	}
	return records, head, nil
}

// ReadLine checks one line of a roster file: line is its bytes up to and
// including its LF, n its number (from 1), and prev the record hash of the
// line before it (64 zeros for the first). The checks run in the order line,
// seq, prev, as in ReadFile, which calls it for every line. The server calls
// it for each record it appends, so that it writes only lines that keep the
// file valid.
func ReadLine(line []byte, r verifier.Roster, n int, prev string) (*verifier.Record, *Broken) {
	rec, err := verifier.ParseLine(line, r)
	switch {
	case err != nil:
		return nil, &Broken{Line: n, Code: CodeLine, Err: err}
	case rec.Seq != uint64(n):
		return nil, &Broken{Line: n, Code: CodeSeq, Err: fmt.Errorf("seq %d on line %d", rec.Seq, n)}
	case rec.Prev != prev:
		return nil, &Broken{Line: n, Code: CodePrev, Err: fmt.Errorf("prev is not %s", prev)}
	}
	return rec, nil
}
