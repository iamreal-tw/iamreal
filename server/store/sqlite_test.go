package store

import (
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/verifier"
)

func open(t *testing.T) (*SQLite, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "iamreal.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path
}

var t0 = time.Date(2026, 11, 16, 2, 0, 0, 0, time.UTC)

func challenge(i int) string {
	return fmt.Sprintf("2026-11-16.%025dG", i)
}

// record returns record seq after prev, with placeholder values.
func record(seq uint64, prev string) *verifier.Record {
	return &verifier.Record{
		Seq: seq, Prev: prev, ScopeString: "iamreal-test:public:0__________",
		ScopedID:  "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880",
		Accounts:  []verifier.Account{{Platform: "test-example", Username: "a-b"}, {Platform: "threads", Username: "alice"}},
		Challenge: challenge(int(seq)), Issuer: "G3", SMTRoot: strings.Repeat("0", 64),
		Circuit: strings.Repeat("1", 64), Proof: base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength)),
	}
}

func TestAppendKeepsTheChain(t *testing.T) {
	s, path := open(t)
	count, head, err := s.Head()
	if err != nil || count != 0 || head != verifier.GenesisPrev {
		t.Fatalf("empty: %d %s %v", count, head, err)
	}
	prev := verifier.GenesisPrev
	var want []*verifier.Record
	for seq := uint64(1); seq <= 3; seq++ {
		r := record(seq, prev)
		if err := s.AddChallenge(r.Challenge, t0); err != nil {
			t.Fatal(err)
		}
		if err := s.Append(r, nil); err != nil {
			t.Fatalf("seq %d: %v", seq, err)
		}
		want = append(want, r)
		prev = r.Hash()
	}
	count, head, err = s.Head()
	if err != nil || count != 3 || head != prev {
		t.Errorf("head: %d %s %v", count, head, err)
	}

	// A seq that skips, a seq already taken, a wrong prev.
	for _, r := range []*verifier.Record{record(5, prev), record(3, want[1].Hash()), record(4, strings.Repeat("a", 64))} {
		s.AddChallenge(r.Challenge, t0)
		if err := s.Append(r, nil); !errors.Is(err, ErrNotNext) {
			t.Errorf("seq %d prev %s: %v, want ErrNotNext", r.Seq, r.Prev[:8], err)
		}
	}

	got, err := s.Records(2, 10)
	if err != nil || len(got) != 2 || !got[0].Equal(want[1]) || !got[1].Equal(want[2]) {
		t.Errorf("Records(2, 10): %d records, %v", len(got), err)
	}

	// Everything is still there after reopening, also read-only.
	s.Close()
	for _, openFn := range []func(string) (*SQLite, error){Open, OpenReadOnly} {
		s2, err := openFn(path)
		if err != nil {
			t.Fatal(err)
		}
		if count, head, err := s2.Head(); err != nil || count != 3 || head != prev {
			t.Errorf("reopened: %d %s %v", count, head, err)
		}
		s2.Close()
	}
}

func TestReadOnlyCannotWrite(t *testing.T) {
	_, path := open(t)
	s, err := OpenReadOnly(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.AddChallenge(challenge(1), t0); err == nil {
		t.Error("read-only store accepted a write")
	}
}

// The record and the accepted challenge are written together or not at all.
func TestAppendNeedsAnOpenChallenge(t *testing.T) {
	s, _ := open(t)
	r := record(1, verifier.GenesisPrev)
	if err := s.Append(r, nil); !errors.Is(err, ErrChallengeNotOpen) {
		t.Errorf("never issued: %v", err)
	}
	if count, _, _ := s.Head(); count != 0 {
		t.Errorf("a record was written without its challenge")
	}
	s.AddChallenge(r.Challenge, t0)
	if err := s.Append(r, nil); err != nil {
		t.Fatal(err)
	}
	c, found, err := s.Submit(r.Challenge)
	if err != nil || !found || !c.Accepted {
		t.Errorf("after Append: %+v %v %v", c, found, err)
	}
	// The same challenge for the next record.
	r2 := record(2, r.Hash())
	r2.Challenge = r.Challenge
	if err := s.Append(r2, nil); !errors.Is(err, ErrChallengeNotOpen) {
		t.Errorf("accepted challenge: %v", err)
	}
}

func TestSubmitCounts(t *testing.T) {
	s, _ := open(t)
	if _, found, err := s.Submit(challenge(1)); found || err != nil {
		t.Errorf("unknown: %v %v", found, err)
	}
	s.AddChallenge(challenge(1), t0)
	for i := 1; i <= 7; i++ {
		c, found, err := s.Submit(challenge(1))
		if err != nil || !found || c.Submissions != i || c.Accepted || !c.Issued.Equal(t0) {
			t.Fatalf("submission %d: %+v %v %v", i, c, found, err)
		}
	}
}

func TestDeleteChallenges(t *testing.T) {
	s, _ := open(t)
	s.AddChallenge(challenge(1), t0)
	s.AddChallenge(challenge(2), t0.Add(time.Nanosecond))
	n, err := s.DeleteChallengesIssuedBefore(t0.Add(time.Nanosecond))
	if err != nil || n != 1 {
		t.Fatalf("deleted %d, %v", n, err)
	}
	if _, found, _ := s.Submit(challenge(1)); found {
		t.Error("challenge 1 is still there")
	}
	if _, found, _ := s.Submit(challenge(2)); !found {
		t.Error("challenge 2 was deleted")
	}
}
