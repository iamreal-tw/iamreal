// The accepted circuits (spec/proof-verification.md, "Circuits and proving
// system"): the one list of their names in worker/. The verifier
// (src/verify.ts), the build step that checks the keys
// (scripts/engine-files.ts) and the tests all read it.
//
// One thing cannot read it: src/in-worker.ts imports each key's file by a
// path written out, because an import's path is fixed when the Worker is
// bundled. Its table is typed by `CircuitName`, so a circuit added here and
// not there does not compile.

export const CIRCUITS = {
  card_proof_rs2048: {
    /** How many public inputs a proof of this circuit has. */
    publicInputCount: 23,
    /** SHA-256 of the verification key, verifier/vk/<name>.vk. */
    verificationKeySha256: "816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8",
  },
  card_proof_rs4096: {
    publicInputCount: 40,
    verificationKeySha256: "bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2",
  },
} as const;

export type CircuitName = keyof typeof CIRCUITS;

export const CIRCUIT_NAMES = Object.keys(CIRCUITS) as CircuitName[];

/** A proof is exactly this many bytes (spec/proof-verification.md, "Encoding"). */
export const PROOF_LENGTH = 14656;
