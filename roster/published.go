package roster

// The roster fingerprint and the published roster (spec/record.md, "Record
// hash and the roster fingerprint" and "The published roster").

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/iamreal-tw/iamreal/verifier"
)

// FingerprintVersion is the version string of the roster fingerprint.
const FingerprintVersion = "iamreal-fingerprint-v1"

// EmptyFingerprint is the roster fingerprint of the empty roster.
var EmptyFingerprint = strings.Repeat("0", 64)

// NextFingerprint returns the roster fingerprint once a record whose record
// hash is recordHash is added to a roster whose fingerprint is fingerprint.
// Both are 64 lowercase hex digits.
func NextFingerprint(fingerprint, recordHash string) string {
	sum := sha256.Sum256([]byte(FingerprintVersion + "\n" + fingerprint + "\n" + recordHash))
	return hex.EncodeToString(sum[:])
}

// Fingerprint returns the roster fingerprint of records, which are the
// roster from seq 1, in order.
func Fingerprint(records []*verifier.Record) string {
	fp := EmptyFingerprint
	for _, r := range records {
		fp = NextFingerprint(fp, r.Hash())
	}
	return fp
}

// LinesPerFile is the number of lines of a full file of the roster
// directory.
const LinesPerFile = 1000

// RosterFileName is the name of the file of the roster directory that
// follows the first before records: before in 16 digits, then ".jsonl".
func RosterFileName(before uint64) string { return fmt.Sprintf("%016d.jsonl", before) }

// HashListName is the path, in the roster directory, of the record hash
// list of the roster file RosterFileName(before).
func HashListName(before uint64) string { return fmt.Sprintf("hashes/%016d.txt", before) }

// File is one file of the published roster: its path in the roster
// directory, with "/" between directories, and its bytes.
type File struct {
	Name string
	Data []byte
}

// DirectoryFiles returns the roster files and the record hash lists of the
// published roster of records, which are the roster from seq 1, in order:
// each roster file followed by its list. The fingerprint file is not among
// them: its lines depend on the days the roster was published.
func DirectoryFiles(records []*verifier.Record) []File {
	var out []File
	fp := EmptyFingerprint
	for before := 0; before < len(records); before += LinesPerFile {
		end := min(before+LinesPerFile, len(records))
		var file []byte
		list := []byte(fp + "\n")
		for _, r := range records[before:end] {
			h := r.Hash()
			file = append(file, r.Line()...)
			list = append(list, h+"\n"...)
			fp = NextFingerprint(fp, h)
		}
		out = append(out,
			File{RosterFileName(uint64(before)), file},
			File{HashListName(uint64(before)), list})
	}
	return out
}
