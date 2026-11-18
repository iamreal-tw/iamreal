package main

// The home page, the FAQ, how to verify and hanging a proof on a profile,
// through the server's routes, against the words of design/copy/ (home.md,
// faq.md, verify.md, hang.md), read the way visitor_test.go reads them;
// and the card proof page moved to /proof.

import (
	"encoding/json"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/server/pages"
)

// ---- Reading faq.md -----------------------------------------------------------

// faqQuestion is one question of faq.md: its category (## heading), the
// question (### heading), its answer (the code block) and its id.
type faqQuestion struct {
	category, question, id string
	answer                 []string
}

var faqID = regexp.MustCompile("這一題在頁面上的 `id`：`([a-z0-9-]+)`")

// faqQuestions reads every question of faq.md, in order.
func faqQuestions(t *testing.T) []faqQuestion {
	t.Helper()
	var out []faqQuestion
	category := ""
	for _, part := range strings.Split(readCopy(t, "faq.md"), "\n## ")[1:] {
		heading, rest, _ := strings.Cut(part, "\n")
		category = heading
		for _, q := range strings.Split(rest, "\n### ")[1:] {
			question, body, _ := strings.Cut(q, "\n")
			blocks := codeBlocks(body)
			m := faqID.FindAllStringSubmatch(body, -1)
			if len(blocks) != 1 || len(m) != 1 {
				t.Fatalf("faq.md %q: %d answers, %d ids", question, len(blocks), len(m))
			}
			out = append(out, faqQuestion{category: category, question: question, id: m[0][1], answer: blocks[0]})
		}
	}
	if len(out) == 0 {
		t.Fatal("faq.md has no question")
	}
	return out
}

func faqByQuestion(t *testing.T, question string) faqQuestion {
	t.Helper()
	for _, q := range faqQuestions(t) {
		if q.question == question {
			return q
		}
	}
	t.Fatalf("faq.md has no question %q", question)
	return faqQuestion{}
}

// previewLines reads a copy file's preview block: 標題, 網站 and, if there is
// one, 摘要.
func previewLines(t *testing.T, file string) (title, site, summary string) {
	t.Helper()
	b := block(t, file, "連結被貼出去時的預覽", 0)
	title, site = strings.TrimPrefix(b[0], "標題："), strings.TrimPrefix(b[1], "網站：")
	if len(b) > 2 {
		summary = strings.TrimPrefix(b[2], "摘要：")
	}
	return title, site, summary
}

var ogDescription = regexp.MustCompile(`<meta property="og:description" content="([^"]*)">`)

// ---- The home page -------------------------------------------------------------

// The roster of TestRosterPage: three cards with an account on Threads, two
// of them in the last three months, one withdrawn.
func homeWorld(t *testing.T) *harness {
	a, b, old, gone := cardStarting(t, cardA), cardStarting(t, cardB), newCard(), newCard()
	return pagesWorld(t, "2026-11-18",
		r("2026-08-01", old, "threads:carol"),
		r("2026-11-10", gone, "threads:dave"),
		r("2026-11-12", gone),
		r("2026-11-17", b, "threads:bob"),
		r("2026-11-18", a, "threads:alice"),
	)
}

