// Case by case: the Worker's proof verifier (src/in-worker.ts, Barretenberg's
// WebAssembly module in the local workerd) against the native
// `bb verify -t noir-recursive`. Accepted or rejected must be the same in
// every case.
//
// It runs when IAMREAL_BB names a bb 6.0.0 executable, the variable the Go
// tests use, and is skipped otherwise. It also needs `go`.
//
// The cases:
//
// 1. Every set of inputs the Go verifier's tests hand to `bb`. They are
//    collected by running `go test ./verifier` with a script in bb's place
//    that keeps a copy of the key, the proof and the public inputs of each
//    `bb verify` and then runs the real bb. Each distinct set is one case.
//    Some of them change from run to run: the Go tests include random
//    proofs.
// 2. The inputs the Go verifier turns away before it runs `bb`
//    (verifier/verify.go, VerifyProof), which therefore never reach the
//    script: a wrong length of proof, a wrong count of inputs, a value not
//    below the field's modulus, another circuit's key. Here the native bb
//    is given them anyway.
//
// The answer of the native bb is taken here, by running it on each case
// under `-t noir-recursive`, whatever setting the Go test used: that
// setting is the only one the Worker's verifier has.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { bigintOfBytes, concatBytes } from "iamreal-protocol/bytes.ts";
import { P } from "iamreal-protocol/field.ts";
import { CIRCUITS, CIRCUIT_NAMES, type CircuitName } from "../src/circuits.ts";
import { fieldElements } from "../src/verify.ts";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { bytes32, sha256Hex, testProof, verificationKey } from "./proofs.ts";

const REPO = join(WORKER_DIR, "..");
const BB = process.env.IAMREAL_BB;
const skip = BB === undefined || BB === "" ? "IAMREAL_BB is not set: no native bb to compare with" : false;

mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
const tmp = mkdtempSync(join(WORKER_DIR, "test-output", "compare-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** One case: what `bb verify` reads, as files' contents. */
interface Case {
  readonly name: string;
  readonly vk: Uint8Array;
  readonly proof: Uint8Array;
  /** The public inputs file: the values one after another. */
  readonly publicInputs: Uint8Array;
}

/** The name the Worker's verifier knows a key by. Throws for a key it has no name for: such a case cannot be asked. */
function circuitOf(vk: Uint8Array): CircuitName {
  const sha = sha256Hex(vk);
  const found = CIRCUIT_NAMES.find((c) => CIRCUITS[c].verificationKeySha256 === sha);
  if (!found) throw new Error(`a case uses a verification key the Worker has no name for (SHA-256 ${sha})`);
  return found;
}

/** The 64 bytes of bn254_g1.dat (spec/proof-verification.md, "The CRS"), so that bb downloads nothing. */
const crsDir = join(tmp, "crs");
mkdirSync(crsDir);
const g1 = new Uint8Array(64);
g1[31] = 1;
g1[63] = 2;
writeFileSync(join(crsDir, "bn254_g1.dat"), g1);

let nativeRuns = 0;
/** Whether the native `bb verify -t noir-recursive` accepts the case: exit code 0. Anything else is a rejection. */
function native(c: Case): boolean {
  const dir = join(tmp, `native-${nativeRuns++}`);
  mkdirSync(dir);
  try {
    writeFileSync(join(dir, "vk"), c.vk);
    writeFileSync(join(dir, "proof"), c.proof);
    writeFileSync(join(dir, "public_inputs"), c.publicInputs);
    const r = spawnSync(BB!, ["verify", "-k", join(dir, "vk"), "-p", join(dir, "proof"), "-i", join(dir, "public_inputs"), "-c", crsDir, "-t", "noir-recursive"], { cwd: dir, timeout: 30000, stdio: "ignore" });
    return r.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the Go verifier's tests with a recording script as bb, and returns each distinct set of inputs they gave it. */
function casesOfGoTests(): { cases: Case[]; calls: number } {
  const recorded = join(tmp, "recorded");
  mkdirSync(recorded);
  const script = join(tmp, "recording-bb");
  writeFileSync(
    script,
    `#!/bin/sh
# In bb's place while the Go tests run: keeps a copy of what each
# \`bb verify\` is given, then runs the real bb with the same arguments.
if [ "$1" = verify ]; then
  dir=$(mktemp -d "$IAMREAL_COMPARE_RECORDED/call.XXXXXXXX") || exit 99
  prev=
  for arg in "$@"; do
    case "$prev" in
      -k) cp "$arg" "$dir/vk" ;;
      -p) cp "$arg" "$dir/proof" ;;
      -i) cp "$arg" "$dir/public_inputs" ;;
      -t) printf %s "$arg" > "$dir/setting" ;;
    esac
    prev=$arg
  done
fi
exec "$IAMREAL_COMPARE_BB" "$@"
`,
  );
  chmodSync(script, 0o755);
  const go = spawnSync("go", ["test", "-count=1", "./verifier"], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, IAMREAL_BB: script, IAMREAL_COMPARE_BB: BB!, IAMREAL_COMPARE_RECORDED: recorded },
  });
  assert.equal(go.status, 0, `go test ./verifier with the recording script:\n${go.stdout}\n${go.stderr}`);

  const calls = readdirSync(recorded).sort();
  const seen = new Set<string>();
  const cases: Case[] = [];
  for (const call of calls) {
    const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(recorded, call, name)));
    const c = { vk: read("vk"), proof: read("proof"), publicInputs: read("public_inputs") };
    const id = sha256Hex(Buffer.from(sha256Hex(c.vk) + sha256Hex(c.proof) + sha256Hex(c.publicInputs)));
    if (seen.has(id)) continue;
    seen.add(id);
    cases.push({ name: `from the Go tests, ${circuitOf(c.vk)}, proof of ${c.proof.length} bytes (${id.slice(0, 12)})`, ...c });
  }
  return { cases, calls: calls.length };
}

