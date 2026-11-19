package main

// The visitors' pages, through the server's routes, against the words of
// design/copy/. Every check of the words reads the copy files' code blocks
// (and the table of proof-page.md section 4), puts the test's values in
// place of the examples' and looks for each line, in order, in the text of
// the page, whitespace ignored. A copy file changed without the templates
// fails here.

import (
	"fmt"
	"html"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode"

	"github.com/iamreal-tw/iamreal/verifier"
)

// ---- Reading the copy files -------------------------------------------------

const copyDir = "../design/copy"

func readCopy(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(copyDir, file))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// copySection returns the text of the section of file whose "## " heading
// starts with heading, up to the next "## ".
func copySection(t *testing.T, file, heading string) string {
	t.Helper()
	text := readCopy(t, file)
	start := strings.Index(text, "\n## "+heading)
	if start < 0 {
		t.Fatalf("%s has no section %q", file, heading)
	}
	rest := text[start+1:]
	if end := strings.Index(rest[3:], "\n## "); end >= 0 {
		rest = rest[:end+3]
	}
	return rest
}

// codeBlocks returns the lines of each code block of text.
func codeBlocks(text string) [][]string {
	var out [][]string
	var cur []string
	in := false
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "```") {
			if in {
				out = append(out, cur)
			}
			in, cur = !in, nil
			continue
		}
		if in {
			cur = append(cur, line)
		}
	}
	return out
}

// block returns code block n of a section.
func block(t *testing.T, file, heading string, n int) []string {
	t.Helper()
	b := codeBlocks(copySection(t, file, heading))
	if n >= len(b) {
		t.Fatalf("%s section %q has %d code blocks", file, heading, len(b))
	}
	return b[n]
}

// needs is home.md's 〈需要什麼〉, which proof-page.md section 5a quotes.
func needs(t *testing.T) string {
	t.Helper()
	b := block(t, "home.md", "需要什麼", 0)
	if len(b) != 1 {
		t.Fatalf("home.md 〈需要什麼〉 is %d lines", len(b))
	}
	return b[0]
}

var (
	bracketed = regexp.MustCompile(`\[\s*([^\]]*?)\s*\]`)
	// placeholder is a line that stands for something else: （Threads 的個人
	// 檔案嵌入）, （示意圖）, （縮小的島民證明）, （第 3 部分的兩行）.
	placeholder = regexp.MustCompile(`^（[^）]*）$`)
)

// copyLines makes the lines a page must show from a code block: the
// example values replaced (old, new pairs, in the order given, so put the
// longer of two overlapping values first), placeholders dropped, a
// button's [ ] and a list item's · taken off, 〈需要什麼〉 put in.
func copyLines(t *testing.T, lines []string, replace ...string) []string {
	t.Helper()
	r := strings.NewReplacer(replace...)
	var out []string
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if l == "" || l == "……" || placeholder.MatchString(l) {
			continue
		}
		l = strings.TrimPrefix(l, "· ")
		l = bracketed.ReplaceAllString(l, "$1")
		l = strings.ReplaceAll(l, "〈需要什麼〉", needs(t))
		out = append(out, r.Replace(l))
	}
	return out
}

// squash removes every whitespace character.
func squash(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, s)
}

var tag = regexp.MustCompile(`<[^>]*>`)

// visibleText is the text of the page's body, tags removed and entities
// read.
func visibleText(page string) string {
	if i := strings.Index(page, "<body"); i >= 0 {
		page = page[i:]
	}
	return html.UnescapeString(tag.ReplaceAllString(page, " "))
}

// wantLines checks that every line is on the page, in this order.
func wantLines(t *testing.T, page string, lines []string) {
	t.Helper()
	text := squash(visibleText(page))
	at := 0
	for _, l := range lines {
		i := strings.Index(text[at:], squash(l))
		if i < 0 {
			if strings.Contains(text, squash(l)) {
				t.Errorf("out of order: %q", l)
			} else {
				t.Errorf("not on the page: %q", l)
			}
			continue
		}
		at += i + len(squash(l))
	}
	if t.Failed() {
		t.Logf("the page's text:\n%s", visibleText(page))
	}
}

// notOnPage checks that none of the lines is on the page.
func notOnPage(t *testing.T, page string, lines ...string) {
	t.Helper()
	text := squash(visibleText(page))
	for _, l := range lines {
		if strings.Contains(text, squash(l)) {
			t.Errorf("on the page, but should not be: %q", l)
		}
	}
}

var (
	titleTag  = regexp.MustCompile(`<title>([^<]*)</title>`)
	ogTitle   = regexp.MustCompile(`<meta property="og:title" content="([^"]*)">`)
	ogSite    = regexp.MustCompile(`<meta property="og:site_name" content="([^"]*)">`)
	scriptTag = regexp.MustCompile(`(?i)<\s*script`)
	onAttr    = regexp.MustCompile(`(?i)\son[a-z]+\s*=`)
	styleAttr = regexp.MustCompile(`(?i)\sstyle\s*=|<\s*style`)
	descMeta  = regexp.MustCompile(`(?i)name="description"|og:description|og:image`)
	imageMeta = regexp.MustCompile(`(?i)name="description"|og:image`)
)

// wantPreview checks the page's <title> (title followed by ｜島民) and, if
// preview, its og:title (title) and og:site_name (site); without preview,
// that it has neither.
func wantPreview(t *testing.T, page, title string, preview bool, site string) {
	t.Helper()
	if got := firstMatch(titleTag, page); got != title+"｜島民" {
		t.Errorf("<title> %q, want %q", got, title+"｜島民")
	}
	if !preview {
		if strings.Contains(page, "og:") {
			t.Error("a link preview on the page")
		}
		return
	}
	if got := firstMatch(ogTitle, page); got != title {
		t.Errorf("og:title %q, want %q", got, title)
	}
	if got := firstMatch(ogSite, page); got != site {
		t.Errorf("og:site_name %q, want %q", got, site)
	}
}

