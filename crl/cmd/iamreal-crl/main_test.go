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

const testdata = "../../testdata"

var testKey = filepath.Join(testdata, "issuer-public-key.der")

type expectedCase struct {
	Name   string `json:"name"`
	Usable bool   `json:"usable"`
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

// index lists every usable CRL, with the root of expected.json, in the
// proposed line format, and reports the others.
func TestIndex(t *testing.T) {
	var out, errs bytes.Buffer
	err := index([]string{"-key", testKey, testdata}, &out, &errs)
	var u *crl.Unusable
	if !errors.As(err, &u) {
		t.Fatalf("want a report of files not indexed, got %v", err)
	}
	want := expected(t)
	usable := 0
	for _, c := range want {
		if c.Usable {
			usable++
		}
	}
	line := regexp.MustCompile(`^\{"issuer":"test","crl_number":"(-|[1-9][0-9]*)","this_update":"[0-9TZ:-]{20}","next_update":"(-|[0-9TZ:-]{20})","crl_date":"[0-9]{4}-[0-9]{2}-[0-9]{2}","sha256":"([0-9a-f]{64})","root":"([0-9a-f]{64})"\}$`)
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != usable {
		t.Fatalf("%d lines, %d usable CRLs", len(lines), usable)
	}
	for _, l := range lines {
		m := line.FindStringSubmatch(l)
		if m == nil {
			t.Fatalf("line does not match the format: %s", l)
		}
		c, ok := want[m[3]]
		if !ok || !c.Usable || c.Root != m[4] {
			t.Errorf("line %s: expected %+v", l, c)
		}
	}
	for _, c := range want {
		if !c.Usable && !strings.Contains(errs.String(), c.Name+".crl: ") {
			t.Errorf("%s not reported", c.Name)
		}
	}
}
