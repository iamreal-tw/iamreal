package main

// CRL patches (spec/revocation-tree.md, "CRL patches"): over HTTP the
// command downloads the first usable CRL of each issuer key whole and gives
// every later one from its patch; a patch that is missing, cannot be used
// or gives another file is reported in one line, and the CRL downloaded
// whole. What a patch gives counts only with the SHA-256 of the file's name,
// so the result is that of downloading every file whole.

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/binary"
	"maps"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/prooflog"
	"github.com/iamreal-tw/iamreal/verifier"
)

// makeTestPatch is a patch that gives next from previous: a copy of what
// they share at the start, a write of the middle, a copy of what they share
// at the end. Any patch that gives next will do (the spec leaves the making
// open); this one copies, so restoring reads previous.
func makeTestPatch(previous, next []byte) []byte {
	head := 0
	for head < len(previous) && head < len(next) && previous[head] == next[head] {
		head++
	}
	tail := 0
	for tail < len(previous)-head && tail < len(next)-head && previous[len(previous)-1-tail] == next[len(next)-1-tail] {
		tail++
	}
	var p []byte
	p = append(p, 0)
	p = binary.BigEndian.AppendUint32(p, 0)
	p = binary.BigEndian.AppendUint32(p, uint32(head))
	middle := next[head : len(next)-tail]
	p = append(p, 1)
	p = binary.BigEndian.AppendUint32(p, uint32(len(middle)))
	p = append(p, middle...)
	p = append(p, 0)
	p = binary.BigEndian.AppendUint32(p, uint32(len(previous)-tail))
	p = binary.BigEndian.AppendUint32(p, uint32(tail))
	return p
}

// patchArchive is a CRL archive on a data domain, signed by keys made for
// it, with the patches the mirror publishes.
type patchArchive struct {
	keys  []crl.NamedKey
	files map[string][]byte // the data domain: an empty proof log, crl/
	// whole is the CRL files the command downloads whole, patches the
	// patches it reads, each as "GET <path>", sorted.
	whole, patches []string
	// patchOf is the path of the patch that gives a CRL file, by the
	// file's path; patched is those files, in the order of the index.
	patchOf map[string]string
	patched []string
}

var patchArchiveOnce = sync.OnceValues(newPatchArchive)

// newPatchArchive signs, under two keys made for it: three CRLs of G2; four
// of G3, the second of which is unusable (it has deltaCRLIndicator) and so
// has no patch and is no file's previous CRL; and adds a file that is not a
// CRL (issuer "-"). Each usable CRL revokes a few more serial numbers than
// the one before. The index is built from the files, as the mirror's.
func newPatchArchive() (*patchArchive, error) {
	a := &patchArchive{files: dataFiles(0, fingerprintEntry("2026-11-16", 0)), patchOf: map[string]string{}}
	var ders [][]byte
	for _, issuer := range []struct {
		name    string
		numbers []int64
		delta   int64 // the number of the unusable one, 0 for none
	}{{"G2", []int64{2026111605, 2026111610, 2026111617}, 0}, {"G3", []int64{2026111605, 2026111610, 2026111617, 2026111623}, 2026111610}} {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}
		a.keys = append(a.keys, crl.NamedKey{Name: issuer.name, Key: &key.PublicKey})
		tmpl := &x509.Certificate{
			SerialNumber:          big.NewInt(1),
			Subject:               pkix.Name{CommonName: "test issuer " + issuer.name},
			SubjectKeyId:          []byte(issuer.name),
			NotBefore:             time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
			NotAfter:              time.Date(2036, 1, 1, 0, 0, 0, 0, time.UTC),
			KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
			BasicConstraintsValid: true,
			IsCA:                  true,
		}
		certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
		if err != nil {
			return nil, err
		}
		cert, err := x509.ParseCertificate(certDER)
		if err != nil {
			return nil, err
		}
		for i, n := range issuer.numbers {
			list := &x509.RevocationList{
				Number:     big.NewInt(n),
				ThisUpdate: time.Date(2026, 11, 15, 21, 0, 0, 0, time.UTC).Add(time.Duration(i) * 6 * time.Hour),
			}
			list.NextUpdate = list.ThisUpdate.Add(36 * time.Hour)
			for s := range 20 + 5*i {
				list.RevokedCertificateEntries = append(list.RevokedCertificateEntries, x509.RevocationListEntry{
					SerialNumber:   big.NewInt(int64(1000 + s)),
					RevocationTime: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(s) * time.Hour),
					ReasonCode:     1,
				})
			}
			if n == issuer.delta {
				base, _ := asn1.Marshal(big.NewInt(n - 5))
				list.ExtraExtensions = []pkix.Extension{{Id: asn1.ObjectIdentifier{2, 5, 29, 27}, Value: base}}
			}
			der, err := x509.CreateRevocationList(rand.Reader, list, cert, key)
			if err != nil {
				return nil, err
			}
			ders = append(ders, der)
		}
	}
	ders = append(ders, []byte("not a CRL"))
	var files []crl.ArchiveFile
	byName := map[string][]byte{}
	for _, der := range ders {
		name := sha256Hex(der) + ".crl"
		byName[name] = der
		files = append(files, crl.ArchiveFile{Name: name, Read: func() ([]byte, error) { return der, nil }})
	}
	lines, err := crl.BuildIndexOf(files, a.keys, nil)
	if err != nil {
		return nil, err
	}
	var index []byte
	var previous *crl.IndexLine
	for _, l := range lines {
		index = append(index, l.Line()...)
		name := "crl/" + l.SHA256 + ".crl"
		a.files[name] = byName[l.SHA256+".crl"]
		if strings.HasPrefix(l.Root, "-") {
			a.whole = append(a.whole, "GET "+name)
			continue
		}
		if previous == nil || previous.Issuer != l.Issuer {
			a.whole = append(a.whole, "GET "+name)
		} else {
			p := path.Join("crl", crl.PatchesDir, crl.PatchName(previous.SHA256, l.SHA256))
			a.files[p] = makeTestPatch(byName[previous.SHA256+".crl"], byName[l.SHA256+".crl"])
			a.patches = append(a.patches, "GET "+p)
			a.patchOf[name] = p
			a.patched = append(a.patched, name)
		}
		previous = &l
	}
	a.files["crl/"+crl.IndexFileName] = index
	slices.Sort(a.whole)
	slices.Sort(a.patches)
	return a, nil
}

