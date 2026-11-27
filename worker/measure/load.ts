// The load of the measurement (README.md in this directory), run by the
// operator against the temporary Worker. Not a test: `pnpm test` runs
// test/*.test.ts only, and this sends many requests.
//
//   MEASURE_KEY=<key> node --experimental-strip-types measure/load.ts <url> <step> [--records N] [--quick] [--any-colo]
//
// <url> is the temporary Worker's (https://iamreal-measure.<subdomain>.workers.dev).
// The steps, in the order `all` runs them:
//
//   colo      which Cloudflare data centre the requests enter (`cf-ray`); stops
//             unless it is one near Taiwan, since the round trip is in every number
//   generate  the made-up proof log, N records (100,000; a multiple of 1,000),
//             written into the data bucket by the Worker. Before anything starts
//             the proof log's object: it rebuilds from these files when it starts
//   rebuild   starts the object and times its rebuild from the bucket, to `swapped`
//   size      the object's database size and the rows of each table
//   pages     card pages of random cards, more at once at each level
//   writes    the object's side of a write (measure-build/index.ts), more at once
//             at each level, with 5 page readers beside it
//   counts    POST /api/v1/counts, more at once each minute; then what each
//             minute's file kept
//   publish   #196: the copy of the card state table alone, three times, by the
//             round trip against one of a request that only reads a row; then
//             today's publication made due now, how long until its line, and
//             the longest a request to the object waited meanwhile
//
// --quick: few records, short levels (the run on this computer, measure/smoke.ts).
// What it prints has times (UTC) to find the same minutes on the dashboard, and
// no address. The key is read from the environment and sent only to <url>.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatDay, taiwanDay } from "iamreal-protocol/date.ts";

const args = process.argv.slice(2);
const [base, step] = args;
const flag = (name: string): boolean => args.includes(name);
const option = (name: string, fallback: number): number => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
if (base === undefined || step === undefined) throw new Error("usage: measure/load.ts <url> <step> [--records N] [--quick] [--any-colo]");
const KEY = process.env["MEASURE_KEY"];
if (KEY === undefined || KEY.length < 32) throw new Error("MEASURE_KEY is not in the environment (the key set on the Worker, 32 characters or more)");
const QUICK = flag("--quick");
const RECORDS = option("--records", QUICK ? 2000 : 100_000);
if (!Number.isSafeInteger(RECORDS) || RECORDS < 1000 || RECORDS % 1000 !== 0) throw new Error("--records is a multiple of 1,000");

