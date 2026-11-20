// The Worker's Poseidon2 hash against spec/vectors/poseidon2.json, the
// answers the Go crl/poseidon2 and the device's code are tested with.
//
// - `hash_2`, `hash_3` and `scoped_id`: the hash itself (src/poseidon2.ts
//   over src/barretenberg.ts and the module a build checks), run here in
//   Node. The Worker has no door to the bare hash.
// - `revocation_tree`: in the local workerd, through the only thing the
//   Worker does with the hash. The fake MOICA serves a CRL with each case's
//   serial numbers, and the root the CRL mirror writes into the index must
//   be the case's root.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { hexOf, bytesOfHex } from "iamreal-protocol/bytes.ts";
import { P } from "iamreal-protocol/field.ts";
import { WASM_FILE, prepareEngineFiles } from "../scripts/engine-files.ts";
import { Barretenberg } from "../src/barretenberg.ts";
import { Engine } from "../src/engine.ts";
import { poseidon2On } from "../src/poseidon2.ts";
import { WORKER_DIR } from "./build.ts";
import { makeCrl } from "./crls.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { bytes32, sha256Hex, testProof } from "./proofs.ts";

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

/** A vector's field element (`0x`, up to 64 hex digits) as 64 digits. */
const field = (s: string): string => s.replace(/^0x/, "").padStart(64, "0");

describe("the hash, in Node", () => {
  prepareEngineFiles();
  const module = new WebAssembly.Module(readFileSync(join(WORKER_DIR, "generated", WASM_FILE)));
  const hash = poseidon2On(new Engine(() => new Barretenberg(module)));
  const poseidon2 = (inputs: readonly string[]): string => hexOf(hash(inputs.map(bytesOfHex)));

  test("the field is the vectors' field", () => {
    assert.equal(BigInt(vectors.field_modulus), P);
  });

  test("hash_2 and hash_3: every case of the vectors", () => {
    assert.ok(vectors.hash_2.length > 0 && vectors.hash_3.length > 0);
    for (const [name, cases] of [["hash_2", vectors.hash_2], ["hash_3", vectors.hash_3]] as const) {
      for (const [i, c] of cases.entries()) assert.equal(poseidon2(c.inputs.map(field)), field(c.hash), `${name} case ${i}`);
    }
  });

  test("scoped_id: the chain of hash_2 over the limbs, every case of the vectors", () => {
    assert.ok(vectors.scoped_id.cases.length > 0);
    for (const [i, c] of vectors.scoped_id.cases.entries()) {
      let state = field("0x0");
      for (const limb of c.limbs) state = poseidon2([state, field(limb)]);
      assert.equal(state, field(c.scoped_id), `case ${i}`);
    }
  });

  test("an input that is not a field element of 32 bytes is refused, and the hash works after it", () => {
    const one = field("0x1");
    for (const bad of [hexOf(bytes32(P)), hexOf(bytes32(P + 1n)), "f".repeat(64), one.slice(2), `00${one}`]) {
      assert.throws(() => poseidon2([one, bad]), RangeError, bad);
    }
    // p + 1 is refused, not hashed as 1.
    assert.equal(poseidon2([field("0x1"), field("0x2")]), field(vectors.hash_2[1]!.hash));
  });
});

describe("the hash in the local workerd, as the CRL mirror uses it", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  /** One round with this CRL as G3's; returns the root the index gives it. */
  async function rootOf(crl: Uint8Array): Promise<string | undefined> {
    worker.moica.serve("G2", crl);
    worker.moica.serve("G3", crl);
    assert.equal((await worker.runSchedule()).outcome, "ok", worker.logLines().join("\n"));
    const index = new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]!.bytes);
    const lines = index.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { sha256: string; root: string });
    return lines.find((l) => l.sha256 === sha256Hex(crl))?.root;
  }
  const crlOf = (serials: readonly string[], number: bigint): Uint8Array => makeCrl({ issuer: "G3", number, thisUpdate: new Date("2026-11-19T16:00:00Z"), serials: serials.map(BigInt) });

  test("revocation_tree: the root of every case of the vectors", async () => {
    const cases = vectors.revocation_tree.cases;
    assert.ok(cases.some((c) => c.serials.length === 0) && cases.some((c) => c.serials.length === 1) && cases.some((c) => c.serials.length > 1));
    for (const [i, c] of cases.entries()) assert.equal(await rootOf(crlOf(c.serials, BigInt(i))), field(c.root), `case ${i}`);
  });

  test("hashing and verifying share one engine: each works after the other, and after a proof that makes it throw", async () => {
    const p = testProof("card_proof_rs2048");
    const c = vectors.revocation_tree.cases.findLast((c) => c.serials.length > 1)!;
    const throwing = p.proof.slice();
    throwing.fill(0xff, 0, 32);
    assert.equal(await rootOf(crlOf(c.serials, 100n)), field(c.root));
    assert.equal(await worker.verify(p.circuit, p.proof, p.publicInputs), true);
    assert.equal(await rootOf(crlOf(c.serials, 101n)), field(c.root));
    assert.equal(await worker.verify(p.circuit, throwing, p.publicInputs), false);
    assert.equal(await rootOf(crlOf(c.serials, 102n)), field(c.root));
    assert.equal(await worker.verify(p.circuit, p.proof, p.publicInputs), true);
  });
});
