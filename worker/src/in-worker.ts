// The proof verifier and the Poseidon2 hash as they run in the Worker: one
// Barretenberg instance per isolate, over the WebAssembly module, with the
// two verification keys. The module and the keys are imported from
// `generated/`, where scripts/engine-files.ts puts them at every build
// after checking their SHA-256; the module arrives already compiled.
//
// This is the only file that imports them. What it wires together is in
// src/verify.ts, src/poseidon2.ts, src/engine.ts and src/barretenberg.ts,
// which import nothing from `generated/`, so that they also run in the
// tests' Node (test/engine.test.ts).
import wasm from "../generated/barretenberg.wasm";
import vk2048 from "../generated/card_proof_rs2048.vk.bin";
import vk4096 from "../generated/card_proof_rs4096.vk.bin";
import { Barretenberg } from "./barretenberg.ts";
import type { CircuitName } from "./circuits.ts";
import { Engine } from "./engine.ts";
import { type Poseidon2Hash, poseidon2On } from "./poseidon2.ts";
import { type ProofVerifier, proofVerifierOn } from "./verify.ts";

const engine = new Engine(() => new Barretenberg(wasm));

// One line per circuit of src/circuits.ts: the type does not allow fewer.
const VERIFICATION_KEYS: Readonly<Record<CircuitName, Uint8Array>> = {
  card_proof_rs2048: new Uint8Array(vk2048),
  card_proof_rs4096: new Uint8Array(vk4096),
};

/** The verifier that runs in the Worker (src/verify.ts, `ProofVerifier`). */
export const proofVerifier: ProofVerifier = proofVerifierOn(engine, VERIFICATION_KEYS);

/** The Poseidon2 hash that runs in the Worker (src/poseidon2.ts, `Poseidon2Hash`). */
export const poseidon2Hash: Poseidon2Hash = poseidon2On(engine);
