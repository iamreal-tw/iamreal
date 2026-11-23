package prooflog

// The card state file (spec/record-rules.md, "The card state file"): the
// state the server keeps of every card that has a valid record, one row a
// card, published once a day so that a re-verifier can compare it with the
// states it computes from the proof log (ADR-0025). Like a proof log line, a row
// has one spelling: it is read by parsing it, checking every value, writing
// it again from the template and comparing bytes.
//
// The format checks each value by itself, not whether a row is a state the
// rules can leave: a wrong kept state is what the file is there to show.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"

	"github.com/iamreal-tw/iamreal/verifier"
)

// Codes of a broken card state file (spec/record-rules.md, "The file").
// CodeLine, a row that is not in its one spelling, is the log file's.
const (
	// CodeOrder: the card of the row is not after the card of the row
	// before it (the same card twice included).
	CodeOrder = "order"
)

// CardRow is a row of a card state file: a card, its state, and the seq of
// its last valid record.
type CardRow struct {
	ScopeString string
	ScopedID    string
	// LastSeq is the seq of the card's last valid record.
	LastSeq uint64
	// State is the card's state. It has a slot on every platform of the
	// proof log's table, as a CardState does: a slot the row does not list is
	// in the initial state.
	State CardState
}

// before reports whether the card of a sorts before the card of b in a card
// state file: by scope string, then by scoped ID, by byte values.
func (a CardRow) before(b CardRow) bool {
	if a.ScopeString != b.ScopeString {
		return a.ScopeString < b.ScopeString
	}
	return a.ScopedID < b.ScopedID
}

// initial reports whether every item of s has its initial value: such a
// slot is not listed in a row.
func (s Slot) initial() bool {
	return s.Current == nil && s.LastDeclared == nil && s.SwitchCount == 0 && s.CorrectionDate == nil
}

// line writes the row from the template, followed by LF: its slots that are
// not in the initial state, in ascending order of platform. It does not
// check the values.
func (row CardRow) line() []byte {
	var b bytes.Buffer
	b.WriteString(`{"scope_string":"` + row.ScopeString + `","scoped_id":"` + row.ScopedID + `","last_seq":`)
	b.WriteString(strconv.FormatUint(row.LastSeq, 10))
	b.WriteString(`,"last_card_proof":`)
	b.WriteString(dateText(row.State.LastCardProof))
	b.WriteString(`,"proofs_on_last_date":`)
	b.WriteString(strconv.Itoa(row.State.ProofsOnLastDate))
	b.WriteString(`,"slots":{`)
	for i, p := range listedPlatforms(row.State) {
		s := row.State.Slots[p]
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`"` + p + `":{"current":` + usernameText(s.Current) + `,"last_declared":` + usernameText(s.LastDeclared))
		b.WriteString(`,"switch_count":` + strconv.Itoa(s.SwitchCount) + `,"correction_date":` + dateText(s.CorrectionDate) + `}`)
	}
	b.WriteString("}}\n")
	return b.Bytes()
}

