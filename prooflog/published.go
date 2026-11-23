package prooflog

// The proof log fingerprint and the published proof log (spec/record.md, "Record
// hash and the proof log fingerprint" and "The published proof log").

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/iamreal-tw/iamreal/verifier"
)

// FingerprintVersion is the version string of the proof log fingerprint.
const FingerprintVersion = "iamreal-fingerprint-v1"

// EmptyFingerprint is the proof log fingerprint of the empty proof log.
var EmptyFingerprint = strings.Repeat("0", 64)

// NextFingerprint returns the proof log fingerprint once a record whose record
// hash is recordHash is added to a proof log whose fingerprint is fingerprint.
// Both are 64 lowercase hex digits.
func NextFingerprint(fingerprint, recordHash string) string {
	sum := sha256.Sum256([]byte(FingerprintVersion + "\n" + fingerprint + "\n" + recordHash))
	return hex.EncodeToString(sum[:])
}

// Fingerprint returns the proof log fingerprint of records, which are the
// proof log from seq 1, in order.
func Fingerprint(records []*verifier.Record) string {
	fp := EmptyFingerprint
	for _, r := range records {
		fp = NextFingerprint(fp, r.Hash())
	}
	return fp
}

// LinesPerFile is the number of lines of a full file of the proof log
// directory.
const LinesPerFile = 1000

// ProofLogFileName is the name of the file of the log directory that
// follows the first before records: before in 16 digits, then ".jsonl".
func ProofLogFileName(before uint64) string { return fmt.Sprintf("%016d.jsonl", before) }

// HashListDir is the subdirectory of the log directory that holds the
// record hash lists.
const HashListDir = "hashes"

// HashListName is the path, in the log directory, of the record hash
// list of the log file ProofLogFileName(before).
func HashListName(before uint64) string { return fmt.Sprintf("%s/%016d.txt", HashListDir, before) }

// CardStateDir is the subdirectory of the log directory that holds the
// card state files, one per date (ADR-0027).
const CardStateDir = "card-state"

// CardStateName is the path, in the log directory, of the card state
// file of date d (spec/record-rules.md, "The card state file").
func CardStateName(d verifier.Date) string { return CardStateDir + "/" + d.String() + ".jsonl" }

// File is one file of the published proof log: its path in the proof log
// directory, with "/" between directories, and its bytes.
type File struct {
	Name string
	Data []byte
}

// DirectoryPart is one log file of the published proof log and its record
// hash list.
type DirectoryPart struct {
	ProofLogFile File
	HashList     File
}

// DirectoryFiles returns the log files and the record hash lists of the
// published proof log of records, which are the proof log from seq 1, in order:
// one part per log file. The fingerprint file is not among them: its
// lines depend on the days the proof log was published.
func DirectoryFiles(records []*verifier.Record) []DirectoryPart {
	var out []DirectoryPart
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
		out = append(out, DirectoryPart{
			ProofLogFile: File{ProofLogFileName(uint64(before)), file},
			HashList:     File{HashListName(uint64(before)), list},
		})
	}
	return out
}
