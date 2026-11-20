// What the tests of the visitors' pages share: a roster built by submitting
// card proofs over several days, and the checks every page must pass.
// Everything goes through the Worker's HTTP (test/harness.ts).
import assert from "node:assert/strict";
import { parseDay } from "iamreal-protocol/date.ts";
import { parseScopedId } from "iamreal-protocol/scoped-id.ts";
import { testRosterLine } from "./copy.ts";
import type { TestWorker } from "./harness.ts";
import { freshRoster, mustSubmit, newCard, publishCrl, sub, tw } from "./records.ts";

/** The short ID of the copy files' example, and of a second card. */
export const CARD_A = "7K2Q9FM4XD";
export const CARD_B = "3M8T1RZ6WA";

/** The date the test roster of these tests says it was last cleared on (the setting `TEST_ROSTER_CLEARED_ON`). */
export const CLEARED_ON = "2026-11-07";

/** One card proof of a test roster: its date, its card and its list ("platform:username"; none is the empty list). */
export interface Rec {
  readonly date: string;
  readonly card: string;
  readonly accounts: readonly string[];
}

export const r = (date: string, card: string, ...accounts: string[]): Rec => ({ date, card, accounts });

/** A new scoped ID that starts with `prefix`. */
export function cardStarting(prefix: string): string {
  const id = prefix + newCard().slice(prefix.length);
  assert.notEqual(parseScopedId(id), null, `${id} is a scoped ID`);
  return id;
}

/**
 * A new roster with these card proofs, submitted in order (their dates must
 * not go back), each at noon of its date with a CRL of that date in the
 * mirror; the clock is left at noon of `today`. Every submission must be
 * written.
 */
export async function pagesWorld(worker: TestWorker, today: string, recs: readonly Rec[], settings: { kind?: "test" | "production" } = {}): Promise<void> {
  await freshRoster(worker, { ...settings, clearedOn: CLEARED_ON });
  let root = "";
  const published = new Set<string>();
  for (const x of recs) {
    await worker.setClock(tw(x.date, "12:00:00"));
    if (!published.has(x.date)) {
      root = await publishCrl(worker, { issuer: "G3", number: parseDay(x.date)!, thisUpdate: tw(x.date, "05:00:00"), serials: [11, 12] });
      published.add(x.date);
    }
    const s = await sub(worker, x.card, root, ...x.accounts);
    const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(settings.kind === "production" ? { ...s, scope_string: "iamreal:public:0_______________" } : s) });
    assert.equal(res.status, 201, `${x.date} ${x.card} ${x.accounts.join(" ")}: ${await res.clone().text()}`);
  }
  await worker.setClock(tw(today, "12:00:00"));
}

export { mustSubmit };

/** The policy of the visitors' pages (README.md, "訪客的頁面送的標頭"). */
export const VISITOR_CSP = "default-src 'none'; style-src 'self'; img-src 'self'; frame-src https://www.threads.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** What a response of the visitors' pages has for headers: these, each with this value, and no other. `noindex` is false on the production roster. */
export function checkVisitorHeaders(what: string, res: Response, expect: { cache: string; noindex?: boolean; more?: readonly string[] }): void {
  const want: Record<string, string> = {
    "content-security-policy": VISITOR_CSP,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-opener-policy": "same-origin",
    "cache-control": expect.cache,
    ...(expect.noindex !== false && { "x-robots-tag": "noindex" }),
  };
  const got: Record<string, string> = {};
  // What the local workerd adds on its way out, or what says how the body is sent, is not the Worker's.
  const transport = new Set(["content-type", "content-length", "transfer-encoding", "mf-content-encoding", "content-encoding", "connection", "date", "vary", "etag", ...(expect.more ?? [])]);
  res.headers.forEach((value, name) => {
    if (!transport.has(name)) got[name] = value;
  });
  assert.deepEqual(got, want, `${what}: the headers`);
  assert.equal(res.headers.get("set-cookie"), null, `${what}: no cookie`);
}

const NAV_LINKS = `<a href="/verify">怎麼驗證</a>
<a href="/roster">名冊</a>
<a href="/faq">常見問題</a>
<a href="https://github.com/iamreal-tw/iamreal">GitHub</a>`;

/**
 * Requests a page and checks what every page of the visitors must be: the
 * headers; HTML with no script, no inline style, no event attribute and no
 * description (but the home page's); the navigation bar and the foot; and,
 * on a test roster, the mark with the date it was last cleared on, above
 * everything else, and `noindex`. Returns the status and the body.
 */
export async function getPage(worker: TestWorker, path: string, expect: { test?: boolean; cache?: string } = {}): Promise<{ status: number; page: string; res: Response }> {
  const res = await worker.fetch(path, { redirect: "manual" });
  const page = await res.text();
  const test = expect.test !== false;
  checkVisitorHeaders(path, res, { cache: expect.cache ?? "public, max-age=60", noindex: test });
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8", `${path}: Content-Type`);
  assert.doesNotMatch(page, /<\s*script/i, `${path}: no script`);
  assert.doesNotMatch(page, /\son[a-z]+\s*=/i, `${path}: no event attribute`);
  assert.doesNotMatch(page, /\sstyle\s*=|<\s*style/i, `${path}: no inline style`);
  assert.doesNotMatch(page, path.split("?")[0] === "/" ? /name="description"|og:image/i : /name="description"|og:description|og:image/i, `${path}: no description`);
  for (const part of ['<link rel="stylesheet" href="/pages.css">', NAV_LINKS, '<a class="button nav-button" href="/proof">我要換島民證明</a>', '<a href="/proof/help.html?topic=prepare">怎麼準備</a>']) {
    assert.ok(page.includes(part), `${path}: the page has ${part}`);
  }
  const mark = `<p class="test-roster">${testRosterLine(CLEARED_ON)}</p>`;
  assert.equal(page.includes("測試名冊"), test, `${path}: says 測試名冊`);
  assert.equal(page.includes('<meta name="robots" content="noindex">'), test, `${path}: noindex in the page`);
  if (test) {
    assert.ok(page.includes(mark), `${path}: the mark of the test roster, with the date`);
    assert.ok(page.indexOf(mark) < page.indexOf("<main>"), `${path}: the mark is above everything else`);
  }
  return { status: res.status, page, res };
}
