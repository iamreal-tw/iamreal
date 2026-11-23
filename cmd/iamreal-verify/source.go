package main

// Where the published files are read from: a local directory, or a URL such
// as the data domain https://data.iamreal.tw/ (ADR-0027). Over HTTP there
// is no listing of a directory, so the command asks only for files whose
// names it knows: from the fingerprint file (the log directory) and from
// the archive index (the CRL archive).

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

// defaultData is the data domain of the production log (ADR-0027).
const defaultData = "https://data.iamreal.tw/"

// The largest file of each kind the command reads. A larger one is an
// error, not read in part.
const (
	// maxLine is the longest line of a log file: the proof, 19,544
	// characters (the base64 of verifier.ProofLength bytes), and 4 KiB
	// for every other field and the template. Today they take under 1 KB
	// with both proof logs' platform tables (spec/record.md, "Fields"); the
	// rest leaves room for platforms added later.
	maxLine = (verifier.ProofLength+2)/3*4 + 4<<10
	// maxProofLogFile is a full log file of maxLine lines.
	maxProofLogFile = prooflog.LinesPerFile * maxLine
	// maxHashList is a full record hash list: 1,001 lines of 64 hex
	// digits and LF (spec/record.md, "Record hash lists").
	maxHashList = (prooflog.LinesPerFile + 1) * 65
	// maxFingerprintFile: a line is at most 128 bytes (a count of 16
	// digits), one line per day; 8 MiB holds more than 170 years.
	maxFingerprintFile = 8 << 20
	// maxIndex: an archive index line is under 400 bytes; 16 MiB holds
	// more than 40,000 CRLs, decades of MOICA's two daily CRLs.
	maxIndex = 16 << 20
	// maxCRL: the largest CRL MOICA publishes, G2's, is about 17 MB
	// (worker/README.md); 64 MiB leaves room for it to grow.
	maxCRL = 64 << 20
)

// errNotFound is a file that is not there: an absent file in a directory,
// a 404 over HTTP.
var errNotFound = errors.New("not found")

// source reads the files under one root.
type source interface {
	// get returns the bytes of the file at p, "/" between directories,
	// relative to the root; errNotFound if there is no such file; an
	// error if it is larger than max bytes.
	get(p string, max int64) ([]byte, error)
	// sub is the source rooted at the directory p.
	sub(p string) source
	// list returns the names of the files in the directory p, and false
	// if the source cannot list a directory.
	list(p string) ([]string, bool, error)
	// crlArchive makes the CRL archive rooted here a local directory, for
	// crl.RebuildArchive or crl.ReadArchiveIndex. It returns the directory,
	// the problems it found on the way (each one line for people), and a
	// function that removes what it made.
	crlArchive(trustIndex bool, stderr io.Writer) (dir string, problems []string, cleanup func(), err error)
	String() string
}

// openSource reads s as an http:// or https:// URL, or else as a local
// directory.
func openSource(s string) (source, error) {
	if strings.Contains(s, "://") {
		u, err := url.Parse(s)
		if err != nil {
			return nil, err
		}
		if u.Scheme != "https" && u.Scheme != "http" || u.Host == "" {
			return nil, fmt.Errorf("%s: want an http:// or https:// URL, or a directory", s)
		}
		if !strings.HasSuffix(u.Path, "/") {
			u.Path += "/"
		}
		return urlSource{u, httpClient}, nil
	}
	info, err := os.Stat(s)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", s)
	}
	return dirSource(s), nil
}

// httpClient does not follow redirects: a 3xx is an error, as for the card
// proof page (redirect: "error", web/src/api.ts). Each download may take
// fileTimeout.
var httpClient = &http.Client{
	Timeout:       fileTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

// fileTimeout is how long one download may take: the largest files are a
// full log file (about 20 MB) and a CRL of G2 (about 17 MB).
const fileTimeout = 10 * time.Minute

type dirSource string

func (d dirSource) path(p string) string { return filepath.Join(string(d), filepath.FromSlash(p)) }

func (d dirSource) get(p string, max int64) ([]byte, error) {
	info, err := os.Stat(d.path(p))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if info.Size() > max {
		return nil, fmt.Errorf("%s: larger than %d bytes", d.path(p), max)
	}
	return os.ReadFile(d.path(p))
}

func (d dirSource) sub(p string) source { return dirSource(d.path(p)) }

func (d dirSource) list(p string) ([]string, bool, error) {
	entries, err := os.ReadDir(d.path(p))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, true, nil
	}
	if err != nil {
		return nil, true, err
	}
	var names []string
	for _, e := range entries {
		if e.Type().IsRegular() {
			names = append(names, e.Name())
		}
	}
	return names, true, nil
}

