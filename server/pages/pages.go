// Package pages makes the pages visitors read, as whole HTML documents
// with no script: the page of a card (/p/<short ID>), the page of an
// account (/threads/@<name>) and the roster page (/roster), and the one
// style sheet they share. Every word on them is from design/copy/
// (proof-page.md, account-page.md, roster-page.md) and is written in the
// templates, not here.
//
// This package only turns data into HTML. The server (server/visitor.go)
// reads the store, reads the URL and writes the response; a test can make
// a page from data it builds itself, with no server.
package pages

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"html/template"
	"io"
	"strconv"

	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

//go:embed templates/*.html
var templateFiles embed.FS

// CSS is the style sheet of the pages, served at CSSPath.
//
//go:embed style.css
var CSS []byte

// CSSPath is the path the server serves CSS at, and the pages link to.
const CSSPath = "/pages.css"

// CSSETag is the entity tag of CSS, for revalidation.
var CSSETag = func() string {
	sum := sha256.Sum256(CSS)
	return `"` + hex.EncodeToString(sum[:8]) + `"`
}()

// Platform is the one platform the pages show: the first version lists
// Threads only (design/copy/proof-page.md). The other platforms of a test
// roster are not shown.
const Platform = "threads"

// Site is what every page says about the server that makes it.
type Site struct {
	// TestRoster is true when the server serves a test roster: every page
	// says so at its top.
	TestRoster bool
}

var templates = func() map[string]*template.Template {
	funcs := template.FuncMap{
		"thousands": thousands,
		// A history row of a kind the page does not know stops the page,
		// rather than leave the row blank.
		"unknownEvent": func(e string) (string, error) { return "", fmt.Errorf("pages: no words for the event %q", e) },
	}
	out := map[string]*template.Template{}
	for _, name := range []string{"proof", "proof-missing", "account", "roster"} {
		out[name] = template.Must(template.New(name).Funcs(funcs).ParseFS(templateFiles,
			"templates/layout.html", "templates/parts.html", "templates/"+name+".html"))
	}
	return out
}()

// document is what the layout of every page reads.
type document struct {
	Site
	Title   string
	OGTitle bool // write og:title and og:site_name (the page of a card)
	CSS     string
	Kind    string // which page: the class of <body>
	Content any
}

func render(w io.Writer, name string, site Site, title string, og bool, content any) error {
	var b bytes.Buffer
	d := document{Site: site, Title: title, OGTitle: og, CSS: CSSPath, Kind: name, Content: content}
	if err := templates[name].ExecuteTemplate(&b, "layout", d); err != nil {
		return err
	}
	_, err := w.Write(b.Bytes())
	return err
}

// Days is how long ago a date was, as the pages write it: "今天" or "12
// 天前", counted in whole days in Taiwan.
type Days struct {
	Today bool
	N     int
}

func daysSince(d, today verifier.Date) Days {
	n := int(today - d)
	// A date after today (the clock stepped back) is written as today.
	return Days{Today: n <= 0, N: n}
}

