// Sparse Merkle tree in circomlib's layout over any field hash, with proofs
// for any key (also one that is in the tree, to forge with). Memoized.
export const DEPTH = 128;
const bit = (k, i) => (k >> BigInt(i)) & 1n;

export class Tree {
  constructor(h, keys) {
    this.h = h;
    this.keys = [...new Set(keys)];
    this.memo = new Map();
  }
  node(keys, depth) {
    if (keys.length === 0) return 0n;
    if (keys.length === 1) return this.h.hash3(keys[0], 1n, 1n);
    if (depth >= DEPTH) throw new Error("keys collide on the whole path");
    const id = depth + ":" + keys.map(String).sort().join(",");
    if (this.memo.has(id)) return this.memo.get(id);
    const l = keys.filter((k) => bit(k, depth) === 0n);
    const r = keys.filter((k) => bit(k, depth) === 1n);
    const v = this.h.hash2(this.node(l, depth + 1), this.node(r, depth + 1));
    this.memo.set(id, v);
    return v;
  }
  root() {
    return this.node(this.keys, 0);
  }
  /** Path for `key`: siblings until the subtree holds at most one key. */
  proof(key) {
    const siblings = [];
    let keys = this.keys;
    let depth = 0;
    while (keys.length > 1) {
      const side = bit(key, depth);
      siblings.push(this.node(keys.filter((k) => bit(k, depth) !== side), depth + 1));
      keys = keys.filter((k) => bit(k, depth) === side);
      depth++;
    }
    const pathLen = siblings.length;
    while (siblings.length < DEPTH) siblings.push(0n);
    return {
      root: this.root(),
      siblings,
      oldKey: keys.length ? keys[0] : 0n,
      oldValue: keys.length ? 1n : 0n,
      isOld0: keys.length === 0,
      pathLen,
    };
  }
}

/**
 * Builds the proof one side's circuit gets for `serial`, for the plan
 * { revoked, mut, aux }. The same structural plan is applied with each side's
 * hash, so both circuits see "the same" proof. Returns the proof.
 */
export function buildProof(h, serial, plan) {
  const tree = new Tree(h, plan.revoked);
  const p = tree.proof(serial);
  const a = plan.aux ?? {};
  switch (plan.mut) {
    case "none":
      break;
    case "revoked-self": // serial is in the tree: the path ends at its own leaf
      break;
    case "revoked-without": { // proof from the tree without the serial, real root
      const t2 = new Tree(h, plan.revoked.filter((k) => k !== serial));
      const q = t2.proof(serial);
      q.root = p.root;
      return q;
    }
    case "revoked-empty":
      return { ...p, siblings: Array(DEPTH).fill(0n), oldKey: 0n, oldValue: 0n, isOld0: true };
    case "sibling-random": {
      if (p.pathLen === 0) break;
      p.siblings[a.i % p.pathLen] = a.value % h.prime;
      break;
    }
    case "sibling-extra":
      p.siblings[Math.min(p.pathLen + (a.i % 8), DEPTH - 2)] = a.value % h.prime;
      break;
    case "sibling-last":
      p.siblings[DEPTH - 1] = a.value % h.prime;
      break;
    case "drop-last":
      if (p.pathLen > 0) p.siblings[p.pathLen - 1] = 0n;
      break;
    case "isOld0-flip":
      p.isOld0 = !p.isOld0;
      if (p.isOld0 === false && p.oldKey === 0n) { p.oldKey = a.key; p.oldValue = 1n; }
      break;
    case "oldKey-other":
      p.oldKey = a.key;
      break;
    case "oldValue-other":
      p.oldValue = a.value % h.prime;
      break;
    case "oldKey-self":
      p.oldKey = serial;
      p.oldValue = 1n;
      p.isOld0 = false;
      break;
    case "root-other":
      p.root = a.value % h.prime;
      break;
    default:
      throw new Error("smt mutation " + plan.mut);
  }
  return p;
}

/** What the plan should give, from the ADR's rule (serial not in the list). */
export function smtExpect(serial, plan, honestProof) {
  if (plan.revoked.includes(serial)) return false;
  // A path that needs all 128 levels cannot be proven: both circuits require
  // the last sibling to be 0 (circomlib's SMTLevIns). Completeness limit only.
  if (honestProof.pathLen >= DEPTH) return false;
  switch (plan.mut) {
    case "none":
      return true;
    case "oldKey-other":
    case "oldValue-other":
      // With isOld0 the old leaf is not part of the root: a no-op.
      return honestProof.isOld0;
    case "sibling-random":
    case "drop-last":
      return honestProof.pathLen === 0; // nothing on the path to change
    default:
      return false;
  }
}
