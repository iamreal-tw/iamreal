//go:build ignore

// Writes the data of the server's end-to-end test (e2e_test.go): CRLs
// signed by throwaway issuer keys, and card proofs with real proofs against
// their roots, each made for a challenge the test has the server issue.
// Run from the repository root:
//
//	go run ./server/testdata/generate.go -bb <bb> -crs <dir>
//
// The proofs are made by cmd/iamreal-verify/testdata/make-proofs.mjs, with
// the test helpers of circuits/. The CRS directory needs the 2^18-point
// bn254_g1.dat that bb prove reads. Each run makes new keys, so every file
// changes. The private keys are not kept. See README.md.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"math/big"
	mrand "math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/verifier"
)

const (
	dir   = "server/testdata"
	scope = "iamreal-test:public:0__________"
)

var circuits = map[string]string{"G2": "card_proof_rs2048", "G3": "card_proof_rs4096"}

// The CRLs, as MOICA's: A for G2; B and C for G3 with the same serial
// numbers (so the same root), C a day after B.
type crlSpec struct {
	file       string
	issuer     string
	number     int64
	thisUpdate time.Time
	serials    string
}

var crls = []crlSpec{
	{"A-G2.crl", "G2", 2026112005, time.Date(2026, 11, 19, 21, 12, 6, 0, time.UTC), "a"},  // CRL date 2026-11-20
	{"B-G3.crl", "G3", 2026112005, time.Date(2026, 11, 19, 21, 11, 40, 0, time.UTC), "b"}, // CRL date 2026-11-20
	{"C-G3.crl", "G3", 2026112105, time.Date(2026, 11, 20, 21, 12, 15, 0, time.UTC), "b"}, // CRL date 2026-11-21
}

// The card proofs, in the order the test submits them. at is the server's
// clock (Taiwan time) when it issues the challenge and gets the proof.
// accounts is the card's whole list, "platform:username" in ascending order
// of platform.
type proofSpec struct {
	at       string
	issuer   string
	accounts []string
	crl      int // the CRL whose root the proof uses
	status   int
	result   string // the kinds ("platform kind", separated by ", "), or the error code
}

var proofs = []proofSpec{
	{"2026-11-20T10:00:00+08:00", "G2", []string{"threads:alice"}, 0, 201, "threads first"},
	{"2026-11-20T10:05:00+08:00", "G3", []string{"test-example:a-b", "threads:alice"}, 1, 201, "test-example first, threads first"},
	{"2026-11-20T10:20:00+08:00", "G3", []string{"test-example:a-b", "threads:alice_"}, 1, 201, "test-example refresh, threads correction"},
	{"2026-11-21T09:00:00+08:00", "G3", []string{"test-example:a-b", "threads:bob"}, 1, 201, "test-example refresh, threads switch"},
	{"2026-11-21T09:30:00+08:00", "G3", []string{"test-example:c-d", "threads:bob"}, 1, 201, "test-example switch, threads refresh"},
	{"2026-11-22T09:00:00+08:00", "G3", []string{"test-example:c-d", "threads:carol"}, 1, 201, "test-example refresh, threads switch"},
	{"2026-11-23T09:00:00+08:00", "G3", []string{"test-example:c-d", "threads:dave"}, 1, 201, "test-example refresh, threads switch"},
	{"2026-11-23T10:00:00+08:00", "G2", []string{}, 0, 201, "threads withdraw"},
	{"2026-11-23T10:30:00+08:00", "G2", []string{}, 0, 400, "empty"},
	{"2026-11-24T09:00:00+08:00", "G3", []string{"test-example:c-d", "threads:erin"}, 1, 403, "switch_restricted"},
	{"2026-11-24T09:30:00+08:00", "G3", []string{"test-example:c-d"}, 1, 201, "test-example refresh, threads withdraw"},
	{"2026-11-24T11:00:00+08:00", "G3", []string{"test-example:c-d", "threads:dave"}, 1, 201, "test-example refresh, threads refresh"},
	{"2026-11-24T11:30:00+08:00", "G3", []string{}, 1, 201, "test-example withdraw, threads withdraw"},
	{"2026-11-24T12:00:00+08:00", "G3", []string{"threads:dave"}, 1, 400, "daily_limit"},
}

// The file e2e_test.go reads.
type cardProof struct {
	At     string `json:"at"`
	Random string `json:"random"` // the 16 random bytes of the challenge, in hex
	Body   body   `json:"body"`   // the request body of POST /api/v1/records
	Status int    `json:"status"`
	Result string `json:"result"`
}

// body is the request body of POST /api/v1/records.
type body struct {
	ScopeString string      `json:"scope_string"`
	ScopedID    string      `json:"scoped_id"`
	Accounts    []inAccount `json:"accounts"`
	Challenge   string      `json:"challenge"`
	Issuer      string      `json:"issuer"`
	SMTRoot     string      `json:"smt_root"`
	Circuit     string      `json:"circuit"`
	Proof       string      `json:"proof"`
}

// inAccount is an account as the request and make-proofs.mjs write it.
type inAccount struct {
	Platform string `json:"platform"`
	Username string `json:"username"`
}

