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
  PAGE_ADDRESSES,
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
import { WRANGLER, buildDeploy, bundleWorker, uploadArgs, wranglerEnv } from "../scripts/deploy.ts";
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

test("the only addresses in the deploy build are MOICA's two, the ones crl/README.md gives, and the ones the pages write", () => {
  checkAddresses(deploy);
  // The pages' are the repository, Threads, the site's own domain (the link /hang/<short ID> copies), MOICA's site
  // (the two links of /prepare), the maintainer's blog (the FAQ's 誰在做島民證明？) and the privacy policies /privacy links to
  // (Cloudflare's, Apple's, Google's), each over HTTPS. (The data
  // domain is in the card proof page's policy, which is in site/_headers and no longer in the Worker.)
  for (const address of PAGE_ADDRESSES) assert.match(address, /^https:\/\/((github\.com|www\.threads\.com|moica\.nat\.gov\.tw|\$\{site\.host\})[/;]|opasschang\.com$|www\.cloudflare\.com\/privacypolicy\/$|www\.apple\.com\/legal\/privacy\/$|policies\.google\.com\/privacy$)/);
  // The data domains as origins, the way the card proof page's policy writes them: the privacy statement names them as words
  // (privacy.md, sections 1 and 5). A policy that wrote one without its scheme would no longer be caught here.
  assert.ok(!deploy.code.includes("https://data.iamreal.tw") && !deploy.code.includes("https://test-data.iamreal.tw") && !deploy.code.includes("Document-Isolation-Policy"), "the deploy build has nothing of the card proof page's headers");
  assert.throws(() => checkAddresses({ ...deploy, code: `${deploy.code}\nfetch("https://example.org/");` }));
});

test("the issuer keys in the deploy build are exactly the two of spec/vectors/issuers.json", () => {
  checkKeys(deploy);
});

test("the one other run as long as a key is the CRS point, and the deploy build holds it exactly once", () => {
  const point = keySizedRuns(deploy.code).find(isCrsPoint);
  assert.ok(point);
  assert.throws(() => checkKeys({ ...deploy, code: `${deploy.code}\nconst again = "${point}";` }), /exactly once/);
  assert.throws(() => checkKeys({ ...deploy, code: deploy.code.replace(point, "") }), /exactly once/);
});

test("the deploy build holds nothing of the test build", () => {
  checkNothingOfTheTestBuild(deploy);
});

test("the test environment's only settings are the proof log's object, the data bucket, the connection log's bucket, the six per-IP limits and the site-wide one, the counts' object and how many counts a minute holds, the object's name, which proof log it is, the date it was last cleared on, whether card proofs are taken and the name of a rebuild asked for", () => {
  checkBindings(deploy.output);
  // Not the files of Static Assets: with a binding to them the Worker could read and send them itself.
  assert.deepEqual(Object.keys(bindingsIn(deploy.output)).sort(), ["CARD_PROOFS_PAUSED", "CONNECTION_LOG", "COUNTS", "COUNT_EVENTS_PER_MINUTE", "DATA", "PROOF_LOG", "PROOF_LOG_KIND", "PROOF_LOG_OBJECT_NAME", "RATE_CARD_STATE", "RATE_CHALLENGES", "RATE_COUNTS", "RATE_PAGES", "RATE_PUBLIC_READS", "RATE_RECORDS", "RATE_STARTS", "REBUILD_PROOF_LOG", "TEST_PROOF_LOG_CLEARED_ON"]);
  assert.throws(() => checkBindings(`${deploy.output}\nenv.ASSETS      Assets\n`));
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
  assert.notDeepEqual(urlsIn(testBuild.code), [...addressesInCrlReadme(), ...PAGE_ADDRESSES].sort());
  assert.deepEqual(bindingsIn(testBuild.output), bindingsIn(deploy.output));
  for (const check of [checkAddresses, checkKeys, checkNothingOfTheTestBuild]) assert.throws(() => check(testBuild), check.name);
});

test("the build for a real card on this computer (local-build/index.ts, `pnpm local`) is the deploy build and a door to the bucket's files: the check of the deploy build finds it", () => {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const out = mkdtempSync(join(WORKER_DIR, "test-output", "bundle-local-"));
  try {
    bundleWorker(out, { entry: "local-build/index.ts", extraArgs: [] });
    const local = readBuild(out);
    // MOICA's keys and addresses, as deployed: nothing of the test build's.
    checkKeys(local);
    checkAddresses(local);
    assert.ok(local.code.includes("writeHttpMetadata"), "the local build sends the bucket's files");
    assert.ok(!deploy.code.includes("writeHttpMetadata"), "the deploy build has no route to the bucket's files (ADR-0027)");
    assert.throws(() => checkNothingOfTheTestBuild(local), /local-build/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the measurement's build (measure-build/index.ts) is not a deploy build: the check of the deploy build finds it", () => {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const out = mkdtempSync(join(WORKER_DIR, "test-output", "bundle-measure-"));
  try {
    bundleWorker(out, { entry: "measure-build/index.ts", extraArgs: [] });
    const measure = readBuild(out);
    checkKeys(measure);
    assert.ok(measure.code.includes("/__measure/"), "the measurement's build has its doors");
    assert.throws(() => checkNothingOfTheTestBuild(measure), /measure-build|__measure|MEASURE_KEY/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
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
