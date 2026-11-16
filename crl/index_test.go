package crl

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func testKeys(t testing.TB) []NamedKey {
	return []NamedKey{{"G3", testIssuerKey(t)}}
}

// copyArchive copies the named synthetic CRLs into a new directory.
func copyArchive(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join("testdata", n+".crl"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, n+".crl"), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// Every synthetic CRL gives the index line expected.json implies.
func TestIndexFile(t *testing.T) {
	var cases []expectedCase
	readJSON(t, "testdata/expected.json", &cases)
	dash := func(s string) string {
		if s == "" {
			return "-"
		}
		return s
	}
	for _, c := range cases {
		der, err := os.ReadFile(filepath.Join("testdata", c.Name+".crl"))
		if err != nil {
			t.Fatal(err)
		}
		want := IndexLine{
			Issuer: "G3", CRLNumber: dash(c.CRLNumber), ThisUpdate: c.ThisUpdate, NextUpdate: dash(c.NextUpdate),
			CRLDate: c.CRLDate, SHA256: c.SHA256, Root: c.Root,
		}
		if !c.Usable {
			want.Root = "-" + c.Reason
		}
		if c.Reason == ReasonSignature {
			want.Issuer = "-"
		}
		if got := IndexFile(der, testKeys(t)); got != want {
			t.Errorf("%s:\n got %s want %s", c.Name, got.Line(), want.Line())
		}
		if _, err := parseIndexLine(want.Line()); err != nil {
			t.Errorf("%s: %v", c.Name, err)
		}
	}
	// A file that is not a CRL has only its SHA-256.
	l := IndexFile([]byte("x"), testKeys(t))
	if string(l.Line()) != `{"issuer":"-","crl_number":"-","this_update":"-","next_update":"-","crl_date":"-","sha256":"2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881","root":"-not_usable_der"}`+"\n" {
		t.Errorf("%s", l.Line())
	}
	// Without the key, every signature fails; without NULL parameters the
	// reason is the algorithm.
	for name, reason := range map[string]string{"one": ReasonSignature, "no-null-parameters": ReasonAlgorithm, "no-null-outer": ReasonAlgorithm} {
		der, _ := os.ReadFile(filepath.Join("testdata", name+".crl"))
		if l := IndexFile(der, nil); l.Issuer != "-" || l.Reason() != reason {
			t.Errorf("%s with no key: %s", name, l.Line())
		}
	}
}

func TestReasonsAreCodes(t *testing.T) {
	for _, r := range Reasons {
		l := IndexLine{"-", "-", "-", "-", "-", strings.Repeat("0", 64), "-" + r}
		if err := l.check(); err != nil {
			t.Errorf("%s: %v", r, err)
		}
	}
}

func line(issuer, number, sha string) IndexLine {
	return IndexLine{issuer, number, "2026-11-15T16:30:00Z", "-", "2026-11-16", strings.Repeat(sha, 64), "-x"}
}

func TestSortIndex(t *testing.T) {
	want := []IndexLine{
		line("-", "-", "0"), line("-", "3", "0"),
		line("G2", "-", "f"), line("G2", "0", "0"), line("G2", "9", "0"), line("G2", "10", "0"), line("G2", "10", "a"), line("G2", "10", "a"),
		line("G3", "2", "0"), line("G3", "4660", "0"), line("G3", "2026111605", "0"),
	}
	got := slices.Clone(want)
	slices.Reverse(got)
	SortIndex(got)
	if !slices.Equal(got, want) {
		t.Errorf("%s", FormatIndex(got))
	}
	if _, err := ParseIndex(FormatIndex(want)); err != nil {
		t.Error(err)
	}
}

func TestParseIndexRejects(t *testing.T) {
	good := `{"issuer":"G3","crl_number":"4660","this_update":"2026-11-15T16:30:00Z","next_update":"2026-11-17T04:30:00Z","crl_date":"2026-11-16","sha256":"` + strings.Repeat("a", 64) + `","root":"` + strings.Repeat("0", 64) + `"}`
	if _, err := ParseIndex([]byte(good + "\n")); err != nil {
		t.Fatal(err)
	}
	// p - 1 is the largest root; p and above are not field elements.
	const p = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001"
	pMinus1 := strings.Replace(good, strings.Repeat("0", 64), p[:63]+"0", 1)
	if _, err := ParseIndex([]byte(pMinus1 + "\n")); err != nil {
		t.Errorf("root p-1: %v", err)
	}
	if l, err := ParseIndex(nil); err != nil || len(l) != 0 {
		t.Fatal("an empty index is an index of nothing")
	}
	for name, bad := range map[string]string{
		"no LF":               good,
		"CRLF":                good + "\r\n",
		"empty line":          good + "\n\n",
		"space":               strings.Replace(good, `,"crl_number"`, `, "crl_number"`, 1),
		"key order":           strings.Replace(strings.Replace(good, `"this_update"`, `"X"`, 1), `"next_update"`, `"this_update"`, 1),
		"extra key":           strings.Replace(good, `}`, `,"x":"1"}`, 1),
		"issuer":              strings.Replace(good, `"G3"`, `"G1"`, 1),
		"leading zero":        strings.Replace(good, `"4660"`, `"04660"`, 1),
		"negative number":     strings.Replace(good, `"4660"`, `"-4660"`, 1),
		"time without Z":      strings.Replace(good, `16:30:00Z`, `16:30:00+00:00`, 1),
		"time fraction":       strings.Replace(good, `16:30:00Z`, `16:30:00.0Z`, 1),
		"next_update missing": strings.Replace(good, `"2026-11-17T04:30:00Z"`, `""`, 1),
		"date in UTC":         strings.Replace(good, `"2026-11-16"`, `"2026-11-15"`, 1),
		"date without time":   strings.Replace(good, `"2026-11-15T16:30:00Z"`, `"-"`, 1),
		"upper-case sha256":   strings.Replace(good, strings.Repeat("a", 64), strings.Repeat("A", 64), 1),
		"short root":          strings.Replace(good, strings.Repeat("0", 64), strings.Repeat("0", 63), 1),
		"root p":              strings.Replace(good, strings.Repeat("0", 64), p, 1),
		"root above p":        strings.Replace(good, strings.Repeat("0", 64), strings.Repeat("f", 64), 1),
		"root without issuer": strings.Replace(good, `"G3"`, `"-"`, 1),
		"root without number": strings.Replace(good, `"4660"`, `"-"`, 1),
		"bare dash":           strings.Replace(good, strings.Repeat("0", 64), "-", 1),
		"reason upper-case":   strings.Replace(good, strings.Repeat("0", 64), "-Not_usable", 1),
		"reason dash":         strings.Replace(good, strings.Repeat("0", 64), "-not-usable", 1),
		"out of order":        good + "\n" + strings.Replace(good, `"4660"`, `"999"`, 1) + "\n",
	} {
		if !strings.HasSuffix(bad, "\n") && name != "no LF" {
			bad += "\n"
		}
		var ie *IndexError
		if _, err := ParseIndex([]byte(bad)); !errors.As(err, &ie) {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestArchive(t *testing.T) {
	r1, r2 := strings.Repeat("1", 64), strings.Repeat("2", 64)
	l := func(issuer, number, this, date, root string) IndexLine {
		return IndexLine{issuer, number, this, "-", date, strings.Repeat(number[len(number)-1:], 64), root}
	}
	a := NewArchive([]IndexLine{
		l("G2", "1", "2026-11-15T16:30:00Z", "2026-11-16", r1),
		l("G3", "1", "2026-11-19T16:30:00Z", "2026-11-20", r2),
		l("G3", "2", "2026-11-20T16:30:00Z", "2026-11-21", r2),
		l("G3", "3", "2026-11-21T16:30:00Z", "2026-11-22", "-"+ReasonDelta),
	})
	for _, c := range []struct {
		issuer, root string
		want         []string
	}{
		{"G2", r1, []string{"2026-11-16"}},
		{"G3", r1, nil},
		{"G2", r2, nil},
		{"G3", r2, []string{"2026-11-20", "2026-11-21"}},
		{"G3", "-" + ReasonDelta, nil},
	} {
		got, err := a.CRLDates(c.issuer, c.root)
		if err != nil || !slices.Equal(got, c.want) {
			t.Errorf("%s %s: %v, want %v", c.issuer, c.root[:1], got, c.want)
		}
	}
}

func TestRebuildArchive(t *testing.T) {
	dir := copyArchive(t, "one", "duplicate", "moica-like", "delta", "other-key")
	lines, err := BuildIndex(dir, testKeys(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	index := FormatIndex(lines)
	write := func(b []byte) {
		if err := os.WriteFile(filepath.Join(dir, IndexFileName), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	rebuild := func() (*Archive, []IndexMismatch) {
		t.Helper()
		a, diffs, err := RebuildArchive(dir, testKeys(t), nil)
		if err != nil {
			t.Fatal(err)
		}
		return a, diffs
	}
	write(index)
	var seen []string
	a, diffs, err := RebuildArchive(dir, testKeys(t), func(name string) { seen = append(seen, name) })
	if err != nil || len(diffs) != 0 {
		t.Fatal(err, diffs)
	}
	if len(seen) != 5 {
		t.Errorf("read %v", seen)
	}
	one := IndexFile(mustRead(t, "testdata/one.crl"), testKeys(t))
	duplicate := IndexFile(mustRead(t, "testdata/duplicate.crl"), testKeys(t))
	if d, _ := a.CRLDates("G3", one.Root); !slices.Equal(d, []string{"2026-11-16"}) {
		t.Errorf("dates %v", d)
	}
	if _, err := ReadArchiveIndex(dir); err != nil {
		t.Fatal(err)
	}

	// Two roots changed in the index: the index alone is trusted, the files
	// are not. Rebuilding reports both lines and answers from the files.
	zero := strings.Repeat("0", 64)
	tampered := bytes.Replace(index, []byte(one.Root), []byte(zero), 1)
	tampered = bytes.Replace(tampered, []byte(duplicate.Root), []byte(strings.Repeat("1", 64)), 1)
	write(tampered)
	if a, err := ReadArchiveIndex(dir); err != nil {
		t.Fatal(err)
	} else if d, _ := a.CRLDates("G3", zero); len(d) != 1 {
		t.Error("the index alone is what ReadArchiveIndex answers from")
	}
	a, diffs = rebuild()
	if len(diffs) != 2 {
		t.Fatalf("tampered roots: %v", diffs)
	}
	for _, m := range diffs {
		if m.Index == "" || m.Files == "" || !strings.HasPrefix(m.String(), "the index differs from the files:") {
			t.Errorf("tampered root: %+v", m)
		}
	}
	if d, _ := a.CRLDates("G3", one.Root); len(d) != 1 {
		t.Error("the rebuilt index is not the one that counts")
	}
	if d, _ := a.CRLDates("G3", zero); len(d) != 0 {
		t.Error("a root only the index has counted")
	}

	// A file the index does not list, and one the index lists but the
	// archive lacks: both reported, the index's line first.
	write(index)
	os.WriteFile(filepath.Join(dir, "extra.crl"), mustRead(t, "testdata/zero.crl"), 0o600)
	os.Remove(filepath.Join(dir, "one.crl"))
	a, diffs = rebuild()
	extra := IndexFile(mustRead(t, "testdata/zero.crl"), testKeys(t))
	want := []IndexMismatch{{Index: lineText(one)}, {Files: lineText(extra)}}
	if !slices.Equal(diffs, want) {
		t.Fatalf("extra and missing file: %v, want %v", diffs, want)
	}
	if !strings.HasPrefix(diffs[0].String(), "the index lists a file the archive does not have: ") ||
		!strings.HasPrefix(diffs[1].String(), "the archive has a file the index does not list: ") {
		t.Errorf("%s\n%s", diffs[0], diffs[1])
	}
	if d, _ := a.CRLDates("G3", one.Root); len(d) != 0 {
		t.Error("a file the archive lacks counted")
	}
	if d, _ := a.CRLDates("G3", extra.Root); len(d) != 1 {
		t.Error("a file the index does not list did not count")
	}

	// No index, or an index that is not as the spec writes it.
	os.Remove(filepath.Join(dir, IndexFileName))
	if _, _, err := RebuildArchive(dir, testKeys(t), nil); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("no index: %v", err)
	}
	write(bytes.ReplaceAll(index, []byte(`":"`), []byte(`": "`)))
	var ie *IndexError
	if _, _, err := RebuildArchive(dir, testKeys(t), nil); !errors.As(err, &ie) {
		t.Errorf("bad index: %v", err)
	}
	if _, err := ReadArchiveIndex(dir); !errors.As(err, &ie) {
		t.Errorf("bad index: %v", err)
	}
}

func lineText(l IndexLine) string { return strings.TrimSuffix(string(l.Line()), "\n") }

// Every difference is reported once, a line of the index paired with a line
// of the files by SHA-256, also when the same line appears more than once.
func TestCompareIndexes(t *testing.T) {
	l := func(sha, root string) IndexLine {
		return IndexLine{"G3", "1", "2026-11-15T16:30:00Z", "-", "2026-11-16", strings.Repeat(sha, 64), strings.Repeat(root, 64)}
	}
	a, a2, b, c, d := l("a", "1"), l("a", "2"), l("b", "1"), l("c", "1"), l("d", "1")
	if got := compareIndexes([]IndexLine{a, b}, []IndexLine{a, b}); len(got) != 0 {
		t.Errorf("same: %v", got)
	}
	got := compareIndexes([]IndexLine{a, b, b, c}, []IndexLine{a2, b, d})
	want := []IndexMismatch{{Index: lineText(a), Files: lineText(a2)}, {Index: lineText(b)}, {Index: lineText(c)}, {Files: lineText(d)}}
	if !slices.Equal(got, want) {
		t.Errorf("got %v\nwant %v", got, want)
	}
	if got := compareIndexes([]IndexLine{b}, []IndexLine{b, b}); !slices.Equal(got, []IndexMismatch{{Files: lineText(b)}}) {
		t.Errorf("a file twice: %v", got)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
