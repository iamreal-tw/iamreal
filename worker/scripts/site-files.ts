// The two files of site/ that tell Static Assets how to send the others
// (wrangler.jsonc, "assets"; README.md, "Static Assets"):
//
//   site/_headers    the headers of the card proof page's files and of the
//                    style sheet, written here from src/headers.ts, the one
//                    place they are defined. A test roster's site and a
//                    production roster's differ in one header (noindex) and
//                    in the data domain the card proof page may connect to,
//                    so the file is written for one kind of roster.
//   site/_redirects  the one address of the card proof page.
//
// Both are in the repository as a test roster's site needs them, the only
// environment there is: the job that uploads checks the repository out and
// runs none of its scripts, so what it uploads is what a reader of the
// repository sees. Every deploy build checks that they are the ones written
// here for the roster of each environment (deploy-build-checks.ts,
// `checkSiteFiles`), and test/proof-files.test.ts that the local workerd
// sends what they say.
//
// `node --experimental-strip-types scripts/site-files.ts` writes both again,
// after a change of src/headers.ts.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVERY_RESPONSE, STYLE_SHEET_CACHE, TEST_SITE_HEADERS, VISITOR_HEADERS, proofPageHeaders } from "../src/headers.ts";

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
export const RUN_WORKER_FIRST: readonly string[] = ["/*", "!/pages.css", "!/proof", "!/proof/*"];

/**
 * Every file of site/ a deploy uploads besides the card proof page's, by
 * its path under site/, sorted: the style sheet and the two files of rules.
 * The page's files are under site/proof/, which is not in the repository
 * (.gitignore): a deploy builds them there (deploy.ts, `buildSite`) and
 * checks what the directory then holds (proof-page.ts).
 */
export const SITE_FILES: readonly string[] = ["_headers", "_redirects", "pages.css"];

/**
 * The SHA-256 of site/pages.css, the one file of site/ that is not written
 * here: a deploy uploads the style sheet that was reviewed. Change it with
 * the file (`shasum -a 256 site/pages.css`).
 */
export const PAGES_CSS_SHA256 = "fac8914e64556eb62ce23073445dfd323f36c5a7ec140a2b1ca2adf27600fc06";

/** Which roster a site is of (wrangler.jsonc, `ROSTER_KIND`). */
export type RosterKind = "test" | "production";

const block = (path: string, headers: Readonly<Record<string, string>>, more: readonly string[] = []): string =>
  [path, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`), ...more.map((line) => `  ${line}`)].join("\n");

/**
 * The text of site/_headers for a site of that kind of roster.
 *
 * - /proof and everything under it: the card proof page's headers
 *   (`proofPageHeaders`, with the data domain of that kind of roster). In the local workerd a rule matches whether or
 *   not there is a file, so a 404, a redirect and a 405 under /proof have
 *   them too. On Cloudflare the 404 and the redirect were seen to; the
 *   405 needs a file to be there (README.md, "Static Assets").
 * - /pages.css: the visitors' pages' headers (`VISITOR_HEADERS`), and
 *   `STYLE_SHEET_CACHE` in place of the Cache-Control Static Assets sends by
 *   itself (taken off with "!", then set: two values would be joined).
 * - Both: `EVERY_RESPONSE`, and on a test roster's site `TEST_SITE_HEADERS`.
 */
export function siteHeaders(kind: RosterKind): string {
  const every = { ...EVERY_RESPONSE, ...(kind === "test" ? TEST_SITE_HEADERS : {}) };
  const proof = { ...proofPageHeaders(kind), ...every };
  return `${[
    `# The headers Static Assets sends with the files of this directory, for a ${kind} roster's site.`,
    "# Written by scripts/site-files.ts from src/headers.ts: change them there, not here.",
    "",
    block("/proof", proof),
    "",
    block("/proof/*", proof),
    "",
    block("/pages.css", { ...VISITOR_HEADERS, ...every }, ["! Cache-Control", `Cache-Control: ${STYLE_SHEET_CACHE}`]),
  ].join("\n")}\n`;
}

/**
 * The text of site/_redirects: /proof is the build's index.html, sent at
 * that address (200); the two other addresses it could have are redirected
 * to it, as the Go backend did. Every other file is at its own path and
 * nowhere else ("html_handling": "none").
 */
export const SITE_REDIRECTS = `# The card proof page is at /proof and nowhere else (scripts/site-files.ts).
/proof /proof/index.html 200
/proof/ /proof 301
/proof/index.html /proof 301
`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(SITE_DIR, "_headers"), siteHeaders("test"));
  writeFileSync(join(SITE_DIR, "_redirects"), SITE_REDIRECTS);
  console.log(`Wrote _headers and _redirects in ${SITE_DIR}, for a test roster's site.`);
}
