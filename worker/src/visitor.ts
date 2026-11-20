// What the Worker serves that is not the API: the visitors' pages and the
// card proof page.
//
//   /            the home page (design/copy/home.md)
//   /p/…         the page of a card (design/copy/proof-page.md)
//   /pages.css   the style sheet of the visitors' pages
//   /proof       the card proof page: index.html of the build of web/;
//                /proof/ is redirected to /proof
//   /proof/…     the other files of that build
//
// The pages are made here, from what `PageData` answers (page-data.ts); the
// style sheet and the card proof page are files of Static Assets
// (wrangler.jsonc, "assets"), which the Worker sends with its own headers
// (headers.ts): no file is served past this code.
//
// Every page and file takes GET and HEAD only, sets no cookie, and is made
// without reading anything of the request but its method and its path.
// Nothing is written for a request that is answered; when the back end
// itself fails, one line says which kind of page and where, never the short
// ID or anything else of the address.
import { readShortIdInUrl } from "iamreal-protocol/scoped-id.ts";
import { EVERY_RESPONSE, PROOF_PAGE_HEADERS, ROSTER_PAGE_CACHE, TEST_SITE_HEADERS, VISITOR_HEADERS } from "./headers.ts";
import type { PageData } from "./page-data.ts";
import { homePage } from "./pages/home.ts";
import { CSS_PATH, type Document, type Site, layout } from "./pages/layout.ts";
import { PLATFORM, proofMissing, proofPage } from "./pages/proof.ts";
import { OTHER_SCHEMA } from "./roster.ts";
import { rosterSettingsOf } from "./settings.ts";

/** Where the card proof page is: the base the build of web/ is made for. Every file of that build is under PROOF_PATH + "/". */
export const PROOF_PATH = "/proof";

/** What the pages are given besides the environment: the piece that is behind an interface, so that it can be replaced by itself. */
export interface VisitorParts {
  /** What the pages read of the roster (page-data.ts). */
  readonly pageData: PageData;
}

/** Where the back end failed, as the one line about it says (`where`). */
type Where = "settings" | "schema" | "roster" | "render" | "files";

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

/** Which kind of page a path is, for the log and to choose its headers; null if it is none. */
function kindOf(pathname: string): "home" | "card" | "css" | "proof" | null {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/p/")) return "card";
  if (pathname === CSS_PATH) return "css";
  if (pathname === PROOF_PATH || pathname.startsWith(`${PROOF_PATH}/`)) return "proof";
  return null;
}

/** What a page handler answers, before the headers every answer of its kind has. */
interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | ReadableStream | null;
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
  if (short === null) return page(site, 404, proofMissing(typed));
  const found = await ask(() => parts.pageData.cards(short));
  if (found.cards.length === 0) return page(site, 404, proofMissing(typed));
  try {
    return page(site, 200, proofPage(short, found));
  } catch (e) {
    throw e instanceof Internal ? e : new Internal("render", e);
  }
}

/** A file of Static Assets at `path`, asked for as `request` asks: its body, and of its headers the ones that describe the file. */
async function file(request: Request, env: Env, path: string): Promise<Answer> {
  let res: Response;
  try {
    const headers = new Headers();
    for (const name of ["If-None-Match", "If-Modified-Since"]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    res = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: request.method, headers }));
  } catch (e) {
    throw new Internal("files", e);
  }
  if (res.status !== 200 && res.status !== 304) return text(404, "not found\n");
  const headers: Record<string, string> = {};
  for (const name of ["Content-Type", "ETag", "Cache-Control"]) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: res.status, headers, body: res.body };
}

/** The style sheet: a file, asked for again every time it is used (`no-cache`), by its ETag. */
async function css(request: Request, env: Env): Promise<Answer> {
  const answer = await file(request, env, CSS_PATH);
  if (answer.status === 404) throw new Internal("files", new Error("the style sheet is not among the files"));
  return { ...answer, headers: { ...answer.headers, "Cache-Control": "no-cache" } };
}

/** The card proof page and its files. */
async function proof(request: Request, env: Env, pathname: string): Promise<Answer> {
  if (pathname === `${PROOF_PATH}/`) return { status: 301, headers: { Location: PROOF_PATH }, body: null };
  return file(request, env, pathname === PROOF_PATH ? `${PROOF_PATH}/index.html` : pathname);
}

/** Whether this code answers for the path: the visitors' pages, their style sheet, and the card proof page with its files. */
export function isVisitorPath(pathname: string): boolean {
  return kindOf(pathname) !== null;
}

/** Answers a request for a page or one of its files. */
export async function visitor(request: Request, env: Env, parts: VisitorParts): Promise<Response> {
  const { pathname } = new URL(request.url);
  const kind = kindOf(pathname);
  if (kind === null) return notFound();
  let answer: Answer;
  let site: Site | null = null;
  try {
    try {
      const settings = rosterSettingsOf(env);
      site = { testRosterClearedOn: settings.testRosterClearedOn };
    } catch (e) {
      throw new Internal("settings", e);
    }
    if (request.method !== "GET" && request.method !== "HEAD") answer = { ...text(405, "method not allowed\n"), headers: { ...text(405, "").headers, Allow: "GET, HEAD" } };
    else if (kind === "home") answer = await home(site, parts);
    else if (kind === "card") answer = await card(site, parts, pathname);
    else if (kind === "css") answer = await css(request, env);
    else answer = await proof(request, env, pathname);
  } catch (e) {
    const cause = e instanceof Internal ? e.cause : e;
    console.error(JSON.stringify({ event: "internal_error", page: kind, where: e instanceof Internal ? e.where : "render", error: cause instanceof Error ? cause.name : "unknown" }));
    answer = text(500, "internal error\n");
  }
  const headers = new Headers({
    ...answer.headers,
    ...EVERY_RESPONSE,
    ...(kind === "proof" ? PROOF_PAGE_HEADERS : VISITOR_HEADERS),
    // With settings that cannot be read, nothing says this is not a test roster's site.
    ...(site === null || site.testRosterClearedOn !== null ? TEST_SITE_HEADERS : {}),
  });
  return new Response(request.method === "HEAD" ? null : answer.body, { status: answer.status, headers });
}

/** The answer for a path that is nothing of the site. */
export function notFound(): Response {
  return new Response("not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...EVERY_RESPONSE } });
}
