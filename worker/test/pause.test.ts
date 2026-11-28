// Stopping and resuming taking card proofs (ADR-0033, #105): the maintainer
// sets CARD_PROOFS_PAUSED, and the Worker refuses challenges and records with
// `paused` before it asks the proof log's object. Everything else goes on.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";
import { cardState, day, freshProofLog, mustSubmit, newCard, publishG3, sub, submit } from "./records.ts";

let worker: TestWorker;
let name = "";

before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

/** The settings of the proof log the test made, with taking card proofs stopped or not. */
const pause = (paused: "true" | "false" | string): Promise<void> => worker.setSettings({ PROOF_LOG_KIND: "test", PROOF_LOG_OBJECT_NAME: name, CARD_PROOFS_PAUSED: paused });

async function config(): Promise<Record<string, unknown>> {
  const res = await worker.fetch("/api/v1/config");
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

async function challenge(): Promise<{ status: number; body: unknown }> {
  const res = await worker.fetch("/api/v1/challenges", { method: "POST" });
  return { status: res.status, body: await res.json() };
}

const count = async (): Promise<unknown> => (await cardState(worker, newCard())).count;

describe("CARD_PROOFS_PAUSED", () => {
  test("not set, or false: config says not paused, and card proofs are taken", async () => {
    name = await freshProofLog(worker);
    const root = await publishG3(worker);
    assert.equal((await config()).paused, false);
    await pause("false");
    assert.equal((await config()).paused, false);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
  });

  test("true: config says so; challenges and records answer 503 paused; the proof log takes nothing, and the submission does not count", async () => {
    name = await freshProofLog(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    // A challenge issued before the stop, submitted after it.
    const before = await sub(worker, newCard(), root, "threads:bob");
    await pause("true");
    const c = await config();
    assert.equal(c.paused, true);
    // The rest of config as ever.
    assert.ok(typeof c.crl_max_age_days === "number" && Array.isArray(c.platforms) && typeof c.min_app === "object");
    assert.deepEqual(await challenge(), { status: 503, body: { error: "paused" } });
    for (let i = 0; i < 6; i++) assert.deepEqual(await submit(worker, before), { status: 503, body: { error: "paused" } }, `submission ${i + 1}`);
    assert.equal(await count(), 1, "the proof log took no record");
    // A malformed request is still malformed: its format is read first.
    const res = await worker.fetch("/api/v1/records", { method: "POST", body: "{}" });
    assert.deepEqual([res.status, await res.json()], [400, { error: "malformed" }]);
    // Resumed: the same challenge, submitted six times while stopped, was not counted (at most 5 submissions).
    await pause("false");
    assert.equal((await config()).paused, false);
    await mustSubmit(worker, before, "threads first");
    assert.equal(await count(), 2);
  });

  test("true: the visitors' pages, card-state and the fingerprint answer as ever, and the proof log is published when the date changes", async () => {
    name = await freshProofLog(worker);
    const root = await publishG3(worker);
    const card = newCard();
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    await pause("true");
    for (const path of ["/", "/faq", "/proof-log", "/threads/@alice"]) assert.equal((await worker.fetch(path)).status, 200, path);
    const state = await cardState(worker, card);
    assert.equal(state.count, 1);
    // The next day: the object's alarm publishes the day before, stopped or not.
    await day(worker, 1);
    await worker.proofLog.runAlarm();
    const fp = (await (await worker.fetch("/api/v1/fingerprint")).json()) as { date: string | null; count: number };
    assert.deepEqual([fp.date, fp.count], ["2026-11-21", 1], "the line written on the new date, with the one record");
    assert.ok((await worker.files()).some((f) => f.key.startsWith("proof-log/") && f.key.endsWith(".jsonl")), "the log file was written");
    await pause("false");
  });

  test("a value that is neither true nor false: nothing of the API answers but 500", async () => {
    name = await freshProofLog(worker);
    await pause("yes");
    for (const [method, path] of [["POST", "/api/v1/challenges"], ["GET", "/api/v1/config"], ["POST", "/api/v1/records"]] as const) assert.equal((await worker.fetch(path, { method })).status, 500, path);
    await pause("false");
  });
});
