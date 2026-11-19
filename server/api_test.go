package main

// Every endpoint, and every error code of each, with the fake proof
// verifier. Real proofs: e2e_test.go.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/roster"
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
	want := map[string]any{"crl_max_age_days": 3.0, "platforms": []any{
		map[string]any{"platform": "test-example", "display_name": "Example (no real service)", "username_format": "[a-z0-9-]{1,20}"},
		map[string]any{"platform": "threads", "display_name": "Threads", "username_format": "[a-z0-9._]{1,30}"},
	}}
	if status != 200 || !reflect.DeepEqual(body, want) {
		t.Errorf("config: %d %v", status, body)
	}
	// The keys in the order of the API document.
	if raw := h.raw("GET", "/api/v1/config", "").Body.String(); !strings.HasPrefix(raw, `{"crl_max_age_days":3,"platforms":[{"platform":"test-example","display_name":"Example (no real service)","username_format":"[a-z0-9-]{1,20}"},`) {
		t.Errorf("config body %s", raw)
	}
	status, body = h.do("GET", "/api/v1/head", "")
	if status != 200 || body["count"] != 0.0 || body["head"] != roster.EmptyFingerprint {
		t.Errorf("empty head: %d %v", status, body)
	}
	h.mustSubmit(h.sub(newCard(), rootOf(t, g3CRL(t)), "threads:alice"), "threads first")
	recs := h.checkChain()
	_, body = h.do("GET", "/api/v1/head", "")
	if body["count"] != 1.0 || body["head"] != roster.Fingerprint(recs) {
		t.Errorf("head: %v", body)
	}
}

// The platform table of config, for each roster: the rows of
// verifier.Platforms, in ascending order, and every username_format is in
// the one form of spec/scope.md, `[…]{m,n}`, and accepts exactly what the
// platform's check function accepts.
func TestConfigPlatforms(t *testing.T) {
	for _, r := range []verifier.Roster{verifier.Production, verifier.Test} {
		h := newHarness(t, startOfTests)
		h.roster = r
		h.start()
		_, body := h.do("GET", "/api/v1/config", "")
		rows, _ := body["platforms"].([]any)
		table := verifier.Platforms(r)
		if len(rows) != len(table) {
			t.Fatalf("%s: %d rows, the table has %d", r, len(rows), len(table))
		}
		for i, row := range rows {
			m, _ := row.(map[string]any)
			id, _ := m["platform"].(string)
			format, _ := m["username_format"].(string)
			if id != table[i].ID || m["display_name"] != table[i].DisplayName || len(m) != 3 {
				t.Errorf("%s: row %d is %v", r, i, m)
			}
			accept, err := parseUsernameFormat(format)
			if err != nil {
				t.Errorf("%s: %s: %q: %v", r, id, format, err)
				continue
			}
			p, _ := verifier.LookupPlatform(r, id)
			for _, u := range usernameProbes() {
				if accept(u) != p.ValidUsername(u) {
					t.Errorf("%s: %q: the format says %v, the check function %v", id, u, accept(u), p.ValidUsername(u))
				}
			}
		}
	}
	if _, err := parseUsernameFormat("[a-z]+"); err == nil {
		t.Errorf("a format outside the form was read")
	}
}

// parseUsernameFormat reads the one form of a username format of
// spec/scope.md, a character class and a length range, `[…]{m,n}`, the way
// a device would: without a regular expression library. In the class, `x-y`
// is a range and any other character stands for itself.
func parseUsernameFormat(f string) (func(string) bool, error) {
	open, close := strings.IndexByte(f, '['), strings.LastIndexByte(f, ']')
	if open != 0 || close < 2 {
		return nil, errors.New("not a character class first")
	}
	class := f[1:close]
	var m, n int
	if _, err := fmt.Sscanf(f[close+1:], "{%d,%d}", &m, &n); err != nil || fmt.Sprintf("{%d,%d}", m, n) != f[close+1:] || m < 1 || n < m {
		return nil, errors.New("not a length range")
	}
	in := func(c byte) bool {
		for i := 0; i < len(class); i++ {
			if i+2 < len(class) && class[i+1] == '-' {
				if class[i] <= c && c <= class[i+2] {
					return true
				}
				i += 2
				continue
			}
			if class[i] == c {
				return true
			}
		}
		return false
	}
	return func(u string) bool {
		if len(u) < m || len(u) > n {
			return false
		}
		for i := 0; i < len(u); i++ {
			if !in(u[i]) {
				return false
			}
		}
		return true
	}, nil
}

