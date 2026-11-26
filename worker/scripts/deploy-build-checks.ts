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
// environment's kind of proof log (`checkSiteFiles`), and a test log's
// site has a date to say it was last cleared on (`checkClearedOn`).
//
// And the card proof page among those files is the test site's build of
// web/, with that date (`checkProofPages`; the checks themselves are in
// proof-page.ts). This one is not part of `checkDeployBuild`: it needs the
// page built first, which the two ways of deploying do (deploy.ts,
// `buildSite`) and a test of the Worker's build does not.
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { parseDay } from "iamreal-protocol/date.ts";
import { CIRCUITS, CIRCUIT_NAMES } from "../src/circuits.ts";
import { ROUND_CPU_MS } from "../src/round-budget.ts";
import { WASM_FILE, WASM_SHA256, vkFile } from "./engine-files.ts";
import { moduliInSpec } from "./issuers-in-spec.ts";
import { PROOF_DIR, type ProofPage, checkProofPage, readProofPage } from "./proof-page.ts";
import { DEMO_FILE, FAVICON_FILE, FONT_FILE, FONT_SOURCE, OG_IMAGE_FILE, OG_IMAGE_SOURCE, RUN_WORKER_FIRST, SITE_FILES, SITE_REDIRECTS, siteHeaders } from "./site-files.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export { moduliInSpec };

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

/** What only the test build holds, and the build for a real card on this computer (local-build/, which sends the bucket's files). */
export const NOT_DEPLOYED: readonly string[] = ["127.0.0.1", "localhost", "__IAMREAL_TEST", "/__test/", "setTestClock", "testClock", "test-build", "crl-paths", "/g2/complete.crl", "local-build"];

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
 *   - the repository, linked from every page (design/copy/home.md, 導覽列),
 *     iamreal-verify's README in it (how to verify, and its section 下載
 *     from the proof log page; the section's name is not ASCII and is not
 *     read here), and its discussions, which the FAQ's answer of who runs
 *     the service links to (design/copy/faq.md);
 *   - the maintainer's blog, which that answer links to too;
 *   - Threads: the profile a page of a card or of an account embeds and
 *     links to (design/copy/proof-page.md, section 3; account-page.md), the
 *     site /hang opens (hang.md), and the one origin the pages' policy
 *     allows a frame from (src/headers.ts);
 *   - the page of a card on this site, as 複製連結 of /hang/<short ID>
 *     copies it (hang.md, part 2), in the site's own domain;
 *   - the image of every page's link preview, site/og-image.png, in the
 *     site's own domain (proof-page.md, section 8, 預覽圖);
 *   - MOICA's site, which /prepare links to: its download page of the
 *     component and its home page (design/copy/prepare.md, sections 3 and
 *     4). Links only: the CRLs, the one thing fetched from MOICA, are on
 *     plain HTTP and in crl/README.md.
 *
 * The data domain, which the card proof page's policy lets it fetch from,
 * is not among them: that policy is sent by Static Assets (site/_headers),
 * and the Worker's code does not hold it.
 */
export const PAGE_ADDRESSES: readonly string[] = [
  "https://github.com/iamreal-tw/iamreal",
  "https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md",
  "https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md#",
  "https://github.com/iamreal-tw/iamreal/discussions",
  "https://opasschang.com",
  "https://www.threads.com/",
  "https://www.threads.com/@${account}",
  "https://www.threads.com/@${account}/embed/",
  "https://www.threads.com;",
  "https://${site.host}/p/${short}",
  "https://${site.host}/og-image.png",
  "https://moica.nat.gov.tw/",
  "https://moica.nat.gov.tw/rac_plugin.html",
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
  for (const s of NOT_DEPLOYED) assert.ok(!b.code.includes(s), `the deploy build contains ${JSON.stringify(s)}`);
}

/**
 * The test environment's only settings are the proof log's object, the data
 * bucket, the object's name, which proof log it is and the date it was last
 * cleared on: so the issuer keys, MOICA's addresses and the clock cannot be
 * read from a setting, and the Worker has no binding to read the files of
 * Static Assets by (`checkSiteFiles`). (A secret set on the Worker with
 * `wrangler secret` is not in the configuration and is not seen here.)
 */
