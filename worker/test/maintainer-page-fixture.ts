// A fixed set of the files the maintainer's page reads (scripts/maintainer-page.ts,
// #436): a week of days' totals and their month in the form
// src/count-totals.ts writes, the data domain's fingerprint file and CRL
// index, and the last runs of two workflows. Made up, and the same each
// time: test/maintainer-page.test.ts checks the page's numbers against them,
// and test/maintainer-page-browser.ts draws the page from them.
import type { Cell, DayTotals, MonthTotals, Run, Sources } from "../scripts/maintainer-page.ts";

export const FIXTURE_DAYS = ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"];
const STEPS = ["open", "read", "component", "certificates", "certificate", "config", "circuit", "engine", "crl", "tree", "checked", "pin", "scope_signed", "state", "chosen", "confirmed", "challenge", "code_signed", "proved", "done"];
const DURATIONS = ["lt_1s", "1s_3s", "3s_10s", "10s_30s", "30s_60s", "1m_3m", "gt_3m"];

/** The web page's attempts of day `i`: started, done, and the stops between. */
export const webStarted = (i: number): number => 40 + 7 * i;
export const webDone = (i: number): number => 22 + 5 * i;
export const androidStarted = (i: number): number => (i < 3 ? 0 : 3 * i);
export const androidDone = (i: number): number => (i < 3 ? 0 : 2 * i);

function day(i: number): DayTotals {
  const date = FIXTURE_DAYS[i]!;
  const reachedOf = (started: number, done: number): Record<string, number> => Object.fromEntries(STEPS.map((s, k) => [s, Math.round(started - ((started - done) * k) / (STEPS.length - 1))]));
  const web = { started: webStarted(i), done: webDone(i), reached: reachedOf(webStarted(i), webDone(i)) };
  // The apps have no step of the component's (spec/counts.md, "Steps").
  const appSteps = (r: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(r).filter(([s]) => s !== "component"));
  const android = { started: androidStarted(i), done: androidDone(i), reached: appSteps(reachedOf(androidStarted(i), androidDone(i))) };
  const zeros = (codes: string[]): Record<string, number> => Object.fromEntries(codes.map((c) => [c, 0]));
  return {
    date,
    minutes: 1_200 + i,
    dropped: i === 4 ? 3 : 0,
    clients: { web: 600 + 30 * i, android: 20 * i, ios: 0 },
    pages: { home: 300 + 10 * i, card: 120 + 9 * i, account: 15, proof_log: 4, faq: 30, verify: 2, check: 11, prepare: 25, privacy: 3, hang: 6 },
    sources: {
      home: { none: 200, domains: { "www.threads.com": 80 + i, "l.threads.com": 12, "www.google.com": 5 }, other: 3 },
      card: { none: 40, domains: { "www.threads.com": 70 + 2 * i, "l.facebook.com": 4 }, other: 1 },
    },
    steps: { web: reachedOf(webStarted(i), webDone(i)), android: appSteps(reachedOf(androidStarted(i), androidDone(i))) },
    stops: { web: { component_unreachable: 6 + i, pin_incorrect: 2, no_card: 4, server_busy: i === 5 ? 9 : 0 }, android: { nfc_off: i, tap_cancelled: 1 } },
    retries: { web: { popup_blocked: 3 + i, pin_incorrect: 5 }, android: { no_tap: 2 * i } },
    durations: {
      web: Object.fromEntries(["crl", "tree", "proved"].map((s, k) => [s, Object.fromEntries(DURATIONS.map((d, j) => [d, j === k + 1 ? 15 + i : j === k + 2 ? 5 : 0]))])),
      android: Object.fromEntries(["crl", "tree", "proved"].map((s) => [s, Object.fromEntries(DURATIONS.map((d, j) => [d, j === 3 ? androidDone(i) : 0]))])),
    },
    attempts: { web, android, ios: { started: 0, done: 0, reached: appSteps(zeros(STEPS)) } },
    card_pages: { cards: 500 + 3 * i, opened: { "0": 380, "1_9": 100 + i, "10_99": 18, "100_or_more": 2 } },
  };
}

export const fixtureDays = (): DayTotals[] => FIXTURE_DAYS.map((_, i) => day(i));

const cell = (attempts: number, done: number, stops: Record<string, number> = {}): Cell => ({ attempts, done, stops, retries: {} });

