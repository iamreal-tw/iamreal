package crl

import (
	"bytes"
	"crypto/rsa"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// IndexFileName is the name of the index in an archive directory. Every
// other file of the directory, except those whose name starts with ".", is a
// file of the archive; subdirectories are not read.
const IndexFileName = "index.jsonl"

// NamedKey is an issuer key and its name in the index (G2 or G3).
type NamedKey struct {
	Name string
	Key  *rsa.PublicKey
}

// MOICAKeys returns the keys of spec/issuers.md, in its order.
func MOICAKeys() ([]NamedKey, error) {
	var out []NamedKey
	for _, name := range Issuers {
		k, err := IssuerKey(name)
		if err != nil {
			return nil, err
		}
		out = append(out, NamedKey{name, k})
	}
	return out, nil
}

// IndexLine is one line of the archive index (spec/revocation-tree.md,
// "Archive index"). Every field holds the text of the line; "-" stands for
// a missing or unreadable value. Root is the root in hex for a usable CRL,
// and "-" followed by a reason code otherwise.
type IndexLine struct {
	Issuer     string
	CRLNumber  string
	ThisUpdate string
	NextUpdate string
	CRLDate    string
	SHA256     string
	Root       string
}

// Usable reports whether the line is of a usable CRL: its root is a root.
func (l IndexLine) Usable() bool { return !strings.HasPrefix(l.Root, "-") }

// Reason returns the reason code of a CRL that is not usable, or "".
func (l IndexLine) Reason() string {
	if l.Usable() {
		return ""
	}
	return l.Root[1:]
}

// Line returns the line in its one spelling, ending in LF.
func (l IndexLine) Line() []byte {
	return fmt.Appendf(nil, `{"issuer":"%s","crl_number":"%s","this_update":"%s","next_update":"%s","crl_date":"%s","sha256":"%s","root":"%s"}`+"\n",
		l.Issuer, l.CRLNumber, l.ThisUpdate, l.NextUpdate, l.CRLDate, l.SHA256, l.Root)
}

const (
	none       = "-"
	timeFormat = "2006-01-02T15:04:05Z"
)

// IndexFile returns the index line of one archive file. keys are tried in
// order; the first under which the signature verifies (as SHA-256 with RSA,
// whatever the AlgorithmIdentifiers say) gives the issuer, and Check under
// that key decides whether the file is usable. If none verifies, the issuer
// is "-" and the reason is ReasonAlgorithm when the AlgorithmIdentifiers are
// wrong, ReasonSignature otherwise. A file that is not a DER CertificateList
// has only its SHA-256 and ReasonDER.
func IndexFile(der []byte, keys []NamedKey) IndexLine {
	sum := sha256Hex(der)
	l := IndexLine{Issuer: none, CRLNumber: none, ThisUpdate: none, NextUpdate: none, CRLDate: none, SHA256: sum}
	c, err := Parse(der)
	if err != nil {
		l.Root = none + ReasonDER
		return l
	}
	l.ThisUpdate = c.ThisUpdate.Format(timeFormat)
	l.CRLDate = c.Date()
	if !c.NextUpdate.IsZero() {
		l.NextUpdate = c.NextUpdate.Format(timeFormat)
	}
	if n, err := c.Number(); err == nil && n != nil {
		l.CRLNumber = n.String()
	}
	var key *rsa.PublicKey
	for _, k := range keys {
		if c.signedBy(k.Key) {
			l.Issuer, key = k.Name, k.Key
			break
		}
	}
	if key == nil {
		if c.algorithmsOK() {
			l.Root = none + ReasonSignature
		} else {
			l.Root = none + ReasonAlgorithm
		}
		return l
	}
	tree, err := c.Tree(key)
	if err != nil {
		var u *Unusable
		if !errors.As(err, &u) {
			panic(err) // Tree returns only *Unusable errors
		}
		l.Root = none + u.Code
		return l
	}
	l.Root = tree.RootHex()
	return l
}

// Tree checks that c is usable under issuerKey and builds its tree. Every
// error is an *Unusable.
func (c *CRL) Tree(issuerKey *rsa.PublicKey) (*Tree, error) {
	keys, err := c.Check(issuerKey)
	if err != nil {
		return nil, err
	}
	t, err := NewTree(keys)
	if err != nil {
		// Check returns distinct keys that do not collide.
		panic(err)
	}
	return t, nil
}

func sha256Hex(b []byte) string {
	sum := (&CRL{Raw: b}).SHA256()
	return hex.EncodeToString(sum[:])
}

// archiveFiles returns the names of the files of an archive directory,
// sorted.
func archiveFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == IndexFileName {
			continue
		}
		names = append(names, e.Name())
	}
	return names, nil
}

// BuildIndex returns the index of the archive directory dir: one line per
// file, sorted (SortIndex). progress, if not nil, is called with each file
// name before the file is read; a G2 CRL takes about 10 seconds.
func BuildIndex(dir string, keys []NamedKey, progress func(name string)) ([]IndexLine, error) {
	names, err := archiveFiles(dir)
	if err != nil {
		return nil, err
	}
	lines := make([]IndexLine, 0, len(names))
	for _, name := range names {
		if progress != nil {
			progress(name)
		}
		der, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		lines = append(lines, IndexFile(der, keys))
	}
	SortIndex(lines)
	return lines, nil
}

