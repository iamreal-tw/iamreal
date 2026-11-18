package pages

// The page functions on their own, with data made here and no server. The
// words of the pages are checked against design/copy/ in
// server/visitor_test.go, through the server.

import (
	"bytes"
	"regexp"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/server/store"
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

const idA = "7K2Q9FM4XD3A0000000000000000000000000000000000000000"

func TestThousands(t *testing.T) {
	for n, want := range map[int]string{0: "0", 7: "7", 999: "999", 1000: "1,000", 1284: "1,284", 100000: "100,000", 1234567: "1,234,567"} {
		if got := thousands(n); got != want {
			t.Errorf("%d: %q", n, got)
		}
	}
}

func TestPrefixes(t *testing.T) {
	a, b, c := idA, "7K2Q9FM4XD3B"+idA[12:], "3M8T1RZ6WA"+idA[10:]
	for _, x := range []struct {
		ids  []string
		want string
	}{
		{nil, ""},
		{[]string{a}, "7K2Q9FM4XD"},
		{[]string{a, c}, "7K2Q9FM4XD 3M8T1RZ6WA"},
		{[]string{a, b}, "7K2Q9FM4XD3A 7K2Q9FM4XD3B"},
		// One length for the whole list.
		{[]string{a, b, c}, "7K2Q9FM4XD3A 7K2Q9FM4XD3B 3M8T1RZ6WA3A"},
	} {
		if got := strings.Join(Prefixes(x.ids), " "); got != x.want {
			t.Errorf("%v: %q", x.ids, got)
		}
	}
}

func TestPosition(t *testing.T) {
	p := store.RecentPosition{Since: date(t, "2026-11-17"), SinceSeq: 123}
	if s := FormatPosition(p); s != "2026-11-17.123" {
		t.Fatal(s)
	}
	if got, ok := ParsePosition("2026-11-17.123"); !ok || got != p {
		t.Errorf("%v %v", got, ok)
	}
	for _, bad := range []string{"", "2026-11-17", "2026-11-17.", "2026-11-17.0", "2026-11-17.012", "2026-11-17.-1", "2026-13-01.1", "2026-11-17.1x", "x"} {
		if _, ok := ParsePosition(bad); ok {
			t.Errorf("%q read", bad)
		}
	}
}

func TestUsernames(t *testing.T) {
	if LowerASCII("Carol.TW_1") != "carol.tw_1" || LowerASCII("Ålice") != "Ålice" {
		t.Error("LowerASCII")
	}
	for u, want := range map[string]bool{"alice": true, "carol.tw": true, "a_b": true, "Alice": false, "a-b": false, "": false, strings.Repeat("a", 30): true, strings.Repeat("a", 31): false} {
		if ValidUsername(u) != want {
			t.Errorf("%q", u)
		}
	}
}

// Pages made from data alone: no script, no inline style, and what comes
// from the URL escaped; a page refuses an account not in the format rather
// than put it in the frame's address.
func TestRenderAlone(t *testing.T) {
	today := date(t, "2026-11-18")
	card := Card{
		Summary: store.CardSummary{ScopedID: idA, FirstCardProof: today, LastCardProof: today, CardProofs: 1,
			Slots: []store.SlotSummary{{Platform: "threads", Current: "alice", Since: today, SinceSeq: 1}}},
		History: []store.HistoryRecord{{Seq: 1, Date: today, Changes: []store.SlotChange{{Platform: "threads", Kind: "first", After: "alice"}}}},
	}
	var pages []string
	render := func(f func(*bytes.Buffer) error) {
		t.Helper()
		var b bytes.Buffer
		if err := f(&b); err != nil {
			t.Fatal(err)
		}
		pages = append(pages, b.String())
	}
	site := Site{TestRoster: true}
	render(func(b *bytes.Buffer) error {
		return ProofPage{ShortID: "7K2Q9FM4XD", Cards: []Card{card}, Today: today}.Render(b, site)
	})
	render(func(b *bytes.Buffer) error { return ProofMissing{Typed: `<script>x"`}.Render(b, site) })
	render(func(b *bytes.Buffer) error {
		return AccountPage{Username: "alice", Cards: []store.AccountCard{{ScopedID: idA, Since: today, LastCardProof: today}}, Today: today}.Render(b, site)
	})
	render(func(b *bytes.Buffer) error { return NotAName{}.Render(b, site) })
	render(func(b *bytes.Buffer) error { return RosterPage{Query: `"><script>`, BadQuery: true}.Render(b, site) })
	render(func(b *bytes.Buffer) error { return HomePage{Declared: 1284, Recent: 1031}.Render(b, site) })
	render(func(b *bytes.Buffer) error { return FAQPage{}.Render(b, site) })
	render(func(b *bytes.Buffer) error { return HangPage{}.Render(b, site) })
	inline := regexp.MustCompile(`(?i)<\s*script|<\s*style|\sstyle\s*=|\son[a-z]+\s*=`)
	for _, p := range pages {
		if m := inline.FindString(p); m != "" {
			t.Errorf("%q on the page:\n%s", m, p)
		}
	}
	if !strings.Contains(pages[5], "現在有 <b>1,284</b> 張島民證明") {
		t.Error(pages[5])
	}
	// The two pages with the copy buttons load /copy.js and nothing else.
	var withScript []string
	for _, f := range []func(*bytes.Buffer) error{
		func(b *bytes.Buffer) error { return VerifyPage{}.Render(b, site) },
		func(b *bytes.Buffer) error {
			return HangPage{ShortID: "7K2Q9FM4XD", Account: "carol.tw"}.Render(b, site)
		},
	} {
		var b bytes.Buffer
		if err := f(&b); err != nil {
			t.Fatal(err)
		}
		withScript = append(withScript, b.String())
	}
	for _, p := range withScript {
		if n := len(regexp.MustCompile(`(?i)<\s*script`).FindAllString(p, -1)); n != 1 || !strings.Contains(p, `<script src="/copy.js" defer></script>`) {
			t.Errorf("%d scripts:\n%s", n, p)
		}
		if m := regexp.MustCompile(`(?i)<\s*style|\sstyle\s*=|\son[a-z]+\s*=`).FindString(p); m != "" {
			t.Errorf("%q on the page", m)
		}
	}
	if !strings.Contains(withScript[1], `href="https://www.threads.com/@carol.tw"`) || !strings.Contains(withScript[1], `<a href="/p/7K2Q9FM4XD">`) {
		t.Error(withScript[1])
	}
	// The page refuses an account not in the format, or a short ID not in
	// its one spelling, rather than put it in a link.
	for _, p := range []HangPage{
		{ShortID: "7K2Q9FM4XD", Account: `a"><script>`}, {ShortID: "7K2Q9FM4XD", Account: "Alice"}, {ShortID: "7K2Q9FM4XD"},
		{ShortID: "7k2q9fm4xd", Account: "alice"}, {ShortID: `"><b>`, Account: "alice"}, {Account: "alice"},
	} {
		if err := p.Render(&bytes.Buffer{}, site); err == nil {
			t.Errorf("%+v was rendered", p)
		}
	}
	if !strings.Contains(pages[0], `src="https://www.threads.com/@alice/embed/"`) || !strings.Contains(pages[0], "上次過卡：今天（2026-11-18）") {
		t.Error(pages[0])
	}

	card.Summary.Slots[0].Current = `a"/><script>`
	if err := (ProofPage{ShortID: "7K2Q9FM4XD", Cards: []Card{card}, Today: today}).Render(&bytes.Buffer{}, site); err == nil {
		t.Error("an account not in the format was rendered")
	}
	if err := (AccountPage{Username: "A"}).Render(&bytes.Buffer{}, site); err == nil {
		t.Error("an account not in the format was rendered")
	}
	if err := (ProofPage{ShortID: "7K2Q9FM4XD"}).Render(&bytes.Buffer{}, site); err == nil {
		t.Error("a page of no card was rendered")
	}
	card.Summary.Slots[0].Current = "alice"
	card.History[0].Changes[0].Kind = "something new"
	if err := (ProofPage{ShortID: "7K2Q9FM4XD", Cards: []Card{card}, Today: today}).Render(&bytes.Buffer{}, site); err == nil {
		t.Error("a row of an unknown kind was rendered")
	}
}
