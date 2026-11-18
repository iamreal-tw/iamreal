package store

// Measurements of the views on a roster of made-up cards. Skipped unless
// IAMREAL_VIEW_MEASURE is set:
//
//	IAMREAL_VIEW_MEASURE=10000 go test -run TestMeasureViews -v ./server/store

import (
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/verifier"
)

func TestMeasureViews(t *testing.T) {
	n, _ := strconv.Atoi(os.Getenv("IAMREAL_VIEW_MEASURE"))
	if n <= 0 {
		t.Skip("set IAMREAL_VIEW_MEASURE to a number of cards")
	}
	f := newFixture(t, verifier.Production)
	scope := productionScope
	// Building the roster is not measured: no fsync.
	if _, err := f.s.db.Exec(`PRAGMA synchronous = OFF`); err != nil {
		t.Fatal(err)
	}
	start := date(t, "2026-01-01")
	cards := make([]string, n)
	add := func(card string, d verifier.Date, accounts ...string) {
		t.Helper()
		if res := f.write(f.record(scope, card, d.String(), accountsOf(accounts...))); !res.Valid {
			t.Fatalf("%s: %s", card, res.Reason)
		}
	}
	// Cards declare one after another over 300 days. One in 50 declares
	// the same account; the others share accounts two by two. A card 1,000
	// steps back then refreshes (30%), switches (10%) or withdraws (5%).
	t0 := time.Now()
	for i := 0; i < n; i++ {
		d := start.AddDays(i * 300 / n)
		cards[i] = cardID(uint64(i), uint64(i))
		u := fmt.Sprintf("u%d", i/2)
		if i%50 == 0 {
			u = "popular"
		}
		add(cards[i], d, "threads:"+u)
		if j := i - 1000; j >= 0 {
			switch j % 20 {
			case 0, 1, 2, 3, 4, 5:
				_, cur := f.currentOn(scope, cards[j])
				if cur != "" {
					add(cards[j], d, "threads:"+cur)
				}
			case 6, 7:
				add(cards[j], d, fmt.Sprintf("threads:s%d", j))
			case 8:
				add(cards[j], d)
			}
		}
	}
	records, _, _ := f.s.Head()
	t.Logf("built %d cards, %d records in %v", n, records, time.Since(t0).Round(time.Millisecond))
	today := start.AddDays(300)

	// Rebuilding the views from every record (rules included), as at
	// start-up after ResetViews, without fsync.
	t1 := time.Now()
	rebuild(t, f.s, f.roster, f.archive, 1000)
	t.Logf("rebuild from %d records: %v", records, time.Since(t1).Round(time.Millisecond))

	// The cost of one append, with synchronous(FULL) as the server runs:
	// with the views, then records only (which leaves the views behind,
	// so it goes second). The building left a large write-ahead log and
	// pages not yet on disk: checkpoint with synchronous(FULL) first, or
	// the first appends pay for them.
	if _, err := f.s.db.Exec(`PRAGMA synchronous = FULL`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		t.Fatal(err)
	}
	const appends = 300
	var withViews, alone []time.Duration
	for i := 0; i < appends; i++ {
		r, v := f.next(cardID(uint64(n+i), uint64(n+i)), today.String(), "threads:new")
		t2 := time.Now()
		if err := f.s.Append(r, v); err != nil {
			t.Fatal(err)
		}
		withViews = append(withViews, time.Since(t2))
		f.rules.Apply(r)
	}
	for i := 0; i < appends; i++ {
		r, _ := f.next(cardID(uint64(2*n+i), uint64(2*n+i)), today.String(), "threads:new")
		t2 := time.Now()
		if err := f.s.Append(r, nil); err != nil {
			t.Fatal(err)
		}
		alone = append(alone, time.Since(t2))
		f.rules.Apply(r)
	}
	t.Logf("append, synchronous(FULL), %d each: with views %s; record only %s", appends, spread(withViews), spread(alone))

	rng := rand.New(rand.NewSource(1))
	const rounds = 2000
	measure := func(name string, q func() int) {
		t.Helper()
		rows := 0
		t3 := time.Now()
		for i := 0; i < rounds; i++ {
			rows += q()
		}
		t.Logf("%-28s mean %8v  (%.1f rows)", name, (time.Since(t3) / rounds).Round(100*time.Nanosecond), float64(rows)/rounds)
	}
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	measure("Cards (short ID)", func() int {
		got, err := f.s.Cards(scope, verifier.ShortID(cards[rng.Intn(n)]))
		must(err)
		return len(got)
	})
	measure("Cards (no match)", func() int {
		got, err := f.s.Cards(scope, "7K2Q9FM4XD")
		must(err)
		return len(got)
	})
	measure("History", func() int {
		got, err := f.s.History(scope, cards[rng.Intn(n)])
		must(err)
		return len(got)
	})
	measure("AccountCards (one or two)", func() int {
		got, err := f.s.AccountCards(scope, "threads", fmt.Sprintf("u%d", rng.Intn(n/2)))
		must(err)
		return len(got)
	})
	measure("AccountCards (popular)", func() int {
		got, err := f.s.AccountCards(scope, "threads", "popular")
		must(err)
		return len(got)
	})
	measure("Recent (first 50)", func() int {
		got, err := f.s.Recent(scope, "threads", RecentPosition{}, 50)
		must(err)
		return len(got)
	})
	measure("Recent (50 from the middle)", func() int {
		got, err := f.s.Recent(scope, "threads", RecentPosition{Since: start.AddDays(rng.Intn(300)), SinceSeq: records}, 50)
		must(err)
		return len(got)
	})
	measure("Counts", func() int {
		d, r, err := f.s.Counts(scope, "threads", today)
		must(err)
		if r > d {
			t.Fatalf("Counts %d %d", d, r)
		}
		return 1
	})
	d, r, _ := f.s.Counts(scope, "threads", today)
	t.Logf("Counts: %d declared, %d in the last 90 days", d, r)
}

// spread writes the mean, the median, the 99th percentile and the
// longest of ds.
func spread(ds []time.Duration) string {
	sorted := append([]time.Duration(nil), ds...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	var sum time.Duration
	for _, d := range ds {
		sum += d
	}
	r := func(d time.Duration) time.Duration { return d.Round(time.Microsecond) }
	return fmt.Sprintf("mean %v, median %v, p99 %v, max %v", r(sum/time.Duration(len(ds))), r(sorted[len(ds)/2]), r(sorted[len(ds)*99/100]), r(sorted[len(ds)-1]))
}

// currentOn returns the card's current account on threads, from the rules.
func (f *fixture) currentOn(scope, card string) (string, string) {
	if cur := f.rules.Card(scope, card).Slots["threads"].Current; cur != nil {
		return "threads", *cur
	}
	return "threads", ""
}
