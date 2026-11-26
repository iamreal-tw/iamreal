// The counts the back end takes (ADR-0032, ADR-0039; issue #54):
// `POST /api/v1/counts` against the whole Worker in the local workerd
// (test/harness.ts). Counts go in over HTTP, the minute is ended by moving
// the Worker's clock and ringing the counts' alarm, and the files are read
// from the simulated bucket. Which counts are taken is spec/vectors/counts.json,
// the same file the card proof page's tests read.
//
// The tests pin what a file holds, exactly: a member more is a failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { readCount } from "iamreal-protocol/counts.ts";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { COUNT_EVENTS_FILE, checkFromOutside } from "./outside-check.ts";
import { START, freshProofLog } from "./records.ts";

const VECTORS = JSON.parse(readFileSync(join(WORKER_DIR, "..", "spec", "vectors", "counts.json"), "utf8")) as { cases: { name: string; count: unknown; taken: boolean }[] };

let worker: TestWorker;
let proofLog: string;
/** The clock of this test: each test has minutes of its own, a day after the last one's. */
let time = START;
let tests = 0;
/** Where the test says its requests come from: an address of its own for each test (ADR-0026). */
let IP = "203.0.113.0";

before(async () => {
  worker = await startWorker();
});
after(() => worker.close());

beforeEach(async () => {
  tests++;
  IP = `203.0.113.${tests}`;
  // Whatever an earlier test left in memory is written under that test's minute, and taken away with the rest.
  await worker.setClock(new Date(time.getTime() + 3_600_000));
  await worker.ringCounts();
  await worker.failConnectionLog(false);
  proofLog = await freshProofLog(worker);
  await worker.emptyConnectionLog();
  time = new Date(START.getTime() + tests * 24 * 3_600_000);
  await worker.setClock(time);
});

const WEB = { client: "web", device_id: "0123456789abcdef0123456789abcdef", attempt_id: "fedcba9876543210fedcba9876543210", browser: "chrome", os: "windows" };
const step = (name: string): Record<string, string> => ({ ...WEB, event: "step", step: name });

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly contentType: string | null;
  readonly cacheControl: string | null;
  readonly requestId: string | null;
}
async function sendText(body: string | Uint8Array, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await worker.fetch("/api/v1/counts", { method: "POST", body: body as BodyInit, headers: { "CF-Connecting-IP": IP, ...headers } });
  return { status: res.status, body: await res.text(), contentType: res.headers.get("Content-Type"), cacheControl: res.headers.get("Cache-Control"), requestId: res.headers.get("X-Request-Id") };
}
const send = (count: unknown, headers?: Record<string, string>): Promise<Answer> => sendText(JSON.stringify(count), headers);

/** Ends the minute: the clock a minute on, and the counts' alarm. */
async function endMinute(): Promise<void> {
  time = new Date(time.getTime() + 60_000);
  await worker.setClock(time);
  await worker.ringCounts();
}

interface MinuteFile {
  readonly key: string;
  readonly text: string;
  readonly contentType: string | undefined;
  readonly said: { minute: string; counts: Record<string, string>[]; dropped: number };
}
/** Everything the bucket that is not public holds, apart: the files of counts, and the rest. */
async function bucket(): Promise<{ counts: MinuteFile[]; others: string[] }> {
  const all = await worker.connectionLog();
  return {
    counts: all.filter((o) => o.key.startsWith("count-events/")).map((o) => ({ key: o.key, text: o.text, contentType: o.contentType, said: o.entry as MinuteFile["said"] })),
    others: all.filter((o) => !o.key.startsWith("count-events/")).map((o) => o.key),
  };
}
const minute = (at: Date): string => `${at.toISOString().slice(0, 16)}Z`;