func newPatchArchiveT(t *testing.T) *patchArchive {
	t.Helper()
	a, err := patchArchiveOnce()
	if err != nil {
		t.Fatal(err)
	}
	if len(a.whole) != 4 || len(a.patches) != 4 || !strings.HasPrefix(path.Base(a.patchOf[a.patched[1]]), strings.TrimSuffix(path.Base(a.patched[0]), ".crl")+"-") {
		t.Fatalf("%d CRLs whole, %d patches: %v %v", len(a.whole), len(a.patches), a.whole, a.patches)
	}
	return a
}

// run runs the command with -data source, the fake verifier and the
// archive's keys.
func (a *patchArchive) run(t *testing.T, source string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	mk := func(verifier.Config) (prooflog.ProofVerifier, error) { return allVerify{}, nil }
	code := run([]string{"-bb", "bb", "-crs", "crs", "-json", "-data", source}, &out, &errOut, deps{mk, openArchive(func() ([]crl.NamedKey, error) { return a.keys, nil })})
	return code, out.String(), errOut.String()
}

// heads is the HEAD requests for the originals of the CRLs given by
// patches, sorted.
func (a *patchArchive) heads() []string {
	var out []string
	for _, name := range a.patched {
		out = append(out, "HEAD "+name)
	}
	slices.Sort(out)
	return out
}

// headsAsked is the HEAD requests a server was asked, sorted.
func headsAsked(srv *dataServer) []string {
	var out []string
	for _, p := range srv.paths() {
		if strings.HasPrefix(p, "HEAD ") {
			out = append(out, p)
		}
	}
	return out
}

// problems is the lines of standard error that are not progress: neither
// "downloading …", nor "CRL …", nor a patch that was not used; with the
// server's URL, url, written as "<data>/".
func problems(errOut, url string) []string {
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(errOut, url, "<data>/"), "\n") {
		if strings.HasPrefix(l, "iamreal-verify: downloading ") || strings.HasPrefix(l, "iamreal-verify: CRL ") || strings.HasSuffix(l, "downloading the CRL whole") {
			continue
		}
		out = append(out, l)
	}
	return out
}

