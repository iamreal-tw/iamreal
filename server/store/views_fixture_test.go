package store

// The fixture of the view tests: a store and the roster rules, fed one
// record at a time the way the server feeds them (CheckWithCard, NewView,
// Append, Apply). Besides the views, the fixture keeps by itself what the
// views should say, from the rules' state only, so that the tests compare
// the views with something they did not compute.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

const testScope = "iamreal-test:public:0__________"

// allVerify is check 1: every record verifies. Only records the rules
// accept are written, as the server does.
type allVerify struct{}

func (allVerify) VerifyRecord(*verifier.Record) error { return nil }

// rootArchive is check 3: each root belongs to CRLs of the given dates.
type rootArchive map[string][]verifier.Date

func (a rootArchive) CRLDates(_, root string) ([]verifier.Date, error) { return a[root], nil }

type slotKey struct{ scope, scopedID, platform string }

type cardKey struct{ scope, scopedID string }

type sinceAt struct {
	date verifier.Date
	seq  uint64
}

type fixture struct {
	t       testing.TB
	s       *SQLite
	roster  verifier.Roster
	archive rootArchive
	rules   *roster.Rules
	n       uint64

	// Kept by the fixture from the rules' state, not from the views.
	since    map[slotKey]sinceAt       // the record from which the slot's current account is current
	first    map[cardKey]verifier.Date // the earliest date of the card's valid records
	proofs   map[cardKey]int
	history  map[cardKey][]HistoryRecord
	declared map[[3]string]bool // (scope, platform, username) ever declared
}

func newFixture(t testing.TB, r verifier.Roster) *fixture {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "iamreal.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	f := &fixture{t: t, s: s, roster: r, archive: rootArchive{}}
	f.reset()
	return f
}

// reset forgets the rules' state and what the fixture kept, not the store.
func (f *fixture) reset() {
	f.rules = roster.NewRules(f.roster, allVerify{}, f.archive)
	f.since, f.first, f.proofs = map[slotKey]sinceAt{}, map[cardKey]verifier.Date{}, map[cardKey]int{}
	f.history, f.declared = map[cardKey][]HistoryRecord{}, map[[3]string]bool{}
}

// cardID returns a scoped ID made from n. Cards made with the same short
// but different n differ only after the short ID: their first 10
// characters are those of short.
func cardID(short, n uint64) string {
	var fe verifier.Field
	hs := sha256.Sum256(binary.BigEndian.AppendUint64([]byte("short "), short))
	hn := sha256.Sum256(binary.BigEndian.AppendUint64([]byte("card "), n))
	copy(fe[24:], hs[:8])   // the low bytes: the first 12 characters of the text
	copy(fe[1:24], hn[:23]) // fe[0] stays 0, so below p
	return verifier.ScopedIDText(fe)
}

// accountsOf reads "platform:username" strings, in the order given.
func accountsOf(accounts ...string) []verifier.Account {
	out := []verifier.Account{}
	for _, a := range accounts {
		p, u, _ := strings.Cut(a, ":")
		out = append(out, verifier.Account{Platform: p, Username: u})
	}
	return out
}

// record returns the next record of the store: card in scope, dated date,
// with a challenge and a root of its own.
func (f *fixture) record(scope, card, date string, accounts []verifier.Account) *verifier.Record {
	f.t.Helper()
	f.n++
	sum := sha256.Sum256([]byte(fmt.Sprint("fixture ", f.n)))
	root := "0" + hex.EncodeToString(sum[:])[1:]
	d, err := verifier.ParseDate(date)
	if err != nil {
		f.t.Fatal(err)
	}
	f.archive[root] = []verifier.Date{d}
	return &verifier.Record{
		ScopeString: scope, ScopedID: card, Accounts: accounts,
		Challenge: date + "." + verifier.EncodeBase32(sum[:16]), Issuer: "G3", SMTRoot: root,
		Circuit: strings.Repeat("0", 64), Proof: base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength)),
	}
}

