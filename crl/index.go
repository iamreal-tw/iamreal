package crl

import (
	"bytes"
	"crypto/rsa"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/iamreal-tw/iamreal/crl/poseidon2"
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
	return indexFile(der, keys, func(c *CRL, _ string, key *rsa.PublicKey) (*Tree, error) { return c.Tree(key) })
}

// An Indexer gives the index lines of the files of an archive, one after
// another, and reuses hashes between the trees of one issuer key
// (TreeBuilder). Each file is read, checked and hashed as IndexFile does
// it, and its line is IndexFile's line: what is reused is the result of the
// hash function, never a check. It keeps the hashes of the last usable CRL
// of each issuer key, in memory, for as long as it is used.
type Indexer struct {
	keys     []NamedKey
	builders map[string]*TreeBuilder
}

// NewIndexer returns an Indexer that tries keys in order, as IndexFile.
func NewIndexer(keys []NamedKey) *Indexer {
	return &Indexer{keys: keys, builders: map[string]*TreeBuilder{}}
}

// IndexFile returns the index line of one archive file.
func (x *Indexer) IndexFile(der []byte) IndexLine {
	return indexFile(der, x.keys, func(c *CRL, issuer string, key *rsa.PublicKey) (*Tree, error) {
		b := x.builders[issuer]
		if b == nil {
			b = new(TreeBuilder)
			x.builders[issuer] = b
		}
		return c.treeWith(b, key)
	})
}