func accountsOf(list []string) ([]verifier.Account, []inAccount) {
	accounts, in := []verifier.Account{}, []inAccount{}
	for _, a := range list {
		p, u, _ := strings.Cut(a, ":")
		accounts = append(accounts, verifier.Account{Platform: p, Username: u})
		in = append(in, inAccount{p, u})
	}
	return accounts, in
}

func main() {
	bb := flag.String("bb", "", "bb 6.0.0")
	crs := flag.String("crs", "", "directory with the 2^18-point bn254_g1.dat")
	flag.Parse()
	if *crs == "" {
		flag.Usage()
		os.Exit(2)
	}
	// Before anything is written: an empty or missing bb is what
	// $(circuits/find-bb.sh) gives when its SHA-256 check fails.
	if fi, err := os.Stat(*bb); err != nil || !fi.Mode().IsRegular() {
		log.Fatalf("bb %q is not a file (see the message of circuits/find-bb.sh)", *bb)
	}
	var err error
	if work, err = os.MkdirTemp("", "iamreal-server-e2e-"); err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(work)

	keys := map[string]*rsa.PrivateKey{}
	certs := map[string]*x509.Certificate{}
	for _, is := range []struct {
		name string
		bits int
	}{{"G2", 2048}, {"G3", 4096}} {
		k, err := rsa.GenerateKey(rand.Reader, is.bits)
		if err != nil {
			fatal(err)
		}
		keys[is.name] = k
		certs[is.name] = issuerCert(is.name, k)
		spki, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
		if err != nil {
			fatal(err)
		}
		write(filepath.Join(dir, "issuer-"+is.name+".der"), spki)
	}

	r := mrand.New(mrand.NewPCG(34, 1))
	sets := map[string][][]byte{"a": serials(r, 50), "b": serials(r, 40)}
	cards := map[string][]byte{"G2": serials(r, 1)[0], "G3": serials(r, 1)[0]}

	crlDir := filepath.Join(dir, "crl")
	os.RemoveAll(crlDir)
	if err := os.MkdirAll(crlDir, 0o755); err != nil {
		fatal(err)
	}
	roots := make([]string, len(crls))
	for i, c := range crls {
		der := makeCRL(c, sets[c.serials], certs[c.issuer], keys[c.issuer])
		write(filepath.Join(crlDir, c.file), der)
		parsed, err := crl.Parse(der)
		if err != nil {
			fatal(err)
		}
		tree, err := parsed.Tree(&keys[c.issuer].PublicKey)
		if err != nil {
			fatalf("%s: %v", c.file, err)
		}
		k, err := crl.KeyFromSerial(cards[c.issuer])
		if err != nil {
			fatal(err)
		}
		if _, err := tree.ProveAbsent(k); err != nil {
			fatalf("%s: the card is revoked", c.file)
		}
		roots[i] = tree.RootHex()
	}
	if roots[1] != roots[2] {
		fatal("B and C must share their root")
	}

	// The input of make-proofs.mjs.
	type inRecord struct {
		Circuit   string      `json:"circuit"`
		Issuer    string      `json:"issuer"`
		Accounts  []inAccount `json:"accounts"`
		Challenge string      `json:"challenge"`
		Revoked   []string    `json:"revoked"`
	}
	type inIssuer struct {
		Bits   int    `json:"bits"`
		KeyPEM string `json:"key_pem"`
	}
	in := struct {
		Scope   string                       `json:"scope"`
		Issuers map[string]inIssuer          `json:"issuers"`
		Cards   map[string]map[string]string `json:"cards"`
		Records []inRecord                   `json:"records"`
	}{Scope: scope, Issuers: map[string]inIssuer{}, Cards: map[string]map[string]string{}}
	for name, k := range keys {
		p8, err := x509.MarshalPKCS8PrivateKey(k)
		if err != nil {
			fatal(err)
		}
		in.Issuers[name] = inIssuer{k.N.BitLen(), string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: p8}))}
		in.Cards[name] = map[string]string{"serial": hex.EncodeToString(cards[name])}
	}
	randoms := make([][]byte, len(proofs))
	for i, p := range proofs {
		at, err := time.Parse(time.RFC3339, p.at)
		if err != nil {
			fatal(err)
		}
		randoms[i] = make([]byte, 16)
		rand.Read(randoms[i])
		date := at.Format("2006-01-02") // at is written in Taiwan time
		var revoked []string
		for _, s := range sets[crls[p.crl].serials] {
			revoked = append(revoked, hex.EncodeToString(s))
		}
		_, accounts := accountsOf(p.accounts)
		in.Records = append(in.Records, inRecord{circuits[p.issuer], p.issuer, accounts,
			date + "." + verifier.EncodeBase32(randoms[i]), revoked})
	}
	j, _ := json.Marshal(in)
	write(filepath.Join(work, "input.json"), j)
	cmd := exec.Command("node", "cmd/iamreal-verify/testdata/make-proofs.mjs", *bb, *crs, work)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		fatal(err)
	}
	var out struct {
		Commit  string `json:"circuits_commit"`
		Records []struct {
			SMTRoot         string `json:"smt_root"`
			DeclarationCode string `json:"declaration_code"`
			Nullifier       string `json:"nullifier"`
		} `json:"records"`
	}
	b, err := os.ReadFile(filepath.Join(work, "output.json"))
	if err != nil {
		fatal(err)
	}
	if err := json.Unmarshal(b, &out); err != nil {
		fatal(err)
	}

	var result []cardProof
	for i, p := range proofs {
		o := out.Records[i]
		if o.SMTRoot != roots[p.crl] {
			fatalf("proof %d: root %s from circuits/, %s from crl/", i+1, o.SMTRoot, roots[p.crl])
		}
		accounts, inAccounts := accountsOf(p.accounts)
		rec := in.Records[i]
		// make-proofs.mjs and verifier/ agree on the declaration code.
		if code := verifier.DeclarationCode(scope, accounts, rec.Challenge); o.DeclarationCode != code {
			fatalf("proof %d: declaration code %s from make-proofs.mjs, %s from verifier/", i+1, o.DeclarationCode, code)
		}
		n, ok := new(big.Int).SetString(o.Nullifier, 16)
		if !ok {
			fatal("nullifier")
		}
		f, err := verifier.FieldFromBigInt(n)
		if err != nil {
			fatal(err)
		}
		proof, err := os.ReadFile(filepath.Join(work, fmt.Sprintf("record-%d.proof", i+1)))
		if err != nil {
			fatal(err)
		}
		vk := ""
		for _, c := range verifier.AcceptedCircuits() {
			if c.Name == circuits[p.issuer] {
				vk = c.VKSHA256
			}
		}
		b := body{
			ScopeString: scope, ScopedID: verifier.ScopedIDText(f), Accounts: inAccounts,
			Challenge: rec.Challenge, Issuer: rec.Issuer,
			SMTRoot: o.SMTRoot, Circuit: vk, Proof: base64.StdEncoding.EncodeToString(proof),
		}
		check := &verifier.Record{Seq: 1, ScopeString: scope, ScopedID: b.ScopedID,
			Accounts: accounts, Challenge: rec.Challenge, Issuer: rec.Issuer,
			SMTRoot: o.SMTRoot, Circuit: vk, Proof: b.Proof}
		if err := check.CheckValues(verifier.Test); err != nil {
			fatalf("proof %d is not a well-formed record: %v", i+1, err)
		}
		result = append(result, cardProof{p.at, hex.EncodeToString(randoms[i]), b, p.status, p.result})
	}
	j, err = json.MarshalIndent(result, "", "  ")
	if err != nil {
		fatal(err)
	}
	write(filepath.Join(dir, "card-proofs.json"), append(j, '\n'))
	write(filepath.Join(dir, "circuits-commit"), []byte(out.Commit+"\n"))
	fmt.Fprintf(os.Stderr, "roots: A %s, B = C %s\n", roots[0], roots[1])
}

