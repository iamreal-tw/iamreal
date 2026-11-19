package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/verifier"
)

// Two card proofs submitted at the same time get consecutive seq numbers
// and the chain does not break; of two with the same challenge, one is
// accepted.
func TestConcurrentSubmissions(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)

	const n = 20
	subs := make([]submission, n)
	for i := range subs {
		subs[i] = h.sub(newCard(), root, "threads:alice")
	}
	statuses := make([]int, n)
	seqs := make([]float64, n)
	var wg sync.WaitGroup
	for i := range subs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, _ := json.Marshal(subs[i])
			rec := h.raw("POST", "/api/v1/records", string(b))
			var out map[string]any
			json.Unmarshal(rec.Body.Bytes(), &out)
			statuses[i] = rec.Code
			seqs[i], _ = out["seq"].(float64)
		}()
	}
	wg.Wait()
	seen := map[float64]bool{}
	for i := range subs {
		if statuses[i] != 201 || seqs[i] < 1 || seqs[i] > n || seen[seqs[i]] {
			t.Errorf("submission %d: %d seq %v", i, statuses[i], seqs[i])
		}
		seen[seqs[i]] = true
	}
	if recs := h.checkChain(); len(recs) != n {
		t.Errorf("%d records", len(recs))
	}

	// The same challenge twice at the same time.
	s := h.sub(newCard(), root, "threads:alice")
	other := s
	other.ScopedID = newCard()
	results := make([]string, 2)
	for i, sub := range []submission{s, other} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, _ := json.Marshal(sub)
			rec := h.raw("POST", "/api/v1/records", string(b))
			results[i] = rec.Body.String()
		}()
	}
	wg.Wait()
	joined := strings.Join(results, " ")
	if strings.Count(joined, `"kind":"first"`) != 1 || strings.Count(joined, `"error":"challenge_used"`) != 1 {
		t.Errorf("same challenge twice: %v", results)
	}
	if recs := h.checkChain(); len(recs) != n+1 {
		t.Errorf("%d records", len(recs))
	}
}

// On start the server reads every record and computes the same state.
func TestStartRecomputes(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	card := newCard()
	h.mustSubmit(h.sub(card, root, "threads:alice"), "threads first")
	h.mustSubmit(h.sub(card, root, "test-example:a-b", "threads:bob"), "test-example first, threads correction")
	ask := `{"scope_string":"` + testScope + `","scoped_id":"` + card + `"}`
	_, before := h.do("POST", "/api/v1/card-state", ask)

	h.start()
	_, after := h.do("POST", "/api/v1/card-state", ask)
	if !reflect.DeepEqual(before, after) || current(after, "threads") != "bob" || current(after, "test-example") != "a-b" {
		t.Errorf("before %v\nafter %v", before, after)
	}
	h.mustSubmit(h.sub(card, root, "test-example:a-b", "threads:carol"), "test-example refresh, threads correction")
	h.wantError(h.sub(newCard(), root), 400, "empty")
	h.clock.Set(startOfTests.Add(24 * time.Hour))
	h.mustSubmit(h.sub(card, root, "test-example:a-b", "threads:dave"), "test-example refresh, threads switch")
	_, after = h.do("POST", "/api/v1/card-state", ask)
	if th := after["platforms"].(map[string]any)["threads"].(map[string]any); th["switch_count"] != 1.0 || th["correction_date"] != "2026-11-21" {
		t.Errorf("after the switch: %v", th)
	}
}

// The server does not start on a roster with an invalid record, and says
// which.
func TestStartRefusesInvalidRecord(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	card := newCard()
	h.mustSubmit(h.sub(card, root, "threads:alice"), "threads first")

	// A record written past the server: the empty list of a card that
	// declares no account.
	r := &verifier.Record{
		Seq: 2, ScopeString: testScope, ScopedID: newCard(),
		Challenge: h.challenge(), Issuer: "G3", SMTRoot: root, Circuit: circuitOf("G3"), Proof: goodProof,
	}
	if err := h.store.Append(r, nil); err != nil {
		t.Fatal(err)
	}
	_, err := New(h.config())
	if err == nil || !strings.Contains(err.Error(), "record 2 is invalid: empty") {
		t.Errorf("%v", err)
	}
}

