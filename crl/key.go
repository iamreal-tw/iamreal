package crl

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"math/bits"
	"slices"
	"strings"
)

// MaxSerialBytes is the longest serial number, in content bytes.
const MaxSerialBytes = 20

// Key is a tree key: a serial number's content bytes read as an unsigned
// big-endian integer, below 2^160. It is stored as 20 big-endian bytes.
type Key [MaxSerialBytes]byte

// KeyFromSerial returns the key of a serial number given as its DER content
// bytes. Following spec/revocation-tree.md, the key is those bytes read as
// an unsigned integer. A serial number that is empty, longer than 20 bytes,
// negative, or not minimally encoded is an error.
func KeyFromSerial(content []byte) (Key, error) {
	var k Key
	switch {
	case len(content) == 0:
		return k, errors.New("empty serial number")
	case len(content) > MaxSerialBytes:
		return k, fmt.Errorf("serial number of %d bytes, more than %d", len(content), MaxSerialBytes)
	case content[0]&0x80 != 0:
		return k, errors.New("negative serial number")
	case len(content) > 1 && content[0] == 0 && content[1]&0x80 == 0:
		return k, errors.New("serial number not minimally encoded")
	}
	copy(k[MaxSerialBytes-len(content):], content)
	return k, nil
}

// KeyFromInt returns the key with value x, which must be below 2^160.
func KeyFromInt(x *big.Int) (Key, error) {
	var k Key
	if x.Sign() < 0 || x.BitLen() > 8*MaxSerialBytes {
		return k, fmt.Errorf("key %#x is not below 2^160", x)
	}
	x.FillBytes(k[:])
	return k, nil
}

// ParseKey reads a key written as a hexadecimal integer, with or without
// 0x, optionally with colons between bytes (as openssl prints serials).
func ParseKey(s string) (Key, error) {
	t := strings.TrimPrefix(strings.ReplaceAll(s, ":", ""), "0x")
	x, ok := new(big.Int).SetString(t, 16)
	if !ok || t == "" || strings.HasPrefix(t, "-") || strings.HasPrefix(t, "+") {
		return Key{}, fmt.Errorf("not a hexadecimal integer: %q", s)
	}
	return KeyFromInt(x)
}

// Int returns the key as an integer.
func (k Key) Int() *big.Int { return new(big.Int).SetBytes(k[:]) }

// String returns the key as 0x-prefixed lowercase hex without leading zeros.
func (k Key) String() string { return fmt.Sprintf("%#x", k.Int()) }

// low returns bits 0..63 and 64..127 of k.
func (k Key) low() (lo, hi uint64) {
	return binary.BigEndian.Uint64(k[12:20]), binary.BigEndian.Uint64(k[4:12])
}

// bit returns bit l of k, counting from the least significant bit.
func (k Key) bit(l int) uint {
	return uint(k[MaxSerialBytes-1-l/8]>>(l%8)) & 1
}

// pathOrder is a key's position in the tree: its lowest 127 bits reversed,
// bit 0 most significant. Sorting keys by pathOrder puts every subtree's
// keys next to each other.
type pathOrder struct{ a, b uint64 }

const pathBits = 127

func (k Key) path() pathOrder {
	lo, hi := k.low()
	return pathOrder{bits.Reverse64(lo), bits.Reverse64(hi & (1<<(pathBits-64) - 1))}
}

func (p pathOrder) compare(q pathOrder) int {
	switch {
	case p.a != q.a:
		if p.a < q.a {
			return -1
		}
		return 1
	case p.b != q.b:
		if p.b < q.b {
			return -1
		}
		return 1
	}
	return 0
}

// findCollision reports two indexes of keys that share their lowest 127
// bits, the smallest such pair in sorted order.
func findCollision(keys []Key) (i, j int, ok bool) {
	idx := make([]int, len(keys))
	for n := range idx {
		idx[n] = n
	}
	paths := make([]pathOrder, len(keys))
	for n, k := range keys {
		paths[n] = k.path()
	}
	slices.SortFunc(idx, func(x, y int) int {
		if c := paths[x].compare(paths[y]); c != 0 {
			return c
		}
		return x - y
	})
	for n := 1; n < len(idx); n++ {
		if paths[idx[n-1]] == paths[idx[n]] {
			return idx[n-1], idx[n], true
		}
	}
	return 0, 0, false
}
