package poseidon2

import (
	"encoding/json"
	"math/big"
	"math/rand/v2"
	"os"
	"testing"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"
)

func readJSON(t testing.TB, path string, v any) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatal(err)
	}
}

func hexInt(t testing.TB, s string) *big.Int {
	t.Helper()
	x, ok := new(big.Int).SetString(s, 0)
	if !ok {
		t.Fatalf("bad hex %q", s)
	}
	return x
}

type constantsFile struct {
	P              string     `json:"p"`
	T              int        `json:"t"`
	Alpha          int        `json:"alpha"`
	FullRounds     int        `json:"full_rounds"`
	PartialRounds  int        `json:"partial_rounds"`
	ExternalMatrix [][]int64  `json:"external_matrix"`
	InternalD      []string   `json:"internal_d"`
	FirstFull      [][]string `json:"round_constants_first_full"`
	Partial        []string   `json:"round_constants_partial"`
	LastFull       [][]string `json:"round_constants_last_full"`
	Permutation    []struct {
		Input  []string `json:"input"`
		Output []string `json:"output"`
	} `json:"permutation"`
}

// constants.go must be what gen_constants.go makes from the JSON.
func TestConstantsMatchSpec(t *testing.T) {
	var c constantsFile
	readJSON(t, "../../spec/vectors/poseidon2-constants.json", &c)
	if hexInt(t, c.P).Cmp(Modulus) != 0 || hexInt(t, c.P).Cmp(refModulus) != 0 {
		t.Fatal("modulus differs")
	}
	if c.T != 4 || c.Alpha != 5 || c.FullRounds != 8 || c.PartialRounds != 56 {
		t.Fatalf("parameters differ: %+v", c)
	}
	want := [][]int64{{5, 7, 1, 3}, {4, 6, 1, 1}, {1, 3, 5, 7}, {1, 1, 4, 6}}
	for i := range want {
		for j := range want[i] {
			if c.ExternalMatrix[i][j] != want[i][j] {
				t.Fatalf("external matrix differs at %d,%d", i, j)
			}
		}
	}
	same := func(name string, got fr.Element, s string) {
		if got.BigInt(new(big.Int)).Cmp(hexInt(t, s)) != 0 {
			t.Errorf("%s differs", name)
		}
		// The math/big reference reads the same constants.
		if refConstant(name, s) == nil {
			t.Errorf("%s: reference has no constant %s", name, s)
		}
	}
	if len(c.InternalD) != 4 || len(c.FirstFull) != 4 || len(c.LastFull) != 4 || len(c.Partial) != 56 {
		t.Fatal("constant counts differ")
	}
	for i := range 4 {
		same("internal_d", internalD[i], c.InternalD[i])
		for r := range 4 {
			same("first_full", firstFull[r][i], c.FirstFull[r][i])
			same("last_full", lastFull[r][i], c.LastFull[r][i])
		}
	}
	for r := range partial {
		same("partial", partial[r], c.Partial[r])
	}
}

// The external matrix as computed must equal the matrix in the JSON.
func TestExternalMatrix(t *testing.T) {
	want := [][]int64{{5, 7, 1, 3}, {4, 6, 1, 1}, {1, 3, 5, 7}, {1, 1, 4, 6}}
	for col := range 4 {
		var s [4]fr.Element
		s[col].SetOne()
		external(&s)
		var ref refState
		ref.s[col].SetUint64(1)
		ref.external()
		for row := range 4 {
			var w fr.Element
			w.SetInt64(want[row][col])
			if !s[row].Equal(&w) {
				t.Errorf("M_E[%d][%d] = %v, want %d", row, col, s[row].String(), want[row][col])
			}
			if ref.s[row].Int64() != want[row][col] {
				t.Errorf("reference M_E[%d][%d] = %v, want %d", row, col, &ref.s[row], want[row][col])
			}
		}
	}
}

func TestPermutation(t *testing.T) {
	var c constantsFile
	readJSON(t, "../../spec/vectors/poseidon2-constants.json", &c)
	if len(c.Permutation) == 0 {
		t.Fatal("no permutation vectors")
	}
	for _, v := range c.Permutation {
		var in [4]*big.Int
		for i := range in {
			in[i] = hexInt(t, v.Input[i])
		}
		for name, perm := range map[string]func([4]*big.Int) ([4]*big.Int, error){"fr": Permutation, "math/big": refPermutation} {
			out, err := perm(in)
			if err != nil {
				t.Fatal(err)
			}
			for i := range out {
				if out[i].Cmp(hexInt(t, v.Output[i])) != 0 {
					t.Errorf("%s: permutation output %d = %#x, want %s", name, i, out[i], v.Output[i])
				}
			}
		}
	}
}

