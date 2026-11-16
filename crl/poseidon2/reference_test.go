package poseidon2

// A second implementation of the same hash on math/big, slow and written to
// be read next to spec/scoped-id.md. The tests check that it and the field
// arithmetic of poseidon2.go agree with the vectors and with each other.

import (
	"fmt"
	"math/big"
)

var refModulus, _ = new(big.Int).SetString("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001", 16)

var (
	refInternalD [4]*big.Int
	refFirstFull [4][4]*big.Int
	refPartial   [56]*big.Int
	refLastFull  [4][4]*big.Int
)

func refMustHex(s string) *big.Int {
	x, ok := new(big.Int).SetString(s, 0)
	if !ok || x.Sign() < 0 || x.Cmp(refModulus) >= 0 {
		panic("poseidon2: bad constant " + s)
	}
	return x
}

func init() {
	for i := range 4 {
		refInternalD[i] = refMustHex(internalDHex[i])
		for r := range 4 {
			refFirstFull[r][i] = refMustHex(firstFullHex[r][i])
			refLastFull[r][i] = refMustHex(lastFullHex[r][i])
		}
	}
	for r := range refPartial {
		refPartial[r] = refMustHex(partialHex[r])
	}
}

// refState holds the permutation refState and scratch space, so that one
// permutation allocates nothing after the first use.
type refState struct {
	s   [4]big.Int
	t   [4]big.Int
	sum big.Int
	sq  big.Int
}

func (st *refState) reduce(x *big.Int) {
	if x.Sign() < 0 || x.Cmp(refModulus) >= 0 {
		x.Mod(x, refModulus)
	}
}

// sbox sets x to (x + c)^5 mod p.
func (st *refState) sbox(x, c *big.Int) {
	x.Add(x, c)
	st.reduce(x)
	st.sq.Mul(x, x)
	st.sq.Mod(&st.sq, refModulus) // x^2
	st.sum.Mul(&st.sq, &st.sq)
	st.sum.Mod(&st.sum, refModulus) // x^4
	x.Mul(x, &st.sum)
	x.Mod(x, refModulus)
}

// external multiplies the refState by M_E = [[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]],
// computed as in Barretenberg (matrix_multiplication_4x4).
func (st *refState) external() {
	s, t := &st.s, &st.t
	t[0].Add(&s[0], &s[1]) // s0 + s1
	t[1].Add(&s[2], &s[3]) // s2 + s3
	t[2].Lsh(&s[1], 1)
	t[2].Add(&t[2], &t[1]) // 2 s1 + s2 + s3
	t[3].Lsh(&s[3], 1)
	t[3].Add(&t[3], &t[0]) // s0 + s1 + 2 s3
	// t4 = 4 t1 + t3, t5 = 4 t0 + t2, t6 = t3 + t5, t7 = t2 + t4
	var t4, t5 big.Int
	t4.Lsh(&t[1], 2)
	t4.Add(&t4, &t[3])
	t5.Lsh(&t[0], 2)
	t5.Add(&t5, &t[2])
	s[0].Add(&t[3], &t5)
	s[1].Set(&t5)
	s[2].Add(&t[2], &t4)
	s[3].Set(&t4)
	for i := range 4 {
		s[i].Mod(&s[i], refModulus)
	}
}

// internal multiplies the refState by M_I: s_i = s_i * d_i + (s_0 + s_1 + s_2 + s_3).
func (st *refState) internal() {
	s := &st.s
	st.sum.Add(&s[0], &s[1])
	st.sum.Add(&st.sum, &s[2])
	st.sum.Add(&st.sum, &s[3])
	for i := range 4 {
		s[i].Mul(&s[i], refInternalD[i])
		s[i].Add(&s[i], &st.sum)
		s[i].Mod(&s[i], refModulus)
	}
}

func (st *refState) permute() {
	st.external()
	for r := range 4 {
		for i := range 4 {
			st.sbox(&st.s[i], refFirstFull[r][i])
		}
		st.external()
	}
	for r := range refPartial {
		st.sbox(&st.s[0], refPartial[r])
		st.internal()
	}
	for r := range 4 {
		for i := range 4 {
			st.sbox(&st.s[i], refLastFull[r][i])
		}
		st.external()
	}
}

func refCheckInput(x *big.Int) error {
	if x.Sign() < 0 || x.Cmp(refModulus) >= 0 {
		return fmt.Errorf("poseidon2: input %#x is not a field element", x)
	}
	return nil
}

// refPermutation returns the Poseidon2 permutation of in. Every element must be
// below the modulus.
func refPermutation(in [4]*big.Int) ([4]*big.Int, error) {
	var st refState
	for i, x := range in {
		if err := refCheckInput(x); err != nil {
			return [4]*big.Int{}, err
		}
		st.s[i].Set(x)
	}
	st.permute()
	var out [4]*big.Int
	for i := range out {
		out[i] = new(big.Int).Set(&st.s[i])
	}
	return out, nil
}

// refHasher computes Poseidon2 hashes, reusing its scratch space. A refHasher is
// not safe for concurrent use.
type refHasher struct {
	st refState
}

// refHash returns Poseidon2(xs...) for 2 or 3 field elements, into out.
func (h *refHasher) refHash(out *big.Int, xs ...*big.Int) error {
	if len(xs) != 2 && len(xs) != 3 {
		return fmt.Errorf("poseidon2: %d inputs, want 2 or 3", len(xs))
	}
	st := &h.st
	for i := range 4 {
		st.s[i].SetUint64(0)
	}
	for i, x := range xs {
		if err := refCheckInput(x); err != nil {
			return err
		}
		st.s[i].Set(x)
	}
	st.s[3].Lsh(big.NewInt(int64(len(xs))), 64) // n * 2^64
	st.permute()
	out.Set(&st.s[0])
	return nil
}

// refHash returns Poseidon2(xs...) for 2 or 3 field elements.
func refHash(xs ...*big.Int) (*big.Int, error) {
	var h refHasher
	out := new(big.Int)
	if err := h.refHash(out, xs...); err != nil {
		return nil, err
	}
	return out, nil
}

// refConstant returns the reference's copy of a constant, or nil.
func refConstant(name, s string) *big.Int {
	x := refMustHex(s)
	var all []*big.Int
	all = append(all, refInternalD[:]...)
	for r := range 4 {
		all = append(all, refFirstFull[r][:]...)
		all = append(all, refLastFull[r][:]...)
	}
	all = append(all, refPartial[:]...)
	for _, c := range all {
		if c.Cmp(x) == 0 {
			return c
		}
	}
	return nil
}
