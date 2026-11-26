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
	// reuse is set only while a TreeBuilder builds the tree.
	reuse *reuse
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
// Every hash of the tree is computed: it is the reference a TreeBuilder's
// trees are compared with.
func NewTree(keys []Key) (*Tree, error) { return newTree(keys, nil) }

// A TreeBuilder builds one tree after another and, for each, reuses the
// hashes of the tree it built before: a leaf's if that tree has a leaf of
// the same key, a branch's if that tree has, at the same place, a branch
// whose two children have the same two hashes. The hash of a node is a
// function of those alone (see Tree), so a reused hash is the hash NewTree
// computes, and the tree is NewTree's tree, node for node.
//
// It is for the CRLs of one issuer key, in any order: two of them differ
// in a few hundred serial numbers out of hundreds of thousands, so nearly
// every node of one is a node of the other (README.md, "重用雜湊"). No
// table is kept: the tree before is walked alongside the one being built.
// So what a builder holds is the last tree it built and nothing else,
// however many it builds. Nothing is written anywhere, and nothing outlives
// the builder. The zero value is ready to use; it is not for use by several
// goroutines at once.
type TreeBuilder struct {
	last     *Tree
	computed int
}

// reuse is the tree before, read while a tree is built, and the count of
// the hashes that could not be taken from it.
type reuse struct {
	from     *Tree
	computed int
}

// noNode is the place in the tree before of a subtree it does not have:
// an empty subtree there, or no tree before at all.
const noNode = empty

// NewTree builds the tree of keys, as the function NewTree does.
func (b *TreeBuilder) NewTree(keys []Key) (*Tree, error) {
	r := &reuse{from: b.last}
	t, err := newTree(keys, r)
	if err != nil {
		// Nothing was built: the tree before stays.
		return nil, err
	}
	b.last, b.computed = t, r.computed
	return t, nil
}

// Computed returns how many Poseidon2 hashes the last tree took that were
// not reused: for the first tree, all of them (Tree.Hashes).
func (b *TreeBuilder) Computed() int { return b.computed }

func newTree(keys []Key, r *reuse) (*Tree, error) {
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
	t := &Tree{keys: make([]Key, len(keys)), reuse: r}
	for i, s := range sorted {
		t.keys[i] = s.k
	}
	// About 1.44 nodes per key for random keys.
	t.nodes = make([]node, 0, len(keys)+len(keys)/2+1)
	t.root = t.build(0, len(t.keys), 0, r.before())
	t.reuse = nil
	return t, nil
}

// before returns the root of the tree before, as the place a build starts
// reading it from: none if there is no tree before, or it is empty.
func (r *reuse) before() int32 {
	if r == nil || r.from == nil {
		return noNode
	}
	return r.from.root
}

// leafHash is Poseidon2(k, 1, 1) for the leaf of key at this level, reused
// if the tree before has a leaf of the same key. p is the node of the tree
// before at the same place (the same low bits of the path), or noNode: the
// key's leaf, if that tree has it, is p or below p, along the key's bits.
func (t *Tree) leafHash(key Key, level int, p int32) fr.Element {
	if r := t.reuse; r != nil {
		prev := r.from
		for p != noNode && prev.nodes[p].left != leaf {
			if key.bit(level) == 1 {
				p = prev.nodes[p].right
			} else {
				p = prev.nodes[p].left
			}
			level++
		}
		if p != noNode && prev.keys[prev.nodes[p].right] == key {
			return prev.nodes[p].hash
		}
		r.computed++
	}
	var k fr.Element
	k.SetBytes(key[:])
	return poseidon2.Hash3(&k, &one, &one)
}

// branchHash is Poseidon2(l, r), reused if p, the node of the tree before
// at the same place, is a branch whose children have these two hashes.
func (t *Tree) branchHash(l, r fr.Element, p int32) fr.Element {
	if re := t.reuse; re != nil {
		prev := re.from
		if p != noNode && prev.nodes[p].left != leaf && prev.hash(prev.nodes[p].left) == l && prev.hash(prev.nodes[p].right) == r {
			return prev.nodes[p].hash
		}
		re.computed++
	}
	return poseidon2.Hash2(&l, &r)
}

// below returns the nodes of the tree before under p, on the side of bit
// 0 and of bit 1 at this level. Under a leaf there is only the leaf
// itself, on the side its key's bit says: a tree has one node for a
// subtree of one key, at whatever level the subtree begins.
func (t *Tree) below(p int32, level int) (int32, int32) {
	if p == noNode {
		return noNode, noNode
	}
	prev := t.reuse.from
	n := prev.nodes[p]
	if n.left != leaf {
		return n.left, n.right
	}
	if prev.keys[n.right].bit(level) == 1 {
		return noNode, p
	}
	return p, noNode
}

// build makes the node of keys[lo:hi], which share their lowest `level`
// bits of the path. p is the node of the tree before for the keys that
// share those bits, or noNode; it is read only by a TreeBuilder.
func (t *Tree) build(lo, hi, level int, p int32) int32 {
	switch hi - lo {
	case 0:
		return empty
	case 1:
		t.nodes = append(t.nodes, node{hash: t.leafHash(t.keys[lo], level, p), left: leaf, right: int32(lo)})
		return int32(len(t.nodes) - 1)
	}
	if level >= pathBits {
		panic("crl: keys collide on the whole path") // excluded by NewTree
	}
	mid := lo + sort.Search(hi-lo, func(i int) bool { return t.keys[lo+i].bit(level) == 1 })
	p0, p1 := noNode, noNode
	if t.reuse != nil {
		p0, p1 = t.below(p, level)
	}
	l := t.build(lo, mid, level+1, p0)
	r := t.build(mid, hi, level+1, p1)
	t.nodes = append(t.nodes, node{hash: t.branchHash(t.hash(l), t.hash(r), p), left: l, right: r})
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

// Hashes returns the number of Poseidon2 hashes the tree has: one for each
// node. A TreeBuilder may have computed fewer (TreeBuilder.Computed).
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
