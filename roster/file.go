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
		rec, err := verifier.ParseLine(data[i:end], r)
		switch {
		case err != nil:
			return nil, "", &Broken{Line: n, Code: CodeLine, Err: err}
		case rec.Seq != uint64(n):
			return nil, "", &Broken{Line: n, Code: CodeSeq, Err: fmt.Errorf("seq %d on line %d", rec.Seq, n)}
		case rec.Prev != head:
			return nil, "", &Broken{Line: n, Code: CodePrev, Err: fmt.Errorf("prev is not %s", head)}
		}
		records = append(records, rec)
		head = rec.Hash()
		i = end
	}
	return records, head, nil
}