type hashCase struct {
	Inputs []string `json:"inputs"`
	Hash   string   `json:"hash"`
}

func TestHashVectors(t *testing.T) {
	var v struct {
		FieldModulus string     `json:"field_modulus"`
		Hash2        []hashCase `json:"hash_2"`
		Hash3        []hashCase `json:"hash_3"`
	}
	readJSON(t, "../../spec/vectors/poseidon2.json", &v)
	if hexInt(t, v.FieldModulus).Cmp(Modulus) != 0 {
		t.Fatal("modulus differs")
	}
	for name, cases := range map[string][]hashCase{"hash_2": v.Hash2, "hash_3": v.Hash3} {
		if len(cases) == 0 {
			t.Fatalf("%s: no cases", name)
		}
		for i, c := range cases {
			xs := make([]*big.Int, len(c.Inputs))
			for j, s := range c.Inputs {
				xs[j] = hexInt(t, s)
			}
			for impl, hash := range map[string]func(...*big.Int) (*big.Int, error){"fr": Hash, "math/big": refHash} {
				got, err := hash(xs...)
				if err != nil {
					t.Fatal(err)
				}
				if got.Cmp(hexInt(t, c.Hash)) != 0 {
					t.Errorf("%s %s case %d: %#x, want %s", impl, name, i, got, c.Hash)
				}
			}
		}
	}
}

// scoped_id: 18 limbs of 120 bits of the signature, chained from 0.
func TestScopedIDVectors(t *testing.T) {
	var v struct {
		ScopedID struct {
			Cases []struct {
				Signature string   `json:"signature"`
				Limbs     []string `json:"limbs"`
				ScopedID  string   `json:"scoped_id"`
			} `json:"cases"`
		} `json:"scoped_id"`
	}
	readJSON(t, "../../spec/vectors/poseidon2.json", &v)
	if len(v.ScopedID.Cases) == 0 {
		t.Fatal("no cases")
	}
	mask := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 120), big.NewInt(1))
	for i, c := range v.ScopedID.Cases {
		s := hexInt(t, "0x"+c.Signature)
		state := new(big.Int)
		for j := range 18 {
			limb := new(big.Int).Rsh(s, uint(120*j))
			limb.And(limb, mask)
			if limb.Cmp(hexInt(t, c.Limbs[j])) != 0 {
				t.Fatalf("case %d limb %d differs", i, j)
			}
			next, err := Hash(state, limb)
			if err != nil {
				t.Fatal(err)
			}
			state = next
		}
		if state.Cmp(hexInt(t, c.ScopedID)) != 0 {
			t.Errorf("case %d: %#x, want %s", i, state, c.ScopedID)
		}
	}
}

// The two implementations agree on inputs the vectors do not cover.
func TestAgreesWithReference(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		xs := make([]*big.Int, 2+r.IntN(2))
		for i := range xs {
			b := make([]byte, 32)
			for j := range b {
				b[j] = byte(r.Uint32())
			}
			xs[i] = new(big.Int).Mod(new(big.Int).SetBytes(b), Modulus)
		}
		xs[0] = new(big.Int).Sub(Modulus, big.NewInt(int64(r.IntN(3))+1)) // near p
		got, err := Hash(xs...)
		if err != nil {
			t.Fatal(err)
		}
		want, err := refHash(xs...)
		if err != nil {
			t.Fatal(err)
		}
		if got.Cmp(want) != 0 {
			t.Fatalf("Hash(%#x) = %#x, reference %#x", xs, got, want)
		}
	}
}

func TestRejects(t *testing.T) {
	if _, err := Hash(big.NewInt(1)); err == nil {
		t.Error("one input accepted")
	}
	if _, err := Hash(big.NewInt(1), big.NewInt(2), big.NewInt(3), big.NewInt(4)); err == nil {
		t.Error("four inputs accepted")
	}
	if _, err := Hash(Modulus, big.NewInt(0)); err == nil {
		t.Error("p accepted as input")
	}
	if _, err := Hash(big.NewInt(-1), big.NewInt(0)); err == nil {
		t.Error("-1 accepted as input")
	}
}

func BenchmarkHash2(b *testing.B) {
	var x, y fr.Element
	x.SetUint64(1)
	y.SetUint64(2)
	for b.Loop() {
		x = Hash2(&x, &y)
	}
}

func BenchmarkHash2Reference(b *testing.B) {
	var h refHasher
	x, y, out := big.NewInt(1), big.NewInt(2), new(big.Int)
	for b.Loop() {
		if err := h.refHash(out, x, y); err != nil {
			b.Fatal(err)
		}
		x.Set(out)
	}
}
