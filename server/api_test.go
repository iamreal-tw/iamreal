package main

// Every endpoint, and every error code of each, with the fake proof
// verifier. Real proofs: e2e_test.go.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/verifier"
)

func g3CRL(t *testing.T) []byte { return makeCRL(t, "G3", 1, crlTime, 11, 12) }

func TestChallenges(t *testing.T) {
	h := newHarness(t, startOfTests)
	random := bytes.Repeat([]byte{0xab}, 16)
	h.random = bytes.NewReader(random)
	h.start()

	status, body := h.do("POST", "/api/v1/challenges", "")
	want := "2026-11-20." + verifier.EncodeBase32(random)
	if status != 200 || body["challenge"] != want || len(body) != 1 {
		t.Fatalf("%d %v, want %s", status, body, want)
	}
	if _, err := verifier.ParseChallenge(want); err != nil {
		t.Fatal(err)
	}
	c, found, err := h.store.Submit(want)
	if err != nil || !found || !c.Issued.Equal(startOfTests) {
		t.Errorf("stored: %+v %v %v", c, found, err)
	}

	// The test's random source is used up: the server answers 500 rather
	// than issue a challenge without 16 random bytes.
	if status, body := h.do("POST", "/api/v1/challenges", ""); status != 500 || body["error"] != "internal" {
		t.Errorf("no random bytes: %d %v", status, body)
	}
	h.random = nil
	h.start()

	// The date is the date in Taiwan, which changes at 16:00 UTC.
	for _, c := range []struct {
		now  time.Time
		date string
	}{
		{tw(2026, 11, 20, 23, 59, 59).Add(999 * time.Millisecond), "2026-11-20"},
		{tw(2026, 11, 21, 0, 0, 0), "2026-11-21"},
		{time.Date(2026, 12, 31, 15, 59, 59, 0, time.UTC), "2026-12-31"},
		{time.Date(2026, 12, 31, 16, 0, 0, 0, time.UTC), "2027-01-01"},
	} {
		h.clock.Set(c.now)
		got := h.challenge()
		if !strings.HasPrefix(got, c.date+".") {
			t.Errorf("at %v: %s, want date %s", c.now.UTC(), got, c.date)
		}
	}

	// Two challenges are never the same.
	if a, b := h.challenge(), h.challenge(); a == b {
		t.Errorf("same challenge twice: %s", a)
	}
}

func TestConfigAndHead(t *testing.T) {
	h := newHarness(t, startOfTests, g3CRL(t))
	status, body := h.do("GET", "/api/v1/config", "")
	if status != 200 || !reflect.DeepEqual(body, map[string]any{"crl_max_age_days": 3.0}) {
		t.Errorf("config: %d %v", status, body)
	}
	status, body = h.do("GET", "/api/v1/head", "")
	if status != 200 || body["count"] != 0.0 || body["head"] != verifier.GenesisPrev {
		t.Errorf("empty head: %d %v", status, body)
	}
	h.mustSubmit(h.sub("declare", newCard(), "alice", rootOf(t, g3CRL(t))), "first")
	recs := h.checkChain()
	_, body = h.do("GET", "/api/v1/head", "")
	if body["count"] != 1.0 || body["head"] != recs[0].Hash() {
		t.Errorf("head: %v", body)
	}
}

func TestEveryResponseIsJSONAndNotCached(t *testing.T) {
	h := newHarness(t, startOfTests)
	for _, c := range []struct{ method, path string }{
		{"POST", "/api/v1/challenges"}, {"GET", "/api/v1/config"}, {"GET", "/api/v1/head"},
		{"POST", "/api/v1/card-state"}, {"POST", "/api/v1/records"}, {"GET", "/api/v1/nothing"},
	} {
		rec := h.raw(c.method, c.path, "")
		if rec.Header().Get("Content-Type") != "application/json" || rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("%s %s: headers %v", c.method, c.path, rec.Header())
		}
		if rec.Header().Get("Set-Cookie") != "" || rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("%s %s: cookie or CORS header", c.method, c.path)
		}
		for k, v := range responseHeaders {
			if rec.Header().Get(k) != v {
				t.Errorf("%s %s: %s is %q", c.method, c.path, k, rec.Header().Get(k))
			}
		}
	}
}

