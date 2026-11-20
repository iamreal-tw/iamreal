// The checks of a deploy build, a directory made by `buildDeploy`
// (deploy.ts): what gets deployed holds MOICA's two issuer keys and MOICA's
// two CRL addresses, written into the code, and nothing of the test build:
// no other key, no fake MOICA, no switch for the clock; none of these is a
// setting (ADR-0028); and its other modules are the proof verifier's files
// with their SHA-256 (engine-files.ts).
//
// They run on every deploy build before it can be uploaded: in the
// workflow's build job and in `pnpm run deploy:test` (both through
// `buildDeploy`). test/bundle.test.ts runs each on a fresh deploy build, and
// on the test build to see that they can fail.
//
// What the checks of keys can and cannot see: a key written as hexadecimal
// or decimal digits, as base64 or as PEM is found; a key written some other
// way (an array of numbers, pieces put together when the Worker runs) is
// not.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CIRCUITS, CIRCUIT_NAMES } from "../src/circuits.ts";
import { WASM_FILE, WASM_SHA256, vkFile } from "./engine-files.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** What a build directory holds, as the checks look at it. */
export interface BuildContents {
  /** The JavaScript modules, one after another. */
  readonly code: string;
  /** The other modules wrangler uploads: the name each was imported by, and its SHA-256. Not the source map or README.md, which are not uploaded. */
  readonly files: Readonly<Record<string, string>>;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

export function readBuild(dir: string): BuildContents {
  const files = filesUnder(dir).filter((f) => !/\.map$|README\.md$/.test(f));
  const js = files.filter((f) => f.endsWith(".js"));
  assert.ok(js.length > 0, `${dir} has the build's JavaScript`);
  return {
    code: js.map((f) => readFileSync(f, "utf8")).join("\n"),
    // wrangler names such a module `<hash>-<the file's name>`.
    files: Object.fromEntries(
      files.filter((f) => !f.endsWith(".js")).map((f) => [basename(f).replace(/^[0-9a-f]{40}-/, ""), createHash("sha256").update(readFileSync(f)).digest("hex")]),
    ),
  };
}

/** The two addresses crl/README.md tells people to download MOICA's CRLs from. */
export function addressesInCrlReadme(): string[] {
  const readme = readFileSync(join(REPO, "crl", "README.md"), "utf8");
  const found = [...readme.matchAll(/^\s*- G[23]：`(http:\/\/[^`]+)`$/gm)].map((m) => m[1]!);
  assert.equal(found.length, 2, "crl/README.md lists two addresses");
  return found;
}

/** MOICA's two moduli as spec/vectors/issuers.json gives them: lowercase hex, no prefix. */
export function moduliInSpec(): string[] {
  const vectors = JSON.parse(readFileSync(join(REPO, "spec", "vectors", "issuers.json"), "utf8")) as { issuers: { modulus: string }[] };
  assert.equal(vectors.issuers.length, 2);
  return vectors.issuers.map((i) => i.modulus.replace(/^0x/, "").toLowerCase());
}

export const urlsIn = (code: string): string[] => [...new Set([...code.matchAll(/https?:\/\/[^\s"'`\\)]+/g)].map((m) => m[0]))].sort();

/** A 1024-bit modulus is 256 hex digits, 172 base64 characters or 309 decimal digits. */
const KEY_SIZED = 170;

/**
 * Every run of digits and letters in the code long enough to be an RSA
 * key, as often as it is there, with string literals that the code joins
 * by `+` put together first. A run of hex or decimal digits is one of
 * these too.
 */
