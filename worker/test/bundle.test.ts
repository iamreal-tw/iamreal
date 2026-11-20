// The checks of the deploy build (scripts/deploy-build-checks.ts), on a
// fresh deploy build made the way every deploy makes it (`bundleWorker`,
// scripts/deploy.ts, as test/build.ts calls it), and on the test build, to
// see that they can fail. Deploying runs the same checks on the build it
// uploads (`buildDeploy`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  type BuildContents,
  addressesInCrlReadme,
  bindingsIn,
  checkAddresses,
  checkBindings,
  checkDeployBuild,
  checkEngineFiles,
  checkKeys,
  checkNothingOfTheTestBuild,
  engineFiles,
  isCrsPoint,
  keySizedRuns,
  moduliInSpec,
  readBuild,
  urlsIn,
} from "../scripts/deploy-build-checks.ts";
import { WRANGLER, buildDeploy, uploadArgs, wranglerEnv } from "../scripts/deploy.ts";
import { type TestBuildValues, WORKER_DIR, buildWorker } from "./build.ts";
import { testIssuers } from "./harness.ts";

interface Build extends BuildContents {
  /** What wrangler printed. */
  readonly output: string;
}

function build(kind: "deploy" | "test", values: TestBuildValues): Build {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const out = mkdtempSync(join(WORKER_DIR, "test-output", `bundle-${kind}-`));
  try {
    const output = kind === "deploy" ? buildWorker("deploy", out) : buildWorker("test", out, values);
    return { ...readBuild(out), output };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const values: TestBuildValues = { moica: "http://127.0.0.1:59999", issuers: testIssuers(), crlTimeoutMs: 1234, crlCatchUpMs: 5678 };

const deploy = build("deploy", values);
const testBuild = build("test", values);

test("the only addresses in the deploy build are MOICA's two, the ones crl/README.md gives", () => {
  checkAddresses(deploy);
});

test("the issuer keys in the deploy build are exactly the two of spec/vectors/issuers.json", () => {
  checkKeys(deploy);
});

test("the deploy build holds nothing of the test build", () => {
  checkNothingOfTheTestBuild(deploy);
});

test("the test environment's only settings are the roster's object, the data bucket and the object's name", () => {
  checkBindings(deploy.output);
});

test("the deploy build's other modules are the proof verifier's files: Barretenberg's module and the two verification keys", () => {
  assert.deepEqual(deploy.files, engineFiles());
  checkEngineFiles(deploy);
  // A build without them does not pass: the mirror could not build a tree.
  assert.throws(() => checkEngineFiles({ ...deploy, files: {} }));
});

test("the test build holds another key, the fake MOICA and the clock's switch: the checks above can fail", () => {
  for (const s of [values.moica, "/__test/clock", "setTestClock", "/g2/complete.crl"]) assert.ok(testBuild.code.includes(s), `the test build lacks ${JSON.stringify(s)}`);
  // The test's keys are found by the same search that finds only MOICA's in the deploy build.
  const runs = keySizedRuns(testBuild.code);
  for (const k of values.issuers) assert.ok(runs.includes(k.modulus), `the search does not find the test's ${k.name} key`);
  assert.notDeepEqual(runs.filter((run) => !isCrsPoint(run)), moduliInSpec().sort());
  assert.notDeepEqual(urlsIn(testBuild.code), addressesInCrlReadme().sort());
  assert.deepEqual(bindingsIn(testBuild.output), bindingsIn(deploy.output));
  for (const check of [checkAddresses, checkKeys, checkNothingOfTheTestBuild]) assert.throws(() => check(testBuild), check.name);
});

test("the proof verifier's files in a build are Barretenberg's module and the two verification keys, each with its SHA-256", () => {
  // The test build calls the verifier (test-build/index.ts), so it holds the files.
  assert.deepEqual(testBuild.files, engineFiles());
  checkEngineFiles(testBuild);
  assert.throws(() => checkEngineFiles({ ...testBuild, files: { ...testBuild.files, "barretenberg.wasm": "0".repeat(64) } }));
});

test("the upload takes the build's other modules with it: Barretenberg's module and the verification keys", () => {
  // The upload of the test build, as a dry run of the upload's own arguments, sends the same three
  // files the build holds. (The deploy build's upload is the next test.)
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "upload-"));
  try {
    const out = join(dir, "build");
    buildWorker("test", out, values);
    const sent = join(dir, "sent");
    const r = spawnSync(WRANGLER, [...uploadArgs(join(out, "index.js")), "--dry-run", "--outdir", sent], { cwd: WORKER_DIR, encoding: "utf8", env: wranglerEnv(process.env) });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.deepEqual(readBuild(sent).files, engineFiles());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildDeploy makes a build that passes the checks, and the upload sends that build as it is", () => {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "deploy-"));
  try {
    const out = join(dir, "build");
    const output = buildDeploy(out);
    checkDeployBuild(out, output);
    // What the upload would send, as a dry run of its own arguments: the same JavaScript and bindings.
    const sent = join(dir, "sent");
    const r = spawnSync(WRANGLER, [...uploadArgs(join(out, "index.js")), "--dry-run", "--outdir", sent], { cwd: WORKER_DIR, encoding: "utf8", env: wranglerEnv(process.env) });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.equal(readFileSync(join(sent, "index.js"), "utf8"), readFileSync(join(out, "index.js"), "utf8"));
    assert.deepEqual(readBuild(sent).files, readBuild(out).files);
    assert.deepEqual(bindingsIn(r.stdout), bindingsIn(output));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
