// Package crl reads MOICA's certificate revocation lists and builds the
// revocation tree of spec/revocation-tree.md: which CRLs are usable, the
// tree's root, and proofs that a serial number is not in the tree.
//
// It does not import any other directory of this repository. The issuer
// certificates it checks signatures against are embedded (issuers.go).
package crl

import (
	"bytes"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/asn1"
	"errors"
	"fmt"
	"math/big"
	"time"

	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"
)

// CRL is a parsed CertificateList (RFC 5280 section 5). Parse checks only
// its DER structure; Check decides whether it is usable.
type CRL struct {
	Raw []byte // the whole CertificateList
	TBS []byte // tbsCertList, the bytes the signature covers

	// The AlgorithmIdentifier inside tbsCertList and the one next to the
	// signature, as encoded.
	TBSSignatureAlgorithm []byte
	SignatureAlgorithm    []byte
	Signature             []byte

	Version    int    // 1 or 2
	Issuer     []byte // the issuer Name, as encoded
	ThisUpdate time.Time
	NextUpdate time.Time // zero if absent
	Entries    []Entry
	Extensions []Extension
}

// Entry is one element of revokedCertificates.
type Entry struct {
	// Serial holds the content bytes of userCertificate, without tag and
	// length, exactly as encoded.
	Serial         []byte
	RevocationDate time.Time
	Extensions     []Extension
}

// Extension is one extension of the CRL or of an entry.
type Extension struct {
	ID       asn1.ObjectIdentifier
	Critical bool
	Value    []byte // the content of extnValue
}

var (
	oidSHA256WithRSA            = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 11}
	oidAuthorityKeyIdentifier   = asn1.ObjectIdentifier{2, 5, 29, 35}
	oidCRLNumber                = asn1.ObjectIdentifier{2, 5, 29, 20}
	oidDeltaCRLIndicator        = asn1.ObjectIdentifier{2, 5, 29, 27}
	oidIssuingDistributionPoint = asn1.ObjectIdentifier{2, 5, 29, 28}
)

// Parse reads a DER-encoded CertificateList. It rejects anything that is not
// one, including trailing bytes and DER that is not minimal; it does not
// check the signature or the extensions (see Check).
func Parse(der []byte) (*CRL, error) {
	c := &CRL{Raw: der}
	input := cryptobyte.String(der)
	var list cryptobyte.String
	if !input.ReadASN1(&list, cbasn1.SEQUENCE) || !input.Empty() {
		return nil, errors.New("crl: not a DER SEQUENCE, or trailing bytes")
	}
	var tbs, sigAlg cryptobyte.String
	var tbsFull cryptobyte.String
	if !list.ReadASN1Element(&tbsFull, cbasn1.SEQUENCE) {
		return nil, errors.New("crl: malformed tbsCertList")
	}
	c.TBS = tbsFull
	if !list.ReadASN1Element(&sigAlg, cbasn1.SEQUENCE) {
		return nil, errors.New("crl: malformed signatureAlgorithm")
	}
	c.SignatureAlgorithm = sigAlg
	var sig asn1.BitString
	if !list.ReadASN1BitString(&sig) || sig.BitLength%8 != 0 {
		return nil, errors.New("crl: malformed signatureValue")
	}
	c.Signature = sig.Bytes
	if !list.Empty() {
		return nil, errors.New("crl: trailing data in CertificateList")
	}

	if !tbsFull.ReadASN1(&tbs, cbasn1.SEQUENCE) {
		return nil, errors.New("crl: malformed tbsCertList")
	}
	c.Version = 1
	if tbs.PeekASN1Tag(cbasn1.INTEGER) {
		var v int
		if !tbs.ReadASN1Integer(&v) || v != 1 {
			return nil, errors.New("crl: version is present and not v2")
		}
		c.Version = 2
	}
	var tbsSigAlg cryptobyte.String
	if !tbs.ReadASN1Element(&tbsSigAlg, cbasn1.SEQUENCE) {
		return nil, errors.New("crl: malformed signature in tbsCertList")
	}
	c.TBSSignatureAlgorithm = tbsSigAlg
	var issuer cryptobyte.String
	if !tbs.ReadASN1Element(&issuer, cbasn1.SEQUENCE) {
		return nil, errors.New("crl: malformed issuer")
	}
	c.Issuer = issuer
	var err error
	if c.ThisUpdate, err = readTime(&tbs); err != nil {
		return nil, fmt.Errorf("crl: thisUpdate: %w", err)
	}
	if tbs.PeekASN1Tag(cbasn1.UTCTime) || tbs.PeekASN1Tag(cbasn1.GeneralizedTime) {
		if c.NextUpdate, err = readTime(&tbs); err != nil {
			return nil, fmt.Errorf("crl: nextUpdate: %w", err)
		}
	}
	if tbs.PeekASN1Tag(cbasn1.SEQUENCE) {
		var revoked cryptobyte.String
		if !tbs.ReadASN1(&revoked, cbasn1.SEQUENCE) {
			return nil, errors.New("crl: malformed revokedCertificates")
		}
		for !revoked.Empty() {
			e, err := readEntry(&revoked)
			if err != nil {
				return nil, fmt.Errorf("crl: entry %d: %w", len(c.Entries), err)
			}
			c.Entries = append(c.Entries, e)
		}
	}
	if tbs.PeekASN1Tag(cbasn1.Tag(0).Constructed().ContextSpecific()) {
		if c.Version != 2 {
			return nil, errors.New("crl: crlExtensions in a v1 CRL")
		}
		var outer cryptobyte.String
		if !tbs.ReadASN1(&outer, cbasn1.Tag(0).Constructed().ContextSpecific()) {
			return nil, errors.New("crl: malformed crlExtensions")
		}
		if c.Extensions, err = readExtensions(&outer); err != nil {
			return nil, fmt.Errorf("crl: crlExtensions: %w", err)
		}
		if !outer.Empty() {
			return nil, errors.New("crl: trailing data in crlExtensions")
		}
	}
	if !tbs.Empty() {
		return nil, errors.New("crl: unexpected data in tbsCertList")
	}
	return c, nil
}