func TestHomePage(t *testing.T) {
	h := homeWorld(t)
	status, page := h.get("/")
	if status != 200 {
		t.Fatalf("%d\n%s", status, page)
	}
	var want []string
	want = append(want, copyLines(t, block(t, "home.md", "導覽列", 0))...)
	want = append(want, copyLines(t, block(t, "home.md", "1. ", 0))...)
	want = append(want, copyLines(t, block(t, "home.md", "1. ", 1))...)
	want = append(want, copyLines(t, block(t, "home.md", "2. ", 0), "1,284", "3", "1,031", "2")...)
	want = append(want, copyLines(t, block(t, "home.md", "3. ", 0))...)
	want = append(want, copyLines(t, block(t, "home.md", "4. ", 0))...)
	want = append(want, copyLines(t, block(t, "home.md", "5. ", 0))...)
	want = append(want, copyLines(t, block(t, "home.md", "5. ", 1))...)
	// Section 6: each question with its answer from faq.md under it.
	six := copyLines(t, block(t, "home.md", "6. ", 0))
	if len(six) != 9 || six[0] != "常見問題" || six[8] != "更多常見問題" {
		t.Fatalf("home.md section 6 is %q", six)
	}
	want = append(want, six[0])
	for _, q := range six[1:8] {
		want = append(want, q)
		want = append(want, copyLines(t, faqByQuestion(t, q).answer)...)
	}
	want = append(want, six[8])
	want = append(want, copyLines(t, block(t, "home.md", "7. ", 0))...)
	want = append(want, copyLines(t, block(t, "home.md", "8. ", 0))...)
	want = append(want, copyLines(t, block(t, "home.md", "9. ", 0))...)
	wantLines(t, page, want)

	for _, link := range []string{
		`<a href="/roster">看已經換出的島民證明</a>`,
		`<a href="/hang">掛到 Threads 的個人檔案上</a>`,
		`<a href="/verify">零知識證明</a>`,
		`<a href="/faq">更多常見問題</a>`,
	} {
		if !strings.Contains(page, link) {
			t.Errorf("no %s", link)
		}
	}
	// The one main action, in section 1 and section 8.
	if n := strings.Count(page, `<a class="button big" href="/proof">我要換島民證明</a>`); n != 2 {
		t.Errorf("the button %d times", n)
	}
	// The seven questions fold, each its own <details>.
	for _, q := range six[1:8] {
		if !strings.Contains(page, "<details><summary>"+q+"</summary>") {
			t.Errorf("%q is not a <details>", q)
		}
	}
	if n := strings.Count(page, "<details>"); n != 7 {
		t.Errorf("%d <details>", n)
	}
	// The small proof is not a link yet.
	mini := regexp.MustCompile(`(?s)<div class="mini-proof">.*?</div>`).FindString(page)
	if mini == "" || strings.Contains(mini, "<a ") {
		t.Errorf("the small proof: %q", mini)
	}
	// The preview, the <title> and the summary.
	title, site, summary := previewLines(t, "home.md")
	if got := firstMatch(titleTag, page); got != "島民｜iamreal.tw" {
		t.Errorf("<title> %q", got)
	}
	if !strings.Contains(copySection(t, "home.md", "連結被貼出去時的預覽"), "`島民｜iamreal.tw`") {
		t.Error("home.md does not give the <title>")
	}
	if firstMatch(ogTitle, page) != title || firstMatch(ogSite, page) != site || firstMatch(ogDescription, page) != summary {
		t.Errorf("preview %q %q %q", firstMatch(ogTitle, page), firstMatch(ogSite, page), firstMatch(ogDescription, page))
	}
	first := copyLines(t, block(t, "home.md", "1. ", 0))
	if summary != first[1]+first[2] {
		t.Errorf("the summary is not the first screen's two lines: %q", summary)
	}
}

// 〈需要什麼〉 is the same sentence in its three places: the home page's
// sections 1 and 8, and section 5a of the page of a card.
func TestNeedsEverywhere(t *testing.T) {
	h, _, _ := exampleCards(t, false)
	n := squash(needs(t))
	_, home := h.get("/")
	if c := strings.Count(squash(visibleText(home)), n); c != 2 {
		t.Errorf("the home page says it %d times", c)
	}
	_, card := h.get("/p/" + cardA)
	if c := strings.Count(squash(visibleText(card)), n); c != 1 {
		t.Errorf("the page of a card says it %d times", c)
	}
	eight := copyLines(t, block(t, "home.md", "8. ", 0))
	wantLines(t, home, []string{copyLines(t, block(t, "home.md", "1. ", 0))[3], needs(t), eight[len(eight)-1]})
	if !strings.HasPrefix(eight[len(eight)-1], needs(t)) {
		t.Error("section 8 does not start its last line with 〈需要什麼〉")
	}
}

