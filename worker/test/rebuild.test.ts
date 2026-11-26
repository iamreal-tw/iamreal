// Rebuilding from the proof log (src/rebuild.ts; ADR-0033, "從證明紀錄重建"),
// seen through the Worker's HTTP and the test build's reading of the object
// (test/harness.ts): what the object computes again from the records is what
// it had; a row of the card states that was wrong is right again; the result
// is put in place only if it is the proof log of the last published line; a
// rebuild that breaks off leaves everything as it was and goes on later; an
// object that has nothing reads the proof log from the data bucket.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LINES_PER_FILE, proofLogFileName } from "iamreal-protocol/record.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { type Submission, cardState, checkProofLog, day, freshProofLog, mustSubmit, newCard, publishG3, sub, submit, tw, wantError } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

/** The date changes in Taiwan, and the object's alarm rings ten seconds into it: the proof log is published. */
async function midnight(date: string): Promise<void> {
  await worker.setClock(tw(date, "00:00:10"));
  await worker.proofLog.runAlarm();
}

/** Writes records until the proof log has `upTo`: each a first card proof of a new card that declares `@alice`, 20 at a time. Returns the cards. */
async function fillTo(root: string, upTo: number): Promise<string[]> {
  const cards: string[] = [];
  for (let count = (await cardState(worker, newCard())).count as number; count < upTo; ) {
    const submissions: Submission[] = [];
    for (let i = 0; i < Math.min(20, upTo - count); i++) submissions.push(await sub(worker, newCard(), root, "threads:alice"));
    for (const answer of await Promise.all(submissions.map((s) => submit(worker, s)))) assert.equal(answer.status, 201, JSON.stringify(answer.body));
    cards.push(...submissions.map((s) => s.scoped_id));
    count += submissions.length;
  }
  return cards;
}

/** Everything a rebuild computes, as the object has it now: the views, the proof log's row, and the states of these cards. */
async function computed(cards: readonly string[]): Promise<unknown> {
  const states: unknown[] = [];
  for (const card of cards) states.push(await cardState(worker, card));
  return { views: await worker.proofLog.views(), proofLog: (await worker.proofLog.stored()).proofLog, states };
}

/** Runs the alarm until the rebuild is no longer running; returns how many steps it took and how it ended. */
async function rebuildToItsEnd(): Promise<{ steps: number; status: string; reason: string | null; records: number }> {
  for (let steps = 1; steps <= 20; steps++) {
    await worker.proofLog.runAlarm();
    const now = (await worker.proofLog.rebuildStatus())!;
    if (now.status !== "running") return { steps, status: now.status, reason: now.reason, records: now.records };
  }
  throw new Error(`the rebuild is still running after 20 steps: ${worker.logLines().filter((l) => l.includes("rebuild")).slice(-3).join(" | ")}`);
}

const stagedTables = async (): Promise<string[]> => (await worker.proofLog.tables()).filter((name) => name.startsWith("rebuild_") && name !== "rebuild_state");

/** A proof log of a few cards over two dates, published once: first card proofs, a refresh, a switch, a withdrawal, and records after the published line. */
async function smallProofLog(): Promise<{ root: string; cards: string[]; last: Submission }> {
  await freshProofLog(worker);
  const root = await publishG3(worker);
  const [a, b, c] = [newCard(), newCard(), newCard()];
  await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads first");
  await mustSubmit(worker, await sub(worker, b, root, "threads:bob"), "threads first");
  await midnight("2026-11-21");
  await day(worker, 1);
  await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads refresh");
  await mustSubmit(worker, await sub(worker, b, root, "threads:carol"), "threads switch");
  await mustSubmit(worker, await sub(worker, c, root, "threads:dave"), "threads first");
  const last = await sub(worker, c, root);
  await mustSubmit(worker, last, "threads withdraw");
  return { root, cards: [a!, b!, c!], last };
}