// thousands writes n with a comma between groups of three digits.
func thousands(n int) string {
	s := strconv.Itoa(n)
	if n < 0 {
		return "-" + thousands(-n)
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// Prefixes returns the beginnings of scoped IDs the pages write for them:
// 10 characters (the short ID), or as many more as it takes for no two of
// them to be the same (GLOSSARY.md, 島民編號).
func Prefixes(ids []string) []string {
	n := verifier.ShortIDLength
	for ; n < verifier.ScopedIDLength; n++ {
		seen := map[string]bool{}
		distinct := true
		for _, id := range ids {
			p := prefix(id, n)
			if seen[p] {
				distinct = false
				break
			}
			seen[p] = true
		}
		if distinct {
			break
		}
	}
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = prefix(id, n)
	}
	return out
}

func prefix(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}

// ---- The page of a card -----------------------------------------------------

// Card is one card of a short ID, as the store has it.
type Card struct {
	Summary store.CardSummary
	History []store.HistoryRecord // newest first, as History returns it
}

// ProofPage is the page of the short ID ShortID (in its one spelling), for
// the cards it resolves to (one or more, sorted by scoped ID).
type ProofPage struct {
	ShortID string
	Cards   []Card
	Today   verifier.Date
}

type proofContent struct {
	ShortID  string
	Multiple bool
	Cards    []cardView
}

type cardView struct {
	// Prefix is the beginning of the scoped ID written above the card when
	// the short ID resolves to more than one card.
	Prefix  string
	Nested  bool // one of several cards: its title is not the page's
	ShortID string
	// Account is the card's account on Threads now; "" if it has none.
	Account string
	// Withdrawn is the account of the latest withdrawal on Threads, for a
	// card with no account now; "" if there is none.
	Withdrawn string
	LastDate  string
	Last      Days
	First     string
	Proofs    int
	Switches  int
	Rows      []historyRow
}

type historyRow struct {
	Date   string
	Event  string // store.Event*
	Before string
	After  string
}

// Title is the page's <title> and og:title (proof-page.md, section 8).
func (p ProofPage) Title() string {
	switch {
	case len(p.Cards) > 1:
		return fmt.Sprintf("這個網址對到 %d 張自然人憑證", len(p.Cards))
	case len(p.Cards) == 1:
		if a := currentOn(p.Cards[0].Summary); a != "" {
			return "一張自然人憑證把 Threads 的名額給了 @" + a
		}
		return "這張自然人憑證現在沒有把名額給任何帳號"
	}
	return "找不到這張島民證明"
}

func currentOn(s store.CardSummary) string {
	for _, slot := range s.Slots {
		if slot.Platform == Platform {
			return slot.Current
		}
	}
	return ""
}

func switchesOn(s store.CardSummary) int {
	for _, slot := range s.Slots {
		if slot.Platform == Platform {
			return slot.SwitchCount
		}
	}
	return 0
}

// Render writes the page of a card. p.Cards must not be empty: a short ID
// that resolves to no card has the page of RenderProofMissing.
func (p ProofPage) Render(w io.Writer, site Site) error {
	if len(p.Cards) == 0 {
		return fmt.Errorf("pages: no card for %s", p.ShortID)
	}
	ids := make([]string, len(p.Cards))
	for i, c := range p.Cards {
		ids[i] = c.Summary.ScopedID
	}
	prefixes := Prefixes(ids)
	content := proofContent{ShortID: p.ShortID, Multiple: len(p.Cards) > 1}
	for i, c := range p.Cards {
		v := cardView{
			Prefix: prefixes[i], Nested: len(p.Cards) > 1, ShortID: p.ShortID,
			Account:  currentOn(c.Summary),
			LastDate: c.Summary.LastCardProof.String(), Last: daysSince(c.Summary.LastCardProof, p.Today),
			First: c.Summary.FirstCardProof.String(), Proofs: c.Summary.CardProofs, Switches: switchesOn(c.Summary),
		}
		if v.Account != "" && !ValidUsername(v.Account) {
			return fmt.Errorf("pages: card %s has an account not in the Threads format", c.Summary.ScopedID)
		}
		for _, r := range c.History {
			for _, ch := range r.Changes {
				if ch.Platform != Platform {
					continue
				}
				e := ch.Event()
				v.Rows = append(v.Rows, historyRow{Date: r.Date.String(), Event: e, Before: ch.Before, After: ch.After})
				if v.Account == "" && v.Withdrawn == "" && e == store.EventWithdraw {
					v.Withdrawn = ch.Before
				}
			}
		}
		content.Cards = append(content.Cards, v)
	}
	return render(w, "proof", site, p.Title(), true, content)
}

// ProofMissing is the page of a short ID that resolves to no card
// (proof-page.md, section 9). Typed is what the visitor typed after /p/,
// written back on the page as it is (escaped).
type ProofMissing struct {
	Typed string
}

// Render writes the page.
func (p ProofMissing) Render(w io.Writer, site Site) error {
	return render(w, "proof-missing", site, "找不到這張島民證明", true, p)
}

// ---- The page of an account -------------------------------------------------

// AccountPage is the page of the Threads account Username: the cards that
// give their place on Threads to it, as AccountCards returns them.
type AccountPage struct {
	Username string
	Cards    []store.AccountCard
	Today    verifier.Date
}

type accountContent struct {
	Username string
	Rows     []accountRow
}

type accountRow struct {
	Prefix  string
	ShortID string
	Since   string
	Last    Days
}

// Title is the page's <title>.
func (p AccountPage) Title() string { return "Threads 的 @" + p.Username + "｜島民" }

// Render writes the page. Username must be in the Threads format.
func (p AccountPage) Render(w io.Writer, site Site) error {
	if !ValidUsername(p.Username) {
		return fmt.Errorf("pages: %q is not in the Threads format", p.Username)
	}
	return render(w, "account", site, p.Title(), false, p.content())
}

// RenderUnknownFormat writes the page of a name that is not in the Threads
// format: the page of an account with no card, which has no embed.
func (p AccountPage) RenderUnknownFormat(w io.Writer, site Site) error {
	return render(w, "account", site, p.Title(), false, accountContent{Username: p.Username})
}

func (p AccountPage) content() accountContent {
	ids := make([]string, len(p.Cards))
	for i, c := range p.Cards {
		ids[i] = c.ScopedID
	}
	prefixes := Prefixes(ids)
	out := accountContent{Username: p.Username}
	for i, c := range p.Cards {
		out.Rows = append(out.Rows, accountRow{
			Prefix: prefixes[i], ShortID: verifier.ShortID(c.ScopedID),
			Since: c.Since.String(), Last: daysSince(c.LastCardProof, p.Today),
		})
	}
	return out
}

// ---- The roster page ---------------------------------------------------------

// PageSize is how many slots the roster page lists at a time
// (roster-page.md).
const PageSize = 50

// RosterPage is the roster page.
type RosterPage struct {
	Declared, Recent int // Counts
	// Slots are the slots listed, as Recent returns them: at most
	// PageSize.
	Slots []store.RecentSlot
	// More is true if there are slots after the last one listed.
	More bool
	// Query is what the visitor typed in the lookup box, for a lookup that
	// is not in the Threads format (BadQuery); "" otherwise.
	Query    string
	BadQuery bool
}

type rosterContent struct {
	Declared, Recent int
	Rows             []rosterRow
	More             string // the value of ?after= for the next ones; "" if none
	Query            string
	BadQuery         bool
}

type rosterRow struct {
	Since    string
	Username string
	ShortID  string
}

// Render writes the page.
func (p RosterPage) Render(w io.Writer, site Site) error {
	c := rosterContent{Declared: p.Declared, Recent: p.Recent, Query: p.Query, BadQuery: p.BadQuery}
	for _, s := range p.Slots {
		c.Rows = append(c.Rows, rosterRow{Since: s.Since.String(), Username: s.Username, ShortID: verifier.ShortID(s.ScopedID)})
	}
	if p.More && len(p.Slots) > 0 {
		c.More = FormatPosition(p.Slots[len(p.Slots)-1].Position())
	}
	return render(w, "roster", site, "名冊｜島民", false, c)
}

// FormatPosition writes a place in the list of the latest slots as the
// roster page's ?after= carries it: the date and the seq, "2026-11-17.123".
func FormatPosition(p store.RecentPosition) string {
	return p.Since.String() + "." + strconv.FormatUint(p.SinceSeq, 10)
}

// ParsePosition reads what FormatPosition writes.
func ParsePosition(s string) (store.RecentPosition, bool) {
	if len(s) < 12 || s[10] != '.' {
		return store.RecentPosition{}, false
	}
	d, err := verifier.ParseDate(s[:10])
	if err != nil {
		return store.RecentPosition{}, false
	}
	seq, err := strconv.ParseUint(s[11:], 10, 64)
	if err != nil || seq == 0 || strconv.FormatUint(seq, 10) != s[11:] {
		return store.RecentPosition{}, false
	}
	return store.RecentPosition{Since: d, SinceSeq: seq}, true
}

// ---- Threads usernames -------------------------------------------------------

// ValidUsername reports whether u is a Threads username in its one
// spelling: lowercase, in the format of the platform table (spec/scope.md),
// which is the same in both rosters.
func ValidUsername(u string) bool {
	p, ok := verifier.LookupPlatform(verifier.Production, Platform)
	return ok && p.ValidUsername(u)
}

// LowerASCII returns s with A to Z made lowercase, and nothing else
// changed: Threads names are ASCII, and other letters stay as they are so
// that they fail the format check.
func LowerASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	return string(b)
}
