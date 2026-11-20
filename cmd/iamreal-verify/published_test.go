package main

// Re-verifying what is published on a data domain (ADR-0027): the roster
// directory under roster/ and the CRL archive under crl/, read from a URL
// or from a local directory with the same layout (-data).

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/roster"
	"github.com/iamreal-tw/iamreal/verifier"
)

// dataServer serves files by path, "/" between directories, at the root of
// an HTTP server: 404 for any other path. It logs every path asked for.
type dataServer struct {
	URL   string
	mu    sync.Mutex
	asked []string
}

func serveData(t *testing.T, files map[string][]byte) *dataServer {
	t.Helper()
	d := &dataServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		d.mu.Lock()
		d.asked = append(d.asked, r.Method+" "+p)
		d.mu.Unlock()
		b, ok := files[p]
		if !ok || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(srv.Close)
	d.URL = srv.URL + "/"
	return d
}

func (d *dataServer) paths() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return slices.Sorted(slices.Values(d.asked))
}

// under puts every file of files under dir/.
func under(dir string, files map[string][]byte) map[string][]byte {
	out := map[string][]byte{}
	for name, b := range files {
		out[path.Join(dir, name)] = b
	}
	return out
}

// dataFiles is a data domain: the published roster of the first n records
// of longRoster, the fingerprint file fps, and an empty CRL archive index.
func dataFiles(n int, fps string) map[string][]byte {
	files := under("roster", published(n))
	files["roster/"+fingerprintsFileName] = []byte(fps)
	files["crl/"+crl.IndexFileName] = nil
	return files
}

// runData runs the command on -data source with the fake verifier and
// archive of main_test.go.
func runData(t *testing.T, source string, extra ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	args := append([]string{"-bb", "bb", "-crs", "crs", "-data", source}, extra...)
	code := run(args, &out, &errOut, fakeDeps(allVerify{}, everyRoot{}))
	return code, out.String(), errOut.String()
}

