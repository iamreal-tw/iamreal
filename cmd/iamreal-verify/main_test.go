package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

// The "three records" file of spec/vectors/record.json, with its tokens
// replaced. Its proofs are placeholders.
func threeRecords(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("../../spec/vectors/record.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Tokens map[string]string `json:"tokens"`
		Files  []struct {
			Name    string `json:"name"`
			Content string `json:"content"`
		} `json:"files"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	for _, f := range v.Files {
		if f.Name == "three records" {
			c := f.Content
			for k, val := range v.Tokens {
				c = strings.ReplaceAll(c, k, val)
			}
			return []byte(c)
		}
	}
	t.Fatal("no file")
	return nil
}

type allVerify struct{}

func (allVerify) VerifyRecord(*verifier.Record) error { return nil }

type everyRoot struct{}

func (everyRoot) CRLDates(string, string) ([]verifier.Date, error) {
	d, _ := verifier.ParseDate("2026-11-16")
	e, _ := verifier.ParseDate("2027-01-01")
	return []verifier.Date{d, e}, nil
}

// fakeDeps verifies with pv and opens every archive as crls.
func fakeDeps(pv prooflog.ProofVerifier, crls prooflog.CRLArchive) deps {
	return deps{
		verifier: func(verifier.Config) (prooflog.ProofVerifier, error) { return pv, nil },
		archive: func(string, bool, func(string)) (prooflog.CRLArchive, []crl.IndexMismatch, error) {
			return crls, nil, nil
		},
	}
}

// runWith runs the command on file with -crl-archive, unless crls is nil.
func runWith(t *testing.T, file []byte, pv prooflog.ProofVerifier, crls prooflog.CRLArchive, extra ...string) (int, string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "proof-log.jsonl")
	os.WriteFile(path, file, 0o600)
	var out, errOut bytes.Buffer
	args := append([]string{"-bb", "bb", "-crs", "crs"}, extra...)
	if crls != nil {
		args = append(args, "-crl-archive", "archive")
	}
	code := run(append(args, path), &out, &errOut, fakeDeps(pv, crls))
	return code, out.String(), errOut.String()
}

func TestText(t *testing.T) {
	code, out, _ := runWith(t, threeRecords(t), allVerify{}, everyRoot{})
	want := `log file: valid
records: 3
fingerprint: d12c22458126fee296b6216503b96ffe9c7ed37f7e8f8bb7f6f61b9c8b7d070b

records:
  1 valid threads first
  2 valid threads withdraw
  3 invalid root

scope iamreal:public:0_______________
  cards:
    QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880  last card proof 2027-01-01  ordinal 1
      no account
  accounts:
`
	if out != want {
		t.Errorf("output\n%s\nwant\n%s", out, want)
	}
	if code != exitInvalid {
		t.Errorf("exit %d, want %d: a record is invalid", code, exitInvalid)
	}
}

// sameDay is a proof log of four records of one card, each listing alice on threads, all
// dated 2026-11-16, made from the first record of threeRecords.
func sameDay(t *testing.T) []byte {
	t.Helper()
	records, _, broken := prooflog.ReadFile(threeRecords(t), verifier.Production)
	if broken != nil {
		t.Fatal(broken)
	}
	var file []byte
	for i := 1; i <= 4; i++ {
		r := *records[0]
		r.Seq, r.Accounts = uint64(i), []verifier.Account{{Platform: "threads", Username: "alice"}}
		r.Challenge = "2026-11-16." + verifier.EncodeBase32(bytes.Repeat([]byte{byte(i)}, 16))
		file = append(file, r.Line()...)
	}
	return file
}

// The fourth valid record of a card on one date is daily_limit, in both
// outputs.
func TestDailyLimit(t *testing.T) {
	code, out, _ := runWith(t, sameDay(t), allVerify{}, everyRoot{})
	for _, line := range []string{"  1 valid threads first\n", "  3 valid threads refresh\n", "  4 invalid daily_limit (3 valid records dated 2026-11-16)\n"} {
		if !strings.Contains(out, line) {
			t.Errorf("no %q in\n%s", line, out)
		}
	}
	if code != exitInvalid {
		t.Errorf("exit %d, want %d", code, exitInvalid)
	}
	_, out, _ = runWith(t, sameDay(t), allVerify{}, everyRoot{}, "-json")
	var got struct {
		Results []jsonResult `json:"results"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Results) != 4 || !reflect.DeepEqual(got.Results[3], jsonResult{Seq: 4, Reason: "daily_limit"}) ||
		!reflect.DeepEqual(got.Results[0], jsonResult{Seq: 1, Valid: true, Kinds: []jsonKind{{"threads", "first"}}}) {
		t.Errorf("%s", out)
	}
}

