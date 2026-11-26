// The connection log (ADR-0022; issue #20): which requests get an object in
// its bucket, and what the object holds. Against the whole Worker in the
// local workerd (test/harness.ts), with the verifier that judges a proof by
// its first byte (test/records.ts): requests go in over HTTP, and the
// objects are read from the simulated R2 bucket.
//
// This is where the back end keeps an IP address. The tests pin the keys of
// an object, exactly: a field more is a failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";
import { BAD_PROOF, START, type Submission, UNVERIFIABLE_PROOF, cardState, checkProofLog, freshProofLog, list, newCard, publishG3, sub } from "./records.ts";

let worker: TestWorker;
let root: string;

before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

beforeEach(async () => {
  await worker.failConnectionLog(false);
  await freshProofLog(worker);
  root = await publishG3(worker);
  await worker.emptyConnectionLog();
});

/** Where the test says its requests come from. */
const IP = "203.0.113.7";
const DEVICE = "0123456789abcdef0123456789abcdef";

interface Sent {
  readonly status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body: any;
  readonly requestId: string;
  readonly text: string;
}

/** Sends a body to `POST /api/v1/records` as it is, as a request from IP. */
async function send(text: string): Promise<Sent> {
  const res = await worker.fetch("/api/v1/records", { method: "POST", body: text, headers: { "CF-Connecting-IP": IP } });
  return { status: res.status, body: JSON.parse(await res.text()), requestId: res.headers.get("X-Request-Id")!, text };
}
const submit = (s: Submission, more: Record<string, unknown> = {}): Promise<Sent> => send(JSON.stringify({ ...s, ...more }));

type Entries = Awaited<ReturnType<TestWorker["connectionLog"]>>;

/** The connection log once it holds `n` objects: the answer does not wait for the write. */
async function entries(n: number): Promise<Entries> {
  let found: Entries = [];
  for (const until = Date.now() + 5_000; Date.now() < until; ) {
    found = await worker.connectionLog();
    if (found.length >= n) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(found.length, n, `the connection log holds ${found.length} objects: ${found.map((f) => f.key).join(", ")}`);
  return found;
}

/** The connection log still holds `n` objects a while after the requests were answered. */
async function stillEntries(n: number): Promise<Entries> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return entries(n);
}

/** The keys of an object for a submission that became a record, and for one that did not: these and no other. */
const ACCEPTED_KEYS = ["request_id", "time", "result", "ip", "country", "asn", "device_id", "seq"];
const REFUSED_KEYS = ["request_id", "time", "result", "error", "ip", "country", "asn", "device_id", "body"];

/** What Cloudflare says of where a request came from: a country code and an AS number, or, in a local workerd, perhaps neither. */
function checkOrigin(entry: Record<string, unknown>): void {
  assert.equal(entry.ip, IP);
  assert.ok(entry.country === null || typeof entry.country === "string", `country ${String(entry.country)}`);
  assert.ok(entry.asn === null || typeof entry.asn === "number", `asn ${String(entry.asn)}`);
}

describe("a submission that becomes a record", () => {
  test("one object: the request ID, the time, 201, where it came from, the device ID and the record's seq; no body, and no other field", async () => {
    const s = await sub(worker, newCard(), root, "threads:alice");
    const sent = await submit(s, { device_id: DEVICE });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    const [object] = await entries(1);
    const { entry } = object!;
    assert.deepEqual(Object.keys(entry), ACCEPTED_KEYS);
    assert.equal(entry.request_id, sent.requestId);
    assert.equal(entry.time, START.toISOString());
    assert.equal(entry.result, 201);
    checkOrigin(entry);
    assert.equal(entry.device_id, DEVICE);
    assert.equal(entry.seq, sent.body.seq);
    // Nothing of the body: not the card, not the account, not the challenge, not the proof.
    for (const part of [s.scoped_id, "alice", s.challenge, s.proof, s.smt_root]) assert.ok(!object!.text.includes(part), part);
    // The key begins with the date, and a day's objects list in the order of their times.
    assert.equal(object!.key, `connection/2026-11-20/${START.toISOString()}-${sent.requestId}.json`);
    assert.equal(object!.contentType, "application/json");
  });

  test("the device ID is in the connection log and nowhere in the proof log", async () => {
    const s = await sub(worker, newCard(), root, "threads:alice");
    assert.equal((await submit(s, { device_id: DEVICE })).status, 201);
    await entries(1);

    const records = await checkProofLog(worker);
    assert.equal(records.length, 1);
    assert.ok(!JSON.stringify(records).includes(DEVICE), "a record holds the device ID");
    assert.ok(!JSON.stringify(await cardState(worker, s.scoped_id)).includes(DEVICE));
    // Nor in any file of the public data.
    for (const file of await worker.files()) assert.ok(!new TextDecoder().decode(file.bytes).includes(DEVICE), file.key);
  });

  test("a submission without a device ID is taken as ever, and its object says null", async () => {
    const sent = await submit(await sub(worker, newCard(), root, "threads:alice"));
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const [object] = await entries(1);
    assert.deepEqual(Object.keys(object!.entry), ACCEPTED_KEYS);
    assert.equal(object!.entry.device_id, null);
  });

  test("a device ID that is not 32 lowercase hex digits is malformed: no record, and no object", async () => {
    for (const bad of ["0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef", `${DEVICE}0`, "", 5, null, { id: DEVICE }]) {
      const sent = await submit(await sub(worker, newCard(), root, "threads:alice"), { device_id: bad });
      assert.deepEqual([sent.status, sent.body], [400, { error: "malformed" }], JSON.stringify(bad));
    }
    // Another key beside it is no submission either.
    const sent = await submit(await sub(worker, newCard(), root, "threads:alice"), { device_id: DEVICE, visit_id: DEVICE });
    assert.deepEqual([sent.status, sent.body], [400, { error: "malformed" }]);
    assert.equal((await checkProofLog(worker)).length, 0);
    await stillEntries(0);
  });
});

