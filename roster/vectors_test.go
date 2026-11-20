package roster_test

// Tests against spec/vectors/record.json (the roster fingerprints, "files"
// and the published roster) and spec/vectors/roster-rules.json. Every case
// runs as a subtest.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

const vectorsDir = "../spec/vectors"

func load(t *testing.T, name string, v any) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(vectorsDir, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

var rosters = map[string]verifier.Roster{"production": verifier.Production, "test": verifier.Test}

func rosterOf(t *testing.T, name string) verifier.Roster {
	t.Helper()
	r, ok := rosters[name]
	if !ok {
		t.Fatalf("roster %q", name)
	}
	return r
}

func TestVectorsRecordFiles(t *testing.T) {
	var v struct {
		Tokens map[string]string `json:"tokens"`
		Files  []struct {
			Name        string `json:"name"`
			Roster      string `json:"roster"`
			Content     string `json:"content"`
			Valid       bool   `json:"valid"`
			Fingerprint string `json:"fingerprint"`
			Line        int    `json:"line"`
			Code        string `json:"code"`
		} `json:"files"`
	}
	load(t, "record.json", &v)
	for _, f := range v.Files {
		t.Run(f.Name, func(t *testing.T) {
			content := f.Content
			for k, val := range v.Tokens {
				content = strings.ReplaceAll(content, k, val)
			}
			records, fingerprint, broken := roster.ReadFile([]byte(content), rosterOf(t, f.Roster))
			if !f.Valid {
				if broken == nil {
					t.Fatalf("valid, want broken at line %d with %s", f.Line, f.Code)
				}
				if broken.Line != f.Line || broken.Code != f.Code {
					t.Errorf("broken at line %d with %s (%v), want line %d with %s", broken.Line, broken.Code, broken.Err, f.Line, f.Code)
				}
				return
			}
			if broken != nil {
				t.Fatalf("broken: %v", broken)
			}
			if fingerprint != f.Fingerprint {
				t.Errorf("fingerprint %s, want %s", fingerprint, f.Fingerprint)
			}
			if strings.Count(content, "\n") != len(records) {
				t.Errorf("%d records", len(records))
			}
		})
	}
}

type account struct {
	Platform string `json:"platform"`
	Username string `json:"username"`
}

type event struct {
	Seq         uint64    `json:"seq"`
	ScopeString string    `json:"scope_string"`
	ScopedID    string    `json:"scoped_id"`
	Accounts    []account `json:"accounts"`
	Challenge   string    `json:"challenge"`
	Date        string    `json:"date"`
	Verifies    bool      `json:"verifies"`
	CRLDates    []string  `json:"crl_dates"`
}

type kind struct {
	Platform string `json:"platform"`
	Kind     string `json:"kind"`
}

type result struct {
	Seq    uint64 `json:"seq"`
	Valid  bool   `json:"valid"`
	Kinds  []kind `json:"kinds,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type slotOut struct {
	Current        *string `json:"current"`
	LastDeclared   *string `json:"last_declared"`
	SwitchCount    int     `json:"switch_count"`
	CorrectionDate *string `json:"correction_date"`
}

// cardOut is a card of the output, with proofs_on_last_date and slots from
// the card's state (the output does not list them; see the vectors' note).
type cardOut struct {
	ScopedID         string             `json:"scoped_id"`
	LastCardProof    string             `json:"last_card_proof"`
	Accounts         []account          `json:"accounts"`
	ProofsOnLastDate int                `json:"proofs_on_last_date"`
	Slots            map[string]slotOut `json:"slots"`
}

type accountCardOut struct {
	ScopedID      string `json:"scoped_id"`
	LastCardProof string `json:"last_card_proof"`
}

type accountOut struct {
	Platform string           `json:"platform"`
	Username string           `json:"username"`
	Cards    []accountCardOut `json:"cards"`
}

type scopeOut struct {
	ScopeString string       `json:"scope_string"`
	Cards       []cardOut    `json:"cards"`
	Accounts    []accountOut `json:"accounts"`
}

type rulesCase struct {
	Name    string     `json:"name"`
	Roster  string     `json:"roster"`
	Events  []event    `json:"events"`
	Results []result   `json:"results"`
	State   []scopeOut `json:"state"`
}

// fakeProofs is check 1 from the events' `verifies`.
type fakeProofs map[uint64]bool

func (f fakeProofs) VerifyRecord(r *verifier.Record) error {
	if f[r.Seq] {
		return nil
	}
	return &verifier.Rejection{Reason: "the vector says it does not verify"}
}

// fakeArchive is check 3 from the events' `crl_dates`: each event's root is
// its own, and the root belongs to CRLs with those dates (possibly none).
type fakeArchive map[string][]verifier.Date

func (a fakeArchive) CRLDates(issuer, root string) ([]verifier.Date, error) {
	if issuer != "G3" {
		return nil, fmt.Errorf("issuer %s", issuer)
	}
	return a[root], nil
}

// rootOf gives each event a root of its own below p.
func rootOf(seq uint64) string {
	sum := sha256.Sum256([]byte(fmt.Sprint("root ", seq)))
	return "0" + hex.EncodeToString(sum[:])[1:]
}

func accountsOf(list []account) []verifier.Account {
	out := []verifier.Account{}
	for _, a := range list {
		out = append(out, verifier.Account{Platform: a.Platform, Username: a.Username})
	}
	return out
}

// casesRecords turns a case's events into records, with the proof verifier
// and CRL archive that answer checks 1 and 3 as the events say. Each record
// is checked to be well formed in the case's roster.
func caseRecords(t *testing.T, c rulesCase) ([]*verifier.Record, fakeProofs, fakeArchive) {
	t.Helper()
	r := rosterOf(t, c.Roster)
	proof := base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength))
	proofs := fakeProofs{}
	archive := fakeArchive{}
	var records []*verifier.Record
	for _, e := range c.Events {
		rec := &verifier.Record{
			Seq: e.Seq, ScopeString: e.ScopeString, ScopedID: e.ScopedID,
			Accounts: accountsOf(e.Accounts), Challenge: e.Challenge, Issuer: "G3",
			SMTRoot: rootOf(e.Seq), Circuit: strings.Repeat("0", 64), Proof: proof,
		}
		if err := rec.CheckValues(r); err != nil {
			t.Fatalf("seq %d is not a well-formed record of the %s roster: %v", e.Seq, r, err)
		}
		if d, _ := rec.Date(); d.String() != e.Date {
			t.Fatalf("seq %d: date %s, the vector says %s", e.Seq, d, e.Date)
		}
		proofs[e.Seq] = e.Verifies
		for _, s := range e.CRLDates {
			archive[rec.SMTRoot] = append(archive[rec.SMTRoot], date(t, s))
		}
		records = append(records, rec)
	}
	return records, proofs, archive
}

func resultOf(res roster.RecordResult) result {
	out := result{Seq: res.Seq, Valid: res.Valid, Reason: res.Reason}
	for _, k := range res.Kinds {
		out.Kinds = append(out.Kinds, kind{k.Platform, k.Kind})
	}
	return out
}

func TestVectorsRosterRules(t *testing.T) {
	var v struct {
		Cases []rulesCase `json:"cases"`
	}
	load(t, "roster-rules.json", &v)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			records, proofs, archive := caseRecords(t, c)
			st, err := roster.Apply(records, rosterOf(t, c.Roster), proofs, archive)
			if err != nil {
				t.Fatal(err)
			}
			var got []result
			for _, res := range st.Records {
				got = append(got, resultOf(res))
			}
			if !reflect.DeepEqual(got, c.Results) {
				g, _ := json.Marshal(got)
				w, _ := json.Marshal(c.Results)
				t.Errorf("results\n got %s\nwant %s", g, w)
			}
			// The output; proofs_on_last_date and the slots are compared one
			// record at a time (incremental_test.go), from Rules.Card.
			if gotState, want := stateOut(st, nil), withoutCardState(c.State); !reflect.DeepEqual(gotState, want) {
				g, _ := json.Marshal(gotState)
				w, _ := json.Marshal(want)
				t.Errorf("state\n got %s\nwant %s", g, w)
			}
		})
	}
}

// stateOut writes the output in the shape of the vectors. x, if not nil,
// gives each card's proofs_on_last_date and slots; otherwise they are left
// out (0 and nil).
func stateOut(st *roster.State, x *roster.Rules) []scopeOut {
	out := []scopeOut{}
	for _, s := range st.Scopes {
		so := scopeOut{ScopeString: s.ScopeString, Cards: []cardOut{}, Accounts: []accountOut{}}
		for _, c := range s.Cards {
			co := cardOut{ScopedID: c.ScopedID, LastCardProof: c.LastCardProof.String(), Accounts: []account{}}
			for _, a := range c.Accounts {
				co.Accounts = append(co.Accounts, account{a.Platform, a.Username})
			}
			if x != nil {
				cs := x.Card(s.ScopeString, c.ScopedID)
				co.ProofsOnLastDate = cs.ProofsOnLastDate
				co.Slots = slotsOut(cs)
			}
			so.Cards = append(so.Cards, co)
		}
		for _, a := range s.Accounts {
			ao := accountOut{Platform: a.Platform, Username: a.Username, Cards: []accountCardOut{}}
			for _, c := range a.Cards {
				ao.Cards = append(ao.Cards, accountCardOut{c.ScopedID, c.LastCardProof.String()})
			}
			so.Accounts = append(so.Accounts, ao)
		}
		out = append(out, so)
	}
	return out
}

// slotsOut writes a card's slots in the shape of the vectors' `slots`.
func slotsOut(cs roster.CardState) map[string]slotOut {
	out := map[string]slotOut{}
	for p, slot := range cs.Slots {
		so := slotOut{Current: slot.Current, LastDeclared: slot.LastDeclared, SwitchCount: slot.SwitchCount}
		if slot.CorrectionDate != nil {
			d := slot.CorrectionDate.String()
			so.CorrectionDate = &d
		}
		out[p] = so
	}
	return out
}

// withoutCardState is the vector's state without proofs_on_last_date and
// slots.
func withoutCardState(state []scopeOut) []scopeOut {
	out := []scopeOut{}
	for _, s := range state {
		s.Cards = append([]cardOut{}, s.Cards...)
		for i := range s.Cards {
			s.Cards[i].ProofsOnLastDate = 0
			s.Cards[i].Slots = nil
		}
		out = append(out, s)
	}
	return out
}
