//go:build ignore

// Writes the synthetic CRLs of this directory and expected.json: CRLs whose
// thisUpdate, nextUpdate or an entry's revocationDate is spelled in one of
// many ways, each with its line of the archive index. Run from the
// repository root:
//
//	go run ./crl/testdata/times/generate.go
//
// The answers are those of spec/revocation-tree.md, "Times": only UTCTime
// YYMMDDHHMMSSZ and GeneralizedTime YYYYMMDDHHMMSSZ, of a time that exists,
// are read; a file with any other spelling is not DER. The files at the end
// are of "Object identifiers" in the same way: an extension's identifier
// written as that section says is read, any other is not DER. The last
// ones have an element with more inside than it has: not DER either. crl/, worker/, web/
// and device-core/ all run their tests over this directory.
//
// The lines are written out below by hand; this program stops if crl/ gives
// any other line. Each run signs with a new key that is not kept and that
// nobody trusts, so every file changes, no file is a usable CRL, and every
// line that is read at all says "-not_usable_signature": what is checked
// here is how the times are read and written.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/crl/internal/crltest"
)

// A time as written in the file: the tag and the characters.
type spelled struct {
	generalized bool // GeneralizedTime; otherwise UTCTime
	text        string
}

func utc(text string) *spelled         { return &spelled{false, text} }
func generalized(text string) *spelled { return &spelled{true, text} }

func (s *spelled) der() []byte {
	tag := cbasn1.UTCTime
	if s.generalized {
		tag = cbasn1.GeneralizedTime
	}
	var b cryptobyte.Builder
	b.AddASN1(tag, func(b *cryptobyte.Builder) { b.AddBytes([]byte(s.text)) })
	return b.BytesOrPanic()
}

type timeCase struct {
	name string
	what string
	// thisUpdate, and nextUpdate if next is true; nil is the usual one
	// (2026-11-19T16:00:00Z and 36 hours later, as UTCTime with Z), and
	// a nil nextUpdate with noNext leaves the field out.
	this, next *spelled
	noNext     bool
	// revocation, when not nil, is the revocationDate of the one entry the
	// file then has; otherwise it has none.
	revocation *spelled
	// noNull writes sha256WithRSAEncryption without NULL parameters, in both
	// places (spec/revocation-tree.md, "Reason codes", row 2).
	noNull bool
	// oid, when not nil, is the content of the OBJECT IDENTIFIER of one
	// more extension of the CRL, not critical, written as it is.
	oid []byte
	// entryOID is the same for an extension of the one entry the file then
	// has.
	entryOID []byte
	// change, when not nil, is given the list before it is written.
	change func(*crltest.CRL)
	// What the index line says; all empty if the file is not DER.
	thisUpdate, nextUpdate, crlDate string
}

const (
	usualThis = "2026-11-19T16:00:00Z"
	usualNext = "2026-11-21T04:00:00Z"
	usualDate = "2026-11-20"
)

func this(name string, s *spelled, thisUpdate, crlDate, what string) timeCase {
	c := timeCase{name: name, what: what, this: s, thisUpdate: thisUpdate, crlDate: crlDate}
	if thisUpdate != "" {
		c.nextUpdate = usualNext
	}
	return c
}

func refused(name string, s *spelled, what string) timeCase { return this(name, s, "", "", what) }

