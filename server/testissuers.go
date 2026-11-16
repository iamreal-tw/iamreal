//go:build iamrealtest

package main

// The options -test-issuers, -test-moica and -test-clock exist only in a
// build with the tag iamrealtest, like verifier.NewWithIssuers, which the
// first uses. web/'s end-to-end test (web/test/e2e/) builds the server with
// the tag and runs it with throwaway issuer keys and a fake MOICA, so that
// the page's proofs of a fake card are verified and accepted by this
// server, and with a clock it moves ahead by whole days, so that one card's
// card proofs fall on several dates (at most 3 valid records of a card a
// day, spec/roster-rules.md). A program built without the tag, as README.md
// says to build it, cannot accept a test key, fetch a CRL from anywhere but
// MOICA, or run on another clock than the machine's.

import (
	"crypto/rsa"
	"crypto/x509"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

func init() {
	testOptions = func(fs *flag.FlagSet) func(*deps) error {
		issuers := fs.String("test-issuers", "", "TEST BUILD ONLY: `directory` with issuer-G2.der and issuer-G3.der (SubjectPublicKeyInfo), throwaway keys that replace MOICA's for proofs and CRLs")
		moica := fs.String("test-moica", "", "TEST BUILD ONLY: base `URL` of a fake MOICA serving G2.crl and G3.crl, instead of MOICA's addresses")
		clock := fs.String("test-clock", "", "TEST BUILD ONLY: `file` holding a number of days the clock runs ahead of the machine's, read again at every reading of the clock")
		return func(d *deps) error {
			if *clock != "" {
				path := *clock
				if _, err := clockDays(path); err != nil {
					return err
				}
				d.now = func() time.Time {
					days, err := clockDays(path)
					if err != nil {
						panic(err) // the request fails with internal; the test sees it
					}
					return time.Now().AddDate(0, 0, days)
				}
			}
			if *issuers != "" {
				var keys []crl.NamedKey
				moduli := map[string]*big.Int{}
				for _, name := range []string{"G2", "G3"} {
					der, err := os.ReadFile(filepath.Join(*issuers, "issuer-"+name+".der"))
					if err != nil {
						return err
					}
					k, err := x509.ParsePKIXPublicKey(der)
					if err != nil {
						return fmt.Errorf("issuer-%s.der: %w", name, err)
					}
					rk, ok := k.(*rsa.PublicKey)
					if !ok {
						return fmt.Errorf("issuer-%s.der: not an RSA key", name)
					}
					keys = append(keys, crl.NamedKey{Name: name, Key: rk})
					moduli[name] = rk.N
				}
				d.verifier = func(cfg verifier.Config) (roster.ProofVerifier, error) { return verifier.NewWithIssuers(cfg, moduli) }
				d.crlKeys = func() ([]crl.NamedKey, error) { return keys, nil }
			}
			if *moica != "" {
				base := strings.TrimSuffix(*moica, "/")
				d.sources = []crlSource{{"G2", base + "/G2.crl"}, {"G3", base + "/G3.crl"}}
			}
			return nil
		}
	}
}

// clockDays reads the file of -test-clock: a whole number of days.
func clockDays(path string) (int, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0, fmt.Errorf("-test-clock %s: %w", path, err)
	}
	return n, nil
}