// previewOf reads the 標題 and 網站 lines of a copy file's preview block.
func previewOf(t *testing.T, file, heading string) (title, site string) {
	t.Helper()
	b := block(t, file, heading, 0)
	return strings.TrimPrefix(b[0], "標題："), strings.TrimPrefix(b[1], "網站：")
}

func firstMatch(re *regexp.Regexp, s string) string {
	m := re.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return html.UnescapeString(m[1])
}

// ---- Building a roster ---------------------------------------------------------

// rec is one card proof of a test roster: its date, its card and its list
// ("platform:username"; none is the empty list).
type rec struct {
	date     string
	card     string
	accounts []string
}

func r(date, card string, accounts ...string) rec { return rec{date, card, accounts} }

// noon is noon in Taiwan on date.
func noon(t *testing.T, date string) time.Time {
	y, m, d := mustDate(t, date).YMD()
	return tw(y, m, d, 12, 0, 0)
}

// pagesWorld submits recs, in order (their dates must not go back), each
// at noon of its date with a CRL of that date in the mirror, and leaves
// the clock at noon of today.
func pagesWorld(t *testing.T, today string, recs ...rec) *harness {
	t.Helper()
	first := today
	if len(recs) > 0 {
		first = recs[0].date
	}
	h := newHarness(t, noon(t, first))
	var root string
	crls := map[string]bool{}
	for _, x := range recs {
		h.clock.Set(noon(t, x.date))
		if !crls[x.date] {
			y, m, d := mustDate(t, x.date).YMD()
			c := makeCRL(t, "G3", int64(mustDate(t, x.date)), tw(y, m, d, 5, 0, 0), 11, 12)
			h.addCRL(c)
			root, crls[x.date] = rootOf(t, c), true
		}
		if status, body := h.submit(h.sub(x.card, root, x.accounts...)); status != 201 {
			t.Fatalf("%s %s %v: %d %v", x.date, x.card, x.accounts, status, body)
		}
	}
	h.clock.Set(noon(t, today))
	return h
}

// cardStarting returns a new scoped ID that starts with prefix.
func cardStarting(t *testing.T, prefix string) string {
	t.Helper()
	id := prefix + newCard()[len(prefix):]
	if _, err := verifier.ParseScopedID(id); err != nil {
		t.Fatal(err)
	}
	return id
}

// get requests a page, checks what every page of the visitors must be,
// and returns its status and body.
func (h *harness) get(path string) (int, string) {
	h.t.Helper()
	rec := h.raw("GET", path, "")
	body := rec.Body.String()
	if rec.Code == 200 || (rec.Code == 404 && strings.HasPrefix(body, "<!DOCTYPE html>")) {
		checkVisitorPage(h.t, path, rec, h.roster == verifier.Test)
	}
	return rec.Code, body
}

// withScript reports whether the page at path loads the copy buttons'
// script: /verify and /hang/<short ID>, nothing else.
func withScript(path string) bool {
	path, _, _ = strings.Cut(path, "?")
	return path == "/verify" || strings.HasPrefix(path, "/hang/")
}

// The navigation bar (home.md, 導覽列) and the foot (home.md, section 9) of
// every page, as written.
var (
	navHTML = `<header class="top">
<a class="home" href="/"><svg class="logo"`
	navLinks = `<b>島民</b></a>
<nav class="links">
<a href="/verify">怎麼驗證</a>
<a href="/roster">名冊</a>
<a href="/faq">常見問題</a>
<a href="https://github.com/iamreal-tw/iamreal">GitHub</a>
</nav>
<a class="button nav-button" href="/proof">我要換島民證明</a>
</header>`
	footHTML = `<footer class="foot">
<span class="site"><b>島民</b> <span>iamreal.tw</span></span>
<a href="/roster">名冊</a>
<a href="https://github.com/iamreal-tw/iamreal">GitHub</a>
<a href="/proof/help.html?topic=prepare">怎麼準備</a>
<a href="/faq">常見問題</a>
</footer>`
)

var copyScript = regexp.MustCompile(`<script src="/copy\.js" defer></script>`)

// checkVisitorPage checks a page's headers, that it has no script (or, on
// /verify and /hang/<short ID>, the one script and nothing inline), no
// inline style and no description (but the home page's), and its
// navigation bar and foot.
func checkVisitorPage(t *testing.T, path string, rec *httptest.ResponseRecorder, test bool) {
	t.Helper()
	script := withScript(path) && rec.Code == 200
	checkVisitorHeadersOf(t, path, rec, script)
	body := rec.Body.String()
	if rec.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Errorf("%s: Content-Type %q", path, rec.Header().Get("Content-Type"))
	}
	scripts := len(scriptTag.FindAllString(body, -1))
	if script {
		if scripts != 1 || len(copyScript.FindAllString(body, -1)) != 1 {
			t.Errorf("%s: %d scripts; want only /copy.js", path, scripts)
		}
	} else if scripts != 0 {
		t.Errorf("%s: %d scripts on the page", path, scripts)
	}
	checks := []*regexp.Regexp{onAttr, styleAttr, descMeta}
	if strings.SplitN(path, "?", 2)[0] == "/" {
		checks = []*regexp.Regexp{onAttr, styleAttr, imageMeta}
	}
	for _, re := range checks {
		if m := re.FindString(body); m != "" {
			t.Errorf("%s: the page has %q", path, m)
		}
	}
	for _, want := range []string{`<link rel="stylesheet" href="/pages.css">`, navHTML, navLinks, footHTML} {
		if !strings.Contains(body, want) {
			t.Errorf("%s: no %s", path, want)
		}
	}
	if got := strings.Contains(body, `<p class="test-roster">測試名冊</p>`); got != test {
		t.Errorf("%s: says 測試名冊: %v", path, got)
	}
}

