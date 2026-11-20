// The Worker's Poseidon2 hash (src/in-worker.ts) in the local workerd
// against spec/vectors/poseidon2.json, the answers the Go crl/poseidon2
// and the device's code are tested with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { hexOf } from "iamreal-protocol/bytes.ts";
import { P } from "iamreal-protocol/field.ts";
import { bytes32, testProof } from "./proofs.ts";

interface HashCase {
  readonly inputs: string[];
  readonly hash: string;
}
const vectors = JSON.parse(readFileSync(join(WORKER_DIR, "..", "spec", "vectors", "poseidon2.json"), "utf8")) as {
  field_modulus: string;
  hash_2: HashCase[];
  hash_3: HashCase[];
  scoped_id: { cases: { limbs: string[]; scoped_id: string }[] };
  revocation_tree: { cases: { serials: string[]; root: string }[] };
};

/** A vector's field element (`0x`, up to 64 hex digits) as the 64 digits the Worker takes and gives. */
const field = (s: string): string => s.replace(/^0x/, "").padStart(64, "0");

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
});
after(() => worker.close());

test("the field is the vectors' field", () => {
  assert.equal(BigInt(vectors.field_modulus), P);
});

test("hash_2 and hash_3: every case of the vectors", async () => {
  assert.ok(vectors.hash_2.length > 0 && vectors.hash_3.length > 0);
  for (const [name, cases] of [["hash_2", vectors.hash_2], ["hash_3", vectors.hash_3]] as const) {
    for (const [i, c] of cases.entries()) assert.equal(await worker.poseidon2(c.inputs.map(field)), field(c.hash), `${name} case ${i}`);
  }
});

test("scoped_id: the chain of hash_2 over the limbs, every case of the vectors", async () => {
  assert.ok(vectors.scoped_id.cases.length > 0);
  for (const [i, c] of vectors.scoped_id.cases.entries()) {
    let state = field("0x0");
    for (const limb of c.limbs) state = await worker.poseidon2([state, field(limb)]);
    assert.equal(state, field(c.scoped_id), `case ${i}`);
  }
});

test("revocation_tree: the root of a tree of one serial is its leaf, hash_3(serial, 1, 1)", async () => {
  const single = vectors.revocation_tree.cases.filter((c) => c.serials.length === 1);
  assert.ok(single.length > 0);
  for (const c of single) assert.equal(await worker.poseidon2([field(c.serials[0]!), field("0x1"), field("0x1")]), field(c.root));
});

test("an input that is not a field element of 32 bytes is refused, and the hash works after it", async () => {
  const one = field("0x1");
  for (const bad of [hexOf(bytes32(P)), hexOf(bytes32(P + 1n)), "f".repeat(64), one.slice(2), `00${one}`]) {
    await assert.rejects(worker.poseidon2([one, bad]), /HTTP 400.*RangeError/, bad);
  }
  // p + 1 is refused, not hashed as 1.
  assert.equal(await worker.poseidon2([field("0x1"), field("0x2")]), field(vectors.hash_2[1]!.hash));
});

test("hashing and verifying share one engine: each works after the other, and after a proof that makes it throw", async () => {
  const p = testProof("card_proof_rs2048");
  const [inputs, hash] = [vectors.hash_2[1]!.inputs.map(field), field(vectors.hash_2[1]!.hash)];
  const throwing = p.proof.slice();
  throwing.fill(0xff, 0, 32);
  assert.equal(await worker.poseidon2(inputs), hash);
  assert.equal(await worker.verify(p.circuit, p.proof, p.publicInputs), true);
  assert.equal(await worker.poseidon2(inputs), hash);
  assert.equal(await worker.verify(p.circuit, throwing, p.publicInputs), false);
  assert.equal(await worker.poseidon2(inputs), hash);
  assert.equal(await worker.verify(p.circuit, p.proof, p.publicInputs), true);
});
