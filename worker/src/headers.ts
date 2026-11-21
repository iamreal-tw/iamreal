// The headers of everything the site sends that is not the API's: the one
// place they are defined. README.md, "頁面送的標頭", gives the reason for
// each; the API's are in api.ts. They are the Go backend's
// (server/headers.go, server/visitor.go), word for word.
//
// The Worker sends the ones of the pages it makes (visitor.ts). The files
// (the card proof page's, the style sheet) are sent by Static Assets, past
// the Worker's code, with the headers of site/_headers, which
// scripts/site-files.ts writes from the values here.
import type { Roster as RosterKind } from "iamreal-protocol/scope.ts";

/** Sent with every response. */
export const EVERY_RESPONSE: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
};

/**
 * Sent with the visitors' pages and their style sheet, besides
 * EVERY_RESPONSE (the style sheet's by site/_headers).
 *
 *   - Content-Security-Policy: no script at all; the style sheet and images
 *     of this origin; frames from https://www.threads.com only (the profile
 *     on the page of a card); forms sent to this origin only (the lookup box
 *     of the roster page); the page cannot be framed.
 *   - Referrer-Policy: a link on a page tells the site it leads to nothing
 *     of the page's address, which has a short ID in it.
 *   - Cross-Origin-Opener-Policy: a page that opened this one, or that this
 *     one opens, has no hold on it.
 *   - No Cross-Origin-Embedder-Policy and no Document-Isolation-Policy: the
 *     Threads frame would be blocked.
 */
export const VISITOR_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * The data domain of each kind of roster (ADR-0027, ADR-0028): where its
 * public files are downloaded from, the CRL archive the card proof page
 * reads among them. The page's build names the same one (web/README.md,
 * "資料網域").
 */
export const DATA_ORIGINS: Readonly<Record<RosterKind, string>> = { production: "https://data.iamreal.tw", test: "https://test-data.iamreal.tw" };

/**
 * Sent with every file of the card proof page (/proof and under /proof/) of
 * a site of that kind of roster, besides EVERY_RESPONSE: the pages, their
 * scripts and workers, the circuits and the CRS. Static Assets sends them,
 * by site/_headers; nothing of the Worker's code does. The page may connect
 * to its own origin and to its roster's data domain, so the two kinds
 * differ in that one address. web/README.md, "頁面需要的標頭", explains each
 * and quotes both policies; a test checks that what is sent is what it
 * quotes (test/proof-files.test.ts).
 */
export function proofPageHeaders(kind: RosterKind): Readonly<Record<string, string>> {
  return {
    "Content-Security-Policy": `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ${DATA_ORIGINS[kind]}; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "Document-Isolation-Policy": "isolate-and-credentialless",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };
}

/**
 * Sent with all of the above on a test roster's site: no page of it, and no
 * file of it, is to be listed by a search engine (ADR-0028). The pages say
 * the same in a <meta> of their own.
 */
export const TEST_SITE_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": "noindex",
};

/**
 * The style sheet's Cache-Control: asked for again every time it is used,
 * by its ETag (site/_headers).
 */
export const STYLE_SHEET_CACHE = "no-cache";

/**
 * How long a page that shows the roster may be kept by a cache: 60 seconds,
 * whether it found what was asked for or not (ADR-0026). Without it a
 * cache in front of the Worker would keep a `404` for longer than that.
 */
export const ROSTER_PAGE_CACHE = "public, max-age=60";
