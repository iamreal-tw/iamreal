// The two files of site/ that tell Static Assets how to send the others
// (wrangler.jsonc, "assets"; README.md, "Static Assets"):
//
//   site/_headers    the headers of the card proof page's files, of the
//                    style sheet and of the copy buttons' script, written here from src/headers.ts, the one
//                    place they are defined. A test log's site and a
//                    production log's differ in one header (noindex) and
//                    in the data domain the card proof page may connect to,
//                    so the file is written for one kind of proof log.
//   site/_redirects  the one address of the card proof page.
//   site/fonts/      a copy of the headings' typeface, the subset of
//                    design/fonts/ (design/fonts/README.md), byte for byte.
//   site/og-image.png
//                    a copy of the image of every page's link preview,
//                    design/screens/og-image.png (design/copy/proof-page.md,
//                    section 8), byte for byte.
//
// Both are in the repository as a test log's site needs them, the only
// environment there is: the job that uploads checks the repository out and
// runs none of its scripts, so what it uploads is what a reader of the
// repository sees. Every deploy build checks that they are the ones written
// here for the proof log of each environment (deploy-build-checks.ts,
// `checkSiteFiles`), and test/proof-files.test.ts that the local workerd
// sends what they say.
//
// `node --experimental-strip-types scripts/site-files.ts` writes all four again,
// after a change of src/headers.ts, of the subset or of the image.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVERY_RESPONSE, VISITOR_FILE_CACHE, TEST_SITE_HEADERS, VISITOR_HEADERS, proofPageHeaders } from "../src/headers.ts";

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "site");

/**
 * `assets.run_worker_first` of wrangler.jsonc: the Worker runs first for
 * every path but the files' own, where Static Assets looks for a file
 * first. In the local workerd a request for one of those never runs the
 * Worker, whether the file is there or not. On Cloudflare that was seen
 * for a file that is not there, and not yet for one that is (README.md,
 * "Static Assets"). The Worker cannot send a file either way: it has no
 * binding to them.
 */
export const RUN_WORKER_FIRST: readonly string[] = ["/*", "!/copy.js", "!/demo.js", "!/fonts/*", "!/og-image.png", "!/pages.css", "!/proof", "!/proof/*"];

/**
 * The headings' typeface under site/, where the style sheet loads it from
 * (`/fonts/…`): a copy of design/fonts/GenRyuMin2TW-B.woff2, which this
 * script writes and test/font.test.ts checks byte for byte.
 */
export const FONT_FILE = "fonts/GenRyuMin2TW-B.woff2";

/** The subset FONT_FILE is a copy of: the one in design/fonts/ (design/fonts/README.md). */
export const FONT_SOURCE = join(SITE_DIR, "..", "..", "design", "fonts", "GenRyuMin2TW-B.woff2");

/**
 * The image of every page's link preview under site/, where the pages'
 * og:image points to (src/pages/layout.ts): a copy of
 * design/screens/og-image.png, which this script writes and a deploy build
 * checks byte for byte (deploy-build-checks.ts, `checkSiteFiles`).
 */
export const OG_IMAGE_FILE = "og-image.png";

/** The image OG_IMAGE_FILE is a copy of (design/screens/README.md). */
export const OG_IMAGE_SOURCE = join(SITE_DIR, "..", "..", "design", "screens", "og-image.png");

/**
 * The player of the demonstration on the page of hanging a proof
 * (design/copy/hang.md, 示範) under site/, loaded by /hang/<short ID>: written
 * by this script from the two files of `demoScript`, and in the repository as
 * written, like the copy buttons' script. test/demo.test.ts checks that it is
 * the one those two files give.
 */
export const DEMO_FILE = "demo.js";

/** What DEMO_FILE is made of: the states of the teaching animations, which the answers of spec/vectors/ are for, and the player that draws them. */
export const DEMO_SOURCES: readonly string[] = [join(SITE_DIR, "..", "src", "teaching-animation.ts"), join(SITE_DIR, "..", "demo", "player.js")];

/**
 * The text of site/demo.js: src/teaching-animation.ts with its types taken
 * off (Node's own stripping, which puts spaces where they were), then
 * demo/player.js, in one function of their own so that nothing of them is a
 * name of the page. The lines the stripping left empty are taken out, and
 * `export`, which a script that is not a module cannot say.
 */
export function demoScript(): string {
  const [states, player] = DEMO_SOURCES.map((file) => readFileSync(file, "utf8")) as [string, string];
  const stripped = stripTypeScriptTypes(states).replace(/^export /gm, "");
  const lines = `${stripped}\n${player}`.split("\n").map((line) => line.trimEnd());
  const body = lines.filter((line, i) => line !== "" || (i > 0 && lines[i - 1] !== "")).join("\n").trim();
  return `// Written by scripts/site-files.ts from src/teaching-animation.ts and demo/player.js: change those, not this file.\n"use strict";\n(() => {\n${body}\n})();\n`;
}

/** The timeline the demonstration plays: design/motion/hang.json (design/motion/README.md). */
export const HANG_TIMELINE_SOURCE = join(SITE_DIR, "..", "..", "design", "motion", "hang.json");

/** Where the Worker has it from: its code imports nothing outside worker/ and protocol/, so this script writes it a copy. */
export const HANG_TIMELINE_FILE = join(SITE_DIR, "..", "src", "pages", "hang-timeline.ts");