describe("which counts are taken: spec/vectors/counts.json", () => {
  test("every case gets the same answer, without a body; the minute's file holds the ones the table takes, in the order they came, and nothing of the others", async () => {
    const began = time;
    for (const [i, c] of VECTORS.cases.entries()) {
      // From several addresses: the cases are more than one address may send in a minute (ADR-0026).
      IP = `198.51.100.${(i % 20) + 1}`;
      const answer = await send(c.count);
      assert.deepEqual([answer.status, answer.body, answer.contentType, answer.cacheControl], [204, "", null, "no-store"], c.name);
      assert.match(answer.requestId ?? "", /^[0-9a-f]{16}$/);
    }
    // Nothing is written while the minute goes on.
    assert.deepEqual((await bucket()).counts, []);
    await endMinute();
    const { counts, others } = await bucket();
    assert.equal(counts.length, 1);
    const [file] = counts;
    assert.equal(file!.key, `count-events/${began.toISOString().slice(0, 10)}/${minute(began)}.json`);
    assert.equal(file!.contentType, "application/json");
    assert.deepEqual(Object.keys(file!.said), ["minute", "counts", "dropped"]);
    const taken = VECTORS.cases.filter((c) => c.taken);
    assert.ok(taken.length > 20 && taken.length < VECTORS.cases.length);
    assert.deepEqual(file!.said, { minute: minute(began), counts: taken.map((c) => readCount(c.count)), dropped: 0 });
    // A count is no submission: the connection log has nothing.
    assert.deepEqual(others, []);
  });

  test("what is no count at all is answered the same and dropped: not JSON, not UTF-8, longer than 2048 bytes", async () => {
    const long = { ...step("read"), reader: "A".repeat(64) };
    const padded = `${JSON.stringify(long).slice(0, -1)}${" ".repeat(2049)}}`;
    for (const body of ["", "{", "null", '"step"', new Uint8Array([0x7b, 0xff, 0x7d]), `﻿${JSON.stringify(step("read"))}`, padded]) {
      const answer = await sendText(body);
      assert.deepEqual([answer.status, answer.body], [204, ""]);
    }
    // The longest count the table allows is well within the limit, and taken.
    assert.equal((await send({ ...long, browser_version: "12345.12345.12345.12345", os_version: "12345.12345.12345.12345" })).status, 204);
    await endMinute();
    const { counts } = await bucket();
    assert.deepEqual(counts.map((f) => f.said.counts.length), [1]);
  });

  test("a minute in which no count was taken writes no file", async () => {
    await send({ ...step("read"), note: "anything" });
    await endMinute();
    assert.deepEqual((await bucket()).counts, []);
  });

  test("GET is not an endpoint's method", async () => {
    const res = await worker.fetch("/api/v1/counts", { headers: { "CF-Connecting-IP": IP } });
    assert.deepEqual([res.status, res.headers.get("Allow"), await res.json()], [405, "POST", { error: "method_not_allowed" }]);
  });
});

describe("what a file holds of a request: the count as the table has it, and nothing else", () => {
  test("no address, no header, no request ID, no time but the minute; the members of a count in one order", async () => {
    const began = time;
    const answer = await send(
      { step: "read", os: "macos", browser: "firefox", attempt_id: WEB.attempt_id, device_id: WEB.device_id, event: "step", client: "web" },
      { "User-Agent": "Mozilla/5.0 (TestAgent 9.9)", Referer: "https://example.org/secret/path", Cookie: "session=abc123", "X-Forwarded-For": "198.51.100.77" },
    );
    await endMinute();
    const { counts, others } = await bucket();
    assert.equal(counts[0]!.text, `{"minute":"${minute(began)}","counts":[{"client":"web","event":"step","step":"read","device_id":"${WEB.device_id}","attempt_id":"${WEB.attempt_id}","browser":"firefox","os":"macos"}],"dropped":0}\n`);
    for (const part of [IP, "203.0.113", "198.51.100.77", "TestAgent", "example.org", "abc123", answer.requestId!, began.toISOString().slice(0, 19)]) assert.ok(!counts[0]!.text.includes(part), part);
    assert.deepEqual(others, []);
  });

  test("the live log says nothing of a count, taken or dropped", async () => {
    const lines = worker.logLines().length;
    await send(step("read"));
    await send({ ...step("read"), reason: "no_reader" });
    await endMinute();
    assert.deepEqual(worker.logLines().slice(lines).filter((l) => l.includes("count") || l.includes(WEB.device_id)), []);
  });
});

