// The proof verifier (src/in-worker.ts) in the local workerd: what it accepts,
// what it rejects, and that a proof that makes Barretenberg throw does not
// spoil the proofs after it. The proofs are the Go verifier's test proofs.
// test/compare.test.ts compares it with the native `bb verify` case by case.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";
import { bigintOfBytes } from "iamreal-protocol/bytes.ts";
import { P } from "iamreal-protocol/field.ts";
import { CIRCUIT_NAMES } from "../src/circuits.ts";
import { type TestProof, bytes32, testProof } from "./proofs.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
});
after(() => worker.close());

const verify = (p: TestProof, change: Partial<Omit<TestProof, "circuit">> & { circuit?: string } = {}): Promise<boolean> => {
  const q = { ...p, ...change };
  return worker.verify(q.circuit, q.proof, q.publicInputs);
};

/** `bytes` with the 32 bytes at `offset` replaced by 0xff…ff, a value above the field's modulus. */
function withOversizedElement(bytes: Uint8Array, offset: number): Uint8Array {
  const out = bytes.slice();
  out.fill(0xff, offset, offset + 32);
  return out;
}

test("the test proofs of both circuits verify", async () => {
  for (const circuit of CIRCUIT_NAMES) assert.equal(await verify(testProof(circuit)), true, circuit);
});

test("a proof is rejected with any one public input changed", async () => {
  for (const circuit of CIRCUIT_NAMES) {
    const p = testProof(circuit);
    for (let i = 0; i < p.publicInputs.length; i++) {
      const publicInputs = p.publicInputs.map((f) => f.slice());
      publicInputs[i]![31]! ^= 1;
      assert.equal(await verify(p, { publicInputs }), false, `${circuit}, input ${i}`);
    }
  }
});

test("a proof is rejected with one byte changed, wherever the byte is", async () => {
  const p = testProof("card_proof_rs2048");
  for (const at of [0, 31, 32, 5000, p.proof.length - 1]) {
    const proof = p.proof.slice();
    proof[at]! ^= 1;
    assert.equal(await verify(p, { proof }), false, `byte ${at}`);
  }
});

test("a proof that is not exactly 14,656 bytes is rejected", async () => {
  for (const circuit of CIRCUIT_NAMES) {
    const p = testProof(circuit);
    const longer = new Uint8Array(p.proof.length + 1);
    longer.set(p.proof);
    const padded = new Uint8Array(p.proof.length);
    padded.set(p.noZkProof);
    const cases: [string, Uint8Array][] = [
      ["empty", new Uint8Array(0)],
      ["one byte short", p.proof.slice(0, -1)],
      ["one byte long", longer],
      ["one field short", p.proof.slice(0, -32)],
      ["made without zero knowledge", p.noZkProof],
      ["made without zero knowledge, padded with zeros to the length", padded],
    ];
    for (const [name, proof] of cases) assert.equal(await verify(p, { proof }), false, `${circuit}, ${name}`);
  }
});

test("public inputs of the wrong count or the wrong size are rejected", async () => {
  for (const circuit of CIRCUIT_NAMES) {
    const p = testProof(circuit);
    const cases: [string, Uint8Array[]][] = [
      ["none", []],
      ["one fewer", p.publicInputs.slice(0, -1)],
      ["one more", [...p.publicInputs, new Uint8Array(32)]],
      ["a value of 31 bytes", p.publicInputs.map((f, i) => (i === 0 ? f.slice(1) : f))],
      ["a value of 33 bytes", p.publicInputs.map((f, i) => (i === 0 ? new Uint8Array([0, ...f]) : f))],
    ];
    for (const [name, publicInputs] of cases) assert.equal(await verify(p, { publicInputs }), false, `${circuit}, ${name}`);
  }
});

test("a public input that is not below the field's modulus is rejected, also when it is the same value plus the modulus", async () => {
  const p = testProof("card_proof_rs2048");
  for (let i = 0; i < p.publicInputs.length; i++) {
    const publicInputs = p.publicInputs.map((f, j) => (j === i ? bytes32(bigintOfBytes(f) + P) : f));
    assert.equal(await verify(p, { publicInputs }), false, `input ${i} plus the modulus`);
  }
  for (const x of [P, 2n ** 256n - 1n]) {
    assert.equal(await verify(p, { publicInputs: p.publicInputs.map((f, j) => (j === 0 ? bytes32(x) : f)) }), false);
  }
});

test("a proof is rejected under the other circuit's name and under a name that is no circuit", async () => {
  const [a, b] = [testProof("card_proof_rs2048"), testProof("card_proof_rs4096")];
  assert.equal(await verify(a, { circuit: b.circuit }), false);
  assert.equal(await verify(b, { circuit: a.circuit }), false);
  // The other circuit's name with that circuit's count of inputs.
  assert.equal(await verify(a, { circuit: b.circuit, publicInputs: b.publicInputs }), false);
  for (const circuit of ["", "card_proof", "constructor", "toString", "__proto__", "CARD_PROOF_RS2048"]) {
    assert.equal(await verify(a, { circuit }), false, JSON.stringify(circuit));
  }
});

test("after a proof that makes Barretenberg throw, the next correct proof verifies", async () => {
  // A proof element above the modulus is one of the inputs Barretenberg
  // throws on instead of answering "not verified" (#16).
  for (const circuit of CIRCUIT_NAMES) {
    const p = testProof(circuit);
    for (const offset of [0, 64, 320, p.proof.length - 32]) {
      assert.equal(await verify(p, { proof: withOversizedElement(p.proof, offset) }), false, `${circuit}, element at ${offset}`);
      assert.equal(await verify(p), true, `${circuit}, the correct proof after the element at ${offset}`);
    }
  }
});

test("after 500 proofs in a row that make Barretenberg throw, the next correct proof verifies", async () => {
  // An instance that is kept through that many refuses correct proofs from about the 335th on (#16).
  const p = testProof("card_proof_rs2048");
  const throwing = withOversizedElement(p.proof, 0);
  for (let i = 0; i < 500; i++) assert.equal(await verify(p, { proof: throwing }), false, `throwing proof ${i + 1}`);
  for (const circuit of CIRCUIT_NAMES) assert.equal(await verify(testProof(circuit)), true, circuit);
});
