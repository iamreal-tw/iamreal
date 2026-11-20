package main

// Where the published files are read from: a local directory, or a URL such
// as the data domain https://data.iamreal.tw/ (ADR-0027). Over HTTP there
// is no listing of a directory, so the command asks only for files whose
// names it knows: from the fingerprint file's last line (the roster
// directory) and from the archive index (the CRL archive).

import (
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
	"time"

	"github.com/iamreal-tw/iamreal/crl"
)

// defaultData is the data domain of the production roster (ADR-0027).
const defaultData = "https://data.iamreal.tw/"

// errNotFound is a file that is not there: an absent file in a directory,
// a 404 over HTTP.
var errNotFound = errors.New("not found")

// source reads the files under one root.
type source interface {
	// get returns the bytes of the file at p, "/" between directories,
	// relative to the root; errNotFound if there is no such file.
	get(p string) ([]byte, error)
	// sub is the source rooted at the directory p.
	sub(p string) source
	// local is the root as a local directory, if it is one.
	local() (string, bool)
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
		return urlSource{u, &http.Client{Timeout: fileTimeout}}, nil
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

// fileTimeout is how long one download may take: the largest files are a
// full roster file (about 20 MB) and a CRL of G2 (about 17 MB).
const fileTimeout = 10 * time.Minute

type dirSource string

func (d dirSource) get(p string) ([]byte, error) {
	b, err := os.ReadFile(filepath.Join(string(d), filepath.FromSlash(p)))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errNotFound
	}
	return b, err
}

func (d dirSource) sub(p string) source {
	return dirSource(filepath.Join(string(d), filepath.FromSlash(p)))
}
func (d dirSource) local() (string, bool) { return string(d), true }
func (d dirSource) String() string        { return string(d) }

type urlSource struct {
	base   *url.URL // its path ends in "/"
	client *http.Client
}

func (u urlSource) url(p string) string { return u.base.JoinPath(p).String() }

func (u urlSource) get(p string) ([]byte, error) {
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
	b, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("%s: %v", u.url(p), err)
	}
	return b, nil
}

func (u urlSource) sub(p string) source {
	b := u.base.JoinPath(p)
	b.Path += "/"
	return urlSource{b, u.client}
}

func (u urlSource) local() (string, bool) { return "", false }
func (u urlSource) String() string        { return u.base.String() }

// archiveFrom returns the CRL archive at src as a local directory, and a
// function that removes what it downloaded. A local archive is used where
// it is. Over HTTP it downloads the index and, unless trustIndex, every
// CRL file the index lists (each named by its SHA-256, as the mirror names
// them, spec/revocation-tree.md "Files") into a new directory. Without a
// listing, a file the index does not list is not seen; a file the index
// lists and the server does not have is left out, so that rebuilding the
// index reports it. Lines that are not as the spec writes them name no
// file; rebuilding reports them too.
func archiveFrom(src source, trustIndex bool, stderr io.Writer) (string, func(), error) {
	if dir, ok := src.local(); ok {
		return dir, func() {}, nil
	}
	dir, err := os.MkdirTemp("", "iamreal-verify-crl-")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { os.RemoveAll(dir) }
	fail := func(err error) (string, func(), error) {
		cleanup()
		return "", nil, err
	}
	index, err := src.get(crl.IndexFileName)
	if errors.Is(err, errNotFound) {
		return dir, cleanup, nil
	}
	if err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(dir, crl.IndexFileName), index, 0o600); err != nil {
		return fail(err)
	}
	if trustIndex {
		return dir, cleanup, nil
	}
	seen := map[string]bool{}
	for _, m := range indexSHA256.FindAllSubmatch(index, -1) {
		name := string(m[1]) + ".crl"
		if seen[name] {
			continue
		}
		seen[name] = true
		fmt.Fprintf(stderr, "iamreal-verify: downloading %s\n", src.(urlSource).url(name))
		b, err := src.get(name)
		if errors.Is(err, errNotFound) {
			continue
		}
		if err != nil {
			return fail(err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			return fail(err)
		}
	}
	return dir, cleanup, nil
}

// indexSHA256 finds the sha256 of each line of an archive index.
var indexSHA256 = regexp.MustCompile(`"sha256":"([0-9a-f]{64})"`)
