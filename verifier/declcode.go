package verifier

import (
	"crypto/sha256"
	"strings"
)

// DeclarationVersion is the version tag of spec/declaration-code.md.
const DeclarationVersion = "iamreal-declaration-v1"

// DeclarationPreimage returns the bytes hashed into the declaration code:
// the version tag, the scope string, one line platform:username per account
// in the order of the list, and the challenge, separated by LF, without a
// trailing LF. The arguments are taken as they are; a record's values are
// checked when its line is.
func DeclarationPreimage(scopeString string, accounts []Account, challenge string) []byte {
	lines := make([]string, 0, len(accounts)+3)
	lines = append(lines, DeclarationVersion, scopeString)
	for _, a := range accounts {
		lines = append(lines, a.Platform+":"+a.Username)
	}
	lines = append(lines, challenge)
	return []byte(strings.Join(lines, "\n"))
}

// DeclarationCode returns the 31-byte declaration code: "D" followed by the
// first 30 characters of the base32 of SHA-256 of the preimage.
func DeclarationCode(scopeString string, accounts []Account, challenge string) string {
	sum := sha256.Sum256(DeclarationPreimage(scopeString, accounts, challenge))
	return "D" + EncodeBase32(sum[:])[:30]
}

// DeclarationCodePacked returns the public input declaration_code_packed.
func DeclarationCodePacked(code string) Field {
	return pack31([]byte(code))
}