// usernameProbes are strings to tell two username checks apart: every
// single byte, every byte after and before a letter, and runs of a letter
// around each length limit of spec/scope.md.
func usernameProbes() []string {
	out := []string{""}
	for c := 0; c < 256; c++ {
		out = append(out, string([]byte{byte(c)}), string([]byte{'a', byte(c)}), string([]byte{byte(c), 'a'}))
	}
	for n := 1; n <= 32; n++ {
		out = append(out, strings.Repeat("a", n), strings.Repeat("-", n), strings.Repeat(".", n))
	}
	return out
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

var neverUsed = map[string]any{"current": nil, "last_declared": nil, "switch_count": 0.0, "correction_date": nil}

func TestCardState(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	card := newCard()
	ask := func() (int, map[string]any) {
		return h.do("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`)
	}

	// A card with no record: not an error; one entry for every platform of
	// the test roster.
	status, body := ask()
	want := map[string]any{
		"last_card_proof": nil, "proofs_on_last_date": 0.0,
		"platforms": map[string]any{"test-example": neverUsed, "threads": neverUsed},
		"count":     0.0, "head": roster.EmptyFingerprint,
	}
	if status != 200 || !reflect.DeepEqual(body, want) {
		t.Errorf("no record: %d %v", status, body)
	}

	h.mustSubmit(h.sub(card, root, "threads:alice"), "threads first")
	h.day(1)
	h.mustSubmit(h.sub(card, root, "test-example:a-b", "threads:bob"), "test-example first, threads switch")
	h.mustSubmit(h.sub(card, root, "test-example:a-b"), "test-example refresh, threads withdraw")
	h.mustSubmit(h.sub(newCard(), root, "threads:alice"), "threads first") // another card
	recs := h.checkChain()
	status, body = ask()
	want = map[string]any{
		"last_card_proof": "2026-11-21", "proofs_on_last_date": 2.0,
		"platforms": map[string]any{
			"test-example": map[string]any{"current": "a-b", "last_declared": "a-b", "switch_count": 0.0, "correction_date": "2026-11-21"},
			"threads":      map[string]any{"current": nil, "last_declared": "bob", "switch_count": 1.0, "correction_date": "2026-11-21"},
		},
		"count": 4.0, "head": roster.Fingerprint(recs),
	}
	if status != 200 || !reflect.DeepEqual(body, want) {
		t.Errorf("after the withdrawal: %d %v", status, body)
	}
	// The keys are in the order of the API document.
	raw := h.raw("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`).Body.String()
	if !strings.HasPrefix(raw, `{"last_card_proof":"2026-11-21","proofs_on_last_date":2,"platforms":{"test-example":{"current":"a-b","last_declared":"a-b","switch_count":0,"correction_date":"2026-11-21"},"threads":{"current":null,"last_declared":"bob","switch_count":1,"correction_date":"2026-11-21"}},"count":4,"head":"`) {
		t.Errorf("body %s", raw)
	}
}

// day moves the server's clock to noon of the date n days after
// startOfTests, and gives the mirror a G3 CRL of that date with the serial
// numbers of g3CRL: the same root, so it stays one of the two newest, and
// the newest CRL is never more than 3 days old.
func (h *harness) day(n int) {
	h.t.Helper()
	h.addCRL(makeCRL(h.t, "G3", int64(1+n), crlTime.Add(time.Duration(n)*24*time.Hour), 11, 12))
	h.clock.Set(startOfTests.Add(time.Duration(n) * 24 * time.Hour))
}

// A production server answers for the platforms of the production table
// only, and refuses a test platform as `platform`.
func TestProductionRoster(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	h.roster = verifier.Production
	h.start()
	const scope = "iamreal:public:0_______________"
	card := newCard()
	status, body := h.do("POST", "/api/v1/card-state", `{"scope_string":"`+scope+`","scoped_id":"`+card+`"}`)
	if status != 200 || !reflect.DeepEqual(body["platforms"], map[string]any{"threads": neverUsed}) {
		t.Errorf("card-state: %d %v", status, body)
	}
	s := h.sub(card, root, "test-example:a-b", "threads:alice")
	s.ScopeString = scope
	h.wantError(s, 400, "platform")
	s.Accounts = list("threads:alice")
	h.mustSubmit(s, "threads first")
	s = h.sub(card, root, "threads:alice")
	h.wantError(s, 400, "scope") // the test scope
}

func TestCardStateMalformed(t *testing.T) {
	h := newHarness(t, startOfTests)
	card := newCard()
	for name, body := range map[string]string{
		"empty":                 "",
		"not an object":         `["` + testScope + `"]`,
		"missing key":           `{"scope_string":"` + testScope + `"}`,
		"extra key":             `{"scope_string":"` + testScope + `","scoped_id":"` + card + `","username":"alice"}`,
		"a platform":            `{"scope_string":"` + testScope + `","scoped_id":"` + card + `","platform":"threads"}`,
		"key twice":             `{"scope_string":"` + testScope + `","scoped_id":"` + card + `","scoped_id":"` + card + `"}`,
		"key in another case":   `{"Scope_string":"` + testScope + `","scoped_id":"` + card + `"}`,
		"number":                `{"scope_string":"` + testScope + `","scoped_id":7}`,
		"null":                  `{"scope_string":"` + testScope + `","scoped_id":null}`,
		"after the object":      `{"scope_string":"` + testScope + `","scoped_id":"` + card + `"}{}`,
		"production scope":      `{"scope_string":"iamreal:public:0_______________","scoped_id":"` + card + `"}`,
		"unknown scope":         `{"scope_string":"iamreal-test:public:1__________","scoped_id":"` + card + `"}`,
		"scope of one platform": `{"scope_string":"iamreal-test:threads:0_________","scoped_id":"` + card + `"}`,
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
	good := h.sub(newCard(), root, "test-example:a-b", "threads:alice")
	edits := map[string]func(s *submission){
		"username in uppercase":             func(s *submission) { s.Accounts = list("threads:Alice") },
		"username too long":                 func(s *submission) { s.Accounts = list("threads:" + strings.Repeat("a", 31)) },
		"username empty":                    func(s *submission) { s.Accounts = list("threads:") },
		"username with a quote":             func(s *submission) { s.Accounts = list(`threads:ali"ce`) },
		"username with a backslash":         func(s *submission) { s.Accounts = list(`threads:ali\ce`) },
		"username with a line feed":         func(s *submission) { s.Accounts = list("threads:alice\n") },
		"username with @":                   func(s *submission) { s.Accounts = list("threads:@alice") },
		"username of another platform: a.b": func(s *submission) { s.Accounts = list("test-example:a.b") },
		"username of another platform: a-b": func(s *submission) { s.Accounts = list("threads:a-b") },
		"a platform twice, same username":   func(s *submission) { s.Accounts = list("threads:alice", "threads:alice") },
		"a platform twice, other usernames": func(s *submission) { s.Accounts = list("threads:alice", "threads:bob") },
		// Not sorted by the server: the same list in ascending order is
		// the good submission.
		"accounts in descending order": func(s *submission) { s.Accounts = list("threads:alice", "test-example:a-b") },
		"accounts null":                func(s *submission) { s.Accounts = nil },
		"scoped ID":                    func(s *submission) { s.ScopedID = strings.ToLower(s.ScopedID) },
		"challenge padding bits":       func(s *submission) { s.Challenge = s.Challenge[:36] + "1" },
		"challenge date":               func(s *submission) { s.Challenge = "2026-02-29" + s.Challenge[10:] },
		"issuer":                       func(s *submission) { s.Issuer = "G4" },
		"smt_root uppercase":           func(s *submission) { s.SMTRoot = strings.ToUpper(s.SMTRoot) },
		"smt_root not below p":         func(s *submission) { s.SMTRoot = strings.Repeat("f", 64) },
		"circuit":                      func(s *submission) { s.Circuit = s.Circuit[:63] },
		"proof one byte short":         func(s *submission) { s.Proof = base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength-1)) },
		"proof one byte long":          func(s *submission) { s.Proof = base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength+1)) },
		"proof without padding":        func(s *submission) { s.Proof = strings.TrimRight(s.Proof, "=") },
		"proof in another spelling":    func(s *submission) { s.Proof = s.Proof[:len(s.Proof)-2] + "B=" },
		"proof with a line feed":       func(s *submission) { s.Proof = s.Proof[:100] + "\n" + s.Proof[101:] },
	}
	for name, edit := range edits {
		s := good
		edit(&s)
		if status, out := h.submit(s); status != 400 || out["error"] != "malformed" {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	b, _ := json.Marshal(good)
	accounts := `"accounts":[{"platform":"test-example","username":"a-b"},{"platform":"threads","username":"alice"}]`
	if !strings.Contains(string(b), accounts) {
		t.Fatalf("%s", b)
	}
	withAccounts := func(s string) string { return strings.Replace(string(b), accounts, `"accounts":`+s, 1) }
	for name, body := range map[string]string{
		"not JSON":                     "declare alice",
		"missing field":                strings.Replace(string(b), `"issuer":"G3",`, "", 1),
		"extra field":                  strings.Replace(string(b), `{`, `{"seq":1,`, 1),
		"field twice":                  strings.Replace(string(b), `{`, `{"issuer":"G3",`, 1),
		"an action":                    strings.Replace(string(b), `{`, `{"action":"declare",`, 1),
		"a username outside the list":  strings.Replace(string(b), `{`, `{"username":"alice",`, 1),
		"accounts missing":             strings.Replace(string(b), accounts+",", "", 1),
		"accounts twice":               strings.Replace(string(b), accounts, accounts+","+accounts, 1),
		"accounts in another case":     strings.Replace(string(b), `"accounts":`, `"Accounts":`, 1),
		"accounts an object":           withAccounts(`{"platform":"threads","username":"alice"}`),
		"accounts a string":            withAccounts(`"[]"`),
		"an account as a string":       withAccounts(`["threads:alice"]`),
		"a list inside the list":       withAccounts(`[[{"platform":"threads","username":"alice"}]]`),
		"an account without username":  withAccounts(`[{"platform":"threads"}]`),
		"an account with an extra key": withAccounts(`[{"platform":"threads","username":"alice","note":"x"}]`),
		"a key twice in an account":    withAccounts(`[{"platform":"threads","username":"alice","username":"bob"}]`),
		"a key in another case":        withAccounts(`[{"Platform":"threads","username":"alice"}]`),
		"a username that is a number":  withAccounts(`[{"platform":"threads","username":7}]`),
		"a username null":              withAccounts(`[{"platform":"threads","username":null}]`),
		// An entry that is not two strings, next to a platform outside the
		// table: the list is not shaped as `platform` requires.
		"a bad entry and an unknown platform": withAccounts(`[{"platform":"instagram","username":"alice"},{"platform":"threads"}]`),
	} {
		if status, out := h.do("POST", "/api/v1/records", body); status != 400 || out["error"] != "malformed" {
			t.Errorf("%s: %d %v", name, status, out)
		}
	}
	// The keys of an account in the other order, and whitespace, are JSON
	// like any other: the server writes the record's line itself.
	s := good
	ws := strings.Replace(withAccounts(` [ {"username":"a-b", "platform":"test-example"} , {"platform":"threads","username":"alice"} ] `), `{`, `{ `, 1)
	// None of the above counted as a submission of the challenge, and the
	// challenge is still usable.
	if status, out := h.do("POST", "/api/v1/records", ws); status != 201 || kindsOf(out) != "test-example first, threads first" {
		t.Errorf("whitespace and key order: %d %v", status, out)
	}
	h.wantError(s, 400, "challenge_used")
}

func TestRecordsScope(t *testing.T) {
	crl := g3CRL(t)
	h := newHarness(t, startOfTests, crl)
	s := h.sub(newCard(), rootOf(t, crl), "threads:alice")
	for _, scope := range []string{
		"iamreal:public:0_______________", // the production roster's
		"iamreal-test:x:0_______________",
		"iamreal-test:threads:0_________", // one platform per scope, before ADR-0017
	} {
		s.ScopeString = scope
		h.wantError(s, 400, "scope")
	}
	// scope before platform and malformed.
	s.Accounts = list("instagram:alice")
	h.wantError(s, 400, "scope")
	s.Accounts = list("threads:Alice")
	h.wantError(s, 400, "scope")
	s.Accounts = nil
	h.wantError(s, 400, "scope")
}

func TestRecordsPlatform(t *testing.T) {
	crl := g3CRL(t)
	h := newHarness(t, startOfTests, crl)
	good := h.sub(newCard(), rootOf(t, crl), "threads:alice")
	for name, accounts := range map[string][]submittedAccount{
		"not in the table":          list("instagram:alice"),
		"another spelling":          list("Threads:alice"),
		"another spelling, `_`":     list("threads_:alice"),
		"next to a good account":    list("instagram:alice", "threads:alice"),
		"before a bad username":     list("instagram:alice", "threads:Alice"),
		"in order after a good one": list("test-example:a-b", "threads:alice", "x:y"),
		"repeated, unknown":         list("x:a", "x:a"),
	} {
		s := good
		s.Accounts = accounts
		if status, out := h.submit(s); status != 400 || out["error"] != "platform" {
			t.Errorf("%s: %d %v", name, status, out)
		}
		// The proof is not even looked at.
		s.Proof = badProof
		if status, out := h.submit(s); status != 400 || out["error"] != "platform" {
			t.Errorf("%s, bad proof: %d %v", name, status, out)
		}
	}
	// None of these counted towards the 5 submissions.
	h.mustSubmit(good, "threads first")
}

func TestChallengeUnknown(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)

	s := h.sub(newCard(), root, "threads:alice")
	s.Challenge = "2026-11-20." + verifier.EncodeBase32(make([]byte, 16)) // well formed, never issued
	h.wantError(s, 400, "challenge_unknown")

	// Usable for less than 10 minutes.
	issued := tw(2026, 11, 20, 23, 55, 0)
	h.clock.Set(issued)
	s = h.sub(newCard(), root, "threads:alice")
	h.clock.Set(issued.Add(challengeLifetime))
	h.wantError(s, 400, "challenge_unknown")

	// One nanosecond earlier it is accepted, after midnight in Taiwan.
	h.clock.Set(issued)
	s = h.sub(newCard(), root, "threads:alice")
	h.clock.Set(issued.Add(challengeLifetime - time.Nanosecond))
	h.mustSubmit(s, "threads first")
	if !strings.HasPrefix(s.Challenge, "2026-11-20.") {
		t.Errorf("challenge %s", s.Challenge)
	}

	// Expired challenges are deleted, and stay unknown. A challenge issued
	// exactly 10 minutes ago is expired but deleted only on the next run.
	h.clock.Set(issued)
	s = h.sub(newCard(), root, "threads:alice")
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
	s := h.sub(newCard(), root, "threads:alice")
	h.mustSubmit(s, "threads first")
	h.wantError(s, 400, "challenge_used")
	s.ScopedID = newCard() // another card proof with the same challenge
	h.wantError(s, 400, "challenge_used")
}

func TestChallengeAttempts(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)

	// A submission that fails leaves the challenge usable, up to 5.
	s := h.sub(newCard(), root, "threads:alice")
	bad := s
	bad.Proof = badProof
	for i := 0; i < 4; i++ {
		h.wantError(bad, 400, "proof")
	}
	h.mustSubmit(s, "threads first")

	s = h.sub(newCard(), root, "threads:alice")
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
	s := h.sub(newCard(), rootOf(t, crl), "threads:alice")
	s.Proof = badProof
	h.wantError(s, 400, "proof")
	if count, _ := h.store.Count(); count != 0 {
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
	h.wantError(h.sub(newCard(), rootOf(t, a), "threads:alice"), 400, "root")
	h.mustSubmit(h.sub(newCard(), rootOf(t, b), "threads:alice"), "threads first")
	h.mustSubmit(h.sub(newCard(), rootOf(t, c), "threads:alice"), "threads first")
	// A root of no CRL; a G2 root for a G3 record.
	h.wantError(h.sub(newCard(), strings.Repeat("0", 63)+"1", "threads:alice"), 400, "root")
	g2 := makeCRL(t, "G2", 4, crlTime, 7)
	h.addCRL(g2)
	h.wantError(h.sub(newCard(), rootOf(t, g2), "threads:alice"), 400, "root")
	// A file in the mirror that is not a usable CRL does not count as newest.
	h.addCRL([]byte("not a CRL"))
	h.mustSubmit(h.sub(newCard(), rootOf(t, b), "threads:alice"), "threads first")
}

func TestCRLStale(t *testing.T) {
	crl := g3CRL(t) // CRL date 2026-11-20
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)

	// At most 3 days old: the last second of 2026-11-23 in Taiwan.
	h.clock.Set(tw(2026, 11, 23, 23, 59, 59))
	s := h.sub(newCard(), root, "threads:alice")
	h.mustSubmit(s, "threads first")
	// The next second it is 4 days old.
	h.clock.Set(tw(2026, 11, 24, 0, 0, 0))
	h.wantError(h.sub(newCard(), root, "threads:alice"), 503, "crl_stale")
	// A new CRL from MOICA, and card proofs are accepted again.
	h.addCRL(makeCRL(t, "G3", 2, crlTime.Add(4*24*time.Hour), 11, 12))
	h.mustSubmit(h.sub(newCard(), root, "threads:alice"), "threads first")

	// No CRL of the issuer at all.
	g2 := h.sub(newCard(), root, "threads:alice")
	g2.Issuer, g2.Circuit = "G2", circuitOf("G2")
	h.wantError(g2, 503, "crl_stale")
}

