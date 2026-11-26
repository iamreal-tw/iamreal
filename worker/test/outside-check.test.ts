// The check from outside Cloudflare (test/outside-check.ts, #53), run on the
// local Worker: it passes on a Worker that published today and mirrored
// fresh CRLs, and each thing it is for makes exactly its line fail, saying
// which: config not answering, the home page not answering, no fingerprint
// line of today, a CRL index too old, no card state file of today. The data
// domain is the simulated R2 bucket.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";
import { CRL_TIME, freshProofLog, publishCrl, tw } from "./records.ts";
import { checkFromOutside } from "./outside-check.ts";
import type { Reader } from "./site-check.ts";

/** The date this test's proof log was cleared on: the day its object first runs. */
const CLEARED_ON = "2026-11-10";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await freshProofLog(worker, { clearedOn: CLEARED_ON });
  // A usable CRL of each issuer key dated 2026-11-20 in Taiwan (records.ts, CRL_TIME), and a newer one dated 2026-11-21.
  for (const issuer of ["G2", "G3"] as const) {
    await publishCrl(worker, { issuer, number: 1, thisUpdate: CRL_TIME });
    await publishCrl(worker, { issuer, number: 2, thisUpdate: tw("2026-11-21", "05:00:00") });
  }
  // The proof log's object starts on 2026-11-20, and is published at the next midnight: a line and a card state file dated 2026-11-21.
  await worker.setClock(tw("2026-11-20", "12:00:00"));
  await worker.fetch("/api/v1/fingerprint");
  await worker.setClock(tw("2026-11-21", "00:00:00"));
  await worker.proofLog.runAlarm();
});
after(async () => {
  await worker.close();
});

const site: Reader = (path, headers) => worker.fetch(path, { redirect: "manual", headers: { ...headers } });
const data: Reader = async (path) => {
  const file = (await worker.files(path.slice(1))).find((f) => `/${f.key}` === path);
  return file === undefined ? new Response(null, { status: 404 }) : new Response(new Blob([new Uint8Array(file.bytes)]));
};

type Parts = Parameters<typeof checkFromOutside>[0];
/** 2026-11-21, 09:30 in Taiwan: the day of the publication above, after it was due. */
const AS_RUNNING: Parts = { site, data, now: tw("2026-11-21", "09:30:00").getTime(), clearedOn: CLEARED_ON };
const failed = async (parts: Partial<Parts>): Promise<string[]> => (await checkFromOutside({ ...AS_RUNNING, ...parts })).filter((l) => !l.ok).map((l) => l.what);
const answering = (path: string, answer: () => Response, reader: Reader): Reader => async (p, headers) => (p === path ? answer() : reader(p, headers));

/** Fails exactly the line that starts with `line`, saying `saying`. */
async function failsOnly(parts: Partial<Parts>, line: string, saying: RegExp): Promise<void> {
  const lines = await failed(parts);
  assert.equal(lines.length, 1, lines.join("\n") || `nothing failed, ${line} should have`);
  assert.ok(lines[0]!.startsWith(line), lines[0]);
  assert.match(lines[0]!, saying);
}

test("every check passes on a Worker that published today and has CRLs of both issuer keys", async () => {
  const lines = await checkFromOutside(AS_RUNNING);
  assert.equal(lines.length, 6, "a line for each thing checked");
  assert.deepEqual(lines.filter((l) => !l.ok), []);
});

test("config not answering, and the home page not answering: each its own line", async () => {
  await failsOnly({ site: answering("/api/v1/config", () => new Response("", { status: 500 }), site) }, "GET /api/v1/config", /the status is 500/);
  await failsOnly({ site: answering("/api/v1/config", () => Response.json({ crl_max_age_days: 3 }), site) }, "GET /api/v1/config", /no platform table/);
  await failsOnly({ site: async (p, h) => (p === "/api/v1/config" ? Promise.reject(new Error("connect ECONNREFUSED")) : site(p, h)) }, "GET /api/v1/config", /the request failed/);
  await failsOnly({ site: answering("/", () => new Response("", { status: 503 }), site) }, "GET / ", /the status is 503/);
});

test("the proof log not published today: the fingerprint line and the card state file fail; until 01:00 in Taiwan yesterday's pass", async () => {
  // The next day, 09:30: the last line and file are of 2026-11-21.
  const nextDay = { now: tw("2026-11-22", "09:30:00").getTime() };
  const lines = await failed(nextDay);
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.match(lines[0]!, /^the data domain: proof-log\/fingerprints\.jsonl has a line dated 2026-11-22 or later \(the proof log was published\): the last line is dated 2026-11-21$/);
  assert.match(lines[1]!, /^the data domain: the card state file of 2026-11-22 or later is there: there is no proof-log\/card-state\/2026-11-22\.jsonl$/);
  // 00:30 the same day: publication may still be retried; yesterday's pass.
  assert.deepEqual(await failed({ now: tw("2026-11-22", "00:30:00").getTime() }), []);
  // No fingerprint file at all, long after the clearing.
  await failsOnly({ data: answering("/proof-log/fingerprints.jsonl", () => new Response(null, { status: 404 }), data) }, "the data domain: proof-log/fingerprints.jsonl", /there is no file/);
  // Just cleared: neither the file nor the card state file yet, and that passes.
  const cleared = { clearedOn: "2026-11-21", data: async (p: string) => (p.startsWith("/proof-log/") ? new Response(null, { status: 404 }) : data(p)) };
  assert.deepEqual(await failed(cleared), []);
});

test("no card state file of today, with today's fingerprint line: only that line fails", async () => {
  await failsOnly({ data: answering("/proof-log/card-state/2026-11-21.jsonl", () => new Response(null, { status: 404 }), data) }, "the data domain: the card state file", /there is no proof-log\/card-state\/2026-11-21\.jsonl/);
});

test("a CRL index whose newest usable CRL of an issuer key is more than a day old: that key's line fails, saying the date", async () => {
  // Two days after the newest CRLs (dated 2026-11-21). The publication is left out of it: a test log cleared the day before, with no file yet.
  const noPublication = { clearedOn: "2026-11-22", data: async (p: string): Promise<Response> => (p.startsWith("/proof-log/") ? new Response(null, { status: 404 }) : data(p)) };
  const lines = await failed({ ...noPublication, now: tw("2026-11-23", "09:30:00").getTime() });
  assert.deepEqual(lines, [
    "the data domain: the newest usable CRL of G2 in crl/index.jsonl is at most 1 day old: it is dated 2026-11-21 (number 2)",
    "the data domain: the newest usable CRL of G3 in crl/index.jsonl is at most 1 day old: it is dated 2026-11-21 (number 2)",
  ]);
  // A day after them: still within.
  assert.deepEqual(await failed({ ...noPublication, now: tw("2026-11-22", "23:00:00").getTime() }), []);
  // No index: both lines fail, saying so.
  const noIndex = await failed({ data: answering("/crl/index.jsonl", () => new Response(null, { status: 404 }), data) });
  assert.equal(noIndex.length, 2, noIndex.join("\n"));
  assert.ok(noIndex.every((l) => l.endsWith("the index's status is 404") || l.endsWith("there is no index to look in")), noIndex.join("\n"));
});

test("what a line says: what was checked, a status or a date; nothing of a request's contents", async () => {
  const lines = await failed({ now: tw("2026-11-25", "09:30:00").getTime() });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.doesNotMatch(l, /\b\d{1,3}(\.\d{1,3}){3}\b|scoped_id|"accounts"/, l);
});
