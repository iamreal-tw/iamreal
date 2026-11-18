package main

import (
	"bytes"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// testDeps are the program's dependencies with the fake verifier, the test
// issuer keys and the harness's clock time.
func testDeps(t *testing.T) deps {
	keys := namedTestKeys(t)
	return deps{
		verifier: func(verifier.Config) (roster.ProofVerifier, error) {
			return &fakeProofs{reject: map[string]bool{badProof: true}}, nil
		},
		crlKeys: func() ([]crl.NamedKey, error) { return keys, nil },
		now:     func() time.Time { return startOfTests },
	}
}

// aliceOnThreads is the list of one account most records here have.
var aliceOnThreads = []verifier.Account{{Platform: "threads", Username: "alice"}}

// appendDirect writes a record into the store past the server's checks,
// with a new challenge dated date. Tests use it to make long rosters fast,
// and invalid ones.
func (h *harness) appendDirect(card string, accounts []verifier.Account, date, root, proof string) *verifier.Record {
	h.t.Helper()
	count, head, err := h.store.Head()
	if err != nil {
		h.t.Fatal(err)
	}
	random := make([]byte, 16)
	rand.Read(random)
	r := &verifier.Record{
		Seq: count + 1, Prev: head, ScopeString: testScope, ScopedID: card, Accounts: accounts,
		Challenge: date + "." + verifier.EncodeBase32(random), Issuer: "G3", SMTRoot: root, Circuit: circuitOf("G3"), Proof: proof,
	}
	if err := h.store.AddChallenge(r.Challenge, h.clock.Now()); err != nil {
		h.t.Fatal(err)
	}
	if err := h.store.Append(r, nil); err != nil {
		h.t.Fatal(err)
	}
	return r
}

func (h *harness) snapshot(today string) (int, string, string) {
	h.t.Helper()
	var out, errOut bytes.Buffer
	code := snapshot(snapshotConfig{
		Store: h.store, Roster: verifier.Test, CRLDir: crlDir(h.data), OutDir: rosterDir(h.data),
		Proofs: h.proofs, Keys: h.keys, Today: mustDate(h.t, today), Out: &out, Err: &errOut,
	})
	return code, out.String(), errOut.String()
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSnapshot(t *testing.T) {
	c := g3CRL(t)
	root := rootOf(t, c)
	h := newHarness(t, startOfTests, c)
	out := rosterDir(h.data)

	// The empty roster: no roster file, one heads line.
	if code, stdout, stderr := h.snapshot("2026-11-19"); code != 0 || !strings.Contains(stdout, "0 records") {
		t.Fatalf("empty: %d %s %s", code, stdout, stderr)
	}
	if got := readFile(t, filepath.Join(out, headsFileName)); got != `{"date":"2026-11-19","count":0,"head":"`+verifier.GenesisPrev+`"}`+"\n" {
		t.Errorf("heads %q", got)
	}

	for i := 0; i < 1001; i++ {
		h.appendDirect(newCard(), aliceOnThreads, "2026-11-20", root, goodProof)
	}
	if code, stdout, stderr := h.snapshot("2026-11-20"); code != 0 || !strings.Contains(stdout, "1001 records") {
		t.Fatalf("%d %s %s", code, stdout, stderr)
	}
	first := filepath.Join(out, "0000000000000001.jsonl")
	second := filepath.Join(out, "0000000000001001.jsonl")
	file := string(h.rosterFile())
	if a, b := readFile(t, first), readFile(t, second); a+b != file || strings.Count(a, "\n") != 1000 || strings.Count(b, "\n") != 1 {
		t.Errorf("roster directory: %d and %d lines", strings.Count(a, "\n"), strings.Count(b, "\n"))
	}
	_, head := mustHead(t, h)
	wantHeads := `{"date":"2026-11-19","count":0,"head":"` + verifier.GenesisPrev + `"}` + "\n" +
		`{"date":"2026-11-20","count":1001,"head":"` + head + `"}` + "\n"
	if got := readFile(t, filepath.Join(out, headsFileName)); got != wantHeads {
		t.Errorf("heads %q", got)
	}

	// The same day again, nothing new: nothing to do.
	if code, stdout, _ := h.snapshot("2026-11-20"); code != 0 || !strings.Contains(stdout, "already published today") {
		t.Errorf("again: %d %s", code, stdout)
	}
	// A new record the same day: a date appears at most once.
	h.appendDirect(newCard(), aliceOnThreads, "2026-11-20", root, goodProof)
	if code, _, stderr := h.snapshot("2026-11-20"); code != 1 || !strings.Contains(stderr, "already has a line for 2026-11-20") {
		t.Errorf("same day: %d %s", code, stderr)
	}

	// The next day: the full file is not written again.
	before, _ := os.Stat(first)
	time.Sleep(10 * time.Millisecond)
	if code, _, stderr := h.snapshot("2026-11-21"); code != 0 {
		t.Fatalf("%d %s", code, stderr)
	}
	after, _ := os.Stat(first)
	if !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("the full file was written again")
	}
	if got := readFile(t, second); strings.Count(got, "\n") != 2 {
		t.Errorf("the last file has %d lines", strings.Count(got, "\n"))
	}
	if got := readFile(t, filepath.Join(out, headsFileName)); strings.Count(got, "\n") != 3 {
		t.Errorf("heads %q", got)
	}
	// The re-verifier reads the directory as one roster file.
	if _, head2, broken := roster.ReadFile([]byte(readFile(t, first)+readFile(t, second)), verifier.Test); broken != nil || !strings.Contains(readFile(t, filepath.Join(out, headsFileName)), head2) {
		t.Errorf("%v", broken)
	}
}

// Nothing is published when anything is wrong, and the exit code is 1.
func TestSnapshotRefuses(t *testing.T) {
	c := g3CRL(t)
	root := rootOf(t, c)

	unchanged := func(t *testing.T, h *harness, code int, stderr, want string) {
		t.Helper()
		if code != 1 || !strings.Contains(stderr, want) || !strings.Contains(stderr, "nothing was published") {
			t.Errorf("exit %d, stderr:\n%s\nwant %q", code, stderr, want)
		}
		if _, err := os.Stat(filepath.Join(rosterDir(h.data), headsFileName)); err == nil {
			if got := readFile(t, filepath.Join(rosterDir(h.data), headsFileName)); strings.Count(got, "\n") != 1 {
				t.Errorf("heads changed: %q", got)
			}
		}
	}

	t.Run("invalid record", func(t *testing.T) {
		h := newHarness(t, startOfTests, c)
		card := newCard()
		h.appendDirect(card, aliceOnThreads, "2026-11-20", root, goodProof)
		h.appendDirect(newCard(), nil, "2026-11-20", root, goodProof)
		code, _, stderr := h.snapshot("2026-11-20")
		unchanged(t, h, code, stderr, "record 2 is invalid: empty")
	})
	t.Run("proof does not verify", func(t *testing.T) {
		h := newHarness(t, startOfTests, c)
		h.appendDirect(newCard(), aliceOnThreads, "2026-11-20", root, badProof)
		code, _, stderr := h.snapshot("2026-11-20")
		unchanged(t, h, code, stderr, "record 1 is invalid: proof")
	})
	t.Run("CRL archive differs from its index", func(t *testing.T) {
		h := newHarness(t, startOfTests, c)
		h.appendDirect(newCard(), aliceOnThreads, "2026-11-20", root, goodProof)
		os.WriteFile(filepath.Join(crlDir(h.data), "extra.crl"), makeCRL(t, "G3", 9, crlTime, 1), 0o644)
		code, _, stderr := h.snapshot("2026-11-20")
		unchanged(t, h, code, stderr, "the archive has a file the index does not list")
	})
	t.Run("published file changed", func(t *testing.T) {
		h := newHarness(t, startOfTests, c)
		h.appendDirect(newCard(), aliceOnThreads, "2026-11-20", root, goodProof)
		if code, _, stderr := h.snapshot("2026-11-20"); code != 0 {
			t.Fatal(stderr)
		}
		name := filepath.Join(rosterDir(h.data), "0000000000000001.jsonl")
		os.WriteFile(name, []byte(strings.Replace(readFile(t, name), "alice", "alicf", 1)), 0o644)
		h.appendDirect(newCard(), aliceOnThreads, "2026-11-20", root, goodProof)
		code, _, stderr := h.snapshot("2026-11-21")
		unchanged(t, h, code, stderr, "is published with other bytes")
	})
	t.Run("heads line of another roster", func(t *testing.T) {
		h := newHarness(t, startOfTests, c)
		h.appendDirect(newCard(), aliceOnThreads, "2026-11-20", root, goodProof)
		os.WriteFile(filepath.Join(rosterDir(h.data), headsFileName), []byte(`{"date":"2026-11-19","count":1,"head":"`+strings.Repeat("a", 64)+`"}`+"\n"), 0o644)
		code, _, stderr := h.snapshot("2026-11-20")
		unchanged(t, h, code, stderr, "is not a head of this roster")
	})
	t.Run("heads line not in its one spelling", func(t *testing.T) {
		h := newHarness(t, startOfTests, c)
		os.WriteFile(filepath.Join(rosterDir(h.data), headsFileName), []byte(`{"date":"2026-11-19","count":0, "head":"`+verifier.GenesisPrev+`"}`+"\n"), 0o644)
		code, _, stderr := h.snapshot("2026-11-20")
		unchanged(t, h, code, stderr, "line 1 is not in the form of the spec")
	})
}

// The subcommand opens the database read-only while the server has it
// open, and publishes into DATA/roster.
func TestSnapshotCommand(t *testing.T) {
	c := g3CRL(t)
	h := newHarness(t, startOfTests, c)
	h.mustSubmit(h.sub(newCard(), rootOf(t, c), "threads:alice"), "threads first")
	var out, errOut bytes.Buffer
	code := run([]string{"snapshot", "-data", h.data, "-bb", "unused", "-crs", "unused"}, &out, &errOut, testDeps(t))
	if code != 0 || !strings.Contains(out.String(), "published 2026-11-20: 1 records") {
		t.Fatalf("exit %d\n%s\n%s", code, out.String(), errOut.String())
	}
	if _, err := os.Stat(filepath.Join(rosterDir(h.data), "0000000000000001.jsonl")); err != nil {
		t.Error(err)
	}
	// The production roster does not accept the test scope: the roster is
	// broken at line 1.
	errOut.Reset()
	code = run([]string{"snapshot", "-data", h.data, "-bb", "unused", "-crs", "unused", "-roster", "production"}, &out, &errOut, testDeps(t))
	if code != 1 || !strings.Contains(errOut.String(), "broken at line 1") {
		t.Errorf("production: exit %d %s", code, errOut.String())
	}
}