/** The inputs the Go verifier rejects before running bb. */
function casesGoTurnsAway(): Case[] {
  const cat = (parts: Uint8Array[]): Uint8Array => concatBytes(...parts);
  const cases: Case[] = [];
  for (const circuit of CIRCUIT_NAMES) {
    const p = testProof(circuit);
    const other = testProof(circuit === "card_proof_rs2048" ? "card_proof_rs4096" : "card_proof_rs2048");
    const vk = verificationKey(circuit);
    const inputs = cat(p.publicInputs);
    const add = (name: string, change: Partial<Omit<Case, "name">>): void => void cases.push({ name: `${circuit}: ${name}`, vk, proof: p.proof, publicInputs: inputs, ...change });
    const withInput = (i: number, value: Uint8Array): Uint8Array => cat(p.publicInputs.map((f, j) => (j === i ? value : f)));
    const valueOf = (i: number): bigint => bigintOfBytes(p.publicInputs[i]!);
    const last = p.publicInputs.length - 1;

    add("the first public input plus the modulus", { publicInputs: withInput(0, bytes32(valueOf(0) + P)) });
    add("the last public input plus the modulus", { publicInputs: withInput(last, bytes32(valueOf(last) + P)) });
    add("a public input equal to the modulus", { publicInputs: withInput(0, bytes32(P)) });
    add("a public input of 2^256 - 1", { publicInputs: withInput(last, bytes32(2n ** 256n - 1n)) });
    add("no public inputs", { publicInputs: new Uint8Array(0) });
    add("one public input fewer", { publicInputs: inputs.slice(0, -32) });
    add("one public input more", { publicInputs: cat([inputs, new Uint8Array(32)]) });
    add("public inputs one byte short", { publicInputs: inputs.slice(0, -1) });
    add("an empty proof", { proof: new Uint8Array(0) });
    add("a proof one byte short", { proof: p.proof.slice(0, -1) });
    add("a proof one byte long", { proof: cat([p.proof, new Uint8Array(1)]) });
    add("a proof one value short", { proof: p.proof.slice(0, -32) });
    add("a proof one value long", { proof: cat([p.proof, new Uint8Array(32)]) });
    add("the proof made without zero knowledge", { proof: p.noZkProof });
    add("the other circuit's key", { vk: verificationKey(other.circuit) });
    add("the other circuit's key and its count of public inputs", { vk: verificationKey(other.circuit), publicInputs: cat(other.publicInputs) });
  }
  return cases;
}

test("accepted or rejected is the same as the native bb verify, case by case", { skip }, async (t) => {
  const version = spawnSync(BB!, ["--version"], { encoding: "utf8" });
  assert.equal(version.stdout.trim(), "6.0.0", "IAMREAL_BB is bb 6.0.0");

  const fromGo = casesOfGoTests();
  const turnedAway = casesGoTurnsAway();
  // The Go tests make well over a thousand calls; far fewer means the script did not see them.
  assert.ok(fromGo.cases.length > 1000, `only ${fromGo.cases.length} cases from the Go tests`);

  let worker: TestWorker | undefined;
  const counts = { accepted: 0, rejected: 0 };
  const different: string[] = [];
  try {
    worker = await startWorker();
    for (const c of [...fromGo.cases, ...turnedAway]) {
      const expected = native(c);
      const got = await worker.verify(circuitOf(c.vk), c.proof, fieldElements(c.publicInputs));
      counts[expected ? "accepted" : "rejected"]++;
      if (got !== expected) different.push(`${c.name}: native ${expected ? "accepts" : "rejects"}, the Worker ${got ? "accepts" : "rejects"}`);
    }
    // After all of them, the correct proofs still verify.
    for (const circuit of CIRCUIT_NAMES) {
      const p = testProof(circuit);
      assert.equal(await worker.verify(p.circuit, p.proof, p.publicInputs), true, `${circuit} after every case`);
    }
  } finally {
    await worker?.close();
  }

  t.diagnostic(`${fromGo.calls} calls of bb verify by the Go tests, ${fromGo.cases.length} distinct sets of inputs`);
  t.diagnostic(`${turnedAway.length} cases the Go verifier rejects before running bb`);
  t.diagnostic(`${fromGo.cases.length + turnedAway.length} cases compared: native bb accepts ${counts.accepted}, rejects ${counts.rejected}; ${different.length} differ`);
  assert.deepEqual(different, []);
  // Both verdicts were seen: the comparison is not of rejections only.
  assert.ok(counts.accepted >= 2 && counts.rejected > 1000);
});