// checkVisitorHeaders checks that a response has the visitors' headers,
// and none of the card proof pages'.
func checkVisitorHeaders(t *testing.T, path string, rec *httptest.ResponseRecorder) {
	t.Helper()
	checkVisitorHeadersOf(t, path, rec, false)
}

// checkVisitorHeadersOf is checkVisitorHeaders; with script, the policy
// allows scripts of this origin too.
func checkVisitorHeadersOf(t *testing.T, path string, rec *httptest.ResponseRecorder, script bool) {
	t.Helper()
	csp := "default-src 'none'; style-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	if script {
		csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
	}
	want := map[string]string{
		"Content-Security-Policy":      csp,
		"Referrer-Policy":              "no-referrer",
		"X-Content-Type-Options":       "nosniff",
		"Cross-Origin-Opener-Policy":   "same-origin",
		"Cache-Control":                "no-cache",
		"Cross-Origin-Embedder-Policy": "",
		"Document-Isolation-Policy":    "",
	}
	for k, v := range want {
		if got := rec.Header().Get(k); got != v {
			t.Errorf("%s: %s is %q, want %q", path, k, got, v)
		}
	}
	for k := range rec.Header() {
		if _, ok := want[k]; !ok && k != "Content-Type" && k != "Etag" && k != "Content-Length" && k != "Accept-Ranges" && k != "Last-Modified" {
			t.Errorf("%s: another header %s", path, k)
		}
	}
}

// ---- The page of a card ---------------------------------------------------------

const (
	cardA = "7K2Q9FM4XD" // the short ID of proof-page.md's example
	cardB = "3M8T1RZ6WA" // account-page.md's second card
)

// exampleCards is the roster of the copy files' examples: card A has the
// history of proof-page.md section 4 (now @alice, last card proof
// 2026-11-06, 12 days before 2026-11-18); card B gives its place to
// @alice too, from a later date than A.
func exampleCards(t *testing.T, withB bool) (h *harness, a, b string) {
	a, b = cardStarting(t, cardA), cardStarting(t, cardB)
	recs := []rec{
		r("2026-03-02", a, "threads:bob"),
		r("2026-05-10", a, "threads:bob"),
		r("2026-08-01", a, "threads:alice"),
		r("2026-09-01", b, "threads:alice"),
		r("2026-11-06", a, "threads:alice"),
		r("2026-11-15", b, "threads:alice"),
	}
	if !withB {
		recs = []rec{recs[0], recs[1], recs[2], recs[4]}
	}
	return pagesWorld(t, "2026-11-18", recs...), a, b
}

func TestProofPage(t *testing.T) {
	h, _, _ := exampleCards(t, true)
	status, page := h.get("/p/" + cardA)
	if status != 200 {
		t.Fatalf("%d\n%s", status, page)
	}
	var want []string
	for _, s := range []string{"1. ", "2. ", "3. ", "4. ", "5. ", "5a. "} {
		want = append(want, copyLines(t, block(t, "proof-page.md", s, 0))...)
	}
	wantLines(t, page, want)

	// The links of the page.
	for _, link := range []string{
		`<a href="/proof">我要更新這張證明</a>`,
		`<a href="https://www.threads.com/@alice">Threads 的 @alice</a>`,
		`<a href="/verify">怎麼驗證</a>`,
		`<a class="button" href="/proof">我也要換島民證明</a>`,
	} {
		if !strings.Contains(page, link) {
			t.Errorf("no %s", link)
		}
	}
	// iamreal.tw/p/… is written, not a link; the embed of the profile.
	if !strings.Contains(page, `<p class="backlink">iamreal.tw/p/7K2Q9FM4XD</p>`) {
		t.Error("the link to compare is not as written")
	}
	wantEmbed(t, page, "alice")
	// 全部紀錄 is folded.
	if !regexp.MustCompile(`<details class="history">\s*<summary>全部紀錄</summary>`).MatchString(page) {
		t.Error("全部紀錄 is not in a closed <details>")
	}
	// The preview (section 8).
	title, site := previewOf(t, "proof-page.md", "8. ")
	wantPreview(t, page, title, true, site)
	// The account fits the full size.
	if !strings.Contains(page, `<span class="account">@alice</span>`) {
		t.Error("@alice is not at the full size")
	}
}

// An account longer than 18 characters is written one size smaller.
func TestProofPageLongAccount(t *testing.T) {
	c18, c19 := cardStarting(t, cardA), cardStarting(t, cardB)
	h := pagesWorld(t, "2026-11-18",
		r("2026-11-01", c18, "threads:"+strings.Repeat("a", 18)),
		r("2026-11-01", c19, "threads:"+strings.Repeat("b", 19)),
	)
	_, page := h.get("/p/" + cardA)
	if !strings.Contains(page, `<span class="account">@`+strings.Repeat("a", 18)+`</span>`) {
		t.Error("18 characters are not at the full size")
	}
	_, page = h.get("/p/" + cardB)
	if !strings.Contains(page, `<span class="account long">@`+strings.Repeat("b", 19)+`</span>`) {
		t.Error("19 characters are not one size smaller")
	}
}

