// Writes spec/vectors/poseidon2.json: fixed answers for the circuit's field
// hash, computed outside the circuit with Barretenberg's own Poseidon2
// (bb.js). Run it once and commit the file; the tests read the file and never
// recompute it. If a rerun changes the file, the hash changed: nullifiers and
// revocation tree roots would no longer match what is already recorded.
//
//   node tests/vectors/make-poseidon2.mjs
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkedHash, loadPoseidon2 } from "../lib/hashes.mjs";
import { limbs } from "../lib/inputs.mjs";
import { Smt } from "../lib/smt.mjs";

// The BN254 scalar field.
const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const field = (x) => "0x" + x.toString(16).padStart(64, "0");
const h = await loadPoseidon2();

// Deterministic filler: SHA-256 in counter mode over a label.
const bytes = (label, n) => {
  const out = [];
  for (let i = 0; out.length * 32 < n; i++) out.push(createHash("sha256").update(`${label}:${i}`).digest());
  return Buffer.concat(out).subarray(0, n);
};
const big = (b) => BigInt("0x" + b.toString("hex"));
const element = (label) => big(bytes(label, 32)) % P;

const pairs = [
  [0n, 0n], [1n, 2n], [2n, 1n], [P - 1n, P - 1n], [0n, 1n], [(1n << 120n) - 1n, 1n << 120n],
  [element("pair-a"), element("pair-b")],
];
const triples = [
  [0n, 0n, 0n], [1n, 2n, 3n], [1n, 2n, 0n], [P - 1n, P - 1n, P - 1n],
  [0x1234567890abcdef1234567890abcdefn, 1n, 1n], // a revocation tree leaf: (serial, 1, 1)
  [element("triple-a"), element("triple-b"), element("triple-c")],
];

// The nullifier: the 256 signature bytes as a big-endian integer, cut into 18
// limbs of 120 bits, least significant first; then state = hash_2(state, limb)
// from state 0.
const signatures = [
  Buffer.concat([Buffer.from([0x5a]), bytes("signature-1", 255)]),
  Buffer.concat([Buffer.alloc(16), bytes("signature-2", 240)]), // leading zero bytes: a zero top limb
  Buffer.alloc(256, 0xff),
  Buffer.concat([Buffer.alloc(255), Buffer.from([1])]),
];

const serial = (hex) => BigInt("0x" + hex);
const trees = [
  { serials: [], absent: [serial("1234567890abcdef1234567890abcdef")] },
  { serials: [serial("05")], absent: [serial("04"), serial("0d")] },
  {
    serials: [
      serial("1234567890abcdef1234567890abcdee"), // differs from the absent serial in bit 0
      serial("1234567890abcdef1234567890abcdeb"),
      serial("05"),
      serial("1111111111111111111111111111111111111111"), // 20 bytes
      serial("00ffffffffffffffffffffffffffffffff"),
      serial("8000000000000000"),
    ],
    absent: [serial("1234567890abcdef1234567890abcdef"), serial("06"), serial("1111111111111111111111111111111111111110")],
  },
];

const out = {
  spec: "poseidon2",
  status: "draft",
  note: "Barretenberg's Poseidon2 sponge over the BN254 scalar field, as the card proof circuit uses it. "
    + "Field elements are 0x-prefixed, 64 hex digits, big-endian.",
  field_modulus: field(P),
  hash_2: pairs.map((inputs) => ({ inputs: inputs.map(field), hash: field(h.hash2(...inputs)) })),
  hash_3: triples.map((inputs) => ({ inputs: inputs.map(field), hash: field(h.hash3(...inputs)) })),
  scoped_id: {
    note: "signature: 256 bytes, big-endian. limbs: 18 limbs of 120 bits, least significant first. "
      + "scoped_id: state = hash_2(state, limb) over the limbs in order, from state 0.",
    cases: signatures.map((s) => {
      const l = limbs(big(s), 120, 18);
      return { signature: s.toString("hex"), limbs: l.map(field), scoped_id: field(chunkedHash(h, l)) };
    }),
  },
  revocation_tree: {
    note: "circomlib's sparse Merkle tree layout, depth 128, keyed by the certificate serial number, value 1. "
      + "leaf = hash_3(serial, 1, 1); branch = hash_2(left, right); an empty subtree is 0; a subtree with one "
      + "leaf is that leaf; the path follows the serial's bits, least significant first. absent: a "
      + "non-membership proof per serial; siblings are listed from the root down and zero-filled to 128.",
    cases: trees.map(({ serials, absent }) => {
      const tree = new Smt(h.hash2, h.hash3);
      for (const s of serials) tree.insert(s);
      return {
        serials: serials.map((s) => "0x" + s.toString(16)),
        root: field(tree.root()),
        absent: absent.map((s) => {
          const p = tree.proveAbsent(s);
          const last = p.siblings.findLastIndex((x) => x !== 0n);
          return {
            serial: "0x" + s.toString(16),
            siblings: p.siblings.slice(0, last + 1).map(field),
            old_key: "0x" + p.oldKey.toString(16),
            old_value: "0x" + p.oldValue.toString(16),
            is_old0: p.isOld0,
          };
        }),
      };
    }),
  },
};
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "spec", "vectors", "poseidon2.json"), JSON.stringify(out, null, 2) + "\n");
process.exit(0);