// listedPlatforms returns the platforms of the slots of cs that are not in
// the initial state, in ascending order by byte value.
func listedPlatforms(cs CardState) []string {
	var out []string
	for p, s := range cs.Slots {
		if !s.initial() {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

func usernameText(u *string) string {
	if u == nil {
		return "null"
	}
	return `"` + *u + `"`
}

func dateText(d *verifier.Date) string {
	if d == nil {
		return "null"
	}
	return `"` + d.String() + `"`
}

// CardStateFile writes the card state file of rows: one row a card, in the
// order of the file whatever order they are given in, each without its
// slots in the initial state. No row gives the empty file. It does not
// check the values; ReadCardStateFile does.
func CardStateFile(rows []CardRow) []byte {
	sorted := append([]CardRow(nil), rows...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].before(sorted[j]) })
	var out []byte
	for _, row := range sorted {
		out = append(out, row.line()...)
	}
	return out
}

// ReadCardStateFile checks a card state file of a proof log r as a whole.
// Lines are checked one at a time, in order; for each line the checks run
// in the order line, order, and the first failure ends the check. For a
// valid file it returns the rows in the order of the file (none for the
// empty file); for a broken one, where it breaks.
func ReadCardStateFile(data []byte, r verifier.ProofLog) ([]CardRow, *Broken) {
	var rows []CardRow
	for i, n := 0, 1; i < len(data); n++ {
		end := len(data)
		if j := bytes.IndexByte(data[i:], '\n'); j >= 0 {
			end = i + j + 1
		}
		row, err := readCardRow(data[i:end], r)
		if err != nil {
			return nil, &Broken{Line: n, Code: CodeLine, Err: err}
		}
		if len(rows) > 0 && !rows[len(rows)-1].before(row) {
			return nil, &Broken{Line: n, Code: CodeOrder, Err: errors.New("the card is not after the card of the row before")}
		}
		rows = append(rows, row)
		i = end
	}
	return rows, nil
}

// The shape a row is parsed into. encoding/json accepts more than the
// template (duplicate keys, keys in another case, unknown keys, a string
// where a number goes); writing the row again and comparing bytes rejects
// all of it.
type rowJSON struct {
	ScopeString      string               `json:"scope_string"`
	ScopedID         string               `json:"scoped_id"`
	LastSeq          json.Number          `json:"last_seq"`
	LastCardProof    *string              `json:"last_card_proof"`
	ProofsOnLastDate json.Number          `json:"proofs_on_last_date"`
	Slots            map[string]*slotJSON `json:"slots"`
}

type slotJSON struct {
	Current        *string     `json:"current"`
	LastDeclared   *string     `json:"last_declared"`
	SwitchCount    json.Number `json:"switch_count"`
	CorrectionDate *string     `json:"correction_date"`
}

// readCardRow checks one line of a card state file: line is its bytes up
// to and including its LF. It parses the line, checks every value, writes
// the row again and compares bytes. An error means the line is not a
// well-formed row.
func readCardRow(line []byte, r verifier.ProofLog) (CardRow, error) {
	var row CardRow
	if len(line) == 0 || line[len(line)-1] != '\n' {
		return row, errors.New("line does not end with LF")
	}
	var v rowJSON
	if err := json.Unmarshal(line, &v); err != nil {
		return row, fmt.Errorf("not a JSON object of a row: %v", err)
	}
	if _, ok := verifier.LookupScope(r, v.ScopeString); !ok {
		return row, fmt.Errorf("scope_string: not an accepted scope of the %s log", r)
	}
	if _, err := verifier.ParseScopedID(v.ScopedID); err != nil {
		return row, err // it says scoped_id
	}
	lastSeq, err := boundedInt(v.LastSeq, 1)
	if err != nil {
		return row, fmt.Errorf("last_seq: %v", err)
	}
	if v.LastCardProof == nil {
		return row, errors.New("last_card_proof: null")
	}
	lastCardProof, err := verifier.ParseDate(*v.LastCardProof)
	if err != nil {
		return row, fmt.Errorf("last_card_proof: %v", err)
	}
	proofs, err := boundedInt(v.ProofsOnLastDate, 0)
	if err != nil {
		return row, fmt.Errorf("proofs_on_last_date: %v", err)
	}
	row = CardRow{ScopeString: v.ScopeString, ScopedID: v.ScopedID, LastSeq: lastSeq,
		State: CardState{LastCardProof: &lastCardProof, ProofsOnLastDate: int(proofs), Slots: map[string]Slot{}}}
	for _, p := range verifier.Platforms(r) {
		row.State.Slots[p.ID] = Slot{}
	}
	for id, s := range v.Slots {
		p, ok := verifier.LookupPlatform(r, id)
		if !ok {
			return row, fmt.Errorf("slots: %q is not a platform of the %s log", id, r)
		}
		if s == nil {
			return row, fmt.Errorf("slots: %s: null", id)
		}
		slot := Slot{Current: s.Current, LastDeclared: s.LastDeclared}
		for _, u := range []*string{s.Current, s.LastDeclared} {
			if u != nil && !p.ValidUsername(*u) {
				return row, fmt.Errorf("slots: %s: a username not in the format %s", id, p.UsernameFormat)
			}
		}
		n, err := boundedInt(s.SwitchCount, 0)
		if err != nil {
			return row, fmt.Errorf("slots: %s: switch_count: %v", id, err)
		}
		slot.SwitchCount = int(n)
		if s.CorrectionDate != nil {
			d, err := verifier.ParseDate(*s.CorrectionDate)
			if err != nil {
				return row, fmt.Errorf("slots: %s: correction_date: %v", id, err)
			}
			slot.CorrectionDate = &d
		}
		row.State.Slots[id] = slot
	}
	if !bytes.Equal(row.line(), line) {
		return row, errors.New("not written exactly as the template")
	}
	return row, nil
}

// boundedInt reads a decimal integer from least to verifier.MaxSeq (2^53 − 1).
// A spelling other than the template's (leading zeros, 1.0, 1e0) is left
// to the byte comparison, as long as it is such an integer.
func boundedInt(n json.Number, least uint64) (uint64, error) {
	v, err := strconv.ParseUint(n.String(), 10, 64)
	if err != nil || v < least || v > verifier.MaxSeq {
		return 0, fmt.Errorf("not a decimal integer from %d to 2^53 − 1", least)
	}
	return v, nil
}

// Outcomes of comparing one card (spec/record-rules.md, "Comparing").
const (
	OutcomeSame      = "same"
	OutcomeSkipped   = "skipped"
	OutcomeDifferent = "different"
)

// CardOutcome is the outcome of one card.
type CardOutcome struct {
	ScopeString string
	ScopedID    string
	Outcome     string
	// Differences, for a different card: what differs, one item each, for
	// people; not part of the result.
	Differences []string
}

// CardComparison is a card state file compared with a re-verifier's own
// computation: one outcome for every card that has a row, a valid record
// among the records applied, or both, in the order of a file's rows.
type CardComparison struct {
	Outcomes []CardOutcome
}

// Passes reports whether no card is different. A skipped card is not a
// failure.
func (c CardComparison) Passes() bool {
	for _, o := range c.Outcomes {
		if o.Outcome == OutcomeDifferent {
			return false
		}
	}
	return true
}

// CompareCardStates compares the rows of a valid card state file with the
// rows a re-verifier computes (spec/record-rules.md, "Comparing"). count is
// the count of the fingerprint file's line of the file's date; applied, N,
// the number of records the re-verifier has applied the rules to; computed,
// its rows after them (Rules.CardRows). Each card gets the outcome of the
// first line of the table that applies.
func CompareCardStates(file []CardRow, count, applied uint64, computed []CardRow) CardComparison {
	type pair struct{ file, computed *CardRow }
	cards := map[cardKey]*pair{}
	var keys []CardRow // one row of each card, for its order
	at := func(row CardRow) *pair {
		k := cardKey{row.ScopeString, row.ScopedID}
		if cards[k] == nil {
			cards[k] = &pair{}
			keys = append(keys, row)
		}
		return cards[k]
	}
	for i := range file {
		at(file[i]).file = &file[i]
	}
	for i := range computed {
		at(computed[i]).computed = &computed[i]
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].before(keys[j]) })
	var out CardComparison
	for _, k := range keys {
		p := cards[cardKey{k.ScopeString, k.ScopedID}]
		o := CardOutcome{ScopeString: k.ScopeString, ScopedID: k.ScopedID}
		switch {
		case p.file != nil && p.file.LastSeq > count:
			o.Outcome = OutcomeDifferent
			o.Differences = []string{fmt.Sprintf("the row's last_seq %d is beyond the file's count %d", p.file.LastSeq, count)}
		case p.file != nil && p.file.LastSeq > applied:
			o.Outcome = OutcomeSkipped
		case p.computed != nil && p.computed.LastSeq > count:
			o.Outcome = OutcomeSkipped
		case p.computed == nil:
			o.Outcome = OutcomeDifferent
			o.Differences = []string{fmt.Sprintf("the file has a row with last_seq %d, the proof log gives no valid record up to %d", p.file.LastSeq, applied)}
		case p.file == nil:
			o.Outcome = OutcomeDifferent
			o.Differences = []string{fmt.Sprintf("the file has no row, the proof log gives a valid record at seq %d", p.computed.LastSeq)}
		default:
			o.Differences = rowDifferences(*p.file, *p.computed)
			o.Outcome = OutcomeSame
			if len(o.Differences) > 0 {
				o.Outcome = OutcomeDifferent
			}
		}
		out.Outcomes = append(out.Outcomes, o)
	}
	return out
}

