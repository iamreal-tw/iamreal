// The Go verifier's test proofs (verifier/testdata/README.md): one real
// proof per circuit, made with throwaway keys, and the public inputs
// `bb prove` wrote next to each.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_DIR } from "./build.ts";

const TESTDATA = join(WORKER_DIR, "..", "verifier", "testdata");

export const CIRCUITS = ["card_proof_rs2048", "card_proof_rs4096"] as const;
export type CircuitName = (typeof CIRCUITS)[number];

/** The BN254 scalar field modulus, 32 bytes big-endian (spec/proof-verification.md). */
export const P_HEX = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";

/** `bytes` cut into the 32-byte values it is made of. */
export function fields(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length % 32 !== 0) throw new Error(`${bytes.length} bytes is not a whole number of fields`);
  return Array.from({ length: bytes.length / 32 }, (_, i) => bytes.slice(32 * i, 32 * i + 32));
}

export interface TestProof {
  readonly circuit: CircuitName;
  /** 14,656 bytes. */
  readonly proof: Uint8Array;
  readonly publicInputs: Uint8Array[];
  /** The proof of the same witness made without zero knowledge: 13,120 bytes. */
  readonly noZkProof: Uint8Array;
}

export function testProof(circuit: CircuitName): TestProof {
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(TESTDATA, name)));
  return {
    circuit,
    proof: read(`${circuit}.proof`),
    publicInputs: fields(read(`${circuit}.public_inputs`)),
    noZkProof: read(`${circuit}.no-zk.proof`),
  };
}
