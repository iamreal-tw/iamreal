// The check of a deployed test site that needs no card and no browser
// (README.md, "部署之後不插卡的檢查"). It only sends GET requests, to the
// site and to its data domain, and prints a line for each thing checked:
//
//   node --experimental-strip-types test/site-check.ts
//   node --experimental-strip-types test/site-check.ts https://test.iamreal.tw https://test-data.iamreal.tw
//
// - every kind of page the Worker makes answers with its status and with
//   the headers of src/headers.ts, says it is a test roster's with the date
//   wrangler.jsonc has (`TEST_ROSTER_CLEARED_ON`), and sets no cookie; the
//   page of a card that is not on the roster is a 404;
// - the style sheet, the copy buttons' script and the card proof page are
//   there (the page in a browser, up to its first screen, is another check:
//   web/test/e2e/smoke.ts);
// - `config` and `fingerprint` answer, uncached;
// - the archive index of the data domain has, for each issuer key, a usable
//   CRL that is at most 3 days old, the age `config` gives devices;
// - the last line of the published fingerprint file is what `fingerprint`
//   answers, and its date is today's or yesterday's: a roster whose daily
//   publication stopped fails here. One that was not published yet (the day
//   its object first ran) has no file and no date, and passes;
// - the data domain lets the site's pages read it from a browser, and no
//   other site's (CORS).
//
// What it cannot see, sending only GET: whether a card proof would be taken.
// A paused roster and one whose object knows no CRL yet answer every GET as
// any other (README.md says how to tell).
//
// The same checks run on the local Worker in test/site-check.test.ts. Not a
// part of `pnpm test` by itself: it is the test's to say that the check
// checks, and an operator's or an agent's to run it on the deployed site.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Day, formatDay, parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import { ISSUER_NAMES } from "../src/issuers.ts";
import { testRosterLine } from "./copy.ts";
import { newestCrls, readIndex } from "../src/crl-index.ts";
import { EVERY_RESPONSE, ROSTER_PAGE_CACHE, SCRIPT_PAGE_HEADERS, STYLE_SHEET_CACHE, TEST_SITE_HEADERS, VISITOR_HEADERS } from "../src/headers.ts";

/** Sends a GET for a path of the site or of the data domain, with these request headers if any; redirects are not followed. */
export type Reader = (path: string, headers?: Readonly<Record<string, string>>) => Promise<Response>;

export interface CheckLine {
  readonly ok: boolean;
  readonly what: string;
}

/** The short ID of the examples (CONTRIBUTING.md): no card of a roster is expected to have it. */
const NO_SUCH_CARD = "7K2Q9FM4XD";
/** How old the newest usable CRL of an issuer key may be, in days: what `config` tells devices (`crl_max_age_days`). */
const CRL_MAX_AGE_DAYS = 3;
const DAILY = "public, max-age=60";

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
 * pages are to say the test roster was last cleared on.
 */