function everyKeySizedRun(code: string): string[] {
  const joined = code.replace(/(["'`])\s*\+\s*\1/g, "");
  return [...joined.matchAll(new RegExp(`[A-Za-z0-9+/_=-]{${KEY_SIZED},}`, "g"))].map((m) => m[0].toLowerCase());
}

/** The different runs of `everyKeySizedRun`, sorted. */
export function keySizedRuns(code: string): string[] {
  return [...new Set(everyKeySizedRun(code))].sort();
}

/** The bindings wrangler lists for a build: name and kind, from the table it prints. */
export function bindingsIn(output: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const m of output.matchAll(/^env\.(\w+)\s.*?\s{2,}(\S.*?)\s*$/gm)) found[m[1]!] = m[2]!;
  return found;
}

/** What only the test build holds. */
export const TEST_ONLY: readonly string[] = ["127.0.0.1", "localhost", "__IAMREAL_TEST", "/__test/", "setTestClock", "testClock", "test-build", "crl-paths", "/g2/complete.crl"];

/** The proof verifier's files, by the name they are imported by, and their SHA-256. */
export function engineFiles(): Record<string, string> {
  return { [WASM_FILE]: WASM_SHA256, ...Object.fromEntries(CIRCUIT_NAMES.map((circuit) => [vkFile(circuit), CIRCUITS[circuit].verificationKeySha256])) };
}

export function checkAddresses(b: BuildContents): void {
  assert.deepEqual(urlsIn(b.code), addressesInCrlReadme().sort(), "the only addresses in the deploy build are MOICA's two, the ones crl/README.md gives");
}

/**
 * The one run as long as a key that is not a key: the G2 point of
 * Barretenberg's CRS, 128 bytes written as hex in src/barretenberg.ts. It
 * is known here by the SHA-256 of the file bb.js downloads it as
 * (README.md, "WASM 檔和驗證金鑰從哪裡來").
 */
const CRS_G2_SHA256 = "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f";
export const isCrsPoint = (run: string): boolean => /^[0-9a-f]{256}$/.test(run) && createHash("sha256").update(Buffer.from(run, "hex")).digest("hex") === CRS_G2_SHA256;

export function checkKeys(b: BuildContents): void {
  const runs = keySizedRuns(b.code);
  assert.deepEqual(runs.filter((run) => !isCrsPoint(run)), moduliInSpec().sort(), "the issuer keys in the deploy build are exactly the two of spec/vectors/issuers.json");
  // Counted without leaving out repeats: the loader holds the point in one
  // place, and a second copy would be code nobody has looked at.
  assert.equal(everyKeySizedRun(b.code).filter(isCrsPoint).length, 1, "the deploy build holds the CRS point exactly once");
  for (const s of ["PRIVATE KEY", "PUBLIC KEY", "BEGIN CERTIFICATE", "pkcs8", "spki"]) assert.ok(!b.code.includes(s), `the deploy build contains ${JSON.stringify(s)}`);
}

export function checkNothingOfTheTestBuild(b: BuildContents): void {
  for (const s of TEST_ONLY) assert.ok(!b.code.includes(s), `the deploy build contains ${JSON.stringify(s)}`);
}

/**
 * The test environment's only settings are the roster's object, the data
 * bucket and the object's name: so the issuer keys, MOICA's addresses and
 * the clock cannot be read from a setting. (A secret set on the Worker with
 * `wrangler secret` is not in the configuration and is not seen here.)
 */
export function checkBindings(wranglerOutput: string): void {
  assert.deepEqual(bindingsIn(wranglerOutput), { ROSTER: "Durable Object", DATA: "R2 Bucket", ROSTER_OBJECT_NAME: "Environment Variable" }, "the deploy build's bindings");
}

/**
 * The modules other than JavaScript are the proof verifier's files, each
 * with its SHA-256, no more and no fewer: the CRL mirror builds its trees
 * with the Poseidon2 of Barretenberg's module (src/index.ts), and the
 * verification keys come in with the same import (src/in-worker.ts).
 */
export function checkEngineFiles(b: BuildContents): void {
  assert.deepEqual(b.files, engineFiles(), "the deploy build's other modules are the proof verifier's files");
}

/** Every check above on the build in `dir`; throws on the first that fails. */
export function checkDeployBuild(dir: string, wranglerOutput: string): void {
  const b = readBuild(dir);
  checkAddresses(b);
  checkKeys(b);
  checkNothingOfTheTestBuild(b);
  checkBindings(wranglerOutput);
  checkEngineFiles(b);
}
