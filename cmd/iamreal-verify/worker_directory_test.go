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
	"os"
	"path/filepath"
	"testing"
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