func TestDataURL(t *testing.T) {
	fps := fingerprints(fingerprintEntry("2026-11-16", 0), fingerprintEntry("2026-11-17", 1000), fingerprintEntry("2026-11-20", 2001))
	srv := serveData(t, dataFiles(2001, fps))
	code, out, errOut := runData(t, srv.URL)
	if code != exitAllValid || !strings.Contains(out, "records: 2001\nfingerprint: "+roster.Fingerprint(longRoster())) ||
		!strings.Contains(errOut, "fingerprints.jsonl: 3 line(s), every fingerprint is the roster's") ||
		!strings.Contains(errOut, "hashes/: 3 list(s), every list is the roster's") {
		t.Fatalf("exit %d\n%.300s\n%s", code, out, errOut)
	}
	// The same records as one file give the same output.
	if _, outFile, _ := runWith(t, lines(longRoster()), allVerify{}, everyRoot{}); outFile != out {
		t.Errorf("the URL and the file give different output")
	}
	// No listing: the fingerprint file says which files there are, and the
	// date of its last line which card state file (not there: a 404).
	want := []string{
		"GET crl/index.jsonl",
		"GET roster/0000000000000000.jsonl", "GET roster/0000000000001000.jsonl", "GET roster/0000000000002000.jsonl",
		"GET roster/card-state/2026-11-20.jsonl",
		"GET roster/fingerprints.jsonl",
		"GET roster/hashes/0000000000000000.txt", "GET roster/hashes/0000000000001000.txt", "GET roster/hashes/0000000000002000.txt",
	}
	if got := srv.paths(); !slices.Equal(got, want) {
		t.Errorf("asked for\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

// The same layout in a local directory.
func TestDataDirectory(t *testing.T) {
	fps := fingerprints(fingerprintEntry("2026-11-16", 0), fingerprintEntry("2026-11-20", 2001))
	dir := writeDir(t, dataFiles(2001, fps), "-")
	code, out, errOut := runData(t, dir)
	if code != exitAllValid || !strings.Contains(out, "records: 2001\n") || !strings.Contains(errOut, "every list is the roster's") {
		t.Fatalf("exit %d\n%.300s\n%s", code, out, errOut)
	}
}

// Records after the count of the fingerprint file's last line are not
// published yet: a full file is published before the day's line, the last
// file and its list grow during the day. They are not checked.
func TestOnlyUpToTheCount(t *testing.T) {
	for _, c := range []struct {
		name      string
		published int
		count     int
		asked     int // roster files asked for
	}{
		{"a full file after the count", 1001, 1000, 1},
		{"records after the count in the last file", 1000, 999, 1},
		{"both", 2001, 1500, 2},
		{"nothing published yet", 1, 0, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			files := dataFiles(c.published, fingerprintEntry("2026-11-16", c.count))
			// What is not published yet is not checked: a broken record there changes nothing.
			last := roster.RosterFileName(uint64((c.published - 1) / roster.LinesPerFile * roster.LinesPerFile))
			b := files["roster/"+last]
			files["roster/"+last] = append(b[:len(b)-1:len(b)-1], " \n"...)
			srv := serveData(t, files)
			code, out, errOut := runData(t, srv.URL)
			if code != exitAllValid || !strings.Contains(out, fmt.Sprintf("records: %d\nfingerprint: %s", c.count, roster.Fingerprint(longRoster()[:c.count]))) {
				t.Fatalf("exit %d\n%.300s\n%s", code, out, errOut)
			}
			n := 0
			for _, p := range srv.paths() {
				if strings.HasSuffix(p, ".jsonl") && strings.HasPrefix(p, "GET roster/0") {
					n++
				}
			}
			if n != c.asked {
				t.Errorf("%d roster files asked for, want %d: %v", n, c.asked, srv.paths())
			}
		})
	}
}

// The record hash list of the last file may hold more hashes than the
// count: the ones up to the count are checked.
func TestHashListUpToTheCount(t *testing.T) {
	files := dataFiles(1000, fingerprintEntry("2026-11-16", 999))
	list := files["roster/hashes/0000000000000000.txt"]
	changed := append([]byte(nil), list...)
	changed[len(changed)-2] ^= 1 // the hash of record 1,000, not published
	files["roster/hashes/0000000000000000.txt"] = changed
	if code, _, errOut := runData(t, serveData(t, files).URL); code != exitAllValid {
		t.Errorf("a hash after the count changed: exit %d\n%s", code, errOut)
	}
	changed = append([]byte(nil), list...)
	changed[len(changed)-67] ^= 1 // the hash of record 999
	files["roster/hashes/0000000000000000.txt"] = changed
	if code, _, errOut := runData(t, serveData(t, files).URL); code != exitInvalid ||
		!strings.Contains(errOut, "hashes/0000000000000000.txt is not the record hash list of the roster") {
		t.Errorf("a hash before the count changed: exit %d\n%s", code, errOut)
	}
}

// The CRL archive of testdata/ on a data domain, each file named by its
// SHA-256 as the mirror names it, with the test roster of testdata/.
func testDataDomain(t *testing.T) map[string][]byte {
	t.Helper()
	rosterFile, err := os.ReadFile(filepath.Join("testdata", "roster.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	records, fp, broken := roster.ReadFile(rosterFile, verifier.Test)
	if broken != nil || len(records) != 3 {
		t.Fatal(broken)
	}
	files := map[string][]byte{}
	for _, p := range roster.DirectoryFiles(records) {
		files["roster/"+p.RosterFile.Name] = p.RosterFile.Data
		files["roster/"+p.HashList.Name] = p.HashList.Data
	}
	files["roster/"+fingerprintsFileName] = fmt.Appendf(nil, `{"date":"2026-11-24","count":3,"fingerprint":"%s"}`+"\n", fp)
	for _, name := range []string{crlA, crlB, crlC, crl.IndexFileName} {
		b, err := os.ReadFile(filepath.Join("testdata", "archive", name))
		if err != nil {
			t.Fatal(err)
		}
		if name != crl.IndexFileName {
			name = sha256Hex(b) + ".crl"
		}
		files["crl/"+name] = b
	}
	return files
}

func runDataArchive(t *testing.T, source string, extra ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	args := append([]string{"-bb", "bb", "-crs", "crs", "-roster", "test", "-data", source}, extra...)
	mk := func(verifier.Config) (roster.ProofVerifier, error) { return allVerify{}, nil }
	code := run(args, &out, &errOut, deps{mk, openArchive(testIssuerKeys)})
	return code, out.String(), errOut.String()
}

func TestDataCRLArchive(t *testing.T) {
	files := testDataDomain(t)
	var crlFiles []string
	for p := range files {
		if strings.HasSuffix(p, ".crl") {
			crlFiles = append(crlFiles, "GET "+p)
		}
	}

	// Rebuilt from every CRL the index lists.
	srv := serveData(t, files)
	code, out, errOut := runDataArchive(t, srv.URL)
	for _, r := range allValid {
		if !strings.Contains(out, "  "+r+"\n") {
			t.Errorf("no %q", r)
		}
	}
	if code != exitAllValid || !strings.Contains(errOut, "rebuilding") {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	for _, p := range append(crlFiles, "GET crl/index.jsonl") {
		if !slices.Contains(srv.paths(), p) {
			t.Errorf("did not ask for %s", p)
		}
	}

	// Trusting the index: only the index is downloaded.
	srv = serveData(t, files)
	if code, _, errOut := runDataArchive(t, srv.URL, "-crl-trust-index"); code != exitAllValid {
		t.Fatalf("trust index: exit %d\n%s", code, errOut)
	}
	for _, p := range srv.paths() {
		if strings.HasSuffix(p, ".crl") {
			t.Errorf("trusting the index, asked for %s", p)
		}
	}

	// A CRL the index lists that is not there: a difference; record 3 has
	// no CRL for its root.
	cFile := ""
	for p, b := range files {
		if c, _ := os.ReadFile(filepath.Join("testdata", "archive", crlC)); bytes.Equal(b, c) {
			cFile = p
		}
	}
	delete(files, cFile)
	code, out, errOut = runDataArchive(t, serveData(t, files).URL)
	if code != exitInvalid || !strings.Contains(out, "  3 invalid root\n") ||
		!strings.Contains(errOut, "the index lists a file the archive does not have") {
		t.Errorf("without C: exit %d\n%s\n%s", code, out, errOut)
	}

	// No index: a difference when rebuilding, nothing to trust otherwise.
	delete(files, "crl/"+crl.IndexFileName)
	if code, _, errOut := runDataArchive(t, serveData(t, files).URL, "-crl-trust-index"); code != exitError {
		t.Errorf("no index, trust index: exit %d\n%s", code, errOut)
	}
}

func TestDataErrors(t *testing.T) {
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusInternalServerError)
	}))
	t.Cleanup(broken.Close)
	if code, _, errOut := runData(t, broken.URL+"/"); code != exitError || !strings.Contains(errOut, "500") {
		t.Errorf("a server error: exit %d\n%s", code, errOut)
	}
	// Nothing at that address: no fingerprint file, a problem (spec/record.md).
	if code, _, errOut := runData(t, serveData(t, nil).URL); code != exitInvalid || !strings.Contains(errOut, "fingerprints.jsonl is missing") {
		t.Errorf("nothing there: exit %d\n%s", code, errOut)
	}
	dir := t.TempDir()
	for _, args := range [][]string{
		{"-data", dir, filepath.Join(dir, "roster.jsonl")}, // -data and a roster file
		{"-crl-archive", dir},                              // an archive without a roster file
		{"-data", "ftp://example.org/"},
	} {
		var out, errOut bytes.Buffer
		if code := run(append([]string{"-bb", "bb", "-crs", "crs"}, args...), &out, &errOut, fakeDeps(allVerify{}, everyRoot{})); code != exitError {
			t.Errorf("%v: exit %d\n%s", args, code, errOut.String())
		}
	}
}

// README.md quotes the prompt of the page "how to verify" exactly: the
// code block that follows "提示詞要逐字照這一段" in design/copy/verify.md.
func TestReadmeQuotesThePrompt(t *testing.T) {
	copyText, err := os.ReadFile("../../design/copy/verify.md")
	if err != nil {
		t.Fatal(err)
	}
	_, after, ok := strings.Cut(string(copyText), "提示詞要逐字照這一段")
	if !ok {
		t.Fatal("verify.md does not say where the prompt is")
	}
	_, after, ok = strings.Cut(after, "```\n")
	prompt, _, closed := strings.Cut(after, "```\n")
	if !ok || !closed || !strings.HasPrefix(prompt, "請幫我驗證") {
		t.Fatalf("no prompt in verify.md: %q", prompt)
	}
	readme, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(readme), "```\n"+prompt+"```\n") {
		t.Errorf("README.md does not quote the prompt of verify.md:\n%s", prompt)
	}
}

// Without a roster file or -data, the command reads the production data
// domain.
func TestDataDefault(t *testing.T) {
	var out, errOut bytes.Buffer
	run([]string{"-h"}, &out, &errOut, fakeDeps(allVerify{}, everyRoot{}))
	if !strings.Contains(errOut.String(), `(default "https://data.iamreal.tw/")`) {
		t.Errorf("usage:\n%s", errOut.String())
	}
}
