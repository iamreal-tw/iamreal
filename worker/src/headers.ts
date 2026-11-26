// The headers of everything the site sends that is not the API's: the one
// place they are defined. README.md, "頁面送的標頭", gives the reason for
// each; the API's are in api.ts. They are the Go backend's
// (e159ab9:server/headers.go, e159ab9:server/visitor.go), word for word.
//
// The Worker sends the ones of the pages it makes (visitor.ts). The files
// (the card proof page's, the style sheet) are sent by Static Assets, past
// the Worker's code, with the headers of site/_headers, which
// scripts/site-files.ts writes from the values here.
import type { ProofLog as ProofLogKind } from "iamreal-protocol/scope.ts";

/** Sent with every response. */
export const EVERY_RESPONSE: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
};

/**
 * Sent with the visitors' pages and their style sheet, besides
 * EVERY_RESPONSE (the style sheet's by site/_headers).
 *
 *   - Content-Security-Policy: no script at all; the style sheet, the
 *     headings' typeface and images of this origin; frames from https://www.threads.com only (the profile
 *     on the page of a card); forms sent to this origin only (the lookup box
 *     of the proof log page); the page cannot be framed.
 *   - Referrer-Policy: a link on a page tells the site it leads to nothing
 *     of the page's address, which has a short ID in it.
 *   - Cross-Origin-Opener-Policy: a page that opened this one, or that this
 *     one opens, has no hold on it.
 *   - No Cross-Origin-Embedder-Policy and no Document-Isolation-Policy: the
 *     Threads frame would be blocked.
 */
export const VISITOR_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * VISITOR_HEADERS with scripts of this origin (`script-src 'self'`) and
 * requests to this origin (`connect-src 'self'`): for the pages that load a
 * script of this site, which is every visitor's page the Worker makes but
 * the ones that say a thing is not there or that there were too many
 * requests. Each loads the counts' script (/count.js, ADR-0032), which
 * sends its counts to this origin's `POST /api/v1/counts`; some the copy
 * buttons' too (/faq, /verify, /hang/<short ID>), or the player of the
 * demonstration (/hang, /hang/<short ID>). Only scripts of this origin,
 * which are those three files: no inline script, no other site's. A
 * request only to this origin: a script, of this site or any other, can
 * send nothing anywhere else. The Go backend's `scriptPageHeaders`, with
 * `connect-src` added.
 */
export const SCRIPT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...VISITOR_HEADERS,
  "Content-Security-Policy": VISITOR_HEADERS["Content-Security-Policy"]!.replace("default-src 'none'; ", "default-src 'none'; script-src 'self'; connect-src 'self'; "),
};

/**
 * The data domain of each kind of proof log (ADR-0027, ADR-0028): where its
 * public files are downloaded from, the CRL archive the card proof page
 * reads among them. The page's build names the same one (web/README.md,
 * "資料網域").
 */
export const DATA_ORIGINS: Readonly<Record<ProofLogKind, string>> = { production: "https://data.iamreal.tw", test: "https://test-data.iamreal.tw" };

/**
 * Sent with every file of the card proof page (/proof and under /proof/) of
 * a site of that kind of proof log, besides EVERY_RESPONSE: the pages, their
 * scripts and workers, the circuits and the CRS. Static Assets sends them,
 * by site/_headers; nothing of the Worker's code does. The page may connect
 * to its own origin and to its proof log's data domain, so the two kinds
 * differ in that one address. web/README.md, "頁面需要的標頭", explains each
 * and quotes both policies; a test checks that what is sent is what it
 * quotes (test/proof-files.test.ts).
 */
export function proofPageHeaders(kind: ProofLogKind): Readonly<Record<string, string>> {
  return {
    "Content-Security-Policy": `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ${DATA_ORIGINS[kind]}; img-src 'self'; style-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Document-Isolation-Policy": "isolate-and-credentialless",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };
}

/**
 * Sent with all of the above on a test log's site: no page of it, and no
 * file of it, is to be listed by a search engine (ADR-0028). The pages say
 * the same in a <meta> of their own.
 */
export const TEST_SITE_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": "noindex",
};

/**
 * The Cache-Control of the visitors' files: the style sheet, the copy
 * buttons' script and the headings' typeface (site/_headers): asked for again every time they
 * are used, by their ETag, so that a page never has a subset older than
 * its words.
 */
export const VISITOR_FILE_CACHE = "no-cache";

/**
 * How long a page that shows the proof log may be kept by a cache: 60 seconds,
 * whether it found what was asked for or not (ADR-0026). Without it a
 * cache in front of the Worker would keep a `404` for longer than that.
 */
export const PROOF_LOG_PAGE_CACHE = "public, max-age=60";
