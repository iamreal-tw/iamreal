// Command makecrl writes one synthetic CRL of MOICA's size and structure,
// for measuring: random positive 16-byte serials (a leading 00 when the top
// bit is set), a reasonCode on every entry, authorityKeyIdentifier and
// cRLNumber. It also writes the issuer's public key. The private key is not
// kept. Nothing here comes from MOICA.
//
//	go run ./crl/internal/crltest/makecrl -n 176202 -bits 4096 -out g3.crl
//	go run ./crl/internal/crltest/makecrl -n 342152 -bits 2048 -out g2.crl
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"flag"
	"log"
	mrand "math/rand/v2"
	"os"
	"time"

	"github.com/iamreal-tw/iamreal/crl/internal/crltest"
)

func main() {
	n := flag.Int("n", 176202, "number of entries")
	bits := flag.Int("bits", 4096, "issuer key size")
	seed := flag.Uint64("seed", 1, "seed for the serials")
	out := flag.String("out", "synthetic.crl", "CRL file to write; the public key goes to the same name with .key.der")
	flag.Parse()

	key, err := rsa.GenerateKey(rand.Reader, *bits)
	if err != nil {
		log.Fatal(err)
	}
	r := mrand.New(mrand.NewPCG(*seed, 28))
	c := &crltest.CRL{
		IssuerCN:   "Synthetic issuer",
		ThisUpdate: time.Now().UTC().Truncate(time.Second),
		NextUpdate: time.Now().UTC().Truncate(time.Second).Add(36 * time.Hour),
		Number:     1,
		Entries:    crltest.Entries(r, crltest.RandomSerials(r, *n)),
	}
	if err := os.WriteFile(*out, crltest.Make(c, key), 0o644); err != nil {
		log.Fatal(err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(*out+".key.der", spki, 0o644); err != nil {
		log.Fatal(err)
	}
}
