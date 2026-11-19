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

// Record is one record of a roster (spec/record.md, "Fields"), its values
// written exactly as in its line.
type Record struct {
	Seq         uint64
	ScopeString string
	ScopedID    string
	// Accounts is the whole list of accounts the card declares once the
	// record is applied, in the order of the line. An empty list is written
	// `[]`; nil and an empty slice are the same list.
	Accounts  []Account
	Challenge string
	Issuer    string
	SMTRoot   string
	Circuit   string
	Proof     string
}

// Line writes the record from the template, followed by LF. It does not check
// the values.
func (r *Record) Line() []byte {
	var b bytes.Buffer
	b.Grow(800 + len(r.Proof))
	b.WriteString(`{"seq":`)
	b.WriteString(strconv.FormatUint(r.Seq, 10))
	str := func(key, value string) {
		b.WriteString(`,"`)
		b.WriteString(key)
		b.WriteString(`":"`)
		b.WriteString(value)
		b.WriteByte('"')
	}
	str("scope_string", r.ScopeString)
	str("scoped_id", r.ScopedID)
	b.WriteString(`,"accounts":`)
	b.WriteString(AccountsText(r.Accounts))
	str("challenge", r.Challenge)
	str("issuer", r.Issuer)
	str("smt_root", r.SMTRoot)
	str("circuit", r.Circuit)
	str("proof", r.Proof)
	b.WriteString("}\n")
	return b.Bytes()
}

// HashPreimage returns the bytes hashed into the record hash: the version
// tag and the nine fields as written in the line, separated by LF.
func (r *Record) HashPreimage() []byte {
	return []byte(strings.Join([]string{
		RecordVersion, strconv.FormatUint(r.Seq, 10), r.ScopeString, r.ScopedID,
		AccountsText(r.Accounts), r.Challenge, r.Issuer, r.SMTRoot, r.Circuit, r.Proof,
	}, "\n"))
}

// Equal reports whether r and o have the same values. A nil and an empty
// account list are the same list.
func (r *Record) Equal(o *Record) bool {
	if len(r.Accounts) != len(o.Accounts) {
		return false
	}
	for i := range r.Accounts {
		if r.Accounts[i] != o.Accounts[i] {
			return false
		}
	}
	return r.Seq == o.Seq && r.ScopeString == o.ScopeString && r.ScopedID == o.ScopedID &&
		r.Challenge == o.Challenge && r.Issuer == o.Issuer && r.SMTRoot == o.SMTRoot &&
		r.Circuit == o.Circuit && r.Proof == o.Proof
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
// "Fields"), in a roster whose accepted scopes and platforms are those of
// roster.
func (r *Record) CheckValues(roster Roster) error {
	if r.Seq < 1 || r.Seq > MaxSeq {
		return errors.New("seq: not from 1 to 2^53 − 1")
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
	if err := CheckAccounts(roster, r.Accounts); err != nil {
		return err
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
	members, err := parseRecordObject(line[:len(line)-1])
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
		"scope_string": &r.ScopeString, "scoped_id": &r.ScopedID,
		"challenge": &r.Challenge, "issuer": &r.Issuer, "smt_root": &r.SMTRoot,
		"circuit": &r.Circuit, "proof": &r.Proof,
	}
	seen := map[string]bool{}
	for _, m := range members {
		if seen[m.key] {
			continue // a duplicate key; the byte comparison rejects the line
		}
		seen[m.key] = true
		switch m.key {
		case "seq":
			if m.value.isString || m.value.isList || !digits(m.value.text) || (len(m.value.text) > 1 && m.value.text[0] == '0') || len(m.value.text) > 16 {
				return nil, errors.New("seq: not a decimal integer without leading zeros")
			}
			n, _ := strconv.ParseUint(m.value.text, 10, 64)
			r.Seq = n
			continue
		case "accounts":
			accounts, err := accountsFromList(m.value)
			if err != nil {
				return nil, err
			}
			r.Accounts = accounts
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
	if len(seen) != 9 || !seen["seq"] || !seen["accounts"] {
		return nil, errors.New("missing key")
	}
	return r, nil
}

// accountsFromList reads the accounts of the list v in the order written.
// Within an account the first of two equal keys is taken; the byte
// comparison of the rewritten line rejects the duplicate, like any other
// spelling outside the template.
func accountsFromList(v jsonValue) ([]Account, error) {
	if !v.isList {
		return nil, errors.New("accounts: not a list")
	}
	accounts := make([]Account, 0, len(v.list))
	for _, members := range v.list {
		var a Account
		seen := map[string]bool{}
		for _, m := range members {
			if seen[m.key] {
				continue
			}
			seen[m.key] = true
			var p *string
			switch m.key {
			case "platform":
				p = &a.Platform
			case "username":
				p = &a.Username
			default:
				return nil, fmt.Errorf("accounts: unknown key %q", m.key)
			}
			if !m.value.isString {
				return nil, fmt.Errorf("accounts: %s: not a string", m.key)
			}
			*p = m.value.text
		}
		if !seen["platform"] || !seen["username"] {
			return nil, errors.New("accounts: an account without platform or username")
		}
		accounts = append(accounts, a)
	}
	return accounts, nil
}