describe("minutes", () => {
  test("each minute is a file of its own; a count that comes in a later minute has the earlier one written, without the alarm", async () => {
    const first = time;
    await send(step("read"));
    await send(step("certificates"));
    time = new Date(time.getTime() + 60_000);
    await worker.setClock(time);
    await send(step("pin"));
    const written = (await bucket()).counts;
    assert.deepEqual(written.map((f) => [f.said.minute, f.said.counts.map((c) => c.step)]), [[minute(first), ["read", "certificates"]]]);
    await endMinute();
    const files = (await bucket()).counts;
    assert.deepEqual(files.map((f) => [f.said.minute, f.said.counts.map((c) => c.step)]), [
      [minute(first), ["read", "certificates"]],
      [minute(new Date(first.getTime() + 60_000)), ["pin"]],
    ]);
  });

  test("the alarm that rings before the minute is over writes nothing, and loses nothing", async () => {
    await send(step("read"));
    await worker.ringCounts();
    assert.deepEqual((await bucket()).counts, []);
    await endMinute();
    assert.deepEqual((await bucket()).counts.map((f) => f.said.counts.length), [1]);
  });

  test("a minute holds COUNT_EVENTS_PER_MINUTE counts: the ones over it are only counted", async () => {
    await worker.setSettings({ PROOF_LOG_KIND: "test", PROOF_LOG_OBJECT_NAME: proofLog, COUNT_EVENTS_PER_MINUTE: "3" });
    for (const name of ["read", "certificates", "certificate", "config", "crl"]) assert.equal((await send(step(name))).status, 204);
    // A dropped count is not one of them.
    await send({ ...step("tree"), note: "anything" });
    await endMinute();
    const [file] = (await bucket()).counts;
    assert.deepEqual([file!.said.counts.map((c) => c.step), file!.said.dropped], [["read", "certificates", "certificate"], 2]);
    // The next minute starts at none.
    await send(step("pin"));
    await endMinute();
    const files = (await bucket()).counts;
    assert.deepEqual([files[1]!.said.counts.map((c) => c.step), files[1]!.said.dropped], [["pin"], 0]);
  });

  test("with 0, no count is kept, and the file says how many came", async () => {
    await worker.setSettings({ PROOF_LOG_KIND: "test", PROOF_LOG_OBJECT_NAME: proofLog, COUNT_EVENTS_PER_MINUTE: "0" });
    await send(step("read"));
    await send(step("pin"));
    await endMinute();
    const [file] = (await bucket()).counts;
    assert.deepEqual([file!.said.counts, file!.said.dropped], [[], 2]);
  });

  test("a setting that is no number of counts: 500, and nothing is kept", async () => {
    for (const set of ["many", "-1", "1.5", "100001", "007", ""]) {
      await worker.setSettings({ PROOF_LOG_KIND: "test", PROOF_LOG_OBJECT_NAME: proofLog, COUNT_EVENTS_PER_MINUTE: set });
      const answer = await send(step("read"));
      assert.deepEqual([answer.status, answer.body], [500, '{"error":"internal"}'], set);
    }
    await endMinute();
    assert.deepEqual((await bucket()).counts, []);
  });
});

describe("the counts and the rest of the back end", () => {
  test("a count does not ask the proof log's object: with that object answering nothing, a count is taken as ever", async () => {
    await worker.proofLog.setStoredSchemaVersion("another");
    await worker.proofLog.restart();
    try {
      const fingerprint = await worker.fetch("/api/v1/fingerprint", { headers: { "CF-Connecting-IP": IP } });
      assert.equal(fingerprint.status, 500, "the proof log's object refuses every call");
      assert.equal((await send(step("read"))).status, 204);
      await endMinute();
      assert.deepEqual((await bucket()).counts.map((f) => f.said.counts.map((c) => c.step)), [["read"]]);
    } finally {
      await worker.proofLog.setStoredSchemaVersion("the build's");
      await worker.proofLog.restart();
    }
  });

  test("a file that cannot be written is one line in the live log, with the minute and nothing of a count; the counts are answered as ever", async () => {
    const began = time;
    await send(step("read"));
    await worker.failConnectionLog(true);
    const lines = worker.logLines().length;
    await endMinute();
    await worker.failConnectionLog(false);
    const said = worker.logLines().slice(lines).filter((l) => l.includes("count_events_not_written"));
    assert.equal(said.length, 1);
    assert.deepEqual(JSON.parse(said[0]!.slice(said[0]!.indexOf("{"))), { event: "count_events_not_written", minute: minute(began), error: "Error" });
    assert.deepEqual((await bucket()).counts, []);
    assert.equal((await send(step("pin"))).status, 204);
  });
});

