// What the tests of the proof verifier share: the Go verifier's test
// proofs (verifier/testdata/README.md: one real proof per circuit, made
// with throwaway keys, and the public inputs `bb prove` wrote next to
// each), its verification keys, and a few helpers.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bytesOfBigint } from "iamreal-protocol/bytes.ts";
import { CIRCUIT_NAMES, type CircuitName } from "../src/circuits.ts";
import { fieldElements } from "../src/verify.ts";
import { WORKER_DIR } from "./build.ts";

const VERIFIER = join(WORKER_DIR, "..", "verifier");

/** SHA-256 as lowercase hex. */
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** `x` as a 32-byte big-endian value, the form of a public input. `x` need not be below the field's modulus. */
export const bytes32 = (x: bigint): Uint8Array => bytesOfBigint(x, 32);

/** The verification key of a circuit: the file the Go verifier embeds. */
export const verificationKey = (circuit: CircuitName): Uint8Array => new Uint8Array(readFileSync(join(VERIFIER, "vk", `${circuit}.vk`)));

/** The key of every circuit. */
export function verificationKeys(): Record<CircuitName, Uint8Array> {
  return Object.fromEntries(CIRCUIT_NAMES.map((c) => [c, verificationKey(c)])) as Record<CircuitName, Uint8Array>;
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
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(VERIFIER, "testdata", name)));
  return {
    circuit,
    proof: read(`${circuit}.proof`),
    publicInputs: fieldElements(read(`${circuit}.public_inputs`)),
    noZkProof: read(`${circuit}.no-zk.proof`),
  };
}
