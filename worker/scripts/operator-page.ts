// The operator's page (#436; ADR-0032, ADR-0039): run on the operator's
// computer, never by the back end, which has no page of numbers and no
// operator's login. It reads the counts' totals and the state of the
// operations, and writes one HTML file to open in a browser:
//
//   node --experimental-strip-types scripts/operator-page.ts [--days 30] [--out <file>]
//
// - The totals are in the bucket that is not public, under `count-totals/`
//   (README.md, "計數的加總"). They are read with the token of the
//   connection log's query (scripts/connection-log.ts, README.md,
//   "查連線紀錄"): "Object Read only" on the bucket iamreal-test-logs, and
//   nothing wider. Its keys are in the operator's file, never in the
//   repository. Nothing of `connection/` or `count-events/` is read.
// - The state of the operations is read from what is public: the data
//   domain's fingerprint file and CRL index, and GitHub's record of the last
//   daily re-verification and the last outside check.
// - The page is the file and nothing else: its styles are in it, it has no
//   script, and its Content-Security-Policy (`default-src 'none'`) lets it
//   load nothing. Opening it sends no request; its links go out only when
//   one is clicked.
//
// Which numbers are shown, and how they are laid out, is a first version
// (#436): the operator looks, and it is changed. The page's words are
// written here, as this command's output, and not in design/copy/: it is not
// a page of the site.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IndexLine, compareNumbers, readIndex, usable } from "../src/crl-index.ts";
import { DATA_ORIGINS } from "../src/headers.ts";
import { ISSUER_NAMES, type IssuerName } from "../src/issuers.ts";
import { type Store, keysIn, r2Store } from "./connection-log.ts";

/** The prefixes of src/count-totals.ts, written again: that file needs the Workers runtime's types. test/operator-page.test.ts reads them there. */
export const DAY_TOTALS_PREFIX = "count-totals/day/";
export const MONTH_TOTALS_PREFIX = "count-totals/month/";
/** The test site's data domain. */
export const DATA_ORIGIN = DATA_ORIGINS.test;
/** Where the public repository's runs are (GitHub's REST API), and where a run's own page is. */
export const RUNS_API = "https://api.github.com/repos/iamreal-tw/iamreal/actions/workflows";
/**
 * A general User-Agent, naming no project and no person (CONTRIBUTING.md,
 * "工作時對外的請求"; as src/mirror.ts): GitHub rejects a request without
 * one ("All API requests must include a valid `User-Agent` header",
 * https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api).
 */
const USER_AGENT = "Mozilla/5.0 (compatible)";
/** The workflows whose last run the page shows: the daily re-verification and the outside check of the test site. */
export const WORKFLOWS = { reverify: "reverify.yml", watch: "watch-test.yml" } as const;
/** How many days of totals the page shows unless asked; and of months, how many. */
export const DEFAULT_DAYS = 30;
const MONTHS = 3;
/** How many lines of the fingerprint file, and how many values of a list, are shown. */
const FINGERPRINT_LINES = 14;
const TOP = 20;
/** How many values of a monthly cell a day keeps by themselves (src/count-totals.ts, KEPT_PER_DAY; test/operator-page.test.ts checks it there). */
export const KEPT_PER_DAY = 100;

type Numbers = Record<string, number>;

/** A cell of a month's card proofs (src/count-totals.ts, Cell). */
export interface Cell {
  attempts: number;
  done: number;
  stops: Numbers;
  retries: Numbers;
}

/** A day's totals, as far as the page reads them (src/count-totals.ts, DayTotals). */
export interface DayTotals {
  date: string;
  minutes: number;
  dropped: number;
  clients: Numbers;
  pages: Numbers;
  sources: Record<string, { none: number; domains: Numbers; other: number }>;
  steps: Record<string, Numbers>;
  stops: Record<string, Numbers>;
  retries: Record<string, Numbers>;
  durations: Record<string, Record<string, Numbers>>;
  attempts: Record<string, { started: number; done: number; reached: Numbers }>;
  card_pages: { cards: number; opened: Numbers };
}

/** A month's totals, as far as the page reads them (src/count-totals.ts, MonthTotals). */
export interface MonthTotals {
  month: string;
  days: string[];
  cards: Record<string, { opened: number; download_app: number; start_card_proof: number }>;
  card_proofs: Record<string, Record<string, { values: Record<string, Cell>; none: Cell; other: Cell }>>;
  devices: { days: string[]; cards_2: number; cards_3_or_more: number } | null;
}

