package crl

import (
	"encoding/json"
	"errors"
	"math/big"
	"math/rand/v2"
	"os"
	"testing"

	"github.com/iamreal-tw/iamreal/crl/poseidon2"
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

func mustKey(t testing.TB, s string) Key {
	t.Helper()
	k, err := ParseKey(s)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func h2(t testing.TB, a, b *big.Int) *big.Int {
	x, err := poseidon2.Hash(a, b)
	if err != nil {
		t.Fatal(err)
	}
	return x
}

func h3(t testing.TB, a, b, c *big.Int) *big.Int {
	x, err := poseidon2.Hash(a, b, c)
	if err != nil {
		t.Fatal(err)
	}
	return x
}

// refNode is node(S, l) of spec/revocation-tree.md, written as there: slow,
// recursive, on integers. The tests compare Tree against it.
func refNode(t testing.TB, keys []*big.Int, l int) *big.Int {
	switch len(keys) {
	case 0:
		return new(big.Int)
	case 1:
		return h3(t, keys[0], big.NewInt(1), big.NewInt(1))
	}
	if l > 126 {
		t.Fatal("keys collide")
	}
	var s0, s1 []*big.Int
	for _, k := range keys {
		if k.Bit(l) == 0 {
			s0 = append(s0, k)
		} else {
			s1 = append(s1, k)
		}
	}
	return h2(t, refNode(t, s0, l+1), refNode(t, s1, l+1))
}

// verifyAbsent is assert_not_in_tree of the circuit (lib/src/smt.nr of the
// Noir circuits), on integers: it recomputes the root from a proof.
func verifyAbsent(t testing.TB, root *big.Int, k Key, p *Proof) bool {
	key := k.Int()
	if !p.IsOld0 && p.OldKey.Cmp(key) == 0 {
		return false
	}
	node := new(big.Int)
	if !p.IsOld0 {
		node = h3(t, p.OldKey, p.OldValue, big.NewInt(1))
	}
	if p.Siblings[Depth-1].Sign() != 0 {
		return false
	}
	onPath := false
	for j := range Depth {
		i := Depth - 1 - j
		onPath = onPath || p.Siblings[i].Sign() != 0
		if !onPath {
			continue
		}
		if key.Bit(i) == 1 {
			node = h2(t, p.Siblings[i], node)
		} else {
			node = h2(t, node, p.Siblings[i])
		}
	}
	return node.Cmp(root) == 0
}

func TestRevocationTreeVectors(t *testing.T) {
	var v struct {
		RevocationTree struct {
			Cases []struct {
				Serials []string `json:"serials"`
				Root    string   `json:"root"`
				Absent  []struct {
					Serial   string   `json:"serial"`
					Siblings []string `json:"siblings"`
					OldKey   string   `json:"old_key"`
					OldValue string   `json:"old_value"`
					IsOld0   bool     `json:"is_old0"`
				} `json:"absent"`
			} `json:"cases"`
		} `json:"revocation_tree"`
	}
	readJSON(t, "../spec/vectors/poseidon2.json", &v)
	if len(v.RevocationTree.Cases) == 0 {
		t.Fatal("no cases")
	}
	for i, c := range v.RevocationTree.Cases {
		keys := make([]Key, len(c.Serials))
		for j, s := range c.Serials {
			keys[j] = mustKey(t, s)
		}
		tree, err := NewTree(keys)
		if err != nil {
			t.Fatal(err)
		}
		if tree.Root().Cmp(hexInt(t, c.Root)) != 0 {
			t.Errorf("case %d: root %#x, want %s", i, tree.Root(), c.Root)
		}
		for _, a := range c.Absent {
			p, err := tree.ProveAbsent(mustKey(t, a.Serial))
			if err != nil {
				t.Fatalf("case %d serial %s: %v", i, a.Serial, err)
			}
			for j := range Depth {
				want := new(big.Int)
				if j < len(a.Siblings) {
					want = hexInt(t, a.Siblings[j])
				}
				if p.Siblings[j].Cmp(want) != 0 {
					t.Errorf("case %d serial %s: sibling %d = %#x, want %#x", i, a.Serial, j, p.Siblings[j], want)
				}
			}
			if p.IsOld0 != a.IsOld0 || p.OldKey.Cmp(hexInt(t, a.OldKey)) != 0 || p.OldValue.Cmp(hexInt(t, a.OldValue)) != 0 {
				t.Errorf("case %d serial %s: old %v %#x %#x, want %v %s %s", i, a.Serial, p.IsOld0, p.OldKey, p.OldValue, a.IsOld0, a.OldKey, a.OldValue)
			}
			if !verifyAbsent(t, tree.Root(), mustKey(t, a.Serial), p) {
				t.Errorf("case %d serial %s: proof does not verify", i, a.Serial)
			}
		}
	}
}

func randomKey(r *rand.Rand, bytes int) Key {
	var k Key
	for i := MaxSerialBytes - bytes; i < MaxSerialBytes; i++ {
		k[i] = byte(r.Uint32())
	}
	return k
}

// Tree agrees with refNode, and every proof verifies the way the circuit
// checks it, for random trees, keys of every length, and keys sharing long
// runs of low bits.
func TestTreeAgainstReference(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	for trial := range 40 {
		n := r.IntN(30)
		seen := map[pathOrder]bool{}
		var keys []Key
		var ints []*big.Int
		for len(keys) < n {
			k := randomKey(r, 1+r.IntN(MaxSerialBytes))
			if trial%4 == 0 && len(keys) > 0 {
				// Same low bits as an earlier key up to a random bit.
				prev := keys[r.IntN(len(keys))].Int()
				bit := r.IntN(127)
				mask := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(bit)), big.NewInt(1))
				x := new(big.Int).AndNot(k.Int(), mask)
				x.Or(x, new(big.Int).And(prev, mask))
				var err error
				if k, err = KeyFromInt(x); err != nil {
					t.Fatal(err)
				}
			}
			if seen[k.path()] {
				continue
			}
			seen[k.path()] = true
			keys = append(keys, k)
			ints = append(ints, k.Int())
		}
		tree, err := NewTree(keys)
		if err != nil {
			t.Fatal(err)
		}
		want := refNode(t, ints, 0)
		if tree.Root().Cmp(want) != 0 {
			t.Fatalf("trial %d: root %#x, reference %#x", trial, tree.Root(), want)
		}
		if tree.Hashes() != len(tree.nodes) {
			t.Fatal("hash count")
		}
		for range 10 {
			k := randomKey(r, 1+r.IntN(MaxSerialBytes))
			if len(keys) > 0 && r.IntN(2) == 0 {
				// Shares low bits with a key in the tree.
				prev := keys[r.IntN(len(keys))].Int()
				bit := r.IntN(128)
				mask := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), uint(bit)), big.NewInt(1))
				x := new(big.Int).AndNot(k.Int(), mask)
				x.Or(x, new(big.Int).And(prev, mask))
				k, _ = KeyFromInt(x)
			}
			p, err := tree.ProveAbsent(k)
			if errors.Is(err, ErrInTree) {
				continue
			}
			if err != nil {
				t.Fatal(err)
			}
			if !verifyAbsent(t, want, k, p) {
				t.Fatalf("trial %d: proof for %v does not verify", trial, k)
			}
		}
		for _, k := range keys {
			if _, err := tree.ProveAbsent(k); !errors.Is(err, ErrInTree) {
				t.Fatalf("trial %d: key in the tree: %v", trial, err)
			}
		}
	}
}