func readTime(s *cryptobyte.String) (time.Time, error) {
	var t time.Time
	switch {
	case s.PeekASN1Tag(cbasn1.UTCTime):
		if !s.ReadASN1UTCTime(&t) {
			return t, errors.New("malformed UTCTime")
		}
	case s.PeekASN1Tag(cbasn1.GeneralizedTime):
		if !s.ReadASN1GeneralizedTime(&t) {
			return t, errors.New("malformed GeneralizedTime")
		}
	default:
		return t, errors.New("not a time")
	}
	return t.UTC(), nil
}

func readEntry(s *cryptobyte.String) (Entry, error) {
	var e Entry
	var entry, serial cryptobyte.String
	if !s.ReadASN1(&entry, cbasn1.SEQUENCE) {
		return e, errors.New("malformed entry")
	}
	if !entry.ReadASN1(&serial, cbasn1.INTEGER) {
		return e, errors.New("userCertificate is not an INTEGER")
	}
	e.Serial = serial
	var err error
	if e.RevocationDate, err = readTime(&entry); err != nil {
		return e, fmt.Errorf("revocationDate: %w", err)
	}
	if entry.PeekASN1Tag(cbasn1.SEQUENCE) {
		if e.Extensions, err = readExtensions(&entry); err != nil {
			return e, fmt.Errorf("crlEntryExtensions: %w", err)
		}
	}
	if !entry.Empty() {
		return e, errors.New("unexpected data in entry")
	}
	return e, nil
}

// readExtensions reads Extensions ::= SEQUENCE SIZE (1..MAX) OF Extension.
func readExtensions(s *cryptobyte.String) ([]Extension, error) {
	var seq cryptobyte.String
	if !s.ReadASN1(&seq, cbasn1.SEQUENCE) || seq.Empty() {
		return nil, errors.New("malformed or empty Extensions")
	}
	var out []Extension
	for !seq.Empty() {
		var ext, value cryptobyte.String
		var x Extension
		if !seq.ReadASN1(&ext, cbasn1.SEQUENCE) || !ext.ReadASN1ObjectIdentifier(&x.ID) {
			return nil, errors.New("malformed Extension")
		}
		// critical BOOLEAN DEFAULT FALSE. An explicit FALSE is not DER, but
		// is accepted, as crypto/x509 does.
		if ext.PeekASN1Tag(cbasn1.BOOLEAN) && !ext.ReadASN1Boolean(&x.Critical) {
			return nil, errors.New("malformed Extension")
		}
		if !ext.ReadASN1(&value, cbasn1.OCTET_STRING) || !ext.Empty() {
			return nil, errors.New("malformed Extension")
		}
		x.Value = value
		out = append(out, x)
	}
	return out, nil
}

// Unusable is the error Check returns for a CRL that gives no tree
// (spec/revocation-tree.md, "Which CRLs").
type Unusable struct {
	Reason string
}

func (e *Unusable) Error() string { return "crl: not usable: " + e.Reason }

func unusable(format string, args ...any) error {
	return &Unusable{Reason: fmt.Sprintf(format, args...)}
}