func TestDateOrder(t *testing.T) {
	// Two CRLs with the same root, dated 2026-11-20 and 2026-11-25.
	early := makeCRL(t, "G3", 1, crlTime, 5)
	late := makeCRL(t, "G3", 2, crlTime.Add(5*24*time.Hour), 5)
	root := rootOf(t, late)
	h := newHarness(t, tw(2026, 11, 25, 12, 0, 0), early, late)
	h.mustSubmit(h.sub(newCard(), root, "threads:alice"), "threads first")
	// The server's clock goes back to 2026-11-20: the challenge is dated 5
	// days before the latest valid record. The root is recognized (the
	// early CRL), but the date is out of order.
	h.clock.Set(startOfTests)
	h.wantError(h.sub(newCard(), root, "threads:alice"), 400, "date_order")
	// 4 days back is still in order.
	h.clock.Set(tw(2026, 11, 21, 12, 0, 0))
	h.mustSubmit(h.sub(newCard(), root, "threads:alice"), "threads first")
}

// kinds and account_cards (docs/api/card-proof.md): one entry per platform
// with a kind, in ascending order of platform; account_cards is the number
// of cards whose current account on that platform is that username once the
// record is applied.
func TestKindsAndAccountCards(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	a, b := newCard(), newCard()
	type kind struct {
		Platform     string  `json:"platform"`
		Kind         string  `json:"kind"`
		Username     string  `json:"username"`
		AccountCards float64 `json:"account_cards"`
	}
	steps := []struct {
		day      int
		card     string
		accounts []string
		want     []kind
	}{
		{0, a, []string{"threads:alice"}, []kind{{"threads", "first", "alice", 1}}},
		// Another card declares the same account, and alice on test-example,
		// which is another account.
		{0, b, []string{"test-example:alice", "threads:alice"}, []kind{{"test-example", "first", "alice", 1}, {"threads", "first", "alice", 2}}},
		// The next day, a leaves alice for bob; alice has one card left.
		{1, a, []string{"threads:bob"}, []kind{{"threads", "switch", "bob", 1}}},
		// b withdraws alice on threads by leaving it out: the cards that
		// still declare it.
		{1, b, []string{"test-example:alice"}, []kind{{"test-example", "refresh", "alice", 1}, {"threads", "withdraw", "alice", 0}}},
		// The same day, a changes bob again: a correction.
		{1, a, []string{"threads:carol"}, []kind{{"threads", "correction", "carol", 1}}},
		{1, b, nil, []kind{{"test-example", "withdraw", "alice", 0}}},
		{2, a, []string{"test-example:alice", "threads:alice"}, []kind{{"test-example", "first", "alice", 1}, {"threads", "switch", "alice", 1}}},
	}
	for i, s := range steps {
		if s.day > 0 && h.clock.Now().Before(startOfTests.Add(time.Duration(s.day)*24*time.Hour)) {
			h.day(s.day)
		}
		status, out := h.submit(h.sub(s.card, root, s.accounts...))
		raw, _ := json.Marshal(out["kinds"])
		var got []kind
		json.Unmarshal(raw, &got)
		if status != 201 || !reflect.DeepEqual(got, s.want) {
			t.Fatalf("step %d: %d %v, want %+v", i+1, status, out, s.want)
		}
	}
	// An error has no kinds.
	status, out := h.submit(h.sub(newCard(), root))
	if _, has := out["kinds"]; status != 400 || out["error"] != "empty" || has {
		t.Errorf("an error: %d %v", status, out)
	}
	// The fields, in their order.
	body, _ := json.Marshal(h.sub(a, root, "test-example:alice", "threads:alice"))
	rec := h.raw("POST", "/api/v1/records", string(body))
	if got := rec.Body.String(); !regexp.MustCompile(`^\{"seq":\d+,"record_hash":"[0-9a-f]{64}","kinds":\[\{"platform":"test-example","kind":"refresh","username":"alice","account_cards":1\},\{"platform":"threads","kind":"refresh","username":"alice","account_cards":1\}\]\}\n$`).MatchString(got) {
		t.Errorf("the fields and their order: %s", got)
	}
}

