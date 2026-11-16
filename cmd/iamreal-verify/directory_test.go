package main

// Reading a published roster directory and its heads file
// (spec/record.md, "The published roster"), with the fake verifier and
// archive of main_test.go.

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/iamreal-tw/iamreal/verifier"
)

// longRoster is a valid roster of 2,001 records with placeholder proofs:
// every record a first declaration of its own card, dated 2026-11-16.
var longRoster = sync.OnceValue(func() []*verifier.Record {
	proof := base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength))
	var out []*verifier.Record
	prev := verifier.GenesisPrev
	for seq := uint64(1); seq <= 2001; seq++ {
		var f verifier.Field
		rand.Read(f[1:])
		random := make([]byte, 16)
		rand.Read(random)
		r := &verifier.Record{
			Seq: seq, Prev: prev, ScopeString: "iamreal:threads:0______________", ScopedID: verifier.ScopedIDText(f),
			Action: "declare", Username: "alice", Challenge: "2026-11-16." + verifier.EncodeBase32(random),
			Issuer: "G3", SMTRoot: strings.Repeat("0", 64), Circuit: strings.Repeat("0", 64), Proof: proof,
		}
		out = append(out, r)
		prev = r.Hash()
	}
	return out
})

func lines(records []*verifier.Record) []byte {
	var b []byte
	for _, r := range records {
		b = append(b, r.Line()...)
	}
	return b
}

func heads(entries ...string) string { return strings.Join(entries, "") }

func headsEntry(date string, count int) string {
	head := verifier.GenesisPrev
	if count > 0 {
		head = longRoster()[count-1].Hash()
	}
	return fmt.Sprintf(`{"date":"%s","count":%d,"head":"%s"}`+"\n", date, count, head)
}

// writeDir writes a roster directory: files by name, and heads.jsonl if
// headsFile is not "-".
func writeDir(t *testing.T, files map[string][]byte, headsFile string) string {
	t.Helper()
	dir := t.TempDir()
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if headsFile != "-" {
		os.WriteFile(filepath.Join(dir, headsFileName), []byte(headsFile), 0o644)
	}
	return dir
}

// cut returns the files of the roster directory of the first n records.
func cut(n int) map[string][]byte {
	files := map[string][]byte{}
	for first := 0; first < n; first += linesPerFile {
		files[fmt.Sprintf("%016d.jsonl", first+1)] = lines(longRoster()[first:min(first+linesPerFile, n)])
	}
	return files
}

func runDir(t *testing.T, dir string, extra ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	args := append([]string{"-bb", "bb", "-crs", "crs", "-crl-archive", "archive"}, extra...)
	code := run(append(args, dir), &out, &errOut, fakeDeps(allVerify{}, everyRoot{}))
	return code, out.String(), errOut.String()
}

func TestDirectory(t *testing.T) {
	files := cut(2001)
	files["README.md"] = []byte("not part of the roster")
	dir := writeDir(t, files, heads(headsEntry("2026-11-16", 0), headsEntry("2026-11-17", 1000), headsEntry("2026-11-19", 1000), headsEntry("2026-11-20", 2001)))
	code, out, errOut := runDir(t, dir)
	head := longRoster()[2000].Hash()
	if code != exitAllValid || !strings.Contains(out, "records: 2001\nhead: "+head) || !strings.Contains(errOut, "heads.jsonl: 4 line(s), every head is the roster's") {
		t.Errorf("exit %d\n%s\n%s", code, out[:200], errOut)
	}
	// The same records as one file give the same output.
	_, outFile, _ := runWith(t, lines(longRoster()), allVerify{}, everyRoot{})
	if outFile != out {
		t.Errorf("the directory and the file give different output")
	}

	// One file of 1 to 1,000 lines.
	for _, n := range []int{1, 1000} {
		code, _, errOut := runDir(t, writeDir(t, cut(n), heads(headsEntry("2026-11-16", n))))
		if code != exitAllValid {
			t.Errorf("%d records: exit %d %s", n, code, errOut)
		}
	}
	// No record: no roster file.
	if code, out, errOut := runDir(t, writeDir(t, nil, headsEntry("2026-11-16", 0))); code != exitAllValid || !strings.Contains(out, "records: 0") {
		t.Errorf("empty: exit %d %s %s", code, out, errOut)
	}
}

