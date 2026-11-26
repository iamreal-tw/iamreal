// The check of a deployed test site that needs no card and no browser
// (README.md, "部署之後不插卡的檢查"). It only sends GET requests, to the
// site and to its data domain, and prints a line for each thing checked:
//
//   node --experimental-strip-types test/site-check.ts
//   node --experimental-strip-types test/site-check.ts https://test.iamreal.tw https://test-data.iamreal.tw
//
// - every kind of page the Worker makes answers with its status and with
//   the headers of src/headers.ts, says it is a test log's with the date
//   wrangler.jsonc has (`TEST_PROOF_LOG_CLEARED_ON`), and sets no cookie; the
//   page of a card that is not on the proof log is a 404;
// - no page has a script that is not a file of the site itself. The pages
//   are asked for as a browser asks (`Accept: text/html`): what stands
//   between the Worker and the visitor may add to a page only then;
// - the style sheet, the copy buttons' script and the card proof page are
//   there (the page in a browser, up to its first screen, is another check:
//   web/test/e2e/smoke.ts), and the old address of its help page goes to
//   /prepare;
// - `config` and `fingerprint` answer, uncached;
// - the archive index of the data domain has, for each issuer key, a usable
//   CRL that is at most 3 days old, the age `config` gives devices;
// - the last line of the published fingerprint file is what `fingerprint`
//   answers, and its date is today's or yesterday's: a proof log whose daily
//   publication stopped fails here. One that was not published yet has no
//   file and no date, and passes up to two days after the date it was
//   cleared on;
// - the data domain lets the site's pages read it from a browser, and no
//   other site's (CORS).
//
// On the local Worker of `pnpm local` (scripts/local.ts) the data domain is
// the site's own origin, and the same command checks it:
//
//   node --experimental-strip-types test/site-check.ts http://localhost:8080 http://localhost:8080
//
// Two lines are about Cloudflare's running of the proof log, not about the
// build, and are left out there: CORS (the page reads the files from its own
// origin), and the daily publication (a local proof log publishes only at a
// midnight the command was running over).
//
// What it cannot see, sending only GET: whether a card proof would be taken.
// A paused proof log and one whose object knows no CRL yet answer every GET as
// any other (README.md says how to tell).
//
// The same checks run on the local Worker in test/site-check.test.ts. Not a
// part of `pnpm test` by itself: it is the test's to say that the check
// checks, and an operator's or an agent's to run it on the deployed site.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Day, formatDay, parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import { ISSUER_NAMES } from "../src/issuers.ts";
import { FAVICON_FILE, FONT_FILE, OG_IMAGE_FILE } from "../scripts/site-files.ts";
import { testProofLogLine } from "./copy.ts";
import { newestCrls, readIndex } from "../src/crl-index.ts";
import { EVERY_RESPONSE, PROOF_LOG_PAGE_CACHE, SCRIPT_PAGE_HEADERS, VISITOR_FILE_CACHE, TEST_SITE_HEADERS, VISITOR_HEADERS } from "../src/headers.ts";

/** Sends a GET for a path of the site or of the data domain, with these request headers if any; redirects are not followed. */
export type Reader = (path: string, headers?: Readonly<Record<string, string>>) => Promise<Response>;

export interface CheckLine {
  readonly ok: boolean;
  readonly what: string;
}

/** The short ID of the examples (CONTRIBUTING.md): no card of a proof log is expected to have it. */
const NO_SUCH_CARD = "7K2Q9FM4XD";
/** How old the newest usable CRL of an issuer key may be, in days: what `config` tells devices (`crl_max_age_days`). */
const CRL_MAX_AGE_DAYS = 3;
const DAILY = "public, max-age=60";
/** For how many days after the date a test log was cleared on it may be without a published line. */
const NEVER_PUBLISHED_DAYS = 2;

/** Why the response does not have each of these headers with this value, or null. */
function headersProblem(res: Response, want: Readonly<Record<string, string>>): string | null {
  for (const [name, value] of Object.entries(want)) {
    if (res.headers.get(name) !== value) return `${name} is ${JSON.stringify(res.headers.get(name))}, not ${JSON.stringify(value)}`;
  }
  return res.headers.get("set-cookie") === null ? null : "it sets a cookie";
}