// A root whose CRL is no longer in the mirror makes its record invalid
// (ADR-0015): the server does not start.
func TestStartRefusesWithoutTheCRL(t *testing.T) {
	c := g3CRL(t)
	h := newHarness(t, startOfTests, c)
	h.mustSubmit(h.sub(newCard(), rootOf(t, c), "threads:alice"), "threads first")
	if err := os.Remove(filepath.Join(crlDir(h.data), crl.IndexFileName)); err != nil {
		t.Fatal(err)
	}
	if _, err := New(h.config()); err == nil || !strings.Contains(err.Error(), "record 1 is invalid: root") {
		t.Errorf("%v", err)
	}
	// An index that is not as the spec writes it.
	os.WriteFile(filepath.Join(crlDir(h.data), crl.IndexFileName), []byte("{}\n"), 0o644)
	if _, err := New(h.config()); err == nil || !strings.Contains(err.Error(), "CRL mirror") {
		t.Errorf("%v", err)
	}
}

// A record of another roster (here, a test record read by a production
// server) breaks the roster: the server does not start.
func TestStartRefusesBrokenRoster(t *testing.T) {
	c := g3CRL(t)
	h := newHarness(t, startOfTests, c)
	h.mustSubmit(h.sub(newCard(), rootOf(t, c), "threads:alice"), "threads first")
	cfg := h.config()
	cfg.Roster = verifier.Production
	if _, err := New(cfg); err == nil || !strings.Contains(err.Error(), "record 1: the roster is broken there") {
		t.Errorf("%v", err)
	}
}

// The log of card-state and records has nothing that identifies the
// connection: not the client's address (nor a forwarded one), not the
// scoped ID, the username or the challenge. It has the request ID, the
// status, the error code and the version.
func TestLogHasNoAddress(t *testing.T) {
	c := g3CRL(t)
	root := rootOf(t, c)
	h := newHarness(t, startOfTests, c)
	card := newCard()
	s := h.sub(card, root, "threads:alice")
	h.do("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`)
	h.mustSubmit(s, "threads first")
	h.wantError(s, 400, "challenge_used")
	h.do("POST", "/api/v1/card-state", `{"scoped_id":"`+card+`"}`)
	h.do("GET", "/api/v1/card-state/"+card, "")

	logs := h.logs.String()
	for _, secret := range []string{clientAddress, "61234", card, "alice", s.Challenge, s.Challenge[11:]} {
		if strings.Contains(logs, secret) {
			t.Errorf("the log contains %q:\n%s", secret, logs)
		}
	}
	var lines []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(logs), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatal(err)
		}
		lines = append(lines, m)
	}
	want := []struct {
		path   string
		status float64
		code   string
	}{
		{"/api/v1/challenges", 200, ""},
		{"/api/v1/card-state", 200, ""},
		{"/api/v1/records", 201, ""},
		{"/api/v1/records", 400, "challenge_used"},
		{"/api/v1/card-state", 400, "malformed"},
		{"other", 404, "not_found"},
	}
	if len(lines) != len(want) {
		t.Fatalf("%d log lines:\n%s", len(lines), logs)
	}
	for i, w := range want {
		l := lines[i]
		if l["path"] != w.path || l["status"] != w.status || l["error"] != w.code || l["version"] != "test-version" ||
			len(l["id"].(string)) != 16 || l["time"] == nil {
			t.Errorf("log line %d: %v, want %+v", i, l, w)
		}
		for k := range l {
			switch k {
			case "time", "level", "msg", "id", "method", "path", "status", "error", "version":
			default:
				t.Errorf("log line %d has %q", i, k)
			}
		}
	}
}

// Every API response carries X-Request-Id, the ID of its log line
// (docs/api/card-proof.md), and only API responses do.
func TestRequestIDIsTheLogs(t *testing.T) {
	h := newHarness(t, startOfTests)
	var ids []string
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/v1/challenges"}, {"GET", "/api/v1/config"}, {"POST", "/api/v1/card-state"},
		{"POST", "/api/v1/records"}, {"GET", "/api/v1/nothing"}, {"GET", "/api/v1/records"},
	} {
		id := h.raw(c.method, c.path, "").Header().Get("X-Request-Id")
		if len(id) != 16 || strings.Trim(id, "0123456789abcdef") != "" {
			t.Errorf("%s %s: X-Request-Id %q", c.method, c.path, id)
		}
		ids = append(ids, id)
	}
	var logged []string
	for _, l := range strings.Split(strings.TrimSpace(h.logs.String()), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatal(err)
		}
		logged = append(logged, m["id"].(string))
	}
	if !reflect.DeepEqual(ids, logged) {
		t.Errorf("response IDs %v, logged %v", ids, logged)
	}
	if ids[0] == ids[1] {
		t.Errorf("two requests, one ID")
	}
	if id := h.raw("GET", "/crl/index.jsonl", "").Header().Get("X-Request-Id"); id != "" {
		t.Errorf("a static file has X-Request-Id %q", id)
	}
}

