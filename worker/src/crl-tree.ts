// The root of the revocation tree (spec/revocation-tree.md, "Tree"):
// circomlib's sparse Merkle tree over the keys, every value 1.
//
//   node(S, l) = 0                                       if S is empty
//              = Poseidon2(k, 1, 1)                      if S = {k}
//              = Poseidon2(node(S0, l+1), node(S1, l+1)) otherwise
//
// S0 and S1 hold the keys whose bit l, from the least significant, is 0 and
// 1. Only the root is wanted, so no node is kept: the only hashes alive are
// those on the way down to the subtree being built.
//
// MOICA's G2 CRL takes about 830,000 hashes, some 25 seconds. The Worker
// has one thread, so the tree is built in parts, the subtrees PART_LEVELS
// below the root, and `pause` is awaited between them: a request that
// arrived meanwhile is answered then (#26).
import { KEY_WORDS, type TreeKeys, reversed } from "./crl.ts";
import type { Poseidon2Hash } from "./poseidon2.ts";

/** The tree is built in up to 2^12 parts, each a subtree 12 levels below the root. */
const PART_LEVELS = 12;
/** A pause comes once the parts built since the last one hold this many keys: about 20 ms of hashing. */
const KEYS_BETWEEN_PAUSES = 256;

export interface TreeRoot {
  /** The root, a field element as 32 big-endian bytes. */
  readonly root: Uint8Array;
  /** How many Poseidon2 hashes it took. */
  readonly hashes: number;
}

const ZERO = new Uint8Array(32);
const ONE = new Uint8Array(32);
ONE[31] = 1;

/**
 * The root of the tree of `keys`, which are sorted and distinct in their
 * lowest 127 bits (src/crl.ts, `TreeKeys`). `pause` is awaited between
 * parts of the work; it should let other events run.
 */
export async function treeRoot(keys: TreeKeys, hash: Poseidon2Hash, pause: () => Promise<void>): Promise<TreeRoot> {
  const { words } = keys;
  let hashes = 0;
  let sincePause = 0;

  /** Bit `level` of key `i`. */
  const bit = (i: number, level: number): number => (words[i * KEY_WORDS + (level >>> 5)]! >>> (31 - (level & 31))) & 1;

  /** Where the keys of [lo, hi), which agree below `level`, change from bit 0 to bit 1 at `level`. */
  const split = (lo: number, hi: number, level: number): number => {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bit(mid, level) === 1) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  const leaf = (i: number): Uint8Array => {
    const key = new Uint8Array(32);
    const view = new DataView(key.buffer);
    // The five words back in the order of the integer (src/crl.ts, `TreeKeys`).
    for (let w = 0; w < KEY_WORDS; w++) view.setUint32(28 - w * 4, w < 4 ? reversed(words[i * KEY_WORDS + w]!) : words[i * KEY_WORDS + w]!);
    hashes++;
    return hash([key, ONE, ONE]);
  };

  const node = (lo: number, hi: number, level: number): Uint8Array => {
    if (hi === lo) return ZERO;
    if (hi - lo === 1) return leaf(lo);
    if (level >= 127) throw new Error("two keys share their lowest 127 bits");
    const mid = split(lo, hi, level);
    const left = node(lo, mid, level + 1);
    const right = node(mid, hi, level + 1);
    hashes++;
    return hash([left, right]);
  };

  /** `node`, with pauses: the levels above the parts. */
  const top = async (lo: number, hi: number, level: number): Promise<Uint8Array> => {
    if (hi - lo <= 1 || level === PART_LEVELS) {
      if (sincePause >= KEYS_BETWEEN_PAUSES) {
        await pause();
        sincePause = 0;
      }
      sincePause += hi - lo;
      return node(lo, hi, level);
    }
    const mid = split(lo, hi, level);
    const left = await top(lo, mid, level + 1);
    const right = await top(mid, hi, level + 1);
    hashes++;
    return hash([left, right]);
  };

  const root = await top(0, keys.count, 0);
  return { root, hashes };
}
