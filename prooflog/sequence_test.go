package prooflog_test

// The answers for worker/'s comparison of a long sequence of records
// (worker/test/sequence.test.ts, #73): this package applies the rules to the
// sequence one record at a time and writes what each record gives.
// TypeScript's protocol/, with its state in memory and in the proof log's
// Durable Object, must give the same.
//
// The two implementations do not import each other and share only spec/
// (CLAUDE.md). The sequence and the answers are exchanged as two files,
// events.json and answers.json, in the shape of a case of
// spec/vectors/record-rules.json, which both already read, extended with
// fields that are not in spec/: `checkpoint_every` in events.json, and
// `rules_version`, `cards`, `latest_valid_dates` and `checkpoints` in
// answers.json (sequenceAnswers). The extension is an agreement between
// this file and worker/test/sequence.ts only.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

// sequenceInput is events.json: a case of the vectors without its answers,
// and how often answers.json lists the accounts (0: only after the last
// record).
type sequenceInput struct {
	rulesCase
	CheckpointEvery int `json:"checkpoint_every"`
}

// cardAfter is the state of a card (prooflog.Card) in the spelling of the
// vectors' `state`, with last_card_proof null for a card with no valid
// record.
type cardAfter struct {
	ScopeString   string             `json:"scope_string"`
	ScopedID      string             `json:"scoped_id"`
	LastCardProof *string            `json:"last_card_proof"`
	Slots         map[string]slotOut `json:"slots"`
}

// accountCount is an account and the number of cards whose current account
// on that platform it is (prooflog.Rules.AccountCards: what the server
// answers as `account_cards`).
type accountCount struct {
	ScopeString  string `json:"scope_string"`
	Platform     string `json:"platform"`
	Username     string `json:"username"`
	AccountCards int    `json:"account_cards"`
}

// checkpoint lists, after the record with seq After, every account that at
// least one card declares, in the order of the output.
type checkpoint struct {
	After    uint64         `json:"after"`
	Accounts []accountCount `json:"accounts"`
}

// sequenceAnswers is answers.json: the case with its answers (`results`,
// the final `state`); for each event `cards`, the state of its card after
// it, and `latest_valid_dates`, the latest date among the valid records up
// to it (null before the first); the accounts at each checkpoint; and the
// final `ordinals`.
//
// prooflog.Rules keeps the latest valid date but does not export it; this
// file takes it from the dates of the records Rules found valid, which is
// how spec/record-rules.md defines it (check 4).
type sequenceAnswers struct {
	RulesVersion     int          `json:"rules_version"`
	Name             string       `json:"name"`
	ProofLog         string       `json:"proof_log"`
	Events           []event      `json:"events"`
	Results          []result     `json:"results"`
	Cards            []cardAfter  `json:"cards"`
	LatestValidDates []*string    `json:"latest_valid_dates"`
	Checkpoints      []checkpoint `json:"checkpoints"`
	State            []scopeOut   `json:"state"`
	Ordinals         []ordinalOut `json:"ordinals"`
}

// answersOf applies the rules to the events of c one record at a time,
// listing the accounts after every checkpointEvery records and after the
// last.
func answersOf(t *testing.T, c rulesCase, checkpointEvery int) sequenceAnswers {
	t.Helper()
	records, proofs, archive := caseRecords(t, c)
	rules := prooflog.NewRules(proofLogOf(t, c.ProofLog), proofs, archive)
	out := sequenceAnswers{
		RulesVersion: prooflog.RulesVersion, Name: c.Name, ProofLog: c.ProofLog, Events: c.Events,
		Results: []result{}, Cards: []cardAfter{}, LatestValidDates: []*string{}, Checkpoints: []checkpoint{},
	}
	var latest *verifier.Date
	for i, rec := range records {
		res, err := rules.Apply(rec)
		if err != nil {
			t.Fatalf("seq %d: %v", rec.Seq, err)
		}
		out.Results = append(out.Results, resultOf(res))

		cs := rules.Card(rec.ScopeString, rec.ScopedID)
		card := cardAfter{ScopeString: rec.ScopeString, ScopedID: rec.ScopedID, Slots: slotsOut(cs)}
		if cs.LastCardProof != nil {
			d := cs.LastCardProof.String()
			card.LastCardProof = &d
		}
		out.Cards = append(out.Cards, card)

		if d, _ := rec.Date(); res.Valid && (latest == nil || d > *latest) {
			latest = &d
		}
		var latestText *string
		if latest != nil {
			d := latest.String()
			latestText = &d
		}
		out.LatestValidDates = append(out.LatestValidDates, latestText)

		if n := i + 1; n == len(records) || (checkpointEvery > 0 && n%checkpointEvery == 0) {
			cp := checkpoint{After: rec.Seq, Accounts: []accountCount{}}
			for _, s := range rules.State().Scopes {
				for _, a := range s.Accounts {
					cp.Accounts = append(cp.Accounts, accountCount{s.ScopeString, a.Platform, a.Username, rules.AccountCards(s.ScopeString, a.Platform, a.Username)})
				}
			}
			out.Checkpoints = append(out.Checkpoints, cp)
		}
	}
	out.State = stateOut(rules.State(), rules)
	out.Ordinals = ordinalsOut(rules.State())
	return out
}