var cases = []timeCase{
	// spec/revocation-tree.md, "Times": only UTCTime YYMMDDHHMMSSZ and
	// GeneralizedTime YYYYMMDDHHMMSSZ, the spellings of RFC 5280.
	refused("utc-minutes", utc("2611191600Z"), "UTCTime without seconds"),
	refused("utc-offset-plus", utc("261119160000+0800"), "UTCTime with an offset east of UTC"),
	refused("utc-minutes-offset-minus", utc("2611191600-0330"), "UTCTime without seconds, with an offset west of UTC"),
	refused("utc-offset-plus-zero", utc("261119160000+0000"), "an offset of zero, written +0000"),
	refused("utc-offset-minus-zero", utc("261119160000-0000"), "an offset of zero, written -0000"),
	refused("utc-offset-24-hours", utc("261119160000+2400"), "an offset of 24 hours"),
	refused("utc-offset-minus-24-30", utc("261119160000-2430"), "an offset of 24 hours and 30 minutes, west"),
	refused("utc-offset-25-hours", utc("261119160000+2500"), "an offset of more than 24 hours"),
	refused("utc-offset-60-minutes", utc("261119160000+0860"), "an offset with 60 minutes"),
	this("utc-year-49", utc("491231235959Z"), "2049-12-31T23:59:59Z", "2050-01-01", "UTCTime year 49 is 2049"),
	this("utc-year-50", utc("500101000000Z"), "1950-01-01T00:00:00Z", "1950-01-01", "UTCTime year 50 is 1950"),
	refused("utc-year-50-offset", utc("500101000000+0100"), "an offset, at the turn of the century UTCTime chooses"),
	this("utc-year-68-leap-day", utc("680229120000Z"), "1968-02-29T12:00:00Z", "1968-02-29", "UTCTime year 68 is 1968, a leap year"),
	this("utc-year-69", utc("690101000000Z"), "1969-01-01T00:00:00Z", "1969-01-01", "UTCTime year 69 is 1969"),
	this("utc-year-99", utc("991231235959Z"), "1999-12-31T23:59:59Z", "2000-01-01", "UTCTime year 99 is 1999"),
	refused("utc-year-99-offset", utc("991231235959-0001"), "an offset that would carry into the next century"),
	this("utc-leap-day-2000", utc("000229000000Z"), "2000-02-29T00:00:00Z", "2000-02-29", "2000 is a leap year"),
	refused("utc-leap-day-2027", utc("270229000000Z"), "29 February of a year that is not a leap year"),
	refused("utc-day-31-november", utc("261131000000Z"), "31 November"),
	refused("utc-month-13", utc("261300000000Z"), "month 13"),
	refused("utc-month-0", utc("260001000000Z"), "month 0"),
	refused("utc-day-0", utc("261100000000Z"), "day 0"),
	refused("utc-hour-24", utc("261119240000Z"), "hour 24"),
	refused("utc-minute-60", utc("261119236000Z"), "minute 60"),
	refused("utc-second-60", utc("261119235960Z"), "second 60"),
	refused("utc-no-zone", utc("261119160000"), "no Z and no offset"),
	refused("utc-lowercase-z", utc("261119160000z"), "a lowercase z"),
	refused("utc-fraction", utc("261119160000.5Z"), "a fraction of a second"),
	refused("utc-11-digits", utc("26111916000Z"), "an odd number of digits"),
	refused("utc-four-digit-year", utc("20261119160000Z"), "a four-digit year in a UTCTime"),
	refused("utc-space", utc("2611191600 Z"), "a space"),
	refused("utc-sign-in-year", utc("+61119160000Z"), "a sign where a digit belongs"),
	refused("utc-empty", utc(""), "an empty UTCTime"),
	refused("utc-after-z", utc("261119160000ZZ"), "a character after the Z"),
	this("generalized", generalized("20261119160000Z"), "2026-11-19T16:00:00Z", "2026-11-20", "GeneralizedTime"),
	refused("generalized-offset", generalized("20261119160000+0800"), "GeneralizedTime with an offset"),
	refused("generalized-minutes", generalized("202611191600Z"), "GeneralizedTime without seconds"),
	refused("generalized-fraction", generalized("20261119160000.000Z"), "GeneralizedTime with a fraction of a second"),
	refused("generalized-no-zone", generalized("20261119160000"), "GeneralizedTime with no Z and no offset"),
	refused("generalized-after-z", generalized("20261119160000Z0"), "GeneralizedTime with a character after the Z"),
	refused("generalized-before-year-0", generalized("00000101000000+0100"), "an offset that would give a time before year 0"),
	this("generalized-year-0-leap-day", generalized("00000229000000Z"), "0000-02-29T00:00:00Z", "0000-02-29", "year 0 is a leap year"),
	this("generalized-year-99", generalized("00991231235959Z"), "0099-12-31T23:59:59Z", "0100-01-01", "a GeneralizedTime year below 100 is that year, not 19xx"),
	this("generalized-year-999", generalized("09991231235959Z"), "0999-12-31T23:59:59Z", "1000-01-01", "a year below 1000 keeps four digits"),
	refused("generalized-year-10000", generalized("99991231235959-0100"), "an offset that would give a time in year 10000"),
	this("generalized-year-10000-in-taiwan", generalized("99991231160000Z"), "9999-12-31T16:00:00Z", "10000-01-01", "year 9999 in UTC, year 10000 in Taiwan"),
	refused("generalized-leap-day-1900", generalized("19000229000000Z"), "1900 is not a leap year"),
	this("generalized-leap-day-2400", generalized("24000229000000Z"), "2400-02-29T00:00:00Z", "2400-02-29", "2400 is a leap year"),
	refused("generalized-two-digit-year", generalized("261119160000Z"), "a two-digit year in a GeneralizedTime"),
	// Rows 1 and 2 of the reason codes at once: the time comes first (#218).
	{name: "utc-offset-no-null", what: "a thisUpdate with an offset, and sha256WithRSAEncryption without NULL parameters: the time (check 1) comes before the algorithm (check 2)", this: utc("261119160000+0800"), noNull: true},

	{name: "next-update-absent", what: "no nextUpdate", noNext: true, thisUpdate: usualThis, nextUpdate: "-", crlDate: usualDate},
	{name: "next-update-year-1", what: "nextUpdate is 0001-01-01T00:00:00Z: a time like any other, not a missing one", next: generalized("00010101000000Z"), thisUpdate: usualThis, nextUpdate: "0001-01-01T00:00:00Z", crlDate: usualDate},
	{name: "next-update-offset", what: "nextUpdate with an offset", next: utc("261121040000+0800")},
	{name: "next-update-minutes", what: "nextUpdate without seconds", next: utc("2611210400Z")},
	{name: "next-update-refused", what: "a nextUpdate that is not a time", next: utc("270229000000Z")},

	{name: "revocation-date-generalized", what: "an entry's revocationDate as GeneralizedTime", revocation: generalized("20261118000000Z"), thisUpdate: usualThis, nextUpdate: usualNext, crlDate: usualDate},
	{name: "revocation-date-offset", what: "an entry's revocationDate with an offset", revocation: utc("261118000000+0800")},
	{name: "revocation-date-minutes", what: "an entry's revocationDate without seconds", revocation: utc("2611180000Z")},
	{name: "revocation-date-no-such-day", what: "an entry's revocationDate on 31 November", revocation: utc("261131000000Z")},

	// Not times: the other thing a reader may draw its own line for, kept
	// here because only this directory's lines can say "not DER"
	// (spec/revocation-tree.md, "Object identifiers").
	{name: "oid-number-largest", what: "an extension of the CRL named 1.2.2147483647: the largest number an OBJECT IDENTIFIER may hold, 2^31 - 1", oid: []byte{0x2a, 0x87, 0xff, 0xff, 0xff, 0x7f}, thisUpdate: usualThis, nextUpdate: usualNext, crlDate: usualDate},
	{name: "oid-number-too-large", what: "an extension of the CRL named 1.2.2147483648: a number of 2^31", oid: []byte{0x2a, 0x88, 0x80, 0x80, 0x80, 0x00}},
	{name: "oid-first-number-largest", what: "an extension of the CRL whose OBJECT IDENTIFIER is one number, 2^31 - 1: the first number is bounded as written", oid: []byte{0x87, 0xff, 0xff, 0xff, 0x7f}, thisUpdate: usualThis, nextUpdate: usualNext, crlDate: usualDate},
	{name: "oid-first-number-too-large", what: "an extension of the CRL whose OBJECT IDENTIFIER is one number, 2^31", oid: []byte{0x88, 0x80, 0x80, 0x80, 0x00}},
	{name: "oid-not-shortest", what: "an extension of the CRL whose OBJECT IDENTIFIER has a number that begins with the byte 80", oid: []byte{0x2a, 0x80, 0x01}},
	{name: "oid-unfinished", what: "an extension of the CRL whose OBJECT IDENTIFIER ends in the middle of a number", oid: []byte{0x2a, 0x81}},
	{name: "oid-empty", what: "an extension of the CRL whose OBJECT IDENTIFIER has no content", oid: []byte{}},
	{name: "oid-entry-number-largest", what: "an extension of an entry named 1.2.2147483647", entryOID: []byte{0x2a, 0x87, 0xff, 0xff, 0xff, 0x7f}, thisUpdate: usualThis, nextUpdate: usualNext, crlDate: usualDate},
	{name: "oid-entry-number-too-large", what: "an extension of an entry named 1.2.2147483648", entryOID: []byte{0x2a, 0x88, 0x80, 0x80, 0x80, 0x00}},

	// Nor times: an element with more inside than it has. A reader that
	// walks the elements one at a time (#410) must still find what is left
	// over (spec/revocation-tree.md, "Which CRLs": a DER CertificateList).
	{name: "extension-then-null", what: "an extension of the CRL with a NULL after its value", change: extension(oid123, octets, null)},
	{name: "extension-two-values", what: "an extension of the CRL with two values", change: extension(oid123, octets, octets)},
	{name: "extension-critical-twice", what: "an extension of the CRL with its critical BOOLEAN twice", change: extension(oid123, isTrue, isTrue, octets)},
	{name: "extension-no-value", what: "an extension of the CRL that is its OID alone", change: extension(oid123)},
	{name: "entry-then-null", what: "an entry with a NULL after its revocationDate", change: entry(serial5, revoked, null)},
	{name: "entry-extensions-then-null", what: "an entry with a NULL after its extensions", change: entry(serial5, revoked, seq(seq(oid123, octets)), null)},
	{name: "tbs-then-null", what: "a NULL at the end of tbsCertList, after crlExtensions", change: func(c *crltest.CRL) { c.AfterExtensions = null }},
}

