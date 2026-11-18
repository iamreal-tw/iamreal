package main

import (
	"bytes"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/iamreal-tw/iamreal/server/pages"
	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

// The pages visitors read (server/pages): the page of a card, the page of
// an account and the roster page. They are made from the store's views on
// each request, so a record shows on the next page opened after it is
// written. Nothing here reads the rules' state in memory.

// visitorHeaders are sent, besides responseHeaders, with the visitors'
// pages and their style sheet; server/README.md explains them. They are
// not the card proof pages' (pageHeaders), which are left as they are.
//
//   - Content-Security-Policy: no script at all; the style sheet and images
//     of this origin; frames from https://www.threads.com only (the
//     profile); forms sent to this origin only (the lookup box).
//   - No Cross-Origin-Embedder-Policy nor Document-Isolation-Policy: the
//     Threads frame would be blocked.
var visitorHeaders = map[string]string{
	"Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; frame-src https://www.threads.com; " +
		"base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
	"Referrer-Policy":            "no-referrer",
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cache-Control":              "no-cache",
}

// countsMaxAge is how long the roster page may show the same counts before
// they are computed again.
const countsMaxAge = 60 * time.Second

// visitorPages serves the pages; routes mounts it.
type visitorPages struct {
	s     *Server
	scope string // the open scope of the server's roster
	site  pages.Site

	mu     sync.Mutex
	counts cachedCounts
}

type cachedCounts struct {
	at               time.Time
	today            verifier.Date
	declared, recent int
}

func (s *Server) visitorPages() *visitorPages {
	v := &visitorPages{s: s, site: pages.Site{TestRoster: s.cfg.Roster == verifier.Test}}
	for _, sc := range verifier.Scopes(s.cfg.Roster) {
		if sc.LastSeq == 0 {
			v.scope = sc.String
		}
	}
	return v
}

// handler returns h with the visitors' headers, for GET and HEAD only.
func (v *visitorPages) handler(h func(w http.ResponseWriter, r *http.Request)) http.Handler {
	return withHeaders(visitorHeaders, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h(w, r)
	}))
}