// The original of a CRL given by its patch is asked for with HEAD: it must
// be there with the length of the file the patch gives. One that is not
// there is left out of the archive and one of another length downloaded
// whole, so that the command reports either as it does when it downloads
// every file whole (here: the same files without patches/). A HEAD that
// fails or gives no length: the CRL downloaded whole, with one line.
func TestDataCRLOriginals(t *testing.T) {
	a := newPatchArchiveT(t)
	target := a.patched[0]
	withoutPatches := func(files map[string][]byte) map[string][]byte {
		out := maps.Clone(files)
		for p := range out {
			if strings.HasPrefix(p, "crl/patches/") {
				delete(out, p)
			}
		}
		return out
	}
	for _, c := range []struct {
		name string
		edit func(map[string][]byte)
		exit int
		want string
	}{
		{"not there", func(f map[string][]byte) { delete(f, target) }, exitInvalid, "the index lists a file the archive does not have"},
		{"of another length", func(f map[string][]byte) { f[target] = append(slices.Clone(f[target]), 0) }, exitInvalid, "is not the SHA-256 of its content"},
	} {
		t.Run(c.name, func(t *testing.T) {
			files := maps.Clone(a.files)
			c.edit(files)
			srv := serveData(t, files)
			code, out, errOut := a.run(t, srv.URL)
			if code != c.exit || !strings.Contains(errOut, c.want) {
				t.Errorf("exit %d\n%s", code, errOut)
			}
			whole := serveData(t, withoutPatches(files))
			wholeCode, wholeOut, wholeErr := a.run(t, whole.URL)
			if got, want := problems(errOut, srv.URL), problems(wholeErr, whole.URL); code != wholeCode || out != wholeOut || !slices.Equal(got, want) {
				t.Errorf("with patches: exit %d\n%s\nwhole: exit %d\n%s", code, strings.Join(got, "\n"), wholeCode, strings.Join(want, "\n"))
			}
			if slices.Contains(srv.paths(), "GET "+a.patchOf[target]) && c.name == "not there" {
				t.Errorf("asked for the patch of a CRL that is not there")
			}
		})
	}
	for _, c := range []struct {
		name string
		head func(w http.ResponseWriter)
		why  string
	}{
		{"a HEAD that fails", func(w http.ResponseWriter) { http.Error(w, "down", http.StatusInternalServerError) }, "500"},
		{"a HEAD without a length", func(w http.ResponseWriter) { w.Header().Set("Transfer-Encoding", "chunked"); w.(http.Flusher).Flush() }, "no Content-Length"},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				p := strings.TrimPrefix(r.URL.Path, "/")
				if r.Method == http.MethodHead && p == target {
					c.head(w)
					return
				}
				b, ok := a.files[p]
				if !ok {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Content-Length", strconv.Itoa(len(b)))
				if r.Method == http.MethodGet {
					w.Write(b)
				}
			}))
			t.Cleanup(srv.Close)
			code, _, errOut := a.run(t, srv.URL+"/")
			var said []string
			for _, l := range strings.Split(errOut, "\n") {
				if strings.Contains(l, "whole") {
					said = append(said, l)
				}
			}
			if code != exitAllValid || len(said) != 1 || !strings.Contains(said[0], target) || !strings.Contains(said[0], c.why) ||
				!strings.Contains(errOut, "downloading "+srv.URL+"/"+target+"\n") {
				t.Errorf("exit %d, said %q\n%s", code, said, errOut)
			}
		})
	}
}

// crlAsked is what a server was asked for under crl/ whose name ends in
// suffix (".crl" for CRL files, ".patch" for patches), sorted.
func crlAsked(srv *dataServer, suffix string) []string {
	var out []string
	for _, p := range srv.paths() {
		if strings.HasPrefix(p, "GET crl/") && strings.HasSuffix(p, suffix) {
			out = append(out, p)
		}
	}
	return out
}

