// The roster is published once a day (ADR-0027; spec/record.md, "The
// published roster"), seen through the Worker's HTTP and the files of the
// simulated R2 bucket (test/harness.ts): at the first alarm after the date
// changes in Taiwan, the last roster file and its record hash list, the
// card state file of the date, and then one more line of the fingerprint
// file; `GET /api/v1/fingerprint` answers the last line published.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { readCardStateFile } from "iamreal-protocol/card-state-file.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import { EMPTY_FINGERPRINT, fingerprintLine, hashList, hashListName, rosterFileName } from "iamreal-protocol/record.ts";
import { type StoredFile, type TestWorker, startWorker } from "./harness.ts";
import { HASH_LIST_TYPE, ROSTER_FILE_TYPE, TEST_SCOPE, cardState, checkRoster, day, freshRoster, mustSubmit, newCard, publishG3, sub, tw } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

/** The `Cache-Control` of everything the daily publication writes (ADR-0027). */
const MINUTE = "public, max-age=60";
const FINGERPRINTS = "fingerprints.jsonl";
const text = (file: StoredFile): string => new TextDecoder().decode(file.bytes);

/** The files of the roster directory in the bucket, by their path in the directory. */
async function directory(): Promise<Map<string, StoredFile>> {
  return new Map((await worker.files("roster/")).map((f) => [f.key.slice("roster/".length), f]));
}

/** What `GET /api/v1/fingerprint` answers. */
async function published(): Promise<unknown> {
  const res = await worker.fetch("/api/v1/fingerprint");
  assert.deepEqual([res.status, res.headers.get("cache-control")], [200, "no-store"]);
  return JSON.parse(await res.text());
}

/** The clock shows `time` of `date` in Taiwan, and the object's alarm rings. */
async function alarmAt(date: string, time: string): Promise<void> {
  await worker.setClock(tw(date, time));
  await worker.roster.runAlarm();
}

/** A line of the fingerprint file. */
const line = (date: string, count: number, fingerprint: string): string => fingerprintLine({ date: parseDay(date)!, count, fingerprint });

describe("a roster without a record", () => {
  test("is published when the date changes: a line of 0 records and 64 zeros, and an empty card state file", async () => {
    await freshRoster(worker);
    // The roster's object starts on 2026-11-20, at noon.
    assert.equal((await cardState(worker, newCard())).count, 0);
    assert.deepEqual(await published(), { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT });

    // Nothing is published on the day the object first runs, whenever its alarm rings.
    await alarmAt("2026-11-20", "23:59:59");
    assert.deepEqual([...(await directory()).keys()], []);
    assert.deepEqual(await published(), { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT });

    // Midnight in Taiwan: no roster file (there is no empty one), the card state file of the date, the line.
    await alarmAt("2026-11-21", "00:00:00");
    const first = await directory();
    assert.deepEqual([...first.keys()], ["card-state/2026-11-21.jsonl", FINGERPRINTS]);
    assert.equal(first.get("card-state/2026-11-21.jsonl")!.bytes.length, 0);
    assert.equal(text(first.get(FINGERPRINTS)!), line("2026-11-21", 0, EMPTY_FINGERPRINT));
    for (const file of first.values()) assert.deepEqual([file.cacheControl, file.contentType], [MINUTE, ROSTER_FILE_TYPE], file.key);
    assert.deepEqual(await published(), { date: "2026-11-21", count: 0, fingerprint: EMPTY_FINGERPRINT });

    // The same date again: nothing is written.
    await alarmAt("2026-11-21", "13:00:00");
    assert.deepEqual(await directory(), first);

    // The next date: one more line, one more card state file; the earlier ones are as they were.
    await alarmAt("2026-11-22", "00:00:01");
    const second = await directory();
    assert.deepEqual([...second.keys()], ["card-state/2026-11-21.jsonl", "card-state/2026-11-22.jsonl", FINGERPRINTS]);
    assert.deepEqual(second.get("card-state/2026-11-21.jsonl"), first.get("card-state/2026-11-21.jsonl"));
    assert.equal(text(second.get(FINGERPRINTS)!), line("2026-11-21", 0, EMPTY_FINGERPRINT) + line("2026-11-22", 0, EMPTY_FINGERPRINT));
    assert.deepEqual(await published(), { date: "2026-11-22", count: 0, fingerprint: EMPTY_FINGERPRINT });
  });
});

