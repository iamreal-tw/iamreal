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

    // Everything but the fingerprint file is written; the answer of its write is lost, then it cannot be written, and the object starts again.
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

    // The bucket's fingerprint file is changed, or gone: the next date's publication writes every line again from what the object keeps.
    for (const [n, spoil] of [() => worker.putFile(`roster/${FINGERPRINTS}`, line("2026-11-21", 2, EMPTY_FINGERPRINT)), () => worker.deleteFile(`roster/${FINGERPRINTS}`)].entries()) {
      await spoil();
      const now = await worker.roster.stored();
      await alarmAt(`2026-11-2${2 + n}`, "00:00:00");
      const lines = text((await directory()).get(FINGERPRINTS)!).split("\n");
      assert.equal(`${lines[0]}\n`, line("2026-11-21", 1, moment.roster.fingerprint));
      assert.equal(`${lines[n + 1]}\n`, line(`2026-11-2${2 + n}`, 2, now.roster.fingerprint));
      assert.equal(lines.length, n + 3);
    }
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