export async function checkSite(parts: { site: Reader; data: Reader; today: string; clearedOn: string; siteOrigin?: string }): Promise<CheckLine[]> {
  const siteOrigin = parts.siteOrigin ?? "https://test.iamreal.tw";
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
  const pageHeaders = { ...EVERY_RESPONSE, ...VISITOR_HEADERS, ...TEST_SITE_HEADERS, "Cache-Control": ROSTER_PAGE_CACHE, "Content-Type": "text/html; charset=utf-8" };
  const pages: readonly (readonly [path: string, status: number, script?: true])[] = [
    ["/", 200],
    [`/p/${NO_SUCH_CARD}`, 404],
    ["/threads/@alice", 200],
    ["/roster", 200],
    ["/faq", 200],
    ["/verify", 200, true],
    ["/hang", 200],
    ["/no-such-page", 404],
  ];
  for (const [path, status, script] of pages) {
    await check(`GET ${path}`, async () => {
      const res = await parts.site(path);
      const page = await res.text();
      if (res.status !== status) return `the status is ${res.status}, not ${status}`;
      // The sentence of design/copy/test-site.md, its date in an element of its own, as the pages write it (test/pages.ts, `testRosterMark`).
      const mark = `<p class="test-roster">${testRosterLine(parts.clearedOn).replace(parts.clearedOn, `<time>${parts.clearedOn}</time>`)}</p>`;
      if (!page.includes(mark)) return `the page does not have the mark of a test roster with the date ${parts.clearedOn}`;
      if (!page.includes('<meta name="robots" content="noindex">')) return "the page does not say noindex";
      return headersProblem(res, script === true ? { ...pageHeaders, ...SCRIPT_PAGE_HEADERS } : pageHeaders);
    });
  }

  // The files Static Assets sends.
  const fileHeaders = { ...EVERY_RESPONSE, ...VISITOR_HEADERS, ...TEST_SITE_HEADERS, "Cache-Control": STYLE_SHEET_CACHE };
  for (const path of ["/pages.css", "/copy.js"]) {
    await check(`GET ${path}`, async () => {
      const res = await parts.site(path);
      await res.arrayBuffer();
      return res.status === 200 ? headersProblem(res, fileHeaders) : `the status is ${res.status}, not 200`;
    });
  }
  // The card proof page: that it is there. Its policy and what it does in a browser are web/test/e2e/smoke.ts's to check.
  await check("GET /proof", async () => {
    const res = await parts.site("/proof");
    await res.arrayBuffer();
    return res.status === 200 ? headersProblem(res, { ...EVERY_RESPONSE, ...TEST_SITE_HEADERS }) : `the status is ${res.status}, not 200`;
  });

  // The API, as far as a GET goes.
  const apiHeaders = { ...EVERY_RESPONSE, "Cache-Control": "no-store", "Content-Type": "application/json" };
  await check("GET /api/v1/config", async () => {
    const res = await parts.site("/api/v1/config");
    const body = await res.text();
    if (res.status !== 200) return `the status is ${res.status}, not 200`;
    const config = JSON.parse(body) as { crl_max_age_days?: unknown; platforms?: { platform?: unknown }[] };
    if (config.crl_max_age_days !== CRL_MAX_AGE_DAYS) return `crl_max_age_days is ${JSON.stringify(config.crl_max_age_days)}, not ${CRL_MAX_AGE_DAYS}`;
    const platforms = (config.platforms ?? []).map((p) => p.platform).join(" ");
    if (platforms !== "test-example threads") return `the platforms are ${JSON.stringify(platforms)}, not the test roster's`;
    return headersProblem(res, apiHeaders);
  });
  let fingerprint: string | null = null;
  await check("GET /api/v1/fingerprint", async () => {
    const res = await parts.site("/api/v1/fingerprint");
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

  // The roster is published every day: the last line is today's, or yesterday's until the alarm of midnight has run.
  await check("GET /api/v1/fingerprint: the roster was published today or yesterday, or never yet", async () => {
    if (fingerprint === null) return "the API did not answer";
    const { date } = JSON.parse(fingerprint) as { date?: unknown };
    if (date === null) return null;
    const day = typeof date === "string" ? parseDay(date) : null;
    return day !== null && (day === today || day === today - 1) ? null : `the last line published is dated ${JSON.stringify(date)}; today is ${parts.today}`;
  });

  // The data domain: a page of the site may read it from a browser, a page of another site may not (ADR-0027).
  await check(`the data domain: CORS allows ${siteOrigin} and no other origin`, async () => {
    const allowed = async (origin: string): Promise<string | null> => {
      const res = await parts.data("/crl/index.jsonl", { Origin: origin });
      await res.arrayBuffer();
      return res.headers.get("access-control-allow-origin");
    };
    const [own, other] = [await allowed(siteOrigin), await allowed("https://example.com")];
    if (own !== siteOrigin) return `for ${siteOrigin}, Access-Control-Allow-Origin is ${JSON.stringify(own)}`;
    return other === null ? null : `for https://example.com, Access-Control-Allow-Origin is ${JSON.stringify(other)}`;
  });

  // The data domain: the last line of the fingerprint file is what the API answers. A roster that was
  // not published yet (the day its object first ran, or the day it was cleared) has no file and no date.
  await check("the data domain: the last line of /roster/fingerprints.jsonl is what GET /api/v1/fingerprint answers", async () => {
    if (fingerprint === null) return "the API did not answer";
    const res = await parts.data("/roster/fingerprints.jsonl");
    const text = await res.text();
    if (res.status === 404) return (JSON.parse(fingerprint) as { date?: unknown }).date === null ? null : `there is no file, and the API answers ${fingerprint}`;
    if (res.status !== 200) return `the status is ${res.status}, not 200 or 404`;
    const last = text.split("\n").at(-2) ?? "";
    if (last !== fingerprint.trimEnd()) return `the file ends with ${JSON.stringify(last)}, the API answers ${fingerprint.trimEnd()} (both are kept for a minute: try again after one)`;
    return headersProblem(res, { "Cache-Control": DAILY });
  });
  return lines;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const site = process.argv[2] ?? "https://test.iamreal.tw";
  const data = process.argv[3] ?? "https://test-data.iamreal.tw";
  const { unstable_readConfig } = await import("wrangler");
  const config = join(fileURLToPath(new URL("..", import.meta.url)), "wrangler.jsonc");
  const clearedOn = String(unstable_readConfig({ config, env: "test" }, { hideWarnings: true }).vars.TEST_ROSTER_CLEARED_ON);
  const reader = (origin: string): Reader => (path, headers) => fetch(new URL(path, origin), { redirect: "manual", headers: { ...headers } });
  const today = formatDay(taiwanDay(Date.now()));
  console.log(`${site} and ${data}, ${today} in Taiwan; wrangler.jsonc says the test roster was last cleared on ${clearedOn}`);
  const lines = await checkSite({ site: reader(site), data: reader(data), today, clearedOn, siteOrigin: new URL(site).origin });
  for (const line of lines) console.log(`${line.ok ? "ok    " : "FAIL  "} ${line.what}`);
  const failures = lines.filter((l) => !l.ok).length;
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  process.exit(failures ? 1 : 0);
}
