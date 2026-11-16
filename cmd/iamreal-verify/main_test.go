package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
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

func runWith(t *testing.T, file []byte, pv roster.ProofVerifier, crls roster.CRLArchive, extra ...string) (int, string, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "roster.jsonl")
	os.WriteFile(path, file, 0o600)
	var out, errOut bytes.Buffer
	mk := func(verifier.Config) (roster.ProofVerifier, error) { return pv, nil }
	args := append([]string{"-bb", "bb", "-crs", "crs"}, extra...)
	code := run(append(args, path), &out, &errOut, mk, crls)
	return code, out.String(), errOut.String()
}

func TestText(t *testing.T) {
	code, out, _ := runWith(t, threeRecords(t), allVerify{}, everyRoot{})
	want := `roster file: valid
records: 3
head: 98949b75a890c8c834c752fe28fda41da55edeed66cc196b75547d376f4192e7

records:
  1 valid first
  2 valid withdraw
  3 invalid root

scope iamreal:threads:0______________
  cards:
    QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880  current none  last card proof 2027-01-01
  accounts:
`
	if out != want {
		t.Errorf("output\n%s\nwant\n%s", out, want)
	}
	if code != exitInvalid {
		t.Errorf("exit %d, want %d: a record is invalid", code, exitInvalid)
	}
}

func TestJSONShape(t *testing.T) {
	_, out, _ := runWith(t, threeRecords(t), allVerify{}, everyRoot{}, "-json")
	var got struct {
		Valid   bool              `json:"valid"`
		Head    string            `json:"head"`
		Results []json.RawMessage `json:"results"`
		State   []json.RawMessage `json:"state"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Valid || len(got.Results) != 3 || got.Head == "" {
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
	code, out, errOut := runWith(t, threeRecords(t), allVerify{}, noArchive{})
	if code != exitInvalid || !strings.Contains(out, "1 invalid root") || !strings.Contains(errOut, "no CRL archive") {
		t.Errorf("exit %d\n%s\n%s", code, out, errOut)
	}
}

func TestEmptyRoster(t *testing.T) {
	code, out, _ := runWith(t, nil, allVerify{}, everyRoot{})
	if code != exitAllValid || !strings.Contains(out, "head: "+verifier.GenesisPrev) {
		t.Errorf("exit %d: %s", code, out)
	}
}

func TestUsage(t *testing.T) {
	var out, errOut bytes.Buffer
	mk := func(verifier.Config) (roster.ProofVerifier, error) { return allVerify{}, nil }
	if code := run(nil, &out, &errOut, mk, everyRoot{}); code != exitError {
		t.Errorf("no arguments: exit %d", code)
	}
	if code := run([]string{"-bb", "x", "-crs", "y", "-roster", "staging", "f"}, &out, &errOut, mk, everyRoot{}); code != exitError {
		t.Errorf("bad roster: exit %d", code)
	}
}