func TestEmptyAndSwitchLimit(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, startOfTests, crl)
	h.start()
	card := newCard()
	state := func() map[string]any {
		_, out := h.do("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`)
		return out
	}
	// The empty list of a card with no account states nothing.
	h.wantError(h.sub(card, root), 400, "empty")
	h.mustSubmit(h.sub(card, root, "threads:a"), "threads first")
	// A change on the date of the first is a correction, not counted.
	h.mustSubmit(h.sub(card, root, "threads:b"), "threads correction")
	// Five switches on five dates; a correction after the fifth, on its
	// date, is still free.
	for i, u := range []string{"c", "d", "e", "f", "g"} {
		h.day(i + 1)
		h.mustSubmit(h.sub(card, root, "threads:"+u), "threads switch")
	}
	h.mustSubmit(h.sub(card, root, "test-example:a-b", "threads:h"), "test-example first, threads correction")
	if th := state()["platforms"].(map[string]any)["threads"].(map[string]any); th["switch_count"] != 5.0 || th["correction_date"] != "2026-11-25" {
		t.Errorf("after five switches: %v", th)
	}
	h.day(6)
	before := state()
	// A sixth switch blocks the whole record: test-example is not changed
	// either.
	h.wantError(h.sub(card, root, "test-example:c-d", "threads:i"), 400, "switch_limit")
	if after := state(); !reflect.DeepEqual(before, after) {
		t.Errorf("a blocked record changed the state:\n%v\n%v", before, after)
	}
	// threads left alone (the same account, or none): test-example can
	// change.
	h.mustSubmit(h.sub(card, root, "test-example:c-d", "threads:h"), "test-example switch, threads refresh")
	h.mustSubmit(h.sub(card, root, "test-example:c-d"), "test-example refresh, threads withdraw")
	// The empty list withdraws everything; then it is empty again.
	h.mustSubmit(h.sub(card, root), "test-example withdraw")
	h.day(7)
	h.wantError(h.sub(card, root), 400, "empty")
	// Declaring the account a blocked switch tried to leave is a refresh;
	// the sixth switch stays blocked.
	h.mustSubmit(h.sub(card, root, "threads:h"), "threads refresh")
	h.wantError(h.sub(card, root, "threads:i"), 400, "switch_limit")
	if recs := h.checkChain(); len(recs) != 12 {
		t.Errorf("%d records; rejected card proofs must not be appended", len(recs))
	}
}

