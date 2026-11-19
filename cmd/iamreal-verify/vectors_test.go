package main

// The published roster of spec/vectors/record.json through the command:
// the roster directories of "generated_roster", written from the names and
// lines the vectors give, and the fingerprint files of "fingerprint_files".

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

type recordVectors struct {
	Tokens  map[string]string `json:"tokens"`
	Rosters []struct {
		Roster  string `json:"roster"`
		Records []struct {
			Line string `json:"line"`
		} `json:"records"`
		HashList string `json:"hash_list"`
	} `json:"rosters"`
	Generated struct {
		LineTemplate string `json:"line_template"`
		Directories  []struct {
			Name   string `json:"name"`
			Roster string `json:"roster"`
			Count  int    `json:"count"`
			Files  []struct {
				Name     string `json:"name"`
				FirstSeq int    `json:"first_seq"`
				Lines    int    `json:"lines"`
				SHA256   string `json:"sha256"`
			} `json:"files"`
			HashLists []struct {
				Name   string `json:"name"`
				SHA256 string `json:"sha256"`
			} `json:"hash_lists"`
			Fingerprint string `json:"fingerprint"`
		} `json:"directories"`
	} `json:"generated_roster"`
	FingerprintFiles []struct {
		Name      string `json:"name"`
		RecordsOf string `json:"records_of"`
		Content   string `json:"content"`
		Valid     bool   `json:"valid"`
		Line      int    `json:"line"`
	} `json:"fingerprint_files"`
}

func loadVectors(t *testing.T) *recordVectors {
	t.Helper()
	b, err := os.ReadFile("../../spec/vectors/record.json")
	if err != nil {
		t.Fatal(err)
	}
	var v recordVectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return &v
}

func (v *recordVectors) sub(s string) string {
	for k, val := range v.Tokens {
		s = strings.ReplaceAll(s, k, val)
	}
	return s
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Each directory is written with the names, first seq and number of lines
// the vectors give, and its record hash lists from the roster package, each
// checked against its SHA-256; the command reads it as valid and prints its
// fingerprint.
func TestVectorsDirectory(t *testing.T) {
	v := loadVectors(t)
	line := func(seq int) string {
		return strings.Replace(v.sub(v.Generated.LineTemplate), "@SEQ@", strconv.Itoa(seq), 1)
	}
	for _, d := range v.Generated.Directories {
		t.Run(d.Name, func(t *testing.T) {
			files := map[string][]byte{}
			var records []*verifier.Record
			for _, f := range d.Files {
				var b []byte
				for seq := f.FirstSeq; seq < f.FirstSeq+f.Lines; seq++ {
					b = append(b, line(seq)...)
					r, err := verifier.ParseLine([]byte(line(seq)), verifier.Production)
					if err != nil {
						t.Fatal(err)
					}
					records = append(records, r)
				}
				if got := sha256Hex(b); got != f.SHA256 {
					t.Fatalf("%s: SHA-256 %s, want %s", f.Name, got, f.SHA256)
				}
				files[f.Name] = b
			}
			for i, f := range roster.DirectoryFiles(records) {
				if i%2 == 1 {
					if want := d.HashLists[i/2]; f.Name != want.Name || sha256Hex(f.Data) != want.SHA256 {
						t.Fatalf("list %s, want %s with SHA-256 %s", f.Name, want.Name, want.SHA256)
					}
					files[f.Name] = f.Data
				}
			}
			fps := fmt.Sprintf(`{"date":"2026-11-16","count":%d,"fingerprint":"%s"}`+"\n", d.Count, d.Fingerprint)
			code, out, errOut := runDir(t, writeDir(t, files, fps), "-json")
			var got jsonReport
			if err := json.Unmarshal([]byte(out), &got); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			if !got.Valid || got.Fingerprint != d.Fingerprint || len(got.Results) != d.Count {
				t.Errorf("exit %d: valid %v, fingerprint %s, %d results; want %s\n%s", code, got.Valid, got.Fingerprint, len(got.Results), d.Fingerprint, errOut)
			}
			for _, w := range []string{"every list is the roster's", "every fingerprint is the roster's"} {
				if !strings.Contains(errOut, w) {
					t.Errorf("stderr does not say %q:\n%s", w, errOut)
				}
			}
		})
	}
}

var problemLine = regexp.MustCompile(`fingerprints\.jsonl line (\d+):`)

// Each fingerprint file is checked against the records of its roster; the
// first line the command reports is the one the vectors give.
func TestVectorsFingerprintFiles(t *testing.T) {
	v := loadVectors(t)
	dirs := map[string]map[string][]byte{}
	for _, rs := range v.Rosters {
		var b []byte
		for _, r := range rs.Records {
			b = append(b, v.sub(r.Line)...)
		}
		dirs[rs.Roster] = map[string][]byte{"0000000000000000.jsonl": b, "hashes/0000000000000000.txt": []byte(rs.HashList)}
	}
	for _, f := range v.FingerprintFiles {
		t.Run(f.Name, func(t *testing.T) {
			_, out, errOut := runDir(t, writeDir(t, dirs[f.RecordsOf], f.Content), "-roster", f.RecordsOf)
			if !strings.Contains(out, "roster file: valid") || !strings.Contains(errOut, "every list is the roster's") {
				t.Fatalf("%s\n%s", out, errOut)
			}
			m := problemLine.FindStringSubmatch(errOut)
			switch {
			case f.Valid && (m != nil || !strings.Contains(errOut, "every fingerprint is the roster's")):
				t.Errorf("not valid:\n%s", errOut)
			case !f.Valid && m == nil:
				t.Errorf("valid, want line %d to fail:\n%s", f.Line, errOut)
			case !f.Valid && m[1] != strconv.Itoa(f.Line):
				t.Errorf("line %s fails first, want %d:\n%s", m[1], f.Line, errOut)
			}
		})
	}
}
