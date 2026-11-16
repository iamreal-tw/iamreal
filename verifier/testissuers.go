//go:build iamrealtest

package verifier

import "math/big"

// NewWithIssuers returns a verifier whose issuer table is moduli instead of
// the one compiled into the program. It exists only when building with the
// tag iamrealtest, which the end-to-end test of cmd/iamreal-verify uses
// (go test -tags iamrealtest). A program built without the tag, as README.md
// says to build it, cannot accept a test key.
func NewWithIssuers(cfg Config, moduli map[string]*big.Int) (*Verifier, error) {
	return newVerifier(cfg, moduli)
}
