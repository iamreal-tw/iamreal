// The maintainer's page (scripts/maintainer-page.ts, #436): for a fixed set of
// totals files (test/maintainer-page-fixture.ts), the numbers on the page are
// the files' numbers; the page loads nothing from anywhere; and the totals
// the Worker itself writes (src/count-totals.ts, run in the local workerd)
// are read the same way, so that the page's reading of the format cannot
// drift from the program that writes it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DAY_TOTALS_PREFIX, DEFAULT_DAYS, KEPT_PER_DAY, MONTH_TOTALS_PREFIX, type Snapshot, gather, lastRun, optionsOf, pageOf } from "../scripts/maintainer-page.ts";
import { FINGERPRINTS, FIXTURE_DAYS, RUNS, androidDone, androidStarted, fixtureDays, fixtureSources, webDone, webStarted } from "./maintainer-page-fixture.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { freshProofLog, publishG3 } from "./records.ts";

const WORKER_DIR = join(import.meta.dirname, "..");
const NOW = new Date("2026-11-27T03:00:00Z");

/** The text of a piece of the page: tags out, the few entities the page writes back, spaces as one. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(Number(c)))
    .replace(/\s+/g, " ")
    .trim();

/** The rows of the table whose caption begins with `caption`, each a list of its cells' text, numbers without commas. */
function rowsOf(html: string, caption: string): string[][] {
  const at = html.indexOf(`<caption>${caption}`);
  assert.ok(at >= 0, `no table "${caption}"`);
  const body = html.slice(html.indexOf("<tbody>", at) + 7, html.indexOf("</tbody>", at));
  return [...body.matchAll(/<tr>(.*?)<\/tr>/g)].map((r) => [...r[1]!.matchAll(/<td>(.*?)<\/td>/g)].map((c) => textOf(c[1]!).replace(/(\d),(?=\d{3})/g, "$1")));
}

/** The part of the page under the heading of one client in a section. */
function clientPart(html: string, section: string, client: string): string {
  const s = html.slice(html.indexOf(`<section id="${section}">`));
  const from = s.indexOf(`<h3${section === "card-proofs" ? ` data-client="${client}"` : ""}>${client}</h3>`);
  assert.ok(from >= 0, `no ${client} in ${section}`);
  const rest = s.slice(from + 4);
  const end = Math.min(...[rest.indexOf("<h3"), rest.indexOf("</section>")].filter((i) => i >= 0));
  return rest.slice(0, end);
}