// sha256WithRSAEncryption with NULL parameters, the encoding RFC 4055
// requires.
var sha256WithRSANull = func() []byte {
	b, err := asn1.Marshal(struct {
		Algorithm  asn1.ObjectIdentifier
		Parameters asn1.RawValue
	}{oidSHA256WithRSA, asn1.NullRawValue})
	if err != nil {
		panic(err)
	}
	return b
}()

// Check decides whether c is usable under issuerKey, and returns its keys in
// the order of revokedCertificates. A CRL that is not usable gives an
// *Unusable error:
//
//   - both AlgorithmIdentifiers are sha256WithRSAEncryption with NULL
//     parameters, and the signature verifies under issuerKey;
//   - no deltaCRLIndicator, no issuingDistributionPoint, no extension
//     appearing twice, and no critical extension (of the CRL or of an entry)
//     other than authorityKeyIdentifier and cRLNumber;
//   - every serial number gives a key (KeyFromSerial), and no two keys share
//     their lowest 127 bits.
func (c *CRL) Check(issuerKey *rsa.PublicKey) ([]Key, error) {
	if err := c.VerifySignature(issuerKey); err != nil {
		return nil, err
	}
	if err := checkExtensions(c.Extensions, "CRL"); err != nil {
		return nil, err
	}
	for _, x := range c.Extensions {
		switch {
		case x.ID.Equal(oidDeltaCRLIndicator):
			return nil, unusable("delta CRL (deltaCRLIndicator)")
		case x.ID.Equal(oidIssuingDistributionPoint):
			return nil, unusable("partitioned CRL (issuingDistributionPoint)")
		}
	}
	keys := make([]Key, len(c.Entries))
	for i, e := range c.Entries {
		if err := checkExtensions(e.Extensions, fmt.Sprintf("entry %d", i)); err != nil {
			return nil, err
		}
		k, err := KeyFromSerial(e.Serial)
		if err != nil {
			return nil, unusable("entry %d: %v", i, err)
		}
		keys[i] = k
	}
	if i, j, ok := findCollision(keys); ok {
		return nil, unusable("entries %d and %d share their lowest 127 bits", i, j)
	}
	return keys, nil
}

// VerifySignature checks that both AlgorithmIdentifiers are
// sha256WithRSAEncryption with NULL parameters and that the signature
// verifies under issuerKey. It returns an *Unusable error if not.
func (c *CRL) VerifySignature(issuerKey *rsa.PublicKey) error {
	if !bytes.Equal(c.TBSSignatureAlgorithm, sha256WithRSANull) ||
		!bytes.Equal(c.SignatureAlgorithm, sha256WithRSANull) {
		return unusable("signature algorithm is not sha256WithRSAEncryption")
	}
	digest := sha256.Sum256(c.TBS)
	if err := rsa.VerifyPKCS1v15(issuerKey, crypto.SHA256, digest[:], c.Signature); err != nil {
		return unusable("signature does not verify under the issuer key")
	}
	return nil
}

func checkExtensions(exts []Extension, where string) error {
	for i, x := range exts {
		for _, y := range exts[:i] {
			if x.ID.Equal(y.ID) {
				return unusable("%s: extension %v appears twice", where, x.ID)
			}
		}
		if x.Critical && !x.ID.Equal(oidAuthorityKeyIdentifier) && !x.ID.Equal(oidCRLNumber) &&
			!x.ID.Equal(oidDeltaCRLIndicator) && !x.ID.Equal(oidIssuingDistributionPoint) {
			return unusable("%s: unknown critical extension %v", where, x.ID)
		}
	}
	return nil
}

// Number returns the cRLNumber extension, or nil if there is none.
func (c *CRL) Number() (*big.Int, error) {
	for _, x := range c.Extensions {
		if !x.ID.Equal(oidCRLNumber) {
			continue
		}
		s := cryptobyte.String(x.Value)
		n := new(big.Int)
		if !s.ReadASN1Integer(n) || !s.Empty() || n.Sign() < 0 {
			return nil, errors.New("crl: malformed cRLNumber")
		}
		return n, nil
	}
	return nil, nil
}

// taiwan is UTC+8, without daylight saving time.
var taiwan = time.FixedZone("UTC+8", 8*60*60)

// Date returns the CRL date: thisUpdate as a date in Taiwan, YYYY-MM-DD.
func (c *CRL) Date() string {
	return c.ThisUpdate.In(taiwan).Format(time.DateOnly)
}

// SHA256 returns the SHA-256 of the whole file.
func (c *CRL) SHA256() [32]byte {
	return sha256.Sum256(c.Raw)
}