// Each issuer key's first usable CRL is downloaded whole, and so is every
// file that the index says is not usable; every other CRL only through its
// patch. Nothing is reported, and the CRLs the patches give are those of
// the files: the command's rebuilt index and output are those of the same
// archive in a directory, which it reads whole.
func TestDataCRLPatches(t *testing.T) {
	a := newPatchArchiveT(t)
	srv := serveData(t, a.files)
	code, out, errOut := a.run(t, srv.URL)
	if code != exitAllValid || strings.Contains(errOut, "whole") {
		t.Fatalf("exit %d\n%s\n%s", code, out, errOut)
	}
	if got := crlAsked(srv, ".crl"); !slices.Equal(got, a.whole) {
		t.Errorf("CRLs asked for whole\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(a.whole, "\n"))
	}
	if got := crlAsked(srv, ".patch"); !slices.Equal(got, a.patches) {
		t.Errorf("patches asked for\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(a.patches, "\n"))
	}
	// The original of each CRL given by a patch: asked for with HEAD.
	if got, want := headsAsked(srv), a.heads(); !slices.Equal(got, want) {
		t.Errorf("HEAD of\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if n := strings.Count(errOut, "iamreal-verify: CRL "); n != len(a.whole)+len(a.patches) {
		t.Errorf("%d CRLs indexed\n%s", n, errOut)
	}

	// The same archive in a local directory, patches/ with it: every file
	// read whole, the same output.
	dir := writeDir(t, a.files, "-")
	dirCode, dirOut, dirErr := a.run(t, dir)
	if dirCode != code || dirOut != out || strings.Contains(dirErr, ".patch") {
		t.Errorf("directory: exit %d\n%s\n%s", dirCode, dirOut, dirErr)
	}

	// What each file gives, read as the command reads it, is the file.
	src, err := openSource(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	files, cleanup, err := src.sub("crl").crlArchive(false, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	for _, f := range files.files {
		b, err := f.Read()
		if err != nil || !bytes.Equal(b, a.files["crl/"+f.Name]) {
			t.Errorf("%s: %d bytes, %v", f.Name, len(b), err)
		}
	}
}

// A patch that is missing, cannot be used, gives another file or cannot be
// downloaded: the CRL is downloaded whole, one line says why, and the
// exit code and output are what they would be without patches. The later
// patches of the key are still read: the CRL downloaded whole is their
// previous one.
func TestDataCRLPatchFallback(t *testing.T) {
	a := newPatchArchiveT(t)
	_, want, _ := a.run(t, serveData(t, a.files).URL)
	// The first patch of G2: the next CRL of G2 has a patch from the one
	// this patch gives.
	target := a.patched[0]
	for _, c := range []struct {
		name string
		edit func(files map[string][]byte, patch string)
		why  string
	}{
		{"missing", func(f map[string][]byte, p string) { delete(f, p) }, "not found"},
		{"not a patch", func(f map[string][]byte, p string) { f[p] = []byte{2, 0, 0} }, "unusable CRL patch: byte 0 is 2, which is no instruction"},
		{"a copy past the previous file", func(f map[string][]byte, p string) {
			f[p] = append([]byte{0, 0, 0, 0, 0}, binary.BigEndian.AppendUint32(nil, 1<<30)...)
		}, "past the previous file"},
		{"another file", func(f map[string][]byte, p string) { f[p] = append([]byte{1, 0, 0, 0, 3}, "abc"...) }, "unusable CRL patch: it gives a file with SHA-256 ba7816bf"},
		{"larger than a CRL can be", func(f map[string][]byte, p string) { f[p] = make([]byte, maxCRL+1) }, "larger than"},
	} {
		t.Run(c.name, func(t *testing.T) {
			files := maps.Clone(a.files)
			patch := a.patchOf[target]
			c.edit(files, patch)
			srv := serveData(t, files)
			code, out, errOut := a.run(t, srv.URL)
			if code != exitAllValid || out != want {
				t.Errorf("exit %d\n%s\n%s", code, out, errOut)
			}
			var said []string
			for _, l := range strings.Split(errOut, "\n") {
				if strings.Contains(l, "whole") {
					said = append(said, l)
				}
			}
			if len(said) != 1 || !strings.Contains(said[0], srv.URL+patch) || !strings.Contains(said[0], c.why) {
				t.Errorf("said %q, want one line on %s: %s\n%s", said, patch, c.why, errOut)
			}
			if got, want := crlAsked(srv, ".crl"), slices.Sorted(slices.Values(append(slices.Clone(a.whole), "GET "+target))); !slices.Equal(got, want) {
				t.Errorf("CRLs asked for whole\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
			}
			if got := crlAsked(srv, ".patch"); !slices.Equal(got, a.patches) {
				t.Errorf("patches asked for %v", got)
			}
		})
	}
	// A server that fails for the patch: the same.
	t.Run("an error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			p := strings.TrimPrefix(r.URL.Path, "/")
			if p == a.patchOf[target] {
				http.Error(w, "down", http.StatusInternalServerError)
				return
			}
			b, ok := a.files[p]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Write(b)
		}))
		t.Cleanup(srv.Close)
		code, out, errOut := a.run(t, srv.URL+"/")
		if code != exitAllValid || out != want || strings.Count(errOut, "whole") != 1 || !strings.Contains(errOut, "500") {
			t.Errorf("exit %d\n%s\n%s", code, out, errOut)
		}
	})
}