// add writes a record of card dated date with the accounts
// "platform:username", which the rules must accept, and returns its
// result.
func (f *fixture) add(card, date string, accounts ...string) roster.RecordResult {
	f.t.Helper()
	res := f.write(f.record(testScope, card, date, accountsOf(accounts...)))
	if !res.Valid {
		f.t.Fatalf("%s %s %v: invalid, %s %s", card[:10], date, accounts, res.Reason, res.Detail)
	}
	return res
}

// write gives r the next seq and prev and, if the rules accept it, writes
// it with its view as the server does. An invalid record is not written.
func (f *fixture) write(r *verifier.Record) roster.RecordResult {
	f.t.Helper()
	count, head, err := f.s.Head()
	if err != nil {
		f.t.Fatal(err)
	}
	r.Seq, r.Prev = count+1, head
	before := f.rules.Card(r.ScopeString, r.ScopedID)
	res, after, err := f.rules.CheckWithCard(r)
	if err != nil {
		f.t.Fatal(err)
	}
	if !res.Valid {
		return res
	}
	v, err := NewView(r, res, before, after)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := f.s.AddChallenge(r.Challenge, t0); err != nil {
		f.t.Fatal(err)
	}
	if err := f.s.Append(r, v); err != nil {
		f.t.Fatalf("seq %d: %v", r.Seq, err)
	}
	if applied, err := f.rules.Apply(r); err != nil || !applied.Equal(res) {
		f.t.Fatalf("seq %d: Apply %+v, Check %+v (%v)", r.Seq, applied, res, err)
	}
	f.keep(r, res, before, after)
	return res
}

// keep notes what the views should now say, from the rules' state.
func (f *fixture) keep(r *verifier.Record, res roster.RecordResult, before, after roster.CardState) {
	d, _ := r.Date()
	ck := cardKey{r.ScopeString, r.ScopedID}
	if first, ok := f.first[ck]; !ok || d < first {
		f.first[ck] = d
	}
	f.proofs[ck]++
	// A slot starts giving its place to an account when its current
	// account changes to it.
	for p := range after.Slots {
		b, a := before.Slots[p].Current, after.Slots[p].Current
		k := slotKey{r.ScopeString, r.ScopedID, p}
		switch {
		case a == nil:
			delete(f.since, k)
		case b == nil || *b != *a:
			f.since[k] = sinceAt{d, r.Seq}
			f.declared[[3]string{r.ScopeString, p, *a}] = true
		}
	}
	h := HistoryRecord{Seq: r.Seq, Date: d}
	for _, k := range res.Kinds {
		b, a := before.Slots[k.Platform], after.Slots[k.Platform]
		c := SlotChange{Platform: k.Platform, Kind: k.Kind, AfterWithdrawal: b.Current == nil && b.LastDeclared != nil}
		if b.LastDeclared != nil {
			c.Before = *b.LastDeclared
		}
		if a.Current != nil {
			c.After = *a.Current
		}
		h.Changes = append(h.Changes, c)
	}
	f.history[ck] = append(f.history[ck], h)
}