// Elements written out by hand, for the files with more inside an element
// than it has.
var (
	oid123  = []byte{0x06, 0x02, 0x2a, 0x03}
	octets  = []byte{0x04, 0x02, 0x05, 0x00}
	isTrue  = []byte{0x01, 0x01, 0xff}
	null    = []byte{0x05, 0x00}
	serial5 = []byte{0x02, 0x01, 0x05}
	revoked = append([]byte{0x17, 0x0d}, "261118000000Z"...)
)

// seq is a SEQUENCE of the elements given.
func seq(elements ...[]byte) []byte {
	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		for _, e := range elements {
			b.AddBytes(e)
		}
	})
	return b.BytesOrPanic()
}

// extension gives the CRL one more extension, made of these elements.
func extension(elements ...[]byte) func(*crltest.CRL) {
	return func(c *crltest.CRL) { c.Extensions = []crltest.Extension{{Raw: seq(elements...)}} }
}

// entry gives the CRL one entry, made of these elements.
func entry(elements ...[]byte) func(*crltest.CRL) {
	return func(c *crltest.CRL) { c.Entries = []crltest.Entry{{Raw: seq(elements...)}} }
}

type expected struct {
	Name   string `json:"name"`
	What   string `json:"what"`
	SHA256 string `json:"sha256"`
	// The file's line of the archive index, without the LF.
	Line string `json:"line"`
}

