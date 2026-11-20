// Barretenberg's Poseidon2 hash over the BN254 scalar field
// (spec/scoped-id.md, "Poseidon2"), computed by the same WebAssembly module
// that verifies proofs (src/engine.ts). The Worker has no Poseidon2 of its
// own: the revocation tree is built with this one.
import { bigintOfBytes } from "iamreal-protocol/bytes.ts";
import { P } from "iamreal-protocol/field.ts";
import { callEngine, dropEngine } from "./engine.ts";

/**
 * The Poseidon2 hash of `inputs`, each a field element as 32 big-endian
 * bytes; the hash is one too. It is synchronous: one call is one call into
 * the module.
 *
 * Throws a RangeError, without asking the module, if an input is not 32
 * bytes or not below the field's modulus: a value has one spelling. Throws
 * an EngineError (src/engine.ts) if the module throws or does not start.
 */
export function poseidon2Hash(inputs: readonly Uint8Array[]): Uint8Array {
  for (const input of inputs) {
    if (input.length !== 32 || bigintOfBytes(input) >= P) throw new RangeError("not a field element of 32 bytes");
  }
  const [kind, answer] = callEngine("Poseidon2Hash", { inputs: inputs.map((input) => input.slice()) });
  const hash = answer.hash;
  if (kind !== "Poseidon2HashResponse" || !(hash instanceof Uint8Array) || hash.length !== 32) {
    dropEngine();
    throw new Error(`Poseidon2Hash answered ${kind}`);
  }
  return new Uint8Array(hash);
}
