package main

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
)

// fakeMOICA serves one file per path, with an ETag and a Last-Modified,
// and answers conditional requests as a web server does.
type fakeMOICA struct {
	mu       sync.Mutex
	files    map[string][]byte
	etags    map[string]string
	modified map[string]time.Time
	status   int      // if not 0, every response has this status
	requests []string // "path If-None-Match If-Modified-Since User-Agent"
}

func (f *fakeMOICA) set(path string, body []byte, etag string, modified time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.files[path], f.etags[path], f.modified[path] = body, etag, modified
}

func (f *fakeMOICA) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, strings.Join([]string{r.URL.Path, r.Header.Get("If-None-Match"), r.Header.Get("If-Modified-Since"), r.Header.Get("User-Agent")}, " | "))
	if f.status != 0 {
		w.WriteHeader(f.status)
		return
	}
	body, ok := f.files[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("ETag", f.etags[r.URL.Path])
	w.Header().Set("Last-Modified", f.modified[r.URL.Path].UTC().Format(http.TimeFormat))
	if inm := r.Header.Get("If-None-Match"); inm != "" && inm == f.etags[r.URL.Path] {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Write(body)
}

func (f *fakeMOICA) takeRequests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.requests
	f.requests = nil
	return r
}

func readIndexLines(t *testing.T, dir string) []crl.IndexLine {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, crl.IndexFileName))
	if err != nil {
		t.Fatal(err)
	}
	lines, err := crl.ParseIndex(data)
	if err != nil {
		t.Fatal(err)
	}
	return lines
}

func archiveFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func TestMirror(t *testing.T) {
	moica := &fakeMOICA{files: map[string][]byte{}, etags: map[string]string{}, modified: map[string]time.Time{}}
	g2 := makeCRL(t, "G2", 10, crlTime, 1, 2)
	g3 := makeCRL(t, "G3", 20, crlTime, 3)
	moica.set("/g2.crl", g2, `"a"`, crlTime)
	moica.set("/g3.crl", g3, `"b"`, crlTime)
	srv := httptest.NewServer(moica)
	defer srv.Close()

	dir := t.TempDir()
	m := &Mirror{
		Dir: dir, Keys: namedTestKeys(t), Client: srv.Client(), Log: slog.New(slog.DiscardHandler),
		Sources: []crlSource{{"G2", srv.URL + "/g2.crl"}, {"G3", srv.URL + "/g3.crl"}},
	}
	ctx := context.Background()

	// First round: both downloaded, stored by SHA-256, indexed.
	if err := m.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	reqs := moica.takeRequests()
	if len(reqs) != 2 || !strings.HasPrefix(reqs[0], "/g2.crl |  |  | Go-http-client/") {
		t.Errorf("first requests: %q", reqs)
	}
	want := []string{sha256Hex(g2) + ".crl", sha256Hex(g3) + ".crl", crl.IndexFileName}
	if got := archiveFiles(t, dir); !sameSet(got, want) {
		t.Errorf("files %v, want %v", got, want)
	}
	lines := readIndexLines(t, dir)
	if len(lines) != 2 || lines[0].Issuer != "G2" || lines[1].Issuer != "G3" || lines[1].Root != rootOf(t, g3) || lines[1].CRLDate != "2026-11-20" {
		t.Errorf("index %+v", lines)
	}
	// The index is exactly what crl/ builds from the files.
	built, err := crl.BuildIndex(dir, namedTestKeys(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	if index, _ := os.ReadFile(filepath.Join(dir, crl.IndexFileName)); string(index) != string(crl.FormatIndex(built)) {
		t.Errorf("index differs from crl.BuildIndex")
	}

	// Second round: conditional requests, nothing changed.
	if err := m.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	for _, r := range moica.takeRequests() {
		if !strings.Contains(r, `| "a" | `) && !strings.Contains(r, `| "b" | `) || !strings.Contains(r, "GMT") {
			t.Errorf("not a conditional request: %q", r)
		}
	}

	// MOICA publishes a new G3 CRL: stored, the index has three lines.
	g3b := makeCRL(t, "G3", 21, crlTime.Add(12*time.Hour), 3, 4)
	moica.set("/g3.crl", g3b, `"c"`, crlTime.Add(12*time.Hour))
	if err := m.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	lines = readIndexLines(t, dir)
	if len(lines) != 3 || lines[2].CRLNumber != "21" || lines[2].Root != rootOf(t, g3b) {
		t.Errorf("index %+v", lines)
	}

	// The same bytes again under another ETag: not stored twice.
	moica.set("/g3.crl", g3, `"d"`, crlTime.Add(24*time.Hour))
	if err := m.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	if lines := readIndexLines(t, dir); len(lines) != 3 {
		t.Errorf("%d lines", len(lines))
	}

	// A file that is not a usable CRL is kept and indexed as such.
	moica.set("/g3.crl", []byte("maintenance page"), `"e"`, crlTime.Add(36*time.Hour))
	if err := m.Fetch(ctx); err != nil {
		t.Fatal(err)
	}
	lines = readIndexLines(t, dir)
	if len(lines) != 4 || lines[0].Root != "-not_usable_der" {
		t.Errorf("index %+v", lines)
	}

	// An error status stores nothing and is reported.
	moica.status = http.StatusInternalServerError
	if err := m.Fetch(ctx); err == nil {
		t.Error("no error for HTTP 500")
	}
	if got := archiveFiles(t, dir); len(got) != 5 {
		t.Errorf("files %v", got)
	}
}

// A CRL file stored without its index line (the index could not be
// written) gets its line on the next round.
func TestMirrorRepairsMissingLine(t *testing.T) {
	dir := t.TempDir()
	m := &Mirror{Dir: dir, Keys: namedTestKeys(t), Log: slog.New(slog.DiscardHandler)}
	a := makeCRL(t, "G3", 1, crlTime, 1)
	b := makeCRL(t, "G3", 2, crlTime, 1, 2)
	if _, stored, err := m.store(a); err != nil || !stored {
		t.Fatal(stored, err)
	}
	os.WriteFile(filepath.Join(dir, sha256Hex(b)+".crl"), b, 0o644) // the file, but no line
	if _, stored, err := m.store(b); err != nil || !stored {
		t.Fatal(stored, err)
	}
	if lines := readIndexLines(t, dir); len(lines) != 2 {
		t.Errorf("%d lines", len(lines))
	}
	// An index that is not as the spec writes it stops the mirror before
	// it changes anything.
	os.WriteFile(filepath.Join(dir, crl.IndexFileName), []byte("{}\n"), 0o644)
	if _, _, err := m.store(makeCRL(t, "G3", 3, crlTime, 1)); err == nil {
		t.Error("no error")
	}
	if got := archiveFiles(t, dir); len(got) != 3 {
		t.Errorf("files %v", got)
	}
}

// The subcommand: one round against the sources it is given.
func TestMirrorCommand(t *testing.T) {
	moica := &fakeMOICA{files: map[string][]byte{}, etags: map[string]string{}, modified: map[string]time.Time{}}
	moica.set("/g3.crl", makeCRL(t, "G3", 20, crlTime, 3), `"b"`, crlTime)
	srv := httptest.NewServer(moica)
	defer srv.Close()
	data := t.TempDir()
	d := testDeps(t)
	d.sources = []crlSource{{"G3", srv.URL + "/g3.crl"}}
	var out, errOut strings.Builder
	if code := run([]string{"mirror", "-data", data}, &out, &errOut, d); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if lines := readIndexLines(t, crlDir(data)); len(lines) != 1 {
		t.Errorf("%d lines", len(lines))
	}
	d.sources = []crlSource{{"G3", srv.URL + "/missing.crl"}}
	if code := run([]string{"mirror", "-data", data}, &out, &errOut, d); code != 1 {
		t.Errorf("exit %d for a missing file", code)
	}
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	m := map[string]int{}
	for _, x := range a {
		m[x]++
	}
	for _, x := range b {
		m[x]--
	}
	for _, v := range m {
		if v != 0 {
			return false
		}
	}
	return true
}