describe("a submission with a challenge the back end issued that does not become a record", () => {
  test("one object: the same without seq, with the error code and the body as it came, and no other field", async () => {
    const s = await sub(worker, newCard(), root, "threads:alice");
    const sent = await submit({ ...s, proof: BAD_PROOF }, { device_id: DEVICE });
    assert.deepEqual([sent.status, sent.body], [400, { error: "proof" }]);

    const [object] = await entries(1);
    const { entry } = object!;
    assert.deepEqual(Object.keys(entry), REFUSED_KEYS);
    assert.equal(entry.request_id, sent.requestId);
    assert.equal(entry.time, START.toISOString());
    assert.equal(entry.result, 400);
    assert.equal(entry.error, "proof");
    checkOrigin(entry);
    assert.equal(entry.device_id, DEVICE);
    assert.equal(entry.body, sent.text);
  });

  test("whatever it is refused with once it was counted: the record rules, and the back end's own failure", async () => {
    // No account and nothing to withdraw: the record rules' `empty`.
    const empty = await submit(await sub(worker, newCard(), root));
    assert.deepEqual([empty.status, empty.body], [400, { error: "empty" }]);
    // A verifier that cannot run: `500`.
    const failed = await submit({ ...(await sub(worker, newCard(), root, "threads:alice")), proof: UNVERIFIABLE_PROOF });
    assert.deepEqual([failed.status, failed.body], [500, { error: "internal" }]);

    const found = await entries(2);
    const byId = new Map(found.map((f) => [f.entry.request_id, f.entry]));
    assert.deepEqual([byId.get(empty.requestId)?.result, byId.get(empty.requestId)?.error, byId.get(empty.requestId)?.body], [400, "empty", empty.text]);
    assert.deepEqual([byId.get(failed.requestId)?.result, byId.get(failed.requestId)?.error, byId.get(failed.requestId)?.body], [500, "internal", failed.text]);
    for (const f of found) assert.deepEqual(Object.keys(f.entry), REFUSED_KEYS);
  });

  test("a challenge is counted five times, so it gets five objects at most: the sixth submission and those after get none", async () => {
    const s = { ...(await sub(worker, newCard(), root, "threads:alice")), proof: BAD_PROOF };
    for (let i = 0; i < 5; i++) assert.equal((await submit(s)).body.error, "proof");
    for (let i = 0; i < 4; i++) assert.equal((await submit(s)).body.error, "challenge_attempts");
    await stillEntries(5);
  });

  test("a challenge a record was written for gets no object again", async () => {
    const s = await sub(worker, newCard(), root, "threads:alice");
    assert.equal((await submit(s)).status, 201);
    for (let i = 0; i < 3; i++) assert.equal((await submit(s)).body.error, "challenge_used");
    await stillEntries(1);
  });
});