/** What `card-state` answers for a card, as the row of the card state file it must be (the slots that are not unused). */
async function rowOf(scopedId: string, lastSeq: number): Promise<unknown> {
  const state = (await cardState(worker, scopedId)) as { last_card_proof: string; proofs_on_last_date: number; platforms: Record<string, { current: string | null; last_declared: string | null; switch_count: number; correction_date: string | null }> };
  const slots: Record<string, unknown> = {};
  for (const platform of Object.keys(state.platforms).sort()) {
    const slot = state.platforms[platform]!;
    if (slot.current !== null || slot.last_declared !== null || slot.switch_count !== 0 || slot.correction_date !== null) slots[platform] = slot;
  }
  return { scope_string: TEST_SCOPE, scoped_id: scopedId, last_seq: lastSeq, last_card_proof: state.last_card_proof, proofs_on_last_date: state.proofs_on_last_date, slots };
}

/** The rows of a card state file as JSON, after it is checked to be a valid file of the test roster. */
function rowsOf(file: StoredFile): unknown[] {
  assert.equal(readCardStateFile("test", file.bytes).valid, true, "the card state file is valid");
  return text(file).split("\n").slice(0, -1).map((row) => JSON.parse(row) as unknown);
}

const byScopedId = (cards: readonly string[]): string[] => [...cards].sort((a, b) => (a < b ? -1 : 1));
const notPublished = (): number => worker.logLines().filter((l) => l.includes('"roster_not_published"')).length;