describe("the date of the oldest file of counts is published every hour, for whoever checks from outside", () => {
  /** The published file after one run of the schedule. */
  async function published(): Promise<{ text: string; cacheControl: string | undefined; contentType: string | undefined }> {
    await worker.runSchedule();
    const [file] = await worker.files(COUNT_EVENTS_FILE);
    assert.ok(file, `the data bucket has ${COUNT_EVENTS_FILE}`);
    return { text: new TextDecoder().decode(file.bytes), cacheControl: file.cacheControl, contentType: file.contentType };
  }
  /** The line of the counts in the check from outside (test/outside-check.ts), reading the data bucket as the data domain: what failed. */
  async function outside(): Promise<string[]> {
    const data = async (path: string): Promise<Response> => {
      const file = (await worker.files(path.slice(1))).find((f) => `/${f.key}` === path);
      return file === undefined ? new Response(null, { status: 404 }) : new Response(new Blob([new Uint8Array(file.bytes)]));
    };
    const lines = await checkFromOutside({ site: (path) => worker.fetch(path), data, now: time.getTime(), clearedOn: "2026-11-20", countEvents: true });
    const line = lines.filter((l) => l.what.startsWith(`the data domain: ${COUNT_EVENTS_FILE}`));
    assert.equal(line.length, 1);
    return line.filter((l) => !l.ok).map((l) => l.what);
  }

  test("no file of counts: the time it was looked at, and null; the check from outside passes", async () => {
    const file = await published();
    assert.equal(file.text, `{"checked":"${time.toISOString()}","oldest":null}\n`);
    assert.deepEqual([file.cacheControl, file.contentType], ["public, max-age=60", "application/json"]);
    assert.deepEqual(await outside(), []);
  });

  test("files of several days: the earliest day, whatever else the bucket holds; nothing a count holds", async () => {
    const began = time;
    await send(step("read"));
    await endMinute();
    // Other prefixes of the same bucket, older: not the counts'.
    await worker.putInConnectionLogBucket("connection/2020-01-01/x.json", "{}");
    await worker.putInConnectionLogBucket("count-totals/2020-01-01.json", "{}");
    const file = await published();
    assert.equal(file.text, `{"checked":"${time.toISOString()}","oldest":"${began.toISOString().slice(0, 10)}"}\n`);
    assert.ok(!file.text.includes(WEB.device_id));
    assert.deepEqual(await outside(), []);
  });

  test("a file 33 days old passes; one 34 days old is in the published file, in the live log, and fails the check from outside", async () => {
    const day = (ago: number): string => new Date(time.getTime() - ago * 24 * 3_600_000).toISOString().slice(0, 10);
    await worker.putInConnectionLogBucket(`count-events/${day(33)}/${day(33)}T00:00Z.json`, "{}");
    assert.equal((await published()).text, `{"checked":"${time.toISOString()}","oldest":"${day(33)}"}\n`);
    assert.deepEqual(await outside(), []);

    await worker.putInConnectionLogBucket(`count-events/${day(34)}/${day(34)}T23:59Z.json`, "{}");
    const lines = worker.logLines().length;
    assert.equal((await published()).text, `{"checked":"${time.toISOString()}","oldest":"${day(34)}"}\n`);
    assert.ok(worker.logLines().slice(lines).some((l) => l.includes('"count_events_overdue"') && l.includes(day(34))));
    assert.deepEqual(await outside(), [`the data domain: ${COUNT_EVENTS_FILE} says the back end looked in the last 2 hours, and no file of counts is older than 33 days: the oldest file of counts is of ${day(34)}`]);
  });

  test("a bucket that cannot be listed leaves the file as it was, and the connection log's file is still published", async () => {
    await published();
    const before = time;
    await worker.putInConnectionLogBucket("count-events/not-a-date.json", "{}");
    time = new Date(time.getTime() + 3_600_000);
    await worker.setClock(time);
    const lines = worker.logLines().length;
    assert.equal((await published()).text, `{"checked":"${before.toISOString()}","oldest":null}\n`);
    assert.ok(worker.logLines().slice(lines).some((l) => l.includes('"count_events_oldest_not_published"')));
    const [connection] = await worker.files("connection-log/oldest.json");
    assert.equal(new TextDecoder().decode(connection!.bytes), `{"checked":"${time.toISOString()}","oldest":null}\n`);
  });
});
