package main

// Reading a published roster directory, its record hash lists and its
// fingerprint file (spec/record.md, "The published roster"), with the fake
// verifier and archive of main_test.go.

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

	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// longRoster is a valid roster of 2,001 records with placeholder proofs:
// every record a first declaration of its own card, dated 2026-11-16.
var longRoster = sync.OnceValue(func() []*verifier.Record {
	proof := base64.StdEncoding.EncodeToString(make([]byte, verifier.ProofLength))
	var out []*verifier.Record
	for seq := uint64(1); seq <= 2001; seq++ {
		var f verifier.Field
		rand.Read(f[1:])
		random := make([]byte, 16)
		rand.Read(random)
		r := &verifier.Record{
			Seq: seq, ScopeString: "iamreal:public:0_______________", ScopedID: verifier.ScopedIDText(f),
			Accounts: []verifier.Account{{Platform: "threads", Username: "alice"}}, Challenge: "2026-11-16." + verifier.EncodeBase32(random),
			Issuer: "G3", SMTRoot: strings.Repeat("0", 64), Circuit: strings.Repeat("0", 64), Proof: proof,
		}
		out = append(out, r)
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

func fingerprints(entries ...string) string { return strings.Join(entries, "") }

func fingerprintEntry(date string, count int) string {
	fp := roster.Fingerprint(longRoster()[:count])
	return fmt.Sprintf(`{"date":"%s","count":%d,"fingerprint":"%s"}`+"\n", date, count, fp)
}

// writeDir writes a roster directory: files by path, and fingerprints.jsonl
// if fingerprintFile is not "-".
func writeDir(t *testing.T, files map[string][]byte, fingerprintFile string) string {
	t.Helper()
	dir := t.TempDir()
	for name, b := range files {
		path := filepath.Join(dir, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if fingerprintFile != "-" {
		os.WriteFile(filepath.Join(dir, fingerprintsFileName), []byte(fingerprintFile), 0o644)
	}
	return dir
}

// longCardStates returns the card state file of the first n records of
// longRoster, as the server writes it: every record is a valid first
// declaration of its own card.
func longCardStates(n int) []byte {
	x := roster.NewRules(verifier.Production, allVerify{}, everyRoot{})
	for _, r := range longRoster()[:min(n, len(longRoster()))] {
		if res, err := x.Apply(r); err != nil || !res.Valid {
			panic(fmt.Sprintf("seq %d: %v %v", r.Seq, res, err))
		}
	}
	return roster.CardStateFile(x.CardRows())
}

// withCardState adds, to the files of a roster directory of longRoster, the
// card state file the server writes with the last line of the fingerprint
// file fps: that of the line's date, with the states after its count. A
// published directory has it (ADR-0027), and the command reports one that
// does not. Nothing is added when fps has no line that reads.
func withCardState(files map[string][]byte, fps string) map[string][]byte {
	lines := readableFingerprintLines([]byte(fps))
	if len(lines) == 0 {
		return files
	}
	last := lines[len(lines)-1]
	out := map[string][]byte{cardStateName(last.Date): longCardStates(int(min(last.Count, uint64(len(longRoster())))))}
	for name, b := range files {
		out[name] = b
	}
	return out
}

// writePublished writes a roster directory of longRoster as the server
// publishes it: writeDir, with the card state file of the last line of
// fingerprintFile.
func writePublished(t *testing.T, files map[string][]byte, fingerprintFile string) string {
	t.Helper()
	return writeDir(t, withCardState(files, fingerprintFile), fingerprintFile)
}

// cut returns the roster files of the roster directory of the first n
// records, without their record hash lists.
func cut(n int) map[string][]byte {
	files := map[string][]byte{}
	for before := 0; before < n; before += roster.LinesPerFile {
		files[fmt.Sprintf("%016d.jsonl", before)] = lines(longRoster()[before:min(before+roster.LinesPerFile, n)])
	}
	return files
}

// published returns the roster files and the record hash lists of the
// first n records.
func published(n int) map[string][]byte {
	files := map[string][]byte{}
	for _, p := range roster.DirectoryFiles(longRoster()[:n]) {
		files[p.RosterFile.Name] = p.RosterFile.Data
		files[p.HashList.Name] = p.HashList.Data
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
	files := published(2001)
	files["README.md"] = []byte("not part of the roster")
	dir := writePublished(t, files, fingerprints(fingerprintEntry("2026-11-16", 0), fingerprintEntry("2026-11-17", 1000), fingerprintEntry("2026-11-19", 1000), fingerprintEntry("2026-11-20", 2001)))
	code, out, errOut := runDir(t, dir)
	fp := roster.Fingerprint(longRoster())
	if code != exitAllValid || !strings.Contains(out, "records: 2001\nfingerprint: "+fp) ||
		!strings.Contains(errOut, "fingerprints.jsonl: 4 line(s), every fingerprint is the roster's") ||
		!strings.Contains(errOut, "hashes/: 3 list(s), every list is the roster's") {
		t.Errorf("exit %d\n%s\n%s", code, out[:200], errOut)
	}
	// The same records as one file give the same output.
	_, outFile, _ := runWith(t, lines(longRoster()), allVerify{}, everyRoot{})
	if outFile != out {
		t.Errorf("the directory and the file give different output")
	}

	// One file of 1 to 1,000 lines.
	for _, n := range []int{1, 1000} {
		code, _, errOut := runDir(t, writePublished(t, published(n), fingerprintEntry("2026-11-16", n)))
		if code != exitAllValid {
			t.Errorf("%d records: exit %d %s", n, code, errOut)
		}
	}
	// No record: no roster file, no record hash list.
	if code, out, errOut := runDir(t, writePublished(t, nil, fingerprintEntry("2026-11-16", 0))); code != exitAllValid || !strings.Contains(out, "records: 0") ||
		!strings.Contains(errOut, "hashes/: 0 list(s)") {
		t.Errorf("empty: exit %d %s %s", code, out, errOut)
	}
}

// The fingerprint file of each case says every record is published (count).
func TestDirectoryBroken(t *testing.T) {
	for _, c := range []struct {
		name  string
		count int
		files func() map[string][]byte
		line  int
		code  string
		want  string
	}{
		{"missing file", 2001, func() map[string][]byte {
			f := cut(2001)
			delete(f, "0000000000001000.jsonl")
			return f
		}, 1001, "directory", "0000000000001000.jsonl, the file that starts at line 1001, is missing"},
		{"short file", 1001, func() map[string][]byte {
			return map[string][]byte{
				"0000000000000000.jsonl": lines(longRoster()[:999]),
				"0000000000000999.jsonl": lines(longRoster()[999:1001]),
			}
		}, 1, "directory", "has 999 lines, not 1000"},
		{"last file too long", 1000, func() map[string][]byte {
			return map[string][]byte{"0000000000000000.jsonl": lines(longRoster()[:1001])}
		}, 1, "directory", "1001 lines, more than 1000"},
		{"empty file", 1001, func() map[string][]byte {
			f := cut(1000)
			f["0000000000001000.jsonl"] = nil
			return f
		}, 1001, "directory", "is empty"},
		{"first file named by its first seq, as before ADR-0027", 1, func() map[string][]byte {
			return map[string][]byte{"0000000000000001.jsonl": lines(longRoster()[:1])}
		}, 1, "directory", "0000000000000000.jsonl, the file that starts at line 1, is missing"},
		{"second file named by its first seq, as before ADR-0027", 1001, func() map[string][]byte {
			f := cut(1001)
			f["0000000000001001.jsonl"] = f["0000000000001000.jsonl"]
			delete(f, "0000000000001000.jsonl")
			return f
		}, 1001, "directory", "0000000000001000.jsonl, the file that starts at line 1001, is missing"},
		{"a file without its last LF", 1001, func() map[string][]byte {
			f := cut(1001)
			b := f["0000000000000000.jsonl"]
			f["0000000000000000.jsonl"] = b[:len(b)-1]
			return f
		}, 1000, "line", ""},
		{"files of the right length, records out of order", 1001, func() map[string][]byte {
			f := cut(1001)
			b := f["0000000000000000.jsonl"]
			last := bytes.LastIndexByte(b[:len(b)-1], '\n') + 1
			f["0000000000000000.jsonl"] = append(append([]byte(nil), b[:last]...), f["0000000000001000.jsonl"]...)
			f["0000000000001000.jsonl"] = b[last:]
			return f
		}, 1000, "seq", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := writePublished(t, c.files(), fingerprintEntry("2026-11-16", c.count))
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

func TestFingerprints(t *testing.T) {
	files := published(1001)
	other := strings.Repeat("a", 64)
	for _, c := range []struct {
		name         string
		fingerprints string
		want         []string
	}{
		{"missing", "-", []string{"fingerprints.jsonl is missing"}},
		{"fingerprint of another roster", `{"date":"2026-11-16","count":1000,"fingerprint":"` + other + `"}` + "\n",
			[]string{"line 1: fingerprint " + other + " is not the roster fingerprint of the first 1000 records"}},
		{"the record hash of the last record, as a head before ADR-0021", `{"date":"2026-11-16","count":1000,"fingerprint":"` + longRoster()[999].Hash() + `"}` + "\n",
			[]string{"line 1: fingerprint " + longRoster()[999].Hash() + " is not the roster fingerprint"}},
		{"the key head, as before ADR-0021", strings.Replace(fingerprintEntry("2026-11-16", 1), `"fingerprint"`, `"head"`, 1),
			[]string{"line 1: not the template of the spec"}},
		{"count beyond the roster", fingerprintEntry("2026-11-16", 0) + `{"date":"2026-11-17","count":1002,"fingerprint":"` + other + `"}` + "\n",
			[]string{"line 2: count 1002, but the roster has 1001 records"}},
		{"date twice", fingerprintEntry("2026-11-16", 1) + fingerprintEntry("2026-11-16", 2),
			[]string{"line 2: date 2026-11-16 is not after 2026-11-16"}},
		{"dates out of order", fingerprintEntry("2026-11-17", 1) + fingerprintEntry("2026-11-16", 2),
			[]string{"line 2: date 2026-11-16 is not after 2026-11-17"}},
		{"count decreases", fingerprintEntry("2026-11-16", 2) + fingerprintEntry("2026-11-17", 1),
			[]string{"line 2: count 1 is less than 2"}},
		{"another spelling", strings.Replace(fingerprintEntry("2026-11-16", 1), `"count":1`, `"count":01`, 1),
			[]string{"line 1: not in its one spelling"}},
		{"whitespace", strings.Replace(fingerprintEntry("2026-11-16", 1), `,"fingerprint"`, `, "fingerprint"`, 1),
			[]string{"line 1: not the template of the spec"}},
		{"no such date", strings.Replace(fingerprintEntry("2026-11-16", 1), "2026-11-16", "2026-02-30", 1),
			[]string{"line 1: date: no such date"}},
		{"no LF at the end", strings.TrimSuffix(fingerprintEntry("2026-11-16", 1), "\n"),
			[]string{"line 1: not the template of the spec"}},
		{"every problem", fingerprintEntry("2026-11-16", 1) + "x\n" + fingerprintEntry("2026-11-16", 2) + fingerprintEntry("2026-11-18", 1001),
			[]string{"line 2: not the template", "line 3: date 2026-11-16 is not after 2026-11-16"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			code, out, errOut := runDir(t, writePublished(t, files, c.fingerprints))
			if code != exitInvalid || !strings.Contains(out, "roster file: valid") {
				t.Errorf("exit %d\n%s", code, errOut)
			}
			for _, w := range c.want {
				if !strings.Contains(errOut, w) {
					t.Errorf("stderr does not say %q:\n%s", w, errOut)
				}
			}
			if strings.Contains(errOut, "every fingerprint is the roster's") {
				t.Errorf("said every fingerprint is fine")
			}
		})
	}
}

func TestHashLists(t *testing.T) {
	fps := fingerprintEntry("2026-11-16", 1001)
	for _, c := range []struct {
		name  string
		files func() map[string][]byte
		want  []string
	}{
		{"one missing", func() map[string][]byte {
			f := published(1001)
			delete(f, "hashes/0000000000001000.txt")
			return f
		}, []string{"hashes/0000000000001000.txt is missing"}},
		{"none", func() map[string][]byte { return cut(1001) },
			[]string{"hashes/0000000000000000.txt is missing", "hashes/0000000000001000.txt is missing"}},
		{"a list without a roster file", func() map[string][]byte {
			f := published(1001)
			f["hashes/0000000000002000.txt"] = []byte(roster.EmptyFingerprint + "\n")
			return f
		}, []string{"hashes/0000000000002000.txt has no roster file"}},
		{"a hash changed", func() map[string][]byte {
			f := published(1001)
			b := append([]byte(nil), f["hashes/0000000000000000.txt"]...)
			b[65] ^= 1
			f["hashes/0000000000000000.txt"] = b
			return f
		}, []string{"hashes/0000000000000000.txt is not the record hash list of the roster"}},
		{"the first line is not the fingerprint before the file", func() map[string][]byte {
			f := published(1001)
			b := f["hashes/0000000000001000.txt"]
			f["hashes/0000000000001000.txt"] = append([]byte(roster.EmptyFingerprint+"\n"), b[65:]...)
			return f
		}, []string{"hashes/0000000000001000.txt is not the record hash list of the roster"}},
		{"no first line", func() map[string][]byte {
			f := published(1001)
			f["hashes/0000000000001000.txt"] = f["hashes/0000000000001000.txt"][65:]
			return f
		}, []string{"hashes/0000000000001000.txt is not the record hash list of the roster"}},
		{"the list of a roster of one record in place of the second list", func() map[string][]byte {
			f := published(1001)
			f["hashes/0000000000001000.txt"] = published(1)["hashes/0000000000000000.txt"]
			return f
		}, []string{"hashes/0000000000001000.txt is not the record hash list of the roster"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			code, out, errOut := runDir(t, writePublished(t, c.files(), fps))
			if code != exitInvalid || !strings.Contains(out, "roster file: valid") {
				t.Errorf("exit %d\n%s", code, errOut)
			}
			for _, w := range c.want {
				if !strings.Contains(errOut, w) {
					t.Errorf("stderr does not say %q:\n%s", w, errOut)
				}
			}
			if strings.Contains(errOut, "every list is the roster's") {
				t.Errorf("said every list is fine")
			}
		})
	}
}