// wantEmbed checks the one embed of the page, as it is decided
// (sandbox without allow-scripts, no referrer, credentialless, no
// scrolling="no").
func wantEmbed(t *testing.T, page, username string) {
	t.Helper()
	want := `<iframe class="threads-profile" src="https://www.threads.com/@` + username + `/embed/" title="Threads 個人檔案：@` + username +
		`" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" credentialless></iframe>`
	if n := strings.Count(page, "<iframe"); n != 1 || !strings.Contains(page, want) {
		t.Errorf("%d frames; want one:\n%s", n, want)
	}
}

// specialTitles are the titles of section 8's last item: withdrawn,
// several cards, none.
func specialTitles(t *testing.T) []string {
	t.Helper()
	sec := copySection(t, "proof-page.md", "8. ")
	m := regexp.MustCompile(`標題是「([^」]*)」`).FindAllStringSubmatch(sec, -1)
	if len(m) != 3 {
		t.Fatalf("section 8 has %d special titles", len(m))
	}
	return []string{m[0][1], m[1][1], m[2][1]}
}

// The words of 全部紀錄 (the table of section 4), for every kind of row; a
// declaration after a withdrawal is written as a switch or a correction
// from the account withdrawn.
func TestProofPageHistoryRows(t *testing.T) {
	e := cardStarting(t, "E000000000")
	h := pagesWorld(t, "2026-11-18",
		r("2026-10-01", e, "threads:bob"),
		r("2026-10-02", e, "threads:bob"),
		r("2026-10-03", e, "threads:alice"),
		r("2026-10-03", e, "threads:dave"), // correction
		r("2026-10-04", e),                 // withdrawal
		r("2026-10-05", e, "threads:dave"), // declared again
		r("2026-10-06", e),
		r("2026-10-07", e, "threads:carol.tw"), // another, after a withdrawal: a switch
		r("2026-10-08", e, "threads:erin"),
		r("2026-10-08", e),
		r("2026-10-08", e, "threads:frank"), // another, after a withdrawal, the day of a switch: a correction
	)
	table := map[string]string{}
	for _, line := range strings.Split(copySection(t, "proof-page.md", "4. "), "\n") {
		cells := strings.Split(line, "|")
		if len(cells) == 4 && !strings.HasPrefix(cells[1], "---") && strings.TrimSpace(cells[1]) != "這一筆紀錄" {
			table[strings.TrimSpace(cells[1])] = strings.TrimSpace(cells[2])
		}
	}
	date := regexp.MustCompile(`\d{4}-\d{2}-\d{2}`)
	account := regexp.MustCompile(`@[a-z0-9._]+`)
	row := func(kind, d string, accounts ...string) string {
		words, ok := table[kind]
		if !ok {
			t.Fatalf("proof-page.md section 4 has no row %q", kind)
		}
		words = date.ReplaceAllLiteralString(words, d)
		i := 0
		return account.ReplaceAllStringFunc(words, func(string) string {
			i++
			return "@" + accounts[i-1]
		})
	}
	_, page := h.get("/p/E000000000")
	wantLines(t, page, []string{
		"全部紀錄",
		row("更正", "2026-10-08", "erin", "frank"),
		row("收回", "2026-10-08", "erin"),
		row("更換", "2026-10-08", "carol.tw", "erin"),
		row("收回之後宣告別的帳號", "2026-10-07", "dave", "carol.tw"),
		row("收回", "2026-10-06", "dave"),
		row("收回之後宣告回同一個帳號", "2026-10-05", "dave"),
		row("收回", "2026-10-04", "dave"),
		row("更正", "2026-10-03", "alice", "dave"),
		row("更換", "2026-10-03", "bob", "alice"),
		row("再次過卡", "2026-10-02"),
		row("新宣告", "2026-10-01", "bob"),
	})
	if len(table) != 7 {
		t.Errorf("the table has %d rows; this test writes 7", len(table))
	}
	wantLines(t, page, copyLines(t, block(t, "proof-page.md", "4. ", 0)[:4],
		"2026-03-02", "2026-10-01", "4 次", "11 次", "1 次", "3 次"))
}

func TestProofPageNoSwitch(t *testing.T) {
	c := cardStarting(t, cardA)
	h := pagesWorld(t, "2026-11-18", r("2026-11-01", c, "threads:alice"), r("2026-11-06", c, "threads:alice"))
	_, page := h.get("/p/" + cardA)
	wantLines(t, page, copyLines(t, block(t, "proof-page.md", "4. ", 1)))
	wantLines(t, page, copyLines(t, block(t, "proof-page.md", "2. ", 0)))
}

// A last card proof today is written 今天 (section 2, second block).
func TestProofPageToday(t *testing.T) {
	c := cardStarting(t, cardA)
	h := pagesWorld(t, "2026-11-18", r("2026-11-18", c, "threads:alice"))
	_, page := h.get("/p/" + cardA)
	wantLines(t, page, copyLines(t, block(t, "proof-page.md", "2. ", 1)))
	notOnPage(t, page, "0 天前")
	// The same on the page of the account.
	_, page = h.get("/threads/@alice")
	wantLines(t, page, []string{"上次過卡 今天"})
}

