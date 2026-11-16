package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/iamreal-tw/iamreal/crl"
	"github.com/iamreal-tw/iamreal/verifier"
)

// crlIndex is the index of the CRL mirror (spec/revocation-tree.md,
// "Archive index") as the server last read it from disk. The mirror writes
// the index; the server reads it again before each card proof it checks, so
// a CRL the mirror just stored counts at once.
//
// It answers two questions:
//   - for the roster rules (check 3), the CRL dates of a root: CRLDates;
//   - for the server's own rule, whether a root is that of one of the two
//     newest CRLs of its issuer and whether the newest is fresh: checkRoot.
type crlIndex struct {
	dir     string
	lines   []crl.IndexLine
	archive *crl.Archive
}

func newCRLIndex(dir string) *crlIndex {
	return &crlIndex{dir: dir, archive: crl.NewArchive(nil)}
}

// reload reads index.jsonl again. A missing index is an empty one: the
// mirror has not stored any CRL yet. An index that is not as the spec
// writes it is an error.
func (x *crlIndex) reload() error {
	data, err := os.ReadFile(filepath.Join(x.dir, crl.IndexFileName))
	if errors.Is(err, fs.ErrNotExist) {
		x.lines, x.archive = nil, crl.NewArchive(nil)
		return nil
	}
	if err != nil {
		return err
	}
	lines, err := crl.ParseIndex(data)
	if err != nil {
		return err
	}
	x.lines, x.archive = lines, crl.NewArchive(lines)
	return nil
}

// CRLDates is roster.CRLArchive: the CRL dates of the usable CRLs of issuer
// whose root is smtRoot.
func (x *crlIndex) CRLDates(issuer, smtRoot string) ([]verifier.Date, error) {
	ds, err := x.archive.CRLDates(issuer, smtRoot)
	if err != nil {
		return nil, err
	}
	out := make([]verifier.Date, len(ds))
	for i, d := range ds {
		if out[i], err = verifier.ParseDate(d); err != nil {
			return nil, fmt.Errorf("CRL index: date %q: %v", d, err)
		}
	}
	return out, nil
}

// The outcomes of checkRoot.
const (
	rootOK       = ""
	rootNotNewer = "root"      // not the root of one of the two newest CRLs
	rootStale    = "crl_stale" // the newest CRL is too old, or there is none
)

// checkRoot is the server's rule on smt_root (docs/api/card-proof.md,
// spec/revocation-tree.md "Who checks what"): accept only the roots of the
// two newest CRLs of issuer in the mirror, and none if the newest is more
// than crlMaxAgeDays days old on today (a date in Taiwan).
//
// "Newest" is by CRL number, as devices choose their CRL; only usable CRLs
// count. The index is sorted by issuer, then CRL number, so the newest of an
// issuer are its last usable lines.
func (x *crlIndex) checkRoot(issuer, smtRoot string, today verifier.Date) (string, error) {
	var usable []crl.IndexLine
	for _, l := range x.lines {
		if l.Issuer == issuer && l.Usable() {
			usable = append(usable, l)
		}
	}
	if len(usable) == 0 {
		return rootStale, nil
	}
	newest := usable[len(usable)-1]
	newestDate, err := verifier.ParseDate(newest.CRLDate)
	if err != nil {
		return "", fmt.Errorf("CRL index: date %q: %v", newest.CRLDate, err)
	}
	if today > newestDate.AddDays(crlMaxAgeDays) {
		return rootStale, nil
	}
	for _, l := range usable[max(0, len(usable)-2):] {
		if l.Root == smtRoot {
			return rootOK, nil
		}
	}
	return rootNotNewer, nil
}
