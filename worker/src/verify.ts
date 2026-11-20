// Verifying a card proof (spec/proof-verification.md) with Barretenberg
// (ADR-0023, #16). The back end reaches it only through `ProofVerifier`, so
// that verifying somewhere else (the native `bb` in a container) replaces
// the implementation and nothing around it. The verifier that runs in the
// Worker is `proofVerifier` of src/in-worker.ts.
//
// What is checked here before Barretenberg sees anything is what the Go
// verifier checks before it runs `bb` (verifier/verify.go, VerifyProof):
// the proof's length, the count of public inputs, each value below the
// field's modulus. On exactly these inputs the module and the native `bb`
// fail in different ways (#16), so neither is asked.
import { bigintOfBytes } from "iamreal-protocol/bytes.ts";
import { P } from "iamreal-protocol/field.ts";
import { CIRCUITS, type CircuitName, PROOF_LENGTH } from "./circuits.ts";
import { type Engine, EngineError } from "./engine.ts";

/** `bb verify -t noir-recursive`, as bb.js 6.0.0 spells it (src/barretenberg/backend.ts). */
const NOIR_RECURSIVE = { ipa_accumulation: false, oracle_hash_type: "poseidon2", disable_zk: false, optimized_solidity_verifier: false };

/** The one thing the back end asks of a proof verifier. */
export interface ProofVerifier {
  /**
   * Whether `proof` proves the statement of the circuit named `circuit`
   * (`card_proof_rs2048` or `card_proof_rs4096`) for `publicInputs`, each a
   * 32-byte big-endian integer, in the circuit's order.
   *
   * Resolves to true only for a proof that verifies. Everything that is
   * wrong with the request resolves to false: a name that is no circuit, a
   * proof of another length, another count or size of inputs, a value not
   * below the field's modulus, a proof that does not verify, a proof the
   * verifier throws on or gives no verdict for.
   *
   * Rejects when the verifier itself could not run. That is not a
   * rejection of the proof and it is not a verdict at all: the caller must
   * not treat it as accepted, and must not write the record. In the Worker
   * it is an EngineError with `notStarted` (src/engine.ts).
   */
  verify(circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): Promise<boolean>;
}

/** `bytes` cut into field elements as `bb` reads them: 32 bytes each. Bytes left over at the end are a last, short element. */
export function fieldElements(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += 32) out.push(bytes.slice(at, at + 32));
  return out;
}

/** A verifier that asks `engine`, with each circuit's verification key (the file the Go verifier embeds, verifier/vk/). */
export function proofVerifierOn(engine: Engine, verificationKeys: Readonly<Record<CircuitName, Uint8Array>>): ProofVerifier {
  const verify = (circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): boolean => {
    if (!Object.hasOwn(CIRCUITS, circuit)) return false;
    const name = circuit as CircuitName;
    if (proof.length !== PROOF_LENGTH) return false;
    if (publicInputs.length !== CIRCUITS[name].publicInputCount) return false;
    for (const input of publicInputs) {
      if (input.length !== 32 || bigintOfBytes(input) >= P) return false;
    }
    try {
      const answer = engine.call(
        "CircuitVerify",
        {
          verification_key: verificationKeys[name],
          public_inputs: publicInputs.map((input) => input.slice()),
          proof: fieldElements(proof),
          settings: NOIR_RECURSIVE,
        },
        "CircuitVerifyResponse",
      );
      if (typeof answer.verified === "boolean") return answer.verified;
      // An answer without a verdict: rejected, and the instance that gave it is not used again.
      engine.drop();
      return false;
    } catch (e) {
      // Barretenberg threw on this proof or gave no answer: rejected (the instance is already dropped).
      if (e instanceof EngineError && !e.notStarted) return false;
      throw e;
    }
  };
  return {
    async verify(circuit, proof, publicInputs) {
      return verify(circuit, proof, publicInputs);
    },
  };
}