// Withdrawn from every account (section 6): the account is that of the
// latest withdrawal in the history, not of the first.
func TestProofPageWithdrawn(t *testing.T) {
	c := cardStarting(t, cardA)
	h := pagesWorld(t, "2026-11-18",
		r("2026-11-01", c, "threads:alice"),
		r("2026-11-05", c),
		r("2026-11-10", c, "threads:bob"),
		r("2026-11-15", c),
	)
	status, page := h.get("/p/" + cardA)
	if status != 200 {
		t.Fatal(status)
	}
	wantLines(t, page, append(copyLines(t, block(t, "proof-page.md", "6. ", 0), "@alice", "@bob"),
		append(copyLines(t, block(t, "proof-page.md", "4. ", 0)[:4], "2026-03-02", "2026-11-01", "4 次", "4 次"),
			copyLines(t, block(t, "proof-page.md", "5. ", 0))...)...))
	// No section 1's account and scope, no section 3, no small lines of
	// section 2 and no link to update.
	one := block(t, "proof-page.md", "1. ", 0)
	two := block(t, "proof-page.md", "2. ", 0)
	notOnPage(t, page, one[0], one[1], string([]rune(one[5])[:10]), two[1], two[2], "我要更新這張證明",
		block(t, "proof-page.md", "3. ", 0)[0])
	if strings.Contains(page, "<iframe") {
		t.Error("an embed on the page of a withdrawn card")
	}
	wantPreview(t, page, specialTitles(t)[0], true, "島民 iamreal.tw")
}

// A short ID of two cards (section 7): both, sorted by scoped ID, each
// under as many characters as tell them apart; section 5 once, at the end.
func TestProofPageTwoCards(t *testing.T) {
	m1, m2 := cardStarting(t, "7K2Q9FM4XD3A"), cardStarting(t, "7K2Q9FM4XD3B")
	h := pagesWorld(t, "2026-11-18",
		r("2026-11-01", m2, "threads:bob"),
		r("2026-11-06", m1, "threads:alice"),
		r("2026-11-15", m2),
	)
	status, page := h.get("/p/" + cardA)
	if status != 200 {
		t.Fatal(status)
	}
	head := block(t, "proof-page.md", "7. ", 0)
	each := block(t, "proof-page.md", "7. ", 1)
	var want []string
	want = append(want, copyLines(t, head)...)
	want = append(want, copyLines(t, each, "7K2Q9FM4XD3A", "7K2Q9FM4XD3A")...)
	want = append(want, copyLines(t, block(t, "proof-page.md", "1. ", 0))...)
	want = append(want, copyLines(t, each, "7K2Q9FM4XD3A", "7K2Q9FM4XD3B")...)
	want = append(want, copyLines(t, block(t, "proof-page.md", "6. ", 0), "@alice", "@bob")...)
	want = append(want, copyLines(t, block(t, "proof-page.md", "5. ", 0))...)
	want = append(want, copyLines(t, block(t, "proof-page.md", "5a. ", 0))...)
	wantLines(t, page, want)
	five := squash(copyLines(t, block(t, "proof-page.md", "5. ", 0))[0])
	fiveA := squash(copyLines(t, block(t, "proof-page.md", "5a. ", 0))[0])
	if n, m := strings.Count(squash(visibleText(page)), five), strings.Count(squash(visibleText(page)), fiveA); n != 1 || m != 1 {
		t.Errorf("section 5 %d times, 5a %d times", n, m)
	}
	wantPreview(t, page, specialTitles(t)[1], true, "島民 iamreal.tw")
}

// A short ID that resolves to no card, or does not read (section 9): 404.
// A short ID in another spelling is redirected to its one spelling.
func TestProofPageMissing(t *testing.T) {
	h, _, _ := exampleCards(t, false)
	for _, typed := range []string{"7K2Q9FM4XE", "7K2Q9FM4X", "7K2Q9FM4XDD", "7K2Q9FM4XU", "7K2Q-FM4XD", "", "a/b"} {
		status, page := h.get("/p/" + typed)
		if status != 404 {
			t.Errorf("/p/%s: %d", typed, status)
			continue
		}
		wantLines(t, page, copyLines(t, block(t, "proof-page.md", "9. ", 0), "7K2Q9FM4XD", typed))
		if !strings.Contains(page, `<a href="/roster#q">查一個 Threads 帳號</a>`) {
			t.Errorf("/p/%s: no link to the lookup", typed)
		}
		wantPreview(t, page, specialTitles(t)[2], true, "島民 iamreal.tw")
	}
	for typed, to := range map[string]string{
		"7k2q9fm4xd": "/p/7K2Q9FM4XD", "7K2Q9FM4XO": "/p/7K2Q9FM4X0", "lK2Q9FM4XD": "/p/1K2Q9FM4XD",
		"iK2Q9FM4XD": "/p/1K2Q9FM4XD", "7k2q9fm4xd?x=1": "/p/7K2Q9FM4XD",
	} {
		rec := h.raw("GET", "/p/"+typed, "")
		if rec.Code != 301 || rec.Header().Get("Location") != to {
			t.Errorf("/p/%s: %d %q", typed, rec.Code, rec.Header().Get("Location"))
		}
	}
	// The redirect leads to the page.
	if status, _ := h.get("/p/7K2Q9FM4XD"); status != 200 {
		t.Error(status)
	}
}

// ---- The page of an account -------------------------------------------------------

