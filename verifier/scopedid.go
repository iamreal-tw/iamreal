package verifier

import (
	"fmt"
	"strings"
)

// ScopedIDLength is the length of the text form of a scoped ID.
const ScopedIDLength = 52

// ShortIDLength is the length of a short ID.
const ShortIDLength = 6

// ScopedIDText writes a scoped ID in its text form: the 32 little-endian
// bytes of the field element in base32 (spec/scoped-id.md, "Text form").
func ScopedIDText(f Field) string {
	return EncodeBase32(reverse(f[:]))
}

// ParseScopedID reads the text form of a scoped ID strictly: 52 characters of
// the alphabet, uppercase, zero padding bits, a value below p. It returns the
// field element (the public input nullifier).
func ParseScopedID(s string) (Field, error) {
	var f Field
	le, err := decodeBase32(s, 32)
	if err != nil {
		return f, fmt.Errorf("scoped_id: %w", err)
	}
	copy(f[:], reverse(le))
	if err := CheckField(f); err != nil {
		return f, fmt.Errorf("scoped_id: %w", err)
	}
	return f, nil
}

// ShortID returns the first 6 characters of the text form.
func ShortID(scopedIDText string) string {
	if len(scopedIDText) < ShortIDLength {
		return scopedIDText
	}
	return scopedIDText[:ShortIDLength]
}

// ReadShortIDInURL reads a short ID as typed in a URL: case-insensitively,
// with O read as 0 and I and L as 1. After this mapping it must be exactly 6
// characters of the alphabet; ok is false otherwise. This leniency is for
// URLs only, never for records.
func ReadShortIDInURL(typed string) (shortID string, ok bool) {
	if len(typed) != ShortIDLength {
		return "", false
	}
	var b strings.Builder
	for i := 0; i < len(typed); i++ {
		c := typed[i]
		if 'a' <= c && c <= 'z' {
			c -= 'a' - 'A'
		}
		switch c {
		case 'O':
			c = '0'
		case 'I', 'L':
			c = '1'
		}
		if strings.IndexByte(Alphabet, c) < 0 {
			return "", false
		}
		b.WriteByte(c)
	}
	return b.String(), true
}

func reverse(b []byte) []byte {
	r := make([]byte, len(b))
	for i := range b {
		r[len(b)-1-i] = b[i]
	}
	return r
}
