package crl

import (
	"errors"
	"fmt"
	"math/big"
	"slices"
	"sort"

	"github.com/consensys/gnark-crypto/ecc/bn254/fr"

	"github.com/iamreal-tw/iamreal/crl/poseidon2"
)

// Depth is the depth of the circuit's tree: the number of siblings in a
// proof of absence.
const Depth = 128

// Tree is the revocation tree of spec/revocation-tree.md: circomlib's sparse
// Merkle tree over the keys, hashed with Poseidon2, every value 1.
//
//	node(S, l) = 0                                      if S is empty
//	           = Poseidon2(k, 1, 1)                     if S = {k}
//	           = Poseidon2(node(S0, l+1), node(S1, l+1)) otherwise
//
// S0 and S1 hold the keys whose bit l (from the least significant) is 0
// and 1. It keeps every node, so proofs need no hashing.
type Tree struct {
	keys  []Key  // sorted by path
	nodes []node // children before parents; the root is last
	root  int32  // index into nodes, or empty
}

// A node is a leaf (left == leaf, right is the key's index) or a branch
// (left and right are node indexes, or empty for an empty subtree).
type node struct {
	hash        fr.Element
	left, right int32
}

const (
	empty int32 = -1
	leaf  int32 = -2
)

var one = func() fr.Element { var e fr.Element; e.SetOne(); return e }()

// NewTree builds the tree of keys. Keys that share their lowest 127 bits,
// including a key given twice, are an error: they cannot be in one tree.
func NewTree(keys []Key) (*Tree, error) {
	if i, j, ok := findCollision(keys); ok {
		return nil, fmt.Errorf("crl: keys %d and %d share their lowest 127 bits", i, j)
	}
	type keyPath struct {
		p pathOrder
		k Key
	}
	sorted := make([]keyPath, len(keys))
	for i, k := range keys {
		sorted[i] = keyPath{k.path(), k}
	}
	slices.SortFunc(sorted, func(x, y keyPath) int { return x.p.compare(y.p) })
	t := &Tree{keys: make([]Key, len(keys))}
	for i, s := range sorted {
		t.keys[i] = s.k
	}
	// About 1.44 nodes per key for random keys.
	t.nodes = make([]node, 0, len(keys)+len(keys)/2+1)
	t.root = t.build(0, len(t.keys), 0)
	return t, nil
}

func (t *Tree) build(lo, hi, level int) int32 {
	switch hi - lo {
	case 0:
		return empty
	case 1:
		var k fr.Element
		k.SetBytes(t.keys[lo][:])
		t.nodes = append(t.nodes, node{hash: poseidon2.Hash3(&k, &one, &one), left: leaf, right: int32(lo)})
		return int32(len(t.nodes) - 1)
	}
	if level >= pathBits {
		panic("crl: keys collide on the whole path") // excluded by NewTree
	}
	mid := lo + sort.Search(hi-lo, func(i int) bool { return t.keys[lo+i].bit(level) == 1 })
	l := t.build(lo, mid, level+1)
	r := t.build(mid, hi, level+1)
	lh, rh := t.hash(l), t.hash(r)
	t.nodes = append(t.nodes, node{hash: poseidon2.Hash2(&lh, &rh), left: l, right: r})
	return int32(len(t.nodes) - 1)
}

func (t *Tree) hash(i int32) fr.Element {
	if i == empty {
		return fr.Element{}
	}
	return t.nodes[i].hash
}

// Len returns the number of keys.
func (t *Tree) Len() int { return len(t.keys) }

// Hashes returns the number of Poseidon2 hashes the tree took to build.
func (t *Tree) Hashes() int { return len(t.nodes) }

// Root returns the root as an integer below the field modulus.
func (t *Tree) Root() *big.Int {
	h := t.hash(t.root)
	return h.BigInt(new(big.Int))
}

// RootHex returns the root as in records: 64 lowercase hex digits,
// big-endian.
func (t *Tree) RootHex() string {
	return fmt.Sprintf("%064x", t.Root())
}

// Proof is a proof that a key is not in the tree, in the shape of the
// circuit's inputs smt_siblings, smt_old_key, smt_old_value, smt_is_old0.
type Proof struct {
	Root     *big.Int
	Siblings [Depth]*big.Int // from the root down, zero after the last
	OldKey   *big.Int        // the key in the leaf the path ends at, or 0
	OldValue *big.Int        // 1 if the path ends at a leaf, else 0
	IsOld0   bool            // the path ends at an empty subtree
}

// ErrInTree is returned when asked to prove that a key in the tree is absent.
var ErrInTree = errors.New("crl: the key is in the tree")

// ProveAbsent returns a proof that k is not in the tree. It walks from the
// root along the bits of k until an empty subtree or a single leaf.
func (t *Tree) ProveAbsent(k Key) (*Proof, error) {
	p := &Proof{Root: t.Root(), OldKey: new(big.Int), OldValue: new(big.Int)}
	for i := range p.Siblings {
		p.Siblings[i] = new(big.Int)
	}
	cur := t.root
	for level := 0; cur != empty && t.nodes[cur].left != leaf; level++ {
		n := t.nodes[cur]
		next, sib := n.left, n.right
		if k.bit(level) == 1 {
			next, sib = n.right, n.left
		}
		h := t.hash(sib)
		h.BigInt(p.Siblings[level])
		cur = next
	}
	if cur == empty {
		p.IsOld0 = true
		return p, nil
	}
	old := t.keys[t.nodes[cur].right]
	if old == k {
		return nil, ErrInTree
	}
	p.OldKey = old.Int()
	p.OldValue.SetInt64(1)
	return p, nil
}