// A change of account on the date of the first is a correction, in both
// outputs; on a later date it is a switch.
func TestCorrection(t *testing.T) {
	records, _, broken := prooflog.ReadFile(threeRecords(t), verifier.Production)
	if broken != nil {
		t.Fatal(broken)
	}
	var file []byte
	for i, step := range []struct{ username, date string }{
		{"alice", "2026-11-16"}, {"bob", "2026-11-16"}, {"carol", "2027-01-01"},
	} {
		r := *records[0]
		r.Seq = uint64(i + 1)
		r.Accounts = []verifier.Account{{Platform: "threads", Username: step.username}}
		r.Challenge = step.date + "." + verifier.EncodeBase32(bytes.Repeat([]byte{byte(i + 1)}, 16))
		file = append(file, r.Line()...)
	}
	code, out, _ := runWith(t, file, allVerify{}, everyRoot{})
	for _, line := range []string{"  1 valid threads first\n", "  2 valid threads correction\n", "  3 valid threads switch\n"} {
		if !strings.Contains(out, line) {
			t.Errorf("no %q in\n%s", line, out)
		}
	}
	if code != exitAllValid {
		t.Errorf("exit %d", code)
	}
	_, out, _ = runWith(t, file, allVerify{}, everyRoot{}, "-json")
	var got struct {
		Results []jsonResult `json:"results"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Results) != 3 || !reflect.DeepEqual(got.Results[1], jsonResult{Seq: 2, Valid: true, Kinds: []jsonKind{{"threads", "correction"}}}) {
		t.Errorf("%s", out)
	}
}

func TestJSONShape(t *testing.T) {
	_, out, _ := runWith(t, threeRecords(t), allVerify{}, everyRoot{}, "-json")
	var got struct {
		Valid       bool              `json:"valid"`
		Fingerprint string            `json:"fingerprint"`
		Results     []json.RawMessage `json:"results"`
		State       []json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Valid || len(got.Results) != 3 || got.Fingerprint != "d12c22458126fee296b6216503b96ffe9c7ed37f7e8f8bb7f6f61b9c8b7d070b" {
		t.Errorf("%s", out)
	}
}

func TestBroken(t *testing.T) {
	file := threeRecords(t)
	code, out, _ := runWith(t, file[:len(file)-1], allVerify{}, everyRoot{})
	if code != exitInvalid || !strings.Contains(out, "broken at line 3: line") {
		t.Errorf("exit %d: %s", code, out)
	}
	_, out, _ = runWith(t, file[:len(file)-1], allVerify{}, everyRoot{}, "-json")
	if strings.TrimSpace(out) != "{\n  \"valid\": false,\n  \"line\": 3,\n  \"code\": \"line\"\n}" {
		t.Errorf("%s", out)
	}
}

func TestNoArchive(t *testing.T) {
	code, out, errOut := runWith(t, threeRecords(t), allVerify{}, nil)
	if code != exitInvalid || !strings.Contains(out, "1 invalid root") || !strings.Contains(errOut, "no CRL archive") {
		t.Errorf("exit %d\n%s\n%s", code, out, errOut)
	}
}

func TestEmptyProofLog(t *testing.T) {
	code, out, _ := runWith(t, nil, allVerify{}, everyRoot{})
	if code != exitAllValid || !strings.Contains(out, "fingerprint: "+prooflog.EmptyFingerprint) {
		t.Errorf("exit %d: %s", code, out)
	}
}

func TestUsage(t *testing.T) {
	var out, errOut bytes.Buffer
	d := fakeDeps(allVerify{}, everyRoot{})
	if code := run(nil, &out, &errOut, d); code != exitError {
		t.Errorf("no arguments: exit %d", code)
	}
	if code := run([]string{"-bb", "x", "-crs", "y", "-proof-log", "staging", "f"}, &out, &errOut, d); code != exitError {
		t.Errorf("bad proof log: exit %d", code)
	}
	if code := run([]string{"-bb", "x", "-crs", "y", "-crl-trust-index", "f"}, &out, &errOut, d); code != exitError {
		t.Errorf("-crl-trust-index without -crl-archive: exit %d", code)
	}
}

// Each card's ordinal, in both outputs: card B's first record is invalid
// (the empty list as a card's first record), so card A, the first with a
// valid record, is 1 and B is 2; B's withdrawing everything changes
// nothing.
func TestOrdinals(t *testing.T) {
	records, _, broken := prooflog.ReadFile(threeRecords(t), verifier.Production)
	if broken != nil {
		t.Fatal(broken)
	}
	const (
		a = "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880"
		b = "0400000000000000000000000000000000000000000000000000"
	)
	var file []byte
	for i, step := range []struct{ card, username string }{{b, ""}, {a, "alice"}, {b, "bob"}, {b, ""}} {
		r := *records[0]
		r.Seq, r.ScopedID = uint64(i+1), step.card
		r.Accounts = []verifier.Account{}
		if step.username != "" {
			r.Accounts = []verifier.Account{{Platform: "threads", Username: step.username}}
		}
		r.Challenge = "2026-11-16." + verifier.EncodeBase32(bytes.Repeat([]byte{byte(i + 1)}, 16))
		file = append(file, r.Line()...)
	}
	_, out, _ := runWith(t, file, allVerify{}, everyRoot{})
	for _, line := range []string{"  1 invalid empty\n", b + "  last card proof 2026-11-16  ordinal 2\n      no account\n", a + "  last card proof 2026-11-16  ordinal 1\n"} {
		if !strings.Contains(out, line) {
			t.Errorf("no %q in\n%s", line, out)
		}
	}
	_, out, _ = runWith(t, file, allVerify{}, everyRoot{}, "-json")
	var got struct {
		Ordinals []jsonOrdinal `json:"ordinals"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	scope := records[0].ScopeString
	if want := []jsonOrdinal{{scope, a, 1}, {scope, b, 2}}; !reflect.DeepEqual(got.Ordinals, want) {
		t.Errorf("ordinals %+v, want %+v", got.Ordinals, want)
	}
}
