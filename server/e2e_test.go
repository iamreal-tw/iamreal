//go:build iamrealtest

package main

// The whole way with real proofs, checked by bb: the mirror fetches CRLs
// from a fake MOICA, the server issues the challenges the proofs of
// testdata/ were made for, accepts and rejects them, the daily snapshot
// re-verifies every proof and publishes the roster directory, and
// iamreal-verify re-verifies that directory and finds the same state as
// the server. See testdata/README.md.
//
//	IAMREAL_BB=<bb 6.0.0> go test -tags iamrealtest ./server
//
// The issuer keys of the test proofs reach the verifier through
// verifier.NewWithIssuers, which exists only with the build tag
// iamrealtest. Without IAMREAL_BB the test is skipped. IAMREAL_CRS may name
// a directory holding bn254_g1.dat; without it the test writes that file.

import (
	"bytes"
	"context"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"math/big"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// nextRandom is the server's random source in this test: the test sets the
// 16 bytes of the next challenge.
type nextRandom struct {
	mu sync.Mutex
	b  []byte
}

func (n *nextRandom) set(b []byte) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.b = b
}

func (n *nextRandom) Read(p []byte) (int, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	c := copy(p, n.b)
	n.b = n.b[c:]
	return c, nil
}

func e2eKeys(t *testing.T) ([]crl.NamedKey, map[string]*big.Int) {
	t.Helper()
	var keys []crl.NamedKey
	moduli := map[string]*big.Int{}
	for _, name := range []string{"G2", "G3"} {
		der, err := os.ReadFile(filepath.Join("testdata", "issuer-"+name+".der"))
		if err != nil {
			t.Fatal(err)
		}
		k, err := x509.ParsePKIXPublicKey(der)
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, crl.NamedKey{Name: name, Key: k.(*rsa.PublicKey)})
		moduli[name] = k.(*rsa.PublicKey).N
	}
	return keys, moduli
}