// SortIndex sorts lines by issuer, then CRL number as a number, then
// SHA-256. Issuer "-" comes before G2 and G3 (byte order), and CRL number
// "-" before every number.
func SortIndex(lines []IndexLine) { slices.SortStableFunc(lines, compareLines) }

func compareLines(a, b IndexLine) int {
	if c := strings.Compare(a.Issuer, b.Issuer); c != 0 {
		return c
	}
	if c := compareNumbers(a.CRLNumber, b.CRLNumber); c != 0 {
		return c
	}
	return strings.Compare(a.SHA256, b.SHA256)
}

// compareNumbers compares decimal numbers without leading zeros, "-" first.
func compareNumbers(a, b string) int {
	switch {
	case a == b:
		return 0
	case a == none:
		return -1
	case b == none:
		return 1
	case len(a) != len(b):
		return len(a) - len(b)
	}
	return strings.Compare(a, b)
}

// FormatIndex returns the lines as an index file.
func FormatIndex(lines []IndexLine) []byte {
	var b bytes.Buffer
	for _, l := range lines {
		b.Write(l.Line())
	}
	return b.Bytes()
}

// IndexError is a line of an index file that is not as the spec writes it.
type IndexError struct {
	Line int // counting from 1
	Err  error
}

func (e *IndexError) Error() string { return fmt.Sprintf("crl: index line %d: %v", e.Line, e.Err) }

var indexKeys = []string{"issuer", "crl_number", "this_update", "next_update", "crl_date", "sha256", "root"}

// ParseIndex reads an index file and checks every line against the spec:
// the template, the format of each field, and the order of the lines. It
// also checks what one line implies about itself: the CRL date is the date
// of thisUpdate in Taiwan (or "-" with it), and a line with a root has an
// issuer, a CRL number and a thisUpdate. It cannot check the roots, the
// hashes or that the files exist; RebuildArchive does.
func ParseIndex(data []byte) ([]IndexLine, error) {
	if len(data) > 0 && data[len(data)-1] != '\n' {
		n := bytes.Count(data, []byte("\n")) + 1
		return nil, &IndexError{n, errors.New("does not end in LF")}
	}
	var lines []IndexLine
	for n := 1; len(data) > 0; n++ {
		i := bytes.IndexByte(data, '\n')
		raw := data[:i+1]
		data = data[i+1:]
		l, err := parseIndexLine(raw)
		if err != nil {
			return nil, &IndexError{n, err}
		}
		if len(lines) > 0 && compareLines(lines[len(lines)-1], l) > 0 {
			return nil, &IndexError{n, errors.New("out of order")}
		}
		lines = append(lines, l)
	}
	return lines, nil
}

func parseIndexLine(raw []byte) (IndexLine, error) {
	s := string(raw)
	var vals []string
	rest, ok := strings.CutPrefix(s, "{")
	for i, k := range indexKeys {
		sep := ","
		if i == 0 {
			sep = ""
		}
		if rest, ok = strings.CutPrefix(rest, sep+`"`+k+`":"`); !ok {
			return IndexLine{}, fmt.Errorf("not the template: expected key %q", k)
		}
		j := strings.IndexByte(rest, '"')
		if j < 0 {
			return IndexLine{}, errors.New("not the template")
		}
		vals = append(vals, rest[:j])
		rest = rest[j+1:]
	}
	if rest != "}\n" {
		return IndexLine{}, errors.New("not the template: trailing data")
	}
	l := IndexLine{vals[0], vals[1], vals[2], vals[3], vals[4], vals[5], vals[6]}
	if err := l.check(); err != nil {
		return IndexLine{}, err
	}
	if !bytes.Equal(l.Line(), raw) {
		return IndexLine{}, errors.New("not the template") // unreachable
	}
	return l, nil
}

