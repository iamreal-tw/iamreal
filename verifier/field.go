package verifier

import (
	"encoding/hex"
	"errors"
	"math/big"
)

// FieldModulus is p, the modulus of the BN254 scalar field (spec/scoped-id.md).
// Every public input of a proof is an integer below p.
var FieldModulus, _ = new(big.Int).SetString("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001", 16)

// Field is one public input: a 32-byte big-endian integer, the form bb reads
// (spec/proof-verification.md, "Encoding"). Nothing about the type keeps it
// below p; CheckField does.
type Field [32]byte

// BigInt returns f as an integer.
func (f Field) BigInt() *big.Int { return new(big.Int).SetBytes(f[:]) }

// Hex returns f as 64 lowercase hex digits, big-endian.
func (f Field) Hex() string { return hex.EncodeToString(f[:]) }

// FieldFromBigInt writes x, which must be below 2^256 and not negative, as a Field.
func FieldFromBigInt(x *big.Int) (Field, error) {
	var f Field
	if x.Sign() < 0 || x.BitLen() > 256 {
		return f, errors.New("not a 256-bit unsigned integer")
	}
	x.FillBytes(f[:])
	return f, nil
}

// CheckField reports whether f is below p.
func CheckField(f Field) error {
	if f.BigInt().Cmp(FieldModulus) >= 0 {
		return errors.New("not below the field modulus")
	}
	return nil
}

// ParseFieldHex reads 64 lowercase hex digits as a big-endian integer below
// p: the form of `smt_root` in a record (spec/record.md).
func ParseFieldHex(s string) (Field, error) {
	var f Field
	if !isLowerHex(s, 64) {
		return f, errors.New("not 64 lowercase hex digits")
	}
	hex.Decode(f[:], []byte(s))
	if err := CheckField(f); err != nil {
		return f, err
	}
	return f, nil
}

// pack31 packs 31 bytes into one field element, b[0] least significant
// (spec/scope.md, "Packing"). The result is below 2^248, so below p.
func pack31(b []byte) Field {
	var f Field
	for i := 0; i < 31 && i < len(b); i++ {
		f[31-i] = b[i]
	}
	return f
}

func isLowerHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f') {
			return false
		}
	}
	return true
}