func TestAccountPage(t *testing.T) {
	t.Run("one", func(t *testing.T) {
		h, _, _ := exampleCards(t, false)
		status, page := h.get("/threads/@alice")
		if status != 200 {
			t.Fatal(status)
		}
		wantLines(t, page, copyLines(t, block(t, "account-page.md", "1. ", 0)))
		wantEmbed(t, page, "alice")
		if !strings.Contains(page, `<a href="/p/7K2Q9FM4XD">看這張島民證明</a>`) {
			t.Error("no link to the card")
		}
		title, site := previewOf(t, "account-page.md", "5. ")
		wantPreview(t, page, title, true, site)
	})
	t.Run("two, by the date from which", func(t *testing.T) {
		// Card B's last card proof is the more recent; it is second all
		// the same.
		h, _, _ := exampleCards(t, true)
		_, page := h.get("/threads/@alice")
		wantLines(t, page, copyLines(t, block(t, "account-page.md", "2. ", 0)))
		wantEmbed(t, page, "alice")
	})
	t.Run("last card proof today", func(t *testing.T) {
		c := cardStarting(t, cardA)
		h := pagesWorld(t, "2026-11-18", r("2026-11-18", c, "threads:alice"))
		_, page := h.get("/threads/@alice")
		wantLines(t, page, append([]string{"島民編號 7K2Q9FM4XD 開頭 2026-11-18 起"}, copyLines(t, block(t, "account-page.md", "1. ", 1))...))
		notOnPage(t, page, "0 天前")
	})
	t.Run("none", func(t *testing.T) {
		h, _, _ := exampleCards(t, true)
		for _, name := range []string{"bob", "nobody"} { // bob: once, no longer
			status, page := h.get("/threads/@" + name)
			if status != 200 {
				t.Fatal(status)
			}
			wantLines(t, page, copyLines(t, block(t, "account-page.md", "3. ", 0), "@alice", "@"+name))
			if strings.Contains(page, "<iframe") {
				t.Error("an embed with no card")
			}
		}
	})
	t.Run("several with the same short ID", func(t *testing.T) {
		m1, m2 := cardStarting(t, "7K2Q9FM4XD3A"), cardStarting(t, "7K2Q9FM4XD3B")
		h := pagesWorld(t, "2026-11-18", r("2026-11-01", m2, "threads:alice"), r("2026-11-06", m1, "threads:alice"))
		_, page := h.get("/threads/@alice")
		wantLines(t, page, []string{"島民編號 7K2Q9FM4XD3B 開頭 2026-11-01 起", "島民編號 7K2Q9FM4XD3A 開頭 2026-11-06 起"})
	})
}

func TestAccountPageNames(t *testing.T) {
	h, _, _ := exampleCards(t, false)
	for typed, to := range map[string]string{"Alice": "/threads/@alice", "ALICE": "/threads/@alice", "Carol.TW": "/threads/@carol.tw"} {
		rec := h.raw("GET", "/threads/@"+typed, "")
		if rec.Code != 301 || rec.Header().Get("Location") != to {
			t.Errorf("@%s: %d %q", typed, rec.Code, rec.Header().Get("Location"))
		}
	}
	// Not in the Threads format: 404, the page of section 4, with no embed
	// and no preview; the name is not written back.
	words := copyLines(t, block(t, "account-page.md", "4. ", 0))
	for _, inURL := range []string{"a-b", "", "a%20b", strings.Repeat("a", 31), "%C3%A5lice", "a/b"} {
		status, page := h.get("/threads/@" + inURL)
		if status != 404 {
			t.Errorf("@%s: %d", inURL, status)
		}
		wantLines(t, page, words)
		notOnPage(t, page, copyLines(t, block(t, "account-page.md", "3. ", 0))[1])
		if !strings.Contains(page, `<a href="/roster#q">查一個 Threads 帳號</a>`) || strings.Contains(page, "<iframe") {
			t.Errorf("@%s: no link to the lookup, or an embed", inURL)
		}
		wantPreview(t, page, words[0], false, "")
	}
	if rec := h.raw("GET", "/threads/alice", ""); rec.Code != 404 {
		t.Errorf("without @: %d", rec.Code)
	}
}

// ---- The roster page ---------------------------------------------------------------

func TestRosterPage(t *testing.T) {
	a, b, old, gone := cardStarting(t, cardA), cardStarting(t, cardB), newCard(), newCard()
	h := pagesWorld(t, "2026-11-18",
		r("2026-08-01", old, "threads:carol"), // 109 days before: counted, not in the last three months
		r("2026-11-10", gone, "threads:dave"),
		r("2026-11-12", gone), // withdrawn: neither counted nor listed
		r("2026-11-17", b, "threads:bob"),
		r("2026-11-18", a, "threads:alice"),
	)
	status, page := h.get("/roster")
	if status != 200 {
		t.Fatal(status)
	}
	lines := copyLines(t, codeBlocks(readCopy(t, "roster-page.md"))[0], "1,284", "3", "1,031", "2")
	var noMore []string
	for _, l := range lines {
		if l != "更多" {
			noMore = append(noMore, l)
		}
	}
	wantLines(t, page, noMore)
	wantLines(t, page, []string{"2026-08-01 Threads 的 @carol"})
	notOnPage(t, page, "@dave", "更多")
	for _, want := range []string{
		`<a href="/p/7K2Q9FM4XD"><time>2026-11-18</time>`,
		`<form method="get" action="/roster">`, `<input type="text" id="q" name="q" value=""`,
		`<a href="/roster/">下載整份名冊</a>`, `<a href="/verify">怎麼驗證</a>`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("no %s", want)
		}
	}
	title, site := previewOf(t, "roster-page.md", "連結被貼出去時的預覽")
	wantPreview(t, page, title, true, site)
	if strings.Contains(page, "<iframe") {
		t.Error("an embed on the roster page")
	}
	notOnPage(t, page, block(t, "roster-page.md", "清單", 0)[0])
}

