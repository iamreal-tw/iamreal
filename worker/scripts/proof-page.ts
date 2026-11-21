// The card proof page among the files of Static Assets: the test site's
// build of web/ (web/vite.config.ts, mode "testsite"), which a deploy puts
// in site/proof/ (wrangler.jsonc, "assets"; README.md, "Static Assets").
//
//   buildProofPage  builds it into a directory, with the date the test
//                   roster was last cleared on (wrangler.jsonc,
//                   TEST_ROSTER_CLEARED_ON), which the page writes beside
//                   the mark of a test roster.
//   checkProofPage  what a deploy build checks before anything is
//                   uploaded: the directory holds the page's files and no
//                   other, and its scripts are the test site's target: MOICA's
//                   issuer keys and component, the test roster's data domain
//                   and no other address of the project or of this computer,
//                   the mark with that date, nothing of the tests.
//
// site/proof/ is not in the repository, so a computer can have anything
// there, and wrangler uploads every file it finds under site/: a deploy
// build made there passes only with a build that these checks pass.
//
// What the checks cannot see: they look for the known ways another build
// could get in (the tests' build, the production roster's, the one for a
// real card on this computer), not for everything a script could do. What
// the page's scripts are is for the reader of web/ and of the lockfile.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CIRCUIT_NAMES } from "../src/circuits.ts";
import { DATA_ORIGINS } from "../src/headers.ts";
import { moduliInSpec } from "./issuers-in-spec.ts";
import type { RosterKind } from "./site-files.ts";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = join(WORKER_DIR, "..", "web");

/** Where a deploy has the page: site/proof/ beside wrangler.jsonc. */
export const PROOF_DIR = join(WORKER_DIR, "site", "proof");

/** A build of the page, as the checks look at it. */
export interface ProofPage {
  /** Every file of the directory, by its path under it, and its size in bytes. */
  readonly files: Readonly<Record<string, number>>;
  /** Its scripts, pages and style sheets, one after another. */
  readonly code: string;
}

/**
 * Builds the test site's page into `outDir`, emptied first, with `clearedOn`
 * as the date beside the mark of a test roster. It runs web/'s own build
 * (vite, as `pnpm build:test-site` in web/ does) and nothing else; the
 * build is not made without a date of the calendar (web/vite.config.ts).
 */
export function buildProofPage(outDir: string, clearedOn: string): void {
  const vite = join(WEB_DIR, "node_modules", ".bin", "vite");
  const r = spawnSync(vite, ["build", "--mode", "testsite", "--outDir", outDir, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: WEB_DIR,
    encoding: "utf8",
    env: { ...process.env, IAMREAL_TEST_ROSTER_CLEARED_ON: clearedOn },
  });
  if (r.status !== 0) throw new Error(`vite build --mode testsite in web/:\n${r.stdout}\n${r.stderr}${r.error ? `\n${r.error.message}` : ""}`);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** The build in `dir`; null if there is no such directory or no file in it. */
export function readProofPage(dir: string): ProofPage | null {
  if (!existsSync(dir)) return null;
  const paths = filesUnder(dir).sort();
  if (paths.length === 0) return null;
  const name = (p: string): string => relative(dir, p).split(sep).join("/");
  return {
    files: Object.fromEntries(paths.map((p) => [name(p), statSync(p).size])),
    code: paths
      .filter((p) => /\.(js|html|css)$/.test(p))
      .map((p) => readFileSync(p, "utf8"))
      .join("\n"),
  };
}

/** The files the page cannot do without, besides its scripts under assets/ (web/vite.config.ts). */
const NEEDED: readonly string[] = [
  "index.html",
  "help.html",
  "bb/barretenberg.wasm.gz",
  "bb/barretenberg-threads.wasm.gz",
  ...CIRCUIT_NAMES.map((circuit) => `circuits/${circuit}.json`),
  "crs/bn254_g1_compressed_2p18.dat",
  "crs/bn254_g2.dat",
];
/** What the build writes under assets/: scripts, a style sheet, Noir's WebAssembly. */
const ASSET = /^assets\/[A-Za-z0-9_.-]+\.(js|css|wasm)$/;
/** MOICA's component on the cardholder's computer (web/src/target.ts). */
const COMPONENT = "http://localhost:61161";
/** What only a build with the tests' card, keys or component holds (web/test/build.test.ts has the same list). */
const TEST_ONLY: readonly string[] = ["the card signs 31 bytes", "__IAMREAL_TEST", "FakeCard", "fake-component", "testIssuer", "PRIVATE KEY", "pkcs8"];
/** The first word of the sentence beside the mark of a test roster (design/copy/test-site.md). */
const MARK = "測試名冊";

/**
 * Throws unless `page` is the card proof page of a site of that kind of
 * roster, built with `clearedOn` as the date beside its mark. Only a test
 * roster's site has one now: the production roster's is not deployed from
 * here yet, and its page would be another build.
 */
export function checkProofPage(page: ProofPage | null, kind: RosterKind, clearedOn: string | null): void {
  assert.equal(kind, "test", `the card proof page is checked for a test roster's site only: a ${kind} roster's site needs its own build and its own checks`);
  assert.ok(page !== null, "there is no build of web/ under site/proof/: /proof would answer 404");
  assert.ok(clearedOn !== null, "a test roster's site has the date it was last cleared on");
  const names = Object.keys(page.files);
  for (const needed of NEEDED) assert.ok(names.includes(needed), `the card proof page has ${needed}`);
  assert.ok(names.some((n) => ASSET.test(n) && n.endsWith(".js")), "the card proof page has a script under assets/");
  for (const name of names) assert.ok(NEEDED.includes(name) || ASSET.test(name), `${name} is not a file of the card proof page's build`);
  for (const needed of NEEDED) assert.ok(page.files[needed]! > 0, `${needed} of the card proof page is not empty`);
  const { code } = page;
  assert.ok(code.includes(COMPONENT), `the card proof page names the component, ${COMPONENT}`);
  for (const modulus of moduliInSpec()) assert.ok(code.includes(modulus), "the card proof page holds MOICA's issuer keys, the two of spec/vectors/issuers.json");
  for (const s of TEST_ONLY) assert.ok(!code.includes(s), `the card proof page contains ${JSON.stringify(s)}`);
  // The only addresses of this computer or of the project: the component's and the roster's data domain.
  const dataOrigin = DATA_ORIGINS[kind];
  const addresses = new Set([...code.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)].map((m) => m[0]));
  for (const address of addresses) {
    if (address === COMPONENT || address === dataOrigin) continue;
    // Names in the libraries' comments (licences, specifications) are not requests; the page's policy lets it
    // connect to its own origin and the data domain only.
    assert.ok(!/localhost|127\.0\.0\.1|iamreal/.test(address), `the card proof page names ${address}`);
  }
  assert.ok(addresses.has(dataOrigin), `the card proof page takes the CRL archive from ${dataOrigin}`);
  // The mark as the build has it (web/src/target-test-site.ts, `TestRosterMark`): the sentence, and `clearedOn` with the date, in whatever quotes the build wrote.
  const dated = new RegExp(`clearedOn:\\s*(["'\`])${clearedOn}\\1`);
  assert.ok(code.includes(MARK) && dated.test(code), `the card proof page has the mark of a test roster with the date ${clearedOn}`);
}