describe("the maintainer's page of a fixed set of files", () => {
  let snapshot: Snapshot;
  let html: string;
  let asked: string[];
  before(async () => {
    const src = fixtureSources();
    snapshot = await gather(src, { days: DEFAULT_DAYS, now: NOW });
    html = pageOf(snapshot);
    asked = src.asked;
  });

  test("it reads the days' and the months' totals and nothing else of the bucket, and the public files", () => {
    assert.deepEqual(
      asked.filter((a) => a.startsWith("list") || a.startsWith("get")),
      [`list ${DAY_TOTALS_PREFIX}`, ...FIXTURE_DAYS.map((d) => `get count-totals/day/${d}.json`), `list ${MONTH_TOTALS_PREFIX}`, "get count-totals/month/2026-10.json", "get count-totals/month/2026-11.json"],
    );
    assert.deepEqual(asked.filter((a) => !a.startsWith("list") && !a.startsWith("get")), ["data /proof-log/fingerprints.jsonl", "data /crl/index.jsonl", "run reverify.yml", "run watch-test.yml"]);
  });

  test("the card proofs of each day: started and done, newest first, as the files have them", () => {
    const web = clientPart(html, "card-proofs", "web");
    assert.deepEqual(
      rowsOf(web, "每天"),
      FIXTURE_DAYS.map((d, i) => [d, String(webStarted(i)), String(webDone(i)), `${((100 * webDone(i)) / webStarted(i)).toFixed(1)}%`]).reverse(),
    );
    const android = clientPart(html, "card-proofs", "android");
    assert.deepEqual(
      rowsOf(android, "每天").map((r) => r.slice(0, 3)),
      FIXTURE_DAYS.map((d, i) => [d, String(androidStarted(i)), String(androidDone(i))]).reverse(),
    );
    // A client with no count in the days has no part.
    assert.ok(!html.includes(`data-client="ios"`));
  });

  test("the funnel: the days' sums of started, then of each step reached, up to done", () => {
    const days = fixtureDays();
    const funnel = rowsOf(clientPart(html, "card-proofs", "web"), "漏斗");
    const started = days.reduce((a, d) => a + d.attempts.web!.started, 0);
    assert.deepEqual(funnel[0]!.slice(0, 2), ["開始", String(started)]);
    const steps = Object.keys(days[0]!.attempts.web!.reached);
    assert.deepEqual(
      funnel.slice(1).map((r) => r.slice(0, 2)),
      steps.map((s) => [s, String(days.reduce((a, d) => a + d.attempts.web!.reached[s]!, 0))]),
    );
    // Done is the last step, once: the day's `done` is the attempts that reached it.
    assert.deepEqual(funnel.at(-1)!.slice(0, 2), ["done", String(days.reduce((a, d) => a + d.attempts.web!.done, 0))]);
  });

  test("the reasons: each code's sum over the days, most first, none that did not happen", () => {
    const days = fixtureDays();
    const web = clientPart(html, "reasons", "web");
    const sums = (pick: (d: (typeof days)[number]) => Record<string, number>) => {
      const out = new Map<string, number>();
      for (const d of days) for (const [k, v] of Object.entries(pick(d))) out.set(k, (out.get(k) ?? 0) + v);
      return [...out].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, v]) => [k, String(v)]);
    };
    assert.deepEqual(rowsOf(web, "停下來"), sums((d) => d.stops.web!));
    assert.deepEqual(rowsOf(web, "重試"), sums((d) => d.retries.web!));
  });

  test("the durations: each timed step's levels, summed over the days", () => {
    const days = fixtureDays();
    const web = clientPart(html, "durations", "web");
    const body = web.slice(web.indexOf("<tbody>"));
    const rows = [...body.matchAll(/<tr>(.*?)<\/tr>/g)].map((r) => [...r[1]!.matchAll(/<td>(.*?)<\/td>/g)].map((c) => textOf(c[1]!).replace(/,/g, "")));
    assert.deepEqual(
      rows,
      ["crl", "tree", "proved"].map((s) => [s, ...Object.keys(days[0]!.durations.web![s]!).map((l) => String(days.reduce((a, d) => a + d.durations.web![s]![l]!, 0)))]),
    );
  });

  test("the months' cells: each value's attempts and done, most attempts first; then the attempts without the value, and other", () => {
    assert.deepEqual(rowsOf(html, "2026-11　web　讀卡機").map((r) => r.slice(0, 3)), [
      ["ACS ACR39U ICC Reader 0", "130", "98"],
      ["Generic Smart Card Reader Interface 0", "70", "50"],
      ["（沒有帶這個值）", "85", "48"],
    ]);
    assert.deepEqual(rowsOf(html, "2026-11　web　瀏覽器和版本").map((r) => r.slice(0, 3)), [
      ["chrome 131", "210", "150"],
      ["edge 131", "60", "41"],
      ["firefox 133", "12", "4"],
      ["other", "3", "1"],
    ]);
    assert.deepEqual(rowsOf(html, "2026-11　android　app 版本")[0]!.slice(0, 3), ["1.0.0", "40", "28"]);
  });

  test("the cards of a month, the cards' pages of the last day, and the devices of a month that is over", () => {
    assert.deepEqual(rowsOf(html, "2026-11（前 20 張"), [
      ["7K2Q9FM4XD", "412", "9", "31"],
      ["3MZ8R2KQ0P", "120", "2", "7"],
      ["9QW4T6YH2B", "15", "0", "1"],
      ["全部 3 張", "547", "11", "39"],
    ]);
    assert.deepEqual(rowsOf(html, "2026-11-26：證明紀錄裡的 518 張島民證明"), [
      ["0", "380"],
      ["1–9", "106"],
      ["10–99", "18"],
      ["100 以上", "2"],
    ]);
    const devices = html.slice(html.indexOf('<section id="devices">'));
    const rows = [...devices.slice(devices.indexOf("<tbody>")).matchAll(/<tr>(.*?)<\/tr>/g)].map((r) => [...r[1]!.matchAll(/<td>(.*?)<\/td>/g)].map((c) => textOf(c[1]!)));
    assert.deepEqual(rows, [
      ["2026-11", "月份還沒結束", "", ""],
      ["2026-10", "4", "1", "1"],
    ]);
  });

  test("the operations: the fingerprint file's last lines, each issuer key's newest usable CRL line, the last runs", () => {
    assert.deepEqual(rowsOf(html, "指紋檔的最後幾行"), [...FINGERPRINTS].reverse().map((f) => [f.date, String(f.count)]));
    assert.deepEqual(rowsOf(html, "清冊存檔"), [
      ["G2", "812", "2026-11-26T16:00:00Z", "2026-11-27"],
      ["G3", "4471", "2026-11-26T15:30:00Z", "2026-11-26"],
    ]);
    assert.deepEqual(rowsOf(html, "最近一次執行").map((r) => r.slice(0, 3)), [
      ["每天的重驗（reverify）", RUNS["reverify.yml"]!.conclusion, RUNS["reverify.yml"]!.created_at],
      ["外部檢查（watch-test）", RUNS["watch-test.yml"]!.conclusion, RUNS["watch-test.yml"]!.created_at],
    ]);
  });

  test("the page loads nothing: no script, no file of any kind, a policy that allows none, links only to its own parts and to the runs", () => {
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">/);
    for (const re of [/<script/i, /<link/i, /<img/i, /<iframe/i, /<object/i, /<embed/i, /<form/i, /\ssrc=/i, /url\(/i, /@import/i, /srcset/i]) assert.doesNotMatch(html, re);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    assert.ok(hrefs.length > 0);
    for (const h of hrefs) assert.ok(h.startsWith("#") || h.startsWith("https://github.com/iamreal-tw/iamreal/actions/runs/"), h);
  });
});

