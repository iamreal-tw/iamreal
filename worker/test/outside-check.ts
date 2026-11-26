// The check from outside Cloudflare (#53, #413 "通知"): a scheduled workflow
// (.github/workflows/watch-test.yml) runs it every hour against the test
// site and its data domain, and fails when any line fails; the email GitHub
// sends for a failed run is the operator's notification (.github/README.md).
// It only sends GET requests, and prints a line for each thing checked:
//
//   node --experimental-strip-types test/outside-check.ts
//   node --experimental-strip-types test/outside-check.ts https://test.iamreal.tw https://test-data.iamreal.tw
//
// - the back end answers: `GET /api/v1/config` is a 200 with a platform
//   table, and the home page is a 200;
// - today's proof log was published: the fingerprint file of the data
//   domain has a line dated today;
// - the CRL mirror runs: for each issuer key, the newest usable CRL of the
//   archive index is dated today or yesterday (MOICA issues one about every
//   six hours; a device stops at 3 days, `crl_max_age_days`, so this fails
//   a day or more before card proofs would);
// - today's card state file is there (proof-log/card-state/<today>.jsonl).
//
// To come: that no connection log is kept past its time (#20). The back end
// will look at the oldest date under connection/ itself and show it; this
// check will read what it shows, as one more GET, once #20 says how. It
// reads no bucket and holds no token for R2.
//
// The proof log is published at midnight in Taiwan, and retried every
// minute in the first hour (README.md, "每天公布"): until 01:00 in Taiwan
// yesterday's line and file pass. After a clearing of the test log the
// fingerprint file and the card state files start again: no line and no file
// pass up to two days after the date wrangler.jsonc gives
// (`TEST_PROOF_LOG_CLEARED_ON`), as in test/site-check.ts.
//
// A line says what was checked and, when it fails, what was found: a status,
// a date. Nothing from a log, and no address but the site's. The checks of a
// deploy are test/site-check.ts's; this one is what can go wrong between
// deploys, and is short so that it can run every hour.
//
// The same checks run on the local Worker in test/outside-check.test.ts.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Day, formatDay, parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import { ISSUER_NAMES } from "../src/issuers.ts";
import { newestCrls, readIndex } from "../src/crl-index.ts";
import type { CheckLine, Reader } from "./site-check.ts";

// The paths of src/proof-log-files.ts (FINGERPRINT_FILE, cardStateFileKey), written again: that file needs the Workers
// runtime's types. test/outside-check.test.ts reads them from what the local Worker writes.
const FINGERPRINT_FILE = "proof-log/fingerprints.jsonl";
const cardStateFileKey = (day: Day): string => `proof-log/card-state/${formatDay(day)}.jsonl`;

/** How old the newest usable CRL of an issuer key may be, in days. */
export const CRL_NOTICE_DAYS = 1;
/** Until this hour in Taiwan, yesterday's line of the fingerprint file and yesterday's card state file pass. */
export const PUBLISHED_BY_HOUR = 1;
/** For how many days after the date a test log was cleared on it may be without a published line (test/site-check.ts). */
const NEVER_PUBLISHED_DAYS = 2;
const HOUR_MS = 3_600_000;

/** The hour in Taiwan (UTC+8, no summer time) at `now`. */
const taiwanHour = (now: number): number => new Date(now + 8 * HOUR_MS).getUTCHours();

/**
 * Checks the site and its data domain at `now` (milliseconds); a line for
 * each thing checked. `clearedOn` is the date the test log was last cleared
 * on (YYYY-MM-DD).
 */
