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

describe("an object that has nothing", () => {
  /** The settings name another object, new and empty, and the bucket stays as it is: the object's storage is gone, or the proof log was moved (ADR-0033). */
  let objects = 0;
  const emptyObject = (): Promise<void> => worker.switchProofLog({ PROOF_LOG_KIND: "test", PROOF_LOG_OBJECT_NAME: `test-rebuilt-${++objects}` });

  test("rebuilt from the data bucket alone, it is the object that published it: the states, the views, the count and the fingerprint, the records of the last file, the full files, the published lines; it then takes records and publishes the next date", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    const cards = await fillTo(root, LINES_PER_FILE + 3);
    // A refresh and a switch among them, so that the states are not all alike.
    await midnight("2026-11-21");
    await day(worker, 1);
    await mustSubmit(worker, await sub(worker, cards[0]!, root, "threads:alice"), "threads refresh");
    await mustSubmit(worker, await sub(worker, cards[1]!, root, "threads:bob"), "threads switch");
    await midnight("2026-11-22");
    await day(worker, 2);
    const some = [cards[0]!, cards[1]!, cards[999]!, cards.at(-1)!];
    const before = await computed(some);
    const stored = await worker.proofLog.stored();
    const kept = await worker.proofLog.kept();
    const published = await (await worker.fetch("/api/v1/fingerprint")).json();
    assert.equal(stored.proofLog.count, LINES_PER_FILE + 5);

    await emptyObject();
    assert.equal((await worker.proofLog.stored()).proofLog.count, 0, "the new object has no record");
    assert.equal(await worker.proofLog.beginRebuild("from-bucket"), true);
    assert.deepEqual(await rebuildToItsEnd(), { steps: 2, status: "swapped", reason: null, records: LINES_PER_FILE + 5 });
    assert.deepEqual(await computed(some), before);
    assert.deepEqual(await worker.proofLog.stored(), stored);
    assert.deepEqual(await worker.proofLog.kept(), kept);
    assert.deepEqual(await (await worker.fetch("/api/v1/fingerprint")).json(), published);
    assert.deepEqual(await stagedTables(), []);
    await checkProofLog(worker);
    // Which CRLs are the newest is not computed from the proof log: the new object learns it from the mirror's next round, and takes no record before.
    await wantError(worker, await sub(worker, cards[2]!, root, "threads:alice"), 503, "crl_stale");
    // (The round ends as failed here, the fake MOICA having no CRL of the other issuer key; it has told the object by then, as in `publishCrl`.)
    await worker.runSchedule();
    // It goes on as the proof log's object: a record, and the next date's line after the two it found.
    await mustSubmit(worker, await sub(worker, cards[2]!, root, "threads:alice"), "threads refresh");
    await midnight("2026-11-23");
    const lines = new TextDecoder().decode((await worker.files("proof-log/")).find((f) => f.key === "proof-log/fingerprints.jsonl")!.bytes).split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 3);
    assert.equal((JSON.parse(lines[2]!) as { count: number }).count, LINES_PER_FILE + 6);
  });

  test("a log file of the bucket that is not the proof log of the fingerprint file's last line: refused with the reason, and the object stays empty", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    await fillTo(root, 6);
    await midnight("2026-11-21");
    const key = `proof-log/${proofLogFileName(0)}`;
    const file = (await worker.files("proof-log/")).find((f) => f.key === key)!;
    const lines = new TextDecoder().decode(file.bytes).split("\n").filter((l) => l !== "");
    // The file without its last record: every line is a record, and it is not the six records the line of the fingerprint file is of.
    await worker.putFile(key, `${lines.slice(0, 5).join("\n")}\n`, file.cacheControl, file.contentType);
    await emptyObject();
    assert.equal(await worker.proofLog.beginRebuild("short"), true);
    let ended = await rebuildToItsEnd();
    assert.equal(ended.status, "refused");
    assert.match(ended.reason ?? "", /has 5 records, fewer than the 6 of the last line of the fingerprint file/);
    assert.equal((await worker.proofLog.stored()).proofLog.count, 0);
    // Two records in the other order: six well-formed lines, but record 5 is not at its place.
    await worker.putFile(key, `${[...lines.slice(0, 4), lines[5], lines[4]].join("\n")}\n`, file.cacheControl, file.contentType);
    assert.equal(await worker.proofLog.beginRebuild("swapped-lines"), true);
    ended = await rebuildToItsEnd();
    assert.equal(ended.status, "refused");
    assert.match(ended.reason ?? "", /record 5 is not a well-formed line of the proof log/);
    assert.equal((await worker.proofLog.stored()).proofLog.count, 0);
    assert.deepEqual(await stagedTables(), []);
    // With the file as it was published, the object is rebuilt.
    await worker.putFile(key, file.bytes, file.cacheControl, file.contentType);
    assert.equal(await worker.proofLog.beginRebuild("as-published"), true);
    assert.deepEqual(await rebuildToItsEnd(), { steps: 1, status: "swapped", reason: null, records: 6 });
  });
});

describe("after the swap", () => {
  test("the card state file of the last published date is written again from the states at that line's count, also when a row was wrong when it was first written and records came after the line", async () => {
    const { cards } = await smallProofLog();
    const key = "proof-log/card-state/2026-11-21.jsonl";
    const published = (await worker.files("proof-log/")).find((f) => f.key === key)!;
    // The file in the bucket is changed behind the object's back: the rebuild writes the one of the line again.
    await worker.putFile(key, "not the card state file\n", published.cacheControl, published.contentType);
    await worker.proofLog.breakCard(cards[0]!);
    assert.equal(await worker.proofLog.beginRebuild("card-state-file"), true);
    assert.equal((await rebuildToItsEnd()).status, "swapped");
    const again = (await worker.files("proof-log/")).find((f) => f.key === key)!;
    // The states after the line's 2 records, not after all 6: two cards, as first published.
    assert.deepEqual(new TextDecoder().decode(again.bytes), new TextDecoder().decode(published.bytes));
    assert.equal(new TextDecoder().decode(again.bytes).split("\n").filter((l) => l !== "").length, 2);
    assert.deepEqual((await worker.proofLog.tables()).filter((name) => name.startsWith("rebuilt_") || name === "cards_copy"), []);
  });

  test("a proof log paused because its states were computed by another version of the record rules takes card proofs again once it is rebuilt", async () => {
    const { root, cards } = await smallProofLog();
    const before = await computed(cards);
    await worker.proofLog.setStoredRulesVersion("another");
    await worker.proofLog.restart();
    assert.equal((await worker.fetch("/api/v1/challenges", { method: "POST" })).status, 503);
    assert.equal(await worker.proofLog.beginRebuild("new-rules"), true);
    assert.equal((await rebuildToItsEnd()).status, "swapped");
    assert.deepEqual(await computed(cards), before);
    await mustSubmit(worker, await sub(worker, cards[0]!, root, "threads:alice"), "threads refresh");
    // And it stays so when the object starts again: the version it stores is the build's.
    await worker.proofLog.restart();
    assert.equal((await worker.fetch("/api/v1/challenges", { method: "POST" })).status, 200);
  });
});