describe("every other request leaves no object", () => {
  test("pages, config, a challenge, the card's state, the fingerprint; a submission that is not one, or whose challenge the back end did not issue; a stopped back end", async () => {
    const headers = { "CF-Connecting-IP": IP };
    for (const path of ["/", "/log", "/faq", "/privacy", "/p/7K2Q9FM4XD", "/api/v1/config", "/api/v1/fingerprint", "/api/v1/rebuild", "/api/v1/nothing"]) await (await worker.fetch(path, { headers })).arrayBuffer();
    assert.equal((await worker.fetch("/api/v1/challenges", { method: "POST", headers })).status, 200);
    assert.equal((await worker.fetch("/api/v1/card-state", { method: "POST", headers, body: JSON.stringify({ scope_string: "iamreal-test:public:0__________", scoped_id: newCard() }) })).status, 200);
    assert.equal((await worker.fetch("/api/v1/records", { headers })).status, 405);

    const good = await sub(worker, newCard(), root, "threads:alice");
    // Not a submission: not JSON, a key missing, a field out of its format, another scope, a platform outside the table.
    for (const [what, text, code] of [
      ["not JSON", "{", "malformed"],
      ["no proof", JSON.stringify({ ...good, proof: undefined }), "malformed"],
      ["a username in uppercase", JSON.stringify({ ...good, accounts: list("threads:Alice") }), "malformed"],
      ["another scope", JSON.stringify({ ...good, scope_string: "iamreal:public:0_______________" }), "scope"],
      ["another platform", JSON.stringify({ ...good, accounts: list("nowhere:alice") }), "platform"],
    ] as const) {
      const sent = await send(text);
      assert.deepEqual([sent.status, sent.body], [400, { error: code }], what);
    }
    // Well formed, with a challenge the back end did not issue: one of another proof log.
    await freshProofLog(worker);
    const other = await submit(good);
    assert.deepEqual([other.status, other.body], [400, { error: "challenge_unknown" }]);
    // The operator stopped taking card proofs.
    const name = await freshProofLog(worker);
    const waiting = await sub(worker, newCard(), await publishG3(worker), "threads:alice");
    await worker.setSettings({ PROOF_LOG_KIND: "test", PROOF_LOG_OBJECT_NAME: name, CARD_PROOFS_PAUSED: "true" });
    const paused = await submit(waiting);
    assert.deepEqual([paused.status, paused.body], [503, { error: "paused" }]);

    await stillEntries(0);
  });
});

describe("a connection log that cannot be written to", () => {
  test("the answers are what they would have been, and the live log has one line for each object that was not written, with nothing of the request", async () => {
    await worker.failConnectionLog(true);
    const before = worker.logLines().length;
    const taken = await submit(await sub(worker, newCard(), root, "threads:alice"), { device_id: DEVICE });
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    assert.deepEqual(Object.keys(taken.body), ["seq", "record_hash", "ordinal", "kinds"]);
    const refusedSubmission = { ...(await sub(worker, newCard(), root, "threads:bob")), proof: BAD_PROOF };
    const refused = await submit(refusedSubmission, { device_id: DEVICE });
    assert.deepEqual([refused.status, refused.body], [400, { error: "proof" }]);
    assert.equal((await checkProofLog(worker)).length, 1);

    let lines: string[] = [];
    for (const until = Date.now() + 5_000; Date.now() < until && lines.length < 2; ) {
      lines = worker.logLines().slice(before).filter((l) => l.includes("connection_log_not_written"));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(lines.map((l) => JSON.parse(l) as unknown).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)), [taken.requestId, refused.requestId].map((id) => ({ event: "connection_log_not_written", id, error: "Error" })).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));
    for (const line of lines) for (const part of [IP, DEVICE, "alice", "bob", refusedSubmission.challenge]) assert.ok(!line.includes(part), `${part} in ${line}`);
    await stillEntries(0);

    // Writable again: the next submission has its object.
    await worker.failConnectionLog(false);
    assert.equal((await submit(await sub(worker, newCard(), root, "threads:carol"))).status, 201);
    await entries(1);
  });
});

describe("writing the connection log does not go through the proof log's object", () => {
  test("the module that writes it names neither the object nor anything that reaches it", () => {
    const source = readFileSync(new URL("../src/connection-log.ts", import.meta.url), "utf8");
    assert.deepEqual([...source.matchAll(/^import .*$/gm)].map((m) => m[0]), [], "connection-log.ts imports nothing");
    for (const name of ["proofLogOf", "PROOF_LOG", "DurableObject", "env."]) assert.ok(!source.includes(name), name);
  });

  test("an object whose every write fails still gets the refused submission's entry written", async () => {
    // The proof log's object cannot write a record; the connection log is not its business.
    const s = await sub(worker, newCard(), root, "threads:alice");
    await worker.proofLog.failWritesTo("records");
    try {
      const sent = await submit(s);
      assert.deepEqual([sent.status, sent.body], [500, { error: "internal" }]);
      const [object] = await entries(1);
      assert.deepEqual([object!.entry.request_id, object!.entry.result, object!.entry.error], [sent.requestId, 500, "internal"]);
    } finally {
      await worker.proofLog.failWritesTo(null);
    }
  });
});

