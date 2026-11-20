package roster_test

// The answers for worker/'s comparison of a long sequence of records
// (worker/test/sequence.test.ts, #73): this package applies the rules to the
// sequence one record at a time and writes, for each record, its result and
// the state of its card after it. TypeScript's protocol/, with its state in
// memory and in the roster's Durable Object, must give the same.
//
// The two implementations do not import each other and share only spec/
// (CLAUDE.md), so the sequence and the answers are exchanged as files in the
// shape of a case of spec/vectors/roster-rules.json, which both already
// read: worker/ writes the events, this writes the results, the final state
// and `cards`, the state of each record's card after it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
)

// cardAfter is the state of a card (roster.Card) in the spelling of the
// vectors' `state`, with last_card_proof null for a card with no valid
// record.
type cardAfter struct {
	ScopeString      string             `json:"scope_string"`
	ScopedID         string             `json:"scoped_id"`
	LastCardProof    *string            `json:"last_card_proof"`
	ProofsOnLastDate int                `json:"proofs_on_last_date"`
	Slots            map[string]slotOut `json:"slots"`
}

// sequenceAnswers is a case of the vectors with its answers, and `cards`:
// for each event, the state of its card after it.
type sequenceAnswers struct {
	RulesVersion int         `json:"rules_version"`
	Name         string      `json:"name"`
	Roster       string      `json:"roster"`
	Events       []event     `json:"events"`
	Results      []result    `json:"results"`
	Cards        []cardAfter `json:"cards"`
	State        []scopeOut  `json:"state"`
}

// answersOf applies the rules to the events of c one record at a time.
func answersOf(t *testing.T, c rulesCase) sequenceAnswers {
	t.Helper()
	records, proofs, archive := caseRecords(t, c)
	x := roster.NewRules(rosterOf(t, c.Roster), proofs, archive)
	out := sequenceAnswers{RulesVersion: roster.RulesVersion, Name: c.Name, Roster: c.Roster, Events: c.Events, Results: []result{}, Cards: []cardAfter{}}
	for _, rec := range records {
		res, err := x.Apply(rec)
		if err != nil {
			t.Fatalf("seq %d: %v", rec.Seq, err)
		}
		out.Results = append(out.Results, resultOf(res))
		cs := x.Card(rec.ScopeString, rec.ScopedID)
		card := cardAfter{ScopeString: rec.ScopeString, ScopedID: rec.ScopedID, ProofsOnLastDate: cs.ProofsOnLastDate, Slots: map[string]slotOut{}}
		if cs.LastCardProof != nil {
			d := cs.LastCardProof.String()
			card.LastCardProof = &d
		}
		for p, s := range cs.Slots {
			so := slotOut{Current: s.Current, LastDeclared: s.LastDeclared, SwitchCount: s.SwitchCount}
			if s.CorrectionDate != nil {
				d := s.CorrectionDate.String()
				so.CorrectionDate = &d
			}
			card.Slots[p] = so
		}
		out.Cards = append(out.Cards, card)
	}
	out.State = stateOut(x.State(), x)
	return out
}

// The answers for every case of the vectors are the vectors' own: each
// record's result, the final state, and each card's state after its last
// record.
func TestSequenceAnswersOfVectors(t *testing.T) {
	var v struct {
		Cases []rulesCase `json:"cases"`
	}
	load(t, "roster-rules.json", &v)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			a := answersOf(t, c)
			if !reflect.DeepEqual(a.Results, c.Results) {
				t.Errorf("results\n got %+v\nwant %+v", a.Results, c.Results)
			}
			if !reflect.DeepEqual(a.State, c.State) {
				g, _ := json.Marshal(a.State)
				w, _ := json.Marshal(c.State)
				t.Errorf("state\n got %s\nwant %s", g, w)
			}
			last := map[string]cardAfter{}
			for _, card := range a.Cards {
				last[card.ScopeString+" "+card.ScopedID] = card
			}
			for _, s := range c.State {
				for _, card := range s.Cards {
					got := last[s.ScopeString+" "+card.ScopedID]
					if got.LastCardProof == nil || *got.LastCardProof != card.LastCardProof || got.ProofsOnLastDate != card.ProofsOnLastDate || !reflect.DeepEqual(got.Slots, card.Slots) {
						t.Errorf("card %s after its last record: %+v, want %+v", card.ScopedID, got, card)
					}
				}
			}
		})
	}
}

// TestSequenceAnswers writes the answers for worker/'s comparison: with
// IAMREAL_ROSTER_SEQUENCE set to a directory, it reads events.json there (a
// case of the vectors without results and state) and writes answers.json
// (sequenceAnswers). Without it, it is skipped: worker/test/sequence.test.ts
// runs it.
func TestSequenceAnswers(t *testing.T) {
	dir := os.Getenv("IAMREAL_ROSTER_SEQUENCE")
	if dir == "" {
		t.Skip("IAMREAL_ROSTER_SEQUENCE is not set: worker/test/sequence.test.ts sets it")
	}
	b, err := os.ReadFile(filepath.Join(dir, "events.json"))
	if err != nil {
		t.Fatal(err)
	}
	var c rulesCase
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatalf("events.json: %v", err)
	}
	out, err := json.Marshal(answersOf(t, c))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "answers.json"), append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