func TestDirectoryBroken(t *testing.T) {
	h := headsEntry("2026-11-16", 0)
	for _, c := range []struct {
		name  string
		files func() map[string][]byte
		line  int
		code  string
		want  string
	}{
		{"missing file", func() map[string][]byte {
			f := cut(2001)
			delete(f, "0000000000001001.jsonl")
			return f
		}, 1001, "directory", "is 0000000000002001.jsonl, not 0000000000001001.jsonl"},
		{"short file", func() map[string][]byte {
			return map[string][]byte{
				"0000000000000001.jsonl": lines(longRoster()[:999]),
				"0000000000001000.jsonl": lines(longRoster()[999:1001]),
			}
		}, 1, "directory", "has 999 lines, not 1000"},
		{"last file too long", func() map[string][]byte {
			return map[string][]byte{"0000000000000001.jsonl": lines(longRoster()[:1001])}
		}, 1, "directory", "1001 lines, more than 1000"},
		{"empty file", func() map[string][]byte {
			f := cut(1000)
			f["0000000000001001.jsonl"] = nil
			return f
		}, 1001, "directory", "is empty"},
		{"first file not at 1", func() map[string][]byte {
			return map[string][]byte{"0000000000000002.jsonl": lines(longRoster()[:1])}
		}, 1, "directory", "is 0000000000000002.jsonl, not 0000000000000001.jsonl"},
		{"a file without its last LF", func() map[string][]byte {
			f := cut(1001)
			b := f["0000000000000001.jsonl"]
			f["0000000000000001.jsonl"] = b[:len(b)-1]
			return f
		}, 1000, "line", ""},
		{"files of the right length, records out of order", func() map[string][]byte {
			f := cut(1001)
			b := f["0000000000000001.jsonl"]
			last := bytes.LastIndexByte(b[:len(b)-1], '\n') + 1
			f["0000000000000001.jsonl"] = append(append([]byte(nil), b[:last]...), f["0000000000001001.jsonl"]...)
			f["0000000000001001.jsonl"] = b[last:]
			return f
		}, 1000, "seq", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := writeDir(t, c.files(), h)
			code, out, _ := runDir(t, dir)
			want := fmt.Sprintf("roster file: broken at line %d: %s", c.line, c.code)
			if code != exitInvalid || !strings.HasPrefix(out, want) || !strings.Contains(out, c.want) {
				t.Errorf("exit %d: %s\nwant %s … %s", code, out, want, c.want)
			}
			_, out, _ = runDir(t, dir, "-json")
			if !strings.Contains(out, fmt.Sprintf(`"line": %d,`, c.line)) || !strings.Contains(out, `"code": "`+c.code+`"`) {
				t.Errorf("JSON: %s", out)
			}
		})
	}
}

func TestHeads(t *testing.T) {
	files := cut(1001)
	other := strings.Repeat("a", 64)
	for _, c := range []struct {
		name  string
		heads string
		want  []string
	}{
		{"missing", "-", []string{"heads.jsonl is missing"}},
		{"head of another roster", `{"date":"2026-11-16","count":1000,"head":"` + other + `"}` + "\n",
			[]string{"line 1: head " + other + " is not the record hash of record 1000"}},
		{"count beyond the roster", headsEntry("2026-11-16", 0) + `{"date":"2026-11-17","count":1002,"head":"` + other + `"}` + "\n",
			[]string{"line 2: count 1002, but the roster has 1001 records"}},
		{"date twice", headsEntry("2026-11-16", 1) + headsEntry("2026-11-16", 2),
			[]string{"line 2: date 2026-11-16 is not after 2026-11-16"}},
		{"dates out of order", headsEntry("2026-11-17", 1) + headsEntry("2026-11-16", 2),
			[]string{"line 2: date 2026-11-16 is not after 2026-11-17"}},
		{"count decreases", headsEntry("2026-11-16", 2) + headsEntry("2026-11-17", 1),
			[]string{"line 2: count 1 is less than 2"}},
		{"another spelling", strings.Replace(headsEntry("2026-11-16", 1), `"count":1`, `"count":01`, 1),
			[]string{"line 1: not in its one spelling"}},
		{"whitespace", strings.Replace(headsEntry("2026-11-16", 1), `,"head"`, `, "head"`, 1),
			[]string{"line 1: not the template of the spec"}},
		{"no such date", strings.Replace(headsEntry("2026-11-16", 1), "2026-11-16", "2026-02-30", 1),
			[]string{"line 1: date: no such date"}},
		{"no LF at the end", strings.TrimSuffix(headsEntry("2026-11-16", 1), "\n"),
			[]string{"line 1: not the template of the spec"}},
		{"every problem", headsEntry("2026-11-16", 1) + "x\n" + headsEntry("2026-11-16", 2) + headsEntry("2026-11-18", 1001),
			[]string{"line 2: not the template", "line 3: date 2026-11-16 is not after 2026-11-16"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			code, out, errOut := runDir(t, writeDir(t, files, c.heads))
			if code != exitInvalid || !strings.Contains(out, "roster file: valid") {
				t.Errorf("exit %d\n%s", code, errOut)
			}
			for _, w := range c.want {
				if !strings.Contains(errOut, w) {
					t.Errorf("stderr does not say %q:\n%s", w, errOut)
				}
			}
			if strings.Contains(errOut, "every head is the roster's") {
				t.Errorf("said every head is fine")
			}
		})
	}
}