/** The last finished run of a workflow, as GitHub records it. */
export interface Run {
  conclusion: string;
  created_at: string;
  html_url: string;
}

/** Everything the page shows, read at one time. */
export interface Snapshot {
  /** When it was read (ISO, UTC). */
  made: string;
  days: DayTotals[];
  months: MonthTotals[];
  /** The last lines of the fingerprint file, newest first; null if it could not be read. */
  fingerprints: { date: string; count: number }[] | null;
  /** Each issuer key's newest usable line of the CRL index; null if the index could not be read. */
  crls: Record<IssuerName, IndexLine | null> | null;
  /** The last finished run of each workflow; null if it could not be read. */
  runs: Record<keyof typeof WORKFLOWS, Run | null>;
}

/** Where the snapshot is read from. */
export interface Sources {
  /** The bucket that is not public, with the operator's token. */
  totals: Store;
  /** A file of the data domain. */
  data: (path: string) => Promise<Response>;
  /** A workflow's last finished run, or null. */
  run: (workflow: string) => Promise<Run | null>;
}

/** Reads the last `days` days of totals and the last months, and the state of the operations. */
export async function gather(src: Sources, o: { days: number; now: Date }): Promise<Snapshot> {
  const read = async <T>(keys: string[]): Promise<T[]> => {
    const out: T[] = [];
    for (const key of keys) {
      const text = await src.totals.text(key);
      if (text !== null) out.push(JSON.parse(text) as T);
    }
    return out;
  };
  // Only what is under the two prefixes, whatever a listing answers.
  const under = async (prefix: string): Promise<string[]> => (await src.totals.keys(prefix)).filter((k) => k.startsWith(prefix) && !k.includes(".."));
  const days = await read<DayTotals>((await under(DAY_TOTALS_PREFIX)).slice(-o.days));
  const months = await read<MonthTotals>((await under(MONTH_TOTALS_PREFIX)).slice(-MONTHS));

  const fingerprints = await (async () => {
    try {
      const res = await src.data("/proof-log/fingerprints.jsonl");
      if (res.status !== 200) return null;
      const lines = (await res.text()).split("\n").filter((l) => l !== "");
      return lines
        .slice(-FINGERPRINT_LINES)
        .map((l) => JSON.parse(l) as { date: string; count: number })
        .map(({ date, count }) => ({ date, count }))
        .reverse();
    } catch {
      return null;
    }
  })();

  const crls = await (async () => {
    try {
      const res = await src.data("/crl/index.jsonl");
      if (res.status !== 200) return null;
      const lines = readIndex(await res.text());
      // As src/crl-index.ts's newestCrls picks them: a usable line, the highest number, then the sha256; with the line's time, which that leaves out.
      const newest = (issuer: IssuerName): IndexLine | null =>
        lines.filter((l) => l.issuer === issuer && usable(l)).sort((a, b) => compareNumbers(b.crlNumber, a.crlNumber) || (a.sha256 < b.sha256 ? 1 : a.sha256 > b.sha256 ? -1 : 0))[0] ?? null;
      return Object.fromEntries(ISSUER_NAMES.map((i) => [i, newest(i)])) as Record<IssuerName, IndexLine | null>;
    } catch {
      return null;
    }
  })();

  const runOf = async (workflow: string): Promise<Run | null> => {
    try {
      return await src.run(workflow);
    } catch {
      return null;
    }
  };
  const runs = { reverify: await runOf(WORKFLOWS.reverify), watch: await runOf(WORKFLOWS.watch) };
  return { made: o.now.toISOString(), days, months, fingerprints, crls, runs };
}