export async function checkFromOutside(parts: { site: Reader; data: Reader; now: number; clearedOn: string }): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];
  const check = async (what: string, problem: () => Promise<string | null>): Promise<void> => {
    let found: string | null;
    try {
      found = await problem();
    } catch (e) {
      found = `the request failed (${e instanceof Error ? e.message : "unknown"})`;
    }
    lines.push({ ok: found === null, what: found === null ? what : `${what}: ${found}` });
  };
  const today = taiwanDay(parts.now);
  // Yesterday's publication passes until PUBLISHED_BY_HOUR.
  const due = taiwanHour(parts.now) < PUBLISHED_BY_HOUR ? today - 1 : today;
  const cleared = parseDay(parts.clearedOn);
  const justCleared = cleared !== null && today <= cleared + NEVER_PUBLISHED_DAYS;

  await check("GET /api/v1/config answers with the platform table", async () => {
    const res = await parts.site("/api/v1/config", { Accept: "*/*" });
    const body = await res.text();
    if (res.status !== 200) return `the status is ${res.status}`;
    const platforms = (JSON.parse(body) as { platforms?: unknown }).platforms;
    return Array.isArray(platforms) && platforms.length > 0 ? null : "it has no platform table";
  });
  await check("GET / (the home page) answers", async () => {
    const res = await parts.site("/", { Accept: "text/html" });
    await res.arrayBuffer();
    return res.status === 200 ? null : `the status is ${res.status}`;
  });

  await check(`the data domain: ${FINGERPRINT_FILE} has a line dated ${formatDay(due)} or later (the proof log was published)`, async () => {
    const res = await parts.data(`/${FINGERPRINT_FILE}`);
    const text = await res.text();
    if (res.status === 404) return justCleared ? null : `there is no file, and the test log was last cleared on ${parts.clearedOn}`;
    if (res.status !== 200) return `the status is ${res.status}`;
    const last = text.split("\n").at(-2) ?? "";
    const date = parseDay(((): string => {
      try {
        return String((JSON.parse(last) as { date?: unknown }).date);
      } catch {
        return "";
      }
    })());
    if (date === null) return "its last line has no date";
    return date >= due ? null : `the last line is dated ${formatDay(date)}`;
  });

  let index: ReturnType<typeof newestCrls> | null = null;
  let indexProblem = "there is no index to look in";
  for (const issuer of ISSUER_NAMES) {
    await check(`the data domain: the newest usable CRL of ${issuer} in crl/index.jsonl is at most ${CRL_NOTICE_DAYS} day old`, async () => {
      if (index === null) {
        const res = await parts.data("/crl/index.jsonl");
        const text = await res.text();
        if (res.status !== 200) {
          indexProblem = `the index's status is ${res.status}`;
          return indexProblem;
        }
        index = newestCrls(readIndex(text));
      }
      const newest = index[issuer][0];
      if (newest === undefined) return `the index has no usable CRL of ${issuer}`;
      const day: Day | null = parseDay(newest.crlDate);
      return day !== null && day >= today - CRL_NOTICE_DAYS ? null : `it is dated ${newest.crlDate} (number ${newest.crlNumber})`;
    });
  }

  await check(`the data domain: the card state file of ${formatDay(due)} or later is there`, async () => {
    // Today's first; before PUBLISHED_BY_HOUR, yesterday's too.
    for (const day of due === today ? [today] : [today, due]) {
      const res = await parts.data(`/${cardStateFileKey(day)}`);
      await res.arrayBuffer();
      if (res.status === 200) return null;
      if (res.status !== 404) return `${cardStateFileKey(day)}: the status is ${res.status}`;
    }
    return justCleared ? null : `there is no ${cardStateFileKey(today)}`;
  });

  // To come (#20): the oldest date of the connection logs, as the back end shows it, at most their time old.
  return lines;
}

/**
 * Checks a running site and its data domain as the command line does,
 * prints a line for each thing checked and a last line, and returns how
 * many failed. The date of the clearing is wrangler.jsonc's.
 */
export async function runOutsideCheck(site: string, data: string): Promise<number> {
  const { unstable_readConfig } = await import("wrangler");
  const config = join(fileURLToPath(new URL("..", import.meta.url)), "wrangler.jsonc");
  const clearedOn = String(unstable_readConfig({ config, env: "test" }, { hideWarnings: true }).vars.TEST_PROOF_LOG_CLEARED_ON);
  const reader = (origin: string): Reader => (path, headers) => fetch(new URL(path, origin), { redirect: "manual", headers: { ...headers } });
  const now = Date.now();
  console.log(`${site} and ${data}, ${formatDay(taiwanDay(now))} ${String(taiwanHour(now)).padStart(2, "0")}h in Taiwan; the test log was last cleared on ${clearedOn}`);
  const lines = await checkFromOutside({ site: reader(site), data: reader(data), now, clearedOn });
  for (const line of lines) console.log(`${line.ok ? "ok    " : "FAIL  "} ${line.what}`);
  const failures = lines.filter((l) => !l.ok).length;
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = await runOutsideCheck(process.argv[2] ?? "https://test.iamreal.tw", process.argv[3] ?? "https://test-data.iamreal.tw");
  process.exit(failures ? 1 : 0);
}