describe("what other people wrote is only text on the page", () => {
  test("a domain, a reader's name, a short ID: escaped, nothing of them is markup", async () => {
    const days = fixtureDays();
    days[6]!.sources.home!.domains[`"><script>alert(1)</script>`] = 999;
    const months = [{ ...(await import("./maintainer-page-fixture.ts")).fixtureMonth() }];
    months[0]!.card_proofs.web!.reader!.values[`<img src=x onerror=alert(1)>`] = { attempts: 500, done: 0, stops: {}, retries: {} };
    const html = pageOf(await gather(fixtureSources({ days, months }), { days: DEFAULT_DAYS, now: NOW }));
    assert.doesNotMatch(html, /<script|<img/);
    assert.ok(html.includes("&#60;script&#62;") && html.includes("&#60;img src=x"));
  });
});

describe("where the page's numbers come from when something cannot be read", () => {
  test("no totals, no public files, no runs: the page says so, and is made", async () => {
    const src = fixtureSources({ days: [], months: [] });
    const html = pageOf(await gather({ ...src, data: async () => new Response("", { status: 503 }), run: async () => { throw new Error("offline"); } }, { days: DEFAULT_DAYS, now: NOW }));
    for (const s of ["還沒有每天的加總", "讀不到指紋檔", "讀不到清冊存檔的索引", "讀不到"]) assert.ok(html.includes(s), s);
  });

  test("the last run of a workflow: GitHub's public API, without a token; anything but a run is none", async () => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const answer = (status: number, body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
      asked.push({ url: String(url), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(body), { status });
    };
    const run = { conclusion: "success", created_at: "2026-11-26T16:31:02Z", html_url: "https://github.com/iamreal-tw/iamreal/actions/runs/1" };
    assert.deepEqual(await lastRun("reverify.yml", answer(200, { workflow_runs: [{ ...run, id: 1 }] }) as typeof fetch), run);
    assert.equal(asked[0]!.url, "https://api.github.com/repos/iamreal-tw/iamreal/actions/workflows/reverify.yml/runs?branch=main&status=completed&per_page=1&exclude_pull_requests=true");
    assert.ok(!Object.keys(asked[0]!.headers).some((h) => h.toLowerCase() === "authorization"));
    // A general User-Agent: no project's name (CONTRIBUTING.md, "工作時對外的請求").
    assert.equal(asked[0]!.headers["User-Agent"], "Mozilla/5.0 (compatible)");
    // A link that is not a run's page of this repository is not put on the page.
    for (const html_url of ["https://example.com/x", "javascript:alert(1)", "https://github.com/iamreal-tw/iamreal/actions/runs/1/../../x"]) assert.equal(await lastRun("reverify.yml", answer(200, { workflow_runs: [{ ...run, html_url }] }) as typeof fetch), null);
    assert.equal(await lastRun("reverify.yml", answer(200, { workflow_runs: [] }) as typeof fetch), null);
    assert.equal(await lastRun("reverify.yml", answer(403, {}) as typeof fetch), null);
  });

  test("the options: --days and --out, and nothing else", () => {
    assert.equal(optionsOf([]).days, DEFAULT_DAYS);
    assert.deepEqual(optionsOf(["--days", "7", "--out", "/tmp/x.html"]), { days: 7, out: "/tmp/x.html" });
    for (const bad of [["--days", "0"], ["--days", "x"], ["--days"], ["--token", "x"]]) assert.throws(() => optionsOf(bad));
  });

  test("a listing that answers a key outside the totals' prefixes: that key is not read", async () => {
    const src = fixtureSources();
    const keys = src.totals.keys;
    src.totals.keys = async (prefix) => [...(await keys(prefix)), "connection/2026-11-20/x.json", `${prefix}../../connection/x.json`];
    await gather(src, { days: DEFAULT_DAYS, now: NOW });
    assert.deepEqual(src.asked.filter((a) => a.startsWith("get") && !/^get count-totals\/(day|month)\/[0-9-]+\.json$/.test(a)), []);
  });

  test("the prefixes and the number of values a day keeps, written again, are src/count-totals.ts's", () => {
    const source = readFileSync(join(WORKER_DIR, "src", "count-totals.ts"), "utf8");
    assert.match(source, new RegExp(`export const KEPT_PER_DAY = ${KEPT_PER_DAY};`));
    assert.match(source, /export const COUNT_TOTALS_PREFIX = "count-totals\/";/);
    assert.match(source, /DAY_TOTALS_PREFIX = `\$\{COUNT_TOTALS_PREFIX\}day\/`;/);
    assert.match(source, /MONTH_TOTALS_PREFIX = `\$\{COUNT_TOTALS_PREFIX\}month\/`;/);
    assert.equal(DAY_TOTALS_PREFIX, "count-totals/day/");
    assert.equal(MONTH_TOTALS_PREFIX, "count-totals/month/");
  });
});