describe("the date of the oldest entry is published every hour, and nothing else of the log", () => {
  const OLDEST = "connection-log/oldest.json";
  /** The published file after one run of the schedule: its text, what it says, and its headers. */
  async function published(): Promise<{ text: string; said: Record<string, unknown>; cacheControl: string | undefined; contentType: string | undefined }> {
    // The round of the mirror in the same run ends as it will (MOICA has nothing here): not this file's business.
    await worker.runSchedule();
    const [file] = await worker.files(OLDEST);
    assert.ok(file, `the data bucket has ${OLDEST}`);
    const text = new TextDecoder().decode(file.bytes);
    return { text, said: JSON.parse(text) as Record<string, unknown>, cacheControl: file.cacheControl, contentType: file.contentType };
  }

  test("an empty log: the time it was looked at, and null", async () => {
    const file = await published();
    assert.equal(file.text, `{"checked":"${START.toISOString()}","oldest":null}\n`);
    assert.deepEqual([file.cacheControl, file.contentType], ["public, max-age=60", "application/json"]);
  });

  test("entries of several days: the earliest day, whatever else the bucket holds; the two keys and no other", async () => {
    const later = new Date(START.getTime() + 3 * 24 * 3600 * 1000);
    await worker.setClock(later);
    const second = await submit(await sub(worker, newCard(), root, "threads:bob"), { device_id: DEVICE });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    await worker.setClock(START);
    const first = await submit({ ...(await sub(worker, newCard(), root, "threads:alice")), proof: BAD_PROOF });
    assert.equal(first.body.error, "proof");
    await entries(2);
    // Under another prefix of the same bucket, older: not the connection log's.
    await worker.putInConnectionLogBucket("counts/2020-01-01/x.json", "{}");

    await worker.setClock(later);
    const file = await published();
    assert.deepEqual(Object.keys(file.said), ["checked", "oldest"]);
    assert.deepEqual(file.said, { checked: later.toISOString(), oldest: "2026-11-20" });
    // Nothing an entry holds, and not how many there are.
    for (const part of [IP, DEVICE, first.requestId, second.requestId, "alice", "bob", "proof"]) assert.ok(!file.text.includes(part), part);
  });

  test("an entry older than 31 days and the two days of slack: its date is published as it is, and the live log says the log is overdue; one day less, and it does not", async () => {
    const overdue = (lines: number): unknown[] => worker.logLines().slice(lines).filter((l) => l.includes("connection_log_overdue")).map((l) => JSON.parse(l) as unknown);
    // START is 2026-11-20 (UTC): 33 days before it is 2026-10-18.
    await worker.putInConnectionLogBucket("connection/2026-10-18/2026-10-18T03:00:00.000Z-0123456789abcdef.json", "{}");
    let lines = worker.logLines().length;
    assert.deepEqual((await published()).said, { checked: START.toISOString(), oldest: "2026-10-18" });
    assert.deepEqual(overdue(lines), [], "33 days old is not overdue yet");

    await worker.putInConnectionLogBucket("connection/2026-10-17/2026-10-17T23:59:59.999Z-fedcba9876543210.json", "{}");
    lines = worker.logLines().length;
    assert.deepEqual((await published()).said, { checked: START.toISOString(), oldest: "2026-10-17" });
    assert.deepEqual(overdue(lines), [{ event: "connection_log_overdue", oldest: "2026-10-17" }]);

    // The old ones gone, as the lifecycle rule takes them: nothing is said again.
    await worker.emptyConnectionLog();
    lines = worker.logLines().length;
    assert.deepEqual((await published()).said, { checked: START.toISOString(), oldest: null });
    assert.deepEqual(overdue(lines), []);
  });

  test("a bucket whose first key is no entry's: nothing is said, the file keeps its earlier time, and the live log has one line", async () => {
    const before = await published();
    await worker.putInConnectionLogBucket("connection/0-not-a-date.json", "{}");
    await worker.setClock(new Date(START.getTime() + 3600 * 1000));
    const lines = worker.logLines().length;
    const after = await published();
    assert.equal(after.text, before.text);
    assert.deepEqual(worker.logLines().slice(lines).filter((l) => l.includes("connection_log_oldest")).map((l) => JSON.parse(l) as unknown), [{ event: "connection_log_oldest_not_published", error: "Error" }]);
  });
});
