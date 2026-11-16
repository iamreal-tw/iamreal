package main

// The test roster and CRL archive of testdata/ (see its README.md) with the
// real archive and a fake proof verifier. e2e_test.go runs the same with the
// real verifier and bb.

import (
	"bytes"
	"crypto/rsa"
	"crypto/x509"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// testIssuerKeys reads the throwaway issuer keys of testdata/, named G2 and
// G3. Only tests use them.
func testIssuerKeys() ([]crl.NamedKey, error) {
	var out []crl.NamedKey
	for _, name := range []string{"G2", "G3"} {
		der, err := os.ReadFile(filepath.Join("testdata", "issuer-"+name+".der"))
		if err != nil {
			return nil, err
		}
		k, err := x509.ParsePKIXPublicKey(der)
		if err != nil {
			return nil, err
		}
		out = append(out, crl.NamedKey{Name: name, Key: k.(*rsa.PublicKey)})
	}
	return out, nil
}

// archiveCase is a copy of testdata/archive changed by edit, and what the
// command gives with it.
type archiveCase struct {
	name       string
	edit       func(t *testing.T, dir string)
	trustIndex bool
	exit       int
	records    []string // the per-record lines of the output, if exit is not exitError
	stderr     string   // a substring of the standard error
}

const (
	crlA = "G2-2026111605.crl"
	crlB = "G3-2026112005.crl"
	crlC = "G3-2026112105.crl"
)

var allValid = []string{"1 valid first", "2 valid first", "3 valid withdraw"}

func archiveCases() []archiveCase {
	return []archiveCase{
		{name: "full", exit: exitAllValid, records: allValid, stderr: "rebuilding"},
		{name: "trust index", trustIndex: true, exit: exitAllValid, records: allValid, stderr: "trusting"},
		// Record 3 (2026-11-24) fits only C (2026-11-21); record 2
		// (2026-11-21) still fits B (2026-11-20), which has the same root.
		{name: "without C", edit: removeCRL(crlC, true), exit: exitInvalid,
			records: []string{"1 valid first", "2 valid first", "3 invalid root"}},
		{name: "without C, trust index", edit: removeCRL(crlC, true), trustIndex: true, exit: exitInvalid,
			records: []string{"1 valid first", "2 valid first", "3 invalid root"}},
		{name: "without B", edit: removeCRL(crlB, true), exit: exitAllValid, records: allValid},
		{name: "without A", edit: removeCRL(crlA, true), exit: exitInvalid,
			records: []string{"1 invalid root", "2 valid first", "3 valid withdraw"}},
		// The index still lists C: rebuilding finds the difference and
		// stops; trusting the index does not notice.
		{name: "C removed, index unchanged", edit: removeCRL(crlC, false), exit: exitError,
			stderr: "the index lists a file the archive does not have: {\"issuer\":\"G3\",\"crl_number\":\"2026112105\""},
		{name: "C removed, index unchanged, trust index", edit: removeCRL(crlC, false), trustIndex: true,
			exit: exitAllValid, records: allValid},
		// C's root changed in the index: rebuilding finds it; trusting the
		// index, record 3 loses its CRL.
		{name: "C's root changed", edit: changeRoot(crlC), exit: exitError, stderr: "the index differs from the files"},
		{name: "C's root changed, trust index", edit: changeRoot(crlC), trustIndex: true, exit: exitInvalid,
			records: []string{"1 valid first", "2 valid first", "3 invalid root"}},
		// A file the index does not list.
		{name: "extra file", edit: func(t *testing.T, dir string) {
			os.WriteFile(filepath.Join(dir, "junk"), []byte("x"), 0o600)
		}, exit: exitError, stderr: "the archive has a file the index does not list"},
		{name: "no index", edit: func(t *testing.T, dir string) {
			os.Remove(filepath.Join(dir, crl.IndexFileName))
		}, exit: exitError, stderr: crl.IndexFileName},
		{name: "index not as the spec writes it", edit: func(t *testing.T, dir string) {
			editIndex(t, dir, func(b []byte) []byte { return bytes.Replace(b, []byte(`"G2"`), []byte(`"g2"`), 1) })
		}, trustIndex: true, exit: exitError, stderr: "index line 1"},
	}
}

// removeCRL removes a CRL from the archive, and its line from the index if
// reindex.
func removeCRL(name string, reindex bool) func(*testing.T, string) {
	return func(t *testing.T, dir string) {
		t.Helper()
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
		if !reindex {
			return
		}
		keys, err := testIssuerKeys()
		if err != nil {
			t.Fatal(err)
		}
		lines, err := crl.BuildIndex(dir, keys, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, crl.IndexFileName), crl.FormatIndex(lines), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// changeRoot replaces the root of a CRL in the index with zeros.
func changeRoot(name string) func(*testing.T, string) {
	return func(t *testing.T, dir string) {
		t.Helper()
		der, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		keys, err := testIssuerKeys()
		if err != nil {
			t.Fatal(err)
		}
		l := crl.IndexFile(der, keys)
		changed := l
		changed.Root = strings.Repeat("0", 64)
		editIndex(t, dir, func(b []byte) []byte { return bytes.Replace(b, l.Line(), changed.Line(), 1) })
	}
}

func editIndex(t *testing.T, dir string, f func([]byte) []byte) {
	t.Helper()
	path := filepath.Join(dir, crl.IndexFileName)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, f(b), 0o600); err != nil {
		t.Fatal(err)
	}
}

// copyTestArchive copies testdata/archive into a new directory.
func copyTestArchive(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	files, err := filepath.Glob(filepath.Join("testdata", "archive", "*"))
	if err != nil || len(files) != 4 {
		t.Fatalf("%v %v", files, err)
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dir, filepath.Base(f)), b, 0o600)
	}
	return dir
}