describe("a proof log the object keeps whole", () => {
  test("rebuilt, everything computed from the records is what it was; the staged tables are gone; a challenge that was used is still refused as used", async () => {
    const { cards, last } = await smallProofLog();
    const before = await computed(cards);
    assert.equal(await worker.proofLog.rebuildStatus(), null, "no rebuild yet");
    assert.equal(await worker.proofLog.beginRebuild("first"), true);
    assert.deepEqual(await worker.proofLog.rebuildStatus(), { token: "first", status: "running", records: 0, reason: null });
    assert.deepEqual(await rebuildToItsEnd(), { steps: 1, status: "swapped", reason: null, records: 6 });
    assert.deepEqual(await computed(cards), before);
    assert.deepEqual(await stagedTables(), []);
    await checkProofLog(worker);
    // The challenge of the last record was used: submitted again, it is refused as used, as before the rebuild.
    await wantError(worker, last, 400, "challenge_used");
    // The same name again begins nothing; another name does.
    assert.equal(await worker.proofLog.beginRebuild("first"), false);
    assert.equal(await worker.proofLog.beginRebuild("second"), true);
    assert.equal((await rebuildToItsEnd()).status, "swapped");
    assert.deepEqual(await computed(cards), before);
  });

  test("a row of the card states that is wrong is right again after the rebuild, and so is a view that was changed", async () => {
    const { root, cards } = await smallProofLog();
    const before = await computed(cards);
    await worker.proofLog.breakCard(cards[1]!);
    // The broken row is not a state: the back end fails for that card.
    assert.equal((await worker.fetch("/api/v1/card-state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope_string: "iamreal-test:public:0__________", scoped_id: cards[1] }) })).status, 500);
    assert.equal(await worker.proofLog.beginRebuild("mend"), true);
    assert.equal((await rebuildToItsEnd()).status, "swapped");
    assert.deepEqual(await computed(cards), before);
    // And the proof log goes on from the rebuilt state: the card that was broken makes its next card proof.
    await mustSubmit(worker, await sub(worker, cards[1]!, root, "threads:carol"), "threads refresh");
  });

  test("while a rebuild runs no challenge is issued and no record taken; the pages and card-state answer from the tables as they were", async () => {
    const { root, cards } = await smallProofLog();
    const waiting = await sub(worker, newCard(), root, "threads:erin");
    const before = await computed(cards);
    assert.equal(await worker.proofLog.beginRebuild("busy"), true);
    assert.equal((await worker.fetch("/api/v1/challenges", { method: "POST" })).status, 503);
    await wantError(worker, waiting, 503, "paused");
    assert.deepEqual(await computed(cards), before);
    assert.equal((await worker.fetch(`/p/${cards[0]!.slice(0, 10)}`)).status, 200);
    assert.equal((await rebuildToItsEnd()).status, "swapped");
    // Challenges from before the rebuild are gone (ADR-0033): the holder asks for another.
    await wantError(worker, waiting, 400, "challenge_unknown");
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:erin"), "threads first");
  });
});

describe("a proof log with full files in the data bucket", () => {
  test("crossing 1,000 records and a date: a step for the file and a step for the records the object keeps; broken off between them, everything is as it was and the pages answer; the next alarm goes on, also after the object started again; a row that was wrong is right again", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    const cards = await fillTo(root, 990);
    await midnight("2026-11-21");
    await day(worker, 1);
    cards.push(...(await fillTo(root, LINES_PER_FILE + 5)));
    // The full file is moved to the bucket by the alarm; the object keeps the five records after it.
    await worker.proofLog.runAlarm();
    assert.deepEqual(await worker.proofLog.kept(), { count: 5, first: LINES_PER_FILE + 1, last: LINES_PER_FILE + 5 });
    const some = [cards[0]!, cards[500]!, cards[989]!, cards[990]!, cards.at(-1)!];
    const before = await computed(some);
    await worker.proofLog.breakCard(cards[500]!);

    assert.equal(await worker.proofLog.beginRebuild("two-steps"), true);
    await worker.proofLog.runAlarm();
    assert.deepEqual(await worker.proofLog.rebuildStatus(), { token: "two-steps", status: "running", records: LINES_PER_FILE, reason: null });
    // Broken off here: the object is stopped. What it answers from has not changed (the broken row is still broken), and the pages answer.
    await worker.proofLog.restart();
    assert.equal((await worker.fetch(`/p/${cards[0]!.slice(0, 10)}`)).status, 200);
    assert.deepEqual((await worker.proofLog.stored()).proofLog, (before as { proofLog: unknown }).proofLog);
    assert.deepEqual(await worker.proofLog.rebuildStatus(), { token: "two-steps", status: "running", records: LINES_PER_FILE, reason: null });
    assert.deepEqual(await rebuildToItsEnd(), { steps: 1, status: "swapped", reason: null, records: LINES_PER_FILE + 5 });
    assert.deepEqual(await computed(some), before);
    assert.deepEqual(await stagedTables(), []);
    await checkProofLog(worker);
  });

  test("a full file of the bucket that was changed: the rebuild is refused with the file's name, and nothing changes; with the file as it was, another rebuild is made", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    const cards = await fillTo(root, LINES_PER_FILE + 2);
    await worker.proofLog.runAlarm();
    const some = [cards[0]!, cards[999]!, cards.at(-1)!];
    const before = await computed(some);
    const key = `proof-log/${proofLogFileName(0)}`;
    const file = (await worker.files("proof-log/")).find((f) => f.key === key)!;
    const changed = new Uint8Array(file.bytes);
    // One digit of the first record's proof.
    changed[changed.length - 20] = changed[changed.length - 20] === 0x41 ? 0x42 : 0x41;
    await worker.putFile(key, changed, file.cacheControl, file.contentType);
    assert.equal(await worker.proofLog.beginRebuild("changed-file"), true);
    const ended = await rebuildToItsEnd();
    assert.equal(ended.status, "refused");
    assert.ok(ended.reason?.includes(key), ended.reason ?? "");
    assert.deepEqual(await computed(some), before);
    assert.deepEqual(await stagedTables(), []);
    // No challenge is held back by a rebuild that is over.
    assert.equal((await worker.fetch("/api/v1/challenges", { method: "POST" })).status, 200);
    await worker.putFile(key, file.bytes, file.cacheControl, file.contentType);
    assert.equal(await worker.proofLog.beginRebuild("file-back"), true);
    assert.equal((await rebuildToItsEnd()).status, "swapped");
    assert.deepEqual(await computed(some), before);
  });
});
