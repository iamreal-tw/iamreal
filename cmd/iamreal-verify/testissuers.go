//go:build iamrealtest

package main

// The option -test-issuers exists only in a build with the tag iamrealtest,
// like verifier.NewWithIssuers, which it uses. The Worker's test with
// real proofs (worker/test/records-real.test.ts) builds the command with
// the tag to re-verify a proof log whose proofs were made under throwaway
// issuer keys. A program built without the
// tag, as README.md says to build it, cannot accept a test key.

import (
	"crypto/rsa"
	"crypto/x509"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

func init() {
	testOptions = func(fs *flag.FlagSet) func(*deps) error {
		dir := fs.String("test-issuers", "", "TEST BUILD ONLY: `directory` with issuer-G2.der and issuer-G3.der (SubjectPublicKeyInfo), throwaway keys that replace MOICA's for proofs and CRLs")
		return func(d *deps) error {
			if *dir == "" {
				return nil
			}
			var keys []crl.NamedKey
			moduli := map[string]*big.Int{}
			for _, name := range []string{"G2", "G3"} {
				der, err := os.ReadFile(filepath.Join(*dir, "issuer-"+name+".der"))
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
			d.verifier = func(cfg verifier.Config) (prooflog.ProofVerifier, error) { return verifier.NewWithIssuers(cfg, moduli) }
			d.archive = openArchive(func() ([]crl.NamedKey, error) { return keys, nil })
			return nil
		}
	}
}
