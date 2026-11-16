// Poseidon2 for the tree, from Barretenberg (bb.js): the same implementation
// the proof uses (ADR-0015), not a second one to keep in step with the
// circuit. Node values stay 32-byte arrays; no bigint per hash.
import { bigintOfBytes, bytesOfBigint } from "../bytes.ts";
import { KEY_WORDS } from "./crl.ts";
import type { TreeHasher } from "./tree.ts";

/** What the tree needs from a BarretenbergSync. */
export interface SyncPoseidon2 {
  poseidon2Hash(req: { inputs: Uint8Array[] }): { hash: Uint8Array };
}

function keyBytes(keys: Uint32Array, i: number): Uint8Array {
  const b = new Uint8Array(32);
  for (let w = 0; w < KEY_WORDS; w++) {
    const v = keys[i * KEY_WORDS + w]!;
    const o = 31 - w * 4;
    b[o] = v & 0xff;
    b[o - 1] = (v >>> 8) & 0xff;
    b[o - 2] = (v >>> 16) & 0xff;
    b[o - 3] = (v >>> 24) & 0xff;
  }
  return b;
}

export function bytesHasher(bb: SyncPoseidon2): TreeHasher<Uint8Array> {
  const zero = new Uint8Array(32);
  const one = new Uint8Array(32);
  one[31] = 1;
  return {
    zero,
    leaf: (keys, i) => bb.poseidon2Hash({ inputs: [keyBytes(keys, i), one, one] }).hash,
    branch: (l, r) => bb.poseidon2Hash({ inputs: [l, r] }).hash,
    toBigInt: (n) => bigintOfBytes(n),
  };
}

/** Poseidon2 of field elements given as bigint, through a BarretenbergSync. */
export function syncHash(bb: SyncPoseidon2, ...xs: bigint[]): bigint {
  return bigintOfBytes(bb.poseidon2Hash({ inputs: xs.map((x) => bytesOfBigint(x, 32)) }).hash);
}