// rowDifferences lists every item on which the row of the file and the
// computed row differ, as "item: file …, proof log …". A platform that one of
// them has no slot for is a slot in the initial state.
func rowDifferences(file, computed CardRow) []string {
	var out []string
	diff := func(item, f, c string) {
		if f != c {
			out = append(out, fmt.Sprintf("%s: file %s, proof log %s", item, f, c))
		}
	}
	diff("last_seq", strconv.FormatUint(file.LastSeq, 10), strconv.FormatUint(computed.LastSeq, 10))
	diff("last_card_proof", dateText(file.State.LastCardProof), dateText(computed.State.LastCardProof))
	diff("proofs_on_last_date", strconv.Itoa(file.State.ProofsOnLastDate), strconv.Itoa(computed.State.ProofsOnLastDate))
	platforms := map[string]bool{}
	for p := range file.State.Slots {
		platforms[p] = true
	}
	for p := range computed.State.Slots {
		platforms[p] = true
	}
	var ids []string
	for p := range platforms {
		ids = append(ids, p)
	}
	sort.Strings(ids)
	for _, p := range ids {
		f, c := file.State.Slots[p], computed.State.Slots[p]
		diff(p+" current", usernameText(f.Current), usernameText(c.Current))
		diff(p+" last_declared", usernameText(f.LastDeclared), usernameText(c.LastDeclared))
		diff(p+" switch_count", strconv.Itoa(f.SwitchCount), strconv.Itoa(c.SwitchCount))
		diff(p+" correction_date", dateText(f.CorrectionDate), dateText(c.CorrectionDate))
	}
	return out
}