func TestNotFoundAndMethod(t *testing.T) {
	h := newHarness(t, startOfTests)
	if status, body := h.do("GET", "/api/v1/card-state/QSP7N6", ""); status != 404 || body["error"] != "not_found" {
		t.Errorf("unknown path: %d %v", status, body)
	}
	for _, c := range []struct{ method, path string }{
		{"GET", "/api/v1/challenges"}, {"GET", "/api/v1/card-state"}, {"GET", "/api/v1/records"},
		{"POST", "/api/v1/config"}, {"POST", "/api/v1/head"},
	} {
		rec := h.raw(c.method, c.path, "")
		if rec.Code != 405 || !strings.Contains(rec.Body.String(), `"method_not_allowed"`) || rec.Header().Get("Allow") == "" {
			t.Errorf("%s %s: %d %s", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
}

func TestCardState(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	card := newCard()
	ask := func() (int, map[string]any) {
		return h.do("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`)
	}

	// A card with no record: not an error.
	status, body := ask()
	want := map[string]any{"current": nil, "last_declared": nil, "last_card_proof": nil, "switch_dates": []any{}, "count": 0.0, "head": verifier.GenesisPrev}
	if status != 200 || !reflect.DeepEqual(body, want) {
		t.Errorf("no record: %d %v", status, body)
	}

	h.mustSubmit(h.sub("declare", card, "alice", root), "first")
	h.mustSubmit(h.sub("declare", card, "bob", root), "switch")
	h.clock.Set(tw(2026, 11, 21, 9, 0, 0))
	h.mustSubmit(h.sub("withdraw", card, "bob", root), "withdraw")
	h.mustSubmit(h.sub("declare", newCard(), "alice", root), "first") // another card
	recs := h.checkChain()
	status, body = ask()
	want = map[string]any{
		"current": nil, "last_declared": "bob", "last_card_proof": "2026-11-21",
		"switch_dates": []any{"2026-11-20"}, "count": 4.0, "head": recs[3].Hash(),
	}
	if status != 200 || !reflect.DeepEqual(body, want) {
		t.Errorf("after withdraw: %d %v", status, body)
	}
	// The keys are in the order of the API document.
	raw := h.raw("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`).Body.String()
	if !strings.HasPrefix(raw, `{"current":null,"last_declared":"bob","last_card_proof":"2026-11-21","switch_dates":["2026-11-20"],"count":4,"head":"`) {
		t.Errorf("body %s", raw)
	}
}

func TestCardStateMalformed(t *testing.T) {
	h := newHarness(t, startOfTests)
	card := newCard()
	for name, body := range map[string]string{
		"empty":                 "",
		"not an object":         `["` + testScope + `"]`,
		"missing key":           `{"scope_string":"` + testScope + `"}`,
		"extra key":             `{"scope_string":"` + testScope + `","scoped_id":"` + card + `","username":"alice"}`,
		"key twice":             `{"scope_string":"` + testScope + `","scoped_id":"` + card + `","scoped_id":"` + card + `"}`,
		"key in another case":   `{"Scope_string":"` + testScope + `","scoped_id":"` + card + `"}`,
		"number":                `{"scope_string":"` + testScope + `","scoped_id":7}`,
		"null":                  `{"scope_string":"` + testScope + `","scoped_id":null}`,
		"after the object":      `{"scope_string":"` + testScope + `","scoped_id":"` + card + `"}{}`,
		"production scope":      `{"scope_string":"iamreal:threads:0______________","scoped_id":"` + card + `"}`,
		"unknown scope":         `{"scope_string":"iamreal-test:threads:1_________","scoped_id":"` + card + `"}`,
		"lowercase scoped ID":   `{"scope_string":"` + testScope + `","scoped_id":"` + strings.ToLower(card) + `"}`,
		"short scoped ID":       `{"scope_string":"` + testScope + `","scoped_id":"` + card[:51] + `"}`,
		"scoped ID not below p": `{"scope_string":"` + testScope + `","scoped_id":"` + strings.Repeat("Z", 51) + `0"}`,
		"too long":              `{"scope_string":"` + testScope + `","scoped_id":"` + strings.Repeat(" ", maxBody) + card + `"}`,
	} {
		if status, out := h.do("POST", "/api/v1/card-state", body); status != 400 || !reflect.DeepEqual(out, map[string]any{"error": "malformed"}) {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	// Whitespace and another order of the keys are JSON like any other.
	if status, out := h.do("POST", "/api/v1/card-state", ` { "scoped_id" : "`+card+`", "scope_string":"`+testScope+`" } `); status != 200 {
		t.Errorf("whitespace: %d %v", status, out)
	}
}

func TestRecordsMalformed(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	good := h.sub("declare", newCard(), "alice", root)
	edits := map[string]func(s *submission){
		"username in uppercase":     func(s *submission) { s.Username = "Alice" },
		"username too long":         func(s *submission) { s.Username = strings.Repeat("a", 31) },
		"action":                    func(s *submission) { s.Action = "switch" },
		"scoped ID":                 func(s *submission) { s.ScopedID = strings.ToLower(s.ScopedID) },
		"challenge padding bits":    func(s *submission) { s.Challenge = s.Challenge[:36] + "1" },
		"challenge date":            func(s *submission) { s.Challenge = "2026-02-29" + s.Challenge[10:] },
		"issuer":                    func(s *submission) { s.Issuer = "G4" },
		"smt_root uppercase":        func(s *submission) { s.SMTRoot = strings.ToUpper(s.SMTRoot) },
		"smt_root not below p":      func(s *submission) { s.SMTRoot = strings.Repeat("f", 64) },
		"circuit":                   func(s *submission) { s.Circuit = s.Circuit[:63] },
		"proof one byte short":      func(s *submission) { s.Proof = base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength-1)) },
		"proof one byte long":       func(s *submission) { s.Proof = base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength+1)) },
		"proof without padding":     func(s *submission) { s.Proof = strings.TrimRight(s.Proof, "=") },
		"proof in another spelling": func(s *submission) { s.Proof = s.Proof[:len(s.Proof)-2] + "B=" },
		"proof with a line feed":    func(s *submission) { s.Proof = s.Proof[:100] + "\n" + s.Proof[101:] },
		"username with a quote":     func(s *submission) { s.Username = `ali"ce` },
		"username with a backslash": func(s *submission) { s.Username = `ali\ce` },
	}
	for name, edit := range edits {
		s := good
		edit(&s)
		if status, out := h.submit(s); status != 400 || out["error"] != "malformed" {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	b, _ := json.Marshal(good)
	for name, body := range map[string]string{
		"not JSON":      "declare alice",
		"missing field": strings.Replace(string(b), `"issuer":"G3",`, "", 1),
		"extra field":   strings.Replace(string(b), `{`, `{"seq":1,`, 1),
		"field twice":   strings.Replace(string(b), `{`, `{"username":"bob",`, 1),
	} {
		if status, out := h.do("POST", "/api/v1/records", body); status != 400 || out["error"] != "malformed" {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	// None of these counted as a submission of the challenge, and the
	// challenge is still usable.
	h.mustSubmit(good, "first")
}

func TestRecordsScope(t *testing.T) {
	crl := g3CRL(t)
	h := newHarness(t, startOfTests, crl)
	s := h.sub("declare", newCard(), "alice", rootOf(t, crl))
	s.ScopeString = "iamreal:threads:0______________" // the production roster's
	h.wantError(s, 400, "scope")
	s.ScopeString = "iamreal-test:x:0_______________"
	h.wantError(s, 400, "scope")
}

func TestChallengeUnknown(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)

	s := h.sub("declare", newCard(), "alice", root)
	s.Challenge = "2026-11-20." + verifier.EncodeBase32(make([]byte, 16)) // well formed, never issued
	h.wantError(s, 400, "challenge_unknown")

	// Usable for less than 10 minutes.
	issued := tw(2026, 11, 20, 23, 55, 0)
	h.clock.Set(issued)
	s = h.sub("declare", newCard(), "alice", root)
	h.clock.Set(issued.Add(challengeLifetime))
	h.wantError(s, 400, "challenge_unknown")

	// One nanosecond earlier it is accepted, after midnight in Taiwan.
	h.clock.Set(issued)
	s = h.sub("declare", newCard(), "alice", root)
	h.clock.Set(issued.Add(challengeLifetime - time.Nanosecond))
	h.mustSubmit(s, "first")
	if !strings.HasPrefix(s.Challenge, "2026-11-20.") {
		t.Errorf("challenge %s", s.Challenge)
	}

	// Expired challenges are deleted, and stay unknown. A challenge issued
	// exactly 10 minutes ago is expired but deleted only on the next run.
	h.clock.Set(issued)
	s = h.sub("declare", newCard(), "alice", root)
	h.clock.Set(issued.Add(challengeLifetime))
	if n, err := h.server.deleteExpiredChallenges(); err != nil || n != 1 {
		t.Errorf("deleted %d %v", n, err) // the one issued at noon
	}
	h.wantError(s, 400, "challenge_unknown")
	h.clock.Set(issued.Add(challengeLifetime + time.Nanosecond))
	if n, err := h.server.deleteExpiredChallenges(); err != nil || n != 3 {
		t.Errorf("deleted %d %v", n, err) // the two expired, and the accepted one
	}
	h.wantError(s, 400, "challenge_unknown")
}

func TestChallengeUsed(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	s := h.sub("declare", newCard(), "alice", root)
	h.mustSubmit(s, "first")
	h.wantError(s, 400, "challenge_used")
	s.ScopedID = newCard() // another card proof with the same challenge
	h.wantError(s, 400, "challenge_used")
}

func TestChallengeAttempts(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)

	// A submission that fails leaves the challenge usable, up to 5.
	s := h.sub("declare", newCard(), "alice", root)
	bad := s
	bad.Proof = badProof
	for i := 0; i < 4; i++ {
		h.wantError(bad, 400, "proof")
	}
	h.mustSubmit(s, "first")

	s = h.sub("declare", newCard(), "alice", root)
	bad = s
	bad.Proof = badProof
	for i := 0; i < 5; i++ {
		h.wantError(bad, 400, "proof")
	}
	h.wantError(s, 400, "challenge_attempts")
	h.wantError(s, 400, "challenge_attempts")
}

func TestProof(t *testing.T) {
	crl := g3CRL(t)
	h := newHarness(t, startOfTests, crl)
	s := h.sub("declare", newCard(), "alice", rootOf(t, crl))
	s.Proof = badProof
	h.wantError(s, 400, "proof")
	if count, _, _ := h.store.Head(); count != 0 {
		t.Errorf("%d records", count)
	}
}

func TestRoot(t *testing.T) {
	// Three G3 CRLs with different roots; the server accepts the roots of
	// the two newest by CRL number.
	a := makeCRL(t, "G3", 1, crlTime.Add(-48*time.Hour), 1)
	b := makeCRL(t, "G3", 2, crlTime.Add(-24*time.Hour), 1, 2)
	c := makeCRL(t, "G3", 3, crlTime, 1, 2, 3)
	h := newHarness(t, startOfTests, c, a, b)
	h.wantError(h.sub("declare", newCard(), "alice", rootOf(t, a)), 400, "root")
	h.mustSubmit(h.sub("declare", newCard(), "alice", rootOf(t, b)), "first")
	h.mustSubmit(h.sub("declare", newCard(), "alice", rootOf(t, c)), "first")
	// A root of no CRL; a G2 root for a G3 record.
	h.wantError(h.sub("declare", newCard(), "alice", strings.Repeat("0", 63)+"1"), 400, "root")
	g2 := makeCRL(t, "G2", 4, crlTime, 7)
	h.addCRL(g2)
	h.wantError(h.sub("declare", newCard(), "alice", rootOf(t, g2)), 400, "root")
	// A file in the mirror that is not a usable CRL does not count as newest.
	h.addCRL([]byte("not a CRL"))
	h.mustSubmit(h.sub("declare", newCard(), "alice", rootOf(t, b)), "first")
}

func TestCRLStale(t *testing.T) {
	crl := g3CRL(t) // CRL date 2026-11-20
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)

	// At most 3 days old: the last second of 2026-11-23 in Taiwan.
	h.clock.Set(tw(2026, 11, 23, 23, 59, 59))
	s := h.sub("declare", newCard(), "alice", root)
	h.mustSubmit(s, "first")
	// The next second it is 4 days old.
	h.clock.Set(tw(2026, 11, 24, 0, 0, 0))
	h.wantError(h.sub("declare", newCard(), "alice", root), 503, "crl_stale")
	// A new CRL from MOICA, and card proofs are accepted again.
	h.addCRL(makeCRL(t, "G3", 2, crlTime.Add(4*24*time.Hour), 11, 12))
	h.mustSubmit(h.sub("declare", newCard(), "alice", root), "first")

	// No CRL of the issuer at all.
	g2 := h.sub("declare", newCard(), "alice", root)
	g2.Issuer, g2.Circuit = "G2", circuitOf("G2")
	h.wantError(g2, 503, "crl_stale")
}

func TestDateOrder(t *testing.T) {
	// Two CRLs with the same root, dated 2026-11-20 and 2026-11-25.
	early := makeCRL(t, "G3", 1, crlTime, 5)
	late := makeCRL(t, "G3", 2, crlTime.Add(5*24*time.Hour), 5)
	root := rootOf(t, late)
	h := newHarness(t, tw(2026, 11, 25, 12, 0, 0), early, late)
	h.mustSubmit(h.sub("declare", newCard(), "alice", root), "first")
	// The server's clock goes back to 2026-11-20: the challenge is dated 5
	// days before the latest valid record. The root is recognized (the
	// early CRL), but the date is out of order.
	h.clock.Set(startOfTests)
	h.wantError(h.sub("declare", newCard(), "alice", root), 400, "date_order")
	// 4 days back is still in order.
	h.clock.Set(tw(2026, 11, 21, 12, 0, 0))
	h.mustSubmit(h.sub("declare", newCard(), "alice", root), "first")
}

func TestNotCurrentAndSwitchLimit(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	card := newCard()
	h.wantError(h.sub("withdraw", card, "alice", root), 400, "not_current")
	h.mustSubmit(h.sub("declare", card, "alice", root), "first")
	h.mustSubmit(h.sub("declare", card, "alice", root), "refresh")
	h.wantError(h.sub("withdraw", card, "bob", root), 400, "not_current")
	h.mustSubmit(h.sub("declare", card, "bob", root), "switch")
	h.mustSubmit(h.sub("declare", card, "carol", root), "switch")
	h.wantError(h.sub("declare", card, "dave", root), 400, "switch_limit")
	h.mustSubmit(h.sub("declare", card, "carol", root), "refresh")
	h.mustSubmit(h.sub("withdraw", card, "carol", root), "withdraw")
	h.wantError(h.sub("withdraw", card, "carol", root), 400, "not_current")
	recs := h.checkChain()
	if len(recs) != 6 {
		t.Errorf("%d records; rejected card proofs must not be appended", len(recs))
	}
}