// No card yet: one sentence where the list is, without the sentence above
// the list and without 更多.
func TestRosterPageEmpty(t *testing.T) {
	h := pagesWorld(t, "2026-11-18")
	status, page := h.get("/roster")
	if status != 200 {
		t.Fatal(status)
	}
	all := copyLines(t, codeBlocks(readCopy(t, "roster-page.md"))[0], "1,284", "0", "1,031", "0")
	want := append(append(append([]string{}, all[:5]...), copyLines(t, block(t, "roster-page.md", "清單", 0))...), all[len(all)-1])
	wantLines(t, page, want)
	notOnPage(t, page, all[5], "更多")
	if strings.Contains(page, "<li>") {
		t.Error("a row with no card")
	}
}

// 50 at a time; 更多 is a link to the next ones, the same list from where
// the page stopped.
func TestRosterPageMore(t *testing.T) {
	var recs []rec
	for i := 0; i < 52; i++ {
		recs = append(recs, r(fmt.Sprintf("2026-10-%02d", 1+i/3), newCard(), fmt.Sprintf("threads:a%02d", i)))
	}
	h := pagesWorld(t, "2026-11-18", recs...)
	_, page := h.get("/roster")
	if n := strings.Count(page, "<li><a href=\"/p/"); n != 50 {
		t.Errorf("%d rows", n)
	}
	m := regexp.MustCompile(`<a href="(/roster\?after=[^"]*)">更多</a>`).FindStringSubmatch(page)
	if m == nil {
		t.Fatal("no 更多")
	}
	if !strings.Contains(m[1], "2026-10-01.3") {
		t.Errorf("更多 is %s", m[1])
	}
	_, next := h.get(html.UnescapeString(m[1]))
	if n := strings.Count(next, "<li><a href=\"/p/"); n != 2 {
		t.Errorf("%d rows after", n)
	}
	wantLines(t, next, []string{"Threads 的 @a01", "Threads 的 @a00"})
	notOnPage(t, next, "@a02", "更多")
	// A place that does not read lists from the start.
	_, bad := h.get("/roster?after=nothing")
	if n := strings.Count(bad, "<li><a href=\"/p/"); n != 50 || !strings.Contains(bad, "@a51") {
		t.Errorf("%d rows", n)
	}
}

// The lookup box: a name, with or without @ and in any case, goes to its
// page (303), also with spaces around it; nothing is the roster page as it
// is; anything else shows the roster page with one more line, and what was
// typed in the box.
func TestRosterPageLookup(t *testing.T) {
	h, _, _ := exampleCards(t, false)
	for q, to := range map[string]string{
		"alice": "/threads/@alice", "%40Alice": "/threads/@alice", "@CAROL.tw": "/threads/@carol.tw",
		"%20alice%20": "/threads/@alice", "%20%40Alice%09": "/threads/@alice", "%E3%80%80alice": "/threads/@alice",
	} {
		rec := h.raw("GET", "/roster?q="+q, "")
		if rec.Code != 303 || rec.Header().Get("Location") != to {
			t.Errorf("q=%s: %d %q", q, rec.Code, rec.Header().Get("Location"))
		}
	}
	bad := block(t, "roster-page.md", "查詢", 0)[0]
	for _, q := range []string{"", "%20%20", "%40", "%20%40%20"} {
		status, page := h.get("/roster?q=" + q)
		if status != 200 {
			t.Errorf("q=%s: %d", q, status)
		}
		notOnPage(t, page, bad)
		if !strings.Contains(page, `name="q" value=""`) {
			t.Errorf("q=%s: the box is not empty", q)
		}
	}
	for q, kept := range map[string]string{"a-b": "a-b", "%40%40alice": "@alice", "a%20b": "a b", "%40%C3%A5lice%20": "ålice"} {
		status, page := h.get("/roster?q=" + q)
		if status != 200 {
			t.Errorf("q=%s: %d", q, status)
		}
		wantLines(t, page, []string{"查一個 Threads 帳號", "@查", bad, "最近換出的島民證明"})
		if !strings.Contains(page, `name="q" value="`+kept+`"`) {
			t.Errorf("q=%s: the box does not keep %q", q, kept)
		}
	}
}

// ---- Escaping, methods, headers -----------------------------------------------------

// What a URL carries is written escaped, or refused.
func TestVisitorPagesEscape(t *testing.T) {
	h, _, _ := exampleCards(t, false)
	for _, path := range []string{
		"/p/%3Cb%3Ex%22%27&amp;", "/threads/@%3Cb%3Ex%22%27", "/roster?q=%3Cb%3Ex%22%27",
		"/threads/@javascript:alert(1)", "/p/javascript:alert(1)",
	} {
		_, page := h.get(path)
		if strings.Contains(page, "<b>x") || strings.Contains(page, `x"'`) || strings.Contains(page, `href="javascript`) || strings.Contains(page, `src="javascript`) {
			t.Errorf("%s: not escaped", path)
		}
	}
	_, page := h.get("/roster?q=%3Cb%3Ex%22")
	if !strings.Contains(page, `value="&lt;b&gt;x&#34;"`) {
		t.Error("the lookup box's value is not escaped")
	}
}

func TestVisitorPagesMethods(t *testing.T) {
	h, _, _ := exampleCards(t, false)
	for _, path := range []string{"/p/7K2Q9FM4XD", "/threads/@alice", "/roster", "/pages.css", "/", "/faq", "/verify", "/hang", "/hang/7K2Q9FM4XD", "/copy.js"} {
		// (net/http drops the body of a HEAD response; the recorder keeps
		// it.)
		head := h.raw("HEAD", path, "")
		if head.Code != 200 {
			t.Errorf("HEAD %s: %d", path, head.Code)
		}
		checkVisitorHeadersOf(t, "HEAD "+path, head, withScript(path))
		for _, m := range []string{"POST", "PUT", "DELETE"} {
			rec := h.raw(m, path, "")
			if rec.Code != 405 || rec.Header().Get("Allow") != "GET, HEAD" {
				t.Errorf("%s %s: %d %q", m, path, rec.Code, rec.Header().Get("Allow"))
			}
		}
	}
}