/**
 * Checks the site and its data domain; a line for each thing checked.
 * `today` is the date in Taiwan (YYYY-MM-DD), `clearedOn` the date the
 * pages are to say the test log was last cleared on. `local`: the
 * site is the local Worker of `pnpm local`, whose data domain is its own
 * origin; the two lines about Cloudflare's running of the proof log are left out.
 */
export async function checkSite(parts: { site: Reader; data: Reader; today: string; clearedOn: string; siteOrigin?: string; local?: boolean }): Promise<CheckLine[]> {
  const siteOrigin = parts.siteOrigin ?? "https://test.iamreal.tw";
  // Every request for the site is sent as a browser sends it: what stands between the Worker and the visitor may
  // answer a request that accepts HTML otherwise than one that does not say (README.md, "Cloudflare 上看過的").
  const html = (path: string): Promise<Response> => parts.site(path, { Accept: "text/html" });
  const file = (path: string): Promise<Response> => parts.site(path, { Accept: "*/*" });
  /** The scripts of a page that are not a file of this site: one from elsewhere, or one written into the page. No page of the repository has either. */
  const foreignScriptsOf = (page: string): string[] => (page.match(/<script\b[^>]*>/gi) ?? []).filter((tag) => !/\ssrc="\/[^/"][^"]*"/.test(tag));
  /** The pages whose HTML has such a script. */
  const foreignScripts: string[] = [];
  const noteScripts = (path: string, page: string): void => {
    const foreign = foreignScriptsOf(page);
    if (foreign.length > 0) foreignScripts.push(`${path} has ${foreign[0]!.slice(0, 120)}`);
  };
  const lines: CheckLine[] = [];
  /** One line: `problem` is null when the thing is as it should be. A request that fails is the line's problem. */
  const check = async (what: string, problem: () => Promise<string | null>): Promise<void> => {
    let found: string | null;
    try {
      found = await problem();
    } catch (e) {
      found = `the request failed (${e instanceof Error ? e.message : "unknown"})`;
    }
    lines.push({ ok: found === null, what: found === null ? what : `${what}: ${found}` });
  };

  // The pages the Worker makes.
  const pageHeaders = { ...EVERY_RESPONSE, ...VISITOR_HEADERS, ...TEST_SITE_HEADERS, "Cache-Control": PROOF_LOG_PAGE_CACHE, "Content-Type": "text/html; charset=utf-8" };
  const pages: readonly (readonly [path: string, status: number, script?: true])[] = [
    ["/", 200],
    [`/p/${NO_SUCH_CARD}`, 404],
    ["/threads/@alice", 200],
    ["/proof-log", 200],
    ["/faq", 200, true],
    ["/verify", 200, true],
    ["/check", 200],
    ["/prepare", 200],
    ["/hang", 200],
    ["/no-such-page", 404],
  ];
  for (const [path, status, script] of pages) {
    await check(`GET ${path}`, async () => {
      const res = await html(path);
      const page = await res.text();
      noteScripts(path, page);
      if (res.status !== status) return `the status is ${res.status}, not ${status}`;
      // The sentence of design/copy/test-site.md, its date in an element of its own, as the pages write it (test/pages.ts, `testProofLogMark`).
      const mark = `<p class="test-proof-log">${testProofLogLine(parts.clearedOn).replace(parts.clearedOn, `<time>${parts.clearedOn}</time>`)}</p>`;
      if (!page.includes(mark)) return `the page does not have the mark of a test log with the date ${parts.clearedOn}`;
      if (!page.includes('<meta name="robots" content="noindex">')) return "the page does not say noindex";
      return headersProblem(res, script === true ? { ...pageHeaders, ...SCRIPT_PAGE_HEADERS } : pageHeaders);
    });
  }

  // The files Static Assets sends.
  const fileHeaders = { ...EVERY_RESPONSE, ...VISITOR_HEADERS, ...TEST_SITE_HEADERS, "Cache-Control": VISITOR_FILE_CACHE };
  for (const path of ["/pages.css", "/copy.js", `/${FAVICON_FILE}`, `/${FONT_FILE}`, `/${OG_IMAGE_FILE}`]) {
    await check(`GET ${path}`, async () => {
      const res = await file(path);
      await res.arrayBuffer();
      return res.status === 200 ? headersProblem(res, fileHeaders) : `the status is ${res.status}, not 200`;
    });
  }
  // The card proof page: that it is there. Its policy and what the page does in a browser are web/test/e2e/smoke.ts's to check.
  await check("GET /proof", async () => {
    const res = await html("/proof");
    const page = await res.text();
    if (res.status !== 200) return `the status is ${res.status}, not 200`;
    noteScripts("/proof", page);
    return headersProblem(res, { ...EVERY_RESPONSE, ...TEST_SITE_HEADERS });
  });
  // Its help page is gone; the old address, which the apps still link to, goes to /prepare.
  await check("GET /proof/help.html", async () => {
    const res = await html("/proof/help.html");
    await res.arrayBuffer();
    const to = res.headers.get("location");
    return res.status === 301 && to === "/prepare" ? null : `the status is ${res.status} to ${JSON.stringify(to)}, not 301 to "/prepare"`;
  });
  await check("no page has a script that is not a file of this site", async () => (foreignScripts.length === 0 ? null : foreignScripts.join("; ")));

  // The API, as far as a GET goes.
  const apiHeaders = { ...EVERY_RESPONSE, "Cache-Control": "no-store", "Content-Type": "application/json" };
  await check("GET /api/v1/config", async () => {
    const res = await file("/api/v1/config");
    const body = await res.text();
    if (res.status !== 200) return `the status is ${res.status}, not 200`;
    const config = JSON.parse(body) as { crl_max_age_days?: unknown; platforms?: { platform?: unknown }[] };
    if (config.crl_max_age_days !== CRL_MAX_AGE_DAYS) return `crl_max_age_days is ${JSON.stringify(config.crl_max_age_days)}, not ${CRL_MAX_AGE_DAYS}`;
    const platforms = (config.platforms ?? []).map((p) => p.platform).join(" ");
    if (platforms !== "test-example threads") return `the platforms are ${JSON.stringify(platforms)}, not the test log's`;
    return headersProblem(res, apiHeaders);
  });
  let fingerprint: string | null = null;
  await check("GET /api/v1/fingerprint", async () => {
    const res = await file("/api/v1/fingerprint");
    const body = await res.text();
    if (res.status !== 200) return `the status is ${res.status}, not 200`;
    fingerprint = body;
    return headersProblem(res, apiHeaders);
  });

  // The data domain: the CRL archive.
  const today = parseDay(parts.today);
  if (today === null) throw new Error(`${parts.today} is not a date`);
  let index: ReturnType<typeof newestCrls> | null = null;
  await check("the data domain: GET /crl/index.jsonl", async () => {
    const res = await parts.data("/crl/index.jsonl");
    const text = await res.text();
    if (res.status !== 200) return `the status is ${res.status}, not 200`;
    index = newestCrls(readIndex(text));
    return headersProblem(res, { "Cache-Control": DAILY });
  });
  for (const issuer of ISSUER_NAMES) {
    await check(`the data domain: a usable CRL of ${issuer} at most ${CRL_MAX_AGE_DAYS} days old`, async () => {
      if (index === null) return "there is no index to look in";
      const newest = index[issuer][0];
      if (newest === undefined) return `the index has no usable CRL of ${issuer}`;
      const day: Day | null = parseDay(newest.crlDate);
      return day !== null && day >= today - CRL_MAX_AGE_DAYS && day <= today + 1 ? null : `the newest usable CRL of ${issuer} (number ${newest.crlNumber}) is dated ${newest.crlDate}; today is ${parts.today}`;
    });
  }

  // The proof log is published every day: the last line is today's, or yesterday's until the alarm of midnight has run.
  // A proof log that was never published has no date. That is so on the day its object first ran, which for the proof log
  // in place after a clearing is the date it was cleared on or, deployed close to midnight, the day after; the first
  // line is written at the midnight after that. So no date passes up to two days after the clearing, and no longer:
  // an object that was never published by then does not publish (it started paused, or takes itself for replaced).
  if (parts.local !== true) await check("GET /api/v1/fingerprint: the proof log was published today or yesterday, or was cleared at most 2 days ago and not published yet", async () => {
    if (fingerprint === null) return "the API did not answer";
    const { date } = JSON.parse(fingerprint) as { date?: unknown };
    if (date === null) {
      const cleared = parseDay(parts.clearedOn);
      return cleared !== null && today <= cleared + NEVER_PUBLISHED_DAYS ? null : `nothing was published yet, and the proof log was last cleared on ${parts.clearedOn}; today is ${parts.today}`;
    }
    const day = typeof date === "string" ? parseDay(date) : null;
    return day !== null && (day === today || day === today - 1) ? null : `the last line published is dated ${JSON.stringify(date)}; today is ${parts.today}`;
  });

  // The data domain: a page of the site may read it from a browser, a page of another site may not (ADR-0027).
  if (parts.local !== true) await check(`the data domain: CORS allows ${siteOrigin} and no other origin`, async () => {
    const allowed = async (origin: string): Promise<string | null> => {
      const res = await parts.data("/crl/index.jsonl", { Origin: origin });
      await res.arrayBuffer();
      return res.headers.get("access-control-allow-origin");
    };
    const [own, other] = [await allowed(siteOrigin), await allowed("https://example.com")];
    if (own !== siteOrigin) return `for ${siteOrigin}, Access-Control-Allow-Origin is ${JSON.stringify(own)}`;
    return other === null ? null : `for https://example.com, Access-Control-Allow-Origin is ${JSON.stringify(other)}`;
  });

  // The data domain: the last line of the fingerprint file is what the API answers. A proof log that was
  // not published yet (the day its object first ran, or the day it was cleared) has no file and no date.
  await check("the data domain: the last line of /proof-log/fingerprints.jsonl is what GET /api/v1/fingerprint answers", async () => {
    if (fingerprint === null) return "the API did not answer";
    const res = await parts.data("/proof-log/fingerprints.jsonl");
    const text = await res.text();
    if (res.status === 404) return (JSON.parse(fingerprint) as { date?: unknown }).date === null ? null : `there is no file, and the API answers ${fingerprint}`;
    if (res.status !== 200) return `the status is ${res.status}, not 200 or 404`;
    const last = text.split("\n").at(-2) ?? "";
    if (last !== fingerprint.trimEnd()) return `the file ends with ${JSON.stringify(last)}, the API answers ${fingerprint.trimEnd()} (both are kept for a minute: try again after one)`;
    return headersProblem(res, { "Cache-Control": DAILY });
  });
  return lines;
}