// check compares every query of the views with the rules' state and what
// the fixture kept, for each of todays.
func (f *fixture) check(todays ...verifier.Date) {
	f.t.Helper()
	st := f.rules.State()
	for _, sc := range st.Scopes {
		scope := sc.ScopeString
		for _, card := range sc.Cards {
			ck := cardKey{scope, card.ScopedID}
			got, err := f.s.Cards(scope, verifier.ShortID(card.ScopedID))
			if err != nil {
				f.t.Fatal(err)
			}
			var gc *CardSummary
			for i := range got {
				if got[i].ScopedID == card.ScopedID {
					gc = &got[i]
				}
			}
			if gc == nil {
				f.t.Errorf("Cards(%s): %s not listed", verifier.ShortID(card.ScopedID), card.ScopedID)
				continue
			}
			want := CardSummary{ScopedID: card.ScopedID, FirstCardProof: f.first[ck], LastCardProof: card.LastCardProof, CardProofs: f.proofs[ck]}
			cs := f.rules.Card(scope, card.ScopedID)
			var current []verifier.Account
			for _, p := range verifier.Platforms(f.roster) {
				slot := cs.Slots[p.ID]
				if slot.LastDeclared == nil {
					continue
				}
				ss := SlotSummary{Platform: p.ID, SwitchCount: slot.SwitchCount}
				if slot.Current != nil {
					ss.Current = *slot.Current
					since := f.since[slotKey{scope, card.ScopedID, p.ID}]
					ss.Since, ss.SinceSeq = since.date, since.seq
					current = append(current, verifier.Account{Platform: p.ID, Username: ss.Current})
				}
				want.Slots = append(want.Slots, ss)
			}
			if !same(*gc, want) {
				f.t.Errorf("card %s:\n got %s\nwant %s", card.ScopedID[:10], js(*gc), js(want))
			}
			if verifier.AccountsText(current) != verifier.AccountsText(card.Accounts) {
				f.t.Errorf("card %s: slots %v, the rules' list %v", card.ScopedID[:10], current, card.Accounts)
			}
			wantHist := append([]HistoryRecord(nil), f.history[ck]...)
			sort.SliceStable(wantHist, func(i, j int) bool {
				if wantHist[i].Date != wantHist[j].Date {
					return wantHist[i].Date > wantHist[j].Date
				}
				return wantHist[i].Seq > wantHist[j].Seq
			})
			hist, err := f.s.History(scope, card.ScopedID)
			if err != nil {
				f.t.Fatal(err)
			}
			if !same(hist, wantHist) {
				f.t.Errorf("history of %s:\n got %s\nwant %s", card.ScopedID[:10], js(hist), js(wantHist))
			}
		}

		// Accounts: the cards the rules list under each, by since.
		listed := map[[3]string]bool{}
		for _, a := range sc.Accounts {
			listed[[3]string{scope, a.Platform, a.Username}] = true
			var want []AccountCard
			for _, c := range a.Cards {
				since := f.since[slotKey{scope, c.ScopedID, a.Platform}]
				want = append(want, AccountCard{ScopedID: c.ScopedID, Since: since.date, SinceSeq: since.seq, LastCardProof: c.LastCardProof})
			}
			sort.Slice(want, func(i, j int) bool {
				if want[i].Since != want[j].Since {
					return want[i].Since < want[j].Since
				}
				return want[i].SinceSeq < want[j].SinceSeq
			})
			got, err := f.s.AccountCards(scope, a.Platform, a.Username)
			if err != nil {
				f.t.Fatal(err)
			}
			if !same(got, want) {
				f.t.Errorf("AccountCards(%s, %s):\n got %s\nwant %s", a.Platform, a.Username, js(got), js(want))
			}
		}
		// An account declared once and no longer: no card.
		for k := range f.declared {
			if k[0] == scope && !listed[k] {
				if got, err := f.s.AccountCards(scope, k[1], k[2]); err != nil || len(got) != 0 {
					f.t.Errorf("AccountCards(%s, %s) no card declares: %v %v", k[1], k[2], got, err)
				}
			}
		}

		for _, p := range verifier.Platforms(f.roster) {
			// Counts, for each day asked.
			for _, today := range todays {
				declared, recent := 0, 0
				for _, card := range sc.Cards {
					if _, ok := verifier.AccountOn(card.Accounts, p.ID); ok {
						declared++
						if today-card.LastCardProof <= RecentDays {
							recent++
						}
					}
				}
				gd, gr, err := f.s.Counts(scope, p.ID, today)
				if err != nil || gd != declared || gr != recent {
					f.t.Errorf("Counts(%s, %s) = %d, %d (%v), want %d, %d", p.ID, today, gd, gr, err, declared, recent)
				}
			}
			// The latest slots, three at a time to the end.
			var want []RecentSlot
			for k, since := range f.since {
				if k.scope == scope && k.platform == p.ID {
					u := *f.rules.Card(scope, k.scopedID).Slots[p.ID].Current
					want = append(want, RecentSlot{SinceSeq: since.seq, Since: since.date, Username: u, ScopedID: k.scopedID})
				}
			}
			sort.Slice(want, func(i, j int) bool {
				if want[i].Since != want[j].Since {
					return want[i].Since > want[j].Since
				}
				return want[i].SinceSeq > want[j].SinceSeq
			})
			if got := f.allRecent(scope, p.ID, 3); !same(got, want) {
				f.t.Errorf("Recent(%s):\n got %s\nwant %s", p.ID, js(got), js(want))
			}
		}
	}
}