// switch_restricted (docs/api/card-proof.md): accepted by default, as the
// roster rules do. With the policy set (-restrict-late-switches), a record
// that would use the fourth or fifth switch of a slot is 403 and not
// appended; the first three, corrections, and every other kind are never
// refused on this ground.
func TestSwitchRestricted(t *testing.T) {
	for _, restrict := range []bool{false, true} {
		t.Run(fmt.Sprintf("restrict=%v", restrict), func(t *testing.T) {
			crl := g3CRL(t)
			root := rootOf(t, crl)
			h := newHarness(t, startOfTests, crl)
			h.restrictLate = restrict
			h.start()
			card := newCard()
			h.mustSubmit(h.sub(card, root, "threads:a"), "threads first")
			for i, u := range []string{"b", "c", "d"} { // switches 1 to 3
				h.day(i + 1)
				h.mustSubmit(h.sub(card, root, "threads:"+u), "threads switch")
			}
			h.mustSubmit(h.sub(card, root, "threads:dd"), "threads correction") // after the third, free
			h.day(4)
			// Not a switch on the slot with 3: refresh, withdraw, first
			// elsewhere.
			h.mustSubmit(h.sub(card, root, "test-example:a-b", "threads:dd"), "test-example first, threads refresh")
			// A correction on another slot: never refused.
			h.mustSubmit(h.sub(card, root, "test-example:c-d", "threads:dd"), "test-example correction, threads refresh")
			fourth := h.sub(card, root, "test-example:c-d", "threads:e")
			if restrict {
				h.wantError(fourth, 403, "switch_restricted")
				// The whole list is refused, nothing recorded; the challenge
				// stays usable, and a list without the switch is accepted.
				if n := len(h.checkChain()); n != 7 {
					t.Errorf("%d records", n)
				}
				fourth.Accounts = list("test-example:c-d")
				h.mustSubmit(fourth, "test-example refresh, threads withdraw")
				h.day(5)
				h.wantError(h.sub(card, root, "threads:e"), 403, "switch_restricted")
				// A record the rules refuse gets the rules' code first.
				h.wantError(h.sub(newCard(), root), 400, "empty")
				return
			}
			h.mustSubmit(fourth, "test-example refresh, threads switch")
			h.day(5)
			h.mustSubmit(h.sub(card, root, "test-example:c-d", "threads:f"), "test-example refresh, threads switch")
			h.mustSubmit(h.sub(card, root, "test-example:c-d", "threads:ff"), "test-example refresh, threads correction")
			h.day(6)
			// The sixth: the rules' code, whatever the policy.
			h.wantError(h.sub(card, root, "threads:g"), 400, "switch_limit")
		})
	}
}