describe("a roster with records", () => {
  test("each date: the last file and its list as they are at that moment, the state of every card, then the line", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const [a, b, c] = [newCard(), newCard(), newCard()];
    await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads first");
    await mustSubmit(worker, await sub(worker, b, root, "test-example:bob-example", "threads:bob"), "test-example first, threads first");
    await mustSubmit(worker, await sub(worker, a, root, "threads:carol"), "threads correction");
    const day1 = await worker.roster.stored();
    assert.deepEqual([...(await directory()).keys()], [], "nothing is published before the date changes");

    await alarmAt("2026-11-21", "00:00:00");
    let files = await directory();
    assert.deepEqual([...files.keys()], [rosterFileName(0), "card-state/2026-11-21.jsonl", FINGERPRINTS, hashListName(0)]);
    assert.equal(text(files.get(rosterFileName(0))!), day1.records.map((row) => row.line).join(""));
    assert.equal(text(files.get(hashListName(0))!), hashList(EMPTY_FINGERPRINT, day1.records.map((row) => row.record_hash)));
    assert.equal(text(files.get(FINGERPRINTS)!), line("2026-11-21", 3, day1.roster.fingerprint));
    assert.deepEqual(rowsOf(files.get("card-state/2026-11-21.jsonl")!), await Promise.all(byScopedId([a, b]).map((card) => rowOf(card, card === a ? 3 : 2))));
    for (const file of files.values()) assert.deepEqual([file.cacheControl, file.contentType], [MINUTE, file.key.endsWith(".txt") ? HASH_LIST_TYPE : ROSTER_FILE_TYPE], file.key);
    assert.deepEqual(await published(), { date: "2026-11-21", count: 3, fingerprint: day1.roster.fingerprint });

    // Records of the new date are in the roster, and in nothing that is published, until the date changes again.
    await day(worker, 1);
    await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads switch");
    await mustSubmit(worker, await sub(worker, c, root, "threads:alice"), "threads first");
    await mustSubmit(worker, await sub(worker, b, root, "test-example:bob-example"), "test-example refresh, threads withdraw");
    await worker.roster.runAlarm();
    assert.deepEqual(await directory(), files);
    assert.deepEqual(await published(), { date: "2026-11-21", count: 3, fingerprint: day1.roster.fingerprint });
    const day2 = await worker.roster.stored();

    await alarmAt("2026-11-22", "00:00:05");
    const earlier = files;
    files = await directory();
    assert.deepEqual([...files.keys()], [rosterFileName(0), "card-state/2026-11-21.jsonl", "card-state/2026-11-22.jsonl", FINGERPRINTS, hashListName(0)]);
    assert.equal(text(files.get(rosterFileName(0))!), day2.records.map((row) => row.line).join(""));
    assert.equal(text(files.get(hashListName(0))!), hashList(EMPTY_FINGERPRINT, day2.records.map((row) => row.record_hash)));
    assert.equal(text(files.get(FINGERPRINTS)!), line("2026-11-21", 3, day1.roster.fingerprint) + line("2026-11-22", 6, day2.roster.fingerprint));
    assert.deepEqual(rowsOf(files.get("card-state/2026-11-22.jsonl")!), await Promise.all(byScopedId([a, b, c]).map((card) => rowOf(card, card === a ? 4 : card === c ? 5 : 6))));
    assert.deepEqual(files.get("card-state/2026-11-21.jsonl"), earlier.get("card-state/2026-11-21.jsonl"), "the card state file of the day before stays");
    for (const file of files.values()) assert.deepEqual([file.cacheControl, file.contentType], [MINUTE, file.key.endsWith(".txt") ? HASH_LIST_TYPE : ROSTER_FILE_TYPE], file.key);

    // A date without a new record: the same count and fingerprint under the new date, and the states again.
    await alarmAt("2026-11-23", "08:00:00");
    const still = await directory();
    assert.equal(text(still.get(FINGERPRINTS)!), text(files.get(FINGERPRINTS)!) + line("2026-11-23", 6, day2.roster.fingerprint));
    assert.equal(text(still.get("card-state/2026-11-23.jsonl")!), text(files.get("card-state/2026-11-22.jsonl")!));
    assert.equal(text(still.get(rosterFileName(0))!), text(files.get(rosterFileName(0))!));

    // A date on which the alarm did not ring gets no line afterwards: the next line is dated the day it is written.
    await alarmAt("2026-11-26", "03:00:00");
    assert.equal(text((await directory()).get(FINGERPRINTS)!), text(still.get(FINGERPRINTS)!) + line("2026-11-26", 6, day2.roster.fingerprint));
    assert.deepEqual(await published(), { date: "2026-11-26", count: 6, fingerprint: day2.roster.fingerprint });
    assert.equal((await checkRoster(worker)).length, 6);
    assert.equal(notPublished(), 0);
  });

  test("everything published is of one moment: a record written while the bucket is being written is in none of it", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const [a, late] = [newCard(), newCard()];
    await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads first");
    const moment = await worker.roster.stored();
    // A challenge taken a minute before midnight: its record is dated the day before, and written after it.
    await worker.setClock(tw("2026-11-20", "23:59:00"));
    const submission = await sub(worker, late, root, "threads:alice");

    // The first write of the publication takes a while, and a record is written meanwhile.
    await worker.roster.setBucketFault({ key: `roster/${rosterFileName(0)}`, how: "put takes a while" });
    await worker.setClock(tw("2026-11-21", "00:00:00"));
    const publishing = worker.roster.runAlarm();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual([...(await directory()).keys()], [], "the publication is still writing its first file");
    // The record's challenge is of the day before, which the roster takes.
    assert.equal((await mustSubmit(worker, submission, "threads first")).seq, 2);
    await publishing;
    await worker.roster.setBucketFault(null);

    const files = await directory();
    assert.equal(text(files.get(FINGERPRINTS)!), line("2026-11-21", 1, moment.roster.fingerprint));
    assert.equal(text(files.get(rosterFileName(0))!), moment.records[0]!.line);
    assert.equal(text(files.get(hashListName(0))!), hashList(EMPTY_FINGERPRINT, [moment.records[0]!.record_hash]));
    assert.deepEqual(rowsOf(files.get("card-state/2026-11-21.jsonl")!), [await rowOf(a, 1)]);
    assert.equal((await checkRoster(worker)).length, 2);
  });
});

