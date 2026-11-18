package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/iamreal-tw/iamreal/server/pages"
)

// responseHeaders are sent with every response: the API, the static files
// and the pages of the web directory. This is the one place to change them,
// with pageHeaders and visitorHeaders (visitor.go).
var responseHeaders = map[string]string{
	"X-Content-Type-Options": "nosniff",
}

// pageHeaders are sent, besides responseHeaders, with every file of the web
// directory: the pages, their scripts and workers, the circuits and the CRS.
// web/README.md explains them and quotes the policy; a test checks that it
// quotes this one.
//
//   - Content-Security-Policy: fetch, images, WebSockets, forms, frames and
//     other origins' scripts and workers reach the page's own origin only.
//     It does not govern top-level navigation, window.open or WebRTC, so it
//     does not stop a script in the page from sending data elsewhere
//     (web/README.md says what it does and does not stop). The window of
//     MOICA's component (http://localhost:61161) is opened with window.open
//     and talked to with postMessage, so it needs nothing for the component.
//   - Document-Isolation-Policy: makes the page cross-origin isolated in
//     desktop Chromium (multithreaded proof) while it can still talk to the
//     component's window, which Cross-Origin-Opener-Policy: same-origin
//     would cut off. Other browsers ignore it and prove with one thread.
//   - Cross-Origin-Opener-Policy: same-origin-allow-popups: a page on
//     another site that opened this one with window.open loses its hold on
//     it (it could otherwise replace the tab, or navigate the component's
//     window by name). The windows the page opens itself keep their opener,
//     so the component's reply still comes back.
var pageHeaders = map[string]string{
	"Content-Security-Policy": "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; " +
		"img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"Document-Isolation-Policy":  "isolate-and-credentialless",
	"Cross-Origin-Opener-Policy": "same-origin-allow-popups",
}

// contentTypes are the media types of the static files whose extension Go
// does not know.
var contentTypes = map[string]string{
	".crl":   "application/pkix-crl", // RFC 5280 section 4.2.1.13
	".jsonl": "application/jsonl",
}

// routes returns the handler of the whole site:
//
//	/api/       the API (api.go)
//	/crl/       the CRL mirror: index.jsonl and SHA256.crl
//	/roster/    the published roster: the roster directory and heads.jsonl
//	/p/         the page of a card (visitor.go)
//	/threads/   the page of an account
//	/roster     the roster page (without the slash)
//	/pages.css  the style sheet of these three pages
//	/           the web directory, if one is given
func (s *Server) routes(crlDir, rosterDir, webDir string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/api/", s.api())
	mux.Handle("/crl/", http.StripPrefix("/crl/", staticFiles(crlDir)))
	mux.Handle("/roster/", http.StripPrefix("/roster/", staticFiles(rosterDir)))
	v := s.visitorPages()
	mux.Handle("/p/", v.handler(v.proof))
	mux.Handle("/threads/", v.handler(v.account))
	mux.Handle("/roster", v.handler(v.roster))
	mux.Handle(pages.CSSPath, v.handler(v.css))
	if webDir != "" {
		mux.Handle("/", withHeaders(pageHeaders, staticFiles(webDir)))
	} else {
		mux.Handle("/", http.NotFoundHandler())
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range responseHeaders {
			w.Header().Set(k, v)
		}
		mux.ServeHTTP(w, r)
	})
}

// withHeaders sets headers on every response of h.
func withHeaders(headers map[string]string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		h.ServeHTTP(w, r)
	})
}

// staticFiles serves the files of dir with GET and HEAD. It lists no
// directory (a directory is served only through its index.html), and
// serves no name that starts with ".": the mirror and the snapshot write
// their files under such a name before renaming them.
func staticFiles(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := path.Clean("/" + r.URL.Path)
		for _, part := range strings.Split(name, "/") {
			if strings.HasPrefix(part, ".") {
				http.NotFound(w, r)
				return
			}
		}
		full := filepath.Join(dir, filepath.FromSlash(name))
		info, err := os.Stat(full)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if info.IsDir() {
			if _, err := os.Stat(filepath.Join(full, "index.html")); err != nil {
				http.NotFound(w, r)
				return
			}
		}
		if t, ok := contentTypes[path.Ext(name)]; ok {
			w.Header().Set("Content-Type", t)
		}
		files.ServeHTTP(w, r)
	})
}
