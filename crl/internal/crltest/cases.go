package crltest

import (
	"bytes"
	"crypto/rsa"
	"encoding/asn1"
	"math/rand/v2"
	"strings"
	"time"
)

// Case is one synthetic CRL of crl/testdata.
type Case struct {
	Name string
	What string // what the case checks
	DER  []byte
	// Usable is whether the CRL gives a tree; Reason is the reason code
	// (crl.Reason…) when it does not.
	Usable bool
	Reason string
}

// ThisUpdate of every case: 16:30 UTC is already the next day in Taiwan.
var ThisUpdate = time.Date(2026, 11, 15, 16, 30, 0, 0, time.UTC)

// Serial returns n as the content bytes of a positive DER INTEGER: its
// minimal big-endian bytes, with a leading 00 when the top bit is set.
func Serial(n []byte) []byte {
	n = bytes.TrimLeft(n, "\x00")
	if len(n) == 0 {
		return []byte{0}
	}
	if n[0]&0x80 != 0 {
		return append([]byte{0}, n...)
	}
	return bytes.Clone(n)
}

func hexBytes(s string) []byte {
	b := make([]byte, len(s)/2)
	for i := range b {
		var v byte
		for _, c := range s[2*i : 2*i+2] {
			v <<= 4
			switch {
			case c >= '0' && c <= '9':
				v |= byte(c - '0')
			case c >= 'a' && c <= 'f':
				v |= byte(c - 'a' + 10)
			default:
				panic("bad hex " + s)
			}
		}
		b[i] = v
	}
	return b
}

// RandomSerials returns n distinct serials as MOICA's look: positive 16-byte
// integers, with a leading 00 when the top bit is set.
func RandomSerials(r *rand.Rand, n int) [][]byte {
	seen := make(map[[16]byte]bool, n)
	out := make([][]byte, 0, n)
	for len(out) < n {
		var b [16]byte
		for i := range b {
			b[i] = byte(r.Uint32())
		}
		if b[0] == 0 || seen[b] {
			continue
		}
		seen[b] = true
		out = append(out, Serial(b[:]))
	}
	return out
}

// Entries returns one entry per serial, with increasing revocation dates
// before ThisUpdate and reason codes as MOICA uses them.
func Entries(r *rand.Rand, serials [][]byte) []Entry {
	start := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	span := ThisUpdate.Sub(start)
	out := make([]Entry, len(serials))
	for i, s := range serials {
		reasons := []int{1, 3, 4, 5, 6}
		out[i] = Entry{
			Serial:         s,
			RevocationDate: start.Add(span * time.Duration(i) / time.Duration(len(serials))),
			Reason:         reasons[r.IntN(len(reasons))],
		}
	}
	return out
}

func base(r *rand.Rand, serials ...[]byte) *CRL {
	return &CRL{
		IssuerCN:   "Synthetic test issuer",
		ThisUpdate: ThisUpdate,
		NextUpdate: ThisUpdate.Add(36 * time.Hour),
		Number:     4660,
		Entries:    Entries(r, serials),
	}
}

