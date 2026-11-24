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
//
// Both are in the repository as a test log's site needs them, the only
// environment there is: the job that uploads checks the repository out and
// runs none of its scripts, so what it uploads is what a reader of the
// repository sees. Every deploy build checks that they are the ones written
// here for the proof log of each environment (deploy-build-checks.ts,
// `checkSiteFiles`), and test/proof-files.test.ts that the local workerd
// sends what they say.
//
// `node --experimental-strip-types scripts/site-files.ts` writes all three again,
// after a change of src/headers.ts or of the subset.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
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
export const RUN_WORKER_FIRST: readonly string[] = ["/*", "!/copy.js", "!/fonts/*", "!/pages.css", "!/proof", "!/proof/*"];

/**
 * The headings' typeface under site/, where the style sheet loads it from
 * (`/fonts/…`): a copy of design/fonts/GenRyuMin2TW-B.woff2, which this
 * script writes and test/font.test.ts checks byte for byte.
 */
export const FONT_FILE = "fonts/GenRyuMin2TW-B.woff2";

/** The subset FONT_FILE is a copy of: the one in design/fonts/ (design/fonts/README.md). */
export const FONT_SOURCE = join(SITE_DIR, "..", "..", "design", "fonts", "GenRyuMin2TW-B.woff2");

/**
 * Every file of site/ a deploy uploads besides the card proof page's, by
 * its path under site/, sorted: the copy buttons' script, the typeface, the
 * style sheet and the two files of rules. The page's files are under site/proof/, which
 * is not in the repository (.gitignore): a deploy builds them there
 * (deploy.ts, `buildSite`) and checks what the directory then holds
 * (proof-page.ts).
 */
export const SITE_FILES: readonly string[] = ["_headers", "_redirects", "copy.js", FONT_FILE, "pages.css"];

/**
 * The SHA-256 of site/pages.css, one of the two files of site/ that are not
 * written here: a deploy uploads the style sheet that was reviewed. Change
 * it with the file (`shasum -a 256 site/pages.css`).
 */
export const PAGES_CSS_SHA256 = "8183994602b481ab47533df68a4ab57a52f9f8f15e52b944ebfe56794e5de10e";

/**
 * The SHA-256 of site/copy.js, the copy buttons' script, the other file of
 * site/ that is not written here: a deploy uploads the script that was
 * reviewed. Change it with the file (`shasum -a 256 site/copy.js`).
 */
export const COPY_JS_SHA256 = "d8ecddb598222cea65e621ae5033b916daec9aafacb87a8f650455bdbd2a3e5d";

/** Which proof log a site is of (wrangler.jsonc, `PROOF_LOG_KIND`). */
export type ProofLogKind = "test" | "production";

const block = (path: string, headers: Readonly<Record<string, string>>, more: readonly string[] = []): string =>
  [path, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`), ...more.map((line) => `  ${line}`)].join("\n");

/** The headers of the visitors' files, the style sheet, the script and the typeface: the pages' (`VISITOR_HEADERS`), asked for again by their ETag each time. */
const visitorFile = (path: string, every: Readonly<Record<string, string>>): string => block(path, { ...VISITOR_HEADERS, ...every }, ["! Cache-Control", `Cache-Control: ${VISITOR_FILE_CACHE}`]);

/**
 * The text of site/_headers for a site of that kind of proof log.
 *
 * - /proof and everything under it: the card proof page's headers
 *   (`proofPageHeaders`, with the data domain of that kind of proof log). In the local workerd a rule matches whether or
 *   not there is a file, so a 404, a redirect and a 405 under /proof have
 *   them too. On Cloudflare the 404 and the redirect were seen to; the
 *   405 needs a file to be there (README.md, "Static Assets").
 * - /pages.css, /copy.js and /fonts/*: the visitors' pages' headers
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
    visitorFile("/fonts/*", every),
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
  console.log(`Wrote _headers, _redirects and ${FONT_FILE} in ${SITE_DIR}, for a test log's site.`);
}