// indexFile is IndexFile with the way a usable CRL's tree is built: tree is
// called with the CRL, the name of the key that signed it, and that key.
func indexFile(der []byte, keys []NamedKey, tree func(c *CRL, issuer string, key *rsa.PublicKey) (*Tree, error)) IndexLine {
	sum := sha256Hex(der)
	l := IndexLine{Issuer: none, CRLNumber: none, ThisUpdate: none, NextUpdate: none, CRLDate: none, SHA256: sum}
	c, err := Parse(der)
	if err != nil {
		l.Root = none + ReasonDER
		return l
	}
	l.ThisUpdate = c.ThisUpdate.Format(timeFormat)
	l.CRLDate = c.Date()
	if c.HasNextUpdate {
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
	t, err := tree(c, l.Issuer, key)
	if err != nil {
		var u *Unusable
		if !errors.As(err, &u) {
			panic(err) // Tree returns only *Unusable errors
		}
		l.Root = none + u.Code
		return l
	}
	l.Root = t.RootHex()
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

// treeWith is Tree with the tree built by b.
func (c *CRL) treeWith(b *TreeBuilder, issuerKey *rsa.PublicKey) (*Tree, error) {
	keys, err := c.Check(issuerKey)
	if err != nil {
		return nil, err
	}
	t, err := b.NewTree(keys)
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

// An ArchiveFile is one file of an archive, read when its turn comes: so
// that an archive that is not on disk (one downloaded file by file) is
// never held whole, on disk or in memory.
type ArchiveFile struct {
	Name string
	// Read returns the file's bytes; ErrLeftOut for a file that is not
	// part of the archive after all (it is not there); any other error
	// stops the rebuilding.
	Read func() ([]byte, error)
}

// ErrLeftOut is what ArchiveFile.Read returns for a file to leave out.
var ErrLeftOut = errors.New("crl: the file is left out of the archive")

// dirFiles returns the files of an archive directory, in the order of
// their names.
func dirFiles(dir string) ([]ArchiveFile, error) {
	names, err := archiveFiles(dir)
	if err != nil {
		return nil, err
	}
	files := make([]ArchiveFile, len(names))
	for i, name := range names {
		files[i] = ArchiveFile{Name: name, Read: func() ([]byte, error) { return os.ReadFile(filepath.Join(dir, name)) }}
	}
	return files, nil
}

// BuildIndex returns the index of the archive directory dir: one line per
// file, sorted (SortIndex). progress, if not nil, is called with each file
// name once the file is read, before its line is computed. The first CRL of an issuer key takes
// seconds, the later ones a fraction of one (Indexer).
func BuildIndex(dir string, keys []NamedKey, progress func(name string)) ([]IndexLine, error) {
	files, err := dirFiles(dir)
	if err != nil {
		return nil, err
	}
	return BuildIndexOf(files, keys, progress)
}

// BuildIndexOf is BuildIndex for files given one by one. Each is read,
// indexed and let go before the next is read. progress, if not nil, is
// called with the name of each file that was read, before it is indexed.
func BuildIndexOf(files []ArchiveFile, keys []NamedKey, progress func(name string)) ([]IndexLine, error) {
	x := NewIndexer(keys)
	lines := make([]IndexLine, 0, len(files))
	for _, f := range files {
		der, err := f.Read()
		if errors.Is(err, ErrLeftOut) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if progress != nil {
			progress(f.Name)
		}
		lines = append(lines, x.IndexFile(der))
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
// issuer, a CRL number and a thisUpdate, and a root below the BN254 scalar
// field modulus p. It cannot check that the roots are those of the files,
// the hashes or that the files exist; RebuildArchive does. The first
// problem is an *IndexError.
func ParseIndex(data []byte) ([]IndexLine, error) {
	lines, problems, whole := scanIndex(data)
	if whole != nil {
		return nil, whole
	}
	if len(problems) > 0 {
		return nil, problems[0].IndexError
	}
	return lines, nil
}

// indexProblem is a line of an index file that is not as the spec writes
// it. Raw is the line as read, without LF.
type indexProblem struct {
	*IndexError
	Raw string
}

// scanIndex reads an index file line by line, going on after a line that
// is not as the spec writes it. It returns the lines that are well formed
// (including those out of order, which are well formed by themselves), and
// a problem for every line that is not well formed or is out of order. A
// file that cannot be split into lines (it does not end in LF, or starts
// with a byte order mark) gives only whole.
func scanIndex(data []byte) (lines []IndexLine, problems []indexProblem, whole *IndexError) {
	if len(data) > 0 && data[len(data)-1] != '\n' {
		n := bytes.Count(data, []byte("\n")) + 1
		return nil, nil, &IndexError{n, errors.New("does not end in LF")}
	}
	if bytes.HasPrefix(data, []byte("\xef\xbb\xbf")) {
		return nil, nil, &IndexError{1, errors.New("starts with a byte order mark")}
	}
	for n := 1; len(data) > 0; n++ {
		i := bytes.IndexByte(data, '\n')
		raw := data[:i+1]
		data = data[i+1:]
		text := string(raw[:i])
		l, err := parseIndexLine(raw)
		if err != nil {
			problems = append(problems, indexProblem{&IndexError{n, err}, text})
			continue
		}
		if len(lines) > 0 && compareLines(lines[len(lines)-1], l) > 0 {
			problems = append(problems, indexProblem{&IndexError{n, errors.New("out of order")}, text})
		}
		lines = append(lines, l)
	}
	return lines, problems, nil
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
		if r, _ := new(big.Int).SetString(l.Root, 16); r.Cmp(poseidon2.Modulus) >= 0 {
			return fmt.Errorf("root %s: not below the BN254 scalar field modulus p", l.Root)
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
// prooflog/ (check 3 of spec/record-rules.md), with dates as strings so that
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

// IndexMismatch is one difference between the index of an archive and the
// index its files give. It is one of:
//
//   - the index as a whole: Problem says what is wrong with index.jsonl
//     (missing, or it cannot be split into lines), Line is 0, and Index and
//     Files are "";
//   - a line of the index that is not well formed or is out of order: Line
//     is its number (from 1), Problem says why, and Index is the line as
//     read, without LF;
//   - a line that differs: Index is the line of the index and Files the
//     line the files give, both without LF; one of them is "" when the
//     other has no counterpart with the same SHA-256.
type IndexMismatch struct {
	Index, Files string
	Line         int
	Problem      string
}

func (m IndexMismatch) String() string {
	switch {
	case m.Problem != "" && m.Line == 0:
		return IndexFileName + " " + m.Problem
	case m.Problem != "":
		return fmt.Sprintf("%s line %d is not as the spec writes it (%s): %s", IndexFileName, m.Line, m.Problem, m.Index)
	case m.Index == "":
		return "the archive has a file the index does not list: " + m.Files
	case m.Files == "":
		return "the index lists a file the archive does not have: " + m.Index
	}
	return fmt.Sprintf("the index differs from the files:\n  index: %s\n  files: %s", m.Index, m.Files)
}

// RebuildArchive reads the archive directory dir in full: it rebuilds the
// index from the files under keys (checking each signature and building
// each tree) and returns the archive of the rebuilt index, which is the one
// that counts (spec/revocation-tree.md, "Re-verifying with the index").
// Every difference between index.jsonl and the rebuilt index is returned
// with it, for the caller to report:
//
//   - index.jsonl is missing, or cannot be split into lines (it does not
//     end in LF, or starts with a byte order mark): one difference, and
//     nothing is compared;
//   - otherwise, first every line that is not as ParseIndex requires, in
//     order (a line out of order is still compared; any other is not);
//     then, in the order of the index and then of the files, every line of
//     the index whose file the archive does not have, every file the index
//     does not list, and every file whose line differs.
//
// Only a file that cannot be read is an error.
func RebuildArchive(dir string, keys []NamedKey, progress func(name string)) (*Archive, []IndexMismatch, error) {
	data, err := os.ReadFile(filepath.Join(dir, IndexFileName))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, nil, err
	}
	files, ferr := dirFiles(dir)
	if ferr != nil {
		return nil, nil, ferr
	}
	return RebuildArchiveOf(data, err == nil, files, keys, progress)
}

// RebuildArchiveOf is RebuildArchive for an archive given as the bytes of
// its index.jsonl (hasIndex false if it has none) and its files one by one
// (BuildIndexOf).
func RebuildArchiveOf(data []byte, hasIndex bool, files []ArchiveFile, keys []NamedKey, progress func(name string)) (*Archive, []IndexMismatch, error) {
	var diffs []IndexMismatch
	var index []IndexLine
	compare := true
	switch {
	case !hasIndex:
		diffs = append(diffs, IndexMismatch{Problem: "is missing"})
		compare = false
	default:
		lines, problems, whole := scanIndex(data)
		if whole != nil {
			diffs = append(diffs, IndexMismatch{Problem: "cannot be split into lines: " + whole.Err.Error()})
			compare = false
		}
		for _, p := range problems {
			diffs = append(diffs, IndexMismatch{Index: p.Raw, Line: p.Line, Problem: p.Err.Error()})
		}
		index = lines
	}
	got, err := BuildIndexOf(files, keys, progress)
	if err != nil {
		return nil, nil, err
	}
	if compare {
		diffs = append(diffs, compareIndexes(index, got)...)
	}
	return NewArchive(got), diffs, nil
}

// compareIndexes returns every difference between index and files, the
// lines of an index and the lines the files give. Lines are compared whole;
// an unmatched line of the index is paired with an unmatched line of the
// files that has the same SHA-256, if there is one.
func compareIndexes(index, files []IndexLine) []IndexMismatch {
	text := func(l IndexLine) string { return strings.TrimSuffix(string(l.Line()), "\n") }
	count := map[string]int{} // lines of the index minus lines of the files
	for _, l := range index {
		count[text(l)]++
	}
	for _, l := range files {
		count[text(l)]--
	}
	var onlyIndex, onlyFiles []IndexLine
	for _, l := range index {
		if t := text(l); count[t] > 0 {
			onlyIndex = append(onlyIndex, l)
			count[t]--
		}
	}
	for _, l := range files {
		if t := text(l); count[t] < 0 {
			onlyFiles = append(onlyFiles, l)
			count[t]++
		}
	}
	paired := make([]bool, len(onlyFiles))
	var out []IndexMismatch
	for _, l := range onlyIndex {
		m := IndexMismatch{Index: text(l)}
		for j, f := range onlyFiles {
			if !paired[j] && f.SHA256 == l.SHA256 {
				paired[j], m.Files = true, text(f)
				break
			}
		}
		out = append(out, m)
	}
	for j, f := range onlyFiles {
		if !paired[j] {
			out = append(out, IndexMismatch{Files: text(f)})
		}
	}
	return out
}