describe("the totals the Worker writes are read as the page reads the fixed ones", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
    await worker.setVerifier("stand-in");
    await freshProofLog(worker);
    await publishG3(worker);
    await worker.emptyConnectionLog();
  });
  after(() => worker.close());

  test("a day with two web attempts, one done and one stopped: the page's numbers are the file's", async () => {
    const D = "2026-11-20";
    const count = (attempt: string, more: Record<string, string>) => ({ client: "web", ...more, device_id: "2".repeat(32), attempt_id: attempt, browser: "chrome", os: "windows", browser_version: "131", os_version: "10.0", reader: "ACS ACR39U ICC Reader 0" });
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    const steps = ["open", "read", "component", "certificates", "certificate", "config", "circuit", "engine", "crl", "tree", "checked", "pin", "scope_signed", "state", "chosen", "confirmed", "challenge", "code_signed", "proved", "done"];
    const counts = [
      ...steps.map((step) => count(a, { event: "step", step })),
      count(a, { event: "duration", step: "proved", took: "10s_30s" }),
      count(b, { event: "step", step: "open" }),
      count(b, { event: "step", step: "read" }),
      count(b, { event: "stop", reason: "component_unreachable" }),
    ];
    await worker.putInConnectionLogBucket(`count-events/${D}/${D}T04:00Z.json`, `${JSON.stringify({ minute: `${D}T04:00Z`, counts, dropped: 0 })}\n`);
    await worker.setClock(new Date("2026-11-21T02:00:00Z"));
    await worker.runSchedule();

    const files = new Map((await worker.connectionLog()).map((o) => [o.key, o.text]));
    const dayText = files.get(`count-totals/day/${D}.json`);
    assert.ok(dayText !== undefined, "the Worker wrote the day's totals");
    const day = JSON.parse(dayText);
    const store = {
      keys: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)).sort(),
      text: async (key: string) => files.get(key) ?? null,
    };
    const html = pageOf(await gather({ totals: store, data: async () => new Response("", { status: 404 }), run: async () => null }, { days: DEFAULT_DAYS, now: NOW }));

    // The file says what was put in, and the page what the file says.
    assert.deepEqual([day.attempts.web.started, day.attempts.web.done], [2, 1]);
    assert.deepEqual(rowsOf(clientPart(html, "card-proofs", "web"), "每天"), [[D, "2", "1", "50.0%"]]);
    assert.deepEqual(rowsOf(clientPart(html, "reasons", "web"), "停下來"), [["component_unreachable", String(day.stops.web.component_unreachable)]]);
    assert.equal(day.durations.web.proved["10s_30s"], 1);
    assert.match(clientPart(html, "durations", "web"), /<td>proved<\/td>(<td>.*?<\/td>){3}<td><span class="n" data-n="1">1<\/span><\/td>/);
    assert.deepEqual(rowsOf(html, "2026-11　web　讀卡機")[0]!.slice(0, 3), ["ACS ACR39U ICC Reader 0", "2", "1"]);
  });
});