// The home page's counts are the roster page's: they follow the roster,
// at most countsMaxAge late, and the two pages share them.
func TestHomePageCounts(t *testing.T) {
	c := g3CRL(t)
	root := rootOf(t, c)
	h := newHarness(t, startOfTests, c)
	_, page := h.get("/")
	wantLines(t, page, []string{"現在有 0 張島民證明", "其中 0 張在過去三個月內過卡"})

	h.mustSubmit(h.sub(cardStarting(t, cardA), root, "threads:alice"), "threads first")
	_, page = h.get("/")
	wantLines(t, page, []string{"現在有 0 張島民證明"})
	h.clock.Set(startOfTests.Add(countsMaxAge - time.Second))
	_, page = h.get("/")
	wantLines(t, page, []string{"現在有 0 張島民證明"})

	h.clock.Set(startOfTests.Add(countsMaxAge))
	_, page = h.get("/")
	wantLines(t, page, []string{"現在有 1 張島民證明", "其中 1 張在過去三個月內過卡"})
	// The roster page reads the same counts, computed once.
	h.mustSubmit(h.sub(cardStarting(t, cardB), root, "threads:bob"), "threads first")
	_, roster := h.get("/roster")
	wantLines(t, roster, []string{"現在有 1 張島民證明，其中 1 張在過去三個月內過卡。"})
	h.clock.Set(startOfTests.Add(2 * countsMaxAge))
	_, roster = h.get("/roster")
	wantLines(t, roster, []string{"現在有 2 張島民證明"})
	_, page = h.get("/")
	wantLines(t, page, []string{"現在有 2 張島民證明", "其中 2 張在過去三個月內過卡"})
}

// ---- The FAQ ---------------------------------------------------------------------

func TestFAQPage(t *testing.T) {
	h := pagesWorld(t, "2026-11-18")
	status, page := h.get("/faq")
	if status != 200 {
		t.Fatal(status)
	}
	questions := faqQuestions(t)
	want := copyLines(t, codeBlocks(readCopy(t, "faq.md"))[0])
	category := ""
	for _, q := range questions {
		if q.category != category {
			category = q.category
			want = append(want, category)
		}
		want = append(want, q.question)
		want = append(want, copyLines(t, q.answer)...)
	}
	// Nothing after the last answer but the foot.
	last := want[len(want)-1]
	want = append(want, copyLines(t, block(t, "home.md", "9. ", 0))...)
	wantLines(t, page, want)
	text := squash(visibleText(page))
	if !strings.HasSuffix(text, squash(last)+squash(want[len(want)-1])) {
		t.Errorf("something between the last answer and the foot:\n%s", visibleText(page))
	}
	if len(questions) != 22 {
		t.Errorf("%d questions; the page writes 22", len(questions))
	}

	// Each question a heading with its id, its answer shown: no <details>.
	if strings.Contains(page, "<details") {
		t.Error("an answer is folded")
	}
	ids := map[string]bool{}
	for _, m := range regexp.MustCompile(`\sid="([^"]*)"`).FindAllStringSubmatch(page, -1) {
		if ids[m[1]] {
			t.Errorf("the id %q twice", m[1])
		}
		ids[m[1]] = true
	}
	for _, q := range questions {
		if !strings.Contains(page, `<section class="question" id="`+q.id+`"><h3>`+q.question+`</h3>`) {
			t.Errorf("%q is not a heading with the id %q", q.question, q.id)
		}
	}
	// Every link to a question that a copy file writes goes to one.
	files, err := filepath.Glob(filepath.Join(copyDir, "*.md"))
	if err != nil || len(files) == 0 {
		t.Fatal(err)
	}
	for _, f := range files {
		b, _ := os.ReadFile(f)
		for _, m := range regexp.MustCompile("/faq#([A-Za-z0-9_-]+)").FindAllStringSubmatch(string(b), -1) {
			if !ids[m[1]] {
				t.Errorf("%s links to /faq#%s, which is not on the page", filepath.Base(f), m[1])
			}
		}
	}

	// The links of the answers.
	security := faqByQuestion(t, "這個技術安全嗎？")
	for _, link := range []string{
		`<a href="/faq#` + security.id + `">了解更多</a>`,
		`<a href="https://github.com/iamreal-tw/iamreal/blob/main/docs/adr/0004-scoped-ids-and-proofs-are-public.md">完整的說明</a>`,
		`<a href="https://github.com/iamreal-tw/iamreal">GitHub</a> 討論`,
		`<strong>注意：</strong>`,
	} {
		if !strings.Contains(page, link) {
			t.Errorf("no %s", link)
		}
	}
	if _, err := os.Stat("../docs/adr/0004-scoped-ids-and-proofs-are-public.md"); err != nil {
		t.Error(err)
	}
	if !strings.Contains(faqByQuestion(t, "政府會知道我是哪個帳號嗎？").answer[2], "了解更多") ||
		!strings.Contains(readCopy(t, "faq.md"), "「了解更多」連到下一題「這個技術安全嗎？」") {
		t.Error("faq.md no longer says where 了解更多 goes")
	}

	title, site, summary := previewLines(t, "faq.md")
	wantPreview(t, page, title, true, site)
	if summary != "" || ogDescription.MatchString(page) {
		t.Error("a summary")
	}
}

