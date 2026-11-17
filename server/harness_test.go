package main

// The test harness: a server on a temporary data directory, with a clock
// the test sets, a fake proof verifier and CRLs signed by a throwaway key.
// Nothing here is a real certificate or a real CRL.

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/server/store"
	"github.com/iamreal-tw/iamreal/verifier"
)

// tw returns a moment given in Taiwan time.
func tw(y, mo, d, h, mi, s int) time.Time {
	return time.Date(y, time.Month(mo), d, h, mi, s, 0, taiwan)
}

func mustDate(t *testing.T, s string) verifier.Date {
	t.Helper()
	d, err := verifier.ParseDate(s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// fakeClock is the server's clock in tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = t
}

// fakeProofs verifies every proof except those in reject. A proof here is
// placeholder bytes; see proofText.
type fakeProofs struct {
	mu     sync.Mutex
	reject map[string]bool
}

func (f *fakeProofs) VerifyRecord(r *verifier.Record) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reject[r.Proof] {
		return &verifier.Rejection{Reason: "the test rejects this proof"}
	}
	return nil
}

// proofText returns placeholder proof bytes in the record's spelling; n
// makes them different.
func proofText(n byte) string {
	b := make([]byte, verifier.ProofLength)
	b[0] = n
	return base64.StdEncoding.EncodeToString(b)
}

var goodProof, badProof = proofText(0), proofText(1)

// testIssuerKeys are throwaway issuer keys named G2 and G3, made once per
// test run. 2048 bits for both: the size of the key does not matter to the
// CRL checks, and it is faster to make.
var testIssuerKeys = sync.OnceValues(func() (map[string]*rsa.PrivateKey, error) {
	keys := map[string]*rsa.PrivateKey{}
	for _, name := range []string{"G2", "G3"} {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}
		keys[name] = k
	}
	return keys, nil
})

func namedTestKeys(t *testing.T) []crl.NamedKey {
	t.Helper()
	keys, err := testIssuerKeys()
	if err != nil {
		t.Fatal(err)
	}
	return []crl.NamedKey{{Name: "G2", Key: &keys["G2"].PublicKey}, {Name: "G3", Key: &keys["G3"].PublicKey}}
}

// makeCRL signs a CRL as MOICA's are made (spec/revocation-tree.md): with
// a CRL number and one reason code per entry. Its CRL date is the date in
// Taiwan of thisUpdate.
func makeCRL(t *testing.T, issuer string, number int64, thisUpdate time.Time, serials ...int64) []byte {
	t.Helper()
	keys, err := testIssuerKeys()
	if err != nil {
		t.Fatal(err)
	}
	k := keys[issuer]
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "Synthetic test issuer " + issuer},
		NotBefore:    time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:     time.Date(2036, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage:     x509.KeyUsageCertSign | x509.KeyUsageCRLSign, BasicConstraintsValid: true, IsCA: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	list := &x509.RevocationList{Number: big.NewInt(number), ThisUpdate: thisUpdate, NextUpdate: thisUpdate.Add(36 * time.Hour)}
	for _, s := range serials {
		list.RevokedCertificateEntries = append(list.RevokedCertificateEntries, x509.RevocationListEntry{
			SerialNumber: big.NewInt(s), RevocationTime: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), ReasonCode: 1,
		})
	}
	out, err := x509.CreateRevocationList(rand.Reader, list, cert, k)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// rootOf returns the root of a CRL made by makeCRL.
func rootOf(t *testing.T, der []byte) string {
	t.Helper()
	l := crl.IndexFile(der, namedTestKeys(t))
	if !l.Usable() {
		t.Fatalf("test CRL not usable: %s", l.Root)
	}
	return l.Root
}

// circuitOf returns the record's circuit field for an issuer.
func circuitOf(issuer string) string {
	for _, c := range verifier.AcceptedCircuits() {
		if c.Issuer == issuer {
			return c.VKSHA256
		}
	}
	panic(issuer)
}

// newCard returns a new random scoped ID.
func newCard() string {
	var f verifier.Field
	rand.Read(f[1:]) // below 2^248, so below p
	return verifier.ScopedIDText(f)
}

const testScope = "iamreal-test:public:0__________"

// harness is a server with its data directory, ready for requests.
type harness struct {
	t      *testing.T
	data   string
	clock  *fakeClock
	proofs roster.ProofVerifier // a *fakeProofs, except in e2e_test.go
	keys   []crl.NamedKey       // the issuer keys of the CRLs
	store  *store.SQLite
	server *Server
	http   http.Handler
	logs   *syncBuffer
	random io.Reader       // the server's random source; nil means crypto/rand
	roster verifier.Roster // whose tables; verifier.Test unless a test sets it
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// newHarness starts a server at now with the given CRLs in its mirror.
func newHarness(t *testing.T, now time.Time, crls ...[]byte) *harness {
	t.Helper()
	h := &harness{t: t, data: t.TempDir(), clock: &fakeClock{t: now}, proofs: &fakeProofs{reject: map[string]bool{badProof: true}}, keys: namedTestKeys(t), logs: &syncBuffer{}, roster: verifier.Test}
	for _, dir := range []string{crlDir(h.data), rosterDir(h.data)} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, der := range crls {
		h.addCRL(der)
	}
	st, err := store.Open(dbPath(h.data))
	if err != nil {
		t.Fatal(err)
	}
	h.store = st
	t.Cleanup(func() { st.Close() })
	h.start()
	return h
}

// start makes a new Server on the harness's store, as the program does
// when it starts.
func (h *harness) start() {
	h.t.Helper()
	s, err := New(h.config())
	if err != nil {
		h.t.Fatal(err)
	}
	h.server = s
	h.http = s.routes(crlDir(h.data), rosterDir(h.data), "")
}

func (h *harness) config() Config {
	random := h.random
	if random == nil {
		random = rand.Reader
	}
	return Config{
		Roster: h.roster, Store: h.store, CRLDir: crlDir(h.data), Proofs: h.proofs,
		Now: h.clock.Now, Random: random, Log: slog.New(slog.NewJSONHandler(h.logs, nil)), Version: "test-version",
	}
}

// addCRL stores a CRL in the mirror the way the mirror does.
func (h *harness) addCRL(der []byte) {
	h.t.Helper()
	m := &Mirror{Dir: crlDir(h.data), Keys: h.keys}
	if _, _, err := m.store(der); err != nil {
		h.t.Fatal(err)
	}
}

// do sends a request and returns the status and the decoded JSON body.
func (h *harness) do(method, path, body string) (int, map[string]any) {
	h.t.Helper()
	rec := h.raw(method, path, body)
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		h.t.Fatalf("%s %s: %d, body %q: %v", method, path, rec.Code, rec.Body.String(), err)
	}
	return rec.Code, out
}