// Cases returns the synthetic CRLs of crl/testdata, signed by key, plus one
// signed by other.
func Cases(key, other *rsa.PrivateKey) []Case {
	r := rand.New(rand.NewPCG(28, 1))
	sixteen := RandomSerials(r, 1000)
	var cases []Case
	add := func(name, what string, usable bool, reason string, c *CRL) {
		cases = append(cases, Case{Name: name, What: what, DER: Make(c, key), Usable: usable, Reason: reason})
	}

	add("empty", "no revokedCertificates field; root 0", true, "", base(r))
	c := base(r)
	c.EmptyList = true
	add("empty-list", "an empty revokedCertificates SEQUENCE; root 0", true, "", c)
	add("one", "one entry", true, "", base(r, Serial(hexBytes("05"))))
	add("moica-like", "1,000 random 16-byte serials, some with a leading 00", true, "", base(r, sixteen...))

	// Keys that differ only in bit 126: the deepest path the tree allows,
	// 127 siblings with the last one at index 126.
	add("top-bit-126", "two 16-byte serials that differ only in bit 126", true, "",
		base(r, Serial(hexBytes("3123456789abcdef0123456789abcdef")), Serial(hexBytes("7123456789abcdef0123456789abcdef"))))
	// Differ only in bit 127: same lowest 127 bits.
	add("top-bit-127", "two 16-byte serials that differ only in their highest bit (127)", false, "not_usable_collision",
		base(r, Serial(hexBytes("3123456789abcdef0123456789abcdef")), Serial(hexBytes("b123456789abcdef0123456789abcdef"))))
	add("same-low-127", "two 20-byte serials that differ only in bit 150", false, "not_usable_collision",
		base(r, Serial(hexBytes("0011223344556677889900112233445566778899")), Serial(hexBytes("0051223344556677889900112233445566778899"))))
	add("duplicate", "the same serial twice: one key", true, "",
		base(r, Serial(hexBytes("05")), Serial(hexBytes("07")), Serial(hexBytes("05"))))
	add("duplicate-and-same-low-127", "the same serial twice, and a different serial that shares its lowest 127 bits", false, "not_usable_collision",
		base(r, Serial(hexBytes("3123456789abcdef0123456789abcdef")), Serial(hexBytes("05")),
			Serial(hexBytes("3123456789abcdef0123456789abcdef")), Serial(hexBytes("b123456789abcdef0123456789abcdef"))))
	add("leading-00", "serials whose top bit is set, encoded with a leading 00 (key is the value without it)", true, "",
		base(r, Serial(hexBytes("80")), Serial(hexBytes("ff00000000000000000000000000000001")), Serial(hexBytes("0102"))))
	add("twenty-bytes", "serials of 20 content bytes, the longest: 7f ff … ff, and 00 ff … fe", true, "",
		base(r, Serial(hexBytes("7f"+strings.Repeat("ff", 19))), Serial(hexBytes(strings.Repeat("ff", 18)+"fe"))))
	add("twenty-one-bytes", "a serial of 21 content bytes: 00 then 20 bytes with the top bit set", false, "not_usable_serial",
		base(r, Serial(hexBytes("05")), Serial(hexBytes("ffffffffffffffffffffffffffffffffffffffff"))))
	add("negative", "a negative serial (content ff 01)", false, "not_usable_serial",
		base(r, Serial(hexBytes("05")), []byte{0xff, 0x01}))
	add("non-minimal", "a serial with a superfluous leading 00 (00 05)", false, "not_usable_serial",
		base(r, Serial(hexBytes("07")), []byte{0x00, 0x05}))
	add("zero", "serial 0 (content 00): a key like any other", true, "",
		base(r, []byte{0x00}, Serial(hexBytes("05"))))

	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{{ID: OIDDeltaCRLIndicator, Critical: true, Value: Integer(4659)}}
	add("delta", "a delta CRL with a critical deltaCRLIndicator: the critical extension (check 5) comes before the delta (check 6)", false, "not_usable_critical_extension", c)
	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{{ID: OIDDeltaCRLIndicator, Value: Integer(4659)}}
	add("delta-noncritical", "deltaCRLIndicator marked non-critical", false, "not_usable_delta", c)
	c = base(r, Serial(hexBytes("05")))
	idp, _ := asn1.Marshal(struct{}{}) // IssuingDistributionPoint with every field absent
	c.Extensions = []Extension{{ID: OIDIssuingDistributionPoint, Critical: true, Value: idp}}
	add("idp", "a partitioned CRL with a critical issuingDistributionPoint: the critical extension (check 5) comes before the partition (check 7)", false, "not_usable_critical_extension", c)
	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{{ID: OIDIssuingDistributionPoint, Value: idp}}
	add("idp-noncritical", "issuingDistributionPoint marked non-critical", false, "not_usable_partitioned", c)
	// Both: checks 6 and 7 are one step, and the extension that comes first
	// in the CRL decides (spec/revocation-tree.md, "Reason codes").
	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{{ID: OIDIssuingDistributionPoint, Value: idp}, {ID: OIDDeltaCRLIndicator, Value: Integer(4659)}}
	add("idp-then-delta", "issuingDistributionPoint before deltaCRLIndicator, both non-critical: the first of the two decides", false, "not_usable_partitioned", c)
	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{{ID: OIDDeltaCRLIndicator, Value: Integer(4659)}, {ID: OIDIssuingDistributionPoint, Value: idp}}
	add("delta-then-idp", "deltaCRLIndicator before issuingDistributionPoint, both non-critical: the first of the two decides", false, "not_usable_delta", c)
	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{{ID: asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 99999, 1}, Critical: true, Value: []byte{5, 0}}}
	add("unknown-critical", "an unknown critical CRL extension", false, "not_usable_critical_extension", c)
	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{{ID: asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 99999, 1}, Value: []byte{5, 0}}}
	add("unknown-noncritical", "an unknown non-critical CRL extension", true, "", c)
	c = base(r, Serial(hexBytes("05")))
	c.CriticalAKI = true
	add("critical-aki", "authorityKeyIdentifier marked critical: no extension may be critical", false, "not_usable_critical_extension", c)
	c = base(r, Serial(hexBytes("05")))
	c.CriticalNumber = true
	add("critical-number", "cRLNumber marked critical: no extension may be critical", false, "not_usable_critical_extension", c)
	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{
		{ID: asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 99999, 1}, Critical: true, Value: []byte{5, 0}},
		{ID: OIDCRLNumber, Value: Integer(4660)},
	}
	add("critical-and-duplicate", "a critical CRL extension, then cRLNumber twice: the duplicate (check 4) comes before the critical extension (check 5)", false, "not_usable_duplicate_extension", c)
	c = base(r, Serial(hexBytes("05")), Serial(hexBytes("06")))
	c.Entries[1].Extensions = []Extension{{ID: asn1.ObjectIdentifier{2, 5, 29, 29}, Critical: true, Value: []byte{0x30, 0}}}
	add("entry-critical", "an entry with a critical certificateIssuer extension (an indirect CRL)", false, "not_usable_critical_extension", c)
	c = base(r, Serial(hexBytes("05")), Serial(hexBytes("06")))
	c.Entries[1].CriticalReason = true
	add("entry-critical-reason", "an entry whose reasonCode is marked critical: no extension may be critical", false, "not_usable_critical_extension", c)
	c = base(r, Serial(hexBytes("05")), []byte{0xff, 0x01})
	c.Entries[1].CriticalReason = true
	add("entry-critical-and-negative", "one entry with a critical reasonCode and a negative serial: within the entry, the critical extension comes first", false, "not_usable_critical_extension", c)
	c = base(r, []byte{0xff, 0x01}, Serial(hexBytes("06")))
	c.Entries[1].CriticalReason = true
	add("negative-then-entry-critical", "a negative serial, then an entry with a critical reasonCode: the first entry with a problem decides", false, "not_usable_serial", c)
	c = base(r, Serial(hexBytes("05")))
	c.Entries[0].CriticalReason = true
	c.Number = -1
	add("no-number-entry-critical", "no cRLNumber, and an entry with a critical reasonCode: the CRL number (check 8) comes before the entries (check 9)", false, "not_usable_crl_number", c)
	c = base(r, Serial(hexBytes("05")))
	c.Number = -1
	add("no-number", "no cRLNumber extension", false, "not_usable_crl_number", c)
	c = base(r, Serial(hexBytes("05")))
	c.Number = -1
	c.Extensions = []Extension{{ID: OIDCRLNumber, Value: Integer(-4660)}}
	add("negative-number", "a cRLNumber that is negative (-4660)", false, "not_usable_crl_number", c)
	// RFC 5280 section 5.2.3: a cRLNumber is at most 20 octets. Counted as
	// for serial numbers: the content bytes, a leading 00 included.
	c = base(r, Serial(hexBytes("05")))
	c.Number = -1
	c.Extensions = []Extension{{ID: OIDCRLNumber, Value: append([]byte{0x02, 20, 0x7f}, bytes.Repeat([]byte{0xff}, 19)...)}}
	add("number-twenty-bytes", "a cRLNumber of 20 content bytes, the longest: 7f ff … ff", true, "", c)
	c = base(r, Serial(hexBytes("05")))
	c.Number = -1
	c.Extensions = []Extension{{ID: OIDCRLNumber, Value: append([]byte{0x02, 21, 0x00}, bytes.Repeat([]byte{0xff}, 20)...)}}
	add("number-twenty-one-bytes", "a cRLNumber of 21 content bytes: 00 then 20 bytes ff, a value below 2^160", false, "not_usable_crl_number", c)
	c = base(r, Serial(hexBytes("05")))
	c.Extensions = []Extension{{ID: OIDCRLNumber, Value: Integer(4661)}}
	add("duplicate-number", "cRLNumber twice", false, "not_usable_duplicate_extension", c)
	c = base(r, Serial(hexBytes("05")))
	c.NextUpdate = time.Time{}
	add("no-next-update", "no nextUpdate", true, "", c)

	c = base(r, Serial(hexBytes("05")))
	c.NoNullTBS, c.NoNullOuter = true, true
	add("no-null-parameters", "sha256WithRSAEncryption without NULL parameters, in both places, correctly signed", false, "not_usable_algorithm", c)
	c = base(r, Serial(hexBytes("05")))
	c.NoNullOuter = true
	add("no-null-outer", "NULL parameters in tbsCertList but not next to the signature, correctly signed", false, "not_usable_algorithm", c)

	c = base(r, Serial(hexBytes("05")), Serial(hexBytes("06")))
	der := Make(c, key)
	der[len(der)-1] ^= 1
	cases = append(cases, Case{Name: "bad-signature", What: "the last byte of the signature changed", DER: der, Usable: false, Reason: "not_usable_signature"})
	c = base(r, Serial(hexBytes("05")), Serial(hexBytes("06")))
	cases = append(cases, Case{Name: "other-key", What: "signed by another key", DER: Make(c, other), Usable: false, Reason: "not_usable_signature"})
	return cases
}