// runArchiveCases runs every case with the proof verifier mk makes.
func runArchiveCases(t *testing.T, mk func(verifier.Config) (roster.ProofVerifier, error), args ...string) {
	rosterFile, err := os.ReadFile(filepath.Join("testdata", "roster.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range archiveCases() {
		t.Run(c.name, func(t *testing.T) {
			dir := copyTestArchive(t)
			if c.edit != nil {
				c.edit(t, dir)
			}
			path := filepath.Join(t.TempDir(), "roster.jsonl")
			os.WriteFile(path, rosterFile, 0o600)
			a := append(append([]string{"-roster", "test", "-crl-archive", dir}, args...), path)
			if c.trustIndex {
				a = append([]string{"-crl-trust-index"}, a...)
			}
			var out, errOut bytes.Buffer
			code := run(a, &out, &errOut, deps{mk, openArchive(testIssuerKeys)})
			if code != c.exit {
				t.Fatalf("exit %d, want %d\n%s\n%s", code, c.exit, out.String(), errOut.String())
			}
			if !strings.Contains(errOut.String(), c.stderr) {
				t.Errorf("stderr lacks %q:\n%s", c.stderr, errOut.String())
			}
			if c.exit == exitError {
				return
			}
			var got []string
			for _, l := range strings.Split(out.String(), "\n") {
				if strings.HasPrefix(l, "  ") && !strings.HasPrefix(l, "   ") && strings.Contains(l, "valid") {
					got = append(got, strings.TrimSpace(l))
				}
			}
			if strings.Join(got, "\n") != strings.Join(c.records, "\n") {
				t.Errorf("records\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(c.records, "\n"))
			}
		})
	}
}

func TestArchive(t *testing.T) {
	runArchiveCases(t, func(verifier.Config) (roster.ProofVerifier, error) { return allVerify{}, nil }, "-bb", "bb", "-crs", "crs")
}

// The index of testdata/archive is the one its files give.
func TestArchiveIndex(t *testing.T) {
	keys, err := testIssuerKeys()
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join("testdata", "archive")
	lines, err := crl.BuildIndex(dir, keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join(dir, crl.IndexFileName))
	if err != nil {
		t.Fatal(err)
	}
	if got := crl.FormatIndex(lines); !bytes.Equal(got, want) {
		t.Errorf("index\n%s\nwant\n%s", got, want)
	}
	// MOICA's keys do not verify the test CRLs: the program, which has only
	// those, recognizes none of their roots.
	moica, err := crl.MOICAKeys()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := crl.RebuildArchive(dir, moica, nil); err == nil {
		t.Error("test CRLs accepted under MOICA's keys")
	}
	for _, l := range mustBuild(t, dir, moica) {
		if l.Issuer != "-" || l.Reason() != crl.ReasonSignature {
			t.Errorf("%s", l.Line())
		}
	}
}

func mustBuild(t *testing.T, dir string, keys []crl.NamedKey) []crl.IndexLine {
	t.Helper()
	lines, err := crl.BuildIndex(dir, keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	return lines
}