// The home page's seven answers are the FAQ's, the same HTML.
func TestHomeAnswersAreTheFAQs(t *testing.T) {
	h := pagesWorld(t, "2026-11-18")
	_, home := h.get("/")
	_, faq := h.get("/faq")
	folded := regexp.MustCompile(`(?s)<details><summary>([^<]*)</summary>\n(.*?)</details>`).FindAllStringSubmatch(home, -1)
	if len(folded) != 7 {
		t.Fatalf("%d questions on the home page", len(folded))
	}
	for _, m := range folded {
		q := faqByQuestion(t, m[1])
		shown := regexp.MustCompile(`(?s)<section class="question" id="` + q.id + `"><h3>[^<]*</h3>\n(.*?)</section>`).FindStringSubmatch(faq)
		if shown == nil || shown[1] != m[2] {
			t.Errorf("%q: the home page's answer is not the FAQ's", m[1])
		}
	}
}

// ---- How to verify ----------------------------------------------------------------

func TestVerifyPage(t *testing.T) {
	h := pagesWorld(t, "2026-11-18")
	status, page := h.get("/verify")
	if status != 200 {
		t.Fatal(status)
	}
	var want []string
	for _, s := range []string{"1. ", "2. "} {
		want = append(want, copyLines(t, block(t, "verify.md", s, 0))...)
	}
	want = append(want, copyLines(t, block(t, "verify.md", "3. ", 0))...)
	want = append(want, copyLines(t, block(t, "verify.md", "3. ", 1))...)
	want = append(want, copyLines(t, block(t, "verify.md", "4. ", 0))...)
	wantLines(t, page, want)

	// The prompt, exactly, one character changed is another prompt.
	prompt := regexp.MustCompile(`(?s)<pre class="prompt" id="prompt">(.*?)</pre>`).FindStringSubmatch(page)
	if prompt == nil || html.UnescapeString(prompt[1]) != strings.Join(block(t, "verify.md", "3. ", 1), "\n") {
		t.Errorf("the prompt is not verify.md's: %q", prompt)
	}
	// Its copy button, shown by the script; 已複製 as card-proof.json writes it.
	if !strings.Contains(page, `<button type="button" class="copy" data-copy="prompt" data-copied="`+copiedWord(t)+`" hidden>`) {
		t.Error("no copy button for the prompt")
	}
	link := `<a href="https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md">cmd/iamreal-verify</a>`
	if !strings.Contains(page, link) {
		t.Errorf("no %s", link)
	}
	if _, err := os.Stat("../cmd/iamreal-verify/README.md"); err != nil {
		t.Error(err)
	}
	title, site, _ := previewLines(t, "verify.md")
	wantPreview(t, page, title, true, site)
}

// copiedWord is what a copy button reads once it has copied: card-proof.json's.
func copiedWord(t *testing.T) string {
	t.Helper()
	var c struct {
		Done struct {
			Copied string `json:"copied"`
		} `json:"done"`
	}
	b, err := os.ReadFile(filepath.Join(copyDir, "card-proof.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	if c.Done.Copied != "已複製" {
		t.Fatalf("card-proof.json's copied is %q", c.Done.Copied)
	}
	return c.Done.Copied
}

// ---- Hanging a proof on a profile ---------------------------------------------------

func TestHangPage(t *testing.T) {
	c := cardStarting(t, cardA)
	h := pagesWorld(t, "2026-11-18", r("2026-11-06", c, "threads:carol.tw"))
	status, page := h.get("/hang/" + cardA)
	if status != 200 {
		t.Fatalf("%d\n%s", status, page)
	}
	two := block(t, "hang.md", "2. ", 0)
	three := block(t, "hang.md", "3. ", 0)
	wantLines(t, page, append(copyLines(t, two, "@alice", "@carol.tw"), copyLines(t, three)...))
	for _, want := range []string{
		`<p class="backlink" id="link">https://iamreal.tw/p/7K2Q9FM4XD</p>`,
		`<button type="button" class="copy button" data-copy="link" data-copied="` + copiedWord(t) + `" hidden>複製連結</button>`,
		`<a class="button quiet" href="https://www.threads.com/@carol.tw" target="_blank" rel="noopener noreferrer">打開 Threads</a>`,
		`<a href="/p/7K2Q9FM4XD">打開你的島民證明</a>`,
		`<span class="account">@carol.tw</span>`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("no %s", want)
		}
	}
	notOnPage(t, page, "還沒有島民證明？")
	title, site, _ := previewLines(t, "hang.md")
	wantPreview(t, page, title, true, site)
}