var work string

func fatal(v ...any) {
	os.RemoveAll(work)
	log.Fatal(v...)
}

func fatalf(format string, v ...any) {
	os.RemoveAll(work)
	log.Fatalf(format, v...)
}

func write(path string, b []byte) {
	if err := os.WriteFile(path, b, 0o644); err != nil {
		fatal(err)
	}
}

// serials returns n distinct positive 16-byte serial numbers as DER content
// bytes, top bit clear.
func serials(r *mrand.Rand, n int) [][]byte {
	seen := map[string]bool{}
	var out [][]byte
	for len(out) < n {
		b := make([]byte, 16)
		for i := range b {
			b[i] = byte(r.Uint32())
		}
		b[0] = b[0]&0x7f | 0x01
		if !seen[string(b)] {
			seen[string(b)] = true
			out = append(out, b)
		}
	}
	return out
}

func issuerCert(name string, k *rsa.PrivateKey) *x509.Certificate {
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{Country: []string{"TW"}, Organization: []string{"Synthetic CRL test"}, CommonName: "Synthetic test issuer " + name},
		NotBefore:             time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		NotAfter:              time.Date(2036, 1, 1, 0, 0, 0, 0, time.UTC),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &k.PublicKey, k)
	if err != nil {
		fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		fatal(err)
	}
	return cert
}

func makeCRL(c crlSpec, set [][]byte, issuer *x509.Certificate, key *rsa.PrivateKey) []byte {
	tmpl := &x509.RevocationList{
		Number:     big.NewInt(c.number),
		ThisUpdate: c.thisUpdate,
		NextUpdate: c.thisUpdate.Add(35*time.Hour + 47*time.Minute),
	}
	for i, s := range set {
		tmpl.RevokedCertificateEntries = append(tmpl.RevokedCertificateEntries, x509.RevocationListEntry{
			SerialNumber:   new(big.Int).SetBytes(s),
			RevocationTime: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Hour),
			ReasonCode:     1,
		})
	}
	der, err := x509.CreateRevocationList(rand.Reader, tmpl, issuer, key)
	if err != nil {
		fatal(err)
	}
	return der
}
