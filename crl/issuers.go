package crl

import (
	"crypto/rsa"
	"crypto/x509"
	_ "embed"
	"fmt"
)

// The issuer certificates of spec/issuers.md, as published by MOICA. The
// tests check their SHA-256 and moduli against spec/issuers.md and
// spec/vectors/issuers.json.
var (
	//go:embed MOICA2.cer
	moicaG2 []byte
	//go:embed MOICA-G3.cer
	moicaG3 []byte
)

// Issuers lists the issuer names in the order of spec/issuers.md.
var Issuers = []string{"G2", "G3"}

// IssuerCertificate returns the DER issuer certificate named G2 or G3.
func IssuerCertificate(issuer string) ([]byte, error) {
	switch issuer {
	case "G2":
		return moicaG2, nil
	case "G3":
		return moicaG3, nil
	}
	return nil, fmt.Errorf("crl: unknown issuer %q (want G2 or G3)", issuer)
}

// IssuerKey returns the RSA public key of the issuer named G2 or G3.
func IssuerKey(issuer string) (*rsa.PublicKey, error) {
	der, err := IssuerCertificate(issuer)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, fmt.Errorf("crl: issuer %s: %w", issuer, err)
	}
	key, ok := cert.PublicKey.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("crl: issuer %s: not an RSA key", issuer)
	}
	return key, nil
}