// Without a proof: the page from the home page, with no script.
func TestHangPageWithout(t *testing.T) {
	h := pagesWorld(t, "2026-11-18")
	status, page := h.get("/hang")
	if status != 200 {
		t.Fatal(status)
	}
	wantLines(t, page, copyLines(t, block(t, "hang.md", "2. ", 1)))
	for _, want := range []string{
		`<a class="button quiet" href="https://www.threads.com/" target="_blank" rel="noopener noreferrer">打開 Threads</a>`,
		`<a class="button" href="/proof">我要換島民證明</a>`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("no %s", want)
		}
	}
	// No 複製連結, not the two lines of part 3.
	notOnPage(t, page, append([]string{"複製連結", "剛才複製的連結"}, copyLines(t, block(t, "hang.md", "3. ", 0))...)...)
	if strings.Contains(page, "<button") {
		t.Error("a button")
	}
	title, site, _ := previewLines(t, "hang.md")
	wantPreview(t, page, title, true, site)
}

// /hang/<short ID> shows the page for one card with an account on Threads
// only; a short ID is read as /p/ reads it.
func TestHangPageCases(t *testing.T) {
	one, m1, m2, gone := cardStarting(t, cardA), cardStarting(t, "M4T8XR6PZ13A"), cardStarting(t, "M4T8XR6PZ13B"), cardStarting(t, cardB)
	h := pagesWorld(t, "2026-11-18",
		r("2026-11-01", one, "threads:alice"),
		r("2026-11-01", m1, "threads:bob"),
		r("2026-11-01", m2, "threads:carol"),
		r("2026-11-02", gone, "threads:dave"),
		r("2026-11-03", gone),
	)
	if status, _ := h.get("/hang/" + cardA); status != 200 {
		t.Errorf("one card: %d", status)
	}
	for typed, why := range map[string]string{
		"2HD5WN0J8C": "no card", "M4T8XR6PZ1": "two cards", cardB: "withdrawn",
		"7K2Q9FM4X": "too short", "7K2Q9FM4XDD": "too long", "7K2Q-FM4XD": "not a short ID", "": "nothing", "a/b": "a slash",
		"%3Cb%3Ex%22": "markup",
	} {
		rec := h.raw("GET", "/hang/"+typed, "")
		if rec.Code != 302 || rec.Header().Get("Location") != "/hang" {
			t.Errorf("%s (%s): %d %q", typed, why, rec.Code, rec.Header().Get("Location"))
		}
		if strings.Contains(rec.Body.String(), "<b>x") {
			t.Errorf("%s: not escaped", typed)
		}
	}
	for typed, to := range map[string]string{"7k2q9fm4xd": "/hang/7K2Q9FM4XD", "7K2Q9FM4XO": "/hang/7K2Q9FM4X0", "lK2Q9FM4XD": "/hang/1K2Q9FM4XD"} {
		rec := h.raw("GET", "/hang/"+typed, "")
		if rec.Code != 301 || rec.Header().Get("Location") != to {
			t.Errorf("%s: %d %q", typed, rec.Code, rec.Header().Get("Location"))
		}
	}
}

// ---- The script ---------------------------------------------------------------------

