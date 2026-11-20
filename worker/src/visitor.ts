// What the Worker serves that is not the API: the visitors' pages.
//
//   /            the home page (design/copy/home.md)
//   /p/…         the page of a card (design/copy/proof-page.md)
//   anything else the page for what is not there (design/copy/not-found.md),
//                with 404
//
// The pages are made here, from what `PageData` answers (page-data.ts).
// Their style sheet (/pages.css) and the card proof page (/proof and
// everything under it) are not: they are files of Static Assets, which
// sends them itself, and a request for one of those paths does not run the
// Worker at all (wrangler.jsonc, "assets"; README.md, "Static Assets"). The
// Worker has no binding to read those files by.
//
// Every page takes GET and HEAD only, sets no cookie, and is made
// without reading anything of the request but its method and its path.
// Nothing is written for a request that is answered; when the back end
// itself fails, one line says which kind of page and where, never the short
// ID or anything else of the address.
import { readShortIdInUrl } from "iamreal-protocol/scoped-id.ts";
import { EVERY_RESPONSE, ROSTER_PAGE_CACHE, TEST_SITE_HEADERS, VISITOR_HEADERS } from "./headers.ts";
import type { PageData } from "./page-data.ts";
import { homePage } from "./pages/home.ts";
import { type Document, type Site, layout } from "./pages/layout.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { PLATFORM, proofMissing, proofPage } from "./pages/proof.ts";
import { OTHER_SCHEMA } from "./roster.ts";
import { rosterSettingsOf } from "./settings.ts";

/** What the pages are given besides the environment: the piece that is behind an interface, so that it can be replaced by itself. */
export interface VisitorParts {
  /** What the pages read of the roster (page-data.ts). */
  readonly pageData: PageData;
}

/** Where the back end failed, as the one line about it says (`where`). */
type Where = "settings" | "schema" | "roster" | "render";

class Internal extends Error {
  readonly where: Where;
  constructor(where: Where, cause: unknown) {
    super(where, { cause });
    this.where = where;
  }
}

/** Asks for the roster's data; a failure is `roster`, or `schema` when the object says its tables are of another version. */
async function ask<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Internal(e instanceof Error && e.message === OTHER_SCHEMA ? "schema" : "roster", e);
  }
}

/** Which kind of page a path is, for the log: the home page, the page of a card, or the page for what is none. */
function kindOf(pathname: string): "home" | "card" | "none" {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/p/")) return "card";
  return "none";
}

/** What a page handler answers, before the headers every answer of its kind has. */
interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

const text = (status: number, body: string): Answer => ({ status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body });

function page(site: Site, status: number, document: Document): Answer {
  let body: string;
  try {
    body = layout(site, document);
  } catch (e) {
    throw new Internal("render", e);
  }
  return { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": ROSTER_PAGE_CACHE }, body };
}

/** `GET /`: the home page, with the roster's two numbers. */
async function home(site: Site, parts: VisitorParts): Promise<Answer> {
  const numbers = await ask(() => parts.pageData.counts(PLATFORM));
  try {
    return page(site, 200, homePage(numbers));
  } catch (e) {
    throw e instanceof Internal ? e : new Internal("render", e);
  }
}

/**
 * `GET /p/<short ID>`: the page of a card. The short ID is read as
 * spec/scoped-id.md reads one in a URL; another spelling of a short ID is
 * redirected (301) to its one spelling. One that does not read is the page
 * of section 9 with `404`, and so is one that resolves to no card; only for
 * the second is the roster asked (ADR-0026).
 */
async function card(site: Site, parts: VisitorParts, pathname: string): Promise<Answer> {
  let typed = pathname.slice("/p/".length);
  try {
    typed = decodeURIComponent(typed);
  } catch {
    // Not percent-encoding: what was typed is written back as it is.
  }
  const short = readShortIdInUrl(typed);
  if (short !== null && short !== typed) return { status: 301, headers: { Location: `/p/${short}`, "Cache-Control": ROSTER_PAGE_CACHE }, body: null };
  if (short === null) return page(site, 404, proofMissing(site, typed));
  const found = await ask(() => parts.pageData.cards(short));
  if (found.cards.length === 0) return page(site, 404, proofMissing(site, typed));
  try {
    return page(site, 200, proofPage(site, short, found));
  } catch (e) {
    throw e instanceof Internal ? e : new Internal("render", e);
  }
}

/**
 * Answers a request for anything that is not the API's: a page, or, for a
 * path that is none, the page that says so, with 404. That one has what
 * every page has (on a test roster the mark, the date and noindex), and is
 * kept by a cache as long as the others.
 */
export async function visitor(request: Request, env: Env, parts: VisitorParts): Promise<Response> {
  const { pathname } = new URL(request.url);
  const kind = kindOf(pathname);
  let answer: Answer;
  let site: Site | null = null;
  try {
    try {
      const settings = rosterSettingsOf(env);
      site = { testRosterClearedOn: settings.testRosterClearedOn, host: settings.siteHost };
    } catch (e) {
      throw new Internal("settings", e);
    }
    if (request.method !== "GET" && request.method !== "HEAD") answer = { ...text(405, "method not allowed\n"), headers: { ...text(405, "").headers, Allow: "GET, HEAD" } };
    else if (kind === "home") answer = await home(site, parts);
    else if (kind === "card") answer = await card(site, parts, pathname);
    else answer = page(site, 404, notFoundPage());
  } catch (e) {
    const cause = e instanceof Internal ? e.cause : e;
    console.error(JSON.stringify({ event: "internal_error", page: kind, where: e instanceof Internal ? e.where : "render", error: cause instanceof Error ? cause.name : "unknown" }));
    answer = text(500, "internal error\n");
  }
  const headers = new Headers({
    ...answer.headers,
    ...EVERY_RESPONSE,
    ...VISITOR_HEADERS,
    // With settings that cannot be read, nothing says this is not a test roster's site.
    ...(site === null || site.testRosterClearedOn !== null ? TEST_SITE_HEADERS : {}),
  });
  return new Response(request.method === "HEAD" ? null : answer.body, { status: answer.status, headers });
}