func (l IndexLine) check() error {
	switch l.Issuer {
	case "G2", "G3", none:
	default:
		return fmt.Errorf("issuer %q: want G2, G3 or -", l.Issuer)
	}
	if l.CRLNumber != none && !isDecimal(l.CRLNumber) {
		return fmt.Errorf("crl_number %q: want a decimal number without leading zeros, or -", l.CRLNumber)
	}
	var this time.Time
	for _, f := range []struct{ name, v string }{{"this_update", l.ThisUpdate}, {"next_update", l.NextUpdate}} {
		if f.v == none {
			continue
		}
		t, err := time.Parse(timeFormat, f.v)
		if err != nil || t.Format(timeFormat) != f.v {
			return fmt.Errorf("%s %q: want YYYY-MM-DDTHH:MM:SSZ or -", f.name, f.v)
		}
		if f.name == "this_update" {
			this = t
		}
	}
	switch {
	case l.ThisUpdate == none && l.CRLDate != none:
		return fmt.Errorf("crl_date %q without this_update", l.CRLDate)
	case l.ThisUpdate != none && l.CRLDate != (&CRL{ThisUpdate: this}).Date():
		return fmt.Errorf("crl_date %q is not the date of this_update in Taiwan", l.CRLDate)
	}
	if !isHex64(l.SHA256) {
		return fmt.Errorf("sha256 %q: want 64 lowercase hex digits", l.SHA256)
	}
	if l.Usable() {
		if !isHex64(l.Root) {
			return fmt.Errorf("root %q: want 64 lowercase hex digits, or - and a reason", l.Root)
		}
		if l.Issuer == none || l.CRLNumber == none || l.ThisUpdate == none {
			return errors.New("a root without an issuer, a crl_number or a this_update")
		}
	} else if r := l.Reason(); r == "" || strings.Trim(r, "abcdefghijklmnopqrstuvwxyz0123456789_") != "" {
		return fmt.Errorf("root %q: the reason is not lowercase letters, digits and _", l.Root)
	}
	return nil
}

func isDecimal(s string) bool {
	return s != "" && strings.Trim(s, "0123456789") == "" && (s == "0" || s[0] != '0')
}

func isHex64(s string) bool {
	return len(s) == 64 && strings.Trim(s, "0123456789abcdef") == ""
}

// Archive answers which usable CRLs have a given root: the CRLArchive of
// roster/ (check 3 of spec/roster-rules.md), with dates as strings so that
// this package imports nothing of the repository.
type Archive struct {
	dates map[[2]string][]string // (issuer, root) → CRL dates
}

// NewArchive returns the archive of the usable lines of an index.
func NewArchive(lines []IndexLine) *Archive {
	a := &Archive{dates: map[[2]string][]string{}}
	for _, l := range lines {
		if l.Usable() {
			k := [2]string{l.Issuer, l.Root}
			a.dates[k] = append(a.dates[k], l.CRLDate)
		}
	}
	return a
}

// CRLDates returns the CRL date (YYYY-MM-DD) of every usable CRL of the
// issuer whose root is root, in the order of the index; none if there is
// none. A date appears once per CRL.
func (a *Archive) CRLDates(issuer, root string) ([]string, error) {
	return slices.Clone(a.dates[[2]string{issuer, root}]), nil
}

// ReadArchiveIndex reads the index of the archive directory dir and checks
// each line as ParseIndex does, trusting it for the roots. It does not read
// the CRL files.
func ReadArchiveIndex(dir string) (*Archive, error) {
	lines, err := readIndexFile(dir)
	if err != nil {
		return nil, err
	}
	return NewArchive(lines), nil
}

func readIndexFile(dir string) ([]IndexLine, error) {
	data, err := os.ReadFile(filepath.Join(dir, IndexFileName))
	if err != nil {
		return nil, err
	}
	return ParseIndex(data)
}

// IndexMismatch is an index that differs from the one its archive gives.
// Index is the line of the index and Files the line the files give, both
// without LF; one of them is "" when the other has no counterpart with the
// same SHA-256.
type IndexMismatch struct {
	Index, Files string
}

func (e *IndexMismatch) Error() string {
	switch {
	case e.Index == "":
		return "crl: the archive has a file the index does not list: " + e.Files
	case e.Files == "":
		return "crl: the index lists a file the archive does not have: " + e.Index
	}
	return fmt.Sprintf("crl: the index differs from the files:\n  index: %s\n  files: %s", e.Index, e.Files)
}

// RebuildArchive reads the archive directory dir in full: it checks the
// index as ParseIndex does, rebuilds it from the files under keys (checking
// each signature and building each tree), and requires the two to have the
// same lines. The first difference, in the order of the index and then of
// the files, is an *IndexMismatch.
func RebuildArchive(dir string, keys []NamedKey, progress func(name string)) (*Archive, error) {
	index, err := readIndexFile(dir)
	if err != nil {
		return nil, err
	}
	got, err := BuildIndex(dir, keys, progress)
	if err != nil {
		return nil, err
	}
	if err := compareIndexes(index, got); err != nil {
		return nil, err
	}
	return NewArchive(got), nil
}

func compareIndexes(index, files []IndexLine) error {
	text := func(l IndexLine) string { return strings.TrimSuffix(string(l.Line()), "\n") }
	count := map[string]int{} // lines of the index minus lines of the files
	for _, l := range index {
		count[text(l)]++
	}
	for _, l := range files {
		count[text(l)]--
	}
	// The other side's unmatched line with the same SHA-256, if any.
	match := func(sha string, from []IndexLine, sign int) string {
		for _, l := range from {
			if l.SHA256 == sha && count[text(l)]*sign > 0 {
				return text(l)
			}
		}
		return ""
	}
	for _, l := range index {
		if count[text(l)] > 0 {
			return &IndexMismatch{Index: text(l), Files: match(l.SHA256, files, -1)}
		}
	}
	for _, l := range files {
		if count[text(l)] < 0 {
			return &IndexMismatch{Files: text(l)}
		}
	}
	return nil
}
