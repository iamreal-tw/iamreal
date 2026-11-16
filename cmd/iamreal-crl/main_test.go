package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/crl"
)

const testdata = "../../crl/testdata"

var testKey = filepath.Join(testdata, "issuer-public-key.der")

type expectedCase struct {
	Name   string `json:"name"`
	Usable bool   `json:"usable"`
	Reason string `json:"reason"`
	SHA256 string `json:"sha256"`
	Root   string `json:"root"`
}

func expected(t *testing.T) map[string]expectedCase {
	raw, err := os.ReadFile(filepath.Join(testdata, "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []expectedCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	m := map[string]expectedCase{}
	for _, c := range cases {
		m[c.SHA256] = c
	}
	return m
}

func TestCheck(t *testing.T) {
	var out bytes.Buffer
	if err := check([]string{"-key", testKey, filepath.Join(testdata, "one.crl")}, &out); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"crl_number   4660\n", "this_update  2026-11-15T16:30:00Z\n", "crl_date     2026-11-16\n",
		"usable       yes\n", "root         12b47395d98620576c5a8c714a9407c9b2d3a7ff91661f67ffb79c2b03b7ea32\n",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q in\n%s", want, out.String())
		}
	}
	out.Reset()
	err := check([]string{"-key", testKey, filepath.Join(testdata, "delta.crl")}, &out)
	var u *crl.Unusable
	if !errors.As(err, &u) || !strings.Contains(out.String(), "usable       no\n") {
		t.Errorf("delta CRL: %v\n%s", err, out.String())
	}
	// A test CRL is not signed by MOICA's keys.
	err = check([]string{"-issuer", "G3", filepath.Join(testdata, "one.crl")}, &out)
	if !errors.As(err, &u) {
		t.Errorf("test CRL under G3: %v", err)
	}
}

func TestProve(t *testing.T) {
	var out bytes.Buffer
	// spec/vectors/poseidon2.json, revocation_tree case 1, serial 0x4.
	if err := prove([]string{"-key", testKey, "-serial", "04", filepath.Join(testdata, "one.crl")}, &out); err != nil {
		t.Fatal(err)
	}
	var p struct {
		Root     string   `json:"smt_root"`
		Siblings []string `json:"smt_siblings"`
		OldKey   string   `json:"smt_old_key"`
		OldValue string   `json:"smt_old_value"`
		IsOld0   bool     `json:"smt_is_old0"`
	}
	if err := json.Unmarshal(out.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Root != "0x12b47395d98620576c5a8c714a9407c9b2d3a7ff91661f67ffb79c2b03b7ea32" || len(p.Siblings) != crl.Depth ||
		p.OldKey != "0x5" || p.OldValue != "0x1" || p.IsOld0 {
		t.Errorf("proof %+v", p)
	}
	for _, s := range p.Siblings {
		if s != "0x0" {
			t.Errorf("sibling %s", s)
		}
	}
	out.Reset()
	if err := prove([]string{"-key", testKey, "-serial", "0x5", filepath.Join(testdata, "one.crl")}, &out); !errors.Is(err, crl.ErrInTree) {
		t.Errorf("revoked serial: %v", err)
	}
}

// index lists every file, usable or not, with the root or reason of
// expected.json, in the line format of the spec.
func TestIndex(t *testing.T) {
	dir := t.TempDir()
	files, _ := filepath.Glob(filepath.Join(testdata, "*.crl"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, filepath.Base(f)), b, 0o600)
	}
	os.WriteFile(filepath.Join(dir, "junk"), []byte("not a CRL"), 0o600)
	os.WriteFile(filepath.Join(dir, crl.IndexFileName), []byte("skipped"), 0o600)
	os.WriteFile(filepath.Join(dir, ".hidden"), []byte("skipped"), 0o600)

	var out, errs bytes.Buffer
	err := index([]string{"-key", testKey, dir}, &out, &errs)
	var u *crl.Unusable
	if !errors.As(err, &u) {
		t.Fatalf("want a report of unusable files, got %v", err)
	}
	want := expected(t)
	line := regexp.MustCompile(`^\{"issuer":"(test|-)","crl_number":"(-|0|[1-9][0-9]*)","this_update":"(-|[0-9TZ:-]{20})","next_update":"(-|[0-9TZ:-]{20})","crl_date":"(-|[0-9]{4}-[0-9]{2}-[0-9]{2})","sha256":"([0-9a-f]{64})","root":"([0-9a-f]{64}|-[a-z0-9_]+)"\}$`)
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != len(files)+1 {
		t.Fatalf("%d lines, %d files", len(lines), len(files)+1)
	}
	junk := 0
	for _, l := range lines {
		m := line.FindStringSubmatch(l)
		if m == nil {
			t.Fatalf("line does not match the format: %s", l)
		}
		c, ok := want[m[6]]
		if !ok {
			if m[7] != "-"+crl.ReasonDER || m[1] != "-" || m[3] != "-" {
				t.Errorf("junk line %s", l)
			}
			junk++
			continue
		}
		wantRoot := c.Root
		if !c.Usable {
			wantRoot = "-" + c.Reason
		}
		if m[7] != wantRoot {
			t.Errorf("%s: root %s, want %s", c.Name, m[7], wantRoot)
		}
		// Only other-key and bad-signature verify under no key.
		if (m[1] == "-") != (c.Name == "other-key" || c.Name == "bad-signature") {
			t.Errorf("%s: issuer %s", c.Name, m[1])
		}
	}
	if junk != 1 {
		t.Errorf("%d lines not in expected.json", junk)
	}
	if n := strings.Count(errs.String(), "not usable"); n != len(lines)-usableCount(want) {
		t.Errorf("%d reported on stderr\n%s", n, errs.String())
	}
}

func usableCount(m map[string]expectedCase) int {
	n := 0
	for _, c := range m {
		if c.Usable {
			n++
		}
	}
	return n
}

// check reports why a CRL is not usable, with exit status 1 (an *Unusable),
// also for a file that is not a CRL and for a missing cRLNumber.
func TestCheckReasons(t *testing.T) {
	junk := filepath.Join(t.TempDir(), "junk")
	os.WriteFile(junk, []byte("not a CRL"), 0o600)
	for path, reason := range map[string]string{
		filepath.Join(testdata, "no-number.crl"):       crl.ReasonCRLNumber,
		filepath.Join(testdata, "negative-number.crl"): crl.ReasonCRLNumber,
		filepath.Join(testdata, "negative.crl"):        crl.ReasonSerial,
		junk:                                           crl.ReasonDER,
	} {
		var out bytes.Buffer
		err := check([]string{"-key", testKey, path}, &out)
		var u *crl.Unusable
		if !errors.As(err, &u) || u.Code != reason || !strings.Contains(out.String(), "reason       "+reason+"\n") {
			t.Errorf("%s: %v\n%s", path, err, out.String())
		}
	}
}
