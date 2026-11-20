// Verifying a card proof (spec/proof-verification.md) inside the Worker,
// with Barretenberg's WebAssembly module (ADR-0023, #16). The back end
// reaches it only through `ProofVerifier`, so that verifying somewhere else
// (the native `bb` in a container) replaces this file and nothing around it.
//
// What is checked here before Barretenberg sees anything is what the Go
// verifier checks before it runs `bb` (verifier/verify.go, VerifyProof):
// the proof's length, the count of public inputs, each value below the
// field's modulus. On exactly these inputs the module and the native `bb`
// fail in different ways (#16), so neither is asked.
import { bigintOfBytes } from "iamreal-protocol/bytes.ts";
import { P } from "iamreal-protocol/field.ts";
import vk2048 from "../generated/card_proof_rs2048.vk.bin";
import vk4096 from "../generated/card_proof_rs4096.vk.bin";
import { EngineError, callEngine, dropEngine } from "./engine.ts";

/** A proof is exactly this many bytes (spec/proof-verification.md, "Encoding"). */
export const PROOF_LENGTH = 14656;

interface Circuit {
  /** The verification key: the file the Go verifier embeds (verifier/vk/). */
  readonly verificationKey: Uint8Array;
  readonly publicInputCount: number;
}

/** The accepted circuits, by name (spec/proof-verification.md, "Circuits and proving system"). */
const CIRCUITS: Readonly<Record<string, Circuit>> = {
  card_proof_rs2048: { verificationKey: new Uint8Array(vk2048), publicInputCount: 23 },
  card_proof_rs4096: { verificationKey: new Uint8Array(vk4096), publicInputCount: 40 },
};

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
   * verifier throws on.
   *
   * Rejects only when the verifier itself could not run, which says
   * nothing about the proof.
   */
  verify(circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): Promise<boolean>;
}

/** `bytes` as the 32-byte values it is made of. */
function fields(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += 32) out.push(bytes.slice(at, at + 32));
  return out;
}

function verifyInWorker(circuit: string, proof: Uint8Array, publicInputs: readonly Uint8Array[]): boolean {
  const c = Object.hasOwn(CIRCUITS, circuit) ? CIRCUITS[circuit] : undefined;
  if (c === undefined) return false;
  if (proof.length !== PROOF_LENGTH) return false;
  if (publicInputs.length !== c.publicInputCount) return false;
  for (const input of publicInputs) {
    if (input.length !== 32 || bigintOfBytes(input) >= P) return false;
  }
  try {
    const [kind, answer] = callEngine("CircuitVerify", {
      verification_key: c.verificationKey,
      public_inputs: publicInputs.map((input) => input.slice()),
      proof: fields(proof),
      settings: NOIR_RECURSIVE,
    });
    if (kind === "CircuitVerifyResponse" && typeof answer.verified === "boolean") return answer.verified;
    // An answer that is not a verdict: rejected, and the instance that gave it is not used again.
    dropEngine();
    return false;
  } catch (e) {
    // The module threw on this proof: rejected (the instance is already dropped).
    if (e instanceof EngineError && !e.notStarted) return false;
    throw e;
  }
}

/** The verifier that runs in the Worker. */
export const proofVerifier: ProofVerifier = {
  async verify(circuit, proof, publicInputs) {
    return verifyInWorker(circuit, proof, publicInputs);
  },
};
