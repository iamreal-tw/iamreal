// What the Worker serves that is not the API: the visitors' pages, the Go
// backend's (e159ab9:server/visitor.go), moved as they were.
//
//   /                 the home page (design/copy/home.md)
//   /p/…              the page of a card (design/copy/proof-page.md)
//   /threads/@…       the page of a Threads account (design/copy/account-page.md)
//   /proof-log           the proof log page (design/copy/proof-log-page.md)
//   /faq              the FAQ (design/copy/faq.md)
//   /verify           how to verify (design/copy/verify.md)
//   /check            how to check an account's proof (design/copy/check.md)
//   /prepare          what a card proof needs (design/copy/prepare.md)
//   /hang, /hang/…    hanging a proof on a profile (design/copy/hang.md)
//   anything else     the page for what is not there
//                     (design/copy/not-found.md), with 404
//
// The pages are made here, from what `PageData` answers (page-data.ts).
// Their style sheet (/pages.css), the copy buttons' script that /verify and
// /hang/… load (/copy.js) and the card proof page (/proof and everything
// under it) are not: they are files of Static Assets, which
// sends them itself, and a request for one of those paths does not run the
// Worker at all (wrangler.jsonc, "assets"; README.md, "Static Assets"). The
// Worker has no binding to read those files by.
//
// Every page takes GET and HEAD only and sets no cookie. A page is made from
// the request's method and path, and the query of /proof-log. Nothing is written for a request that is answered; when
// the back end itself fails, one line says which kind of page and where,
// never the short ID, the account or anything else of the address.
import { readShortIdInUrl } from "iamreal-protocol/scoped-id.ts";
import { EVERY_RESPONSE, PROOF_LOG_PAGE_CACHE, SCRIPT_PAGE_HEADERS, TEST_SITE_HEADERS, VISITOR_HEADERS } from "./headers.ts";
import type { PageData } from "./page-data.ts";
import { accountPage, notAName } from "./pages/account.ts";
import { checkPage } from "./pages/check.ts";
import { faqPage } from "./pages/faq.ts";
import { hangPage, hangWithout } from "./pages/hang.ts";
import { homePage } from "./pages/home.ts";
import { type Document, type Site, layout } from "./pages/layout.ts";
import { notFoundPage } from "./pages/not-found.ts";
import { preparePage } from "./pages/prepare.ts";
import { PLATFORM, isThreadsUsername, proofMissing, proofPage } from "./pages/proof.ts";
import { PAGE_SIZE, proofLogPage, readAfter } from "./pages/proof-log-page.ts";
import { verifyPage } from "./pages/verify.ts";
import { OTHER_SCHEMA } from "./proof-log.ts";
import { proofLogSettingsOf } from "./settings.ts";

/** What the pages are given besides the environment: the piece that is behind an interface, so that it can be replaced by itself. */
export interface VisitorParts {
  /** What the pages read of the proof log (page-data.ts). */
  readonly pageData: PageData;
}

/** Where the back end failed, as the one line about it says (`where`). */
type Where = "settings" | "schema" | "proof_log" | "render";

class Internal extends Error {
  readonly where: Where;
  constructor(where: Where, cause: unknown) {
    super(where, { cause });
    this.where = where;
  }
}

/** Asks for the proof log's data; a failure is `proof_log`, or `schema` when the object says its tables are of another version. */
async function ask<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Internal(e instanceof Error && e.message === OTHER_SCHEMA ? "schema" : "proof_log", e);
  }
}

/** Which kind of page a path is, for the log: never the short ID or the account in it. */
type Kind = "home" | "card" | "account" | "proof_log" | "hang" | "faq" | "verify" | "check" | "prepare" | "none";

function kindOf(pathname: string): Kind {
  if (pathname === "/") return "home";
  if (pathname.startsWith("/p/")) return "card";
  if (pathname.startsWith("/threads/")) return "account";
  if (pathname === "/proof-log") return "proof_log";
  if (pathname === "/faq") return "faq";
  if (pathname === "/verify") return "verify";
  if (pathname === "/check") return "check";
  if (pathname === "/prepare") return "prepare";
  if (pathname === "/hang" || pathname.startsWith("/hang/")) return "hang";
  return "none";
}