func TestDailyLimit(t *testing.T) {
	crl := g3CRL(t)
	root := rootOf(t, crl)
	h := newHarness(t, tw(2026, 11, 20, 23, 55, 0), crl)
	card := newCard()
	state := func() map[string]any {
		_, out := h.do("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`)
		return out
	}
	h.mustSubmit(h.sub(card, root, "threads:alice"), "threads first")
	// Records the rules reject do not count.
	h.wantError(h.sub(newCard(), root), 400, "empty")
	h.mustSubmit(h.sub(card, root, "test-example:a-b", "threads:bob"), "test-example first, threads correction")
	h.mustSubmit(h.sub(card, root, "test-example:a-b"), "test-example refresh, threads withdraw")
	if out := state(); out["last_card_proof"] != "2026-11-20" || out["proofs_on_last_date"] != 3.0 {
		t.Errorf("after 3 records: %v", out)
	}
	// The fourth of the day, whatever it changes on whichever platform, is
	// not appended; the challenge stays usable.
	s := h.sub(card, root, "test-example:a-b", "threads:bob")
	h.wantError(s, 400, "daily_limit")
	h.wantError(h.sub(card, root), 400, "daily_limit")
	// Another card on the same day is not limited.
	h.mustSubmit(h.sub(newCard(), root, "threads:alice"), "threads first")
	if recs := h.checkChain(); len(recs) != 4 {
		t.Errorf("%d records; rejected card proofs must not be appended", len(recs))
	}
	if out := state(); out["proofs_on_last_date"] != 3.0 || current(out, "threads") != nil {
		t.Errorf("after daily_limit: %v", out)
	}
	// The next day in Taiwan. A challenge issued before midnight is dated
	// the day before, so the same submission is still the fourth of its
	// date.
	h.clock.Set(tw(2026, 11, 21, 0, 0, 0))
	h.wantError(s, 400, "daily_limit")
	h.mustSubmit(h.sub(card, root, "test-example:a-b", "threads:bob"), "test-example refresh, threads refresh")
	if out := state(); out["last_card_proof"] != "2026-11-21" || out["proofs_on_last_date"] != 1.0 {
		t.Errorf("the next day: %v", out)
	}
}