// allRecent pages through Recent n at a time.
func (f *fixture) allRecent(scope, platform string, n int) []RecentSlot {
	f.t.Helper()
	var out []RecentSlot
	var before RecentPosition
	for {
		page, err := f.s.Recent(scope, platform, before, n)
		if err != nil {
			f.t.Fatal(err)
		}
		if len(page) > n {
			f.t.Fatalf("Recent gave %d, asked for %d", len(page), n)
		}
		out = append(out, page...)
		if len(page) < n {
			return out
		}
		before = page[len(page)-1].Position()
	}
}

// dumpViews returns every row of every view table, in key order.
func dumpViews(t testing.TB, s *SQLite) []string {
	t.Helper()
	var out []string
	for _, q := range []string{
		`SELECT * FROM view_state`,
		`SELECT * FROM view_cards ORDER BY scope_string, scoped_id`,
		`SELECT * FROM view_slots ORDER BY scope_string, scoped_id, platform`,
		`SELECT * FROM view_history ORDER BY seq, platform`,
	} {
		rows, err := s.db.Query(q)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			out = append(out, fmt.Sprintf("%s %v", q[14:], vals))
		}
		rows.Close()
	}
	return out
}

// rebuild empties the views and builds them again from the stored records
// with new rules, batch views per transaction, as the server does when it
// starts.
func rebuild(t testing.TB, s *SQLite, r verifier.Roster, archive rootArchive, batch int) {
	t.Helper()
	if err := s.ResetViews(); err != nil {
		t.Fatal(err)
	}
	if seq, err := s.ViewSeq(); err != nil || seq != 0 {
		t.Fatalf("ViewSeq after ResetViews: %d %v", seq, err)
	}
	records, err := s.Records(1, 1<<40)
	if err != nil {
		t.Fatal(err)
	}
	x := roster.NewRules(r, allVerify{}, archive)
	var pending []*View
	for _, rec := range records {
		before := x.Card(rec.ScopeString, rec.ScopedID)
		res, err := x.Apply(rec)
		if err != nil || !res.Valid {
			t.Fatalf("seq %d: %+v %v", rec.Seq, res, err)
		}
		v, err := NewView(rec, res, before, x.Card(rec.ScopeString, rec.ScopedID))
		if err != nil {
			t.Fatal(err)
		}
		if pending = append(pending, v); len(pending) == batch {
			if err := s.AddViews(pending); err != nil {
				t.Fatal(err)
			}
			pending = nil
		}
	}
	if err := s.AddViews(pending); err != nil {
		t.Fatal(err)
	}
}

// checkRebuild checks that emptying the views and building them again from
// the records gives the same rows, in one batch and in several.
func (f *fixture) checkRebuild() {
	f.t.Helper()
	incremental := dumpViews(f.t, f.s)
	for _, batch := range []int{1, 3, 1000} {
		rebuild(f.t, f.s, f.roster, f.archive, batch)
		if again := dumpViews(f.t, f.s); !same(again, incremental) {
			f.t.Errorf("batch %d: rebuilt views differ\nincremental %s\n    rebuilt %s", batch, js(incremental), js(again))
		}
	}
}

func js(v any) string { return fmt.Sprintf("%+v", v) }

// same compares two values as %+v writes them: a nil and an empty slice
// are the same.
func same(a, b any) bool { return js(a) == js(b) }
