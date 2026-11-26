package crl

import (
	"errors"
	"fmt"
	"math/big"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// sameTree fails unless got is want node for node: the same keys in the
// same order, the same nodes with the same hashes and children, the same
// root.
func sameTree(t *testing.T, what string, got, want *Tree) {
	t.Helper()
	if !slices.Equal(got.keys, want.keys) || !slices.Equal(got.nodes, want.nodes) || got.root != want.root {
		t.Fatalf("%s: the reused tree is not NewTree's tree (root %s, want %s)", what, got.RootHex(), want.RootHex())
	}
	if got.reuse != nil {
		t.Fatalf("%s: the tree still holds the tree before", what)
	}
}

// randomKeys returns n keys of random 16-byte serial numbers, no two of
// which share their lowest 127 bits.
func randomKeys(t *testing.T, r *rand.Rand, n int) []Key {
	t.Helper()
	keys := make([]Key, 0, n)
	seen := map[pathOrder]bool{}
	for len(keys) < n {
		x := new(big.Int).SetUint64(r.Uint64())
		x.Lsh(x, 64).Or(x, new(big.Int).SetUint64(r.Uint64()))
		k, err := KeyFromInt(x)
		if err != nil {
			t.Fatal(err)
		}
		if seen[k.path()] {
			continue
		}
		seen[k.path()] = true
		keys = append(keys, k)
	}
	return keys
}

// keysOfInts returns the keys of serial numbers given as integers.
func keysOfInts(t *testing.T, serials ...int64) []Key {
	t.Helper()
	keys := make([]Key, len(serials))
	for i, s := range serials {
		k, err := KeyFromInt(big.NewInt(s))
		if err != nil {
			t.Fatal(err)
		}
		keys[i] = k
	}
	return keys
}

// The trees of spec/vectors/poseidon2.json (revocation_tree), one builder
// for all of them in the order of the file and in the reverse order: each
// is NewTree's tree and has the root of the vectors, whatever was built
// before it.
func TestTreeBuilderVectors(t *testing.T) {
	var v struct {
		RevocationTree struct {
			Cases []struct {
				Serials []string `json:"serials"`
				Root    string   `json:"root"`
			} `json:"cases"`
		} `json:"revocation_tree"`
	}
	readJSON(t, "../spec/vectors/poseidon2.json", &v)
	cases := v.RevocationTree.Cases
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for _, order := range []string{"in order", "reversed"} {
		var b TreeBuilder
		for n := range cases {
			i := n
			if order == "reversed" {
				i = len(cases) - 1 - n
			}
			c := cases[i]
			keys := make([]Key, len(c.Serials))
			for j, s := range c.Serials {
				keys[j] = mustKey(t, s)
			}
			want, err := NewTree(keys)
			if err != nil {
				t.Fatal(err)
			}
			got, err := b.NewTree(keys)
			if err != nil {
				t.Fatal(err)
			}
			sameTree(t, fmt.Sprintf("%s, case %d", order, i), got, want)
			if got.Root().Cmp(hexInt(t, c.Root)) != 0 {
				t.Errorf("%s, case %d: root %s, want %s", order, i, got.RootHex(), c.Root)
			}
		}
	}
}

// A run of lists that differ in a few serial numbers, as one issuer key's
// CRLs do: some added, some gone, one the same as the one before, one
// empty, one of a single key. Each tree is NewTree's, in the order given,
// in the reverse order and in shuffled orders; and a list that is the same
// as the one before, or differs in one key, takes almost no new hash.
func TestTreeBuilderRun(t *testing.T) {
	r := rand.New(rand.NewPCG(439, 1))
	base := randomKeys(t, r, 5000)
	without := func(keys []Key, n int) []Key { return slices.Clone(keys[n:]) }
	with := func(keys []Key, n int) []Key { return append(slices.Clone(keys), randomKeys(t, r, n)...) }
	lists := [][]Key{
		base,
		with(base, 7),             // some added
		without(with(base, 7), 5), // some gone, some added
		without(with(base, 7), 5), // the same again
		without(base, 4999),       // one key
		nil,                       // none
		base,                      // back to the first
		with(without(base, 300), 200),
	}
	// The same keys in another order are the same list to a tree.
	shuffled := slices.Clone(lists[1])
	r.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })
	lists = append(lists, shuffled)

	want := make([]*Tree, len(lists))
	for i, keys := range lists {
		var err error
		if want[i], err = NewTree(keys); err != nil {
			t.Fatal(err)
		}
	}
	orders := [][]int{nil, nil}
	for i := range lists {
		orders[0] = append(orders[0], i)
		orders[1] = append(orders[1], len(lists)-1-i)
	}
	for range 5 {
		orders = append(orders, r.Perm(len(lists)))
	}
	for _, order := range orders {
		var b TreeBuilder
		for _, i := range order {
			got, err := b.NewTree(lists[i])
			if err != nil {
				t.Fatal(err)
			}
			sameTree(t, fmt.Sprintf("order %v, list %d", order, i), got, want[i])
			// A proof of absence reads the same tree.
			absent := randomKeys(t, r, 1)[0]
			pg, errG := got.ProveAbsent(absent)
			pw, errW := want[i].ProveAbsent(absent)
			if (errG == nil) != (errW == nil) || (errG == nil && (pg.Root.Cmp(pw.Root) != 0 || pg.OldKey.Cmp(pw.OldKey) != 0 || pg.IsOld0 != pw.IsOld0)) {
				t.Fatalf("order %v, list %d: the proofs of absence differ", order, i)
			}
		}
	}

	// What reusing saves: the first tree computes every hash, the same list
	// again none, a list with a few keys more or fewer a few paths' worth.
	var b TreeBuilder
	first, _ := b.NewTree(lists[0])
	if b.Computed() != first.Hashes() {
		t.Errorf("the first tree computed %d of its %d hashes", b.Computed(), first.Hashes())
	}
	if _, _ = b.NewTree(lists[0]); b.Computed() != 0 {
		t.Errorf("the same list again computed %d hashes", b.Computed())
	}
	if _, _ = b.NewTree(lists[1]); b.Computed() == 0 || b.Computed() > 7*40 {
		t.Errorf("7 keys more computed %d hashes", b.Computed())
	}
	// Only the last tree's hashes are kept: after an unrelated list, the first is computed anew.
	if _, _ = b.NewTree(randomKeys(t, r, 10)); b.Computed() == 0 {
		t.Error("an unrelated list computed nothing")
	}
	if again, _ := b.NewTree(lists[0]); b.Computed() != again.Hashes() {
		t.Errorf("after an unrelated list the first computed %d of its %d hashes", b.Computed(), again.Hashes())
	}
}

