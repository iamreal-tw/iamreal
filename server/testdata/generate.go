//go:build ignore

// Writes the data of the server's end-to-end test (e2e_test.go): CRLs
// signed by throwaway issuer keys, and card proofs with real proofs against
// their roots, each made for a challenge the test has the server issue.
// Run from the repository root:
//
//	go run ./server/testdata/generate.go -zkid <zkid-noir> -bb <bb> -crs <dir>
//
// The proofs are made by cmd/iamreal-verify/testdata/make-proofs.mjs, with
// zkid-noir's test helpers. The CRS directory needs the 2^18-point
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
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/verifier"
)

const (
	dir   = "server/testdata"
	scope = "iamreal-test:threads:0_________"
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
type proofSpec struct {
	at       string
	issuer   string
	action   string
	username string
	crl      int // the CRL whose root the proof uses
	status   int
	result   string // the kind, or the error code
}

var proofs = []proofSpec{
	{"2026-11-20T10:00:00+08:00", "G2", "declare", "alice", 0, 201, "first"},
	{"2026-11-20T10:05:00+08:00", "G3", "declare", "alice", 1, 201, "first"},
	{"2026-11-20T10:20:00+08:00", "G3", "declare", "alice", 1, 201, "refresh"},
	{"2026-11-21T09:00:00+08:00", "G3", "declare", "bob", 1, 201, "switch"},
	{"2026-11-21T09:30:00+08:00", "G3", "declare", "carol", 1, 201, "switch"},
	{"2026-11-22T09:00:00+08:00", "G3", "declare", "dave", 1, 400, "switch_limit"},
	{"2026-11-22T09:30:00+08:00", "G3", "withdraw", "bob", 1, 400, "not_current"},
	{"2026-11-22T10:00:00+08:00", "G3", "withdraw", "carol", 1, 201, "withdraw"},
}

// The file e2e_test.go reads.
type cardProof struct {
	At     string            `json:"at"`
	Random string            `json:"random"` // the 16 random bytes of the challenge, in hex
	Body   map[string]string `json:"body"`   // the request body of POST /api/v1/records
	Status int               `json:"status"`
	Result string            `json:"result"`
}

func main() {
	zkid := flag.String("zkid", "", "zkid-noir checkout")
	bb := flag.String("bb", "", "bb 6.0.0")
	crs := flag.String("crs", "", "directory with the 2^18-point bn254_g1.dat")
	flag.Parse()
	if *zkid == "" || *bb == "" || *crs == "" {
		flag.Usage()
		os.Exit(2)
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
		Circuit   string   `json:"circuit"`
		Issuer    string   `json:"issuer"`
		Action    string   `json:"action"`
		Username  string   `json:"username"`
		Challenge string   `json:"challenge"`
		Revoked   []string `json:"revoked"`
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
		in.Records = append(in.Records, inRecord{circuits[p.issuer], p.issuer, p.action, p.username,
			date + "." + verifier.EncodeBase32(randoms[i]), revoked})
	}
	j, _ := json.Marshal(in)
	write(filepath.Join(work, "input.json"), j)
	cmd := exec.Command("node", "cmd/iamreal-verify/testdata/make-proofs.mjs", *zkid, *bb, *crs, work)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		fatal(err)
	}
	var out struct {
		Commit  string `json:"zkid_noir_commit"`
		Records []struct {
			SMTRoot   string `json:"smt_root"`
			Nullifier string `json:"nullifier"`
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
			fatalf("proof %d: root %s from zkid-noir, %s from crl/", i+1, o.SMTRoot, roots[p.crl])
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
		rec := in.Records[i]
		body := map[string]string{
			"scope_string": scope, "scoped_id": verifier.ScopedIDText(f), "action": rec.Action,
			"username": rec.Username, "challenge": rec.Challenge, "issuer": rec.Issuer,
			"smt_root": o.SMTRoot, "circuit": vk, "proof": base64.StdEncoding.EncodeToString(proof),
		}
		check := &verifier.Record{Seq: 1, Prev: verifier.GenesisPrev, ScopeString: scope, ScopedID: body["scoped_id"],
			Action: rec.Action, Username: rec.Username, Challenge: rec.Challenge, Issuer: rec.Issuer,
			SMTRoot: o.SMTRoot, Circuit: vk, Proof: body["proof"]}
		if err := check.CheckValues(verifier.Test); err != nil {
			fatalf("proof %d is not a well-formed record: %v", i+1, err)
		}
		result = append(result, cardProof{p.at, hex.EncodeToString(randoms[i]), body, p.status, p.result})
	}
	j, err = json.MarshalIndent(result, "", "  ")
	if err != nil {
		fatal(err)
	}
	write(filepath.Join(dir, "card-proofs.json"), append(j, '\n'))
	write(filepath.Join(dir, "zkid-noir-commit"), []byte(out.Commit+"\n"))
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
