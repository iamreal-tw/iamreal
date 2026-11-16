package verifier

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// RecordVersion is the version tag of spec/record.md.
const RecordVersion = "iamreal-record-v1"

const (
	// ProofLength is the length of a proof in bytes.
	ProofLength = 14656
	// ProofTextLength is the length of a proof in a record: standard base64
	// with padding.
	ProofTextLength = 19544
	// MaxSeq is the largest `seq`, 2^53 − 1.
	MaxSeq = 1<<53 - 1
)

// GenesisPrev is `prev` of the record with `seq` 1, and the head of the empty
// roster.
var GenesisPrev = strings.Repeat("0", 64)

// Record is one record of a roster (spec/record.md, "Fields"), its values
// written exactly as in its line.
type Record struct {
	Seq         uint64
	Prev        string
	ScopeString string
	ScopedID    string
	Action      string
	Username    string
	Challenge   string
	Issuer      string
	SMTRoot     string
	Circuit     string
	Proof       string
}

// Line writes the record from the template, followed by LF. It does not check
// the values.
func (r *Record) Line() []byte {
	var b bytes.Buffer
	b.Grow(600 + len(r.Proof))
	b.WriteString(`{"seq":`)
	b.WriteString(strconv.FormatUint(r.Seq, 10))
	for _, kv := range [][2]string{
		{"prev", r.Prev}, {"scope_string", r.ScopeString}, {"scoped_id", r.ScopedID},
		{"action", r.Action}, {"username", r.Username}, {"challenge", r.Challenge},
		{"issuer", r.Issuer}, {"smt_root", r.SMTRoot}, {"circuit", r.Circuit}, {"proof", r.Proof},
	} {
		b.WriteString(`,"`)
		b.WriteString(kv[0])
		b.WriteString(`":"`)
		b.WriteString(kv[1])
		b.WriteByte('"')
	}
	b.WriteString("}\n")
	return b.Bytes()
}

// HashPreimage returns the bytes hashed into the record hash.
func (r *Record) HashPreimage() []byte {
	return []byte(strings.Join([]string{
		RecordVersion, strconv.FormatUint(r.Seq, 10), r.Prev, r.ScopeString, r.ScopedID,
		r.Action, r.Username, r.Challenge, r.Issuer, r.SMTRoot, r.Circuit, r.Proof,
	}, "\n"))
}

// Hash returns the record hash: SHA-256 of the preimage, 64 lowercase hex digits.
func (r *Record) Hash() string {
	sum := sha256.Sum256(r.HashPreimage())
	return hex.EncodeToString(sum[:])
}

// Date returns the date of the record: the date in its challenge.
func (r *Record) Date() (Date, error) { return ParseChallenge(r.Challenge) }

// ProofBytes decodes the proof, which must be the one base64 spelling of
// exactly ProofLength bytes.
func (r *Record) ProofBytes() ([]byte, error) { return decodeProof(r.Proof) }

func decodeProof(s string) ([]byte, error) {
	if len(s) != ProofTextLength {
		return nil, fmt.Errorf("proof: %d characters, not %d", len(s), ProofTextLength)
	}
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("proof: %w", err)
	}
	if len(b) != ProofLength || base64.StdEncoding.EncodeToString(b) != s {
		return nil, errors.New("proof: not the one base64 spelling of 14,656 bytes")
	}
	return b, nil
}

// CheckValues checks every value against its format (spec/record.md,
// "Fields"), in a roster whose accepted scopes are those of roster.
func (r *Record) CheckValues(roster Roster) error {
	if r.Seq < 1 || r.Seq > MaxSeq {
		return errors.New("seq: not from 1 to 2^53 − 1")
	}
	if !isLowerHex(r.Prev, 64) {
		return errors.New("prev: not 64 lowercase hex digits")
	}
	scope, ok := LookupScope(roster, r.ScopeString)
	if !ok {
		return fmt.Errorf("scope_string: not an accepted scope of the %s roster", roster)
	}
	if scope.LastSeq != 0 && r.Seq > scope.LastSeq {
		return fmt.Errorf("scope_string: the scope accepts records up to seq %d", scope.LastSeq)
	}
	if _, err := ParseScopedID(r.ScopedID); err != nil {
		return err
	}
	if r.Action != Declare && r.Action != Withdraw {
		return errors.New("action: not declare or withdraw")
	}
	if !scope.ValidUsername(r.Username) {
		return errors.New("username: not in the format of the scope")
	}
	if _, err := ParseChallenge(r.Challenge); err != nil {
		return err
	}
	if !knownIssuerName(r.Issuer) {
		return errors.New("issuer: not G2 or G3")
	}
	if _, err := ParseFieldHex(r.SMTRoot); err != nil {
		return fmt.Errorf("smt_root: %w", err)
	}
	if !isLowerHex(r.Circuit, 64) {
		return errors.New("circuit: not 64 lowercase hex digits")
	}
	if _, err := decodeProof(r.Proof); err != nil {
		return err
	}
	return nil
}

func knownIssuerName(name string) bool {
	for _, is := range productionIssuers {
		if is.Name == name {
			return true
		}
	}
	return false
}

// ParseLine checks one line of a roster file (spec/record.md, "Lines and
// files"): line is its bytes up to and including its LF. It parses the line,
// checks every value, writes the line again from the template and compares
// bytes. An error means the line is malformed.
func ParseLine(line []byte, roster Roster) (*Record, error) {
	if len(line) == 0 || line[len(line)-1] != '\n' {
		return nil, errors.New("line does not end with LF")
	}
	if bytes.IndexByte(line, '\n') != len(line)-1 {
		return nil, errors.New("LF inside the line")
	}
	members, err := parseFlatObject(line[:len(line)-1])
	if err != nil {
		return nil, err
	}
	r, err := recordFromMembers(members)
	if err != nil {
		return nil, err
	}
	if err := r.CheckValues(roster); err != nil {
		return nil, err
	}
	if !bytes.Equal(r.Line(), line) {
		return nil, errors.New("not written exactly as the template")
	}
	return r, nil
}

func recordFromMembers(members []jsonMember) (*Record, error) {
	r := &Record{}
	strs := map[string]*string{
		"prev": &r.Prev, "scope_string": &r.ScopeString, "scoped_id": &r.ScopedID,
		"action": &r.Action, "username": &r.Username, "challenge": &r.Challenge,
		"issuer": &r.Issuer, "smt_root": &r.SMTRoot, "circuit": &r.Circuit, "proof": &r.Proof,
	}
	seen := map[string]bool{}
	for _, m := range members {
		if seen[m.key] {
			continue // a duplicate key; the byte comparison rejects the line
		}
		seen[m.key] = true
		if m.key == "seq" {
			if m.value.isString || !digits(m.value.text) || (len(m.value.text) > 1 && m.value.text[0] == '0') || len(m.value.text) > 16 {
				return nil, errors.New("seq: not a decimal integer without leading zeros")
			}
			n, _ := strconv.ParseUint(m.value.text, 10, 64)
			r.Seq = n
			continue
		}
		p, ok := strs[m.key]
		if !ok {
			return nil, fmt.Errorf("unknown key %q", m.key)
		}
		if !m.value.isString {
			return nil, fmt.Errorf("%s: not a string", m.key)
		}
		*p = m.value.text
	}
	if len(seen) != 11 || !seen["seq"] {
		return nil, errors.New("missing key")
	}
	return r, nil
}
