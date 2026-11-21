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
	NextUpdate time.Time // meaningful only if HasNextUpdate
	// HasNextUpdate is whether the CRL has a nextUpdate field. NextUpdate
	// being the zero time does not say: 0001-01-01T00:00:00Z is a time a
	// CRL can carry.
	HasNextUpdate bool
	Entries       []Entry
	// Extensions holds the CRL's extensions, but no more than
	// MaxExtensions+1: a CRL with more is not usable, and Parse keeps no
	// more than it needs to tell.
	Extensions []Extension
}

// Entry is one element of revokedCertificates.
type Entry struct {
	// Serial holds the content bytes of userCertificate, without tag and
	// length, exactly as encoded.
	Serial         []byte
	RevocationDate time.Time
	// Extensions holds the entry's extensions, but no more than
	// MaxExtensions+1, as CRL.Extensions.
	Extensions []Extension
}

// Extension is one extension of the CRL or of an entry.
type Extension struct {
	ID       asn1.ObjectIdentifier
	Critical bool
	Value    []byte // the content of extnValue
}

var (
	oidSHA256WithRSA            = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 11}
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
		c.HasNextUpdate = true
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

// readTime reads a time as RFC 5280 spells it (spec/revocation-tree.md,
// "Times"): a UTCTime YYMMDDHHMMSSZ, whose years 50 to 99 are 19xx and 00
// to 49 are 20xx, or a GeneralizedTime YYYYMMDDHHMMSSZ, of a time that
// exists. Anything else, an offset or a missing second included, is an
// error. Go's cryptobyte reads more than these, so it is not used here.
func readTime(s *cryptobyte.String) (time.Time, error) {
	var text cryptobyte.String
	yearDigits := 0
	switch {
	case s.PeekASN1Tag(cbasn1.UTCTime):
		yearDigits = 2
		if !s.ReadASN1(&text, cbasn1.UTCTime) {
			return time.Time{}, errors.New("malformed UTCTime")
		}
	case s.PeekASN1Tag(cbasn1.GeneralizedTime):
		yearDigits = 4
		if !s.ReadASN1(&text, cbasn1.GeneralizedTime) {
			return time.Time{}, errors.New("malformed GeneralizedTime")
		}
	default:
		return time.Time{}, errors.New("not a time")
	}
	digits := yearDigits + 10
	if len(text) != digits+1 || text[digits] != 'Z' {
		return time.Time{}, errors.New("a time not spelled YYMMDDHHMMSSZ or YYYYMMDDHHMMSSZ")
	}
	n := make([]int, 0, 6)
	for i := 0; i < digits; {
		width := 2
		if i == 0 {
			width = yearDigits
		}
		v := 0
		for _, c := range text[i : i+width] {
			if c < '0' || c > '9' {
				return time.Time{}, errors.New("a time with a character that is not a digit")
			}
			v = v*10 + int(c-'0')
		}
		n = append(n, v)
		i += width
	}
	year, month, day, hour, minute, second := n[0], n[1], n[2], n[3], n[4], n[5]
	if yearDigits == 2 {
		if year >= 50 {
			year += 1900
		} else {
			year += 2000
		}
	}
	t := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
	// time.Date carries what is out of range into the next field.
	if t.Year() != year || int(t.Month()) != month || t.Day() != day || t.Hour() != hour || t.Minute() != minute || t.Second() != second {
		return time.Time{}, errors.New("no such time")
	}
	return t, nil
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

// MaxExtensions is the most extensions the CRL, and each entry, may have
// (spec/revocation-tree.md, "Which CRLs").
const MaxExtensions = 16

// readExtensions reads Extensions ::= SEQUENCE SIZE (1..MAX) OF Extension.
// It checks every extension, but keeps only the first MaxExtensions+1.
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
		if len(out) <= MaxExtensions {
			out = append(out, x)
		}
	}
	return out, nil
}

// Unusable is the error Check returns for a CRL that gives no tree
// (spec/revocation-tree.md, "Which CRLs"). Code is one of the Reason
// constants; Reason says why, for people.
type Unusable struct {
	Code   string
	Reason string
}

