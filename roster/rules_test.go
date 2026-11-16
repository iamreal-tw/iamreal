package roster_test

import (
	"errors"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

func date(t *testing.T, s string) verifier.Date {
	t.Helper()
	d, err := verifier.ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func oneRecord(challenge string) []*verifier.Record {
	return []*verifier.Record{{
		Seq: 1, ScopeString: "iamreal:threads:0______________",
		ScopedID: "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880",
		Action:   "declare", Username: "alice", Challenge: challenge, Issuer: "G3", SMTRoot: rootOf(1),
	}}
}

// Several usable CRLs can have the same root (no new revocations between
// them). The root is recognized if the date fits any one of them.
func TestRootOfSeveralCRLs(t *testing.T) {
	recs := oneRecord("2026-03-10.G9PYF6T6FCEQ2GH6DG2XHGFV74")
	for _, c := range []struct {
		dates []string
		valid bool
	}{
		{[]string{"2026-03-01", "2026-03-09"}, true},
		{[]string{"2026-03-09", "2026-03-01"}, true},
		{[]string{"2026-03-01", "2026-03-11"}, true},  // d = CRL date − 1
		{[]string{"2026-03-01", "2026-03-12"}, false}, // d = CRL date − 2
		{[]string{"2026-03-06", "2026-03-20"}, false}, // d = CRL date + 4
		{[]string{"2026-03-07"}, true},                // d = CRL date + 3
		{nil, false},
	} {
		var ds []verifier.Date
		for _, s := range c.dates {
			ds = append(ds, date(t, s))
		}
		st, err := roster.Apply(recs, fakeProofs{1: true}, fakeArchive{rootOf(1): ds})
		if err != nil {
			t.Fatal(err)
		}
		if st.Records[0].Valid != c.valid {
			t.Errorf("CRL dates %v: %+v, want valid %v", c.dates, st.Records[0], c.valid)
		}
	}
}

type brokenVerifier struct{}

func (brokenVerifier) VerifyRecord(*verifier.Record) error { return errors.New("bb could not start") }

type brokenArchive struct{}

func (brokenArchive) CRLDates(string, string) ([]verifier.Date, error) {
	return nil, errors.New("archive unreadable")
}

// When check 1 or check 3 cannot be made, the rules stop instead of giving
// a code: an error of the verifier says nothing about the record.
func TestCannotCheckStops(t *testing.T) {
	recs := oneRecord("2026-03-10.G9PYF6T6FCEQ2GH6DG2XHGFV74")
	if _, err := roster.Apply(recs, brokenVerifier{}, fakeArchive{}); err == nil {
		t.Errorf("verifier error: no error")
	}
	if _, err := roster.Apply(recs, fakeProofs{1: true}, brokenArchive{}); err == nil {
		t.Errorf("archive error: no error")
	}
	// A record that does not verify never reaches check 3.
	st, err := roster.Apply(recs, fakeProofs{}, brokenArchive{})
	if err != nil || st.Records[0].Reason != roster.CodeProof {
		t.Errorf("%v %+v", err, st)
	}
}
