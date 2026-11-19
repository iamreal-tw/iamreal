package roster_test

// Tests against spec/vectors/record.json: the roster fingerprint
// ("fingerprint_version", "empty_fingerprint", the fingerprint of every
// record of "rosters"), the record hash list of each of "rosters", and the
// roster directories of "generated_roster".

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

type publishedVectors struct {
	Tokens             map[string]string `json:"tokens"`
	FingerprintVersion string            `json:"fingerprint_version"`
	EmptyFingerprint   string            `json:"empty_fingerprint"`
	Rosters            []struct {
		Roster  string `json:"roster"`
		Records []struct {
			Line        string `json:"line"`
			RecordHash  string `json:"record_hash"`
			Fingerprint string `json:"fingerprint"`
		} `json:"records"`
		Fingerprint string `json:"fingerprint"`
		HashList    string `json:"hash_list"`
	} `json:"rosters"`
	Generated struct {
		Roster       string `json:"roster"`
		LineTemplate string `json:"line_template"`
		Fingerprints []struct {
			Count       int    `json:"count"`
			Fingerprint string `json:"fingerprint"`
		} `json:"fingerprints"`
		Directories []struct {
			Name   string `json:"name"`
			Roster string `json:"roster"`
			Count  int    `json:"count"`
			Files  []struct {
				Name     string `json:"name"`
				FirstSeq uint64 `json:"first_seq"`
				Lines    int    `json:"lines"`
				SHA256   string `json:"sha256"`
			} `json:"files"`
			HashLists []struct {
				Name      string `json:"name"`
				Lines     int    `json:"lines"`
				FirstLine string `json:"first_line"`
				LastLine  string `json:"last_line"`
				SHA256    string `json:"sha256"`
			} `json:"hash_lists"`
			Fingerprint string `json:"fingerprint"`
		} `json:"directories"`
	} `json:"generated_roster"`
}

func loadPublished(t *testing.T) *publishedVectors {
	t.Helper()
	var v publishedVectors
	load(t, "record.json", &v)
	return &v
}

func (v *publishedVectors) sub(s string) string {
	for k, val := range v.Tokens {
		s = strings.ReplaceAll(s, k, val)
	}
	return s
}

// generated returns the first n records of the generated roster.
func (v *publishedVectors) generated(t *testing.T, n int) []*verifier.Record {
	t.Helper()
	r := rosterOf(t, v.Generated.Roster)
	out := make([]*verifier.Record, 0, n)
	for seq := 1; seq <= n; seq++ {
		line := strings.Replace(v.sub(v.Generated.LineTemplate), "@SEQ@", strconv.Itoa(seq), 1)
		rec, err := verifier.ParseLine([]byte(line), r)
		if err != nil {
			t.Fatalf("generated record %d: %v", seq, err)
		}
		out = append(out, rec)
	}
	return out
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestVectorsFingerprint(t *testing.T) {
	v := loadPublished(t)
	if v.FingerprintVersion != roster.FingerprintVersion {
		t.Errorf("version %q, want %q", roster.FingerprintVersion, v.FingerprintVersion)
	}
	if v.EmptyFingerprint != roster.EmptyFingerprint {
		t.Errorf("empty fingerprint %q, want %q", roster.EmptyFingerprint, v.EmptyFingerprint)
	}
	for _, rs := range v.Rosters {
		t.Run("rosters/"+rs.Roster, func(t *testing.T) {
			fp := roster.EmptyFingerprint
			var file []byte
			for _, c := range rs.Records {
				fp = roster.NextFingerprint(fp, c.RecordHash)
				if fp != c.Fingerprint {
					t.Errorf("fingerprint after %s… is %s, want %s", c.RecordHash[:8], fp, c.Fingerprint)
				}
				file = append(file, v.sub(c.Line)...)
			}
			records, got, broken := roster.ReadFile(file, rosterOf(t, rs.Roster))
			if broken != nil {
				t.Fatal(broken)
			}
			if got != rs.Fingerprint {
				t.Errorf("ReadFile: fingerprint %s, want %s", got, rs.Fingerprint)
			}
			parts := roster.DirectoryFiles(records)
			if len(parts) != 1 || parts[0].HashList.Name != "hashes/0000000000000000.txt" {
				t.Fatalf("files %v", names(parts))
			}
			if string(parts[0].HashList.Data) != rs.HashList {
				t.Errorf("hash list\n%s\nwant\n%s", parts[0].HashList.Data, rs.HashList)
			}
		})
	}
	all := v.generated(t, 2001)
	for _, c := range v.Generated.Fingerprints {
		t.Run(fmt.Sprintf("generated/%d", c.Count), func(t *testing.T) {
			if got := roster.Fingerprint(all[:c.Count]); got != c.Fingerprint {
				t.Errorf("fingerprint %s, want %s", got, c.Fingerprint)
			}
		})
	}
}

func names(parts []roster.DirectoryPart) []string {
	var out []string
	for _, p := range parts {
		out = append(out, p.RosterFile.Name, p.HashList.Name)
	}
	return out
}

func TestVectorsDirectory(t *testing.T) {
	v := loadPublished(t)
	all := v.generated(t, 2001)
	for _, d := range v.Generated.Directories {
		t.Run(d.Name, func(t *testing.T) {
			parts := roster.DirectoryFiles(all[:d.Count])
			var want []string
			for i := range d.Files {
				want = append(want, d.Files[i].Name, d.HashLists[i].Name)
			}
			if got := names(parts); strings.Join(got, " ") != strings.Join(want, " ") {
				t.Fatalf("files %v, want %v", got, want)
			}
			for i, f := range d.Files {
				got := parts[i].RosterFile
				if n := strings.Count(string(got.Data), "\n"); n != f.Lines {
					t.Errorf("%s: %d lines, want %d", f.Name, n, f.Lines)
				}
				if got.Data != nil && !strings.HasPrefix(string(got.Data), fmt.Sprintf(`{"seq":%d,`, f.FirstSeq)) {
					t.Errorf("%s does not start with seq %d", f.Name, f.FirstSeq)
				}
				if s := sha256Hex(got.Data); s != f.SHA256 {
					t.Errorf("%s: SHA-256 %s, want %s", f.Name, s, f.SHA256)
				}
			}
			for i, h := range d.HashLists {
				list := parts[i].HashList.Data
				got := strings.Split(strings.TrimSuffix(string(list), "\n"), "\n")
				if len(got) != h.Lines || got[0] != h.FirstLine || got[len(got)-1] != h.LastLine {
					t.Errorf("%s: %d lines from %s to %s, want %d from %s to %s", h.Name, len(got), got[0], got[len(got)-1], h.Lines, h.FirstLine, h.LastLine)
				}
				if s := sha256Hex(list); s != h.SHA256 {
					t.Errorf("%s: SHA-256 %s, want %s", h.Name, s, h.SHA256)
				}
			}
			if got := roster.Fingerprint(all[:d.Count]); got != d.Fingerprint {
				t.Errorf("fingerprint %s, want %s", got, d.Fingerprint)
			}
		})
	}
}
