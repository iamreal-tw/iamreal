// Off-circuit Poseidon2, the field hash of the circuits.
import { BarretenbergSync } from "@aztec-foundation/bb.js";

const toBytes = (x) => Buffer.from(x.toString(16).padStart(64, "0"), "hex");
const fromBytes = (b) => BigInt("0x" + Buffer.from(b).toString("hex"));

/** Barretenberg's Poseidon2 sponge. */
export async function loadPoseidon2() {
  const bb = await BarretenbergSync.initSingleton();
  const hash = (inputs) => fromBytes(bb.poseidon2Hash({ inputs: inputs.map(toBytes) }).hash);
  return { hash2: (a, b) => hash([a, b]), hash3: (a, b, c) => hash([a, b, c]) };
}

/** `state = H(state, x)` from 0: the chain behind the nullifier (and pk_commit). */
export function chunkedHash(h, inputs) {
  return inputs.reduce((state, x) => h.hash2(state, x), 0n);
}
