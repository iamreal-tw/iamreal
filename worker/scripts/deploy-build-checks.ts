// The checks of a deploy build, a directory made by `buildDeploy`
// (deploy.ts): what gets deployed holds MOICA's two issuer keys and MOICA's
// two CRL addresses, written into the code, no other address but the ones
// the pages write (`PAGE_ADDRESSES`), and nothing of the test build:
// no other key, no fake MOICA, no switch for the clock; none of these is a
// setting (ADR-0028); and its other modules are the proof verifier's files
// with their SHA-256 (engine-files.ts).
//
// And the configuration it is uploaded with gives an invocation the CPU
// time a round of the CRL mirror counts on (`checkCpuLimit`), and has
// Cloudflare send the files of site/ itself, with the headers of the
// environment's kind of roster (`checkSiteFiles`), and a test roster's
// site has a date to say it was last cleared on (`checkClearedOn`).
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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { parseDay } from "iamreal-protocol/date.ts";
import { CIRCUITS, CIRCUIT_NAMES } from "../src/circuits.ts";
import { ROUND_CPU_MS } from "../src/round-budget.ts";
import { WASM_FILE, WASM_SHA256, vkFile } from "./engine-files.ts";
import { RUN_WORKER_FIRST, SITE_REDIRECTS, siteHeaders } from "./site-files.ts";

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

/**
 * The addresses the pages and their headers write, each as the code has it
 * (`urlsIn` reads up to the next quote or space, so what follows an address
 * in the same string is part of it here). None of them is fetched: the
 * Worker requests nothing but MOICA's two CRLs.
 *
 *   - the repository, linked from every page (design/copy/home.md, 導覽列);
 *   - Threads: the profile a page of a card embeds and links to
 *     (design/copy/proof-page.md, section 3), and the one origin the pages'
 *     policy allows a frame from (src/headers.ts).
 *
 * The data domain, which the card proof page's policy lets it fetch from,
 * is not among them: that policy is sent by Static Assets (site/_headers),
 * and the Worker's code does not hold it.
 */
export const PAGE_ADDRESSES: readonly string[] = [
  "https://github.com/iamreal-tw/iamreal",
  "https://www.threads.com/@${account}",
  "https://www.threads.com/@${account}/embed/",
  "https://www.threads.com;",
];