// web/README.md quotes the Content-Security-Policy the server sends.
func TestWebReadmeQuotesThePolicy(t *testing.T) {
	readme, err := os.ReadFile(filepath.Join("..", "web", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(readme), pageHeaders["Content-Security-Policy"]) {
		t.Errorf("web/README.md does not quote the Content-Security-Policy of headers.go")
	}
	if !strings.Contains(string(readme), "Document-Isolation-Policy: "+pageHeaders["Document-Isolation-Policy"]) {
		t.Errorf("web/README.md does not quote the Document-Isolation-Policy of headers.go")
	}
	if !strings.Contains(string(readme), "Cross-Origin-Opener-Policy: "+pageHeaders["Cross-Origin-Opener-Policy"]) {
		t.Errorf("web/README.md does not quote the Cross-Origin-Opener-Policy of headers.go")
	}
	if len(pageHeaders) != 3 {
		t.Errorf("web/README.md explains three page headers; headers.go has %d", len(pageHeaders))
	}
}

// A page that opened the card proof page with window.open must not keep a
// hold on it, while the windows the page opens itself (MOICA's component)
// keep theirs (web/README.md, "Cross-Origin-Opener-Policy"; the browser
// test is web/test/e2e/ui.ts).
func TestPageOpenerPolicy(t *testing.T) {
	if got := pageHeaders["Cross-Origin-Opener-Policy"]; got != "same-origin-allow-popups" {
		t.Errorf("Cross-Origin-Opener-Policy is %q", got)
	}
}

func TestStaticFiles(t *testing.T) {
	c := g3CRL(t)
	h := newHarness(t, startOfTests, c)
	web := t.TempDir()
	os.WriteFile(filepath.Join(web, "index.html"), []byte("<p>page</p>"), 0o644)
	os.Mkdir(filepath.Join(web, "assets"), 0o755)
	os.WriteFile(filepath.Join(web, "assets", "a.js"), []byte("1"), 0o644)
	os.WriteFile(filepath.Join(rosterDir(h.data), "fingerprints.jsonl"), []byte("x\n"), 0o644)
	os.Mkdir(filepath.Join(rosterDir(h.data), "hashes"), 0o755)
	os.WriteFile(filepath.Join(rosterDir(h.data), "hashes", "0000000000000000.txt"), []byte("x\n"), 0o644)
	os.WriteFile(filepath.Join(crlDir(h.data), ".tmp-123"), []byte("half"), 0o644)
	h.http = h.server.routes(crlDir(h.data), rosterDir(h.data), web)

	name := sha256Hex(c) + ".crl"
	for _, x := range []struct {
		path        string
		status      int
		contentType string
	}{
		{"/crl/index.jsonl", 200, "application/jsonl"},
		{"/crl/" + name, 200, "application/pkix-crl"},
		{"/crl/.tmp-123", 404, ""},
		{"/crl/", 404, ""}, // no directory listing
		{"/roster/fingerprints.jsonl", 200, "application/jsonl"},
		{"/roster/hashes/0000000000000000.txt", 200, "text/plain; charset=utf-8"},
		{"/roster/", 404, ""},
		{"/proof", 200, "text/html; charset=utf-8"},
		{"/proof/assets/a.js", 200, "text/javascript; charset=utf-8"},
		{"/proof/assets/", 404, ""},
		{"/proof/nothing", 404, ""},
	} {
		rec := h.raw("GET", x.path, "")
		if rec.Code != x.status || (x.contentType != "" && rec.Header().Get("Content-Type") != x.contentType) {
			t.Errorf("%s: %d %q", x.path, rec.Code, rec.Header().Get("Content-Type"))
		}
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: no nosniff", x.path)
		}
		// The page's headers go with the web directory's files, not with the
		// mirror or the roster.
		page := strings.HasPrefix(x.path, "/proof")
		for k, v := range pageHeaders {
			if got := rec.Header().Get(k); (got == v) != page {
				t.Errorf("%s: %s is %q", x.path, k, got)
			}
		}
	}
	if rec := h.raw("GET", "/crl/"+name, ""); rec.Body.String() != string(c) {
		t.Errorf("the CRL is not its original bytes")
	}
	if rec := h.raw("POST", "/crl/index.jsonl", ""); rec.Code != 405 {
		t.Errorf("POST: %d", rec.Code)
	}
	// Without a web directory, /proof is not found.
	h.http = h.server.routes(crlDir(h.data), rosterDir(h.data), "")
	if rec := h.raw("GET", "/proof", ""); rec.Code != 404 {
		t.Errorf("/proof without web: %d", rec.Code)
	}
}

// current returns the current account of a card-state response on a
// platform, or nil.
func current(body map[string]any, platform string) any {
	platforms, _ := body["platforms"].(map[string]any)
	slot, _ := platforms[platform].(map[string]any)
	return slot["current"]
}
