// What the flow needs from the proof engine. engine.ts is the page's
// implementation (bb.js); tests may pass another.
import type { CircuitName } from "../issuers.ts";

/** How the engine runs. bb.js falls back to one thread without an error, so the engine says which it is. */
export interface ThreadMode {
  /** The page is cross-origin isolated and SharedArrayBuffer exists. */
  multithreaded: boolean;
  /** Threads the engine asked bb.js for. */
  threads: number;
  /** What bb.js itself reported starting, when it said so. */
  reportedThreads: number | null;
}

/** The only proof settings the page uses: zero knowledge, Poseidon2 transcript (spec/proof-verification.md). Not configurable. */
export const VERIFIER_TARGET = "noir-recursive" as const;
export const PROOF_BYTES = 14_656;

export interface ProofResult {
  proof: Uint8Array;
  publicInputs: bigint[];
}

export interface Prover {
  /** Resolves when the engine can prove; rejects if it cannot start. */
  ready(): Promise<ThreadMode>;
  /** Poseidon2 of two field elements (for the scoped ID). */
  hash2(a: bigint, b: bigint): Promise<bigint>;
  /** Checks the circuit file early (SHA-256), so a bad file stops the flow before the card signs. */
  preloadCircuit(name: CircuitName): Promise<void>;
  /** Witness with noir_js, then an UltraHonk proof under VERIFIER_TARGET. */
  prove(name: CircuitName, inputs: Record<string, unknown>): Promise<ProofResult>;
}
