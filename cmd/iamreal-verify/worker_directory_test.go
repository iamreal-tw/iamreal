package main

// Reading a roster directory that the back end wrote (worker/, the full
// roster files and their record hash lists it moved to the data bucket):
// worker/test/roster-files.test.ts copies the bucket's roster directory to
// a directory, runs this test on it, and reads what the command printed.
//
// The two implementations do not import each other (CLAUDE.md); what they
// exchange here is the roster directory itself, as spec/record.md writes
// it, and the command's own output.

import (
	"bytes"
	"crypto/rsa"
	"crypto/x509"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// TestWorkerDirectory runs the command, with the fake verifier and archive
// of main_test.go, on the roster directory named by
// IAMREAL_WORKER_DIRECTORY, as a test roster, and writes its JSON output to
// verify.json and what it printed for people to verify.txt, both next to
// the directory. It is skipped without the variable. The records of the
// directory carry placeholder proofs: the fake verifier accepts every
// record, and the fake archive knows every root as that of a CRL dated
// 2026-11-16.
func TestWorkerDirectory(t *testing.T) {
	dir := os.Getenv("IAMREAL_WORKER_DIRECTORY")
	if dir == "" {
		t.Skip("IAMREAL_WORKER_DIRECTORY is not set: worker/test/roster-files.test.ts sets it")
	}
	code, out, errOut := runDir(t, dir, "-roster", "test", "-json")
	if code == exitError {
		t.Fatalf("the check could not be made: %s", errOut)
	}
	for name, text := range map[string]string{"verify.json": out, "verify.txt": errOut} {
		if err := os.WriteFile(filepath.Join(filepath.Dir(dir), name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// TestWorkerData runs the command as it runs by default, on everything the
// back end published (worker/test/publication-verify.test.ts): the directory
// named by IAMREAL_WORKER_DATA holds data/, a copy of the data bucket with
// the roster directory under roster/ (roster files, record hash lists,
// fingerprint file, card state files) and the CRL archive under crl/, and
// issuers/, the two issuer keys the archive's CRLs are signed by
// (issuer-G2.der, issuer-G3.der, SubjectPublicKeyInfo). The command is given
// `-roster test -data <data>` and nothing else: it reads the fingerprint
// file, the roster files up to the last line's count, their lists, the card
// state file of the last line's date, and rebuilds the CRL archive from its
// CRLs under those keys. It writes the command's JSON output to
// verify.json, what it printed for people to verify.txt and its exit code
// to verify.code, in that directory. It is skipped without the variable.
//
// The records carry placeholder proofs, so the proof verifier is the fake
// one of main_test.go, which accepts every record. Everything else is the
// command's own: the roster rules, the fingerprints, the lists, the
// comparison of the card state file, the CRL archive and its dates.
func TestWorkerData(t *testing.T) {
	dir := os.Getenv("IAMREAL_WORKER_DATA")
	if dir == "" {
		t.Skip("IAMREAL_WORKER_DATA is not set: worker/test/publication-verify.test.ts sets it")
	}
	var keys []crl.NamedKey
	for _, name := range []string{"G2", "G3"} {
		der, err := os.ReadFile(filepath.Join(dir, "issuers", "issuer-"+name+".der"))
		if err != nil {
			t.Fatal(err)
		}
		k, err := x509.ParsePKIXPublicKey(der)
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, crl.NamedKey{Name: name, Key: k.(*rsa.PublicKey)})
	}
	var out, errOut bytes.Buffer
	mk := func(verifier.Config) (roster.ProofVerifier, error) { return allVerify{}, nil }
	code := run([]string{"-bb", "bb", "-crs", "crs", "-roster", "test", "-json", "-data", filepath.Join(dir, "data")},
		&out, &errOut, deps{mk, openArchive(func() ([]crl.NamedKey, error) { return keys, nil })})
	for name, text := range map[string]string{"verify.json": out.String(), "verify.txt": errOut.String(), "verify.code": strconv.Itoa(code)} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