// The answers for every case of the vectors are the vectors' own: each
// record's result, the final state, each card's state after its last
// record, and the number of cards under each account after the last.
func TestSequenceAnswersOfVectors(t *testing.T) {
	var v struct {
		Cases []rulesCase `json:"cases"`
	}
	load(t, "record-rules.json", &v)
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			a := answersOf(t, c, 0)
			if !reflect.DeepEqual(a.Results, c.Results) {
				t.Errorf("results\n got %+v\nwant %+v", a.Results, c.Results)
			}
			if !reflect.DeepEqual(a.State, c.State) {
				g, _ := json.Marshal(a.State)
				w, _ := json.Marshal(c.State)
				t.Errorf("state\n got %s\nwant %s", g, w)
			}
			if !reflect.DeepEqual(a.Ordinals, c.Ordinals) {
				t.Errorf("ordinals\n got %+v\nwant %+v", a.Ordinals, c.Ordinals)
			}
			last := map[string]cardAfter{}
			for _, card := range a.Cards {
				last[card.ScopeString+" "+card.ScopedID] = card
			}
			want := []accountCount{}
			for _, s := range c.State {
				for _, card := range s.Cards {
					got := last[s.ScopeString+" "+card.ScopedID]
					if got.LastCardProof == nil || *got.LastCardProof != card.LastCardProof || !reflect.DeepEqual(got.Slots, card.Slots) {
						t.Errorf("card %s after its last record: %+v, want %+v", card.ScopedID, got, card)
					}
				}
				for _, acct := range s.Accounts {
					want = append(want, accountCount{s.ScopeString, acct.Platform, acct.Username, len(acct.Cards)})
				}
			}
			if len(a.Checkpoints) != 1 || a.Checkpoints[0].After != uint64(len(c.Events)) || !reflect.DeepEqual(a.Checkpoints[0].Accounts, want) {
				t.Errorf("checkpoints %+v, want one after %d with %+v", a.Checkpoints, len(c.Events), want)
			}
			if len(a.LatestValidDates) != len(c.Events) {
				t.Errorf("%d latest valid dates for %d events", len(a.LatestValidDates), len(c.Events))
			}
		})
	}
}

// TestSequenceAnswers writes the answers for worker/'s comparison: with
// IAMREAL_PROOF_LOG_SEQUENCE set to a directory, it reads events.json there
// (sequenceInput) and writes answers.json (sequenceAnswers). Without it, it
// is skipped: worker/test/sequence.test.ts runs it.
func TestSequenceAnswers(t *testing.T) {
	dir := os.Getenv("IAMREAL_PROOF_LOG_SEQUENCE")
	if dir == "" {
		t.Skip("IAMREAL_PROOF_LOG_SEQUENCE is not set: worker/test/sequence.test.ts sets it")
	}
	b, err := os.ReadFile(filepath.Join(dir, "events.json"))
	if err != nil {
		t.Fatal(err)
	}
	var in sequenceInput
	if err := json.Unmarshal(b, &in); err != nil {
		t.Fatalf("events.json: %v", err)
	}
	out, err := json.Marshal(answersOf(t, in.rulesCase, in.CheckpointEvery))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "answers.json"), append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
