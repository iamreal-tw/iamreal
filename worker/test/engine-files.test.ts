// The step every build starts with (scripts/engine-files.ts): Barretenberg's
// module and the verification keys are written for the build only if each
// has the SHA-256 the script names; otherwise the build stops.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { GENERATED_DIR, WASM_FILE, WASM_SHA256, defaultSources, prepareEngineFiles, vkFile } from "../scripts/engine-files.ts";
import { CIRCUITS, CIRCUIT_NAMES } from "../src/circuits.ts";
import { WORKER_DIR, buildWorker } from "./build.ts";
import { sha256Hex, verificationKey } from "./proofs.ts";

mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
const tmp = mkdtempSync(join(WORKER_DIR, "test-output", "engine-files-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A fresh empty directory under the test's own. */
function dir(name: string): string {
  const d = join(tmp, name);
  mkdirSync(d);
  return d;
}

test("the files written are the module of bb.js 6.0.0 and the Go verifier's two keys", () => {
  const out = dir("good");
  prepareEngineFiles(defaultSources(), out);
  assert.deepEqual(readdirSync(out).sort(), [WASM_FILE, vkFile("card_proof_rs2048"), vkFile("card_proof_rs4096")].sort());
  const wasm = readFileSync(join(out, WASM_FILE));
  assert.equal(wasm.length, 18278515);
  assert.equal(sha256Hex(wasm), WASM_SHA256);
  for (const circuit of CIRCUIT_NAMES) assert.deepEqual(new Uint8Array(readFileSync(join(out, vkFile(circuit)))), verificationKey(circuit), circuit);
});

test("the circuits, the SHA-256 of their keys and their counts of public inputs are the ones of spec/proof-verification.md", () => {
  const spec = readFileSync(join(WORKER_DIR, "..", "spec", "proof-verification.md"), "utf8");
  const rows = [...spec.matchAll(/^\| `(card_proof_\w+)` \| `G\d` \| (\d+) \| `([0-9a-f]{64})` \|$/gm)];
  const table = Object.fromEntries(rows.map((m) => [m[1]!, m[3]!]));
  assert.deepEqual(Object.fromEntries(CIRCUIT_NAMES.map((c) => [c, CIRCUITS[c].publicInputCount])), Object.fromEntries(rows.map((m) => [m[1]!, Number(m[2])])));
  assert.deepEqual(Object.fromEntries(CIRCUIT_NAMES.map((c) => [c, CIRCUITS[c].verificationKeySha256])), table);
  assert.equal(Object.keys(table).length, 2);
});

test("a module with another SHA-256 stops the build: an error, and nothing written", () => {
  // bb.js's file with one byte of the module changed, packed the way bb.js packs it.
  const original = readFileSync(defaultSources().bbjsModule, "utf8");
  const wasm = gunzipSync(Buffer.from(/base64,([A-Za-z0-9+/=]+)"/.exec(original)![1]!, "base64"));
  wasm[wasm.length - 1]! ^= 1;
  const changed = join(dir("changed-module"), "barretenberg.js");
  writeFileSync(changed, `const barretenberg = "data:application/gzip;base64,${gzipSync(wasm).toString("base64")}";\nexport default barretenberg;\n`);
  const out = dir("out-changed-module");
  assert.throws(() => prepareEngineFiles({ ...defaultSources(), bbjsModule: changed }, out), /SHA-256 [0-9a-f]{64}, not 88c435ec/);
  assert.deepEqual(readdirSync(out), []);
});

test("a file that is not bb.js's file with the module in it stops the build", () => {
  const other = join(dir("not-the-file"), "barretenberg.js");
  writeFileSync(other, "export default 1;\n");
  const out = dir("out-not-the-file");
  assert.throws(() => prepareEngineFiles({ ...defaultSources(), bbjsModule: other }, out), /not bb\.js 6\.0\.0's file/);
  assert.deepEqual(readdirSync(out), []);
});

test("a verification key with another SHA-256 stops the build: an error, and nothing written", () => {
  const vkDir = dir("changed-vk");
  for (const circuit of CIRCUIT_NAMES) copyFileSync(join(WORKER_DIR, "..", "verifier", "vk", `${circuit}.vk`), join(vkDir, `${circuit}.vk`));
  const vk = readFileSync(join(vkDir, "card_proof_rs4096.vk"));
  vk[100]! ^= 1;
  writeFileSync(join(vkDir, "card_proof_rs4096.vk"), vk);
  const out = dir("out-changed-vk");
  assert.throws(() => prepareEngineFiles({ ...defaultSources(), vkDir }, out), /card_proof_rs4096\.vk has SHA-256 [0-9a-f]{64}, not bed43ed8/);
  assert.deepEqual(readdirSync(out), []);
});

test("a build puts the checked files where the Worker's code imports them from", () => {
  const out = dir("build");
  buildWorker("deploy", out);
  assert.equal(sha256Hex(readFileSync(join(GENERATED_DIR, WASM_FILE))), WASM_SHA256);
  for (const circuit of CIRCUIT_NAMES) assert.equal(sha256Hex(readFileSync(join(GENERATED_DIR, vkFile(circuit)))), CIRCUITS[circuit].verificationKeySha256, circuit);
});
