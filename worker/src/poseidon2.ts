// Barretenberg's Poseidon2 hash over the BN254 scalar field
// (spec/scoped-id.md, "Poseidon2"), computed by the same Barretenberg
// instance that verifies proofs. The Worker has no Poseidon2 of its own:
// the revocation tree is built with this one. The hash that runs in the
// Worker is `poseidon2Hash` of src/in-worker.ts.
import { bigintOfBytes } from "iamreal-protocol/bytes.ts";
import { P } from "iamreal-protocol/field.ts";
import { type Engine, EngineError } from "./engine.ts";

/**
 * The Poseidon2 hash of `inputs`, each a field element as 32 big-endian
 * bytes; the hash is one too. It is synchronous: one call is one command
 * to Barretenberg.
 *
 * Throws a RangeError, without asking Barretenberg, if an input is not 32
 * bytes or not below the field's modulus: a value has one spelling. Throws
 * an EngineError (src/engine.ts) if Barretenberg does not start, throws, or
 * answers something that is not a hash; the next call starts a new
 * instance.
 */
export type Poseidon2Hash = (inputs: readonly Uint8Array[]) => Uint8Array;

/** The hash computed by `engine`. */
export function poseidon2On(engine: Engine): Poseidon2Hash {
  return (inputs) => {
    for (const input of inputs) {
      if (input.length !== 32 || bigintOfBytes(input) >= P) throw new RangeError("not a field element of 32 bytes");
    }
    const { hash } = engine.call("Poseidon2Hash", { inputs: inputs.map((input) => input.slice()) }, "Poseidon2HashResponse");
    if (!(hash instanceof Uint8Array) || hash.length !== 32) {
      engine.drop();
      throw new EngineError("Poseidon2Hash answered no hash", false);
    }
    return new Uint8Array(hash);
  };
}
