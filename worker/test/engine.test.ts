// What the proof verifier and the Poseidon2 hash do when Barretenberg does
// not behave: it throws, it answers something that is not an answer, or it
// does not start. Barretenberg's module never does the last two on its own,
// so here a stand-in is put in its place, at the one point where the
// Worker's code meets the module: what `Engine` starts (src/engine.ts).
// The real module is tested in the local workerd (test/verify.test.ts,
// test/poseidon2.test.ts, test/compare.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesOfBigint } from "iamreal-protocol/bytes.ts";
import { Engine, EngineError, type Instance } from "../src/engine.ts";
import { poseidon2On } from "../src/poseidon2.ts";
import { proofVerifierOn } from "../src/verify.ts";
import { testProof, verificationKeys } from "./proofs.ts";

/** What a stand-in instance does with one command: the answer it gives, or it throws. */
type Behaviour = (command: string) => unknown;

/** An engine whose instances behave as `behaviours` say, the n-th instance as the n-th says (the last one for the rest). */
function engineOf(...behaviours: (Behaviour | "does not start")[]): { engine: Engine; started: () => number; calls: () => number } {
  let started = 0;
  let calls = 0;
  const engine = new Engine((): Instance => {
    const behaviour = behaviours[Math.min(started, behaviours.length - 1)]!;
    started++;
    if (behaviour === "does not start") throw new Error("the stand-in does not start");
    return {
      call(command) {
        calls++;
        return behaviour(command);
      },
    };
  });
  return { engine, started: () => started, calls: () => calls };
}

const one = bytesOfBigint(1n, 32);
const hash = bytesOfBigint(7n, 32);
const working: Behaviour = (command) => (command === "CircuitVerify" ? ["CircuitVerifyResponse", { verified: true }] : ["Poseidon2HashResponse", { hash }]);
const p = testProof("card_proof_rs2048");
const verifyOn = (engine: Engine): Promise<boolean> => proofVerifierOn(engine, verificationKeys()).verify(p.circuit, p.proof, p.publicInputs);

/** Answers that are not a verdict: the wrong shape, the wrong kind, an error. */
const NOT_AN_ANSWER: [string, unknown][] = [
  ["nothing", undefined],
  ["null", null],
  ["a list of one", ["CircuitVerifyResponse"]],
  ["no fields", ["CircuitVerifyResponse", undefined]],
  ["fields that are null", ["CircuitVerifyResponse", null]],
  ["fields that are a string", ["CircuitVerifyResponse", "true"]],
  ["no verdict in the fields", ["CircuitVerifyResponse", {}]],
  ["a verdict that is not a boolean", ["CircuitVerifyResponse", { verified: 1 }]],
  ["a verdict under another kind", ["Poseidon2HashResponse", { verified: true }]],
  ["an error", ["ErrorResponse", { message: "no" }]],
  ["a kind that is not a string", [1, { verified: true }]],
  ["not a list", { verified: true }],
];

test("the stand-in is asked, and a verdict it gives is the verifier's", async () => {
  const { engine, calls } = engineOf(working);
  assert.equal(await verifyOn(engine), true);
  assert.equal(calls(), 1);
  const { engine: refusing } = engineOf(() => ["CircuitVerifyResponse", { verified: false }]);
  assert.equal(await verifyOn(refusing), false);
});

test("an answer that is not a verdict is a rejection, and the instance that gave it is not used again", async () => {
  for (const [name, answer] of NOT_AN_ANSWER) {
    const { engine, started } = engineOf(() => answer, working);
    assert.equal(await verifyOn(engine), false, name);
    assert.equal(started(), 1, name);
    assert.equal(await verifyOn(engine), true, `${name}: the next proof`);
    assert.equal(started(), 2, `${name}: the next proof is verified by a new instance`);
  }
});

test("an instance that throws is a rejection, and it is not used again", async () => {
  const { engine, started } = engineOf(() => {
    throw new Error("the stand-in throws");
  }, working);
  assert.equal(await verifyOn(engine), false);
  assert.equal(await verifyOn(engine), true);
  assert.equal(started(), 2);
});

test("when Barretenberg does not start, verifying fails: it does not answer, neither accepted nor rejected", async () => {
  const { engine, started } = engineOf("does not start", "does not start", working);
  for (let i = 0; i < 2; i++) {
    const outcome = await verifyOn(engine).then(
      (verified) => ({ verified }),
      (error: unknown) => ({ error }),
    );
    assert.ok("error" in outcome, `resolved to ${JSON.stringify(outcome)}`);
    assert.ok(outcome.error instanceof EngineError && outcome.error.notStarted);
  }
  // Each call tries to start it again, and once it starts, proofs are verified.
  assert.equal(await verifyOn(engine), true);
  assert.equal(started(), 3);
});

test("what is wrong with the request is rejected without Barretenberg being started", async () => {
  const { engine, started } = engineOf("does not start");
  const verifier = proofVerifierOn(engine, verificationKeys());
  assert.equal(await verifier.verify("no_such_circuit", p.proof, p.publicInputs), false);
  assert.equal(await verifier.verify(p.circuit, p.proof.slice(1), p.publicInputs), false);
  assert.equal(await verifier.verify(p.circuit, p.proof, p.publicInputs.slice(1)), false);
  assert.equal(started(), 0);
});

test("Poseidon2: an answer that is not a hash is an EngineError, and the instance that gave it is not used again", () => {
  const answers: [string, unknown][] = [
    ["nothing", undefined],
    ["no fields", ["Poseidon2HashResponse", undefined]],
    ["fields that are null", ["Poseidon2HashResponse", null]],
    ["no hash", ["Poseidon2HashResponse", {}]],
    ["a hash of 31 bytes", ["Poseidon2HashResponse", { hash: hash.slice(1) }]],
    ["a hash that is a string", ["Poseidon2HashResponse", { hash: "07" }]],
    ["a hash under another kind", ["CircuitVerifyResponse", { hash }]],
    ["an error", ["ErrorResponse", { message: "no" }]],
  ];
  for (const [name, answer] of answers) {
    const { engine, started } = engineOf(() => answer, working);
    const poseidon2Hash = poseidon2On(engine);
    assert.throws(() => poseidon2Hash([one, one]), (e) => e instanceof EngineError && !e.notStarted, name);
    assert.deepEqual(poseidon2Hash([one, one]), hash, `${name}: the next hash`);
    assert.equal(started(), 2, name);
  }
});

test("Poseidon2: an instance that throws or does not start is an EngineError", () => {
  const throwing = engineOf(() => {
    throw new Error("the stand-in throws");
  }, working);
  assert.throws(() => poseidon2On(throwing.engine)([one]), (e) => e instanceof EngineError && !e.notStarted);
  assert.deepEqual(poseidon2On(throwing.engine)([one]), hash);
  const stopped = engineOf("does not start");
  assert.throws(() => poseidon2On(stopped.engine)([one]), (e) => e instanceof EngineError && e.notStarted);
});
