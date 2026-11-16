//go:build ignore

// Writes the synthetic CRLs of this directory, the test issuer's public key,
// and expected.json. Run from the repository root:
//
//	go run ./crl/testdata/generate.go
//
// Each run makes new keys, so every file changes. The private keys are not
// kept. The roots in expected.json come from this package; check them with
// an independent implementation after regenerating (README.md).
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/crl/internal/crltest"
)

type expected struct {
	Name       string `json:"name"`
	What       string `json:"what"`
	Usable     bool   `json:"usable"`
	Reason     string `json:"reason,omitempty"`
	Entries    int    `json:"entries"`
	CRLNumber  string `json:"crl_number,omitempty"`
	ThisUpdate string `json:"this_update"`
	NextUpdate string `json:"next_update,omitempty"`
	CRLDate    string `json:"crl_date"`
	SHA256     string `json:"sha256"`
	Root       string `json:"root,omitempty"`
}

func main() {
	dir := "crl/testdata"
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Fatal(err)
	}
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Fatal(err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "issuer-public-key.der"), spki, 0o644); err != nil {
		log.Fatal(err)
	}
	var out []expected
	for _, c := range crltest.Cases(key, other) {
		if err := os.WriteFile(filepath.Join(dir, c.Name+".crl"), c.DER, 0o644); err != nil {
			log.Fatal(err)
		}
		parsed, err := crl.Parse(c.DER)
		if err != nil {
			log.Fatalf("%s: %v", c.Name, err)
		}
		sum := parsed.SHA256()
		e := expected{
			Name: c.Name, What: c.What, Usable: c.Usable, Reason: c.Reason,
			Entries:    len(parsed.Entries),
			ThisUpdate: parsed.ThisUpdate.Format("2006-01-02T15:04:05Z"),
			CRLDate:    parsed.Date(),
			SHA256:     hex.EncodeToString(sum[:]),
		}
		if !parsed.NextUpdate.IsZero() {
			e.NextUpdate = parsed.NextUpdate.Format("2006-01-02T15:04:05Z")
		}
		if n, err := parsed.Number(); err != nil {
			log.Fatal(err)
		} else if n != nil {
			e.CRLNumber = n.String()
		}
		keys, err := parsed.Check(&key.PublicKey)
		var u *crl.Unusable
		switch {
		case c.Usable && err != nil:
			log.Fatalf("%s: %v", c.Name, err)
		case !c.Usable && !errors.As(err, &u):
			log.Fatalf("%s: want unusable, got %v", c.Name, err)
		}
		if c.Usable {
			tree, err := crl.NewTree(keys)
			if err != nil {
				log.Fatal(err)
			}
			e.Root = tree.RootHex()
		}
		out = append(out, e)
	}
	j, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "expected.json"), append(j, '\n'), 0o644); err != nil {
		log.Fatal(err)
	}
}
