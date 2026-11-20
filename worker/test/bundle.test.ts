// What gets deployed holds MOICA's two issuer keys and MOICA's two CRL
// addresses, written into the code, and nothing of the test build: no other
// key, no fake MOICA, no switch for the clock; and none of these is a
// setting (ADR-0028). The deploy build here is made with the arguments and
// the environment of `pnpm run deploy:test` itself (scripts/deploy.ts), as
// a dry run (test/build.ts).
//
// What the checks of keys can and cannot see: a key written as hexadecimal
// or decimal digits, as base64 or as PEM is found; a key written some other
// way (an array of numbers, pieces put together when the Worker runs) is
// not.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { WASM_FILE, WASM_SHA256, vkFile } from "../scripts/engine-files.ts";
import { CIRCUITS, CIRCUIT_NAMES } from "../src/circuits.ts";
import { type TestBuildValues, WORKER_DIR, buildWorker } from "./build.ts";
import { testIssuers } from "./harness.ts";
import { sha256Hex } from "./proofs.ts";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

interface Build {
  /** The modules as wrangler would upload them (not the source map, which is not uploaded). */
  readonly code: string;
  /** What wrangler printed. */
  readonly output: string;
  /** The modules that are not JavaScript: the name each was imported by, and its SHA-256. */
  readonly files: Readonly<Record<string, string>>;
}

function build(kind: "deploy" | "test", values: TestBuildValues): Build {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const out = mkdtempSync(join(WORKER_DIR, "test-output", `bundle-${kind}-`));
  try {
    const output = kind === "deploy" ? buildWorker("deploy", out) : buildWorker("test", out, values);
    const files = filesUnder(out).filter((f) => !/\.map$|README\.md$/.test(f));
    assert.ok(files.length > 0, `${kind}: the build has files`);
    const others = files.filter((f) => !f.endsWith(".js"));
    return {
      code: files.map((f) => readFileSync(f, "utf8")).join("\n"),
      output,
      // wrangler names such a module `<hash>-<the file's name>`.
      files: Object.fromEntries(others.map((f) => [basename(f).replace(/^[0-9a-f]{40}-/, ""), sha256Hex(readFileSync(f))])),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The two addresses crl/README.md tells people to download MOICA's CRLs from. */
function addressesInCrlReadme(): string[] {
  const readme = readFileSync(join(WORKER_DIR, "..", "crl", "README.md"), "utf8");
  const found = [...readme.matchAll(/^\s*- G[23]：`(http:\/\/[^`]+)`$/gm)].map((m) => m[1]!);
  assert.equal(found.length, 2, "crl/README.md lists two addresses");
  return found;
}

/** MOICA's two moduli as spec/vectors/issuers.json gives them: lowercase hex, no prefix. */
function moduliInSpec(): string[] {
  const vectors = JSON.parse(readFileSync(join(WORKER_DIR, "..", "spec", "vectors", "issuers.json"), "utf8")) as { issuers: { modulus: string }[] };
  assert.equal(vectors.issuers.length, 2);
  return vectors.issuers.map((i) => i.modulus.replace(/^0x/, "").toLowerCase());
}

const urlsIn = (code: string): string[] => [...new Set([...code.matchAll(/https?:\/\/[^\s"'`\\)]+/g)].map((m) => m[0]))].sort();

/** A 1024-bit modulus is 256 hex digits, 172 base64 characters or 309 decimal digits. */
const KEY_SIZED = 170;

/**
 * Every run of digits and letters in the code long enough to be an RSA
 * key, with string literals that the code joins by `+` put together first.
 * A run of hex or decimal digits is one of these too.
 */
function keySizedRuns(code: string): string[] {
  const joined = code.replace(/(["'`])\s*\+\s*\1/g, "");
  return [...new Set([...joined.matchAll(new RegExp(`[A-Za-z0-9+/_=-]{${KEY_SIZED},}`, "g"))].map((m) => m[0].toLowerCase()))].sort();
}

/** The bindings wrangler lists for a build: name and kind, from the table it prints. */
function bindingsIn(output: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of output.matchAll(/^env\.(\w+)\s.*?\s{2,}(\S.*?)\s*$/gm)) found[m[1]!] = m[2]!;
  return found;
}

const values: TestBuildValues = { moica: "http://127.0.0.1:59999", issuers: testIssuers(), crlTimeoutMs: 1234 };
/** What only the test build holds. */
const TEST_ONLY = [values.moica, "127.0.0.1", "localhost", "__IAMREAL_TEST", "/__test/", "setTestClock", "testClock", "test-build", "crl-paths", "/g2/complete.crl"];

const deploy = build("deploy", values);

test("the only addresses in the deploy build are MOICA's two, the ones crl/README.md gives", () => {
  assert.deepEqual(urlsIn(deploy.code), addressesInCrlReadme().sort());
});

test("the issuer keys in the deploy build are exactly the two of spec/vectors/issuers.json", () => {
  assert.deepEqual(keySizedRuns(deploy.code), moduliInSpec().sort());
  for (const s of ["PRIVATE KEY", "PUBLIC KEY", "BEGIN CERTIFICATE", "pkcs8", "spki"]) assert.ok(!deploy.code.includes(s), `the deploy build contains ${JSON.stringify(s)}`);
});

test("the deploy build holds nothing of the test build", () => {
  for (const s of TEST_ONLY) assert.ok(!deploy.code.includes(s), `the deploy build contains ${JSON.stringify(s)}`);
});

test("the test environment's only settings are the roster's object, the data bucket, the object's name and which roster it is", () => {
  // So the issuer keys, MOICA's addresses and the clock cannot be read from a setting: there is none
  // to read them from. (A secret set on the Worker with `wrangler secret` is not in the configuration
  // and is not seen here.)
  assert.deepEqual(bindingsIn(deploy.output), { ROSTER: "Durable Object", DATA: "R2 Bucket", ROSTER_OBJECT_NAME: "Environment Variable", ROSTER_KIND: "Environment Variable" });
});

test("the test build holds another key, the fake MOICA and the clock's switch: the checks above can fail", () => {
  const testBuild = build("test", values);
  for (const s of [values.moica, "/__test/clock", "setTestClock", "/g2/complete.crl"]) assert.ok(testBuild.code.includes(s), `the test build lacks ${JSON.stringify(s)}`);
  // The test's keys are found by the same search that finds only MOICA's in the deploy build.
  const runs = keySizedRuns(testBuild.code);
  for (const k of values.issuers) assert.ok(runs.includes(k.modulus), `the search does not find the test's ${k.name} key`);
  assert.notDeepEqual(runs, moduliInSpec().sort());
  assert.notDeepEqual(urlsIn(testBuild.code), addressesInCrlReadme().sort());
  assert.deepEqual(bindingsIn(testBuild.output), bindingsIn(deploy.output));
});

test("the proof verifier's files in a build are Barretenberg's module and the two verification keys, each with its SHA-256", () => {
  const checked = { [WASM_FILE]: WASM_SHA256, ...Object.fromEntries(CIRCUIT_NAMES.map((circuit) => [vkFile(circuit), CIRCUITS[circuit].verificationKeySha256])) };
  // The test build calls the verifier (test-build/index.ts), so it holds the files.
  assert.deepEqual(build("test", values).files, checked);
  // The deployed Worker has nothing that calls the verifier yet, so the
  // bundler leaves it out and this `if` is never true. #67, which makes
  // the deployed Worker verify submissions, removes the `if`: from then on
  // the deploy build's files must be these same ones.
  if (Object.keys(deploy.files).length > 0) assert.deepEqual(deploy.files, checked);
});
