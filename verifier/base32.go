package verifier

import (
	"errors"
	"strings"
)

// Alphabet is the Crockford base32 alphabet of spec/README.md.
const Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// EncodeBase32 writes data in Crockford base32 as spec/README.md defines it:
// uppercase, no padding, no check symbol. The bytes are read as a big-endian
// bit string cut into 5-bit groups from the most significant bit; a final
// short group is padded with zero bits on the right.
func EncodeBase32(data []byte) string {
	var b strings.Builder
	b.Grow((len(data)*8 + 4) / 5)
	var acc uint32
	var bits uint
	for _, c := range data {
		acc = acc<<8 | uint32(c)
		bits += 8
		for bits >= 5 {
			bits -= 5
			b.WriteByte(Alphabet[(acc>>bits)&31])
		}
	}
	if bits > 0 {
		b.WriteByte(Alphabet[(acc<<(5-bits))&31])
	}
	return b.String()
}

// decodeBase32 decodes s, which must be the one spelling of exactly n bytes:
// the right length, only characters of the alphabet in uppercase, and zero
// padding bits. So decoding and encoding again gives s.
func decodeBase32(s string, n int) ([]byte, error) {
	if len(s) != (n*8+4)/5 {
		return nil, errors.New("wrong length")
	}
	out := make([]byte, 0, n)
	var acc uint32
	var bits uint
	for i := 0; i < len(s); i++ {
		v := strings.IndexByte(Alphabet, s[i])
		if v < 0 {
			return nil, errors.New("character not in the alphabet")
		}
		acc = acc<<5 | uint32(v)
		bits += 5
		if bits >= 8 {
			bits -= 8
			out = append(out, byte(acc>>bits))
		}
	}
	if acc&(1<<bits-1) != 0 {
		return nil, errors.New("padding bits are not zero")
	}
	return out, nil
}
