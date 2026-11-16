package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
)

// crlSource is where MOICA publishes the complete CRL of one issuer key.
type crlSource struct {
	Issuer string // G2 or G3; for the log, since the index takes the issuer from the signature
	URL    string
}

// moicaCRLs are MOICA's complete CRLs, one per issuer key. These are the
// addresses crl/README.md gives ("拿內政部的清冊重算樹根"). Each CRL is signed
// by MOICA, so plain HTTP is enough: whatever arrives is checked against
// the issuer keys before it gives a root (spec/revocation-tree.md).
var moicaCRLs = []crlSource{
	{"G2", "http://moica.nat.gov.tw/repository/MOICA/CRL2/complete.crl"},
	{"G3", "http://crl-moica.moi.gov.tw/crl/MOICA-G3-complete.crl"},
}

// mirrorInterval is how often the mirror asks MOICA for each CRL
// (spec/revocation-tree.md, "Who checks what").
const mirrorInterval = time.Hour

// maxCRLSize is the largest CRL the mirror downloads. MOICA's G2 CRL was
// about 17 MB on 2026-11-16.
const maxCRLSize = 256 << 20

// Mirror keeps the CRL archive: every distinct CRL it has seen, as the
// original bytes in a file named by its SHA-256, and the index of them all
// (spec/revocation-tree.md, "Archive index").
type Mirror struct {
	Dir     string         // the archive directory
	Keys    []crl.NamedKey // the issuer keys the index is built with
	Sources []crlSource
	Client  *http.Client
	Log     *slog.Logger

	mu sync.Mutex // one round at a time
	// The validators of the last response of each URL, sent back in the
	// next request so that an unchanged CRL is not downloaded again. They
	// are kept in memory: after a restart the first request of each URL
	// downloads the file, and an unchanged file is not stored again.
	etag         map[string]string
	lastModified map[string]string
}

// Fetch asks for every source once. It returns the errors of all sources
// that failed; the others are stored all the same.
func (m *Mirror) Fetch(ctx context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.etag == nil {
		m.etag, m.lastModified = map[string]string{}, map[string]string{}
	}
	var errs []error
	for _, src := range m.Sources {
		if err := m.fetch(ctx, src); err != nil {
			m.Log.Error("CRL mirror", "issuer", src.Issuer, "url", src.URL, "err", err)
			errs = append(errs, fmt.Errorf("%s: %w", src.URL, err))
		}
	}
	return errors.Join(errs...)
}

// fetch asks for one CRL with a conditional request. A new file (by
// SHA-256) is stored and added to the index; an unchanged or known one is
// not.
func (m *Mirror) fetch(ctx context.Context, src crlSource) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src.URL, nil)
	if err != nil {
		return err
	}
	if v := m.etag[src.URL]; v != "" {
		req.Header.Set("If-None-Match", v)
	}
	if v := m.lastModified[src.URL]; v != "" {
		req.Header.Set("If-Modified-Since", v)
	}
	resp, err := m.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusNotModified:
		m.Log.Info("CRL mirror: not modified", "issuer", src.Issuer)
		return nil
	case http.StatusOK:
	default:
		return fmt.Errorf("HTTP status %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxCRLSize+1))
	if err != nil {
		return err
	}
	if len(body) > maxCRLSize {
		return fmt.Errorf("larger than %d bytes", maxCRLSize)
	}
	line, stored, err := m.store(body)
	if err != nil {
		return err
	}
	// Remember the validators only once the file is safely stored.
	m.etag[src.URL] = resp.Header.Get("ETag")
	m.lastModified[src.URL] = resp.Header.Get("Last-Modified")
	if stored {
		m.Log.Info("CRL mirror: stored a new CRL", "issuer", src.Issuer, "sha256", line.SHA256,
			"index_issuer", line.Issuer, "crl_number", line.CRLNumber, "crl_date", line.CRLDate, "root", line.Root)
	} else {
		m.Log.Info("CRL mirror: already stored", "issuer", src.Issuer, "sha256", line.SHA256)
	}
	return nil
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// store adds a CRL file to the archive and its line to the index, unless
// the index already has a line with the same SHA-256. stored says whether
// it was new.
func (m *Mirror) store(der []byte) (line crl.IndexLine, stored bool, err error) {
	sum := sha256Hex(der)
	// Read the index before writing anything, so that an index that is not
	// as the spec writes it stops the mirror before it changes the archive.
	lines, err := m.readIndex()
	if err != nil {
		return crl.IndexLine{}, false, err
	}
	for _, l := range lines {
		if l.SHA256 == sum {
			return l, false, nil
		}
	}
	// The file may be there without its line, if writing the index failed
	// last time; it has the same bytes, since its name is their SHA-256.
	path := filepath.Join(m.Dir, sum+".crl")
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		if err := writeFileAtomic(path, der); err != nil {
			return crl.IndexLine{}, false, err
		}
	} else if err != nil {
		return crl.IndexLine{}, false, err
	}
	line = crl.IndexFile(der, m.Keys)
	lines = append(lines, line)
	crl.SortIndex(lines)
	if err := writeFileAtomic(filepath.Join(m.Dir, crl.IndexFileName), crl.FormatIndex(lines)); err != nil {
		return crl.IndexLine{}, false, err
	}
	return line, true, nil
}

// readIndex reads the archive's index. If there is none yet, it builds one
// from the files already in the directory (none, the first time).
func (m *Mirror) readIndex() ([]crl.IndexLine, error) {
	data, err := os.ReadFile(filepath.Join(m.Dir, crl.IndexFileName))
	if errors.Is(err, fs.ErrNotExist) {
		return crl.BuildIndex(m.Dir, m.Keys, nil)
	}
	if err != nil {
		return nil, err
	}
	return crl.ParseIndex(data)
}

// writeFileAtomic writes a file under a temporary name starting with "."
// (which is not part of the archive, and is not served) and renames it, so
// that nobody ever reads half a file.
func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // does nothing after the rename
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