// /copy.js: the visitors' headers, an ETag, and nothing that reaches
// another site.
func TestCopyScript(t *testing.T) {
	h := pagesWorld(t, "2026-11-18")
	rec := h.raw("GET", "/copy.js", "")
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "text/javascript; charset=utf-8" || rec.Body.String() != string(pages.CopyJS) {
		t.Fatalf("/copy.js: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	checkVisitorHeaders(t, "/copy.js", rec)
	again := h.raw("GET", "/copy.js", "")
	if again.Header().Get("ETag") != pages.CopyJSETag {
		t.Error("no ETag")
	}
	for _, s := range []string{"http", "fetch", "XMLHttpRequest", "sendBeacon", "import", "eval", "innerHTML", "location"} {
		if strings.Contains(string(pages.CopyJS), s) {
			t.Errorf("copy.js has %q", s)
		}
	}
}

// ---- The card proof page at /proof -------------------------------------------------

// The card proof page and its files are under /proof, with the headers
// the card proof page has always had (pageHeaders and responseHeaders,
// nothing else); / is the home page, and the old paths are not the card
// proof page any more.
func TestProofMoved(t *testing.T) {
	h, _, _ := exampleCards(t, false)
	web := t.TempDir()
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<p>card proof</p>"), 0o644)
	os.WriteFile(filepath.Join(web, "help.html"), []byte("<p>help</p>"), 0o644)
	os.Mkdir(filepath.Join(web, "assets"), 0o755)
	os.WriteFile(filepath.Join(web, "assets", "a.js"), []byte("1"), 0o644)
	h.http = h.server.routes(crlDir(h.data), rosterDir(h.data), web)

	content := map[string]bool{"Content-Type": true, "Content-Length": true, "Last-Modified": true, "Accept-Ranges": true}
	for path, body := range map[string]string{"/proof": "<p>card proof</p>", "/proof?x=1": "<p>card proof</p>", "/proof/help.html": "<p>help</p>", "/proof/assets/a.js": "1"} {
		rec := h.raw("GET", path, "")
		if rec.Code != 200 || rec.Body.String() != body {
			t.Errorf("%s: %d %q", path, rec.Code, rec.Body.String())
		}
		want := map[string]string{"X-Content-Type-Options": "nosniff"}
		for k, v := range pageHeaders {
			want[k] = v
		}
		for k, v := range want {
			if rec.Header().Get(k) != v {
				t.Errorf("%s: %s is %q", path, k, rec.Header().Get(k))
			}
		}
		for k := range rec.Header() {
			if _, ok := want[k]; !ok && !content[k] {
				t.Errorf("%s: another header %s: %q", path, k, rec.Header().Get(k))
			}
		}
	}
	if rec := h.raw("GET", "/proof", ""); rec.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Errorf("/proof: %q", rec.Header().Get("Content-Type"))
	}
	// One address for the page.
	if rec := h.raw("GET", "/proof/", ""); rec.Code != 301 || rec.Header().Get("Location") != "/proof" {
		t.Errorf("/proof/: %d %q", rec.Code, rec.Header().Get("Location"))
	}
	if rec := h.raw("GET", "/proof/index.html", ""); rec.Code == 200 {
		t.Errorf("/proof/index.html: %d", rec.Code)
	}
	if rec := h.raw("POST", "/proof", ""); rec.Code != 405 {
		t.Errorf("POST /proof: %d", rec.Code)
	}
	for _, path := range []string{"/proof/assets/", "/proof/nothing", "/proof/.x"} {
		if rec := h.raw("GET", path, ""); rec.Code != 404 {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
	// / is the home page; the old paths of the web directory are not found,
	// and have none of the card proof page's headers.
	if status, page := h.get("/"); status != 200 || !strings.Contains(page, `<body class="home">`) {
		t.Errorf("/: %d", status)
	}
	for _, path := range []string{"/index.html", "/help.html", "/assets/a.js", "/proofx", "/nothing"} {
		rec := h.raw("GET", path, "")
		if rec.Code != 404 {
			t.Errorf("%s: %d", path, rec.Code)
		}
		for k := range pageHeaders {
			if rec.Header().Get(k) != "" {
				t.Errorf("%s: %s", path, k)
			}
		}
	}

	// Without a web directory: /proof is not found; the other pages are as
	// they are.
	h.http = h.server.routes(crlDir(h.data), rosterDir(h.data), "")
	for _, path := range []string{"/proof", "/proof/", "/proof/help.html"} {
		if rec := h.raw("GET", path, ""); rec.Code != 404 {
			t.Errorf("%s without web: %d", path, rec.Code)
		}
	}
	for _, path := range []string{"/", "/faq", "/verify", "/hang", "/hang/" + cardA, "/p/" + cardA, "/threads/@alice", "/roster"} {
		if status, _ := h.get(path); status != 200 {
			t.Errorf("%s without web: %d", path, status)
		}
	}
}
