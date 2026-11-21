// Reference sparse Merkle tree with circomlib's layout, over any 2-/3-input
// field hash. Small and slow on purpose: it is here to be read.
//
//   leaf   = H(key, value, 1)
//   branch = H(left, right)
//   empty  = 0
//   A subtree with a single leaf is that leaf; the path follows the key's
//   bits, least significant first.
import { SMT_DEPTH } from "./inputs.mjs";

const bit = (key, i) => (key >> BigInt(i)) & 1n;

export class Smt {
  /** hash2(a, b) and hash3(a, b, c) take and return BigInt. */
  constructor(hash2, hash3) {
    this.hash2 = hash2;
    this.hash3 = hash3;
    this.leaves = new Map(); // key -> value
  }

  insert(key, value = 1n) {
    this.leaves.set(key, value);
  }

  #node(keys, depth) {
    if (keys.length === 0) return 0n;
    if (keys.length === 1) return this.hash3(keys[0], this.leaves.get(keys[0]), 1n);
    if (depth === SMT_DEPTH) throw new Error("keys collide on the whole path");
    const left = keys.filter((k) => bit(k, depth) === 0n);
    const right = keys.filter((k) => bit(k, depth) === 1n);
    return this.hash2(this.#node(left, depth + 1), this.#node(right, depth + 1));
  }

  root() {
    return this.#node([...this.leaves.keys()], 0);
  }

  /** Non-membership proof for `key`, in the shape the circuits take. */
  proveAbsent(key) {
    if (this.leaves.has(key)) throw new Error("key is in the tree");
    const siblings = [];
    let keys = [...this.leaves.keys()];
    let depth = 0;
    while (keys.length > 1) {
      const side = bit(key, depth);
      siblings.push(this.#node(keys.filter((k) => bit(k, depth) !== side), depth + 1));
      keys = keys.filter((k) => bit(k, depth) === side);
      depth++;
    }
    while (siblings.length < SMT_DEPTH) siblings.push(0n);
    const isOld0 = keys.length === 0;
    return {
      root: this.root(),
      siblings,
      oldKey: isOld0 ? 0n : keys[0],
      oldValue: isOld0 ? 0n : this.leaves.get(keys[0]),
      isOld0,
    };
  }
}