const stamp = (): string => new Date().toISOString().slice(0, 19) + "Z";
const say = (line: string): void => console.log(`${stamp()} ${line}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const url = (path: string): string => new URL(path, base).toString();

/** Today in Taiwan, YYYY-MM-DD, shifted by `days`. */
const taiwanDate = (days = 0): string => formatDay(taiwanDay(Date.now()) + days);

async function door<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(url(path), { method, headers: { Authorization: `Bearer ${KEY}`, ...(body !== undefined && { "Content-Type": "application/json" }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

interface Tally {
  readonly ms: number[];
  readonly statuses: Map<string, number>;
}
const newTally = (): Tally => ({ ms: [], statuses: new Map() });
async function timed(tally: Tally, send: () => Promise<Response>): Promise<void> {
  const t = performance.now();
  let key: string;
  try {
    const res = await send();
    await res.arrayBuffer();
    key = String(res.status);
  } catch (e) {
    key = e instanceof Error ? e.name : "error";
  }
  tally.ms.push(performance.now() - t);
  tally.statuses.set(key, (tally.statuses.get(key) ?? 0) + 1);
}
function summary(tally: Tally, seconds: number): { line: string; failed: number; p99: number } {
  const sorted = [...tally.ms].sort((a, b) => a - b);
  const n = sorted.length;
  const ok = [...tally.statuses].filter(([s]) => s.startsWith("2")).reduce((a, [, c]) => a + c, 0);
  const p99 = quantile(sorted, 0.99);
  const statuses = [...tally.statuses].map(([s, c]) => `${s}×${c}`).join(" ");
  return { line: `${(n / seconds).toFixed(1)}/s, p50 ${quantile(sorted, 0.5).toFixed(0)} ms, p99 ${p99.toFixed(0)} ms, ${statuses}`, failed: n === 0 ? 1 : (n - ok) / n, p99 };
}

/** Runs `send` from `n` loops at once for `seconds`. */
async function run(n: number, seconds: number, send: () => Promise<Response>): Promise<Tally> {
  const tally = newTally();
  const until = performance.now() + seconds * 1000;
  await Promise.all(Array.from({ length: n }, async () => {
    while (performance.now() < until) await timed(tally, send);
  }));
  return tally;
}

/** One level after another, each `seconds` long, until one fails more than 5% or its p99 is over 3 s. */
async function ramp(name: string, levels: readonly number[], seconds: number, send: () => Promise<Response>, beside?: () => Promise<Response>): Promise<void> {
  for (const n of levels) {
    say(`${name}: ${n} at once, ${seconds} s`);
    const [tally, besideTally] = await Promise.all([run(n, seconds, send), beside === undefined ? Promise.resolve(null) : run(5, seconds, beside)]);
    const s = summary(tally, seconds);
    say(`${name}: ${n} at once: ${s.line}`);
    if (besideTally !== null) say(`${name}: ${n} at once: pages beside it: ${summary(besideTally, seconds).line}`);
    if (s.failed > 0.05 || s.p99 > 3000) {
      say(`${name}: stopped at ${n} at once`);
      return;
    }
  }
}

const LEVELS = QUICK ? [2, 4] : [10, 25, 50, 100, 200, 400];
const SECONDS = QUICK ? 3 : 30;

async function colo(): Promise<void> {
  const res = await fetch(url("/api/v1/config"));
  await res.arrayBuffer();
  const ray = res.headers.get("cf-ray");
  const where = ray?.split("-").at(-1) ?? "none (not Cloudflare)";
  say(`colo: ${where}, config HTTP ${res.status}`);
  const near = ["TPE", "KHH", "HKG", "NRT", "KIX", "ICN", "MNL", "SIN"];
  if (ray !== null && !near.includes(where) && !flag("--any-colo")) throw new Error(`the requests enter ${where}, not a data centre near Taiwan: the round trips would be in every number (--any-colo to go on)`);
}

async function generate(): Promise<void> {
  const day = taiwanDate(-2);
  let fingerprint = "0".repeat(64);
  const start = performance.now();
  for (let before = 0; before < RECORDS; before += 1000) {
    const file = await door<{ bytes: number; fingerprint: string }>("POST", "/__measure/log-file", { before, fingerprint, day });
    fingerprint = file.fingerprint;
    if ((before / 1000) % 10 === 9 || before + 1000 === RECORDS) say(`generate: ${before + 1000} records, the last file ${file.bytes} bytes, ${((performance.now() - start) / 1000).toFixed(0)} s`);
  }
  await door("POST", "/__measure/fingerprints", { day: taiwanDate(0), count: RECORDS, fingerprint });
  say(`generate: done, ${RECORDS} records dated ${day}, the fingerprint file's line ${taiwanDate(0)}`);
}

async function rebuild(): Promise<void> {
  const start = performance.now();
  let last = -1;
  for (;;) {
    const res = await fetch(url("/api/v1/rebuild"));
    const status = (await res.json()) as { name: string | null; status: string | null; records: number; reason: string | null };
    if (status.records !== last || status.status !== "running") {
      say(`rebuild: ${status.status} at ${status.records} records, ${((performance.now() - start) / 1000).toFixed(0)} s${status.reason === null ? "" : `, ${status.reason}`}`);
      last = status.records;
    }
    if (status.status === "swapped" || status.status === "refused") break;
    if (status.status === null && performance.now() - start > 60_000) throw new Error("rebuild: none began in a minute (was the object started before the files were there?)");
    if (performance.now() - start > 4 * 3_600_000) throw new Error("rebuild: not done in 4 hours");
    await sleep(2000);
  }
}

async function size(): Promise<void> {
  const s = await door<{ database_bytes: number; tables: Record<string, number>; bytes: Record<string, number> | null }>("GET", "/__measure/size");
  const cards = s.tables["cards"] ?? 0;
  say(`size: ${s.database_bytes} bytes; ${cards} cards, ${cards === 0 ? "-" : (s.database_bytes / cards).toFixed(0)} bytes a card, all tables together`);
  say(`size: rows ${JSON.stringify(s.tables)}`);
  say(`size: bytes each table holds (its values; pages, indexes and record headers not counted) ${s.bytes === null ? "not readable here" : JSON.stringify(s.bytes)}`);
}

/** A request for the card page of a random card of the views, from a sample asked for once. */
async function randomCardPage(): Promise<() => Promise<Response>> {
  const ids = await door<string[]>("GET", `/__measure/short-ids?n=${QUICK ? 50 : 2000}`);
  return () => fetch(url(`/p/${ids[Math.floor(Math.random() * ids.length)]}`), { headers: { Accept: "text/html" } });
}