// write renders a page into memory and sends it with status; an error
// sends 500 instead, with nothing of the page.
func (v *visitorPages) write(w http.ResponseWriter, r *http.Request, status int, render func(*bytes.Buffer) error) {
	var b bytes.Buffer
	if err := render(&b); err != nil {
		v.internal(w, r, "render", err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	w.Write(b.Bytes())
}

func (v *visitorPages) internal(w http.ResponseWriter, r *http.Request, what string, err error) {
	v.s.cfg.Log.Error("internal error", "page", pageName(r.URL.Path), "what", what, "err", strings.TrimSpace(err.Error()))
	http.Error(w, "internal error", http.StatusInternalServerError)
}

// pageName is which page a path is, for the log: never the short ID or the
// account in it.
func pageName(p string) string {
	switch {
	case strings.HasPrefix(p, "/p/"):
		return "card"
	case strings.HasPrefix(p, "/threads/"):
		return "account"
	}
	return "roster"
}

func (v *visitorPages) today() verifier.Date { return taiwanDate(v.s.cfg.Now()) }

// GET /p/<short ID>: the page of a card (design/copy/proof-page.md). The
// short ID is read as spec/scoped-id.md reads one in a URL; another
// spelling of a short ID is redirected (301) to its one spelling. A short
// ID that does not read, or resolves to no card, has the page of section
// 9, with 404.
func (v *visitorPages) proof(w http.ResponseWriter, r *http.Request) {
	typed := strings.TrimPrefix(r.URL.Path, "/p/")
	short, ok := verifier.ReadShortIDInURL(typed)
	if ok && short != typed {
		http.Redirect(w, r, "/p/"+short, http.StatusMovedPermanently)
		return
	}
	var cards []pages.Card
	if ok {
		summaries, err := v.s.cfg.Store.Cards(v.scope, short)
		if err != nil {
			v.internal(w, r, "cards", err)
			return
		}
		for _, c := range summaries {
			h, err := v.s.cfg.Store.History(v.scope, c.ScopedID)
			if err != nil {
				v.internal(w, r, "history", err)
				return
			}
			cards = append(cards, pages.Card{Summary: c, History: h})
		}
	}
	if len(cards) == 0 {
		v.write(w, r, http.StatusNotFound, func(b *bytes.Buffer) error { return pages.ProofMissing{Typed: typed}.Render(b, v.site) })
		return
	}
	p := pages.ProofPage{ShortID: short, Cards: cards, Today: v.today()}
	v.write(w, r, http.StatusOK, func(b *bytes.Buffer) error { return p.Render(b, v.site) })
}

// GET /threads/@<name>: the page of a Threads account
// (design/copy/account-page.md), 200 whether or not a card gives its place
// to it. A name with uppercase letters is redirected (301) to lowercase; a
// name not in the Threads format has a page of its own (section 4), 404.
func (v *visitorPages) account(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/threads/")
	typed, found := strings.CutPrefix(rest, "@")
	if !found {
		http.NotFound(w, r)
		return
	}
	name := pages.LowerASCII(typed)
	if !pages.ValidUsername(name) {
		v.write(w, r, http.StatusNotFound, func(b *bytes.Buffer) error { return pages.NotAName{}.Render(b, v.site) })
		return
	}
	if name != typed {
		http.Redirect(w, r, "/threads/@"+name, http.StatusMovedPermanently)
		return
	}
	cards, err := v.s.cfg.Store.AccountCards(v.scope, pages.Platform, name)
	if err != nil {
		v.internal(w, r, "account cards", err)
		return
	}
	p := pages.AccountPage{Username: name, Cards: cards, Today: v.today()}
	v.write(w, r, http.StatusOK, func(b *bytes.Buffer) error { return p.Render(b, v.site) })
}

// GET /roster: the roster page (design/copy/roster-page.md). ?after= lists
// the slots after a place in the list (the link 更多); ?q= is the lookup
// box (roster-page.md, 查詢): with the spaces around it and a leading @
// taken off, a Threads name in any case is redirected (303) to its page;
// nothing left shows the page as it is; anything else shows the page with
// what was typed in the box and a line under it.
func (v *visitorPages) roster(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	p := pages.RosterPage{}
	if typed := strings.TrimPrefix(strings.TrimSpace(query.Get("q")), "@"); typed != "" {
		if name := pages.LowerASCII(typed); pages.ValidUsername(name) {
			http.Redirect(w, r, "/threads/@"+name, http.StatusSeeOther)
			return
		}
		p.Query, p.BadQuery = typed, true
	}
	var after store.RecentPosition
	if !p.BadQuery && query.Has("after") {
		// A place that does not read lists from the start.
		after, p.After = pages.ParsePosition(query.Get("after"))
	}
	slots, err := v.s.cfg.Store.Recent(v.scope, pages.Platform, after, pages.PageSize+1)
	if err != nil {
		v.internal(w, r, "recent", err)
		return
	}
	if len(slots) > pages.PageSize {
		slots, p.More = slots[:pages.PageSize], true
	}
	p.Slots = slots
	if p.Declared, p.Recent, err = v.countsOf(v.today()); err != nil {
		v.internal(w, r, "counts", err)
		return
	}
	v.write(w, r, http.StatusOK, func(b *bytes.Buffer) error { return p.Render(b, v.site) })
}

// countsOf returns the counts of the roster page, computed again at most
// every countsMaxAge, and at once when the date in Taiwan changes.
func (v *visitorPages) countsOf(today verifier.Date) (declared, recent int, err error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.s.cfg.Now()
	c := v.counts
	if !c.at.IsZero() && c.today == today && now.Sub(c.at) < countsMaxAge && !now.Before(c.at) {
		return c.declared, c.recent, nil
	}
	declared, recent, err = v.s.cfg.Store.Counts(v.scope, pages.Platform, today)
	if err != nil {
		return 0, 0, err
	}
	v.counts = cachedCounts{at: now, today: today, declared: declared, recent: recent}
	return declared, recent, nil
}

// css serves the pages' style sheet, with an ETag for revalidation.
func (v *visitorPages) css(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("ETag", pages.CSSETag)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(pages.CSS))
}