// Keys that share many low bits of the path: the tree before has a leaf
// where the next has a branch many levels deep, and the other way round,
// so the leaf of the tree before is carried down level after level, on its
// own side only. Every list after every other, node for node NewTree's.
func TestTreeBuilderSharedLowBits(t *testing.T) {
	bit := func(bits ...uint) Key {
		x := big.NewInt(1)
		for _, b := range bits {
			x.SetBit(x, int(b), 1)
		}
		k, err := KeyFromInt(x)
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	lists := [][]Key{
		nil,
		{bit()},
		{bit(), bit(100)},
		{bit(100)},
		{bit(), bit(100), bit(100, 120)},
		{bit(100), bit(100, 126)},
		{bit(60), bit(100)},
		{bit(), bit(126)},
		{bit(1), bit(2), bit(1, 2)},
		{bit(), bit(100), bit(100, 120), bit(60), bit(126), bit(1), bit(2)},
	}
	want := make([]*Tree, len(lists))
	for i, keys := range lists {
		var err error
		if want[i], err = NewTree(keys); err != nil {
			t.Fatal(err)
		}
	}
	for i := range lists {
		for j := range lists {
			var b TreeBuilder
			if _, err := b.NewTree(lists[i]); err != nil {
				t.Fatal(err)
			}
			got, err := b.NewTree(lists[j])
			if err != nil {
				t.Fatal(err)
			}
			sameTree(t, fmt.Sprintf("list %d after list %d", j, i), got, want[j])
			if i == j && b.Computed() != 0 {
				t.Errorf("list %d again: %d hashes computed", i, b.Computed())
			}
		}
	}
}

// Keys that cannot be in one tree are an error from a builder as from
// NewTree, and leave the builder as it was.
func TestTreeBuilderCollision(t *testing.T) {
	var b TreeBuilder
	keys := keysOfInts(t, 5, 6, 7)
	if _, err := b.NewTree(keys); err != nil {
		t.Fatal(err)
	}
	a := keysOfInts(t, 9)[0]
	if _, err := b.NewTree([]Key{a, a}); err == nil {
		t.Fatal("a key twice built a tree")
	}
	if _, err := b.NewTree(keys); err != nil || b.Computed() != 0 {
		t.Fatalf("after a refused list the builder computed %d hashes for the list before (%v)", b.Computed(), err)
	}
}

// Every file of crl/testdata/ and crl/testdata/times/: an Indexer gives
// IndexFile's line for each, in the order of the names, in the reverse
// order and shuffled, usable or not, under the test key and under MOICA's.
func TestIndexerIsIndexFile(t *testing.T) {
	var files [][]byte
	var names []string
	for _, dir := range []string{"testdata", filepath.Join("testdata", "times")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".crl") {
				names = append(names, filepath.Join(dir, e.Name()))
				files = append(files, mustRead(t, filepath.Join(dir, e.Name())))
			}
		}
	}
	if len(files) < 100 {
		t.Fatalf("%d files", len(files))
	}
	moica, err := MOICAKeys()
	if err != nil {
		t.Fatal(err)
	}
	r := rand.New(rand.NewPCG(439, 2))
	for _, keys := range [][]NamedKey{testKeys(t), moica, nil} {
		want := make([]IndexLine, len(files))
		usable := 0
		for i, der := range files {
			want[i] = IndexFile(der, keys)
			if want[i].Usable() {
				usable++
			}
		}
		if len(keys) == 1 && usable < 10 {
			t.Fatalf("%d usable files under the test key", usable)
		}
		orders := [][]int{nil, nil, r.Perm(len(files)), r.Perm(len(files))}
		for i := range files {
			orders[0] = append(orders[0], i)
			orders[1] = append(orders[1], len(files)-1-i)
		}
		for n, order := range orders {
			x := NewIndexer(keys)
			for _, i := range order {
				if got := x.IndexFile(files[i]); got != want[i] {
					t.Fatalf("order %d, %s:\n got  %s want %s", n, names[i], got.Line(), want[i].Line())
				}
			}
		}
	}
}

