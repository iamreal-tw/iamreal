package main

// Where the published files are read from: a local directory, or a URL such
// as the data domain https://data.iamreal.tw/ (ADR-0027). Over HTTP there
// is no listing of a directory, so the command asks only for files whose
// names it knows: from the fingerprint file (the log directory) and from
// the archive index (the CRL archive).

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
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
	// maxPatch: a CRL patch larger than the largest CRL is never worth
	// reading; downloading the CRL whole is less.
	maxPatch = maxCRL
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
	// crlArchive makes the CRL archive rooted here ready to open
	// (openArchive), and returns it with a function that removes what it
	// made.
	crlArchive(trustIndex bool, stderr io.Writer) (files crlFiles, cleanup func(), err error)
	String() string
}

// crlFiles is a CRL archive to open: a directory, or the files of a URL,
// which are downloaded one at a time as the index is rebuilt.
type crlFiles struct {
	// dir holds index.jsonl; for a directory the command was given, every
	// CRL file too. Empty for no archive.
	dir string
	// remote is set for an archive at a URL: the bytes of its index.jsonl
	// (hasIndex false if it has none) and its files, each downloaded when
	// it is read and held in memory only until its line is computed. No
	// CRL file is written to disk, so the archive is never there whole: a
	// year of it is tens of gigabytes.
	remote   bool
	index    []byte
	hasIndex bool
	files    []crl.ArchiveFile
	// problems returns what reading the files found besides what
	// rebuilding the index reports (each one line for people); nil if
	// nothing can be found.
	problems func() []string
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
func (d dirSource) crlArchive(bool, io.Writer) (crlFiles, func(), error) {
	return crlFiles{dir: string(d)}, func() {}, nil
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

// crlArchive downloads the index into a new temporary directory and,
// unless trustIndex, names every CRL file the index lists, by its SHA-256
// as the mirror names them (spec/revocation-tree.md, "Files"), in the
// order of the index: the CRLs of one issuer key one after another, which
// is the order in which rebuilding reuses the most (crl.Indexer), and in
// which each CRL patch follows from the one before. A file is obtained
// when rebuilding reads it, and not kept: besides it, only the previous
// usable CRL is in memory, and no CRL is on disk.
//
// A file is obtained from its CRL patch (patched) when the index says it
// is usable and the file before it is a usable CRL of the same issuer key
// that was obtained: the first usable CRL of each key, and every file the
// index says is not usable, are downloaded whole. The index is not
// trusted for this: what a patch gives counts only with the SHA-256 of the
// file's name, so a wrong index costs downloads, never a wrong file.
//
// Without a listing, a file the index does not list is not seen. A file
// the index lists that is not there (404), or whose content's SHA-256 is
// not its name, is left out, so that rebuilding the index reports it; the
// second is also a problem of its own. Lines that are not as the spec
// writes them name no file; rebuilding reports them too.
func (u urlSource) crlArchive(trustIndex bool, stderr io.Writer) (crlFiles, func(), error) {
	dir, cleanup, err := tempDir()
	if err != nil {
		return crlFiles{}, nil, err
	}
	fail := func(err error) (crlFiles, func(), error) {
		cleanup()
		return crlFiles{}, nil, err
	}
	out := crlFiles{dir: dir, remote: true}
	index, err := u.get(crl.IndexFileName, maxIndex)
	if errors.Is(err, errNotFound) {
		return out, cleanup, nil
	}
	if err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(dir, crl.IndexFileName), index, 0o600); err != nil {
		return fail(err)
	}
	out.index, out.hasIndex = index, true
	if trustIndex {
		return out, cleanup, nil
	}
	var problems []string
	out.problems = func() []string { return problems }
	// previous is the last file obtained that the index says is a usable
	// CRL: the previous CRL of the next one of its key.
	var previous *heldCRL
	seen := map[string]bool{}
	for _, line := range bytes.Split(index, []byte("\n")) {
		issuer, usable := indexUsable(line)
		for _, m := range indexSHA256.FindAllSubmatch(line, -1) {
			sha := string(m[1])
			name := sha + ".crl"
			if seen[name] {
				continue
			}
			seen[name] = true
			out.files = append(out.files, crl.ArchiveFile{Name: name, Read: func() ([]byte, error) {
				var b []byte
				if usable && previous != nil && previous.issuer != issuer {
					previous = nil // the first of another key: let the last one go
				}
				if usable && previous != nil {
					b = u.patched(previous, sha, stderr)
				}
				if b == nil {
					fmt.Fprintf(stderr, "iamreal-verify: downloading %s\n", u.url(name))
					var err error
					b, err = u.get(name, maxCRL)
					if errors.Is(err, errNotFound) {
						return nil, crl.ErrLeftOut
					}
					if err != nil {
						return nil, err
					}
					sum := sha256.Sum256(b)
					if got := hex.EncodeToString(sum[:]); got != sha {
						problems = append(problems, fmt.Sprintf("%s: %s is not the SHA-256 of its content, %s; left out of the archive", u.url(name), sha, got))
						return nil, crl.ErrLeftOut
					}
				}
				if usable {
					previous = &heldCRL{issuer: issuer, sha256: sha, der: b}
				}
				return b, nil
			}})
		}
	}
	return out, cleanup, nil
}

// heldCRL is a CRL file kept in memory as the previous CRL of the next.
type heldCRL struct {
	issuer, sha256 string
	der            []byte
}

// patched returns the file with SHA-256 sha, given by its CRL patch from
// previous (spec/revocation-tree.md, "CRL patches"); nil, after one line
// on stderr, if the patch is missing, cannot be downloaded or cannot be
// used, or gives a file without that SHA-256 or larger than a CRL can be.
// The caller then downloads the file whole.
func (u urlSource) patched(previous *heldCRL, sha string, stderr io.Writer) []byte {
	p := path.Join(crl.PatchesDir, crl.PatchName(previous.sha256, sha))
	fmt.Fprintf(stderr, "iamreal-verify: downloading %s\n", u.url(p))
	patch, err := u.get(p, maxPatch)
	var file []byte
	if err == nil {
		file, err = crl.RestorePatch(previous.der, patch, sha)
	}
	if err == nil && len(file) > maxCRL {
		err = fmt.Errorf("it gives more than %d bytes", maxCRL)
	}
	if err != nil {
		fmt.Fprintf(stderr, "iamreal-verify: %s: %v; downloading the CRL whole\n", u.url(p), err)
		return nil
	}
	return file
}

func (u urlSource) String() string { return u.base.String() }

// indexSHA256 finds the sha256 of each line of an archive index.
var indexSHA256 = regexp.MustCompile(`"sha256":"([0-9a-f]{64})"`)

// indexIssuer and indexRoot find the issuer and the root of a line; a
// usable CRL's root is 64 hex digits, an unusable file's "-" and a code.
var (
	indexIssuer = regexp.MustCompile(`"issuer":"(G2|G3)"`)
	indexRoot   = regexp.MustCompile(`"root":"[0-9a-f]{64}"`)
)

// indexUsable returns the issuer key of a line of an archive index, and
// whether the line says its file is a usable CRL. A line that does not
// say both is taken for an unusable file: downloaded whole, the previous
// CRL of none.
func indexUsable(line []byte) (string, bool) {
	m := indexIssuer.FindSubmatch(line)
	if m == nil || !indexRoot.Match(line) {
		return "", false
	}
	return string(m[1]), true
}

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
