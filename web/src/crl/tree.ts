// The revocation tree (spec/revocation-tree.md, "Tree"): circomlib's sparse
// Merkle tree over the keys, hashed with Poseidon2.
//
//   node(S, l) = 0                         if S is empty
//              = Poseidon2(k, 1, 1)        if S = {k}
//              = Poseidon2(node(S0, l+1), node(S1, l+1))   otherwise
//
// Bit l counts from the least significant bit. Built in one recursive pass
// that keeps only the nodes on the recursion stack and the siblings of one
// path, over 160-bit keys.
// The tree can be built in 2^D parts by the D low bits of the keys (the
// parts run in workers, parallel.ts) and joined by `combine`.
import { KEY_WORDS } from "./crl.ts";

export const SMT_DEPTH = 128;

/** Poseidon2 behind the tree. Node values may be bytes or bigint. */
export interface TreeHasher<N> {
  zero: N;
  leaf(keys: Uint32Array, i: number): N;
  branch(left: N, right: N): N;
  toBigInt(node: N): bigint;
}

/** Where the path of the target ends inside one built part. */
export type PathEnd = { isOld0: true } | { isOld0: false; oldKey: bigint } | { inTree: true };

export interface PartResult {
  root: bigint;
  /** Siblings at depths `depth` .. 127 (index = depth), only when a target was given. */
  siblings?: bigint[];
  end?: PathEnd;
}

const keyBit = (keys: Uint32Array, i: number, d: number): number => (keys[i * KEY_WORDS + (d >>> 5)]! >>> (d & 31)) & 1;

function keyBig(keys: Uint32Array, i: number): bigint {
  let x = 0n;
  for (let w = KEY_WORDS - 1; w >= 0; w--) x = (x << 32n) | BigInt(keys[i * KEY_WORDS + w]!);
  return x;
}

/**
 * The subtree, from level `depth` down, over the first `count` keys (all of
 * which share their `depth` low bits), and the path of `target` (KEY_WORDS
 * words) if given. Keys must be distinct in their lowest 127 bits.
 */
export function buildPart<N>(keys: Uint32Array, count: number, hasher: TreeHasher<N>, target: Uint32Array | null, depth: number): PartResult {
  const idx = new Int32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  const targetBit = (d: number): number => (target![d >>> 5]! >>> (d & 31)) & 1;
  const siblings: N[] = [];
  let end: PathEnd | null = null;

  const node = (lo: number, hi: number, d: number, onPath: boolean): N => {
    const n = hi - lo;
    if (n === 0) {
      if (onPath) end = { isOld0: true };
      return hasher.zero;
    }
    if (n === 1) {
      if (onPath) {
        const k = idx[lo]!;
        let same = true;
        for (let w = 0; w < KEY_WORDS; w++) if (keys[k * KEY_WORDS + w] !== target![w]) same = false;
        end = same ? { inTree: true } : { isOld0: false, oldKey: keyBig(keys, k) };
      }
      return hasher.leaf(keys, idx[lo]!);
    }
    if (d >= SMT_DEPTH - 1) throw new Error("keys collide on the whole path");
    let i = lo;
    let j = hi - 1;
    while (i <= j) {
      if (keyBit(keys, idx[i]!, d) === 0) i++;
      else {
        const t = idx[i]!;
        idx[i] = idx[j]!;
        idx[j] = t;
        j--;
      }
    }
    let left: N;
    let right: N;
    if (onPath && targetBit(d) === 0) {
      left = node(lo, i, d + 1, true);
      right = node(i, hi, d + 1, false);
      siblings[d] = right;
    } else if (onPath) {
      left = node(lo, i, d + 1, false);
      right = node(i, hi, d + 1, true);
      siblings[d] = left;
    } else {
      left = node(lo, i, d + 1, false);
      right = node(i, hi, d + 1, false);
    }
    return hasher.branch(left, right);
  };

  const root = hasher.toBigInt(node(0, count, depth, target !== null));
  if (!target) return { root };
  const sib: bigint[] = [];
  for (let d = depth; d < SMT_DEPTH; d++) sib[d] = siblings[d] === undefined ? 0n : hasher.toBigInt(siblings[d]!);
  return { root, siblings: sib, end: end! };
}

export interface Group {
  keys: Uint32Array;
  count: number;
}

/** Groups the keys by their `D` low bits. */
export function partition(keys: Uint32Array, count: number, D: number): Group[] {
  const G = 1 << D;
  const mask = G - 1;
  const sizes = new Uint32Array(G);
  for (let i = 0; i < count; i++) sizes[keys[i * KEY_WORDS]! & mask]!++;
  const groups: Group[] = Array.from({ length: G }, (_, g) => ({ keys: new Uint32Array(sizes[g]! * KEY_WORDS), count: 0 }));
  for (let i = 0; i < count; i++) {
    const grp = groups[keys[i * KEY_WORDS]! & mask]!;
    grp.keys.set(keys.subarray(i * KEY_WORDS, (i + 1) * KEY_WORDS), grp.count * KEY_WORDS);
    grp.count++;
  }
  return groups;
}