// crlArchive is the directory itself: every file in it is a CRL file of
// the archive, whatever its name (spec/revocation-tree.md, "Files").
func (d dirSource) crlArchive(bool, io.Writer) (string, []string, func(), error) {
	return string(d), nil, func() {}, nil
}

func (d dirSource) String() string { return string(d) }

type urlSource struct {
	base   *url.URL // its path ends in "/"
	client *http.Client
}

func (u urlSource) url(p string) string { return u.base.JoinPath(p).String() }

func (u urlSource) get(p string, max int64) ([]byte, error) {
	res, err := u.client.Get(u.url(p))
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, errNotFound
	default:
		return nil, fmt.Errorf("%s: %s", u.url(p), res.Status)
	}
	if res.ContentLength > max {
		return nil, fmt.Errorf("%s: larger than %d bytes", u.url(p), max)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, max+1))
	if err != nil {
		return nil, fmt.Errorf("%s: %v", u.url(p), err)
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("%s: larger than %d bytes", u.url(p), max)
	}
	return b, nil
}

func (u urlSource) sub(p string) source {
	b := u.base.JoinPath(p)
	b.Path += "/"
	return urlSource{b, u.client}
}

// list: there is no listing over HTTP.
func (u urlSource) list(string) ([]string, bool, error) { return nil, false, nil }

// crlArchive downloads the index and, unless trustIndex, every CRL file
// the index lists, named by its SHA-256 as the mirror names them
// (spec/revocation-tree.md, "Files"), into a new temporary directory.
// Without a listing, a file the index does not list is not seen. A file
// the index lists that is not there (404), or whose content's SHA-256 is
// not its name, is left out, so that rebuilding the index reports it; the
// second is also a problem of its own. Lines that are not as the spec
// writes them name no file; rebuilding reports them too.
func (u urlSource) crlArchive(trustIndex bool, stderr io.Writer) (string, []string, func(), error) {
	dir, cleanup, err := tempDir()
	if err != nil {
		return "", nil, nil, err
	}
	fail := func(err error) (string, []string, func(), error) {
		cleanup()
		return "", nil, nil, err
	}
	index, err := u.get(crl.IndexFileName, maxIndex)
	if errors.Is(err, errNotFound) {
		return dir, nil, cleanup, nil
	}
	if err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(dir, crl.IndexFileName), index, 0o600); err != nil {
		return fail(err)
	}
	if trustIndex {
		return dir, nil, cleanup, nil
	}
	var problems []string
	seen := map[string]bool{}
	for _, m := range indexSHA256.FindAllSubmatch(index, -1) {
		sha := string(m[1])
		name := sha + ".crl"
		if seen[name] {
			continue
		}
		seen[name] = true
		fmt.Fprintf(stderr, "iamreal-verify: downloading %s\n", u.url(name))
		b, err := u.get(name, maxCRL)
		if errors.Is(err, errNotFound) {
			continue
		}
		if err != nil {
			return fail(err)
		}
		sum := sha256.Sum256(b)
		if got := hex.EncodeToString(sum[:]); got != sha {
			problems = append(problems, fmt.Sprintf("%s: %s is not the SHA-256 of its content, %s; left out of the archive", u.url(name), sha, got))
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			return fail(err)
		}
	}
	return dir, problems, cleanup, nil
}

func (u urlSource) String() string { return u.base.String() }

// indexSHA256 finds the sha256 of each line of an archive index.
var indexSHA256 = regexp.MustCompile(`"sha256":"([0-9a-f]{64})"`)

// tempDirs is the temporary directories not yet removed, so that an
// interrupted command removes them too (removeTempDirs).
var tempDirs = struct {
	sync.Mutex
	dirs map[string]bool
}{dirs: map[string]bool{}}

// tempDir makes a temporary directory and returns the function that
// removes it.
func tempDir() (string, func(), error) {
	dir, err := os.MkdirTemp("", "iamreal-verify-crl-")
	if err != nil {
		return "", nil, err
	}
	tempDirs.Lock()
	tempDirs.dirs[dir] = true
	tempDirs.Unlock()
	return dir, func() {
		tempDirs.Lock()
		delete(tempDirs.dirs, dir)
		tempDirs.Unlock()
		os.RemoveAll(dir)
	}, nil
}

// removeTempDirs removes every temporary directory not yet removed.
func removeTempDirs() {
	tempDirs.Lock()
	defer tempDirs.Unlock()
	for dir := range tempDirs.dirs {
		os.RemoveAll(dir)
		delete(tempDirs.dirs, dir)
	}
}
