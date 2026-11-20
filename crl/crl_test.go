package crl

import (
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type expectedCase struct {
	Name       string `json:"name"`
	What       string `json:"what"`
	Usable     bool   `json:"usable"`
	Reason     string `json:"reason"`
	Entries    int    `json:"entries"`
	CRLNumber  string `json:"crl_number"`
	ThisUpdate string `json:"this_update"`
	NextUpdate string `json:"next_update"`
	CRLDate    string `json:"crl_date"`
	SHA256     string `json:"sha256"`
	Root       string `json:"root"`
}

func testIssuerKey(t testing.TB) *rsa.PublicKey {
	t.Helper()
	der, err := os.ReadFile("testdata/issuer-public-key.der")
	if err != nil {
		t.Fatal(err)
	}
	k, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatal(err)
	}
	return k.(*rsa.PublicKey)
}

// Every synthetic CRL in testdata is usable or not as expected.json says,
// with the root given there.
func TestSyntheticCRLs(t *testing.T) {
	var cases []expectedCase
	readJSON(t, "testdata/expected.json", &cases)
	key := testIssuerKey(t)
	files, _ := filepath.Glob("testdata/*.crl")
	if len(files) != len(cases) || len(cases) < 20 {
		t.Fatalf("%d files, %d cases", len(files), len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			der, err := os.ReadFile(filepath.Join("testdata", c.Name+".crl"))
			if err != nil {
				t.Fatal(err)
			}
			if sum := sha256.Sum256(der); hex.EncodeToString(sum[:]) != c.SHA256 {
				t.Fatal("file differs from expected.json")
			}
			parsed, err := Parse(der)
			if err != nil {
				t.Fatal(err)
			}
			if len(parsed.Entries) != c.Entries {
				t.Errorf("%d entries, want %d", len(parsed.Entries), c.Entries)
			}
			if got := parsed.ThisUpdate.Format(time.RFC3339); got != c.ThisUpdate {
				t.Errorf("thisUpdate %s, want %s", got, c.ThisUpdate)
			}
			if c.NextUpdate == "" != !parsed.HasNextUpdate ||
				(c.NextUpdate != "" && parsed.NextUpdate.Format(time.RFC3339) != c.NextUpdate) {
				t.Errorf("nextUpdate %v, want %q", parsed.NextUpdate, c.NextUpdate)
			}
			if parsed.Date() != c.CRLDate {
				t.Errorf("CRL date %s, want %s", parsed.Date(), c.CRLDate)
			}
			// A cRLNumber that is not a non-negative INTEGER reads as none.
			n, _ := parsed.Number()
			if (n == nil) != (c.CRLNumber == "") || (n != nil && n.String() != c.CRLNumber) {
				t.Errorf("cRLNumber %v, want %q", n, c.CRLNumber)
			}
			keys, err := parsed.Check(key)
			if !c.Usable {
				var u *Unusable
				if !errors.As(err, &u) || u.Code != c.Reason {
					t.Fatalf("got %v, want unusable: %s", err, c.Reason)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			tree, err := NewTree(keys)
			if err != nil {
				t.Fatal(err)
			}
			if tree.RootHex() != c.Root {
				t.Errorf("root %s, want %s", tree.RootHex(), c.Root)
			}
		})
	}
}

// The CRL date is thisUpdate in Taiwan (UTC+8).
func TestDate(t *testing.T) {
	for in, want := range map[string]string{
		"2026-11-15T15:59:59Z": "2026-11-15",
		"2026-11-15T16:00:00Z": "2026-11-16",
		"2026-12-31T23:59:59Z": "2027-01-01",
		"2026-11-16T00:00:00Z": "2026-11-16",
	} {
		tm, _ := time.Parse(time.RFC3339, in)
		if got := (&CRL{ThisUpdate: tm}).Date(); got != want {
			t.Errorf("%s: %s, want %s", in, got, want)
		}
	}
}

func TestParseRejects(t *testing.T) {
	der, err := os.ReadFile("testdata/one.crl")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(der); err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(append(der[:len(der):len(der)], 0)); err == nil {
		t.Error("trailing byte accepted")
	}
	if _, err := Parse(der[:len(der)-1]); err == nil {
		t.Error("truncated CRL accepted")
	}
	// A long-form length where the short form fits is not DER.
	long := append([]byte{0x30, 0x81, byte(len(der) - 2)}, der[2:]...)
	if der[1] < 0x80 {
		if _, err := Parse(long); err == nil {
			t.Error("non-minimal length accepted")
		}
	}
	if _, err := Parse([]byte{}); err == nil {
		t.Error("empty input accepted")
	}
}

// The embedded issuer certificates are those of spec/issuers.md.
func TestIssuers(t *testing.T) {
	var v struct {
		Issuers []struct {
			Issuer            string `json:"issuer"`
			CertificateSHA256 string `json:"certificate_sha256"`
			ModulusBits       int    `json:"modulus_bits"`
			Exponent          int    `json:"exponent"`
			Modulus           string `json:"modulus"`
		} `json:"issuers"`
	}
	readJSON(t, "../spec/vectors/issuers.json", &v)
	if len(v.Issuers) != len(Issuers) {
		t.Fatalf("%d issuers in the vectors, %d here", len(v.Issuers), len(Issuers))
	}
	spec, err := os.ReadFile("../spec/issuers.md")
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range v.Issuers {
		if Issuers[i] != want.Issuer {
			t.Fatalf("issuer %d is %s, want %s", i, Issuers[i], want.Issuer)
		}
		der, err := IssuerCertificate(want.Issuer)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(der)
		got := hex.EncodeToString(sum[:])
		if got != want.CertificateSHA256 {
			t.Errorf("%s: certificate SHA-256 %s, want %s", want.Issuer, got, want.CertificateSHA256)
		}
		if !strings.Contains(string(spec), "| `"+want.Issuer+"` |") || !strings.Contains(string(spec), "`"+got+"`") {
			t.Errorf("%s: SHA-256 %s not in spec/issuers.md", want.Issuer, got)
		}
		key, err := IssuerKey(want.Issuer)
		if err != nil {
			t.Fatal(err)
		}
		if key.N.Cmp(hexInt(t, want.Modulus)) != 0 || key.N.BitLen() != want.ModulusBits || key.E != want.Exponent {
			t.Errorf("%s: key differs from issuers.json", want.Issuer)
		}
	}
	if _, err := IssuerKey("G1"); err == nil {
		t.Error("unknown issuer accepted")
	}
}
