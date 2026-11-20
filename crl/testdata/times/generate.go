//go:build ignore

// Writes the synthetic CRLs of this directory and expected.json: CRLs whose
// thisUpdate or nextUpdate is spelled in one of the ways
// spec/revocation-tree.md ("Times") accepts or refuses, each with the line
// of the archive index it must give. Run from the repository root:
//
//	go run ./crl/testdata/times/generate.go
//
// The answers are written out below, by hand from the spec; this program
// stops if crl/ gives any other line. Each run signs with a new key that is
// not kept and that nobody trusts, so every file changes, no file is a
// usable CRL, and every line that is read at all says
// "-not_usable_signature": what is checked here is how the times are read
// and written.
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
	this("utc-minutes", utc("2611191600Z"), "2026-11-19T16:00:00Z", "2026-11-20", "UTCTime without seconds"),
	this("utc-offset-plus", utc("261119160000+0800"), "2026-11-19T08:00:00Z", "2026-11-19", "UTCTime with an offset east of UTC"),
	this("utc-minutes-offset-minus", utc("2611191600-0330"), "2026-11-19T19:30:00Z", "2026-11-20", "UTCTime without seconds, with an offset west of UTC"),
	refused("utc-offset-plus-zero", utc("261119160000+0000"), "an offset of zero is written Z"),
	refused("utc-offset-minus-zero", utc("261119160000-0000"), "an offset of zero is written Z"),
	this("utc-offset-24-hours", utc("261119160000+2400"), "2026-11-18T16:00:00Z", "2026-11-19", "an offset of 24 hours"),
	this("utc-offset-minus-24-30", utc("261119160000-2430"), "2026-11-20T16:30:00Z", "2026-11-21", "an offset of 24 hours and 30 minutes, west"),
	refused("utc-offset-25-hours", utc("261119160000+2500"), "an offset of more than 24 hours"),
	refused("utc-offset-60-minutes", utc("261119160000+0860"), "an offset with 60 minutes"),
	this("utc-year-49", utc("491231235959Z"), "2049-12-31T23:59:59Z", "2050-01-01", "UTCTime year 49 is 2049"),
	this("utc-year-50", utc("500101000000Z"), "1950-01-01T00:00:00Z", "1950-01-01", "UTCTime year 50 is 1950"),
	this("utc-year-50-offset", utc("500101000000+0100"), "1949-12-31T23:00:00Z", "1950-01-01", "the century is chosen from the year as written, before the offset"),
	this("utc-year-68-leap-day", utc("680229120000Z"), "1968-02-29T12:00:00Z", "1968-02-29", "UTCTime year 68 is 1968, a leap year"),
	this("utc-year-69", utc("690101000000Z"), "1969-01-01T00:00:00Z", "1969-01-01", "UTCTime year 69 is 1969"),
	this("utc-year-99-offset", utc("991231235959-0001"), "2000-01-01T00:00:59Z", "2000-01-01", "an offset that carries into the next century"),
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
	this("generalized", generalized("20261119160000Z"), "2026-11-19T16:00:00Z", "2026-11-20", "GeneralizedTime"),
	this("generalized-offset", generalized("20261119160000+0800"), "2026-11-19T08:00:00Z", "2026-11-19", "GeneralizedTime with an offset"),
	refused("generalized-minutes", generalized("202611191600Z"), "GeneralizedTime without seconds"),
	refused("generalized-fraction", generalized("20261119160000.000Z"), "GeneralizedTime with a fraction of a second"),
	refused("generalized-no-zone", generalized("20261119160000"), "GeneralizedTime with no Z and no offset"),
	this("generalized-before-year-0", generalized("00000101000000+0100"), "-0001-12-31T23:00:00Z", "0000-01-01", "a time in the year before year 0"),
	this("generalized-year-0-leap-day", generalized("00000229000000Z"), "0000-02-29T00:00:00Z", "0000-02-29", "year 0 is a leap year"),
	this("generalized-year-999", generalized("09991231235959Z"), "0999-12-31T23:59:59Z", "1000-01-01", "a year below 1000 keeps four digits"),
	this("generalized-year-10000", generalized("99991231235959-0100"), "10000-01-01T00:59:59Z", "10000-01-01", "a time in year 10000"),
	this("generalized-year-10000-in-taiwan", generalized("99991231160000Z"), "9999-12-31T16:00:00Z", "10000-01-01", "year 9999 in UTC, year 10000 in Taiwan"),
	refused("generalized-leap-day-1900", generalized("19000229000000Z"), "1900 is not a leap year"),
	this("generalized-leap-day-2400", generalized("24000229000000Z"), "2400-02-29T00:00:00Z", "2400-02-29", "2400 is a leap year"),
	refused("generalized-two-digit-year", generalized("261119160000Z"), "a two-digit year in a GeneralizedTime"),

	{name: "next-update-absent", what: "no nextUpdate", noNext: true, thisUpdate: usualThis, nextUpdate: "-", crlDate: usualDate},
	{name: "next-update-year-1", what: "nextUpdate is 0001-01-01T00:00:00Z: a time like any other, not a missing one", next: generalized("00010101000000Z"), thisUpdate: usualThis, nextUpdate: "0001-01-01T00:00:00Z", crlDate: usualDate},
	{name: "next-update-offset", what: "nextUpdate with an offset", next: utc("261121040000+0800"), thisUpdate: usualThis, nextUpdate: "2026-11-20T20:00:00Z", crlDate: usualDate},
	{name: "next-update-refused", what: "a nextUpdate that is not a time", next: utc("270229000000Z")},
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
