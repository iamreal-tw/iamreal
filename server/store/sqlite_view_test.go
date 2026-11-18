package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

var productionScope = verifier.Scopes(verifier.Production)[0].String

func date(t testing.TB, s string) verifier.Date {
	t.Helper()
	d, err := verifier.ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// One card through every kind of change, on one platform: the history,
// newest first, says what each record did, with the accounts before and
// after; since moves only when the account does.
func TestViewsHistoryOfOneCard(t *testing.T) {
	f := newFixture(t, verifier.Production)
	card := cardID(1, 1)
	scope := productionScope
	add := func(date string, accounts ...string) {
		t.Helper()
		if res := f.write(f.record(scope, card, date, accountsOf(accounts...))); !res.Valid {
			t.Fatalf("%s %v: %s", date, accounts, res.Reason)
		}
	}
	add("2026-03-02", "threads:bob")   // 1 first
	add("2026-03-02", "threads:alice") // 2 correction
	add("2026-05-10", "threads:alice") // 3 refresh
	add("2026-08-01", "threads:carol") // 4 switch
	add("2026-11-06")                  // 5 withdraw, all
	add("2026-11-07", "threads:carol") // 6 the same account again
	add("2026-11-08")                  // 7 withdraw
	add("2026-11-09", "threads:dave")  // 8 another account, a later date: a switch
	add("2026-11-09")                  // 9 withdraw
	add("2026-11-09", "threads:erin")  // 10 another account, the date of the switch: a correction
	add("2026-11-08", "threads:erin")  // 11 a day back (allowed): a refresh

	type row struct {
		seq                 uint64
		date, event, before string
		after               string
	}
	want := []row{
		{10, "2026-11-09", EventCorrectionAfterWithdrawal, "dave", "erin"},
		{9, "2026-11-09", EventWithdraw, "dave", ""},
		{8, "2026-11-09", EventSwitchAfterWithdrawal, "carol", "dave"},
		{11, "2026-11-08", EventRefresh, "erin", "erin"},
		{7, "2026-11-08", EventWithdraw, "carol", ""},
		{6, "2026-11-07", EventRedeclare, "carol", "carol"},
		{5, "2026-11-06", EventWithdraw, "carol", ""},
		{4, "2026-08-01", EventSwitch, "alice", "carol"},
		{3, "2026-05-10", EventRefresh, "alice", "alice"},
		{2, "2026-03-02", EventCorrection, "bob", "alice"},
		{1, "2026-03-02", EventFirst, "", "bob"},
	}
	hist, err := f.s.History(scope, card)
	if err != nil {
		t.Fatal(err)
	}
	var got []row
	for _, h := range hist {
		if len(h.Changes) != 1 || h.Changes[0].Platform != "threads" {
			t.Fatalf("seq %d: %+v", h.Seq, h.Changes)
		}
		c := h.Changes[0]
		got = append(got, row{h.Seq, h.Date.String(), c.Event(), c.Before, c.After})
	}
	if !same(got, want) {
		t.Errorf("history\n got %+v\nwant %+v", got, want)
	}

	cards, err := f.s.Cards(scope, verifier.ShortID(card))
	if err != nil || len(cards) != 1 {
		t.Fatalf("Cards: %+v %v", cards, err)
	}
	wantCard := CardSummary{
		ScopedID: card, FirstCardProof: date(t, "2026-03-02"), LastCardProof: date(t, "2026-11-09"), CardProofs: 11,
		Slots: []SlotSummary{{Platform: "threads", Current: "erin", Since: date(t, "2026-11-09"), SinceSeq: 10, SwitchCount: 2}},
	}
	if !same(cards[0], wantCard) {
		t.Errorf("card\n got %+v\nwant %+v", cards[0], wantCard)
	}
	f.check(date(t, "2026-11-09"))
	f.checkRebuild()
}

// One record changes several platforms; a withdrawn slot stays listed with
// its switch count.
func TestViewsTwoPlatforms(t *testing.T) {
	f := newFixture(t, verifier.Test)
	card := cardID(2, 1)
	f.add(card, "2026-11-10", "test-example:a-b", "threads:alice")
	f.add(card, "2026-11-11", "threads:bob") // test-example withdraw, threads switch
	hist, err := f.s.History(testScope, card)
	if err != nil {
		t.Fatal(err)
	}
	wantHist := []HistoryRecord{
		{Seq: 2, Date: date(t, "2026-11-11"), Changes: []SlotChange{
			{Platform: "test-example", Kind: roster.KindWithdraw, Before: "a-b"},
			{Platform: "threads", Kind: roster.KindSwitch, Before: "alice", After: "bob"},
		}},
		{Seq: 1, Date: date(t, "2026-11-10"), Changes: []SlotChange{
			{Platform: "test-example", Kind: roster.KindFirst, After: "a-b"},
			{Platform: "threads", Kind: roster.KindFirst, After: "alice"},
		}},
	}
	if !same(hist, wantHist) {
		t.Errorf("history\n got %+v\nwant %+v", hist, wantHist)
	}
	cards, err := f.s.Cards(testScope, verifier.ShortID(card))
	if err != nil || len(cards) != 1 {
		t.Fatalf("Cards: %+v %v", cards, err)
	}
	wantSlots := []SlotSummary{
		{Platform: "test-example"},
		{Platform: "threads", Current: "bob", Since: date(t, "2026-11-11"), SinceSeq: 2, SwitchCount: 1},
	}
	if !same(cards[0].Slots, wantSlots) {
		t.Errorf("slots\n got %+v\nwant %+v", cards[0].Slots, wantSlots)
	}
	f.check(date(t, "2026-11-11"))
	f.checkRebuild()
}

// The cards of an account, by since, then seq; a refresh does not move a
// card, a new declaration does. The same username on another platform is
// another account.
func TestViewsAccountCardsOrder(t *testing.T) {
	f := newFixture(t, verifier.Test)
	a, b, c, d := cardID(3, 1), cardID(4, 1), cardID(5, 1), cardID(6, 1)
	f.add(a, "2026-11-10", "threads:alice") // 1
	f.add(b, "2026-11-10", "threads:alice") // 2
	f.add(c, "2026-11-09", "threads:alice") // 3: dated a day back
	f.add(d, "2026-11-10", "test-example:alice")
	ids := func() []string {
		got, err := f.s.AccountCards(testScope, "threads", "alice")
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, x := range got {
			out = append(out, x.ScopedID)
		}
		return out
	}
	if got, want := ids(), []string{c, a, b}; !same(got, want) {
		t.Errorf("by since: %v, want %v", got, want)
	}
	f.add(a, "2026-11-11", "threads:alice") // refresh: a stays
	if got, want := ids(), []string{c, a, b}; !same(got, want) {
		t.Errorf("after a refresh: %v, want %v", got, want)
	}
	f.add(b, "2026-11-12", "threads:bob")
	f.add(b, "2026-11-13", "threads:alice") // a switch back: b starts again
	if got, want := ids(), []string{c, a, b}; !same(got, want) {
		t.Errorf("after switching back: %v, want %v", got, want)
	}
	f.add(c, "2026-11-13") // c withdraws everything
	if got, want := ids(), []string{a, b}; !same(got, want) {
		t.Errorf("after a withdrawal: %v, want %v", got, want)
	}
	if got, err := f.s.AccountCards(testScope, "threads", "nobody"); err != nil || len(got) != 0 {
		t.Errorf("an account no card declares: %v %v", got, err)
	}
	if got, err := f.s.AccountCards(testScope, "test-example", "alice"); err != nil || len(got) != 1 || got[0].ScopedID != d {
		t.Errorf("alice on test-example: %v %v", got, err)
	}
	f.check(date(t, "2026-11-13"))
	f.checkRebuild()
}

// A short ID resolves to every card that starts with it, by scoped ID;
// nothing else resolves.
func TestViewsShortID(t *testing.T) {
	f := newFixture(t, verifier.Test)
	x, y, z := cardID(7, 2), cardID(7, 1), cardID(8, 1)
	if verifier.ShortID(x) != verifier.ShortID(y) || x == y || verifier.ShortID(x) == verifier.ShortID(z) {
		t.Fatalf("test cards: %s %s %s", x, y, z)
	}
	f.add(x, "2026-11-10", "threads:alice")
	f.add(y, "2026-11-10", "threads:bob")
	f.add(z, "2026-11-10", "threads:alice")
	got, err := f.s.Cards(testScope, verifier.ShortID(x))
	if err != nil || len(got) != 2 || got[0].ScopedID != min(x, y) || got[1].ScopedID != max(x, y) {
		t.Errorf("two cards: %+v %v", got, err)
	}
	if got, err := f.s.Cards(testScope, verifier.ShortID(z)); err != nil || len(got) != 1 || got[0].ScopedID != z {
		t.Errorf("one card: %+v %v", got, err)
	}
	short := verifier.ShortID(z)
	for _, s := range []string{"7K2Q9FM4XD", strings.ToLower(short), short[:9], z[:11], z, ""} {
		if got, err := f.s.Cards(testScope, s); err != nil || len(got) != 0 {
			t.Errorf("Cards(%q): %+v %v", s, got, err)
		}
	}
	if got, err := f.s.Cards(productionScope, short); err != nil || len(got) != 0 {
		t.Errorf("another scope: %+v %v", got, err)
	}
	if got, err := f.s.History(testScope, cardID(9, 9)); err != nil || len(got) != 0 {
		t.Errorf("History of a card with no record: %+v %v", got, err)
	}
	f.check(date(t, "2026-11-10"))
}

// The counts: cards with an account on the platform now; of them, those
// whose last card proof is on today or up to 90 days before (day 90
// included, day 91 not).
func TestViewsCounts(t *testing.T) {
	f := newFixture(t, verifier.Test)
	today := date(t, "2026-11-18")
	day := func(n int) string { return today.AddDays(n).String() }
	gone := cardID(10, 6)
	f.add(cardID(10, 1), day(-91), "threads:a")
	f.add(gone, day(-91), "threads:gone")
	f.add(gone, day(-91)) // withdraws everything: not counted
	f.add(cardID(10, 2), day(-90), "threads:b")
	f.add(cardID(10, 3), day(-1), "threads:c")
	f.add(cardID(10, 4), day(0), "threads:d")
	f.add(cardID(10, 5), day(2), "test-example:e") // another platform, dated ahead
	for _, c := range []struct {
		platform        string
		today           int
		declared, fresh int
	}{
		{"threads", 0, 4, 3},
		{"threads", 1, 4, 2},
		{"threads", -91, 4, 4},
		{"test-example", 0, 1, 1},
		{"test-example", 93, 1, 0},
	} {
		d, r, err := f.s.Counts(testScope, c.platform, today.AddDays(c.today))
		if err != nil || d != c.declared || r != c.fresh {
			t.Errorf("Counts(%s, today%+d) = %d, %d (%v), want %d, %d", c.platform, c.today, d, r, err, c.declared, c.fresh)
		}
	}
	if d, r, err := f.s.Counts(productionScope, "threads", today); err != nil || d != 0 || r != 0 {
		t.Errorf("another scope: %d %d %v", d, r, err)
	}
	f.check(today, today.AddDays(1), today.AddDays(-90), today.AddDays(91))
	f.checkRebuild()
}

// The latest slots, a page at a time: by the date from which each gives
// its place to its account, latest first, and the same date by the seq of
// that record. A record dated a day back sorts by its date, not its seq.
// A refresh does not bring a slot back up; a new account does.
func TestViewsRecent(t *testing.T) {
	f := newFixture(t, verifier.Test)
	var cards []string
	for i, d := range []string{"2026-11-10", "2026-11-10", "2026-11-11", "2026-11-09", "2026-11-11"} {
		cards = append(cards, cardID(uint64(21+i), 1))
		f.add(cards[i], d, fmt.Sprintf("threads:u%d", i+1)) // seq i+1
	}
	page := func(before RecentPosition, n int) ([]string, RecentPosition) {
		got, err := f.s.Recent(testScope, "threads", before, n)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		var last RecentPosition
		for _, r := range got {
			out = append(out, r.Username)
			last = r.Position()
		}
		return out, last
	}
	all, _ := page(RecentPosition{}, 5)
	if want := []string{"u5", "u3", "u2", "u1", "u4"}; !same(all, want) {
		t.Errorf("exactly all: %v, want %v", all, want)
	}
	var got []string
	var at RecentPosition
	for i, want := range [][]string{{"u5", "u3"}, {"u2", "u1"}, {"u4"}, nil} {
		got, at = page(at, 2)
		if !same(got, want) {
			t.Errorf("page %d: %v, want %v", i+1, got, want)
		}
		if got == nil {
			break
		}
	}
	// After a position inside a date: the rest of that date, then the
	// dates before.
	if got, _ := page(RecentPosition{Since: date(t, "2026-11-11"), SinceSeq: 5}, 2); !same(got, []string{"u3", "u2"}) {
		t.Errorf("after u5: %v", got)
	}
	f.add(cards[0], "2026-11-12", "threads:u1")  // refresh: stays where it was
	f.add(cards[1], "2026-11-12", "threads:u2b") // switch: first
	f.add(cards[2], "2026-11-12")                // withdraw: gone
	if got, _ := page(RecentPosition{}, 10); !same(got, []string{"u2b", "u5", "u1", "u4"}) {
		t.Errorf("after changes: %v", got)
	}
	if got, err := f.s.Recent(testScope, "test-example", RecentPosition{}, 10); err != nil || len(got) != 0 {
		t.Errorf("another platform: %v %v", got, err)
	}
	f.check(date(t, "2026-11-12"))
	f.checkRebuild()
}

// The first card proof is the earliest date among the card's valid
// records, which is not always the date of its first record: dates can
// step back.
func TestViewsFirstCardProof(t *testing.T) {
	f := newFixture(t, verifier.Test)
	card := cardID(50, 1)
	f.add(card, "2026-11-10", "threads:alice")
	f.add(card, "2026-11-08", "threads:alice") // two days back: allowed
	f.add(card, "2026-11-11", "threads:alice")
	cards, err := f.s.Cards(testScope, verifier.ShortID(card))
	if err != nil || len(cards) != 1 {
		t.Fatalf("%+v %v", cards, err)
	}
	if got := cards[0]; got.FirstCardProof.String() != "2026-11-08" || got.LastCardProof.String() != "2026-11-11" || got.CardProofs != 3 {
		t.Errorf("%+v", got)
	}
	hist, err := f.s.History(testScope, card)
	if err != nil || len(hist) != 3 || hist[len(hist)-1].Date != cards[0].FirstCardProof {
		t.Errorf("the last row of the history: %+v %v", hist, err)
	}
	f.check(date(t, "2026-11-11"))
	f.checkRebuild()
}

// The roster of every case of spec/vectors/roster-rules.json: the views
// say what the rules say. The store holds only valid records, as the
// server writes only those, so each case's valid records are written in
// order; an invalid record changes nothing but its challenge, so leaving
// it out changes no later result, which the test checks too.
func TestViewsMatchVectors(t *testing.T) {
	b, err := os.ReadFile("../../spec/vectors/roster-rules.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Cases []struct {
			Name   string `json:"name"`
			Roster string `json:"roster"`
			Events []struct {
				Seq         uint64 `json:"seq"`
				ScopeString string `json:"scope_string"`
				ScopedID    string `json:"scoped_id"`
				Accounts    []struct {
					Platform string `json:"platform"`
					Username string `json:"username"`
				} `json:"accounts"`
				Challenge string   `json:"challenge"`
				Verifies  bool     `json:"verifies"`
				CRLDates  []string `json:"crl_dates"`
			} `json:"events"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			r := map[string]verifier.Roster{"production": verifier.Production, "test": verifier.Test}[c.Roster]
			f := newFixture(t, r)
			proofs := map[uint64]bool{}
			var records []*verifier.Record
			for _, e := range c.Events {
				rec := f.record(e.ScopeString, e.ScopedID, e.Challenge[:10], nil)
				rec.Seq, rec.Challenge = e.Seq, e.Challenge
				for _, a := range e.Accounts {
					rec.Accounts = append(rec.Accounts, verifier.Account{Platform: a.Platform, Username: a.Username})
				}
				f.archive[rec.SMTRoot] = nil
				for _, s := range e.CRLDates {
					f.archive[rec.SMTRoot] = append(f.archive[rec.SMTRoot], date(t, s))
				}
				proofs[e.Seq] = e.Verifies
				records = append(records, rec)
			}
			whole, err := roster.Apply(records, r, vectorProofs(proofs), f.archive)
			if err != nil {
				t.Fatal(err)
			}
			var latest verifier.Date
			for i, rec := range records {
				want := whole.Records[i]
				if !want.Valid {
					continue
				}
				copied := *rec
				got := f.write(&copied)
				want.Seq = got.Seq
				if !got.Equal(want) {
					t.Fatalf("event %d: alone %+v, in the case %+v", rec.Seq, got, want)
				}
				if d, _ := rec.Date(); d > latest {
					latest = d
				}
			}
			if st := f.rules.State(); !same(st.Scopes, whole.Scopes) {
				t.Fatalf("the valid records alone give\n%+v\nthe case\n%+v", st.Scopes, whole.Scopes)
			}
			f.check(latest, latest.AddDays(RecentDays), latest.AddDays(RecentDays+1))
			f.checkRebuild()
		})
	}
}

// vectorProofs is check 1 from the events' `verifies`.
type vectorProofs map[uint64]bool

func (p vectorProofs) VerifyRecord(r *verifier.Record) error {
	if p[r.Seq] {
		return nil
	}
	return &verifier.Rejection{Reason: "the vector says it does not verify"}
}

// next returns the next record of f and its view, without writing them.
func (f *fixture) next(card, date string, accounts ...string) (*verifier.Record, *View) {
	f.t.Helper()
	r := f.record(testScope, card, date, accountsOf(accounts...))
	count, head, err := f.s.Head()
	if err != nil {
		f.t.Fatal(err)
	}
	r.Seq, r.Prev = count+1, head
	before := f.rules.Card(r.ScopeString, r.ScopedID)
	res, after, err := f.rules.CheckWithCard(r)
	if err != nil || !res.Valid {
		f.t.Fatalf("%+v %v", res, err)
	}
	v, err := NewView(r, res, before, after)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := f.s.AddChallenge(r.Challenge, t0); err != nil {
		f.t.Fatal(err)
	}
	return r, v
}

// unchanged checks that the records, the views and the challenge of r are
// as they were.
func unchanged(t *testing.T, f *fixture, count uint64, views []string, r *verifier.Record) {
	t.Helper()
	if n, _, err := f.s.Head(); err != nil || n != count {
		t.Errorf("records: %d (%v), want %d", n, err, count)
	}
	if got := dumpViews(t, f.s); !same(got, views) {
		t.Errorf("views changed\nbefore %v\n after %v", views, got)
	}
	var accepted bool
	if err := f.s.db.QueryRow(`SELECT accepted FROM challenges WHERE challenge = ?`, r.Challenge).Scan(&accepted); err != nil || accepted {
		t.Errorf("challenge accepted: %v %v", accepted, err)
	}
}

// A write that fails half way leaves the records and the views as they
// were: the record, the challenge and the views are one transaction.
func TestAppendWithViewsIsOneTransaction(t *testing.T) {
	f := newFixture(t, verifier.Test)
	card := cardID(30, 1)
	f.add(card, "2026-11-10", "test-example:a-b", "threads:alice")
	views := dumpViews(t, f.s)

	r, v := f.next(card, "2026-11-11", "test-example:a-b", "threads:bob")
	// The second change fails when its history row is written, after the
	// record, the card and the first change are.
	broken := *v
	broken.Changes = []SlotChange{v.Changes[1], v.Changes[1]}
	if err := f.s.Append(r, &broken); err == nil {
		t.Fatal("a broken view was written")
	}
	unchanged(t, f, 1, views, r)

	// A view of another record.
	other := *v
	other.Seq++
	if err := f.s.Append(r, &other); !errors.Is(err, ErrViewMismatch) {
		t.Errorf("view of another seq: %v", err)
	}
	other = *v
	other.ScopedID = cardID(31, 1)
	if err := f.s.Append(r, &other); !errors.Is(err, ErrViewMismatch) {
		t.Errorf("view of another card: %v", err)
	}
	unchanged(t, f, 1, views, r)

	// The record with its view goes in.
	if err := f.s.Append(r, v); err != nil {
		t.Fatal(err)
	}
	if _, err := f.rules.Apply(r); err != nil {
		t.Fatal(err)
	}
	if seq, err := f.s.ViewSeq(); err != nil || seq != 2 {
		t.Errorf("ViewSeq %d %v", seq, err)
	}

	// A challenge already accepted: nothing is written, views included.
	r2, v2 := f.next(card, "2026-11-12", "threads:bob")
	r2.Challenge = r.Challenge
	views = dumpViews(t, f.s)
	if err := f.s.Append(r2, v2); !errors.Is(err, ErrChallengeNotOpen) {
		t.Errorf("used challenge: %v", err)
	}
	if got := dumpViews(t, f.s); !same(got, views) {
		t.Errorf("views changed")
	}
}

// Records written without their views leave the views behind, and say
// so: a view for a later record is refused until AddViews brings them up.
func TestViewsBehind(t *testing.T) {
	f := newFixture(t, verifier.Test)
	card := cardID(32, 1)
	f.add(card, "2026-11-10", "threads:alice")

	r, v := f.next(card, "2026-11-11", "threads:bob")
	if err := f.s.Append(r, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f.rules.Apply(r); err != nil {
		t.Fatal(err)
	}
	if seq, err := f.s.ViewSeq(); err != nil || seq != 1 {
		t.Errorf("ViewSeq after a record without its view: %d %v", seq, err)
	}
	r3, v3 := f.next(card, "2026-11-12", "threads:carol")
	views := dumpViews(t, f.s)
	if err := f.s.Append(r3, v3); !errors.Is(err, ErrViewsBehind) {
		t.Errorf("views behind: %v", err)
	}
	unchanged(t, f, 2, views, r3)

	// AddViews: not the next one; not the stored record; one broken in
	// the middle; then the right one.
	if err := f.s.AddViews([]*View{v3}); !errors.Is(err, ErrViewsBehind) {
		t.Errorf("AddViews skipping one: %v", err)
	}
	wrong := *v
	wrong.ScopedID = cardID(33, 1)
	if err := f.s.AddViews([]*View{&wrong}); !errors.Is(err, ErrViewMismatch) {
		t.Errorf("AddViews of another card: %v", err)
	}
	broken := *v
	broken.Changes = []SlotChange{v.Changes[0], v.Changes[0]}
	if err := f.s.AddViews([]*View{&broken}); err == nil {
		t.Errorf("AddViews wrote a broken view")
	}
	if got := dumpViews(t, f.s); !same(got, views) {
		t.Errorf("views changed by a failed AddViews")
	}
	if err := f.s.AddViews([]*View{v}); err != nil {
		t.Fatal(err)
	}
	if err := f.s.Append(r3, v3); err != nil {
		t.Fatal(err)
	}
	if seq, err := f.s.ViewSeq(); err != nil || seq != 3 {
		t.Errorf("ViewSeq %d %v", seq, err)
	}
	// The views are those of writing every record with its view.
	caughtUp := dumpViews(t, f.s)
	rebuild(t, f.s, f.roster, f.archive, 1000)
	if got := dumpViews(t, f.s); !same(got, caughtUp) {
		t.Errorf("caught up\n%v\nrebuilt\n%v", caughtUp, got)
	}
}

// Every query of the pages reads one range of an index and sorts nothing.
func TestViewQueriesUseIndexes(t *testing.T) {
	f := newFixture(t, verifier.Test)
	f.add(cardID(40, 1), "2026-11-10", "threads:alice")
	for _, q := range []struct {
		name, sql string
		args      []any
	}{
		{"Cards", queryCards, []any{testScope, "0123456789"}},
		{"slots", querySlots, []any{testScope, "X"}},
		{"History", queryHistory, []any{testScope, "X"}},
		{"AccountCards", queryAccountCards, []any{testScope, "threads", "alice"}},
		{"Recent", queryRecent, []any{testScope, "threads", 20000, 100, 50}},
		{"Counts", queryCounts, []any{1, testScope, "threads"}},
	} {
		rows, err := f.s.db.Query("EXPLAIN QUERY PLAN "+q.sql, q.args...)
		if err != nil {
			t.Fatal(err)
		}
		var plan []string
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
		}
		rows.Close()
		if len(plan) != 1 || !strings.HasPrefix(plan[0], "SEARCH ") ||
			!strings.Contains(plan[0], " INDEX ") && !strings.Contains(plan[0], " PRIMARY KEY ") {
			t.Errorf("%s: %q", q.name, plan)
		}
		t.Logf("%s: %s", q.name, plan)
	}
}