// The style sheet has the pages' headers; the card proof pages keep
// theirs; the roster's files stay under /roster/ beside the page /roster.
func TestVisitorHeadersAndRoutes(t *testing.T) {
	h, _, _ := exampleCards(t, false)
	web := t.TempDir()
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<p>page</p>"), 0o644)
	os.WriteFile(filepath.Join(rosterDir(h.data), "fingerprints.jsonl"), []byte("x\n"), 0o644)
	os.WriteFile(filepath.Join(rosterDir(h.data), "0000000000000000.jsonl"), []byte("y\n"), 0o644)
	h.http = h.server.routes(crlDir(h.data), rosterDir(h.data), web)

	css := h.raw("GET", "/pages.css", "")
	if css.Code != 200 || css.Header().Get("Content-Type") != "text/css; charset=utf-8" || !strings.Contains(css.Body.String(), "--paper: #f4f1ea") {
		t.Errorf("/pages.css: %d %q", css.Code, css.Header().Get("Content-Type"))
	}
	checkVisitorHeaders(t, "/pages.css", css)
	req := httptest.NewRequest("GET", "/pages.css", nil)
	req.Header.Set("If-None-Match", css.Header().Get("ETag"))
	again := httptest.NewRecorder()
	h.http.ServeHTTP(again, req)
	if again.Code != 304 {
		t.Errorf("revalidating the style sheet: %d", again.Code)
	}

	for path, body := range map[string]string{"/roster/fingerprints.jsonl": "x\n", "/roster/0000000000000000.jsonl": "y\n"} {
		rec := h.raw("GET", path, "")
		if rec.Code != 200 || rec.Body.String() != body || rec.Header().Get("Content-Type") != "application/jsonl" {
			t.Errorf("%s: %d %q", path, rec.Code, rec.Body.String())
		}
		for _, k := range []string{"Content-Security-Policy", "Referrer-Policy", "Cache-Control"} {
			if rec.Header().Get(k) != "" {
				t.Errorf("%s: %s is %q", path, k, rec.Header().Get(k))
			}
		}
	}
	if status, _ := h.get("/roster"); status != 200 {
		t.Errorf("/roster: %d", status)
	}
	// The card proof pages: their own headers, none of the visitors'.
	page := h.raw("GET", "/proof", "")
	for k, v := range pageHeaders {
		if page.Header().Get(k) != v {
			t.Errorf("/proof: %s is %q", k, page.Header().Get(k))
		}
	}
	for _, k := range []string{"Referrer-Policy", "Cache-Control"} {
		if page.Header().Get(k) != "" {
			t.Errorf("/proof: %s is %q", k, page.Header().Get(k))
		}
	}
}

// The production roster's pages do not say 測試名冊.
func TestVisitorPagesProductionRoster(t *testing.T) {
	h := newHarness(t, startOfTests, g3CRL(t))
	h.roster = verifier.Production
	h.start()
	for _, path := range []string{"/roster", "/threads/@alice", "/p/7K2Q9FM4XD", "/", "/faq", "/verify", "/hang"} {
		h.get(path) // checkVisitorPage checks there is no 測試名冊
	}
}

// ---- Up to date ----------------------------------------------------------------------

// A record the server writes shows on the next page opened. The counts of
// the roster page may be up to a minute old.
func TestVisitorPagesUpToDate(t *testing.T) {
	c := g3CRL(t)
	root := rootOf(t, c)
	h := newHarness(t, startOfTests, c)
	card := cardStarting(t, cardA)

	_, page := h.get("/threads/@alice")
	wantLines(t, page, []string{"沒有自然人憑證把名額給這個帳號。"})
	_, rosterPage := h.get("/roster")
	wantLines(t, rosterPage, []string{"現在有 0 張島民證明"})
	if status, _ := h.get("/p/" + cardA); status != 404 {
		t.Fatal(status)
	}

	h.mustSubmit(h.sub(card, root, "threads:alice"), "threads first")
	_, page = h.get("/threads/@alice")
	wantLines(t, page, []string{"有 1 張自然人憑證", "島民編號 7K2Q9FM4XD 開頭 2026-11-20 起 上次過卡 今天"})
	if status, page := h.get("/p/" + cardA); status != 200 || !strings.Contains(page, "@alice") {
		t.Fatal(status)
	}
	_, rosterPage = h.get("/roster")
	wantLines(t, rosterPage, []string{"現在有 0 張島民證明", "2026-11-20 Threads 的 @alice"})

	h.clock.Set(startOfTests.Add(countsMaxAge))
	_, rosterPage = h.get("/roster")
	wantLines(t, rosterPage, []string{"現在有 1 張島民證明，其中 1 張在過去三個月內過卡。"})

	h.clock.Set(startOfTests.Add(countsMaxAge + time.Second))
	h.mustSubmit(h.sub(card, root, "threads:bob"), "threads correction")
	_, page = h.get("/p/" + cardA)
	wantLines(t, page, []string{"@bob", "2026-11-20 更正：@alice 改成 @bob"})
	_, page = h.get("/threads/@alice")
	wantLines(t, page, []string{"沒有自然人憑證把名額給這個帳號。"})
}