func TestEndToEnd(t *testing.T) {
	bb := os.Getenv("IAMREAL_BB")
	if bb == "" {
		t.Skip("IAMREAL_BB is not set: no bb to run")
	}
	crs := os.Getenv("IAMREAL_CRS")
	if crs == "" {
		crs = t.TempDir()
		point := make([]byte, 64)
		point[31], point[63] = 1, 2
		if err := os.WriteFile(filepath.Join(crs, verifier.CRSFile), point, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	keys, moduli := e2eKeys(t)
	v, err := verifier.NewWithIssuers(verifier.Config{BB: bb, CRSDir: crs}, moduli)
	if err != nil {
		t.Fatal(err)
	}
	var proofs []struct {
		At     string     `json:"at"`
		Random string     `json:"random"`
		Body   submission `json:"body"`
		Status int        `json:"status"`
		Result string     `json:"result"` // the kinds as kindsOf writes them, or the error code
	}
	b, err := os.ReadFile(filepath.Join("testdata", "card-proofs.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &proofs); err != nil {
		t.Fatal(err)
	}
	crlFile := func(name string) []byte {
		b, err := os.ReadFile(filepath.Join("testdata", "crl", name))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	// MOICA publishes A (G2) and B (G3) on 2026-11-20, C (G3) on 2026-11-21.
	moica := &fakeMOICA{files: map[string][]byte{}, etags: map[string]string{}, modified: map[string]time.Time{}}
	moica.set("/g2.crl", crlFile("A-G2.crl"), `"a"`, crlTime)
	moica.set("/g3.crl", crlFile("B-G3.crl"), `"b"`, crlTime)
	srv := httptest.NewServer(moica)
	defer srv.Close()

	random := &nextRandom{}
	h := newHarness(t, tw(2026, 11, 20, 9, 0, 0))
	h.keys, h.proofs, h.random = keys, v, random
	// The policy on the fourth and fifth switch set (-restrict-late-switches):
	// card proof 10 of testdata/ is a fourth switch, refused with
	// switch_restricted (testdata/README.md).
	h.restrictLate = true
	mirror := &Mirror{Dir: crlDir(h.data), Keys: keys, Client: srv.Client(), Log: slog.New(slog.DiscardHandler),
		Sources: []crlSource{{"G2", srv.URL + "/g2.crl"}, {"G3", srv.URL + "/g3.crl"}}}
	if err := mirror.Fetch(context.Background()); err != nil {
		t.Fatal(err)
	}
	h.start()

	for i, p := range proofs {
		at, err := time.Parse(time.RFC3339, p.At)
		if err != nil {
			t.Fatal(err)
		}
		h.clock.Set(at)
		if at.Day() == 21 && !bytes.Equal(moica.files["/g3.crl"], crlFile("C-G3.crl")) {
			moica.set("/g3.crl", crlFile("C-G3.crl"), `"c"`, crlTime.Add(24*time.Hour))
			if err := mirror.Fetch(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
		r, _ := hex.DecodeString(p.Random)
		random.set(r)
		if c := h.challenge(); c != p.Body.Challenge {
			t.Fatalf("card proof %d: challenge %s, want %s", i+1, c, p.Body.Challenge)
		}
		if p.Status == 201 && len(p.Body.Accounts) > 0 {
			// The same proof with another list does not verify: the
			// declaration code is computed from the whole list. The
			// challenge stays usable.
			other := p.Body
			other.Accounts = append([]submittedAccount(nil), p.Body.Accounts...)
			other.Accounts[len(other.Accounts)-1].Username = "carl"
			h.wantError(other, 400, "proof")
			if len(p.Body.Accounts) == 2 {
				// One account fewer.
				other.Accounts = p.Body.Accounts[1:]
				h.wantError(other, 400, "proof")
				// The same list in the other order: the server does not
				// sort it.
				other.Accounts = []submittedAccount{p.Body.Accounts[1], p.Body.Accounts[0]}
				h.wantError(other, 400, "malformed")
			}
		}
		status, out := h.submit(p.Body)
		got := kindsOf(out)
		if status != 201 {
			got, _ = out["error"].(string)
		}
		if status != p.Status || got != p.Result {
			t.Fatalf("card proof %d (%v): %d %v, want %d %s", i+1, p.Body.Accounts, status, out, p.Status, p.Result)
		}
	}
	recs := h.checkRoster()
	if len(recs) != 11 {
		t.Fatalf("%d records", len(recs))
	}

	// The state the server answers.
	never := map[string]any{"current": nil, "last_declared": nil, "switch_count": 0.0, "correction_date": nil}
	g2Card, g3Card := proofs[0].Body.ScopedID, proofs[1].Body.ScopedID
	for card, want := range map[string]map[string]any{
		g2Card: {"last_card_proof": "2026-11-23", "proofs_on_last_date": 1.0, "platforms": map[string]any{
			"test-example": never,
			"threads":      map[string]any{"current": nil, "last_declared": "alice", "switch_count": 0.0, "correction_date": "2026-11-20"},
		}},
		g3Card: {"last_card_proof": "2026-11-24", "proofs_on_last_date": 3.0, "platforms": map[string]any{
			"test-example": map[string]any{"current": nil, "last_declared": "c-d", "switch_count": 1.0, "correction_date": "2026-11-21"},
			"threads":      map[string]any{"current": nil, "last_declared": "dave", "switch_count": 3.0, "correction_date": "2026-11-23"},
		}},
	} {
		_, out := h.do("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`)
		for k, w := range want {
			if !reflect.DeepEqual(out[k], w) {
				t.Errorf("card %s: %s is %v, want %v", card[:10], k, out[k], w)
			}
		}
	}

	// The daily snapshot, with every proof verified again by bb and the
	// CRL archive rebuilt.
	if code, stdout, stderr := h.snapshot("2026-11-24"); code != 0 {
		t.Fatalf("snapshot: exit %d\n%s\n%s", code, stdout, stderr)
	}

	// iamreal-verify, built with the test keys option, re-verifies the
	// published directory.
	cmd := filepath.Join(t.TempDir(), "iamreal-verify")
	build := exec.Command("go", "build", "-tags", "iamrealtest", "-o", cmd, "../cmd/iamreal-verify")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building iamreal-verify: %v\n%s", err, out)
	}
	var stdout, stderr bytes.Buffer
	verify := exec.Command(cmd, "-bb", bb, "-crs", crs, "-roster", "test", "-json",
		"-test-issuers", "testdata", "-crl-archive", crlDir(h.data), rosterDir(h.data))
	verify.Stdout, verify.Stderr = &stdout, &stderr
	if err := verify.Run(); err != nil {
		t.Fatalf("iamreal-verify: %v\n%s\n%s", err, stdout.String(), stderr.String())
	}
	for _, w := range []string{"fingerprints.jsonl: 1 line(s), every fingerprint is the roster's", "hashes/: 1 list(s), every list is the roster's"} {
		if !bytes.Contains(stderr.Bytes(), []byte(w)) {
			t.Errorf("iamreal-verify did not say %q:\n%s", w, stderr.String())
		}
	}
	var report struct {
		Valid       bool             `json:"valid"`
		Fingerprint string           `json:"fingerprint"`
		Results     []map[string]any `json:"results"`
		State       json.RawMessage  `json:"state"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, r := range report.Results {
		kinds = append(kinds, kindsOf(r))
	}
	var want []string
	for _, p := range proofs {
		if p.Status == 201 {
			want = append(want, p.Result)
		}
	}
	if !report.Valid || report.Fingerprint != roster.Fingerprint(recs) || !reflect.DeepEqual(kinds, want) {
		t.Errorf("iamreal-verify: %s\nkinds %q\nwant %q", stdout.String(), kinds, want)
	}
	// The same state as the server's.
	h.server.mu.RLock()
	serverState := stateJSON(h.server.rules.State())
	h.server.mu.RUnlock()
	var verifyState, ours any
	json.Unmarshal(report.State, &verifyState)
	json.Unmarshal(serverState, &ours)
	if !reflect.DeepEqual(verifyState, ours) {
		t.Errorf("iamreal-verify's state\n%s\nthe server's\n%s", report.State, serverState)
	}

	// The program's own verifier, with MOICA's keys, rejects every test
	// proof: the snapshot refuses.
	prod, err := verifier.New(verifier.Config{BB: bb, CRSDir: crs})
	if err != nil {
		t.Fatal(err)
	}
	h.proofs = prod
	if code, _, stderr := h.snapshot("2026-11-25"); code != snapshotRefused || !bytes.Contains([]byte(stderr), []byte("11 invalid record(s)")) {
		t.Errorf("MOICA's keys: exit %d\n%s", code, stderr)
	}
}

// stateJSON writes the state in the shape of spec/vectors/roster-rules.json
// ("state", without the items the output does not list), the shape of
// iamreal-verify -json.
func stateJSON(st *roster.State) []byte {
	type listAccount struct {
		Platform string `json:"platform"`
		Username string `json:"username"`
	}
	type card struct {
		ScopedID      string        `json:"scoped_id"`
		LastCardProof string        `json:"last_card_proof"`
		Accounts      []listAccount `json:"accounts"`
	}
	type accountCard struct {
		ScopedID      string `json:"scoped_id"`
		LastCardProof string `json:"last_card_proof"`
	}
	type account struct {
		Platform string        `json:"platform"`
		Username string        `json:"username"`
		Cards    []accountCard `json:"cards"`
	}
	type scope struct {
		ScopeString string    `json:"scope_string"`
		Cards       []card    `json:"cards"`
		Accounts    []account `json:"accounts"`
	}
	out := []scope{}
	for _, s := range st.Scopes {
		so := scope{ScopeString: s.ScopeString, Cards: []card{}, Accounts: []account{}}
		for _, c := range s.Cards {
			co := card{ScopedID: c.ScopedID, LastCardProof: c.LastCardProof.String(), Accounts: []listAccount{}}
			for _, a := range c.Accounts {
				co.Accounts = append(co.Accounts, listAccount{a.Platform, a.Username})
			}
			so.Cards = append(so.Cards, co)
		}
		for _, a := range s.Accounts {
			ao := account{Platform: a.Platform, Username: a.Username, Cards: []accountCard{}}
			for _, c := range a.Cards {
				ao.Cards = append(ao.Cards, accountCard{c.ScopedID, c.LastCardProof.String()})
			}
			so.Accounts = append(so.Accounts, ao)
		}
		out = append(out, so)
	}
	b, _ := json.Marshal(out)
	return b
}