/** What a page handler answers, before the headers every answer of its kind has. */
interface Answer {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  /** A page that loads the copy buttons' script: its policy lets scripts of this origin run. */
  readonly script?: boolean;
}

const text = (status: number, body: string): Answer => ({ status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }, body });

function page(site: Site, status: number, document: Document): Answer {
  let body: string;
  try {
    body = layout(site, document);
  } catch (e) {
    throw new Internal("render", e);
  }
  return { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": PROOF_LOG_PAGE_CACHE }, body, script: document.script === true };
}

/** `GET /`: the home page, with the proof log's two numbers. */
async function home(site: Site, parts: VisitorParts): Promise<Answer> {
  const numbers = await ask(() => parts.pageData.counts(PLATFORM));
  try {
    return page(site, 200, homePage(numbers));
  } catch (e) {
    throw e instanceof Internal ? e : new Internal("render", e);
  }
}

/** A redirect, kept by a cache as long as a page (ADR-0026). */
const redirect = (status: 301 | 302 | 303, location: string): Answer => ({ status, headers: { Location: location, "Cache-Control": PROOF_LOG_PAGE_CACHE }, body: null });

/** What was typed after `prefix` in the path, percent-encoding read; as it is if it is not percent-encoding. */
function typedAfter(pathname: string, prefix: string): string {
  const typed = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(typed);
  } catch {
    return typed;
  }
}

/**
 * `GET /p/<short ID>`: the page of a card. The short ID is read as
 * spec/scoped-id.md reads one in a URL; another spelling of a short ID is
 * redirected (301) to its one spelling. One that does not read is the page
 * of section 9 with `404`, and so is one that resolves to no card; only for
 * the second is the proof log asked (ADR-0026).
 */
async function card(site: Site, parts: VisitorParts, pathname: string): Promise<Answer> {
  const typed = typedAfter(pathname, "/p/");
  const short = readShortIdInUrl(typed);
  if (short !== null && short !== typed) return redirect(301, `/p/${short}`);
  if (short === null) return page(site, 404, proofMissing(site, typed));
  const found = await ask(() => parts.pageData.cards(short));
  if (found.cards.length === 0) return page(site, 404, proofMissing(site, typed));
  try {
    return page(site, 200, proofPage(site, short, found));
  } catch (e) {
    throw e instanceof Internal ? e : new Internal("render", e);
  }
}

/** A–Z made lowercase and nothing else: Threads names are ASCII, and other letters stay as they are so that they fail the format check. */
const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * `GET /threads/@<name>`: the page of a Threads account, `200` whether or
 * not a card gives its place to it. A name with uppercase letters is
 * redirected (301) to lowercase; a name not in the Threads format has a page
 * of its own (account-page.md, section 4), `404`. Only a name in the format
 * is asked of the proof log (ADR-0026). A path without the @ is no page.
 */
async function threadsAccount(site: Site, parts: VisitorParts, pathname: string): Promise<Answer> {
  const rest = typedAfter(pathname, "/threads/");
  if (!rest.startsWith("@")) return page(site, 404, notFoundPage());
  const typed = rest.slice(1);
  const name = lowerAscii(typed);
  if (!isThreadsUsername(name)) return page(site, 404, notAName());
  if (name !== typed) return redirect(301, `/threads/@${name}`);
  const cards = await ask(() => parts.pageData.account(PLATFORM, name));
  return page(site, 200, accountPage(name, cards));
}

/**
 * White space at both ends taken off, as Go's `strings.TrimSpace` takes it
 * (`unicode.IsSpace`: the ASCII spaces, U+0085, U+00A0 and the Unicode
 * separators). JavaScript's `trim` differs at two characters: it keeps
 * U+0085 and takes off U+FEFF.
 */
const trimSpace = (s: string): string => s.replace(/^[\t\n\v\f\r \u0085\p{Z}]+|[\t\n\v\f\r \u0085\p{Z}]+$/gu, "");

/**
 * `GET /proof-log`: the proof log page. `?after=` lists the records before a
 * `seq` (the link 更多); one that does not read lists from the latest.
 * `?q=` is the lookup box (proof-log-page.md, 查詢): with the spaces
 * around it and a leading @ taken off, a Threads name in any case is
 * redirected (303) to its page, without asking the proof log; nothing left
 * shows the page as it is; anything else shows the page with what was
 * typed in the box and a line under it, from the latest record.
 */