// ---------------------------------------------------------------------------
// The page.

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (x: number): string => x.toLocaleString("en-US");
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
/** A share as a percentage with one decimal, or "-" when there is nothing to share. */
const share = (part: number, whole: number): string => (whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`);

/** A table: its head and its rows, each cell already HTML. A number's cell is marked so that it lines up, and so that a test can read it. */
function table(head: readonly string[], rows: readonly (readonly string[])[], caption?: string): string {
  if (rows.length === 0) return `<p class="none">${caption ? `${escape(caption)}：` : ""}沒有資料</p>`;
  return `<table>${caption ? `<caption>${escape(caption)}</caption>` : ""}<thead><tr>${head.map((h) => `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
/** A number in a cell. */
const num = (x: number): string => `<span class="n" data-n="${x}">${n(x)}</span>`;

/** A line of the days' values, drawn in the page itself (SVG): no file is loaded for it. */
function trend(values: readonly number[]): string {
  if (values.length < 2) return "";
  const w = 240;
  const h = 40;
  const top = Math.max(...values, 1);
  const points = values.map((v, i) => `${((i * w) / (values.length - 1)).toFixed(1)},${(h - (v * h) / top).toFixed(1)}`).join(" ");
  return `<svg class="trend" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

/** Every client that has any count in the days. */
function clientsIn(days: readonly DayTotals[]): string[] {
  const seen = new Set<string>();
  for (const d of days) for (const [c, v] of Object.entries(d.clients)) if (v > 0) seen.add(c);
  return [...seen].sort();
}

/** The sum over the days of each code of `pick(day)`, without the zeros, the most first. */
function totalsOf(days: readonly DayTotals[], pick: (d: DayTotals) => Numbers | undefined): [string, number][] {
  const out = new Map<string, number>();
  for (const d of days) for (const [k, v] of Object.entries(pick(d) ?? {})) out.set(k, (out.get(k) ?? 0) + v);
  return [...out].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

function operations(s: Snapshot): string {
  const fp = s.fingerprints === null ? `<p class="none">讀不到指紋檔</p>` : table(["日期（台灣）", "紀錄筆數"], s.fingerprints.map((f) => [escape(f.date), num(f.count)]), "指紋檔的最後幾行");
  const crl =
    s.crls === null
      ? `<p class="none">讀不到清冊存檔的索引</p>`
      : table(
          ["發證金鑰", "清冊編號", "清冊的時間（thisUpdate）", "清冊日期"],
          ISSUER_NAMES.map((i) => {
            const l = s.crls![i];
            return l === null ? [i, "沒有", "", ""] : [i, escape(l.crlNumber), escape(l.thisUpdate), escape(l.crlDate)];
          }),
          "清冊存檔：每把發證金鑰最新的一行",
        );
  const runRow = (name: string, r: Run | null): string[] => (r === null ? [escape(name), "讀不到", "", ""] : [escape(name), escape(r.conclusion), escape(r.created_at), `<a href="${escape(r.html_url)}">執行紀錄</a>`]);
  const runs = table(["工作", "結果", "開始的時間（UTC）", ""], [runRow("每天的重驗（reverify）", s.runs.reverify), runRow("外部檢查（watch-test）", s.runs.watch)], "最近一次執行（GitHub）");
  return `${fp}${crl}${runs}`;
}

function cardProofs(days: readonly DayTotals[]): string {
  const parts: string[] = [];
  for (const client of clientsIn(days)) {
    const started = days.map((d) => d.attempts[client]?.started ?? 0);
    const done = days.map((d) => d.attempts[client]?.done ?? 0);
    const rows = days.map((d, i) => [escape(d.date), num(started[i]!), num(done[i]!), share(done[i]!, started[i]!)]).reverse();
    const reached = totalsOf(days, (d) => d.attempts[client]?.reached);
    const allStarted = sum(started);
    const funnel = table(
      ["步驟", "走到的嘗試", "佔開始的"],
      [["開始", num(allStarted), share(allStarted, allStarted)], ...orderedSteps(days, client, reached).map(([step, v]) => [escape(step), num(v), share(v, allStarted)])],
      `漏斗（這 ${days.length} 天加起來）`,
    );
    parts.push(
      `<h3 data-client="${escape(client)}">${escape(client)}</h3><div class="row"><div><p>每天開始的嘗試 ${trend(started)}</p><p>每天完成的 ${trend(done)}</p>${funnel}</div><div>${table(["日期（UTC）", "開始", "完成", "完成的比例"], rows, "每天")}</div></div>`,
    );
  }
  return `${parts.join("")}`;
}

/** The steps a client's attempts reached, in the order of the day's file (the table's order), with their sums. */
function orderedSteps(days: readonly DayTotals[], client: string, reached: [string, number][]): [string, number][] {
  const order = Object.keys(days.at(-1)?.attempts[client]?.reached ?? {});
  const sums = new Map(reached);
  return order.map((s) => [s, sums.get(s) ?? 0] as [string, number]);
}

function reasons(days: readonly DayTotals[]): string {
  const parts = clientsIn(days).map((client) => {
    const stops = totalsOf(days, (d) => d.stops[client]);
    const retries = totalsOf(days, (d) => d.retries[client]);
    return `<h3>${escape(client)}</h3><div class="row"><div>${table(["原因", "次數"], stops.map(([r, v]) => [escape(r), num(v)]), "停下來")}</div><div>${table(["原因", "次數"], retries.map(([r, v]) => [escape(r), num(v)]), "重試")}</div></div>`;
  });
  return `${parts.join("")}`;
}

function durations(days: readonly DayTotals[]): string {
  const parts = clientsIn(days).map((client) => {
    const steps = Object.keys(days.at(-1)?.durations[client] ?? {});
    const levels = Object.keys(days.at(-1)?.durations[client]?.[steps[0] ?? ""] ?? {});
    if (steps.length === 0) return "";
    const rows = steps.map((step) => {
      const counts = levels.map((l) => sum(days.map((d) => d.durations[client]?.[step]?.[l] ?? 0)));
      return [escape(step), ...counts.map(num)];
    });
    return `<h3>${escape(client)}</h3>${table(["步驟", ...levels], rows)}`;
  });
  return `${parts.join("")}`;
}

function clients(days: readonly DayTotals[]): string {
  const names = [...new Set(days.flatMap((d) => Object.keys(d.clients)))].sort();
  const rows = days.map((d) => [escape(d.date), ...names.map((c) => num(d.clients[c] ?? 0)), num(d.minutes), num(d.dropped)]).reverse();
  return `${table(["日期（UTC）", ...names, "每分鐘的檔", "沒留下"], rows)}`;
}

/** What a month's card proofs were counted by, in words. */
const DIMENSION_NAMES: Readonly<Record<string, string>> = { browser: "瀏覽器和版本", os: "作業系統和版本", reader: "讀卡機", os_version: "系統版本", app_version: "app 版本" };

function cells(months: readonly MonthTotals[]): string {
  const parts: string[] = [];
  for (const m of [...months].reverse()) {
    for (const [client, dims] of Object.entries(m.card_proofs)) {
      for (const [dim, c] of Object.entries(dims)) {
        const values = Object.entries(c.values).sort((a, b) => b[1].attempts - a[1].attempts || (a[0] < b[0] ? -1 : 1));
        const all = [...values.slice(0, TOP), ...(values.length > TOP ? [["（其餘的值）", addCells(values.slice(TOP).map(([, v]) => v))] as [string, Cell]] : []), ["（沒有帶這個值）", c.none] as [string, Cell], ["other", c.other] as [string, Cell]];
        const rows = all
          .filter(([, v]) => v.attempts > 0)
          .map(([value, v]) => {
            const top = Object.entries(v.stops).sort((a, b) => b[1] - a[1])[0];
            return [escape(value), num(v.attempts), num(v.done), share(v.done, v.attempts), top ? `${escape(top[0])}（${n(top[1])}）` : ""];
          });
        if (rows.length > 0) parts.push(table(["值", "嘗試", "完成", "完成的比例", "最多的停下原因"], rows, `${m.month}　${client}　${DIMENSION_NAMES[dim] ?? dim}`));
      }
    }
  }
  return `${parts.join("")}`;
}

function addCells(cs: readonly Cell[]): Cell {
  const out: Cell = { attempts: 0, done: 0, stops: {}, retries: {} };
  for (const c of cs) {
    out.attempts += c.attempts;
    out.done += c.done;
    for (const [r, v] of Object.entries(c.stops)) out.stops[r] = (out.stops[r] ?? 0) + v;
    for (const [r, v] of Object.entries(c.retries)) out.retries[r] = (out.retries[r] ?? 0) + v;
  }
  return out;
}

function pages(days: readonly DayTotals[]): string {
  const names = [...new Set(days.flatMap((d) => Object.keys(d.pages)))];
  const rows = days.map((d) => [escape(d.date), ...names.map((p) => num(d.pages[p] ?? 0))]).reverse();
  const domains = totalsOf(days, (d) => {
    const out: Numbers = {};
    for (const s of Object.values(d.sources)) {
      out["（沒有來源）"] = (out["（沒有來源）"] ?? 0) + s.none;
      out["other"] = (out["other"] ?? 0) + s.other;
      for (const [dom, v] of Object.entries(s.domains)) out[dom] = (out[dom] ?? 0) + v;
    }
    return out;
  }).slice(0, TOP);
  const views = days.map((d) => sum(Object.values(d.pages)));
  return `<p>每天打開的頁面 ${trend(views)}</p><div class="row"><div>${table(["日期（UTC）", ...names], rows, "每天，照頁面的種類")}</div><div>${table(["來源", "次數"], domains.map(([d, v]) => [escape(d), num(v)]), `來源（這 ${days.length} 天加起來，前 ${TOP} 個）`)}</div></div>`;
}

function cards(days: readonly DayTotals[], months: readonly MonthTotals[]): string {
  const last = days.at(-1);
  const opened = last === undefined ? "" : table(["被打開的次數", "張數"], Object.entries(last.card_pages.opened).map(([k, v]) => [escape(k.replace("_or_more", " 以上").replace("_", "–")), num(v)]), `${last.date}：證明紀錄裡的 ${n(last.card_pages.cards)} 張島民證明`);
  const monthly = [...months].reverse().map((m) => {
    const rows = Object.entries(m.cards)
      .sort((a, b) => b[1].opened - a[1].opened || (a[0] < b[0] ? -1 : 1))
      .slice(0, TOP)
      .map(([id, c]) => [`<code>${escape(id)}</code>`, num(c.opened), num(c.download_app), num(c.start_card_proof)]);
    const all = Object.values(m.cards);
    if (all.length > 0) rows.push([`全部 ${n(all.length)} 張`, num(sum(all.map((c) => c.opened))), num(sum(all.map((c) => c.download_app))), num(sum(all.map((c) => c.start_card_proof)))]);
    return table(["短編號", "被打開", "下載 app", "從它開始過卡"], rows, `${m.month}（前 ${TOP} 張，照被打開的次數；最後一列是全部）`);
  });
  return `${opened}${monthly.join("")}`;
}

function devices(months: readonly MonthTotals[]): string {
  const rows = [...months].reverse().map((m) => (m.devices === null ? [escape(m.month), "月份還沒結束", "", ""] : [escape(m.month), num(m.devices.cards_2), num(m.devices.cards_3_or_more), num(m.devices.days.length)]));
  return `${table(["月份", "2 張", "3 張以上", "用了幾天的檔"], rows)}`;
}

const STYLE = `
:root { color-scheme: light; font-family: system-ui, -apple-system, "PingFang TC", "Microsoft JhengHei", sans-serif; color: #1f1f1f; background: #fafaf7; }
body { margin: 0 auto; max-width: 1180px; padding: 24px 32px 64px; line-height: 1.5; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 40px 0 8px; padding-top: 16px; border-top: 1px solid #d9d6cc; }
h3 { font-size: 15px; margin: 20px 0 6px; }
nav a { margin-right: 14px; color: inherit; }
.note, .made { color: #5c5a54; font-size: 13px; margin: 0 0 8px; }
.none { color: #5c5a54; font-size: 13px; }
.row { display: flex; gap: 32px; flex-wrap: wrap; align-items: flex-start; }
.row > div { flex: 1 1 360px; min-width: 0; }
table { border-collapse: collapse; font-size: 13px; margin: 6px 0 14px; }
caption { text-align: left; font-weight: 600; padding-bottom: 4px; white-space: nowrap; }
th, td { padding: 3px 10px 3px 0; text-align: left; border-bottom: 1px solid #ebe8df; vertical-align: top; white-space: nowrap; }
td:has(> .n) { text-align: right; font-variant-numeric: tabular-nums; }
svg.trend { vertical-align: middle; color: #2b4a6f; }
code { font-size: 12px; }
`;

/** The page of a snapshot: one HTML file, with nothing outside it. */
export function pageOf(s: Snapshot): string {
  const first = s.days[0]?.date;
  const last = s.days.at(-1)?.date;
  const range = first === undefined ? "還沒有每天的加總" : `${first} 到 ${last}，${s.days.length} 天（UTC）`;
  const days = s.days.length;
  // Each section: its id, its name in the list at the top, its heading, a line under it, and what it holds.
  const sections: readonly [string, string, string, string | null, string][] = [
    ["operations", "營運的狀況", "營運的狀況", "都來自公開的檔和公開的執行紀錄。", operations(s)],
    ["card-proofs", "過卡", "過卡", "照嘗試編號接起來之後的嘗試：算在它第一筆計數的那一天。", cardProofs(s.days)],
    ["reasons", "原因", "停下來和重試的原因", `這 ${days} 天加起來，次數多的在前；沒有發生的不列。`, reasons(s.days)],
    ["durations", "花了多久", "花了多久", `這 ${days} 天加起來，每一級幾次（spec/counts.md「Durations」）。`, durations(s.days)],
    ["clients", "客戶端", "各客戶端的計數", "每天收下的計數筆數；「每分鐘的檔」是那一天有幾個檔，「沒留下」是超過每分鐘的上限沒有留下的筆數。", clients(s.days)],
    ["cells", "型號、版本、讀卡機", "型號、版本、讀卡機", `每月的檔；每一天每一種分法只留嘗試最多的 ${KEPT_PER_DAY} 個值，其餘的在 other。`, cells(s.months)],
    ["pages", "頁面和來源", "頁面瀏覽和來源", null, pages(s.days)],
    ["cards", "每張島民證明", "每張島民證明", null, cards(s.days, s.months)],
    ["devices", "好幾張卡片的裝置", "送出好幾張卡片的裝置", "從連線紀錄裡成功的送出算，月份結束才有。", devices(s.months)],
  ];
  const nav = sections.map(([id, name]) => `<a href="#${id}">${name}</a>`).join("");
  const body = sections.map(([id, , title, note, html]) => `<section id="${id}"><h2>${title}</h2>${note === null ? "" : `<p class="note">${escape(note)}</p>`}${html || `<p class="none">沒有資料</p>`}</section>`).join("\n");
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iamreal 營運者的數字</title>
<style>${STYLE}</style>
</head>
<body>
<h1>iamreal 營運者的數字</h1>
<p class="made">測試網站。產生的時間 ${escape(s.made)}；加總：${escape(range)}。這一頁只在這台電腦上，打開時不送出任何東西，只有按了執行紀錄的連結才會連到 GitHub。</p>
<nav>${nav}</nav>
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// The command.

/** The last finished run of a workflow on the default branch, from GitHub's public API: no token. */
export async function lastRun(workflow: string, fetchFn: typeof fetch = fetch): Promise<Run | null> {
  const res = await fetchFn(`${RUNS_API}/${workflow}/runs?branch=main&status=completed&per_page=1&exclude_pull_requests=true`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
  });
  if (res.status !== 200) return null;
  const run = ((await res.json()) as { workflow_runs?: { conclusion?: unknown; created_at?: unknown; html_url?: unknown }[] }).workflow_runs?.[0];
  // The link goes on the page: only a run's page of this repository.
  if (run === undefined || typeof run.conclusion !== "string" || typeof run.created_at !== "string" || typeof run.html_url !== "string" || !/^https:\/\/github\.com\/iamreal-tw\/iamreal\/actions\/runs\/\d+$/.test(run.html_url)) return null;
  return { conclusion: run.conclusion, created_at: run.created_at, html_url: run.html_url };
}

/** `--days N` and `--out <file>`. Throws on anything else. */
export function optionsOf(args: readonly string[]): { days: number; out: string } {
  let days = DEFAULT_DAYS;
  let out = join(tmpdir(), "iamreal-operator-page.html");
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i], args[i + 1]];
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === "--days" && /^[1-9]\d{0,2}$/.test(value)) days = Number(value);
    else if (name === "--out") out = value;
    else throw new Error(`not an option: ${name} ${value} (--days 1 to 999, --out <file>)`);
  }
  return { days, out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { days, out } = optionsOf(process.argv.slice(2));
    const snapshot = await gather({ totals: r2Store(keysIn()), data: (path) => fetch(new URL(path, DATA_ORIGIN)), run: (w) => lastRun(w) }, { days, now: new Date() });
    writeFileSync(out, pageOf(snapshot), { mode: 0o600 });
    console.log(`${out}: ${snapshot.days.length} days, ${snapshot.months.length} months. Open it in a browser.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "failed");
    process.exitCode = 1;
  }
}