func (e *Unusable) Error() string { return "crl: not usable (" + e.Code + "): " + e.Reason }

// Reason codes of a CRL that is not usable, as the archive index writes them
// after "-" in place of the root (spec/revocation-tree.md, "Archive index").
// When several apply, the first in this order is given.
const (
	// Not a DER CertificateList (Parse fails).
	ReasonDER = "not_usable_der"
	// An AlgorithmIdentifier is not sha256WithRSAEncryption with NULL
	// parameters.
	ReasonAlgorithm = "not_usable_algorithm"
	// The signature does not verify under the issuer key (in the index: under
	// neither G2 nor G3).
	ReasonSignature = "not_usable_signature"
	// More than MaxExtensions extensions, in the CRL or in an entry.
	ReasonTooManyExtensions = "not_usable_too_many_extensions"
	// An extension appears twice, in the CRL or in an entry.
	ReasonDuplicateExtension = "not_usable_duplicate_extension"
	// A critical extension, whichever it is, in the CRL or in an entry.
	ReasonCriticalExtension = "not_usable_critical_extension"
	// A delta CRL (deltaCRLIndicator, critical or not).
	ReasonDelta = "not_usable_delta"
	// A partitioned CRL (issuingDistributionPoint, critical or not).
	ReasonPartitioned = "not_usable_partitioned"
	// No cRLNumber, or one that is not a non-negative INTEGER.
	ReasonCRLNumber = "not_usable_crl_number"
	// A serial number that gives no key: empty, negative, not in its
	// shortest encoding, or more than 20 content bytes.
	ReasonSerial = "not_usable_serial"
	// Two different keys share their lowest 127 bits.
	ReasonCollision = "not_usable_collision"
)

// Reasons lists the reason codes in the order Check applies them to the
// CRL. ReasonTooManyExtensions, ReasonDuplicateExtension,
// ReasonCriticalExtension and ReasonSerial also apply to each entry, after
// ReasonCRLNumber (see Check).
var Reasons = []string{
	ReasonDER, ReasonAlgorithm, ReasonSignature, ReasonTooManyExtensions, ReasonDuplicateExtension,
	ReasonCriticalExtension, ReasonDelta, ReasonPartitioned, ReasonCRLNumber,
	ReasonSerial, ReasonCollision,
}

func unusable(code, format string, args ...any) error {
	return &Unusable{Code: code, Reason: fmt.Sprintf(format, args...)}
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

// Check decides whether c is usable under issuerKey, and returns its keys:
// one per distinct serial number, in the order of their first appearance in
// revokedCertificates. A CRL that is not usable gives an *Unusable error.
// The checks, in the order their reason codes are given:
//
//   - both AlgorithmIdentifiers are sha256WithRSAEncryption with NULL
//     parameters, and the signature verifies under issuerKey;
//   - the CRL has at most MaxExtensions extensions;
//   - no extension of the CRL appears twice;
//   - no extension of the CRL is critical, whichever it is;
//   - no deltaCRLIndicator and no issuingDistributionPoint, critical or not;
//   - a cRLNumber holding a non-negative INTEGER;
//   - entry by entry, the first entry with a problem deciding: at most
//     MaxExtensions extensions, no extension of the entry appears twice,
//     none is critical, and the serial number gives a key (KeyFromSerial),
//     in this order;
//   - no two different keys share their lowest 127 bits. The same serial
//     number listed twice is one key.
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
			return nil, unusable(ReasonDelta, "delta CRL (deltaCRLIndicator)")
		case x.ID.Equal(oidIssuingDistributionPoint):
			return nil, unusable(ReasonPartitioned, "partitioned CRL (issuingDistributionPoint)")
		}
	}
	switch n, err := c.Number(); {
	case err != nil:
		return nil, unusable(ReasonCRLNumber, "%v", err)
	case n == nil:
		return nil, unusable(ReasonCRLNumber, "no cRLNumber extension")
	}
	keys := make([]Key, 0, len(c.Entries))
	entryOf := make([]int, 0, len(c.Entries)) // the entry each key comes from
	seen := make(map[Key]bool, len(c.Entries))
	for i, e := range c.Entries {
		if err := checkExtensions(e.Extensions, fmt.Sprintf("entry %d", i)); err != nil {
			return nil, err
		}
		k, err := KeyFromSerial(e.Serial)
		if err != nil {
			return nil, unusable(ReasonSerial, "entry %d: %v", i, err)
		}
		if seen[k] {
			continue // the same serial number again: one key
		}
		seen[k] = true
		keys = append(keys, k)
		entryOf = append(entryOf, i)
	}
	if i, j, ok := findCollision(keys); ok {
		return nil, unusable(ReasonCollision, "entries %d and %d are different serial numbers that share their lowest 127 bits", entryOf[i], entryOf[j])
	}
	return keys, nil
}