// clientAddress is the address every test request comes from. It must not
// appear in the log.
const clientAddress = "198.51.100.23"

func (h *harness) raw(method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = clientAddress + ":61234"
	req.Header.Set("X-Forwarded-For", clientAddress)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.http.ServeHTTP(rec, req)
	return rec
}

// challenge issues a challenge and returns it.
func (h *harness) challenge() string {
	h.t.Helper()
	status, body := h.do("POST", "/api/v1/challenges", "")
	if status != 200 {
		h.t.Fatalf("challenge: %d %v", status, body)
	}
	return body["challenge"].(string)
}

// submission is the body of POST /api/v1/records.
type submission struct {
	ScopeString string             `json:"scope_string"`
	ScopedID    string             `json:"scoped_id"`
	Accounts    []submittedAccount `json:"accounts"`
	Challenge   string             `json:"challenge"`
	Issuer      string             `json:"issuer"`
	SMTRoot     string             `json:"smt_root"`
	Circuit     string             `json:"circuit"`
	Proof       string             `json:"proof"`
}

type submittedAccount struct {
	Platform string `json:"platform"`
	Username string `json:"username"`
}

// list returns an account list from "platform:username" strings, in the
// order given: the tests also send lists in other orders.
func list(accounts ...string) []submittedAccount {
	out := []submittedAccount{}
	for _, a := range accounts {
		p, u, _ := strings.Cut(a, ":")
		out = append(out, submittedAccount{p, u})
	}
	return out
}

// sub returns a submission of a G3 card proof of card with a new challenge;
// accounts are "platform:username", in the order given.
func (h *harness) sub(card, root string, accounts ...string) submission {
	return submission{
		ScopeString: testScope, ScopedID: card, Accounts: list(accounts...),
		Challenge: h.challenge(), Issuer: "G3", SMTRoot: root, Circuit: circuitOf("G3"), Proof: goodProof,
	}
}

func (h *harness) submit(s submission) (int, map[string]any) {
	h.t.Helper()
	b, _ := json.Marshal(s)
	return h.do("POST", "/api/v1/records", string(b))
}

// kindsOf writes the kinds of a 201 response as "platform kind" pairs
// separated by ", ".
func kindsOf(body map[string]any) string {
	list, _ := body["kinds"].([]any)
	var out []string
	for _, k := range list {
		m, _ := k.(map[string]any)
		out = append(out, fmt.Sprint(m["platform"], " ", m["kind"]))
	}
	return strings.Join(out, ", ")
}

// mustSubmit submits and expects 201 with kinds, written as kindsOf writes
// them ("threads first", "test-example withdraw, threads switch").
func (h *harness) mustSubmit(s submission, kinds string) map[string]any {
	h.t.Helper()
	status, body := h.submit(s)
	if status != 201 || kindsOf(body) != kinds {
		h.t.Fatalf("%v: %d %v, want 201 %s", s.Accounts, status, body, kinds)
	}
	return body
}

// wantError submits and expects an error.
func (h *harness) wantError(s submission, status int, code string) {
	h.t.Helper()
	got, body := h.submit(s)
	if got != status || body["error"] != code {
		h.t.Fatalf("%v: %d %v, want %d %s", s.Accounts, got, body, status, code)
	}
}

// rosterFile returns the stored records as a roster file.
func (h *harness) rosterFile() []byte {
	h.t.Helper()
	recs, err := h.store.Records(1, 1<<40)
	if err != nil {
		h.t.Fatal(err)
	}
	var out []byte
	for _, r := range recs {
		out = append(out, r.Line()...)
	}
	return out
}

// checkChain checks that the stored records form a valid roster file whose
// head the server reports.
func (h *harness) checkChain() []*verifier.Record {
	h.t.Helper()
	recs, head, broken := roster.ReadFile(h.rosterFile(), h.roster)
	if broken != nil {
		h.t.Fatalf("stored roster is broken: %v", broken)
	}
	_, body := h.do("GET", "/api/v1/head", "")
	if body["head"] != head || int(body["count"].(float64)) != len(recs) {
		h.t.Fatalf("head %v, stored %d records with head %s", body, len(recs), head)
	}
	return recs
}

// The CRLs most tests use: G3 and G2 CRLs dated 2026-11-20 in Taiwan
// (thisUpdate 2026-11-19 21:00 UTC is 05:00 in Taiwan).
var crlTime = time.Date(2026, 11, 19, 21, 0, 0, 0, time.UTC)

// startOfTests is when most tests begin: noon of the CRLs' date in Taiwan.
var startOfTests = tw(2026, 11, 20, 12, 0, 0)
