// Package crltest writes synthetic CRLs for tests: DER CertificateLists
// with the structure of MOICA's (version 2, sha256WithRSAEncryption, entries
// with a reasonCode, authorityKeyIdentifier and cRLNumber), signed with a key
// the caller supplies. Nothing here comes from MOICA.
package crltest

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/asn1"
	"math/big"
	"time"

	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"
)

// Extension is a CRL or entry extension. Value is the content of extnValue.
type Extension struct {
	ID       asn1.ObjectIdentifier
	Critical bool
	Value    []byte
}

// Entry is one revoked certificate. Serial is the INTEGER's content bytes,
// written as given, so tests can write negative or non-minimal serials.
type Entry struct {
	Serial         []byte
	RevocationDate time.Time
	Reason         int // reasonCode; 0 leaves the extension out
	Extensions     []Extension
}

// CRL describes the list to write.
type CRL struct {
	IssuerCN   string
	ThisUpdate time.Time
	NextUpdate time.Time // zero leaves it out
	Number     int64     // cRLNumber; negative leaves it out
	Entries    []Entry
	// EmptyList writes an empty revokedCertificates SEQUENCE when there
	// are no entries, instead of leaving the field out.
	EmptyList  bool
	Extensions []Extension // after authorityKeyIdentifier and cRLNumber
}

var (
	oidSHA256WithRSA = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 11}
	oidCountry       = asn1.ObjectIdentifier{2, 5, 4, 6}
	oidOrganization  = asn1.ObjectIdentifier{2, 5, 4, 10}
	oidCommonName    = asn1.ObjectIdentifier{2, 5, 4, 3}

	OIDAuthorityKeyIdentifier   = asn1.ObjectIdentifier{2, 5, 29, 35}
	OIDCRLNumber                = asn1.ObjectIdentifier{2, 5, 29, 20}
	OIDReasonCode               = asn1.ObjectIdentifier{2, 5, 29, 21}
	OIDDeltaCRLIndicator        = asn1.ObjectIdentifier{2, 5, 29, 27}
	OIDIssuingDistributionPoint = asn1.ObjectIdentifier{2, 5, 29, 28}
	OIDFreshestCRL              = asn1.ObjectIdentifier{2, 5, 29, 46}
)

func addAlgorithm(b *cryptobyte.Builder) {
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		b.AddASN1ObjectIdentifier(oidSHA256WithRSA)
		b.AddASN1NULL()
	})
}

func addTime(b *cryptobyte.Builder, t time.Time) {
	t = t.UTC().Truncate(time.Second)
	if t.Year() >= 1950 && t.Year() < 2050 {
		b.AddASN1UTCTime(t)
	} else {
		b.AddASN1GeneralizedTime(t)
	}
}

func addExtensions(b *cryptobyte.Builder, exts []Extension) {
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		for _, x := range exts {
			b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
				b.AddASN1ObjectIdentifier(x.ID)
				if x.Critical {
					b.AddASN1Boolean(true)
				}
				b.AddASN1OctetString(x.Value)
			})
		}
	})
}

// Integer returns the DER encoding of n.
func Integer(n int64) []byte {
	var b cryptobyte.Builder
	b.AddASN1BigInt(big.NewInt(n))
	return b.BytesOrPanic()
}

// TBS returns the DER tbsCertList of c, for an issuer whose key identifier
// is keyID.
func TBS(c *CRL, keyID []byte) []byte {
	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		b.AddASN1Int64(1) // v2
		addAlgorithm(b)
		b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
			for _, rdn := range []struct {
				oid asn1.ObjectIdentifier
				tag cbasn1.Tag
				v   string
			}{{oidCountry, cbasn1.PrintableString, "TW"}, {oidOrganization, cbasn1.UTF8String, "Synthetic CRL test"}, {oidCommonName, cbasn1.UTF8String, c.IssuerCN}} {
				b.AddASN1(cbasn1.SET, func(b *cryptobyte.Builder) {
					b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
						b.AddASN1ObjectIdentifier(rdn.oid)
						b.AddASN1(rdn.tag, func(b *cryptobyte.Builder) { b.AddBytes([]byte(rdn.v)) })
					})
				})
			}
		})
		addTime(b, c.ThisUpdate)
		if !c.NextUpdate.IsZero() {
			addTime(b, c.NextUpdate)
		}
		if len(c.Entries) > 0 || c.EmptyList {
			b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
				for _, e := range c.Entries {
					b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
						b.AddASN1(cbasn1.INTEGER, func(b *cryptobyte.Builder) { b.AddBytes(e.Serial) })
						addTime(b, e.RevocationDate)
						exts := e.Extensions
						if e.Reason != 0 {
							var r cryptobyte.Builder
							r.AddASN1Enum(int64(e.Reason))
							exts = append([]Extension{{ID: OIDReasonCode, Value: r.BytesOrPanic()}}, exts...)
						}
						if len(exts) > 0 {
							addExtensions(b, exts)
						}
					})
				}
			})
		}
		var exts []Extension
		var aki cryptobyte.Builder
		aki.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
			b.AddASN1(cbasn1.Tag(0).ContextSpecific(), func(b *cryptobyte.Builder) { b.AddBytes(keyID) })
		})
		exts = append(exts, Extension{ID: OIDAuthorityKeyIdentifier, Value: aki.BytesOrPanic()})
		if c.Number >= 0 {
			exts = append(exts, Extension{ID: OIDCRLNumber, Value: Integer(c.Number)})
		}
		exts = append(exts, c.Extensions...)
		b.AddASN1(cbasn1.Tag(0).Constructed().ContextSpecific(), func(b *cryptobyte.Builder) {
			addExtensions(b, exts)
		})
	})
	return b.BytesOrPanic()
}

// KeyID is the key identifier of key: SHA-1 would be usual; this uses the
// first 20 bytes of the SHA-256 of the modulus, which is enough for tests.
func KeyID(key *rsa.PublicKey) []byte {
	h := sha256.Sum256(key.N.Bytes())
	return h[:20]
}

// Sign wraps tbs into a CertificateList signed by key.
func Sign(tbs []byte, key *rsa.PrivateKey) []byte {
	digest := sha256.Sum256(tbs)
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		panic(err)
	}
	return Wrap(tbs, sig)
}

// Wrap puts tbs and a signature into a CertificateList.
func Wrap(tbs, sig []byte) []byte {
	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		b.AddBytes(tbs)
		addAlgorithm(b)
		b.AddASN1BitString(sig)
	})
	return b.BytesOrPanic()
}

// Make returns c signed by key.
func Make(c *CRL, key *rsa.PrivateKey) []byte {
	return Sign(TBS(c, KeyID(&key.PublicKey)), key)
}
