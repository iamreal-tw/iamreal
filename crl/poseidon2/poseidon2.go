// Package poseidon2 is Barretenberg's Poseidon2 hash over the BN254 scalar
// field, as defined in spec/scoped-id.md ("Poseidon2"): the permutation of
// width 4 with x^5, 8 full and 56 partial rounds, and the one-permutation
// sponge that puts the input length in the last state element.
//
// The round constants are in constants.go, generated from
// spec/vectors/poseidon2-constants.json (go generate). Field arithmetic is
// gnark-crypto's fr; only its field elements are used, not its Poseidon2.
package poseidon2

//go:generate go run gen_constants.go

import (
	"fmt"
	"math/big"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
)

// Modulus is the BN254 scalar field modulus p.
var Modulus = fr.Modulus()

var (
	internalD [4]fr.Element
	firstFull [4][4]fr.Element
	partial   [56]fr.Element
	lastFull  [4][4]fr.Element
)

func mustElement(s string) fr.Element {
	x, ok := new(big.Int).SetString(s, 0)
	if !ok || x.Sign() < 0 || x.Cmp(Modulus) >= 0 {
		panic("poseidon2: bad constant " + s)
	}
	var e fr.Element
	e.SetBigInt(x)
	return e
}

func init() {
	for i := range 4 {
		internalD[i] = mustElement(internalDHex[i])
		for r := range 4 {
			firstFull[r][i] = mustElement(firstFullHex[r][i])
			lastFull[r][i] = mustElement(lastFullHex[r][i])
		}
	}
	for r := range partial {
		partial[r] = mustElement(partialHex[r])
	}
}

// sbox sets x to (x + c)^5.
func sbox(x, c *fr.Element) {
	var x2, x4 fr.Element
	x.Add(x, c)
	x2.Square(x)
	x4.Square(&x2)
	x.Mul(x, &x4)
}

// external multiplies s by M_E = [[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]],
// in the steps Barretenberg uses (matrix_multiplication_4x4).
func external(s *[4]fr.Element) {
	var t0, t1, t2, t3, t4, t5 fr.Element
	t0.Add(&s[0], &s[1]) // s0 + s1
	t1.Add(&s[2], &s[3]) // s2 + s3
	t2.Double(&s[1])     //
	t2.Add(&t2, &t1)     // 2 s1 + s2 + s3
	t3.Double(&s[3])     //
	t3.Add(&t3, &t0)     // s0 + s1 + 2 s3
	t4.Double(&t1)       //
	t4.Double(&t4)       //
	t4.Add(&t4, &t3)     // s0 + s1 + 4 s2 + 6 s3
	t5.Double(&t0)       //
	t5.Double(&t5)       //
	t5.Add(&t5, &t2)     // 4 s0 + 6 s1 + s2 + s3
	s[0].Add(&t3, &t5)   // 5 s0 + 7 s1 + s2 + 3 s3
	s[2].Add(&t2, &t4)   // s0 + 3 s1 + 5 s2 + 7 s3
	s[1], s[3] = t5, t4
}

// internal multiplies s by M_I: s_i = s_i * d_i + (s_0 + s_1 + s_2 + s_3).
func internal(s *[4]fr.Element) {
	var sum fr.Element
	sum.Add(&s[0], &s[1])
	sum.Add(&sum, &s[2])
	sum.Add(&sum, &s[3])
	for i := range 4 {
		s[i].Mul(&s[i], &internalD[i])
		s[i].Add(&s[i], &sum)
	}
}

// Permute applies the Poseidon2 permutation to s in place.
func Permute(s *[4]fr.Element) {
	external(s)
	for r := range 4 {
		for i := range 4 {
			sbox(&s[i], &firstFull[r][i])
		}
		external(s)
	}
	for r := range partial {
		sbox(&s[0], &partial[r])
		internal(s)
	}
	for r := range 4 {
		for i := range 4 {
			sbox(&s[i], &lastFull[r][i])
		}
		external(s)
	}
}

// The last state element before the permutation: n · 2^64.
var length2, length3 fr.Element

func init() {
	length2.SetBigInt(new(big.Int).Lsh(big.NewInt(2), 64))
	length3.SetBigInt(new(big.Int).Lsh(big.NewInt(3), 64))
}

// Hash2 returns Poseidon2(a, b).
func Hash2(a, b *fr.Element) fr.Element {
	s := [4]fr.Element{*a, *b, {}, length2}
	Permute(&s)
	return s[0]
}

// Hash3 returns Poseidon2(a, b, c).
func Hash3(a, b, c *fr.Element) fr.Element {
	s := [4]fr.Element{*a, *b, *c, length3}
	Permute(&s)
	return s[0]
}

// Element returns x as a field element. x must be below the modulus.
func Element(x *big.Int) (fr.Element, error) {
	var e fr.Element
	if x.Sign() < 0 || x.Cmp(Modulus) >= 0 {
		return e, fmt.Errorf("poseidon2: %#x is not a field element", x)
	}
	e.SetBigInt(x)
	return e, nil
}

// Hash returns Poseidon2(xs...) for 2 or 3 field elements given as integers.
func Hash(xs ...*big.Int) (*big.Int, error) {
	es := make([]fr.Element, len(xs))
	for i, x := range xs {
		e, err := Element(x)
		if err != nil {
			return nil, err
		}
		es[i] = e
	}
	var h fr.Element
	switch len(xs) {
	case 2:
		h = Hash2(&es[0], &es[1])
	case 3:
		h = Hash3(&es[0], &es[1], &es[2])
	default:
		return nil, fmt.Errorf("poseidon2: %d inputs, want 2 or 3", len(xs))
	}
	return h.BigInt(new(big.Int)), nil
}

// Permutation returns the Poseidon2 permutation of in, given as integers.
func Permutation(in [4]*big.Int) ([4]*big.Int, error) {
	var s [4]fr.Element
	for i, x := range in {
		e, err := Element(x)
		if err != nil {
			return [4]*big.Int{}, err
		}
		s[i] = e
	}
	Permute(&s)
	var out [4]*big.Int
	for i := range s {
		out[i] = s[i].BigInt(new(big.Int))
	}
	return out, nil
}