export function fixtureMonth(): MonthTotals {
  return {
    month: "2026-11",
    days: FIXTURE_DAYS,
    cards: {
      "7K2Q9FM4XD": { opened: 412, download_app: 9, start_card_proof: 31 },
      "3MZ8R2KQ0P": { opened: 120, download_app: 2, start_card_proof: 7 },
      "9QW4T6YH2B": { opened: 15, download_app: 0, start_card_proof: 1 },
    },
    card_proofs: {
      web: {
        browser: { values: { "chrome 131": cell(210, 150, { component_unreachable: 30 }), "edge 131": cell(60, 41, { no_card: 9 }), "firefox 133": cell(12, 4, { component_unreachable: 6 }) }, none: cell(0, 0), other: cell(3, 1) },
        os: { values: { "windows 10.0": cell(240, 170, { component_unreachable: 33 }), macos: cell(45, 26, { pin_incorrect: 4 }) }, none: cell(0, 0), other: cell(0, 0) },
        reader: { values: { "ACS ACR39U ICC Reader 0": cell(130, 98, { pin_incorrect: 5 }), "Generic Smart Card Reader Interface 0": cell(70, 50, { no_card: 6 }) }, none: cell(85, 48, { component_unreachable: 36 }), other: cell(0, 0) },
      },
      android: { os_version: { values: { "15": cell(40, 28, { nfc_off: 6 }) }, none: cell(0, 0), other: cell(0, 0) }, app_version: { values: { "1.0.0": cell(40, 28, { nfc_off: 6 }) }, none: cell(0, 0), other: cell(0, 0) } },
      ios: { os_version: { values: {}, none: cell(0, 0), other: cell(0, 0) }, app_version: { values: {}, none: cell(0, 0), other: cell(0, 0) } },
    },
    devices: null,
  };
}

/** The month before, over: its devices are counted. */
export function fixtureLastMonth(): MonthTotals {
  return { ...fixtureMonth(), month: "2026-10", days: ["2026-10-31"], cards: {}, devices: { days: ["2026-10-31"], cards_2: 4, cards_3_or_more: 1 } };
}

export const FINGERPRINTS = [
  { date: "2026-11-24", count: 1520 },
  { date: "2026-11-25", count: 1588 },
  { date: "2026-11-26", count: 1641 },
];
const fingerprintFile = (): string => FINGERPRINTS.map((f) => `{"date":"${f.date}","count":${f.count},"fingerprint":"${"ab".repeat(32)}"}\n`).join("");

/** The CRL index: G2's newest usable line is number 812; 813 is a CRL that was not usable (its root says why). */
export const CRL_INDEX = [
  `{"issuer":"G2","crl_number":"811","this_update":"2026-11-25T16:00:00Z","next_update":"2026-11-26T16:00:00Z","crl_date":"2026-11-26","sha256":"${"01".repeat(32)}","root":"${"11".repeat(32)}"}`,
  `{"issuer":"G2","crl_number":"812","this_update":"2026-11-26T16:00:00Z","next_update":"2026-11-27T16:00:00Z","crl_date":"2026-11-27","sha256":"${"02".repeat(32)}","root":"${"12".repeat(32)}"}`,
  `{"issuer":"G2","crl_number":"813","this_update":"2026-11-27T16:00:00Z","next_update":"2026-11-28T16:00:00Z","crl_date":"2026-11-28","sha256":"${"04".repeat(32)}","root":"-signature"}`,
  `{"issuer":"G3","crl_number":"4471","this_update":"2026-11-26T15:30:00Z","next_update":"2026-11-27T15:30:00Z","crl_date":"2026-11-26","sha256":"${"03".repeat(32)}","root":"${"13".repeat(32)}"}`,
]
  .map((l) => `${l}\n`)
  .join("");

export const RUNS: Record<string, Run> = {
  "reverify.yml": { conclusion: "success", created_at: "2026-11-26T16:31:02Z", html_url: "https://github.com/iamreal-tw/iamreal/actions/runs/1001" },
  "watch-test.yml": { conclusion: "failure", created_at: "2026-11-27T01:17:44Z", html_url: "https://github.com/iamreal-tw/iamreal/actions/runs/1002" },
};

/** The fixture's files as the page's sources: the bucket's keys in order, as R2 lists them. */
export function fixtureSources(o: { days?: DayTotals[]; months?: MonthTotals[] } = {}): Sources & { asked: string[] } {
  const files = new Map<string, string>();
  for (const d of o.days ?? fixtureDays()) files.set(`count-totals/day/${d.date}.json`, `${JSON.stringify(d)}\n`);
  for (const m of o.months ?? [fixtureLastMonth(), fixtureMonth()]) files.set(`count-totals/month/${m.month}.json`, `${JSON.stringify(m)}\n`);
  const asked: string[] = [];
  return {
    asked,
    totals: {
      keys: async (prefix) => {
        asked.push(`list ${prefix}`);
        return [...files.keys()].filter((k) => k.startsWith(prefix)).sort();
      },
      text: async (key) => {
        asked.push(`get ${key}`);
        return files.get(key) ?? null;
      },
    },
    data: async (path) => {
      asked.push(`data ${path}`);
      if (path === "/proof-log/fingerprints.jsonl") return new Response(fingerprintFile());
      if (path === "/crl/index.jsonl") return new Response(CRL_INDEX);
      return new Response("", { status: 404 });
    },
    run: async (workflow) => {
      asked.push(`run ${workflow}`);
      return RUNS[workflow] ?? null;
    },
  };
}
