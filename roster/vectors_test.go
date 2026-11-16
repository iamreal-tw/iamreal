package roster_test

// Tests against spec/vectors/record.json ("files") and
// spec/vectors/roster-rules.json. Every case runs as a subtest.

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

func TestVectorsRecordFiles(t *testing.T) {
	var v struct {
		Tokens map[string]string `json:"tokens"`
		Files  []struct {
			Name    string `json:"name"`
			Content string `json:"content"`
			Valid   bool   `json:"valid"`
			Head    string `json:"head"`
			Line    int    `json:"line"`
			Code    string `json:"code"`
		} `json:"files"`
	}
	load(t, "record.json", &v)
	for _, f := range v.Files {
		t.Run(f.Name, func(t *testing.T) {
			content := f.Content
			for k, val := range v.Tokens {
				content = strings.ReplaceAll(content, k, val)
			}
			records, head, broken := roster.ReadFile([]byte(content), verifier.Production)
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
			if head != f.Head {
				t.Errorf("head %s, want %s", head, f.Head)
			}
			if strings.Count(content, "\n") != len(records) {
				t.Errorf("%d records", len(records))
			}
		})
	}
}

type event struct {
	Seq         uint64   `json:"seq"`
	ScopeString string   `json:"scope_string"`
	ScopedID    string   `json:"scoped_id"`
	Action      string   `json:"action"`
	Username    string   `json:"username"`
	Challenge   string   `json:"challenge"`
	Date        string   `json:"date"`
	Verifies    bool     `json:"verifies"`
	CRLDates    []string `json:"crl_dates"`
}

type result struct {
	Seq    uint64 `json:"seq"`
	Valid  bool   `json:"valid"`
	Kind   string `json:"kind,omitempty"`
	Reason string `json:"reason,omitempty"`
}

type cardOut struct {
	ScopedID      string  `json:"scoped_id"`
	Current       *string `json:"current"`
	LastCardProof string  `json:"last_card_proof"`
}

type accountCardOut struct {
	ScopedID      string `json:"scoped_id"`
	LastCardProof string `json:"last_card_proof"`
}

type accountOut struct {
	Username string           `json:"username"`
	Cards    []accountCardOut `json:"cards"`
}

type scopeOut struct {
	ScopeString string       `json:"scope_string"`
	Cards       []cardOut    `json:"cards"`
	Accounts    []accountOut `json:"accounts"`
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

func TestVectorsRosterRules(t *testing.T) {
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
				// The events stand for well-formed records; the scopes are
				// those of either roster.
				if r.CheckValues(verifier.Production) != nil && r.CheckValues(verifier.Test) != nil {
					t.Fatalf("seq %d is not a well-formed record: %v", e.Seq, r.CheckValues(verifier.Production))
				}
				if d, _ := r.Date(); d.String() != e.Date {
					t.Fatalf("seq %d: date %s, the vector says %s", e.Seq, d, e.Date)
				}
				proofs[e.Seq] = e.Verifies
				for _, c := range e.CRLDates {
					d, err := verifier.ParseDate(c)
					if err != nil {
						t.Fatal(err)
					}
					archive[r.SMTRoot] = append(archive[r.SMTRoot], d)
				}
				records = append(records, r)
			}
			st, err := roster.Apply(records, proofs, archive)
			if err != nil {
				t.Fatal(err)
			}
			var got []result
			for _, res := range st.Records {
				got = append(got, result{Seq: res.Seq, Valid: res.Valid, Kind: res.Kind, Reason: res.Reason})
			}
			if !reflect.DeepEqual(got, c.Results) {
				t.Errorf("results\n got %+v\nwant %+v", got, c.Results)
			}
			if gotState := stateOut(st); !reflect.DeepEqual(gotState, c.State) {
				g, _ := json.Marshal(gotState)
				w, _ := json.Marshal(c.State)
				t.Errorf("state\n got %s\nwant %s", g, w)
			}
		})
	}
}

func stateOut(st *roster.State) []scopeOut {
	out := []scopeOut{}
	for _, s := range st.Scopes {
		so := scopeOut{ScopeString: s.ScopeString, Cards: []cardOut{}, Accounts: []accountOut{}}
		for _, c := range s.Cards {
			so.Cards = append(so.Cards, cardOut{c.ScopedID, c.Current, c.LastCardProof.String()})
		}
		for _, a := range s.Accounts {
			ao := accountOut{Username: a.Username, Cards: []accountCardOut{}}
			for _, c := range a.Cards {
				ao.Cards = append(ao.Cards, accountCardOut{c.ScopedID, c.LastCardProof.String()})
			}
			so.Accounts = append(so.Accounts, ao)
		}
		out = append(out, so)
	}
	return out
}
