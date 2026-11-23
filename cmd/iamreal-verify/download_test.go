package main

// What can go wrong between the command and a data domain: files that grow
// while being read, a fingerprint file that says nothing, files too large,
// redirects, CRL files whose content is not their name, and the temporary
// directory of a downloaded archive.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/prooflog"
)

// proofLogFilesAsked is the log files a server was asked for.
func proofLogFilesAsked(srv *dataServer) []string {
	var out []string
	for _, p := range srv.paths() {
		if strings.HasPrefix(p, "GET proof-log/0") {
			out = append(out, p)
		}
	}
	return out
}

// The day's last file is fetched when it holds exactly the published
// records; its list, fetched after, has grown with the day's new records.
// Only the list's lines up to the count are checked (user story 25).
func TestHashListGrewAfterTheFile(t *testing.T) {
	files := dataFiles(500, fingerprintEntry("2026-11-16", 500))
	files["proof-log/hashes/0000000000000000.txt"] = dataFiles(1000, "")["proof-log/hashes/0000000000000000.txt"]
	if code, _, errOut := runData(t, serveData(t, files).URL); code != exitAllValid {
		t.Errorf("exit %d\n%s", code, errOut)
	}
}

// With -data, a fingerprint file that does not say how many records are
// published (none, or no line as the spec writes it) publishes none: no
// log file is downloaded, and the fingerprint file's problems are
// reported. A server that answers every path is not read without end.
func TestDataWithoutACount(t *testing.T) {
	for _, c := range []struct {
		name string
		fps  string // "-": no fingerprint file
		exit int
		want string
	}{
		{"no fingerprint file", "-", exitInvalid, "fingerprints.jsonl is missing"},
		{"no line as the spec writes it", "garbage\n", exitInvalid, "fingerprints.jsonl line 1: not the template of the spec"},
		// spec/record.md: one line per day the proof log was published; an
		// empty file has no line with a problem.
		{"empty", "", exitAllValid, "fingerprints.jsonl: 0 line(s), every fingerprint is the proof log's"},
	} {
		t.Run(c.name, func(t *testing.T) {
			files := dataFiles(1001, c.fps)
			if c.fps == "-" {
				delete(files, "proof-log/"+fingerprintsFileName)
			}
			srv := serveData(t, files)
			code, out, errOut := runData(t, srv.URL)
			if code != c.exit || !strings.Contains(out, "records: 0\n") || !strings.Contains(errOut, c.want) {
				t.Errorf("exit %d\n%s\n%s", code, out, errOut)
			}
			if asked := proofLogFilesAsked(srv); len(asked) != 0 {
				t.Errorf("asked for %v", asked)
			}
		})
	}
	everything := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("garbage\n"))
	}))
	t.Cleanup(everything.Close)
	if code, _, errOut := runData(t, everything.URL+"/"); code != exitInvalid {
		t.Errorf("a server that answers every path: exit %d\n%s", code, errOut)
	}
}

// A file larger than its format allows is an error, not read in part.
func TestDataTooLarge(t *testing.T) {
	for _, c := range []struct {
		name string
		edit func(map[string][]byte)
	}{
		{"a record hash list of more than 1,001 lines", func(f map[string][]byte) {
			f["proof-log/hashes/0000000000000000.txt"] = bytes.Repeat([]byte(prooflog.EmptyFingerprint+"\n"), 1002)
		}},
		{"a fingerprint file larger than its limit", func(f map[string][]byte) {
			f["proof-log/"+fingerprintsFileName] = bytes.Repeat([]byte(fingerprintEntry("2026-11-16", 1)), maxFingerprintFile/100)
		}},
		{"a log file larger than 1,000 lines can be", func(f map[string][]byte) {
			f["proof-log/0000000000000000.jsonl"] = bytes.Repeat([]byte{'x'}, maxProofLogFile+1)
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			files := dataFiles(1, fingerprintEntry("2026-11-16", 1))
			c.edit(files)
			if code, _, errOut := runData(t, serveData(t, files).URL); code != exitError || !strings.Contains(errOut, "larger than") {
				t.Errorf("exit %d\n%s", code, errOut)
			}
		})
	}
}

// A redirect is not followed, wherever it points: the page does the same
// (redirect: "error").
func TestDataNoRedirect(t *testing.T) {
	real := serveData(t, dataFiles(1, fingerprintEntry("2026-11-16", 1)))
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, strings.TrimSuffix(real.URL, "/")+r.URL.Path, http.StatusFound)
	}))
	t.Cleanup(redirect.Close)
	if code, _, errOut := runData(t, redirect.URL+"/"); code != exitError || !strings.Contains(errOut, "302") {
		t.Errorf("exit %d\n%s", code, errOut)
	}
	if len(real.paths()) != 0 {
		t.Errorf("followed the redirect: %v", real.paths())
	}
}