func main() {
	dir := "crl/testdata/times"
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Fatal(err)
	}
	keys, err := crl.MOICAKeys()
	if err != nil {
		log.Fatal(err)
	}
	usual := time.Date(2026, 11, 19, 16, 0, 0, 0, time.UTC)
	var out []expected
	for _, c := range cases {
		list := &crltest.CRL{IssuerCN: "Synthetic issuer nobody trusts", ThisUpdate: usual, Number: 4660}
		if c.this != nil {
			list.ThisUpdateDER = c.this.der()
		}
		switch {
		case c.next != nil:
			list.NextUpdateDER = c.next.der()
		case !c.noNext:
			list.NextUpdate = usual.Add(36 * time.Hour)
		}
		if c.revocation != nil {
			list.Entries = []crltest.Entry{{Serial: []byte{0x05}, RevocationDateDER: c.revocation.der()}}
		}
		list.NoNullTBS, list.NoNullOuter = c.noNull, c.noNull
		if c.entryOID != nil {
			list.Entries = []crltest.Entry{{Serial: []byte{0x05}, RevocationDate: usual.Add(-24 * time.Hour), Extensions: []crltest.Extension{{IDContent: c.entryOID, Value: []byte{5, 0}}}}}
		}
		if c.change != nil {
			c.change(list)
		}
		if c.oid != nil {
			list.Extensions = []crltest.Extension{{IDContent: c.oid, Value: []byte{5, 0}}}
		}
		der := crltest.Make(list, key)
		got := crl.IndexFile(der, keys)
		want := crl.IndexLine{Issuer: "-", CRLNumber: "4660", ThisUpdate: c.thisUpdate, NextUpdate: c.nextUpdate, CRLDate: c.crlDate, SHA256: got.SHA256, Root: "-" + crl.ReasonSignature}
		if c.thisUpdate == "" {
			want = crl.IndexLine{Issuer: "-", CRLNumber: "-", ThisUpdate: "-", NextUpdate: "-", CRLDate: "-", SHA256: got.SHA256, Root: "-" + crl.ReasonDER}
		}
		if got != want {
			log.Fatalf("%s:\n got  %s want %s", c.name, got.Line(), want.Line())
		}
		if err := os.WriteFile(filepath.Join(dir, c.name+".crl"), der, 0o644); err != nil {
			log.Fatal(err)
		}
		line := want.Line()
		sum := (&crl.CRL{Raw: der}).SHA256()
		out = append(out, expected{Name: c.name, What: c.what, SHA256: hex.EncodeToString(sum[:]), Line: string(line[:len(line)-1])})
	}
	j, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "expected.json"), append(j, '\n'), 0o644); err != nil {
		log.Fatal(err)
	}
}