async function pages(): Promise<void> {
  await ramp("pages", LEVELS, SECONDS, await randomCardPage());
}

async function writes(): Promise<void> {
  await door("POST", "/__measure/crls");
  const page = await randomCardPage();
  const write = (): Promise<Response> => fetch(url("/__measure/write"), { method: "POST", headers: { Authorization: `Bearer ${KEY}` } });
  await ramp("writes", QUICK ? [1, 2] : [1, 2, 5, 10, 20, 40, 80], SECONDS, write, page);
}

async function counts(): Promise<void> {
  const vectors = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "spec", "vectors", "counts.json"), "utf8")) as { cases: { count: unknown; taken: boolean }[] };
  const body = JSON.stringify(vectors.cases.find((c) => c.taken)!.count);
  const sent = new Map<string, number>();
  const minuteOf = (): string => `${new Date().toISOString().slice(0, 16)}Z`;
  const send = async (): Promise<Response> => {
    const minute = minuteOf();
    const res = await fetch(url("/api/v1/counts"), { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (res.status === 204) sent.set(minute, (sent.get(minute) ?? 0) + 1);
    return res;
  };
  for (const n of QUICK ? [2] : [10, 50, 100, 200, 400]) {
    // A level fills one minute's file: it begins a second after a minute begins and ends 4 s before it ends.
    await sleep(61_000 - (Date.now() % 60_000));
    say(`counts: ${n} at once, minute ${minuteOf()}`);
    const tally = await run(n, 55, send);
    say(`counts: ${n} at once: ${summary(tally, 55).line}`);
  }
  say("counts: waiting 75 s for the last minute's file");
  await sleep(75_000);
  const dates = [...new Set([...sent.keys()].map((m) => m.slice(0, 10)))];
  const files = (await Promise.all(dates.map((d) => door<{ minute: string; counts: number; dropped: number }[]>("GET", `/__measure/count-events?date=${d}`)))).flat();
  for (const [minute, n] of [...sent].sort()) {
    const file = files.find((f) => f.minute === minute);
    say(`counts: minute ${minute}: sent ${n} (204), the file kept ${file?.counts ?? "no file"}, dropped ${file?.dropped ?? "-"}`);
  }
}

async function publish(): Promise<void> {
  const roundTrip = async (send: () => Promise<unknown>): Promise<number> => {
    const t = performance.now();
    await send();
    return performance.now() - t;
  };
  for (let n = 1; n <= 3; n++) {
    const base = await roundTrip(async () => (await fetch(url("/api/v1/rebuild"))).arrayBuffer());
    const copy = await roundTrip(() => door("POST", "/__measure/cards-copy?drop=0"));
    const drop = await roundTrip(() => door("POST", "/__measure/cards-copy?drop=1"));
    say(`publish: copying the card state table, run ${n}: ${copy.toFixed(0)} ms, dropping the copy ${drop.toFixed(0)} ms, a request that reads one row ${base.toFixed(0)} ms (the round trip in both)`);
  }
  const today = taiwanDate(0);
  const start = performance.now();
  await door("POST", "/__measure/publish-now");
  say("publish: due now");
  let longest = 0;
  let polls = 0;
  for (;;) {
    polls++;
    const t = performance.now();
    const res = await fetch(url("/api/v1/fingerprint"));
    const line = (await res.json()) as { date?: string | null; count?: number };
    longest = Math.max(longest, performance.now() - t);
    if (line.date === today) {
      say(`publish: the line of ${today} (count ${line.count}) after ${((performance.now() - start) / 1000).toFixed(1)} s; a request to the object waited ${longest.toFixed(0)} ms at most; ${polls} requests of GET /api/v1/fingerprint meanwhile (each reads one row of published: take them off the rows read)`);
      return;
    }
    if (performance.now() - start > 30 * 60_000) throw new Error("publish: no line in 30 minutes");
    await sleep(10);
  }
}

const STEPS: Record<string, () => Promise<void>> = { colo, generate, rebuild, size, pages, writes, counts, publish };
if (step === "all") {
  for (const [name, f] of Object.entries(STEPS)) {
    say(`== ${name}`);
    await f();
  }
} else {
  const f = STEPS[step];
  if (f === undefined) throw new Error(`no step ${step}: ${["all", ...Object.keys(STEPS)].join(", ")}`);
  await f();
}