describe("the card state file is written from a copy of the card state table", () => {
  test("records written while it is written, one to a card in it and one of a new card, are in none of it; the copy is gone afterwards", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const [a, b, late] = [newCard(), newCard(), newCard()];
    await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads first");
    await mustSubmit(worker, await sub(worker, b, root, "threads:bob"), "threads first");
    const moment = await worker.roster.stored();
    const rows = await Promise.all(byScopedId([a, b]).map((card) => rowOf(card, card === a ? 1 : 2)));
    const tables = await worker.roster.tables();

    await worker.setClock(tw("2026-11-21", "00:00:00"));
    const [change, first] = [await sub(worker, a, root, "threads:carol"), await sub(worker, late, root, "threads:dave")];
    await worker.roster.setBucketFault({ key: "roster/card-state/2026-11-21.jsonl", how: "put takes a while" });
    const publishing = worker.roster.runAlarm();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual([...(await directory()).keys()], [rosterFileName(0), hashListName(0)], "the publication is writing the card state file");
    assert.equal((await mustSubmit(worker, change, "threads switch")).seq, 3);
    assert.equal((await mustSubmit(worker, first, "threads first")).seq, 4);
    await publishing;
    await worker.roster.setBucketFault(null);

    const files = await directory();
    assert.deepEqual(rowsOf(files.get("card-state/2026-11-21.jsonl")!), rows);
    assert.equal(text(files.get(FINGERPRINTS)!), line("2026-11-21", 2, moment.roster.fingerprint));
    assert.deepEqual(await worker.roster.tables(), tables);
    assert.equal((await checkRoster(worker)).length, 4);
  });

  test("a row of the table not in the format of a row: nothing of the card state file is written, and no line; once the row is mended, the roster is published", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const a = newCard();
    await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads first");
    const tables = await worker.roster.tables();
    const card = { scope_string: TEST_SCOPE, scoped_id: newCard(), last_card_proof: "2026-11-20", proofs_on_last_date: 1, platforms: {} };
    await worker.roster.writeCard({ ...card, seq: 0 });
    const failures = notPublished();

    await alarmAt("2026-11-21", "00:00:00");
    assert.deepEqual([...(await directory()).keys()], [rosterFileName(0), hashListName(0)]);
    assert.equal(notPublished(), failures + 1);
    assert.deepEqual(await worker.roster.tables(), tables);

    await worker.roster.writeCard({ ...card, seq: 1 });
    await alarmAt("2026-11-21", "00:01:00");
    const files = await directory();
    assert.equal(rowsOf(files.get("card-state/2026-11-21.jsonl")!).length, 2);
    assert.equal(text(files.get(FINGERPRINTS)!).split("\n").length, 2);
  });
});