/** A proof of absence in the shape of the circuit's inputs (spec/revocation-tree.md). */
export interface AbsenceProof {
  root: bigint;
  /** From the root down, zero after the end of the path; 128 entries. */
  siblings: bigint[];
  isOld0: boolean;
  oldKey: bigint;
  oldValue: bigint;
}

export type TreeResult = { inTree: false; proof: AbsenceProof } | { inTree: true; root: bigint };

/**
 * The whole tree from its 2^D parts. `parts[g]` is `buildPart` of group g at
 * depth D, with the target only in the target's group. `groups[g].count` is
 * the number of keys in group g; a single key of a group is in `singles[g]`.
 */
export async function combine(
  D: number,
  counts: number[],
  parts: PartResult[],
  singles: (bigint | null)[],
  target: bigint,
  hash2: (a: bigint, b: bigint) => Promise<bigint>,
): Promise<TreeResult> {
  interface Top {
    value: bigint;
    count: number;
  }
  const memo = new Map<string, Top>();
  const node = async (prefix: number, depth: number): Promise<Top> => {
    const key = `${depth}:${prefix}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let top: Top;
    if (depth === D) top = { value: parts[prefix]!.root, count: counts[prefix]! };
    else {
      const l = await node(prefix, depth + 1);
      const r = await node(prefix | (1 << depth), depth + 1);
      const count = l.count + r.count;
      // A subtree with at most one key is that key's leaf, or empty.
      if (count === 0) top = { value: 0n, count };
      else if (count === 1) top = { value: l.count ? l.value : r.value, count };
      else top = { value: await hash2(l.value, r.value), count };
    }
    memo.set(key, top);
    return top;
  };
  const root = (await node(0, 0)).value;

  // Walk the top D levels along the target's bits.
  const siblings: bigint[] = Array(SMT_DEPTH).fill(0n);
  let prefix = 0;
  let depth = 0;
  let here = await node(0, 0);
  while (depth < D && here.count >= 2) {
    const bit = Number((target >> BigInt(depth)) & 1n);
    const other = await node(prefix | ((1 - bit) << depth), depth + 1);
    siblings[depth] = other.value;
    prefix |= bit << depth;
    depth++;
    here = await node(prefix, depth);
  }
  if (here.count === 0) return { inTree: false, proof: { root, siblings, isOld0: true, oldKey: 0n, oldValue: 0n } };
  if (here.count === 1) {
    // The only key below this node: in which group is it?
    let only: bigint | null = null;
    for (let g = prefix; g < 1 << D; g += 1 << depth) if (counts[g] === 1) only = singles[g]!;
    if (only === null) throw new Error("internal: single key not found");
    if (only === target) return { inTree: true, root };
    return { inTree: false, proof: { root, siblings, isOld0: false, oldKey: only, oldValue: 1n } };
  }
  // depth === D and the target's group holds two or more keys: its part has the rest.
  const part = parts[prefix]!;
  const end = part.end!;
  if ("inTree" in end) return { inTree: true, root };
  for (let d = D; d < SMT_DEPTH; d++) siblings[d] = part.siblings![d]!;
  return end.isOld0
    ? { inTree: false, proof: { root, siblings, isOld0: true, oldKey: 0n, oldValue: 0n } }
    : { inTree: false, proof: { root, siblings, isOld0: false, oldKey: end.oldKey, oldValue: 1n } };
}

/** The circuit's check (smt.nr, assert_not_in_tree), recomputed: the proof leads back to the root. */
export async function checkAbsence(
  proof: AbsenceProof,
  key: bigint,
  hash2: (a: bigint, b: bigint) => Promise<bigint>,
  hash3: (a: bigint, b: bigint, c: bigint) => Promise<bigint>,
): Promise<boolean> {
  if (!proof.isOld0 && proof.oldKey === key) return false;
  if (proof.siblings.length !== SMT_DEPTH || proof.siblings[SMT_DEPTH - 1] !== 0n) return false;
  let levels = 0;
  for (let d = 0; d < SMT_DEPTH; d++) if (proof.siblings[d] !== 0n) levels = d + 1;
  let node = proof.isOld0 ? 0n : await hash3(proof.oldKey, 1n, 1n);
  if (!proof.isOld0) {
    // The old leaf must sit on the key's path: same low bits up to the end of the path.
    const mask = (1n << BigInt(levels)) - 1n;
    if ((proof.oldKey & mask) !== (key & mask)) return false;
  }
  for (let d = levels - 1; d >= 0; d--) {
    const sib = proof.siblings[d]!;
    node = (key >> BigInt(d)) & 1n ? await hash2(sib, node) : await hash2(node, sib);
  }
  return node === proof.root;
}