func TestTreeRejectsCollisions(t *testing.T) {
	a := mustKey(t, "0x3123456789abcdef0123456789abcdef")
	b := mustKey(t, "0xb123456789abcdef0123456789abcdef") // differs in bit 127
	if _, err := NewTree([]Key{a, b}); err == nil {
		t.Error("keys differing only in bit 127 accepted")
	}
	if _, err := NewTree([]Key{a, a}); err == nil {
		t.Error("a key twice accepted")
	}
	c := mustKey(t, "0x7123456789abcdef0123456789abcdef") // differs in bit 126
	tree, err := NewTree([]Key{a, c})
	if err != nil {
		t.Fatal(err)
	}
	// The deepest path: 127 siblings, the last one at index 126. b shares
	// its lowest 127 bits with a, so its path ends at a's leaf.
	k := b
	p, err := tree.ProveAbsent(k)
	if err != nil {
		t.Fatal(err)
	}
	if p.Siblings[126].Sign() == 0 || p.Siblings[127].Sign() != 0 || p.IsOld0 || p.OldKey.Cmp(a.Int()) != 0 {
		t.Errorf("deepest path: sibling 126 %#x, 127 %#x, is_old0 %v", p.Siblings[126], p.Siblings[127], p.IsOld0)
	}
	if !verifyAbsent(t, tree.Root(), k, p) {
		t.Error("deepest proof does not verify")
	}
}

func TestKeyFromSerial(t *testing.T) {
	for _, c := range []struct {
		content []byte
		want    string // "" for an error
	}{
		{[]byte{0x00}, "0x0"},
		{[]byte{0x05}, "0x5"},
		{[]byte{0x00, 0x80}, "0x80"},
		{[]byte{0x7f, 0xff}, "0x7fff"},
		{[]byte{0x80}, ""},       // negative
		{[]byte{0xff, 0x01}, ""}, // negative
		{[]byte{0x00, 0x05}, ""}, // not minimal
		{[]byte{}, ""},
		{append([]byte{0x7f}, make([]byte, 19)...), "0x7f" + "00000000000000000000000000000000000000"},
		{append([]byte{0x00, 0x80}, make([]byte, 18)...), "0x80" + "000000000000000000000000000000000000"},
		{append([]byte{0x00, 0x80}, make([]byte, 19)...), ""}, // 21 bytes
	} {
		k, err := KeyFromSerial(c.content)
		switch {
		case c.want == "" && err == nil:
			t.Errorf("% x: accepted as %v", c.content, k)
		case c.want != "" && err != nil:
			t.Errorf("% x: %v", c.content, err)
		case c.want != "" && k.String() != c.want:
			t.Errorf("% x: %v, want %s", c.content, k, c.want)
		}
	}
}

func TestParseKey(t *testing.T) {
	for in, want := range map[string]string{
		"0x5": "0x5", "5": "0x5", "00:80": "0x80", "0x00ff": "0xff",
		"ffffffffffffffffffffffffffffffffffffffff": "0xffffffffffffffffffffffffffffffffffffffff",
	} {
		k, err := ParseKey(in)
		if err != nil || k.String() != want {
			t.Errorf("ParseKey(%q) = %v, %v; want %s", in, k, err, want)
		}
	}
	for _, in := range []string{"", "0x", "-5", "+5", "xyz", "0x1" + "0000000000000000000000000000000000000000"} {
		if k, err := ParseKey(in); err == nil {
			t.Errorf("ParseKey(%q) = %v, want an error", in, k)
		}
	}
}
