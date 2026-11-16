package verifier

import "math/big"

// NewWithIssuers returns a verifier whose issuer table is moduli instead of
// the one compiled into the program. Only tests can call it: this file is
// compiled into tests and nothing else, so no executable can accept a test
// key.
func NewWithIssuers(cfg Config, moduli map[string]*big.Int) (*Verifier, error) {
	return newVerifier(cfg, moduli)
}