/**
 * Checks a running site and its data domain as the command line does,
 * prints a line for each thing checked and a last line, and returns how
 * many failed. The date of the clearing is wrangler.jsonc's. A data domain
 * at the site's own origin is the local Worker of `pnpm local`
 * (scripts/local.ts), checked with `local`.
 */
export async function runSiteCheck(site: string, data: string): Promise<number> {
  const { unstable_readConfig } = await import("wrangler");
  const config = join(fileURLToPath(new URL("..", import.meta.url)), "wrangler.jsonc");
  const clearedOn = String(unstable_readConfig({ config, env: "test" }, { hideWarnings: true }).vars.TEST_PROOF_LOG_CLEARED_ON);
  const reader = (origin: string): Reader => (path, headers) => fetch(new URL(path, origin), { redirect: "manual", headers: { ...headers } });
  const today = formatDay(taiwanDay(Date.now()));
  // The data domain at the site's own origin: the local Worker of `pnpm local`.
  const local = new URL(site).origin === new URL(data).origin;
  console.log(`${site} and ${data}, ${today} in Taiwan; wrangler.jsonc says the test log was last cleared on ${clearedOn}`);
  if (local) console.log("the data domain is the site's own origin (pnpm local): CORS and the daily publication are not checked");
  const lines = await checkSite({ site: reader(site), data: reader(data), today, clearedOn, siteOrigin: new URL(site).origin, local });
  for (const line of lines) console.log(`${line.ok ? "ok    " : "FAIL  "} ${line.what}`);
  const failures = lines.filter((l) => !l.ok).length;
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = await runSiteCheck(process.argv[2] ?? "https://test.iamreal.tw", process.argv[3] ?? "https://test-data.iamreal.tw");
  process.exit(failures ? 1 : 0);
}
