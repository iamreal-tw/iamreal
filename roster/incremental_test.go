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
		Cases []rulesCase `json:"cases"`
	}
	load(t, "roster-rules.json", &v)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			r := rosterOf(t, c.Roster)
			records, proofs, archive := caseRecords(t, c)
			whole, err := roster.Apply(records, r, proofs, archive)
			if err != nil {
				t.Fatal(err)
			}

			x := roster.NewRules(r, proofs, archive)
			var got []result
			for _, rec := range records {
				// Check says what Apply then does, and changes nothing:
				// asking twice gives the same answer.
				checked, err := x.Check(rec)
				if err != nil {
					t.Fatal(err)
				}
				again, err := x.Check(rec)
				if err != nil || !again.Equal(checked) {
					t.Fatalf("seq %d: Check twice: %+v, then %+v (%v)", rec.Seq, checked, again, err)
				}
				applied, err := x.Apply(rec)
				if err != nil {
					t.Fatal(err)
				}
				if !applied.Equal(checked) {
					t.Errorf("seq %d: Check %+v, Apply %+v", rec.Seq, checked, applied)
				}
				got = append(got, resultOf(applied))
			}
			if !reflect.DeepEqual(got, c.Results) {
				t.Errorf("results\n got %+v\nwant %+v", got, c.Results)
			}
			// The output, with each card's proofs_on_last_date and slots.
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
			// AccountCards agrees with the output's accounts; an account no
			// card declares now has none, and the same username on another
			// platform is another account.
			for _, s := range whole.Scopes {
				listed := map[[2]string]bool{}
				for _, a := range s.Accounts {
					listed[[2]string{a.Platform, a.Username}] = true
					if n := x.AccountCards(s.ScopeString, a.Platform, a.Username); n != len(a.Cards) {
						t.Errorf("AccountCards(%s, %s, %s) = %d, output %d", s.ScopeString, a.Platform, a.Username, n, len(a.Cards))
					}
				}
				for _, p := range verifier.Platforms(r) {
					for _, a := range s.Accounts {
						if !listed[[2]string{p.ID, a.Username}] {
							if n := x.AccountCards(s.ScopeString, p.ID, a.Username); n != 0 {
								t.Errorf("AccountCards(%s, %s) of an account no card declares: %d", p.ID, a.Username, n)
							}
						}
					}
				}
			}
			// Card agrees with the output for every listed card: its current
			// list is the current account of its slots.
			for _, s := range whole.Scopes {
				for _, card := range s.Cards {
					cs := x.Card(s.ScopeString, card.ScopedID)
					var list []verifier.Account
					for _, p := range verifier.Platforms(r) {
						if cur := cs.Slots[p.ID].Current; cur != nil {
							list = append(list, verifier.Account{Platform: p.ID, Username: *cur})
						}
					}
					if len(cs.Slots) != len(verifier.Platforms(r)) || cs.LastCardProof == nil ||
						*cs.LastCardProof != card.LastCardProof || verifier.AccountsText(list) != verifier.AccountsText(card.Accounts) {
						t.Errorf("Card(%s): %+v, output %+v", card.ScopedID, cs, card)
					}
				}
			}
		})
	}
}

// Card of a card with no record: every slot of the table, never used. The
// caller cannot change the rules' state through what Card returns.
func TestCard(t *testing.T) {
	const scope = "iamreal-test:public:0__________"
	const id = "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880"
	proof := base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength))
	x := roster.NewRules(verifier.Test, fakeProofs{1: true, 2: true, 3: true}, everyRootRecognized{})
	c := x.Card(scope, id)
	if c.LastCardProof != nil || c.ProofsOnLastDate != 0 || len(c.Slots) != 2 {
		t.Errorf("no record: %+v", c)
	}
	for p, s := range c.Slots {
		if s.Current != nil || s.LastDeclared != nil || len(s.SwitchDates) != 0 {
			t.Errorf("no record, %s: %+v", p, s)
		}
	}
	for i, e := range []struct {
		accounts  []verifier.Account
		challenge string
	}{
		{[]verifier.Account{{Platform: "test-example", Username: "a-b"}, {Platform: "threads", Username: "alice"}}, "2026-03-01.G9PYF6T6FCEQ2GH6DG2XHGFV74"},
		{[]verifier.Account{{Platform: "threads", Username: "bob"}}, "2026-03-02.G9PYF6T6FCEQ2GH6DG2XHGFV74"},
		{nil, "2026-03-03.G9PYF6T6FCEQ2GH6DG2XHGFV74"},
	} {
		r := &verifier.Record{
			Seq: uint64(i + 1), Prev: verifier.GenesisPrev, ScopeString: scope, ScopedID: id,
			Accounts: e.accounts, Challenge: e.challenge, Issuer: "G3",
			SMTRoot: rootOf(1), Circuit: strings.Repeat("0", 64), Proof: proof,
		}
		if res, err := x.Apply(r); err != nil || !res.Valid {
			t.Fatalf("seq %d: %+v %v", i+1, res, err)
		}
	}
	c = x.Card(scope, id)
	th, te := c.Slots["threads"], c.Slots["test-example"]
	if th.Current != nil || th.LastDeclared == nil || *th.LastDeclared != "bob" ||
		!reflect.DeepEqual(th.SwitchDates, []verifier.Date{date(t, "2026-03-02")}) ||
		te.Current != nil || te.LastDeclared == nil || *te.LastDeclared != "a-b" || len(te.SwitchDates) != 0 ||
		c.LastCardProof == nil || *c.LastCardProof != date(t, "2026-03-03") || c.ProofsOnLastDate != 1 {
		t.Errorf("%+v %+v %+v", c, th, te)
	}
	// The withdrawals of the last record name the accounts withdrawn.
	if res := x.State().Records[2]; !reflect.DeepEqual(res.Kinds, []roster.PlatformKind{
		{Platform: "threads", Kind: roster.KindWithdraw, Username: "bob"},
	}) {
		t.Errorf("kinds %+v", res.Kinds)
	}
	// The second record: test-example withdrawn, threads switched.
	if res := x.State().Records[1]; !reflect.DeepEqual(res.Kinds, []roster.PlatformKind{
		{Platform: "test-example", Kind: roster.KindWithdraw, Username: "a-b"},
		{Platform: "threads", Kind: roster.KindSwitch, Username: "bob"},
	}) {
		t.Errorf("kinds %+v", res.Kinds)
	}
	th.SwitchDates[0] = 0
	if x.Card(scope, id).Slots["threads"].SwitchDates[0] != date(t, "2026-03-02") {
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
