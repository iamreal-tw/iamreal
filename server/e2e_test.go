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
		At     string            `json:"at"`
		Random string            `json:"random"`
		Body   map[string]string `json:"body"`
		Status int               `json:"status"`
		Result string            `json:"result"`
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
		if c := h.challenge(); c != p.Body["challenge"] {
			t.Fatalf("card proof %d: challenge %s, want %s", i+1, c, p.Body["challenge"])
		}
		body, _ := json.Marshal(p.Body)
		if p.Result == "withdraw" {
			// The same proof for another username does not verify; the
			// challenge stays usable.
			other := map[string]string{}
			for k, v := range p.Body {
				other[k] = v
			}
			other["username"] = "carl"
			ob, _ := json.Marshal(other)
			if status, out := h.do("POST", "/api/v1/records", string(ob)); status != 400 || out["error"] != "proof" {
				t.Fatalf("card proof %d for another username: %d %v", i+1, status, out)
			}
		}
		status, out := h.do("POST", "/api/v1/records", string(body))
		got, _ := out["kind"].(string)
		if status != 201 {
			got, _ = out["error"].(string)
		}
		if status != p.Status || got != p.Result {
			t.Fatalf("card proof %d (%s %s): %d %v, want %d %s", i+1, p.Body["action"], p.Body["username"], status, out, p.Status, p.Result)
		}
	}
	recs := h.checkChain()
	if len(recs) != 6 {
		t.Fatalf("%d records", len(recs))
	}

	// The state the server answers.
	g2Card, g3Card := proofs[0].Body["scoped_id"], proofs[1].Body["scoped_id"]
	for card, want := range map[string]map[string]any{
		g2Card: {"current": "alice", "last_declared": "alice", "last_card_proof": "2026-11-20", "switch_dates": []any{}},
		g3Card: {"current": nil, "last_declared": "carol", "last_card_proof": "2026-11-22", "switch_dates": []any{"2026-11-21", "2026-11-21"}},
	} {
		_, out := h.do("POST", "/api/v1/card-state", `{"scope_string":"`+testScope+`","scoped_id":"`+card+`"}`)
		for k, w := range want {
			if !reflect.DeepEqual(out[k], w) {
				t.Errorf("card %s: %s is %v, want %v", card[:6], k, out[k], w)
			}
		}
	}

	// The daily snapshot, with every proof verified again by bb and the
	// CRL archive rebuilt.
	if code, stdout, stderr := h.snapshot("2026-11-22"); code != 0 {
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
	if !bytes.Contains(stderr.Bytes(), []byte("heads.jsonl: 1 line(s), every head is the roster's")) {
		t.Errorf("iamreal-verify did not check the heads file:\n%s", stderr.String())
	}
	var report struct {
		Valid   bool   `json:"valid"`
		Head    string `json:"head"`
		Results []struct {
			Seq   uint64 `json:"seq"`
			Valid bool   `json:"valid"`
			Kind  string `json:"kind"`
		} `json:"results"`
		State json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	var kinds []string
	for _, r := range report.Results {
		kinds = append(kinds, r.Kind)
	}
	if !report.Valid || report.Head != recs[5].Hash() || !reflect.DeepEqual(kinds, []string{"first", "first", "refresh", "switch", "switch", "withdraw"}) {
		t.Errorf("iamreal-verify: %s", stdout.String())
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
	if code, _, stderr := h.snapshot("2026-11-23"); code != snapshotRefused || !bytes.Contains([]byte(stderr), []byte("6 invalid record(s)")) {
		t.Errorf("MOICA's keys: exit %d\n%s", code, stderr)
	}
}

// stateJSON writes the state in the shape of spec/vectors/roster-rules.json
// ("state"), the shape of iamreal-verify -json.
func stateJSON(st *roster.State) []byte {
	type card struct {
		ScopedID      string  `json:"scoped_id"`
		Current       *string `json:"current"`
		LastCardProof string  `json:"last_card_proof"`
	}
	type accountCard struct {
		ScopedID      string `json:"scoped_id"`
		LastCardProof string `json:"last_card_proof"`
	}
	type account struct {
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
			so.Cards = append(so.Cards, card{c.ScopedID, c.Current, c.LastCardProof.String()})
		}
		for _, a := range s.Accounts {
			ao := account{Username: a.Username, Cards: []accountCard{}}
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