export function checkAddresses(b: BuildContents): void {
  assert.deepEqual(
    urlsIn(b.code),
    [...addressesInCrlReadme(), ...PAGE_ADDRESSES].sort(),
    "the only addresses in the deploy build are MOICA's two, the ones crl/README.md gives, and the ones the pages write",
  );
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
 * bucket, the object's name, which roster it is and the date it was last
 * cleared on: so the issuer keys, MOICA's addresses and the clock cannot be
 * read from a setting, and the Worker has no binding to read the files of
 * Static Assets by (`checkSiteFiles`). (A secret set on the Worker with
 * `wrangler secret` is not in the configuration and is not seen here.)
 */
export function checkBindings(wranglerOutput: string): void {
  assert.deepEqual(
    bindingsIn(wranglerOutput),
    { ROSTER: "Durable Object", DATA: "R2 Bucket", ROSTER_OBJECT_NAME: "Environment Variable", ROSTER_KIND: "Environment Variable", TEST_ROSTER_CLEARED_ON: "Environment Variable" },
    "the deploy build's bindings",
  );
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

const WRANGLER_CONFIG = join(REPO, "worker", "wrangler.jsonc");

/**
 * `limits.cpu_ms` of every environment of wrangler.jsonc, each read the
 * way wrangler reads it for `--env <name>`: the value an upload of that
 * environment sends (deploy.ts, `uploadArgs`). `undefined` where neither
 * the environment nor the top level sets one.
 *
 * This reads the configuration file with wrangler's own code, in this
 * process, not in a child: it starts no command and sends no request.
 */
export function configuredCpuMs(): Record<string, number | undefined> {
  const { rawConfig } = experimental_readRawConfig({ config: WRANGLER_CONFIG });
  const out: Record<string, number | undefined> = {};
  for (const env of Object.keys(rawConfig.env ?? {})) {
    // The file's one warning, that the top level has no name, is wrangler's to print when it bundles.
    out[env] = unstable_readConfig({ config: WRANGLER_CONFIG, env }, { hideWarnings: true }).limits?.cpu_ms;
  }
  return out;
}

/**
 * The CPU time the configuration gives one invocation is, in every
 * environment, the one a round of the CRL mirror counts on
 * (src/round-budget.ts). With less, a round is stopped in the middle of a
 * tree: with none set, after about 30 seconds, before the first tree is
 * built.
 */
export function checkCpuLimit(cpuMs: Readonly<Record<string, number | undefined>>): void {
  assert.ok(Object.keys(cpuMs).length > 0, "wrangler.jsonc has an environment");
  for (const [env, ms] of Object.entries(cpuMs)) assert.equal(ms, ROUND_CPU_MS, `limits.cpu_ms of the ${env} environment is the CPU time a round of the CRL mirror counts on`);
}

/**
 * `ROSTER_KIND` and `TEST_ROSTER_CLEARED_ON` of every environment of
 * wrangler.jsonc, each read the way wrangler reads it for `--env <name>`
 * (as `configuredCpuMs` reads).
 */
export function configuredClearedOn(): Record<string, { kind: unknown; clearedOn: unknown }> {
  const { rawConfig } = experimental_readRawConfig({ config: WRANGLER_CONFIG });
  const out: Record<string, { kind: unknown; clearedOn: unknown }> = {};
  for (const env of Object.keys(rawConfig.env ?? {})) {
    const { vars } = unstable_readConfig({ config: WRANGLER_CONFIG, env }, { hideWarnings: true });
    out[env] = { kind: vars.ROSTER_KIND, clearedOn: vars.TEST_ROSTER_CLEARED_ON };
  }
  return out;
}

/**
 * In every environment that serves a test roster, `TEST_ROSTER_CLEARED_ON`
 * is a date of the calendar, `YYYY-MM-DD`, read as the Worker reads it
 * (src/settings.ts): with any other value the deployed test site answers
 * nothing but 500, its API included, and that would only be seen after the
 * deploy.
 */
export function checkClearedOn(configured: Readonly<Record<string, { kind: unknown; clearedOn: unknown }>>): void {
  assert.ok(Object.keys(configured).length > 0, "wrangler.jsonc has an environment");
  for (const [env, { kind, clearedOn }] of Object.entries(configured)) {
    if (kind !== "test") continue;
    assert.ok(typeof clearedOn === "string" && parseDay(clearedOn) !== null, `TEST_ROSTER_CLEARED_ON of the ${env} environment is a date, YYYY-MM-DD`);
  }
}

/** How one environment of wrangler.jsonc has Static Assets send the files of its directory. */
export interface ConfiguredSite {
  /** `ROSTER_KIND`: which roster the environment serves. */
  readonly kind: unknown;
  /** `assets.run_worker_first`, `assets.binding`, `assets.html_handling`, `assets.not_found_handling`. */
  readonly runWorkerFirst: unknown;
  readonly binding: unknown;
  readonly htmlHandling: unknown;
  readonly notFoundHandling: unknown;
  /** The text of `_headers` and of `_redirects` in `assets.directory`; null if the file is not there. */
  readonly headers: string | null;
  readonly redirects: string | null;
}

/**
 * Static Assets of every environment of wrangler.jsonc, each read the way
 * wrangler reads it for `--env <name>`, with the two files of its directory
 * as they are in this checkout: what an upload of that environment sends
 * (deploy.ts, `uploadArgs`). Read as `configuredCpuMs` reads: in this
 * process, sending nothing.
 */
export function configuredSites(): Record<string, ConfiguredSite> {
  const { rawConfig } = experimental_readRawConfig({ config: WRANGLER_CONFIG });
  const out: Record<string, ConfiguredSite> = {};
  for (const env of Object.keys(rawConfig.env ?? {})) {
    const config = unstable_readConfig({ config: WRANGLER_CONFIG, env }, { hideWarnings: true });
    const directory = config.assets?.directory;
    const textOf = (name: string): string | null => {
      if (directory === undefined) return null;
      // wrangler resolves the directory against the configuration file's.
      const path = join(dirname(WRANGLER_CONFIG), directory, name);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    };
    out[env] = {
      kind: config.vars.ROSTER_KIND,
      runWorkerFirst: config.assets?.run_worker_first,
      binding: config.assets?.binding,
      htmlHandling: config.assets?.html_handling,
      notFoundHandling: config.assets?.not_found_handling,
      headers: textOf("_headers"),
      redirects: textOf("_redirects"),
    };
  }
  return out;
}

/**
 * In every environment, Cloudflare sends the card proof page's files and
 * the style sheet itself, and the Worker's code has no part in it
 * (README.md, "Static Assets"):
 *
 *   - a request for one of them never runs the Worker (`RUN_WORKER_FIRST`),
 *     and the Worker has no binding to read them by;
 *   - a path is a file's own or nothing, but for the redirects of
 *     site-files.ts (`SITE_REDIRECTS`);
 *   - their headers are the ones written from src/headers.ts for the
 *     environment's kind of roster (`siteHeaders`): a test roster's site
 *     says noindex and a production roster's does not.
 *
 * `_headers` is one file of one directory. Two environments that serve
 * different kinds of roster from the same directory do not pass: each then
 * needs a directory of its own, or its files written before the upload.
 */
export function checkSiteFiles(sites: Readonly<Record<string, ConfiguredSite>>): void {
  assert.ok(Object.keys(sites).length > 0, "wrangler.jsonc has an environment");
  for (const [env, site] of Object.entries(sites)) {
    assert.deepEqual(site.runWorkerFirst, RUN_WORKER_FIRST, `assets.run_worker_first of the ${env} environment keeps the Worker from the files of Static Assets`);
    assert.equal(site.binding, undefined, `the ${env} environment gives the Worker no binding to the files of Static Assets`);
    assert.equal(site.htmlHandling, "none", `assets.html_handling of the ${env} environment`);
    assert.equal(site.notFoundHandling, "none", `assets.not_found_handling of the ${env} environment`);
    assert.ok(site.kind === "test" || site.kind === "production", `ROSTER_KIND of the ${env} environment is test or production`);
    assert.equal(site.headers, siteHeaders(site.kind), `_headers of the ${env} environment is the one scripts/site-files.ts writes for a ${site.kind} roster's site`);
    assert.equal(site.redirects, SITE_REDIRECTS, `_redirects of the ${env} environment is the one of scripts/site-files.ts`);
  }
}

/** Every check above on the build in `dir`; throws on the first that fails. */
export function checkDeployBuild(dir: string, wranglerOutput: string): void {
  const b = readBuild(dir);
  checkAddresses(b);
  checkKeys(b);
  checkNothingOfTheTestBuild(b);
  checkBindings(wranglerOutput);
  checkEngineFiles(b);
  checkCpuLimit(configuredCpuMs());
  checkSiteFiles(configuredSites());
  checkClearedOn(configuredClearedOn());
}
