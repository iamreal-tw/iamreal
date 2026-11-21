//go:build ignore

// Writes the end-to-end test data of this directory: a CRL archive signed by
// throwaway issuer keys, and a test roster whose records carry real proofs
// against the roots of those CRLs. Run from the repository root:
//
//	go run ./cmd/iamreal-verify/testdata/generate.go -bb <bb> -crs <dir>
//
// The CRS directory needs the 2^18-point bn254_g1.dat that bb prove reads.
// Each run makes new keys, so every file changes. The private keys are not
// kept. See README.md.
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
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/verifier"
)

const (
	dir   = "cmd/iamreal-verify/testdata"
	scope = "iamreal-test:public:0__________"
)

// The circuit of each issuer key (spec/record.md, "Accepted circuits").
var circuits = map[string]string{"G2": "card_proof_rs2048", "G3": "card_proof_rs4096"}

// crlSpec is one CRL of the archive.
type crlSpec struct {
	file       string
	issuer     string
	number     int64
	thisUpdate time.Time
	serials    string // which set of serial numbers
}

// The archive: A (G2), and B and C (G3) with the same serial numbers, C a
// day after B. B and C have the same root.
var crls = []crlSpec{
	{"G2-2026111605.crl", "G2", 2026111605, time.Date(2026, 11, 15, 21, 12, 6, 0, time.UTC), "a"},
	{"G3-2026112005.crl", "G3", 2026112005, time.Date(2026, 11, 19, 21, 11, 40, 0, time.UTC), "b"},
	{"G3-2026112105.crl", "G3", 2026112105, time.Date(2026, 11, 20, 21, 12, 15, 0, time.UTC), "b"},
}

// recordSpec is one record of the roster; crl is the index into crls of the
// CRL whose root it uses.
type recordSpec struct {
	issuer   string
	accounts []verifier.Account
	date     string
	crl      int
}

var (
	alice = verifier.Account{Platform: "threads", Username: "alice"}
	ab    = verifier.Account{Platform: "test-example", Username: "a-b"}
)

// Record 2 (2026-11-21) fits B (2026-11-20) and C (2026-11-21); record 3
// (2026-11-24) only C. Record 3 leaves out the account of record 2 on
// test-example, which withdraws it.
var records = []recordSpec{
	{"G2", []verifier.Account{alice}, "2026-11-16", 0},
	{"G3", []verifier.Account{ab, alice}, "2026-11-21", 1},
	{"G3", []verifier.Account{alice}, "2026-11-24", 1},
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
	if work, err = os.MkdirTemp("", "iamreal-e2e-"); err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(work)

	// Issuer keys, and a self-signed issuer certificate for each, which
	// x509.CreateRevocationList needs to sign a CRL.
	keys := map[string]*rsa.PrivateKey{}
	certs := map[string]*x509.Certificate{}
	var named []crl.NamedKey
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
		named = append(named, crl.NamedKey{Name: is.name, Key: &k.PublicKey})
		spki, err := x509.MarshalPKIXPublicKey(&k.PublicKey)
		if err != nil {
			fatal(err)
		}
		write(filepath.Join(dir, "issuer-"+is.name+".der"), spki)
	}

	// Serial numbers: revoked ones in sets a and b, and one card per issuer
	// that is not revoked.
	r := mrand.New(mrand.NewPCG(30, 1))
	sets := map[string][][]byte{"a": serials(r, 200), "b": serials(r, 150)}
	cards := map[string][]byte{"G2": serials(r, 1)[0], "G3": serials(r, 1)[0]}

	archive := filepath.Join(dir, "archive")
	os.RemoveAll(archive)
	if err := os.MkdirAll(archive, 0o755); err != nil {
		fatal(err)
	}
	roots := make([]string, len(crls))
	for i, c := range crls {
		der := makeCRL(c, sets[c.serials], certs[c.issuer], keys[c.issuer])
		write(filepath.Join(archive, c.file), der)
		parsed, err := crl.Parse(der)
		if err != nil {
			fatal(err)
		}
		tree, err := parsed.Tree(&keys[c.issuer].PublicKey)
		if err != nil {
			fatalf("%s: %v", c.file, err)
		}
		if _, err := tree.ProveAbsent(mustKey(cards[c.issuer])); err != nil {
			fatalf("%s: the card is revoked: %v", c.file, err)
		}
		roots[i] = tree.RootHex()
	}
	if roots[1] != roots[2] || roots[0] == roots[1] {
		fatal("B and C must share their root, A must not")
	}
	lines, err := crl.BuildIndex(archive, named, nil)
	if err != nil {
		fatal(err)
	}
	write(filepath.Join(archive, crl.IndexFileName), crl.FormatIndex(lines))

	// The proofs, by make-proofs.mjs.
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
	for _, rec := range records {
		var revoked []string
		for _, s := range sets[crls[rec.crl].serials] {
			revoked = append(revoked, hex.EncodeToString(s))
		}
		in.Records = append(in.Records, inRecord{circuits[rec.issuer], rec.issuer, inAccounts(rec.accounts), challenge(rec.date), revoked})
	}
	j, _ := json.Marshal(in)
	write(filepath.Join(work, "input.json"), j)
	cmd := exec.Command("node", filepath.Join(dir, "make-proofs.mjs"), *bb, *crs, work)
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

	// The roster.
	var roster []byte
	for i, rec := range records {
		o := out.Records[i]
		// The reference tree of circuits/ and crl/ agree on the root.
		if o.SMTRoot != roots[rec.crl] {
			fatalf("record %d: root %s from circuits/, %s from crl/", i+1, o.SMTRoot, roots[rec.crl])
		}
		// make-proofs.mjs and verifier/ agree on the declaration code.
		if code := verifier.DeclarationCode(scope, rec.accounts, in.Records[i].Challenge); o.DeclarationCode != code {
			fatalf("record %d: declaration code %s from make-proofs.mjs, %s from verifier/", i+1, o.DeclarationCode, code)
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
			if c.Name == circuits[rec.issuer] {
				vk = c.VKSHA256
			}
		}
		rr := &verifier.Record{
			Seq: uint64(i + 1), ScopeString: scope, ScopedID: verifier.ScopedIDText(f),
			Accounts: rec.accounts, Challenge: in.Records[i].Challenge, Issuer: rec.issuer,
			SMTRoot: o.SMTRoot, Circuit: vk, Proof: base64.StdEncoding.EncodeToString(proof),
		}
		if _, err := verifier.ParseLine(rr.Line(), verifier.Test); err != nil {
			fatalf("record %d is not well formed: %v", i+1, err)
		}
		roster = append(roster, rr.Line()...)
	}
	write(filepath.Join(dir, "roster.jsonl"), roster)
	write(filepath.Join(dir, "circuits-commit"), []byte(out.Commit+"\n"))
	fmt.Fprintf(os.Stderr, "roots: A %s, B = C %s\n", roots[0], roots[1])
}

// work holds the private keys while the program runs; fatal removes it.
var work string

// inAccount is an account in the input of make-proofs.mjs.
type inAccount struct {
	Platform string `json:"platform"`
	Username string `json:"username"`
}

func inAccounts(list []verifier.Account) []inAccount {
	out := []inAccount{}
	for _, a := range list {
		out = append(out, inAccount{a.Platform, a.Username})
	}
	return out
}

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

func mustKey(serial []byte) crl.Key {
	k, err := crl.KeyFromSerial(serial)
	if err != nil {
		fatal(err)
	}
	return k
}

func challenge(date string) string {
	b := make([]byte, 16)
	rand.Read(b)
	return date + "." + verifier.EncodeBase32(b)
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
