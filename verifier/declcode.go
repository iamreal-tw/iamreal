package verifier

import (
	"crypto/sha256"
	"strings"
)

// DeclarationVersion is the version tag of spec/declaration-code.md.
const DeclarationVersion = "iamreal-declaration-v1"

// Actions of a record.
const (
	Declare  = "declare"
	Withdraw = "withdraw"
)

// DeclarationPreimage returns the bytes hashed into the declaration code. The
// arguments are taken as they are; a record's values are checked when its
// line is.
func DeclarationPreimage(action, scopeString, username, challenge string) []byte {
	return []byte(strings.Join([]string{DeclarationVersion, action, scopeString, username, challenge}, "\n"))
}

// DeclarationCode returns the 31-byte declaration code: "D" followed by the
// first 30 characters of the base32 of SHA-256 of the preimage.
func DeclarationCode(action, scopeString, username, challenge string) string {
	sum := sha256.Sum256(DeclarationPreimage(action, scopeString, username, challenge))
	return "D" + EncodeBase32(sum[:])[:30]
}

// DeclarationCodePacked returns the public input declaration_code_packed.
func DeclarationCodePacked(code string) Field {
	return pack31([]byte(code))
}
