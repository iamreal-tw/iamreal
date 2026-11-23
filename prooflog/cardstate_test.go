package prooflog_test

// Tests against spec/vectors/card-state-file.json: reading and writing the
// card state file ("files"), the rows of a case of record-rules.json, and
// the comparison ("comparisons").

import (
	"encoding/hex"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

// rowOut is a row in the shape of the vectors' `cards`: `slots` has only the
// slots the row lists.
type rowOut struct {
	ScopeString      string             `json:"scope_string"`
	ScopedID         string             `json:"scoped_id"`
	LastSeq          uint64             `json:"last_seq"`
	LastCardProof    string             `json:"last_card_proof"`
	ProofsOnLastDate int                `json:"proofs_on_last_date"`
	Slots            map[string]slotOut `json:"slots"`
}

type cardStateFileCase struct {
	Name            string   `json:"name"`
	ProofLog        string   `json:"proof_log"`
	Content         string   `json:"content"`
	ContentHex      string   `json:"content_hex"`
	Valid           bool     `json:"valid"`
	Cards           []rowOut `json:"cards"`
	Line            int      `json:"line"`
	Code            string   `json:"code"`
	RecordRulesCase string   `json:"record_rules_case"`
	Count           int      `json:"count"`
	RulesLeave      *bool    `json:"rules_leave"`
}

type outcomeOut struct {
	ScopeString string `json:"scope_string"`
	ScopedID    string `json:"scoped_id"`
	Outcome     string `json:"outcome"`
}

type comparisonCase struct {
	Name     string       `json:"name"`
	ProofLog string       `json:"proof_log"`
	Count    uint64       `json:"count"`
	Verified uint64       `json:"verified"`
	Content  string       `json:"content"`
	Computed []rowOut     `json:"computed"`
	Outcomes []outcomeOut `json:"outcomes"`
	Passes   bool         `json:"passes"`
}

func loadCardStateVectors(t *testing.T) ([]cardStateFileCase, []comparisonCase) {
	t.Helper()
	var v struct {
		RulesVersion *int                `json:"rules_version"`
		Files        []cardStateFileCase `json:"files"`
		Comparisons  []comparisonCase    `json:"comparisons"`
	}
	load(t, "card-state-file.json", &v)
	if len(v.Files) == 0 || len(v.Comparisons) == 0 {
		t.Fatal("no cases")
	}
	// The files of record-rules.json's cases are computed by one version of
	// the rules, as record-rules.json's are (version_test.go).
	if v.RulesVersion == nil || *v.RulesVersion != prooflog.RulesVersion {
		t.Fatalf("RulesVersion is %d, spec/vectors/card-state-file.json has %v", prooflog.RulesVersion, v.RulesVersion)
	}
	return v.Files, v.Comparisons
}

// bytes returns the file's bytes: content_hex if the vector has it (bytes
// that are not UTF-8), otherwise the UTF-8 of content.
func (f cardStateFileCase) bytes(t *testing.T) []byte {
	t.Helper()
	if f.ContentHex == "" {
		return []byte(f.Content)
	}
	if f.Content != "" {
		t.Fatal("both content and content_hex")
	}
	b, err := hex.DecodeString(f.ContentHex)
	if err != nil {
		t.Fatalf("content_hex: %v", err)
	}
	return b
}

// rowsOut writes rows in the shape of the vectors, without the slots in the
// initial state.
func rowsOut(rows []prooflog.CardRow) []rowOut {
	out := []rowOut{}
	for _, row := range rows {
		ro := rowOut{ScopeString: row.ScopeString, ScopedID: row.ScopedID, LastSeq: row.LastSeq, ProofsOnLastDate: row.State.ProofsOnLastDate, Slots: map[string]slotOut{}}
		if row.State.LastCardProof != nil {
			ro.LastCardProof = row.State.LastCardProof.String()
		}
		for p, so := range slotsOut(row.State) {
			if so.Current != nil || so.LastDeclared != nil || so.SwitchCount != 0 || so.CorrectionDate != nil {
				ro.Slots[p] = so
			}
		}
		out = append(out, ro)
	}
	return out
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestVectorsCardStateFileRead(t *testing.T) {
	files, _ := loadCardStateVectors(t)
	for _, f := range files {
		t.Run(f.Name, func(t *testing.T) {
			rows, b := prooflog.ReadCardStateFile(f.bytes(t), proofLogOf(t, f.ProofLog))
			if !f.Valid {
				if b == nil {
					t.Fatalf("valid, want broken at line %d with %s", f.Line, f.Code)
				}
				if b.Line != f.Line || b.Code != f.Code {
					t.Errorf("broken at line %d with %s (%v), want line %d with %s", b.Line, b.Code, b.Err, f.Line, f.Code)
				}
				return
			}
			if b != nil {
				t.Fatalf("broken: %v", b)
			}
			if got, want := rowsOut(rows), f.Cards; !reflect.DeepEqual(got, want) {
				t.Errorf("rows\n got %s\nwant %s", jsonText(got), jsonText(want))
			}
			// Every row has a slot on every platform of the table, as a
			// CardState does.
			for _, row := range rows {
				for _, p := range verifier.Platforms(proofLogOf(t, f.ProofLog)) {
					if _, ok := row.State.Slots[p.ID]; !ok {
						t.Errorf("%s: no slot on %s", row.ScopedID, p.ID)
					}
				}
			}
		})
	}
}

// rowsIn turns the vectors' `cards` into rows, with a slot in the initial
// state on every platform of the table that the vector does not list.
func rowsIn(t *testing.T, cards []rowOut, r verifier.ProofLog) []prooflog.CardRow {
	t.Helper()
	var rows []prooflog.CardRow
	for _, c := range cards {
		d := date(t, c.LastCardProof)
		row := prooflog.CardRow{ScopeString: c.ScopeString, ScopedID: c.ScopedID, LastSeq: c.LastSeq,
			State: prooflog.CardState{LastCardProof: &d, ProofsOnLastDate: c.ProofsOnLastDate, Slots: map[string]prooflog.Slot{}}}
		for _, p := range verifier.Platforms(r) {
			row.State.Slots[p.ID] = prooflog.Slot{}
		}
		for p, s := range c.Slots {
			slot := prooflog.Slot{Current: s.Current, LastDeclared: s.LastDeclared, SwitchCount: s.SwitchCount}
			if s.CorrectionDate != nil {
				cd := date(t, *s.CorrectionDate)
				slot.CorrectionDate = &cd
			}
			row.State.Slots[p] = slot
		}
		rows = append(rows, row)
	}
	return rows
}

func TestVectorsCardStateFileWrite(t *testing.T) {
	files, _ := loadCardStateVectors(t)
	for _, f := range files {
		if !f.Valid {
			continue
		}
		t.Run(f.Name, func(t *testing.T) {
			rows := rowsIn(t, f.Cards, proofLogOf(t, f.ProofLog))
			// In any order: the file sorts them.
			for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
				rows[i], rows[j] = rows[j], rows[i]
			}
			if got := string(prooflog.CardStateFile(rows)); got != f.Content {
				t.Errorf("file\n got %q\nwant %q", got, f.Content)
			}
		})
	}
}

// The files that are the final state of a case of record-rules.json: the
// rows the rules give, one record at a time and for a whole log file,
// are the file's cards, and writing them gives the file.
func TestVectorsCardStateFileOfRecordRules(t *testing.T) {
	files, _ := loadCardStateVectors(t)
	var v struct {
		Cases []rulesCase `json:"cases"`
	}
	load(t, "record-rules.json", &v)
	cases := map[string]rulesCase{}
	for _, c := range v.Cases {
		cases[c.Name] = c
	}
	n := 0
	for _, f := range files {
		if f.RecordRulesCase == "" {
			continue
		}
		n++
		t.Run(f.Name, func(t *testing.T) {
			c, ok := cases[f.RecordRulesCase]
			if !ok {
				t.Fatalf("no case %q in record-rules.json", f.RecordRulesCase)
			}
			if c.ProofLog != f.ProofLog || len(c.Events) != f.Count {
				t.Fatalf("case of the %s log with %d events, the file says %s and %d", c.ProofLog, len(c.Events), f.ProofLog, f.Count)
			}
			r := proofLogOf(t, c.ProofLog)
			records, proofs, archive := caseRecords(t, c)
			x := prooflog.NewRules(r, proofs, archive)
			var file []byte
			for _, rec := range records {
				if _, err := x.Apply(rec); err != nil {
					t.Fatal(err)
				}
				file = append(file, rec.Line()...)
			}
			if got := rowsOut(x.CardRows()); !reflect.DeepEqual(got, f.Cards) {
				t.Errorf("Rules.CardRows\n got %s\nwant %s", jsonText(got), jsonText(f.Cards))
			}
			if got := string(prooflog.CardStateFile(x.CardRows())); got != f.Content {
				t.Errorf("file\n got %q\nwant %q", got, f.Content)
			}
			rep, err := prooflog.Check(file, r, proofs, archive)
			if err != nil {
				t.Fatal(err)
			}
			if got := rowsOut(rep.Cards); !reflect.DeepEqual(got, f.Cards) {
				t.Errorf("Report.Cards\n got %s\nwant %s", jsonText(got), jsonText(f.Cards))
			}
		})
	}
	if n == 0 {
		t.Fatal("no file names a case of record-rules.json")
	}
}

func TestVectorsCardStateComparisons(t *testing.T) {
	_, comparisons := loadCardStateVectors(t)
	for _, c := range comparisons {
		t.Run(c.Name, func(t *testing.T) {
			r := proofLogOf(t, c.ProofLog)
			rows, b := prooflog.ReadCardStateFile([]byte(c.Content), r)
			if b != nil {
				t.Fatalf("the file is broken: %v", b)
			}
			cmp := prooflog.CompareCardStates(rows, c.Count, c.Verified, rowsIn(t, c.Computed, r))
			got := []outcomeOut{}
			for _, o := range cmp.Outcomes {
				got = append(got, outcomeOut{o.ScopeString, o.ScopedID, o.Outcome})
				// What differs is said for every different card, and only
				// for those.
				if (o.Outcome == prooflog.OutcomeDifferent) != (len(o.Differences) > 0) {
					t.Errorf("%s %s: %s with differences %q", o.ScopedID, o.Outcome, o.Outcome, o.Differences)
				}
			}
			if !reflect.DeepEqual(got, c.Outcomes) {
				t.Errorf("outcomes\n got %s\nwant %s", jsonText(got), jsonText(c.Outcomes))
			}
			if cmp.Passes() != c.Passes {
				t.Errorf("passes %v, want %v", cmp.Passes(), c.Passes)
			}
		})
	}
}
