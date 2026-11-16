//go:build iamrealtest

package main

// The options -test-issuers and -test-moica exist only in a build with the
// tag iamrealtest, like verifier.NewWithIssuers, which they use. web/'s
// end-to-end test (web/test/e2e/) builds the server with the tag and runs
// it with throwaway issuer keys and a fake MOICA, so that the page's proofs
// of a fake card are verified and accepted by this server. A program built
// without the tag, as README.md says to build it, cannot accept a test key
// or fetch a CRL from anywhere but MOICA.

import (
	"crypto/rsa"
	"crypto/x509"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

func init() {
	testOptions = func(fs *flag.FlagSet) func(*deps) error {
		issuers := fs.String("test-issuers", "", "TEST BUILD ONLY: `directory` with issuer-G2.der and issuer-G3.der (SubjectPublicKeyInfo), throwaway keys that replace MOICA's for proofs and CRLs")
		moica := fs.String("test-moica", "", "TEST BUILD ONLY: base `URL` of a fake MOICA serving G2.crl and G3.crl, instead of MOICA's addresses")
		return func(d *deps) error {
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
