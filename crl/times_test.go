package crl

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Every CRL of testdata/times gives the index line expected.json holds:
// how thisUpdate and nextUpdate are read and written
// (spec/revocation-tree.md, "Times"). worker/ reads the same files.
func TestTimeSpellings(t *testing.T) {
	var cases []struct {
		Name   string `json:"name"`
		SHA256 string `json:"sha256"`
		Line   string `json:"line"`
	}
	readJSON(t, "testdata/times/expected.json", &cases)
	files, _ := filepath.Glob("testdata/times/*.crl")
	if len(files) != len(cases) || len(cases) < 40 {
		t.Fatalf("%d files, %d cases", len(files), len(cases))
	}
	read, refused := 0, 0
	for _, c := range cases {
		der, err := os.ReadFile(filepath.Join("testdata", "times", c.Name+".crl"))
		if err != nil {
			t.Fatal(err)
		}
		if sum := sha256.Sum256(der); hex.EncodeToString(sum[:]) != c.SHA256 {
			t.Fatalf("%s: file differs from expected.json", c.Name)
		}
		if got := strings.TrimSuffix(string(IndexFile(der, testKeys(t)).Line()), "\n"); got != c.Line {
			t.Errorf("%s:\n got  %s\n want %s", c.Name, got, c.Line)
		}
		if strings.Contains(c.Line, "-"+ReasonDER) {
			refused++
		} else {
			read++
		}
	}
	if read < 10 || refused < 10 {
		t.Errorf("%d cases read and %d refused: the list should hold both", read, refused)
	}
}

// A nextUpdate of 0001-01-01T00:00:00Z, Go's zero time, is there.
func TestNextUpdateZeroTime(t *testing.T) {
	c, err := Parse(mustRead(t, "testdata/times/next-update-year-1.crl"))
	if err != nil {
		t.Fatal(err)
	}
	if !c.HasNextUpdate || !c.NextUpdate.IsZero() {
		t.Errorf("HasNextUpdate %v, NextUpdate %v", c.HasNextUpdate, c.NextUpdate)
	}
	c, err = Parse(mustRead(t, "testdata/times/next-update-absent.crl"))
	if err != nil {
		t.Fatal(err)
	}
	if c.HasNextUpdate {
		t.Error("a CRL without nextUpdate has one")
	}
}