describe("a publication that cannot be finished", () => {
  /** Each try is one alarm, a minute of the object's clock after the one before. */
  let time = 0;
  const tryAgain = async (): Promise<void> => {
    time += 60 * 1000;
    await worker.setClock(new Date(time));
    await worker.roster.runAlarm();
  };

  test("no line without the files before it; made again later, all of it and from a new moment", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const a = newCard();
    await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads first");
    await worker.setClock(tw("2026-11-20", "23:59:00"));
    const next = await sub(worker, newCard(), root, "threads:alice");
    const failures = notPublished();
    const nothing = { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT };
    time = tw("2026-11-21", "00:00:00").getTime();
    await worker.setClock(new Date(time));

    // The last roster file cannot be written: nothing of the date is published.
    await worker.roster.setBucketFault({ key: `roster/${rosterFileName(0)}`, how: "put fails" });
    await worker.roster.runAlarm();
    assert.deepEqual([...(await directory()).keys()], []);
    assert.equal(notPublished(), failures + 1, "one line says that the roster was not published");
    // The next try is a minute later, not at the next alarm; a piece of timed work after this one runs all the same.
    await worker.roster.setExtraWork(new Date(time), 24 * 3600 * 1000);
    await worker.roster.runAlarm();
    assert.equal(notPublished(), failures + 1);
    assert.deepEqual(await worker.roster.extraWorkRuns(), [new Date(time)]);

    // Its record hash list cannot be written, then the card state file: the files before are there, and no line.
    await worker.roster.setBucketFault({ key: `roster/${hashListName(0)}`, how: "put fails" });
    await tryAgain();
    assert.deepEqual([...(await directory()).keys()], [rosterFileName(0)]);
    await worker.roster.setBucketFault({ key: "roster/card-state/2026-11-21.jsonl", how: "put writes other bytes" });
    await mustSubmit(worker, next, "threads first");
    const moment = await worker.roster.stored();
    await tryAgain();
    assert.deepEqual([...(await directory()).keys()], [rosterFileName(0), "card-state/2026-11-21.jsonl", hashListName(0)]);
    assert.deepEqual(await published(), nothing);
    assert.equal(notPublished(), failures + 3);

    // Once the bucket takes everything: all of it again, as the roster is now, and the line.
    await worker.roster.setBucketFault(null);
    await tryAgain();
    const files = await directory();
    assert.deepEqual([...files.keys()], [rosterFileName(0), "card-state/2026-11-21.jsonl", FINGERPRINTS, hashListName(0)]);
    assert.equal(text(files.get(rosterFileName(0))!), moment.records.map((row) => row.line).join(""));
    assert.equal(text(files.get(hashListName(0))!), hashList(EMPTY_FINGERPRINT, moment.records.map((row) => row.record_hash)));
    assert.equal(rowsOf(files.get("card-state/2026-11-21.jsonl")!).length, 2);
    assert.equal(text(files.get(FINGERPRINTS)!), line("2026-11-21", 2, moment.roster.fingerprint));
    assert.deepEqual(await published(), { date: "2026-11-21", count: 2, fingerprint: moment.roster.fingerprint });
    assert.equal(notPublished(), failures + 3);
  });

  test("the card state file breaks off while it is written: no line, no copy of the card state table kept; the next try is of its own moment", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    const tables = await worker.roster.tables();
    time = tw("2026-11-21", "00:00:00").getTime();
    await worker.setClock(new Date(time));

    await worker.roster.setBucketFault({ key: "roster/card-state/2026-11-21.jsonl", how: "put breaks off" });
    await worker.roster.runAlarm();
    assert.deepEqual([...(await directory()).keys()], [rosterFileName(0), hashListName(0)]);
    assert.deepEqual(await worker.roster.tables(), tables);

    await worker.roster.setBucketFault(null);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    const moment = await worker.roster.stored();
    await tryAgain();
    const files = await directory();
    assert.equal(rowsOf(files.get("card-state/2026-11-21.jsonl")!).length, 2);
    assert.equal(text(files.get(FINGERPRINTS)!), line("2026-11-21", 2, moment.roster.fingerprint));
    assert.deepEqual(await worker.roster.tables(), tables);
  });

  test("the line of a date is decided once: a fingerprint file that could not be written is written later with that line, whatever was recorded since", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    const moment = await worker.roster.stored();
    await worker.setClock(tw("2026-11-20", "23:59:00"));
    const next = await sub(worker, newCard(), root, "threads:alice");
    const failures = notPublished();
    time = tw("2026-11-21", "00:00:00").getTime();
    await worker.setClock(new Date(time));

    // Everything but the fingerprint file is written: that one cannot be written, and the object starts again.
    await worker.roster.setBucketFault({ key: `roster/${FINGERPRINTS}`, how: "put fails" });
    await worker.roster.runAlarm();
    const before = await directory();
    assert.deepEqual([...before.keys()], [rosterFileName(0), "card-state/2026-11-21.jsonl", hashListName(0)]);
    assert.deepEqual(await published(), { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT }, "a line that is not in the bucket's file is not answered as published");
    assert.equal(notPublished(), failures + 1);
    await mustSubmit(worker, next, "threads first");
    await worker.roster.restart();
    await worker.setClock(new Date(time));

    // The next try writes the fingerprint file alone: the line is that of the moment the files are of.
    await tryAgain();
    const files = await directory();
    assert.equal(text(files.get(FINGERPRINTS)!), line("2026-11-21", 1, moment.roster.fingerprint));
    for (const name of before.keys()) assert.deepEqual(files.get(name), before.get(name), `${name} is not written again`);
    assert.deepEqual(await published(), { date: "2026-11-21", count: 1, fingerprint: moment.roster.fingerprint });
  });

  test("the bucket's fingerprint file is never made shorter or changed: lines that are missing are written again, and a file with a line the object does not have stops the publication", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    await alarmAt("2026-11-21", "00:00:00");
    await alarmAt("2026-11-22", "00:00:00");
    const two = text((await directory()).get(FINGERPRINTS)!);
    const [first, second] = [two.slice(0, two.indexOf("\n") + 1), two.slice(two.indexOf("\n") + 1)];
    assert.deepEqual([first, second].map((l) => JSON.parse(l).date), ["2026-11-21", "2026-11-22"]);
    const differs = (): number => worker.logLines().filter((l) => l === JSON.stringify({ event: "fingerprint_file_differs", error: "Error" })).length;
    assert.equal(differs(), 0);

    // The file is gone, then it lacks its last line, then it ends in the middle of one: each is the beginning of what
    // the object keeps, and the next date's publication writes every line.
    let date = 22;
    const spoils = [() => worker.deleteFile(`roster/${FINGERPRINTS}`), () => worker.putFile(`roster/${FINGERPRINTS}`, first), () => worker.putFile(`roster/${FINGERPRINTS}`, two.slice(0, -40))];
    let whole = two;
    for (const spoil of spoils) {
      await spoil();
      await alarmAt(`2026-11-${++date}`, "00:00:00");
      const file = text((await directory()).get(FINGERPRINTS)!);
      assert.ok(file.startsWith(whole) && file.split("\n").length === whole.split("\n").length + 1, `the lines so far and the one of 2026-11-${date}`);
      whole = file;
    }
    assert.equal(differs(), 0);

    // The file has a line the object does not have, after its own or in place of one of them: nothing is written, of
    // this date or of any later one, and nothing of the file changes.
    const foreign = line("2026-11-20", 7, EMPTY_FINGERPRINT);
    for (const other of [whole + foreign, foreign + whole.slice(whole.indexOf("\n") + 1), whole.replace('"count":1,', '"count":2,')]) {
      await worker.putFile(`roster/${FINGERPRINTS}`, other, MINUTE, ROSTER_FILE_TYPE);
      const before = await directory();
      const answered = await published();
      const logged = differs();
      await alarmAt(`2026-11-${++date}`, "00:00:00");
      assert.deepEqual(await directory(), before, "no file is written, not the last roster file or a card state file either");
      assert.deepEqual(await published(), answered);
      assert.equal(differs(), logged + 1, "one line says that the bucket's fingerprint file is not the object's");
      // A minute later it is tried again, and stops again.
      await worker.setClock(tw(`2026-11-${date}`, "00:01:00"));
      await worker.roster.runAlarm();
      assert.deepEqual(await directory(), before);
      assert.equal(differs(), logged + 2);
    }

    // Once the bucket's file is the object's again, the roster is published as on any day: no line for the dates it was not.
    await worker.putFile(`roster/${FINGERPRINTS}`, whole, MINUTE, ROSTER_FILE_TYPE);
    await alarmAt(`2026-11-${++date}`, "00:00:00");
    const file = text((await directory()).get(FINGERPRINTS)!);
    assert.ok(file.startsWith(whole));
    assert.deepEqual(file.slice(whole.length).split("\n").map((l) => (l === "" ? "" : JSON.parse(l).date)), [`2026-11-${date}`, ""]);
  });

  test("a fingerprint file the object wrote without learning that it did is its own: the line whose write lost its answer is not taken for a foreign one", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    const differs = (): number => worker.logLines().filter((l) => l.includes('"fingerprint_file_differs"')).length;
    const lineDates = async (): Promise<unknown[]> => text((await directory()).get(FINGERPRINTS)!).split("\n").slice(0, -1).map((l) => [JSON.parse(l).date, JSON.parse(l).count]);
    const logged = differs();

    // The fingerprint file is stored with the new line, and the answer of the write is lost: the bucket has a line the
    // object has not marked as written.
    await worker.roster.setBucketFault({ key: `roster/${FINGERPRINTS}`, how: "put loses its answer" });
    await alarmAt("2026-11-21", "00:00:00");
    assert.deepEqual(await lineDates(), [["2026-11-21", 1]]);
    assert.equal(((await published()) as { date: unknown }).date, null, "the object has not read the line back");
    // The next try finds its own file, writes it again, and the line is published.
    await worker.roster.setBucketFault(null);
    await alarmAt("2026-11-21", "00:01:00");
    assert.equal(((await published()) as { date: unknown }).date, "2026-11-21");

    // The same on the next date, with the object started again before it tries again, and a day gone by.
    await worker.roster.setBucketFault({ key: `roster/${FINGERPRINTS}`, how: "put loses its answer" });
    await alarmAt("2026-11-22", "00:00:00");
    assert.deepEqual(await lineDates(), [["2026-11-21", 1], ["2026-11-22", 1]]);
    assert.equal(((await published()) as { date: unknown }).date, "2026-11-21");
    await worker.roster.restart();
    await day(worker, 2);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    await alarmAt("2026-11-23", "00:00:00");
    assert.deepEqual(await lineDates(), [["2026-11-21", 1], ["2026-11-22", 1], ["2026-11-23", 2]]);
    assert.equal(((await published()) as { date: unknown }).date, "2026-11-23");
    assert.equal(differs(), logged, "the object's own file was never taken for another's");
  });

  test("the bucket's fingerprint file is looked at again when it is written: one that changed while the other files were written is not written over", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    await alarmAt("2026-11-21", "00:00:00");
    const whole = text((await directory()).get(FINGERPRINTS)!);
    const foreign = whole + line("2026-11-21", 9, EMPTY_FINGERPRINT);
    const differs = (): number => worker.logLines().filter((l) => l.includes('"fingerprint_file_differs"')).length;
    const logged = differs();

    // The publication of 2026-11-22 has looked at the bucket's file and is writing the card state file when a line
    // that is not the object's appears in it.
    await worker.roster.setBucketFault({ key: "roster/card-state/2026-11-22.jsonl", how: "put takes a while" });
    await worker.setClock(tw("2026-11-22", "00:00:00"));
    const publishing = worker.roster.runAlarm();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await worker.putFile(`roster/${FINGERPRINTS}`, foreign, MINUTE, ROSTER_FILE_TYPE);
    await publishing;
    await worker.roster.setBucketFault(null);
    assert.equal(text((await directory()).get(FINGERPRINTS)!), foreign, "the file is not written over");
    assert.equal(differs(), logged + 1);
    assert.equal(((await published()) as { date: unknown }).date, "2026-11-21");

    // Once the file is the object's again, the line decided on 2026-11-22 is written with the next date's.
    const before = await directory();
    await alarmAt("2026-11-23", "00:00:00");
    assert.deepEqual(await directory(), before);
    await worker.putFile(`roster/${FINGERPRINTS}`, whole, MINUTE, ROSTER_FILE_TYPE);
    await alarmAt("2026-11-23", "00:01:00");
    assert.deepEqual(text((await directory()).get(FINGERPRINTS)!).split("\n").slice(0, -1).map((l) => JSON.parse(l).date), ["2026-11-21", "2026-11-22", "2026-11-23"]);
    assert.equal(((await published()) as { date: unknown }).date, "2026-11-23");
  });

  test("the fingerprint file is written only over the file that was looked at: one that changed between the look and the write stays, and is dealt with a minute later", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    await alarmAt("2026-11-21", "00:00:00");
    const whole = text((await directory()).get(FINGERPRINTS)!);
    const foreign = whole + line("2026-11-21", 9, EMPTY_FINGERPRINT);
    const count = (event: string): number => worker.logLines().filter((l) => l.includes(`"${event}"`)).length;
    const dates = async (): Promise<unknown[]> => text((await directory()).get(FINGERPRINTS)!).split("\n").slice(0, -1).map((l) => JSON.parse(l).date);
    /** A publication at midnight of `date` whose write of the fingerprint file takes a while, during which `change` is done to the bucket's file. */
    const publishWhile = async (date: string, change: () => Promise<void>): Promise<void> => {
      await worker.roster.setBucketFault({ key: `roster/${FINGERPRINTS}`, how: "put takes a while" });
      await worker.setClock(tw(date, "00:00:00"));
      const publishing = worker.roster.runAlarm();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await change();
      await publishing;
      await worker.roster.setBucketFault(null);
    };

    // Another's line appears in the file once the object has looked at it: the object's write does not happen.
    const [failed, differed] = [count("roster_not_published"), count("fingerprint_file_differs")];
    await publishWhile("2026-11-22", () => worker.putFile(`roster/${FINGERPRINTS}`, foreign, MINUTE, ROSTER_FILE_TYPE));
    assert.equal(text((await directory()).get(FINGERPRINTS)!), foreign, "the file is not written over");
    assert.deepEqual([count("roster_not_published"), count("fingerprint_file_differs")], [failed + 1, differed]);
    assert.equal(((await published()) as { date: unknown }).date, "2026-11-21");
    // A minute later the file is looked at again, and is not the object's.
    await alarmAt("2026-11-22", "00:01:00");
    assert.equal(text((await directory()).get(FINGERPRINTS)!), foreign);
    assert.equal(count("fingerprint_file_differs"), differed + 1);

    // The file is the object's again, and is deleted between the look and the write of the next try: that write does
    // not happen either, on a file that is no longer the one looked at; the try after it writes every line.
    await worker.putFile(`roster/${FINGERPRINTS}`, whole, MINUTE, ROSTER_FILE_TYPE);
    await worker.roster.setBucketFault({ key: `roster/${FINGERPRINTS}`, how: "put takes a while" });
    await worker.setClock(tw("2026-11-22", "00:02:00"));
    const trying = worker.roster.runAlarm();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await worker.deleteFile(`roster/${FINGERPRINTS}`);
    await trying;
    await worker.roster.setBucketFault(null);
    assert.equal((await directory()).has(FINGERPRINTS), false);
    assert.equal(count("roster_not_published"), failed + 2);
    await alarmAt("2026-11-22", "00:03:00");
    assert.deepEqual(await dates(), ["2026-11-21", "2026-11-22"]);
    assert.equal(((await published()) as { date: unknown }).date, "2026-11-22");

    // And a file that appears where there was none when the object looked: not written over.
    await worker.deleteFile(`roster/${FINGERPRINTS}`);
    await publishWhile("2026-11-23", () => worker.putFile(`roster/${FINGERPRINTS}`, foreign, MINUTE, ROSTER_FILE_TYPE));
    assert.equal(text((await directory()).get(FINGERPRINTS)!), foreign);
    assert.equal(((await published()) as { date: unknown }).date, "2026-11-22");
  });

  test("the date changes while the bucket is being written: no line is written for the day that ended, and the next try publishes the new date", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    const failures = notPublished();
    // The publication begins a second before midnight of 2026-11-21, and its card state file takes a while.
    await worker.roster.setBucketFault({ key: "roster/card-state/2026-11-21.jsonl", how: "put takes a while" });
    await worker.setClock(tw("2026-11-21", "23:59:59"));
    const publishing = worker.roster.runAlarm();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await worker.setClock(tw("2026-11-22", "00:00:00"));
    await publishing;
    await worker.roster.setBucketFault(null);
    assert.equal((await directory()).has(FINGERPRINTS), false);
    assert.deepEqual(await published(), { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT });
    assert.equal(notPublished(), failures + 1);

    await worker.setClock(tw("2026-11-22", "00:01:00"));
    await worker.roster.runAlarm();
    const files = await directory();
    assert.match(text(files.get(FINGERPRINTS)!), /^\{"date":"2026-11-22","count":1,[^\n]*\n$/);
    assert.equal(files.has("card-state/2026-11-22.jsonl"), true);
  });

  // What this shows is the test build's: there the alarm's handler runs one at a time, the alarm's own run and the
  // ones a test starts (test-build/index.ts, `alarm`). The deployed object has nothing of the kind, and needs none:
  // its alarm never runs twice at once.
  test("alarms a test starts at once at midnight run one after the other, and publish once", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    const failures = notPublished();
    await worker.setClock(tw("2026-11-21", "00:00:00"));
    await Promise.all([worker.roster.runAlarm(), worker.roster.runAlarm(), worker.roster.runAlarm()]);
    assert.equal(text((await directory()).get(FINGERPRINTS)!).split("\n").length, 2);
    assert.equal(notPublished(), failures);
  });

  test("a paused roster is not published, and is once it is no longer paused", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    const moment = await worker.roster.stored();
    await worker.roster.setStoredRulesVersion("another");
    await worker.roster.restart();
    try {
      await alarmAt("2026-11-21", "00:00:00");
      await alarmAt("2026-11-22", "00:00:00");
      assert.deepEqual([...(await directory()).keys()], []);
      assert.deepEqual(await published(), { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT });
    } finally {
      await worker.roster.setStoredRulesVersion("the build's");
      await worker.roster.restart();
    }
    await worker.setClock(tw("2026-11-22", "00:00:00"));
    await worker.roster.runAlarm();
    assert.equal(text((await directory()).get(FINGERPRINTS)!), line("2026-11-22", 1, moment.roster.fingerprint));
  });
});

describe("the published files", () => {
  test("no address of the Worker gives the fingerprint file, a card state file or the last roster file", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    await alarmAt("2026-11-21", "00:00:00");
    const files = await directory();
    assert.equal(files.size, 4);
    for (const name of files.keys()) {
      for (const path of [`/roster/${name}`, `/${name}`, `/api/v1/roster/${name}`, `/api/v1/${name}`]) {
        const res = await worker.fetch(path);
        const body = await res.text();
        assert.equal(res.status, 404, path);
        assert.ok(!body.includes('"proof"') && !body.includes('"fingerprint"') && !body.includes('"last_seq"'), `${path} gives something of a file`);
      }
    }
    // The endpoint the Go backend called `head` is not one of the Worker's.
    assert.equal((await worker.fetch("/api/v1/head")).status, 404);
    assert.deepEqual([(await worker.fetch("/api/v1/fingerprint", { method: "POST" })).status], [405]);
  });
});