async function proofLog(site: Site, parts: VisitorParts, query: URLSearchParams): Promise<Answer> {
  const typed = trimSpace(query.get("q") ?? "").replace(/^@/, "");
  let badQuery: string | null = null;
  if (typed !== "") {
    const name = lowerAscii(typed);
    if (isThreadsUsername(name)) return redirect(303, `/threads/@${name}`);
    badQuery = typed;
  }
  const after = badQuery === null && query.has("after") ? readAfter(query.get("after")!) : null;
  const { counts, rows } = await ask(() => parts.pageData.logPart(PLATFORM, after, PAGE_SIZE + 1));
  return page(site, 200, proofLogPage({ counts, rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE, after: after !== null, badQuery }));
}

/**
 * `GET /hang` and `GET /hang/<short ID>`: hanging a proof on a profile,
 * without a proof, or with the proof of a card. The short ID is read as
 * `/p/` reads it, and another spelling redirected (301) to its one
 * spelling. A short ID that does not read, resolves to no card or to
 * several, or to a card with no account on Threads, is redirected (302) to
 * /hang; only a short ID that reads is asked of the proof log.
 */
async function hang(site: Site, parts: VisitorParts, pathname: string): Promise<Answer> {
  if (pathname === "/hang") return page(site, 200, hangWithout());
  const typed = typedAfter(pathname, "/hang/");
  const short = readShortIdInUrl(typed);
  if (short !== null && short !== typed) return redirect(301, `/hang/${short}`);
  if (short === null) return redirect(302, "/hang");
  const { cards } = await ask(() => parts.pageData.cards(short));
  const account = cards.length === 1 ? (cards[0]!.slots.find((s) => s.platform === PLATFORM)?.current ?? null) : null;
  if (account === null) return redirect(302, "/hang");
  return page(site, 200, hangPage(site, short, account));
}

/**
 * Answers a request for anything that is not the API's: a page, or, for a
 * path that is none, the page that says so, with 404. That one has what
 * every page has (on a test log the mark, the date and noindex), and is
 * kept by a cache as long as the others.
 */
export async function visitor(request: Request, env: Env, parts: VisitorParts): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  const kind = kindOf(pathname);
  let answer: Answer;
  let site: Site | null = null;
  try {
    try {
      const settings = proofLogSettingsOf(env);
      site = { testProofLogClearedOn: settings.testProofLogClearedOn, host: settings.siteHost };
    } catch (e) {
      throw new Internal("settings", e);
    }
    if (request.method !== "GET" && request.method !== "HEAD") answer = { ...text(405, "method not allowed\n"), headers: { ...text(405, "").headers, Allow: "GET, HEAD" } };
    else if (kind === "home") answer = await home(site, parts);
    else if (kind === "card") answer = await card(site, parts, pathname);
    else if (kind === "proof_log") answer = await proofLog(site, parts, searchParams);
    else if (kind === "account") answer = await threadsAccount(site, parts, pathname);
    else if (kind === "hang") answer = await hang(site, parts, pathname);
    else if (kind === "faq") answer = page(site, 200, faqPage());
    else if (kind === "verify") answer = page(site, 200, verifyPage());
    else if (kind === "check") answer = page(site, 200, checkPage(site));
    else if (kind === "prepare") answer = page(site, 200, preparePage());
    else answer = page(site, 404, notFoundPage());
  } catch (e) {
    const cause = e instanceof Internal ? e.cause : e;
    console.error(JSON.stringify({ event: "internal_error", page: kind, where: e instanceof Internal ? e.where : "render", error: cause instanceof Error ? cause.name : "unknown" }));
    answer = text(500, "internal error\n");
  }
  const headers = new Headers({
    ...answer.headers,
    ...EVERY_RESPONSE,
    ...(answer.script === true ? SCRIPT_PAGE_HEADERS : VISITOR_HEADERS),
    // With settings that cannot be read, nothing says this is not a test log's site.
    ...(site === null || site.testProofLogClearedOn !== null ? TEST_SITE_HEADERS : {}),
  });
  return new Response(request.method === "HEAD" ? null : answer.body, { status: answer.status, headers });
}