/**
 * The text of src/pages/hang-timeline.ts: design/motion/hang.json as one
 * line of JSON, which the page of hanging a proof writes into itself as data
 * (src/pages/hang.ts). test/demo.test.ts checks that it is that file's.
 */
export function hangTimelineModule(): string {
  const json = JSON.stringify(JSON.parse(readFileSync(HANG_TIMELINE_SOURCE, "utf8")));
  return `// Written by scripts/site-files.ts from design/motion/hang.json: change that file, not this one.\n\n/** design/motion/hang.json, as one line of JSON. */\nexport const HANG_TIMELINE_JSON = ${JSON.stringify(json)};\n`;
}

/**
 * Every file of site/ a deploy uploads besides the card proof page's, by
 * its path under site/, sorted: the copy buttons' script, the demonstration's player, the typeface, the
 * link preview's image, the style sheet and the two files of rules. The page's files are under site/proof/, which
 * is not in the repository (.gitignore): a deploy builds them there
 * (deploy.ts, `buildSite`) and checks what the directory then holds
 * (proof-page.ts).
 */
export const SITE_FILES: readonly string[] = ["_headers", "_redirects", "copy.js", DEMO_FILE, FONT_FILE, OG_IMAGE_FILE, "pages.css"];

/** Which proof log a site is of (wrangler.jsonc, `PROOF_LOG_KIND`). */
export type ProofLogKind = "test" | "production";

const block = (path: string, headers: Readonly<Record<string, string>>, more: readonly string[] = []): string =>
  [path, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`), ...more.map((line) => `  ${line}`)].join("\n");

/** The headers of the visitors' files, the style sheet, the script, the typeface and the image: the pages' (`VISITOR_HEADERS`), asked for again by their ETag each time. */
const visitorFile = (path: string, every: Readonly<Record<string, string>>): string => block(path, { ...VISITOR_HEADERS, ...every }, ["! Cache-Control", `Cache-Control: ${VISITOR_FILE_CACHE}`]);

/**
 * The text of site/_headers for a site of that kind of proof log.
 *
 * - /proof and everything under it: the card proof page's headers
 *   (`proofPageHeaders`, with the data domain of that kind of proof log). In the local workerd a rule matches whether or
 *   not there is a file, so a 404, a redirect and a 405 under /proof have
 *   them too. On Cloudflare the 404 and the redirect were seen to; the
 *   405 needs a file to be there (README.md, "Static Assets").
 * - /pages.css, /copy.js, /demo.js, /fonts/* and /og-image.png: the visitors' pages' headers
 *   (`VISITOR_HEADERS`), and `VISITOR_FILE_CACHE` in place of the
 *   Cache-Control Static Assets sends by itself (taken off with "!", then
 *   set: two values would be joined). The script's policy has no
 *   script-src: it is the page that loads it whose policy says what runs.
 * - Both: `EVERY_RESPONSE`, and on a test log's site `TEST_SITE_HEADERS`.
 */
export function siteHeaders(kind: ProofLogKind): string {
  const every = { ...EVERY_RESPONSE, ...(kind === "test" ? TEST_SITE_HEADERS : {}) };
  const proof = { ...proofPageHeaders(kind), ...every };
  return `${[
    `# The headers Static Assets sends with the files of this directory, for a ${kind} log's site.`,
    "# Written by scripts/site-files.ts from src/headers.ts: change them there, not here.",
    "",
    block("/proof", proof),
    "",
    block("/proof/*", proof),
    "",
    visitorFile("/pages.css", every),
    "",
    visitorFile("/copy.js", every),
    "",
    visitorFile(`/${DEMO_FILE}`, every),
    "",
    visitorFile("/fonts/*", every),
    "",
    visitorFile(`/${OG_IMAGE_FILE}`, every),
  ].join("\n")}\n`;
}

/**
 * The text of site/_redirects: /proof is the build's index.html, sent at
 * that address (200); the two other addresses it could have are redirected
 * to it, as the Go backend did. The help page the card proof page had is
 * gone (#292): its address goes to the site's page of what a card proof
 * needs, /prepare, where the Android and iOS apps' links to it land until
 * they change. Every other file is at its own path and nowhere else
 * ("html_handling": "none").
 */
export const SITE_REDIRECTS = `# The card proof page is at /proof and nowhere else (scripts/site-files.ts).
/proof /proof/index.html 200
/proof/ /proof 301
/proof/index.html /proof 301
/proof/help.html /prepare 301
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(SITE_DIR, "_headers"), siteHeaders("test"));
  writeFileSync(join(SITE_DIR, "_redirects"), SITE_REDIRECTS);
  mkdirSync(join(SITE_DIR, "fonts"), { recursive: true });
  copyFileSync(FONT_SOURCE, join(SITE_DIR, FONT_FILE));
  copyFileSync(OG_IMAGE_SOURCE, join(SITE_DIR, OG_IMAGE_FILE));
  writeFileSync(join(SITE_DIR, DEMO_FILE), demoScript());
  writeFileSync(HANG_TIMELINE_FILE, hangTimelineModule());
  console.log(`Wrote _headers, _redirects, ${DEMO_FILE}, ${FONT_FILE} and ${OG_IMAGE_FILE} in ${SITE_DIR}, for a test log's site.`);
}
