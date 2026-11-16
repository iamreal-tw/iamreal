package roster_test

// The rules applied one record at a time (Rules) give the same results as
// the whole roster at once (Apply), on every case of
// spec/vectors/roster-rules.json. The server uses Rules; re-verifiers use
// Apply through Check.

import (
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

func TestVectorsOneAtATime(t *testing.T) {
	var v struct {
		Cases []struct {
			Name    string     `json:"name"`
			Events  []event    `json:"events"`
			Results []result   `json:"results"`
			State   []scopeOut `json:"state"`
		} `json:"cases"`
	}
	load(t, "roster-rules.json", &v)
	proof := base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength))
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			proofs := fakeProofs{}
			archive := fakeArchive{}
			var records []*verifier.Record
			for _, e := range c.Events {
				r := &verifier.Record{
					Seq: e.Seq, Prev: verifier.GenesisPrev, ScopeString: e.ScopeString, ScopedID: e.ScopedID,
					Action: e.Action, Username: e.Username, Challenge: e.Challenge, Issuer: "G3",
					SMTRoot: rootOf(e.Seq), Circuit: strings.Repeat("0", 64), Proof: proof,
				}
				proofs[e.Seq] = e.Verifies
				for _, s := range e.CRLDates {
					archive[r.SMTRoot] = append(archive[r.SMTRoot], date(t, s))
				}
				records = append(records, r)
			}
			whole, err := roster.Apply(records, proofs, archive)
			if err != nil {
				t.Fatal(err)
			}

			x := roster.NewRules(proofs, archive)
			var got []result
			for _, r := range records {
				// Check says what Apply then does, and changes nothing:
				// asking twice gives the same answer.
				checked, err := x.Check(r)
				if err != nil {
					t.Fatal(err)
				}
				again, err := x.Check(r)
				if err != nil || again != checked {
					t.Fatalf("seq %d: Check twice: %+v, then %+v (%v)", r.Seq, checked, again, err)
				}
				applied, err := x.Apply(r)
				if err != nil {
					t.Fatal(err)
				}
				if applied != checked {
					t.Errorf("seq %d: Check %+v, Apply %+v", r.Seq, checked, applied)
				}
				got = append(got, result{Seq: applied.Seq, Valid: applied.Valid, Kind: applied.Kind, Reason: applied.Reason})
			}
			if !reflect.DeepEqual(got, c.Results) {
				t.Errorf("results\n got %+v\nwant %+v", got, c.Results)
			}
			if got := stateOut(x.State(), x); !reflect.DeepEqual(got, c.State) {
				g, _ := json.Marshal(got)
				w, _ := json.Marshal(c.State)
				t.Errorf("state\n got %s\nwant %s", g, w)
			}
			if !reflect.DeepEqual(x.State(), whole) {
				t.Errorf("one at a time and all at once differ")
			}
			if x.Count() != len(records) {
				t.Errorf("Count %d", x.Count())
			}
			// Card agrees with the output for every listed card.
			for _, s := range whole.Scopes {
				for _, card := range s.Cards {
					cs := x.Card(s.ScopeString, card.ScopedID)
					if !reflect.DeepEqual(cs.Current, card.Current) || cs.LastCardProof == nil || *cs.LastCardProof != card.LastCardProof {
						t.Errorf("Card(%s): %+v, output %+v", card.ScopedID, cs, card)
					}
				}
			}
		})
	}
}

// Card gives what the output does not: the account last declared, kept
// after a withdrawal, and the dates of the switches.
func TestCard(t *testing.T) {
	const scope = "iamreal:threads:0______________"
	const id = "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880"
	proof := base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength))
	events := []struct{ action, username, challenge string }{
		{"declare", "alice", "2026-03-01.G9PYF6T6FCEQ2GH6DG2XHGFV74"},
		{"declare", "bob", "2026-03-02.G9PYF6T6FCEQ2GH6DG2XHGFV74"},
		{"withdraw", "bob", "2026-03-03.G9PYF6T6FCEQ2GH6DG2XHGFV74"},
	}
	x := roster.NewRules(fakeProofs{1: true, 2: true, 3: true}, everyRootRecognized{})
	if c := x.Card(scope, id); c.Current != nil || c.LastDeclared != nil || c.LastCardProof != nil || len(c.SwitchDates) != 0 || c.ProofsOnLastDate != 0 {
		t.Errorf("no record: %+v", c)
	}
	for i, e := range events {
		r := &verifier.Record{
			Seq: uint64(i + 1), Prev: verifier.GenesisPrev, ScopeString: scope, ScopedID: id,
			Action: e.action, Username: e.username, Challenge: e.challenge, Issuer: "G3",
			SMTRoot: rootOf(1), Circuit: strings.Repeat("0", 64), Proof: proof,
		}
		if res, err := x.Apply(r); err != nil || !res.Valid {
			t.Fatalf("seq %d: %+v %v", i+1, res, err)
		}
	}
	c := x.Card(scope, id)
	if c.Current != nil || c.LastDeclared == nil || *c.LastDeclared != "bob" ||
		c.LastCardProof == nil || *c.LastCardProof != date(t, "2026-03-03") || c.ProofsOnLastDate != 1 ||
		!reflect.DeepEqual(c.SwitchDates, []verifier.Date{date(t, "2026-03-02")}) {
		t.Errorf("%+v", c)
	}
	// The caller cannot change the rules' state through what Card returns.
	c.SwitchDates[0] = 0
	if x.Card(scope, id).SwitchDates[0] != date(t, "2026-03-02") {
		t.Errorf("Card returned the rules' own slice")
	}
}

// everyRootRecognized recognizes every root, with CRLs dated on every day.
type everyRootRecognized struct{}

func (everyRootRecognized) CRLDates(string, string) ([]verifier.Date, error) {
	d, _ := verifier.ParseDate("2026-03-01")
	var out []verifier.Date
	for i := -5; i < 400; i++ {
		out = append(out, d.AddDays(i))
	}
	return out, nil
}