// BuildIndexOf reads one file at a time, in the order given: a file is
// read only after the one before it was indexed; a file that is left out
// has no line and no progress; an error stops everything.
func TestBuildIndexOfReadsOneAtATime(t *testing.T) {
	keys := testKeys(t)
	var log []string
	file := func(name string) ArchiveFile {
		return ArchiveFile{Name: name, Read: func() ([]byte, error) {
			log = append(log, "read "+name)
			return mustRead(t, filepath.Join("testdata", name)), nil
		}}
	}
	gone := ArchiveFile{Name: "gone.crl", Read: func() ([]byte, error) {
		log = append(log, "read gone.crl")
		return nil, ErrLeftOut
	}}
	files := []ArchiveFile{file("one.crl"), gone, file("duplicate.crl"), file("empty.crl")}
	lines, err := BuildIndexOf(files, keys, func(name string) { log = append(log, "index "+name) })
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"read one.crl", "index one.crl", "read gone.crl", "read duplicate.crl", "index duplicate.crl", "read empty.crl", "index empty.crl"}; !slices.Equal(log, want) {
		t.Errorf("order of reading and indexing: %v", log)
	}
	want := []IndexLine{IndexFile(mustRead(t, "testdata/one.crl"), keys), IndexFile(mustRead(t, "testdata/duplicate.crl"), keys), IndexFile(mustRead(t, "testdata/empty.crl"), keys)}
	SortIndex(want)
	if !slices.Equal(lines, want) {
		t.Errorf("lines %v, want %v", lines, want)
	}

	broken := errors.New("the connection broke")
	log = nil
	files = []ArchiveFile{file("one.crl"), {Name: "x.crl", Read: func() ([]byte, error) { return nil, broken }}, file("empty.crl")}
	if _, err := BuildIndexOf(files, keys, nil); !errors.Is(err, broken) {
		t.Errorf("a file that cannot be read: %v", err)
	}
	if !slices.Equal(log, []string{"read one.crl"}) {
		t.Errorf("after an error nothing more is read: %v", log)
	}

	// RebuildArchiveOf with these files is RebuildArchive of a directory that holds them.
	dir := copyArchive(t, "one", "duplicate", "empty")
	index := FormatIndex(want)
	if err := os.WriteFile(filepath.Join(dir, IndexFileName), index, 0o644); err != nil {
		t.Fatal(err)
	}
	fromDir, diffsDir, err := RebuildArchive(dir, keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	fromFiles, diffsFiles, err := RebuildArchiveOf(index, true, []ArchiveFile{file("empty.crl"), gone, file("one.crl"), file("duplicate.crl")}, keys, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(diffsDir) != 0 || len(diffsFiles) != 0 || !reflect.DeepEqual(fromDir, fromFiles) {
		t.Errorf("the archive of the files is not the archive of the directory: %v / %v", diffsDir, diffsFiles)
	}
	if _, diffs, _ := RebuildArchiveOf(nil, false, nil, keys, nil); len(diffs) != 1 || diffs[0].Problem != "is missing" {
		t.Errorf("no index: %v", diffs)
	}
}