export function checkBindings(wranglerOutput: string): void {
  assert.deepEqual(
    bindingsIn(wranglerOutput),
    { PROOF_LOG: "Durable Object", DATA: "R2 Bucket", PROOF_LOG_OBJECT_NAME: "Environment Variable", PROOF_LOG_KIND: "Environment Variable", TEST_PROOF_LOG_CLEARED_ON: "Environment Variable" },
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
 * `PROOF_LOG_KIND` and `TEST_PROOF_LOG_CLEARED_ON` of every environment of
 * wrangler.jsonc, each read the way wrangler reads it for `--env <name>`
 * (as `configuredCpuMs` reads).
 */
export function configuredClearedOn(): Record<string, { kind: unknown; clearedOn: unknown }> {
  const { rawConfig } = experimental_readRawConfig({ config: WRANGLER_CONFIG });
  const out: Record<string, { kind: unknown; clearedOn: unknown }> = {};
  for (const env of Object.keys(rawConfig.env ?? {})) {
    const { vars } = unstable_readConfig({ config: WRANGLER_CONFIG, env }, { hideWarnings: true });
    out[env] = { kind: vars.PROOF_LOG_KIND, clearedOn: vars.TEST_PROOF_LOG_CLEARED_ON };
  }
  return out;
}

/**
 * In every environment that serves a test log, `TEST_PROOF_LOG_CLEARED_ON`
 * is a date of the calendar, `YYYY-MM-DD`, read as the Worker reads it
 * (src/settings.ts): with any other value the deployed test site answers
 * nothing but 500, its API included, and that would only be seen after the
 * deploy.
 */
export function checkClearedOn(configured: Readonly<Record<string, { kind: unknown; clearedOn: unknown }>>): void {
  assert.ok(Object.keys(configured).length > 0, "wrangler.jsonc has an environment");
  for (const [env, { kind, clearedOn }] of Object.entries(configured)) {
    if (kind !== "test") continue;
    assert.ok(typeof clearedOn === "string" && parseDay(clearedOn) !== null, `TEST_PROOF_LOG_CLEARED_ON of the ${env} environment is a date, YYYY-MM-DD`);
  }
}

/** How one environment of wrangler.jsonc has Static Assets send the files of its directory. */
export interface ConfiguredSite {
  /** `PROOF_LOG_KIND`: which proof log the environment serves. */
  readonly kind: unknown;
  /** `assets.run_worker_first`, `assets.binding`, `assets.html_handling`, `assets.not_found_handling`. */
  readonly runWorkerFirst: unknown;
  readonly binding: unknown;
  readonly htmlHandling: unknown;
  readonly notFoundHandling: unknown;
  /** The text of `_headers` and of `_redirects` in `assets.directory`; null if the file is not there. */
  readonly headers: string | null;
  readonly redirects: string | null;
  /** Every file under `assets.directory` outside proof/, by its path under it, sorted: what wrangler finds there to upload besides the card proof page, which `configuredProofPages` reads. */
  readonly files: readonly string[];
  /** The SHA-256 of `pages.css` there; null if the file is not there. */
  readonly styleSheetSha256: string | null;
  /** The SHA-256 of `pages.css` there as the commit checked out holds it (`sha256InHead`); null if there is none to read. */
  readonly committedStyleSheetSha256: string | null;
  /** The SHA-256 of `copy.js` there; null if the file is not there. */
  readonly scriptSha256: string | null;
  /** The SHA-256 of `copy.js` there as the commit checked out holds it; null if there is none to read. */
  readonly committedScriptSha256: string | null;
  /** The SHA-256 of `demo.js` there (`DEMO_FILE`); null if the file is not there. */
  readonly demoSha256: string | null;
  /** The SHA-256 of `demo.js` there as the commit checked out holds it; null if there is none to read. */
  readonly committedDemoSha256: string | null;
  /** The SHA-256 of the icon there (`FAVICON_FILE`); null if the file is not there. */
  readonly faviconSha256: string | null;
  /** The SHA-256 of the icon there as the commit checked out holds it; null if there is none to read. */
  readonly committedFaviconSha256: string | null;
  /** The SHA-256 of the typeface there (`FONT_FILE`); null if the file is not there. */
  readonly fontSha256: string | null;
  /** The SHA-256 of the link preview's image there (`OG_IMAGE_FILE`); null if the file is not there. */
  readonly ogImageSha256: string | null;
}

/**
 * The SHA-256 of a file as the commit checked out (HEAD) holds it, at the
 * same path: what git has for it, not what the working tree has. Null if
 * there is none to read: the file is not in HEAD, or its directory is not
 * in a git checkout, or there is no git to ask. A file git keeps as other
 * bytes than the working tree's (a symbolic link, a filter of
 * .gitattributes; there is none) is not the same either: the check fails.
 */
export function sha256InHead(path: string): string | null {
  // git finds the repository from the file's directory, not from a GIT_DIR or GIT_WORK_TREE this process was started with (in a hook, say).
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  try {
    // `HEAD:./<name>` is the path from the directory git runs in, wherever that is in the repository.
    const held = execFileSync("git", ["show", `HEAD:./${basename(path)}`], { cwd: dirname(path), env, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return createHash("sha256").update(held).digest("hex");
  } catch {
    return null;
  }
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
    // wrangler resolves the directory against the configuration file's.
    const directory = config.assets?.directory === undefined ? undefined : join(dirname(WRANGLER_CONFIG), config.assets.directory);
    const textOf = (name: string): string | null => {
      if (directory === undefined) return null;
      const path = join(directory, name);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    };
    const sha256Of = (name: string): string | null => {
      if (directory === undefined) return null;
      const path = join(directory, name);
      return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
    };
    const committedSha256Of = (name: string): string | null => (directory === undefined ? null : sha256InHead(join(directory, name)));
    out[env] = {
      kind: config.vars.PROOF_LOG_KIND,
      runWorkerFirst: config.assets?.run_worker_first,
      binding: config.assets?.binding,
      htmlHandling: config.assets?.html_handling,
      notFoundHandling: config.assets?.not_found_handling,
      headers: textOf("_headers"),
      redirects: textOf("_redirects"),
      files: directory === undefined || !existsSync(directory) ? [] : filesUnder(directory).map((f) => relative(directory, f).split(sep).join("/")).filter((f) => !f.startsWith("proof/")).sort(),
      styleSheetSha256: sha256Of("pages.css"),
      committedStyleSheetSha256: committedSha256Of("pages.css"),
      scriptSha256: sha256Of("copy.js"),
      committedScriptSha256: committedSha256Of("copy.js"),
      demoSha256: sha256Of(DEMO_FILE),
      committedDemoSha256: committedSha256Of(DEMO_FILE),
      faviconSha256: sha256Of(FAVICON_FILE),
      committedFaviconSha256: committedSha256Of(FAVICON_FILE),
      fontSha256: sha256Of(FONT_FILE),
      ogImageSha256: sha256Of(OG_IMAGE_FILE),
    };
  }
  return out;
}

/**
 * In every environment, Cloudflare sends the card proof page's files, the
 * style sheet, the copy buttons' script, the icon, the typeface and the link preview's image itself, and the Worker's code has no part in what a file
 * is sent as (README.md, "Static Assets"):
 *
 *   - their paths are kept out of the Worker's (`RUN_WORKER_FIRST`), and
 *     the Worker has no binding to read them by. In the local workerd a
 *     request for one of those paths never runs the Worker; on Cloudflare
 *     that is not confirmed for a file that is not there (README.md);
 *   - the files of the directory outside proof/ are the ones listed
 *     (`SITE_FILES`) and no other; the style sheet, the script and the icon are the
 *     ones the commit checked out holds (`sha256InHead`), so a deploy
 *     uploads the ones that were reviewed, not a change that was not
 *     committed or one a build made, and one git cannot read from HEAD does
 *     not pass; the typeface is the subset of design/fonts/
 *     (`FONT_SOURCE`) and the image is design/screens/og-image.png
 *     (`OG_IMAGE_SOURCE`), byte for byte. What is under proof/, which is not in the
 *     repository, is the card proof page's build: `checkProofPages` looks
 *     at it;
 *   - a path is a file's own or nothing, but for the redirects of
 *     site-files.ts (`SITE_REDIRECTS`);
 *   - their headers are the ones written from src/headers.ts for the
 *     environment's kind of proof log (`siteHeaders`): a test log's site
 *     says noindex and a production log's does not.
 *
 * `_headers` is one file of one directory. Two environments that serve
 * different kinds of proof log from the same directory do not pass: each then
 * needs a directory of its own, or its files written before the upload.
 */
export function checkSiteFiles(sites: Readonly<Record<string, ConfiguredSite>>): void {
  assert.ok(Object.keys(sites).length > 0, "wrangler.jsonc has an environment");
  for (const [env, site] of Object.entries(sites)) {
    assert.deepEqual(site.runWorkerFirst, RUN_WORKER_FIRST, `assets.run_worker_first of the ${env} environment keeps the Worker from the files of Static Assets`);
    assert.equal(site.binding, undefined, `the ${env} environment gives the Worker no binding to the files of Static Assets`);
    assert.equal(site.htmlHandling, "none", `assets.html_handling of the ${env} environment`);
    assert.equal(site.notFoundHandling, "none", `assets.not_found_handling of the ${env} environment`);
    assert.ok(site.kind === "test" || site.kind === "production", `PROOF_LOG_KIND of the ${env} environment is test or production`);
    assert.equal(site.headers, siteHeaders(site.kind), `_headers of the ${env} environment is the one scripts/site-files.ts writes for a ${site.kind} log's site`);
    assert.equal(site.redirects, SITE_REDIRECTS, `_redirects of the ${env} environment is the one of scripts/site-files.ts`);
    assert.deepEqual(site.files, SITE_FILES, `the files of the ${env} environment's Static Assets outside proof/ are the ones scripts/site-files.ts lists, no more and no fewer`);
    for (const [name, there, committed] of [
      ["pages.css", site.styleSheetSha256, site.committedStyleSheetSha256],
      ["copy.js", site.scriptSha256, site.committedScriptSha256],
      [DEMO_FILE, site.demoSha256, site.committedDemoSha256],
      [FAVICON_FILE, site.faviconSha256, site.committedFaviconSha256],
    ] as const) {
      const message = `${name} of the ${env} environment is the one of HEAD, byte for byte: commit it before a deploy, and have nothing change it after`;
      assert.notEqual(committed, null, message);
      assert.equal(there, committed, message);
    }
    assert.equal(site.fontSha256, createHash("sha256").update(readFileSync(FONT_SOURCE)).digest("hex"), `${FONT_FILE} of the ${env} environment is the subset of design/fonts/`);
    assert.equal(site.ogImageSha256, createHash("sha256").update(readFileSync(OG_IMAGE_SOURCE)).digest("hex"), `${OG_IMAGE_FILE} of the ${env} environment is design/screens/og-image.png`);
  }
}

/** The card proof page of one environment of wrangler.jsonc, as an upload of that environment would send it. */
export interface ConfiguredProofPage {
  /** `PROOF_LOG_KIND` and `TEST_PROOF_LOG_CLEARED_ON`. */
  readonly kind: unknown;
  readonly clearedOn: unknown;
  /** The build under proof/ of `assets.directory`; null if there is none. */
  readonly page: ProofPage | null;
}

/**
 * The card proof page of every environment of wrangler.jsonc: the build
 * under proof/ of its `assets.directory`, in this checkout, with the kind
 * of proof log and the date it is to be checked against. Read as
 * `configuredSites` reads.
 */
export function configuredProofPages(): Record<string, ConfiguredProofPage> {
  const { rawConfig } = experimental_readRawConfig({ config: WRANGLER_CONFIG });
  const out: Record<string, ConfiguredProofPage> = {};
  for (const env of Object.keys(rawConfig.env ?? {})) {
    const config = unstable_readConfig({ config: WRANGLER_CONFIG, env }, { hideWarnings: true });
    const directory = config.assets?.directory === undefined ? undefined : join(dirname(WRANGLER_CONFIG), config.assets.directory);
    out[env] = { kind: config.vars.PROOF_LOG_KIND, clearedOn: config.vars.TEST_PROOF_LOG_CLEARED_ON, page: directory === undefined ? null : readProofPage(join(directory, "proof")) };
  }
  return out;
}

/**
 * In every environment the card proof page is there and is the build of
 * its kind of proof log's site, with the date of its settings beside the mark
 * (proof-page.ts, `checkProofPage`): a deploy with no page (where /proof
 * would answer 404), with what a computer happened to have under
 * site/proof/, or with a build of another target does not pass.
 */
export function checkProofPages(pages: Readonly<Record<string, ConfiguredProofPage>>): void {
  assert.ok(Object.keys(pages).length > 0, "wrangler.jsonc has an environment");
  for (const [env, { kind, clearedOn, page }] of Object.entries(pages)) {
    assert.ok(kind === "test" || kind === "production", `PROOF_LOG_KIND of the ${env} environment is test or production`);
    assert.ok(clearedOn === undefined || typeof clearedOn === "string", `TEST_PROOF_LOG_CLEARED_ON of the ${env} environment is text`);
    try {
      checkProofPage(page, kind, clearedOn ?? null);
    } catch (e) {
      throw new assert.AssertionError({ message: `the ${env} environment: ${(e as Error).message}` });
    }
  }
}

/** Where the checks expect the page: the directory `buildSite` builds into (deploy.ts). */
export { PROOF_DIR };

/** Every check above but the card proof page's, on the build in `dir`; throws on the first that fails. */
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