// A CRL file downloaded as crl/<SHA-256>.crl whose content has another
// SHA-256 is reported, and counts as missing from the archive.
func TestDataCRLNotItsName(t *testing.T) {
	files := testDataDomain(t)
	var names []string
	for n := range files {
		if strings.HasSuffix(n, ".crl") {
			names = append(names, n)
		}
	}
	files[names[0]], files[names[1]] = files[names[1]], files[names[0]]
	code, _, errOut := runDataArchive(t, serveData(t, files).URL)
	if code != exitInvalid || strings.Count(errOut, "is not the SHA-256 of its content") != 2 ||
		!strings.Contains(errOut, "the index lists a file the archive does not have") {
		t.Errorf("exit %d\n%s", code, errOut)
	}
}

// A record hash list without a log file is a problem
// (spec/record.md), found where the whole directory can be seen: a local
// directory, given as the log directory or with -data. Over HTTP there
// is no listing.
func TestHashListWithoutAProofLogFile(t *testing.T) {
	files := dataFiles(1001, fingerprintEntry("2026-11-16", 1001))
	files["proof-log/hashes/0000000000002000.txt"] = []byte(prooflog.EmptyFingerprint + "\n")
	dir := writeDir(t, files, "-")
	const want = "hashes/0000000000002000.txt has no log file"
	if code, _, errOut := runDir(t, filepath.Join(dir, "proof-log")); code != exitInvalid || !strings.Contains(errOut, want) {
		t.Errorf("log directory: exit %d\n%s", code, errOut)
	}
	if code, _, errOut := runData(t, dir); code != exitInvalid || !strings.Contains(errOut, want) {
		t.Errorf("-data directory: exit %d\n%s", code, errOut)
	}
	if code, _, errOut := runData(t, serveData(t, files).URL); code != exitAllValid {
		t.Errorf("-data URL: exit %d\n%s", code, errOut)
	}
	// A list after the count whose log file is there (a full file not
	// published yet) has a log file.
	files = dataFiles(2000, fingerprintEntry("2026-11-16", 1000))
	if code, _, errOut := runData(t, writeDir(t, files, "-")); code != exitAllValid {
		t.Errorf("a list after the count: exit %d\n%s", code, errOut)
	}
}

// crlTempDirs is the temporary directories of downloaded archives under dir.
func crlTempDirs(t *testing.T, dir string) []string {
	t.Helper()
	m, err := filepath.Glob(filepath.Join(dir, "iamreal-verify-crl-*"))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// The downloaded archive is removed when a download fails half way.
func TestDataTempDirOnError(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	files := testDataDomain(t)
	served := serveData(t, files)
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".crl") {
			if n++; n == 2 {
				http.Error(w, "down", http.StatusInternalServerError)
				return
			}
		}
		res, err := http.Get(strings.TrimSuffix(served.URL, "/") + r.URL.Path)
		if err != nil {
			t.Error(err)
			return
		}
		defer res.Body.Close()
		w.WriteHeader(res.StatusCode)
		var b bytes.Buffer
		b.ReadFrom(res.Body)
		w.Write(b.Bytes())
	}))
	t.Cleanup(srv.Close)
	if code, _, errOut := runDataArchive(t, srv.URL+"/"); code != exitError {
		t.Errorf("exit %d\n%s", code, errOut)
	}
	if d := crlTempDirs(t, tmp); len(d) != 0 {
		t.Errorf("left %v", d)
	}
	if code, _, _ := runDataArchive(t, served.URL); code != exitAllValid {
		t.Errorf("exit %d", code)
	}
	if d := crlTempDirs(t, tmp); len(d) != 0 {
		t.Errorf("left %v", d)
	}
}

// The downloaded archive is removed when the command is interrupted.
func TestDataTempDirOnInterrupt(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the command")
	}
	cmd := filepath.Join(t.TempDir(), "iamreal-verify")
	if out, err := exec.Command("go", "build", "-o", cmd, ".").CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	files := testDataDomain(t)
	asked := make(chan struct{}, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if strings.HasSuffix(p, ".crl") {
			select {
			case asked <- struct{}{}:
			default:
			}
			<-release // held until the test ends
			return
		}
		b, ok := files[p]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	tmp := t.TempDir()
	c := exec.Command(cmd, "-bb", "bb", "-crs", "crs", "-proof-log", "test", "-data", srv.URL+"/")
	c.Env = append(os.Environ(), "TMPDIR="+tmp)
	var errOut bytes.Buffer
	c.Stderr = &errOut
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-asked:
	case <-time.After(30 * time.Second):
		c.Process.Kill()
		t.Fatalf("no CRL asked for\n%s", errOut.String())
	}
	if d := crlTempDirs(t, tmp); len(d) != 1 {
		t.Fatalf("temporary directories %v", d)
	}
	c.Process.Signal(syscall.SIGINT)
	c.Wait()
	if d := crlTempDirs(t, tmp); len(d) != 0 {
		t.Errorf("left %v\n%s", d, errOut.String())
	}
}