// VerifySignature checks that both AlgorithmIdentifiers are
// sha256WithRSAEncryption with NULL parameters and that the signature
// verifies under issuerKey. It returns an *Unusable error if not.
func (c *CRL) VerifySignature(issuerKey *rsa.PublicKey) error {
	if !c.algorithmsOK() {
		return unusable(ReasonAlgorithm, "signature algorithm is not sha256WithRSAEncryption with NULL parameters")
	}
	if !c.signedBy(issuerKey) {
		return unusable(ReasonSignature, "signature does not verify under the issuer key")
	}
	return nil
}

func (c *CRL) algorithmsOK() bool {
	return bytes.Equal(c.TBSSignatureAlgorithm, sha256WithRSANull) &&
		bytes.Equal(c.SignatureAlgorithm, sha256WithRSANull)
}

// signedBy reports whether the signature verifies under key as an
// RSASSA-PKCS1-v1_5 signature with SHA-256, whatever the
// AlgorithmIdentifiers say.
func (c *CRL) signedBy(key *rsa.PublicKey) bool {
	digest := sha256.Sum256(c.TBS)
	return rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], c.Signature) == nil
}

// checkExtensions checks the extensions of the CRL or of one entry: first
// that there are at most MaxExtensions, then that none appears twice, then
// that none is critical. No extension may be critical, not even one these
// rules read (spec/revocation-tree.md, "Which CRLs").
func checkExtensions(exts []Extension, where string) error {
	if len(exts) > MaxExtensions {
		return unusable(ReasonTooManyExtensions, "%s: more than %d extensions", where, MaxExtensions)
	}
	for i, x := range exts {
		for _, y := range exts[:i] {
			if x.ID.Equal(y.ID) {
				return unusable(ReasonDuplicateExtension, "%s: extension %v appears twice", where, x.ID)
			}
		}
	}
	for _, x := range exts {
		if x.Critical {
			return unusable(ReasonCriticalExtension, "%s: critical extension %v", where, x.ID)
		}
	}
	return nil
}

// MaxCRLNumberBytes is the most content bytes a cRLNumber may have, a
// leading 00 included (RFC 5280 section 5.2.3).
const MaxCRLNumberBytes = 20

// Number returns the cRLNumber extension, or nil if there is none. It is an
// error if the extension does not hold a non-negative INTEGER in DER of at
// most MaxCRLNumberBytes content bytes, or if the CRL has more than
// MaxExtensions extensions (Parse does not keep them all). The length is
// checked before the bytes become a number, so a long one costs no more
// than reading it.
func (c *CRL) Number() (*big.Int, error) {
	if len(c.Extensions) > MaxExtensions {
		return nil, fmt.Errorf("crl: more than %d extensions", MaxExtensions)
	}
	for _, x := range c.Extensions {
		if !x.ID.Equal(oidCRLNumber) {
			continue
		}
		s := cryptobyte.String(x.Value)
		peek := s
		var content cryptobyte.String
		if !peek.ReadASN1(&content, cbasn1.INTEGER) || len(content) > MaxCRLNumberBytes {
			return nil, errors.New("crl: malformed cRLNumber, or longer than 20 bytes")
		}
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
