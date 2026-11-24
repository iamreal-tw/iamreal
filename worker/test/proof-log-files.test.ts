// A log file that is full moves to the data bucket (ADR-0027,
// spec/record.md "The published proof log"), seen through the Worker's HTTP and
// the files of the simulated R2 bucket (test/harness.ts): once the 1,000th
// record is written, the file and its record hash list are in the bucket,
// byte for byte what the records give, and the object no longer keeps those
// records; the proof log goes on as before. A file that could not be written,
// or that did not read back as it was written, stays in the object and is
// moved later, with the same bytes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { EMPTY_FINGERPRINT, LINES_PER_FILE, hashList, hashListName, nextFingerprint, recordHash, proofLogFileName } from "iamreal-protocol/record.ts";
import { WORKER_DIR } from "./build.ts";
import { type StoredFile, type TestWorker, startWorker } from "./harness.ts";
import { CARD_A, cardStarting } from "./pages.ts";
import { DAY_MS, HASH_LIST_TYPE, IMMUTABLE, PROOF_LOG_FILE_TYPE, START, type Submission, TEST_SCOPE, cardState, checkProofLog, freshProofLog, mustSubmit, newCard, publishCrl, publishG3, sub, submit, tw } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

const text = (file: StoredFile): string => new TextDecoder().decode(file.bytes);
const page = async (path: string): Promise<[number, string]> => {
  const res = await worker.fetch(path);
  return [res.status, await res.text()];
};

/** Writes records until the proof log has `upTo` of them: each a first card proof of a new card that declares `@alice`, 20 submitted at a time. */
async function fillTo(root: string, upTo: number): Promise<void> {
  let count = (await cardState(worker, newCard())).count as number;
  while (count < upTo) {
    const submissions: Submission[] = [];
    for (let i = 0; i < Math.min(20, upTo - count); i++) submissions.push(await sub(worker, newCard(), root, "threads:alice"));
    for (const answer of await Promise.all(submissions.map((s) => submit(worker, s)))) assert.equal(answer.status, 201, JSON.stringify(answer.body));
    count += submissions.length;
  }
}

/** The files of the log directory in the bucket, by their path in the directory. */
async function directory(): Promise<Map<string, StoredFile>> {
  return new Map((await worker.files("proof-log/")).map((f) => [f.key.slice("proof-log/".length), f]));
}

const FILE = `proof-log/${proofLogFileName(0)}`;
const LIST = `proof-log/${hashListName(0)}`;

/**
 * Waits until the full log files and their record hash lists in the
 * bucket are exactly these, for at most ten seconds. What the daily
 * publication writes (README.md, "每天換日公布證明紀錄") is not among them: a
 * proof log whose date changes during a test is published by its own alarm,
 * and those files do not carry the full files' `Cache-Control`.
 */
async function untilDirectoryIs(names: readonly string[]): Promise<Map<string, StoredFile>> {
  for (let tries = 0; ; tries++) {
    const files = new Map([...(await directory())].filter(([, file]) => file.cacheControl === IMMUTABLE));
    if (tries === 100 || JSON.stringify([...files.keys()]) === JSON.stringify(names)) {
      assert.deepEqual([...files.keys()], names);
      return files;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** How many times the object has said that it could not move a full file. */
const notMoved = (): number => worker.logLines().filter((line) => line.includes('"full_file_not_moved"')).length;

// The tests of this group go on from each other, on one proof log: filling a file takes a thousand records.
describe("the 1,000th record fills a log file", () => {
  const card = cardStarting(CARD_A);
  // Three cards that declare in the first file and change their list in the second: a correction, a switch, a withdrawal.
  const [corrects, switches, withdraws] = [newCard(), newCard(), newCard()];
  let root: string;

  test("the file and its record hash list are in the bucket, the object keeps none of its records, and the proof log goes on", async () => {
    await freshProofLog(worker);
    // The records are dated 2026-11-16, the date of the CRL the fake archive of Go's tests knows every root by (below).
    root = await publishCrl(worker, { issuer: "G3", number: 1, thisUpdate: tw("2026-11-16", "05:00:00"), serials: [11, 12] });
    await worker.setClock(tw("2026-11-16", "12:00:00"));
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    for (const other of [corrects, switches, withdraws]) await mustSubmit(worker, await sub(worker, other, root, "threads:alice"), "threads first");
    await fillTo(root, LINES_PER_FILE - 1);
    assert.deepEqual([...(await directory()).keys()], [], "a file that is not full is not in the bucket");
    assert.equal((await checkProofLog(worker)).length, LINES_PER_FILE - 1);

    // What the object stores of the 999 records, and what the card and its page are before the file is full.
    const before = await worker.proofLog.stored();
    const state = await cardState(worker, card);
    const cardPage = await page(`/p/${CARD_A}`);

    await fillTo(root, LINES_PER_FILE);
    const full = (await worker.proofLog.stored()).records;
    assert.equal(full.length, LINES_PER_FILE);
    assert.deepEqual(full.slice(0, -1), before.records);
    const home = await page("/");

    // Nothing asks for the move: the record that fills the file sets the object's alarm, and the alarm moves it.
    const files = await untilDirectoryIs([proofLogFileName(0), hashListName(0)]);
    const file = files.get(proofLogFileName(0))!;
    const hashes = files.get(hashListName(0))!;
    assert.equal(text(file), full.map((row) => row.line).join(""), "the log file is the stored lines, one after the other");
    assert.equal(text(hashes), hashList(EMPTY_FINGERPRINT, full.map((row) => row.record_hash)), "the record hash list is the fingerprint before the file and the stored record hashes");
    assert.deepEqual([file.cacheControl, hashes.cacheControl], [IMMUTABLE, IMMUTABLE]);
    assert.deepEqual([file.contentType, hashes.contentType], [PROOF_LOG_FILE_TYPE, HASH_LIST_TYPE]);

    // The object keeps none of the 1,000, and still says what the proof log is as a whole.
    await worker.proofLog.runAlarm(); // waits for the move that put the list there, if it is still deleting
    const moved = await worker.proofLog.stored();
    assert.deepEqual(moved.records, []);
    assert.deepEqual(moved.proofLog, { count: LINES_PER_FILE, fingerprint: full.at(-1)!.fingerprint });
    assert.equal(notMoved(), 0);

    // The card and the pages are as they were; the 1,001st record is written as any other.
    assert.deepEqual(await cardState(worker, card), { ...state, count: LINES_PER_FILE });
    assert.deepEqual(await page(`/p/${CARD_A}`), cardPage);
    assert.deepEqual(await page("/"), home);
    const next = await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads refresh");
    assert.equal(next.seq, LINES_PER_FILE + 1);
    assert.deepEqual((await worker.proofLog.stored()).records.map((row) => row.seq), [LINES_PER_FILE + 1]);
    assert.equal((await checkProofLog(worker)).length, LINES_PER_FILE + 1);
    assert.deepEqual([...(await directory()).keys()], [proofLogFileName(0), hashListName(0)], "the file that is not full stays in the object");
  });

  /** What a page answers when the back end itself fails. */
  const wantUnavailable = async (path: string): Promise<void> => {
    const res = await worker.fetch(path);
    assert.deepEqual([res.status, res.headers.get("cache-control"), await res.text()], [500, "no-store", "internal error\n"], path);
  };
  const notFilled = (): number => worker.logLines().filter((line) => line.includes('"views_not_filled"')).length;

  test("the views, cleared, are written again from the bucket's log file and the object's records: row for row what they were", async () => {
    // Records of every kind whose card's earlier records are in the file that was moved: a correction on the day of the
    // first declaration, and the day after a switch, a withdrawal and a refresh.
    await mustSubmit(worker, await sub(worker, corrects, root, "threads:carol"), "threads correction");
    await worker.setClock(tw("2026-11-17", "12:00:00"));
    await mustSubmit(worker, await sub(worker, switches, root, "threads:bob"), "threads switch");
    await mustSubmit(worker, await sub(worker, withdraws, root), "threads withdraw");
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads refresh");
    const views = await worker.proofLog.views();
    assert.deepEqual(views.view_state, [{ id: 1, seq: LINES_PER_FILE + 5 }]);
    assert.deepEqual([...new Set(views.view_history!.map((row) => row.kind))].sort(), ["correction", "first", "refresh", "switch", "withdraw"]);
    const pages = [await page("/"), await page(`/p/${CARD_A}`)];

    await worker.proofLog.clearViews();
    await worker.proofLog.restart();
    await worker.proofLog.viewsFilled();
    assert.deepEqual(await worker.proofLog.views(), views);
    assert.deepEqual([await page("/"), await page(`/p/${CARD_A}`)], pages);
    assert.equal(notFilled(), 0);

    // And the proof log goes on from them.
    const next = await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads refresh");
    assert.deepEqual([next.seq, next.kinds[0].account_cards], [LINES_PER_FILE + 6, LINES_PER_FILE - 3]);
  });

  test("a log file the bucket does not have as it was written fills no views: no page, no record, until the file is back", async () => {
    const views = await worker.proofLog.views();
    const pages = [await page("/"), await page(`/p/${CARD_A}`)];
    const state = await cardState(worker, card);
    const file = (await directory()).get(proofLogFileName(0))!;
    // Each start is once the wait of the failure before it is over (a minute after the first, two after the second):
    // an object that starts before that does not fill its views at once.
    let time = tw("2026-11-17", "12:00:00").getTime();
    await worker.setClock(new Date(time));
    const submission = await sub(worker, newCard(), root, "threads:alice");

    // Other bytes under the file's name: its last line is missing. Then no file at all.
    for (const [n, spoil] of [() => worker.putFile(FILE, file.bytes.subarray(0, file.bytes.lastIndexOf(0x0a, file.bytes.length - 2) + 1)), () => worker.deleteFile(FILE)].entries()) {
      await spoil();
      await worker.proofLog.clearViews();
      time += n * 60 * 1000;
      await worker.setClock(new Date(time));
      await worker.proofLog.restart();
      await worker.proofLog.viewsFilled();
      assert.equal(notFilled(), n + 1, "one line says that the views were not filled");
      for (const path of ["/", `/p/${CARD_A}`]) await wantUnavailable(path);
      const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(submission) });
      assert.deepEqual([res.status, JSON.parse(await res.text())], [500, { error: "internal" }]);
      // What does not read the views goes on.
      assert.deepEqual(await cardState(worker, card), state);
      await worker.issueChallenge();
    }

    await worker.putFile(FILE, file.bytes, IMMUTABLE, PROOF_LOG_FILE_TYPE);
    await worker.setClock(new Date(time + 2 * 60 * 1000));
    await worker.proofLog.restart();
    await worker.proofLog.viewsFilled();
    assert.deepEqual(await worker.proofLog.views(), views);
    assert.deepEqual([await page("/"), await page(`/p/${CARD_A}`)], pages);
    await mustSubmit(worker, submission, "threads first");
    assert.equal((await checkProofLog(worker)).length, LINES_PER_FILE + 7);
  });

  // Go's re-verifying command reads the directory. Without go this is skipped on a developer's machine; where it
  // must run (CI, which GitHub Actions sets, or IAMREAL_BB), a missing go is a failure, as in sequence.test.ts.
  const hasGo = spawnSync("go", ["version"]).status === 0;
  const goRequired = Boolean(process.env.CI) || Boolean(process.env.IAMREAL_BB);

  test("a second file follows the first, and Go's iamreal-verify reads the directory the Worker wrote", { skip: !hasGo && !goRequired ? "go is not installed" : false }, async () => {
    assert.ok(hasGo, "go is not installed, and CI or IAMREAL_BB is set: this must run here");
    await fillTo(root, 2 * LINES_PER_FILE + 1);
    const names = [proofLogFileName(0), proofLogFileName(LINES_PER_FILE), hashListName(0), hashListName(LINES_PER_FILE)];
    const files = await untilDirectoryIs(names);
    await worker.proofLog.runAlarm();
    const records = await checkProofLog(worker);
    assert.equal(records.length, 2 * LINES_PER_FILE + 1);
    assert.deepEqual((await worker.proofLog.stored()).records.map((row) => row.seq), [2 * LINES_PER_FILE + 1]);

    // The bucket's log directory, copied to a directory of its own.
    mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
    const out = mkdtempSync(join(WORKER_DIR, "test-output", "directory-"));
    try {
      for (const name of names) {
        mkdirSync(dirname(join(out, "proof-log", name)), { recursive: true });
        writeFileSync(join(out, "proof-log", name), files.get(name)!.bytes);
      }
      const run = spawnSync("go", ["test", "-count=1", "-tags", "iamrealtest", "-run", "^TestWorkerDirectory$", "./cmd/iamreal-verify"], { cwd: join(WORKER_DIR, ".."), env: { ...process.env, IAMREAL_WORKER_DIRECTORY: join(out, "proof-log") }, encoding: "utf8" });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const said = readFileSync(join(out, "verify.txt"), "utf8");
      const verified = JSON.parse(readFileSync(join(out, "verify.json"), "utf8")) as {
        valid: boolean;
        fingerprint: string;
        results: { seq: number; valid: boolean }[];
        state: { scope_string: string; cards: { scoped_id: string; last_card_proof: string; accounts: unknown }[] }[];
        ordinals: { scope_string: string; scoped_id: string; ordinal: number }[];
      };

      // The directory is a valid proof log of the records of its two files, each one valid, with the fingerprint they give.
      let fingerprint = EMPTY_FINGERPRINT;
      for (const record of records.slice(0, 2 * LINES_PER_FILE)) fingerprint = await nextFingerprint(fingerprint, await recordHash(record));
      assert.equal(verified.valid, true);
      assert.equal(verified.fingerprint, fingerprint);
      assert.deepEqual(verified.results.map((r) => [r.seq, r.valid]), Array.from({ length: 2 * LINES_PER_FILE }, (_, i) => [i + 1, true]));
      // Both lists are the proof log's; the one thing the command misses is the fingerprint file, which is published once a day.
      assert.match(said, /hashes\/: 2 list\(s\), every list is the proof log's/);
      assert.deepEqual(said.split("\n").filter((line) => /missing|not the record hash list|has no log file|broken/.test(line)), ["iamreal-verify: fingerprints.jsonl is missing"]);
      // What Go computes of the card that has four records is what the back end answers for it.
      const cards = verified.state.find((scope) => scope.scope_string === TEST_SCOPE)!.cards;
      // The card that has four records, and the three that have two.
      assert.equal(cards.length, 2 * LINES_PER_FILE - 6);
      const state = await cardState(worker, card);
      assert.deepEqual(cards.find((c) => c.scoped_id === card), { scoped_id: card, last_card_proof: state.last_card_proof, accounts: [{ platform: "threads", username: "alice" }] });
      // Every card's ordinal Go computes is the one the pages read (src/views.ts, view_ordinals); the record after the
      // two files, not in the directory, is no card's first. And the page of the card writes Go's number.
      const views = (await worker.proofLog.views()).view_ordinals!.map((row) => ({ scope_string: row.scope_string, scoped_id: row.scoped_id, ordinal: row.ordinal }));
      assert.equal(verified.ordinals.length, cards.length);
      assert.deepEqual(verified.ordinals, views.slice(0, verified.ordinals.length));
      const ordinal = verified.ordinals.find((o) => o.scoped_id === card)!.ordinal;
      const page = await (await worker.fetch(`/p/${card.slice(0, 10)}`)).text();
      assert.ok(page.includes(`<p class="ordinal">第 ${ordinal.toLocaleString("en-US")} 張島民證明</p>`), `the page of ${card} writes 第 ${ordinal} 張`);
      rmSync(out, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\nThe directory and what Go printed are kept in ${out}`, { cause: e });
    }
  });

  test("views that could not be filled from the bucket are tried again after 1, 2, 4, then 5 minutes each, one filling at a time; once filled, a failure is a first one again", async () => {
    const views = await worker.proofLog.views();
    const pages = [await page("/"), await page(`/p/${CARD_A}`)];
    const second = `proof-log/${proofLogFileName(LINES_PER_FILE)}`;
    const file = (await directory()).get(proofLogFileName(LINES_PER_FILE))!;
    let time = tw("2026-11-17", "13:00:00").getTime();
    const minutesLater = async (minutes: number): Promise<void> => {
      time += minutes * 60 * 1000;
      await worker.setClock(new Date(time));
      await worker.proofLog.runAlarm();
      await worker.proofLog.viewsFilled();
    };

    // The second file is gone when the object starts: the views stop at the end of the first, and no page is shown.
    await worker.setClock(new Date(time));
    await worker.deleteFile(second);
    await worker.proofLog.clearViews();
    await worker.proofLog.restart();
    await worker.proofLog.viewsFilled();
    const lines = notFilled();
    assert.deepEqual((await worker.proofLog.views()).view_state, [{ id: 1, seq: LINES_PER_FILE }]);
    await wantUnavailable("/");
    // The object set its alarm for the next try by itself: within the minute, where the challenges' own is minutes away.
    const alarm = await worker.proofLog.alarmInMs();
    assert.ok(alarm !== null && alarm <= 60 * 1000, `the alarm is ${alarm} ms ahead`);

    // Started again before the minute is over (on Cloudflare, an object that had nothing to do for some seconds), the
    // object does not fill the views at once: it waits as the one before it would have.
    await worker.proofLog.restart();
    await worker.setClock(new Date(time));
    await worker.proofLog.viewsFilled();
    assert.equal(notFilled(), lines);
    await wantUnavailable("/");

    // An alarm before the minute is over does not try.
    await worker.proofLog.runAlarm();
    assert.equal(notFilled(), lines);
    // Once it is over, the alarm starts the object again, as on Cloudflare it starts one that left memory: the object
    // begins a filling when it starts, and the alarm's handler, which runs right after, begins none beside it.
    time += 60 * 1000;
    await worker.setClock(new Date(time));
    await worker.proofLog.restart();
    await worker.proofLog.runAlarm();
    await worker.proofLog.viewsFilled();
    assert.equal(notFilled(), lines + 1, "one filling, one line");
    await wantUnavailable("/");

    // Failing on, the waits are 2 and 4 minutes, then 5 each: the longest wait of this piece of work, shorter than the
    // others' hour, as pages and submissions wait with it (README.md, "失敗後多久再試").
    for (const [n, minutes] of [2, 4, 5, 5].entries()) {
      await minutesLater(minutes - 1);
      assert.equal(notFilled(), lines + 1 + n, `nothing is tried before ${minutes} minutes are over`);
      await minutesLater(1);
      assert.equal(notFilled(), lines + 2 + n, `the try after ${minutes} minutes`);
    }
    await wantUnavailable("/");

    // The file is back: the try five minutes after the last failure fills the views, and the pages and records go on.
    const failed = notFilled();
    await worker.putFile(second, file.bytes, IMMUTABLE, PROOF_LOG_FILE_TYPE);
    await minutesLater(4);
    await wantUnavailable("/");
    await minutesLater(1);
    assert.equal(notFilled(), failed);
    assert.deepEqual(await worker.proofLog.views(), views);
    assert.deepEqual([await page("/"), await page(`/p/${CARD_A}`)], pages);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    assert.equal((await checkProofLog(worker)).length, 2 * LINES_PER_FILE + 2);

    // Filled, the object keeps nothing of the failures: views that cannot be filled when it next starts are a first
    // failure, tried again a minute later.
    await worker.deleteFile(second);
    await worker.proofLog.clearViews();
    await worker.proofLog.restart();
    await worker.setClock(new Date(time));
    await worker.proofLog.viewsFilled();
    assert.equal(notFilled(), failed + 1);
    await minutesLater(1);
    assert.equal(notFilled(), failed + 2, "the try a minute after the first failure");
    // The file is back, and the try two minutes after the second failure fills the views.
    await worker.putFile(second, file.bytes, IMMUTABLE, PROOF_LOG_FILE_TYPE);
    await minutesLater(2);
    assert.equal(notFilled(), failed + 2);
    assert.equal((await page("/"))[0], 200);
  });

  test("no address of the Worker gives a log file or a record hash list", async () => {
    const line = text((await directory()).get(proofLogFileName(0))!).slice(0, 200);
    for (const path of [`/${FILE}`, `/${LIST}`, `/${proofLogFileName(0)}`, `/${hashListName(0)}`, `/api/v1/${FILE}`, `/api/v1/${LIST}`, "/api/v1/proof-log", "/api/v1/records", "/proof-log/", "/proof-log/fingerprints.jsonl"]) {
      const res = await worker.fetch(path);
      const body = await res.text();
      assert.ok(res.status === 404 || res.status === 405, `${path}: ${res.status}`);
      assert.ok(!body.includes(line.slice(0, 40)) && !body.includes('"proof"'), `${path} gives something of a record`);
    }
  });
});

describe("a full log file that cannot be moved", () => {
  test("stays in the object, whichever step fails, and is moved later with the same bytes", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    const card = newCard();
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    await fillTo(root, LINES_PER_FILE - 1);

    // Each try is one alarm, `minutes` of the object's clock after the one before: a minute after a first failure, and
    // twice as long after each further failure in a row, up to an hour (src/proof-log.ts, `Retries`). An alarm a second
    // before that does not try.
    let time = START.getTime();
    const tryAgain = async (minutes: number): Promise<void> => {
      time += minutes * 60 * 1000;
      const lines = notMoved();
      await worker.setClock(new Date(time - 1000));
      await worker.proofLog.runAlarm();
      assert.equal(notMoved(), lines, `nothing is tried before ${minutes} minutes are over`);
      await worker.setClock(new Date(time));
      await worker.proofLog.runAlarm();
    };
    // The object keeps all its records, and the proof log is whole.
    const kept = async (records: number): Promise<void> => {
      assert.equal((await worker.proofLog.stored()).records.length, records);
      assert.equal((await checkProofLog(worker)).length, records);
    };

    // The log file cannot be written: nothing is in the bucket, and no record is deleted.
    await worker.proofLog.setBucketFault({ key: FILE, how: "put fails" });
    await fillTo(root, LINES_PER_FILE);
    const full = (await worker.proofLog.stored()).records;
    const fileText = full.map((row) => row.line).join("");
    const listText = hashList(EMPTY_FINGERPRINT, full.map((row) => row.record_hash));
    await worker.proofLog.runAlarm();
    assert.deepEqual([...(await directory()).keys()], []);
    await kept(LINES_PER_FILE);
    assert.equal(notMoved(), 1, "one line says that the file was not moved");

    // The next try is a minute later, not at the next alarm; a piece of timed work after this one runs all the same.
    await worker.proofLog.setExtraWork(new Date(time), DAY_MS);
    await worker.proofLog.runAlarm();
    assert.equal(notMoved(), 1);
    assert.deepEqual(await worker.proofLog.extraWorkRuns(), [new Date(time)]);

    // Meanwhile the proof log takes records, and the card is what it was.
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads refresh");
    await kept(LINES_PER_FILE + 1);

    // The bucket is sent other bytes than the object meant: it refuses them by their SHA-256, and nothing wrong is ever under the file's name.
    await worker.proofLog.setBucketFault({ key: FILE, how: "put sends other bytes" });
    await tryAgain(1);
    assert.deepEqual([...(await directory()).keys()], []);
    await kept(LINES_PER_FILE + 1);

    // The bucket stores other bytes than it was sent: the file does not read back as written, and no list is written after it.
    await worker.proofLog.setBucketFault({ key: FILE, how: "put writes other bytes" });
    await tryAgain(2);
    assert.deepEqual([...(await directory()).keys()], [proofLogFileName(0)]);
    assert.notEqual(text((await directory()).get(proofLogFileName(0))!), fileText);
    await kept(LINES_PER_FILE + 1);

    // The log file cannot be read back.
    await worker.proofLog.setBucketFault({ key: FILE, how: "get fails" });
    await tryAgain(4);
    await kept(LINES_PER_FILE + 1);

    // The log file is written with its bytes and another header: read back, it is not as it was to be written.
    for (const [how, minutes] of [["put writes another Cache-Control", 8], ["put writes another Content-Type", 16]] as const) {
      await worker.proofLog.setBucketFault({ key: FILE, how });
      await tryAgain(minutes);
      const files = await directory();
      assert.deepEqual([...files.keys()], [proofLogFileName(0)]);
      assert.equal(text(files.get(proofLogFileName(0))!), fileText);
      assert.notDeepEqual([files.get(proofLogFileName(0))!.cacheControl, files.get(proofLogFileName(0))!.contentType], [IMMUTABLE, PROOF_LOG_FILE_TYPE]);
      await kept(LINES_PER_FILE + 1);
    }

    // The log file is there, and its list cannot be written, or does not read back as written.
    for (const [how, minutes] of [["put fails", 32], ["put writes other bytes", 60]] as const) {
      await worker.proofLog.setBucketFault({ key: LIST, how });
      await tryAgain(minutes);
      const files = await directory();
      assert.equal(text(files.get(proofLogFileName(0))!), fileText);
      assert.equal(files.has(hashListName(0)), how !== "put fails");
      await kept(LINES_PER_FILE + 1);
    }

    // Both are written, and the object stops before it deletes its records: it lost the answer of the last write, and is started again.
    await worker.proofLog.setBucketFault({ key: LIST, how: "put loses its answer" });
    await tryAgain(60);
    assert.equal(notMoved(), 9);
    const written = await directory();
    assert.deepEqual([text(written.get(proofLogFileName(0))!), text(written.get(hashListName(0))!)], [fileText, listText]);
    assert.deepEqual([written.get(proofLogFileName(0))!.contentType, written.get(hashListName(0))!.contentType], [PROOF_LOG_FILE_TYPE, HASH_LIST_TYPE]);
    await kept(LINES_PER_FILE + 1);
    await worker.proofLog.restart();
    await worker.setClock(new Date(time));

    // The second file is full while the object, started again, waits the hour after the ninth failure: it keeps both
    // files and every record after them, and does not try before the hour is over.
    await worker.proofLog.setBucketFault({ key: FILE, how: "put fails" });
    await fillTo(root, 2 * LINES_PER_FILE + 5);
    await worker.proofLog.runAlarm();
    assert.equal(notMoved(), 9);
    assert.deepEqual(await worker.proofLog.kept(), { count: 2 * LINES_PER_FILE + 5, first: 1, last: 2 * LINES_PER_FILE + 5 });
    assert.deepEqual([...(await directory()).keys()], [proofLogFileName(0), hashListName(0)], "nothing of the second file is in the bucket before the first is moved");

    // The tenth try fails again, an hour later.
    await tryAgain(60);
    assert.equal(notMoved(), 10);
    assert.deepEqual([...(await directory()).keys()], [proofLogFileName(0), hashListName(0)]);

    // Once the bucket takes the file, both are moved (an hour after that), the earlier first and with the same bytes,
    // and only their records are deleted.
    await worker.proofLog.setBucketFault(null);
    await tryAgain(60);
    const files = await directory();
    assert.deepEqual([...files.keys()], [proofLogFileName(0), proofLogFileName(LINES_PER_FILE), hashListName(0), hashListName(LINES_PER_FILE)]);
    assert.deepEqual(await worker.proofLog.kept(), { count: 5, first: 2 * LINES_PER_FILE + 1, last: 2 * LINES_PER_FILE + 5 });
    assert.deepEqual([text(files.get(proofLogFileName(0))!), text(files.get(hashListName(0))!)], [fileText, listText]);
    assert.deepEqual([files.get(proofLogFileName(0))!.cacheControl, files.get(hashListName(0))!.cacheControl], [IMMUTABLE, IMMUTABLE]);
    assert.deepEqual([files.get(proofLogFileName(0))!.contentType, files.get(hashListName(0))!.contentType], [PROOF_LOG_FILE_TYPE, HASH_LIST_TYPE]);
    assert.equal((await checkProofLog(worker)).length, 2 * LINES_PER_FILE + 5);
    assert.equal(notMoved(), 10);
  });

  test("a file the daily publication moves, after moves that failed, is a move that succeeded: the next file is moved at once, and its failure waits a minute", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    const at = async (date: string, time: string): Promise<void> => {
      await worker.setClock(tw(date, time));
      await worker.proofLog.runAlarm();
    };

    // The first file cannot be moved, four times in a row: at 23:50, 23:51, 23:53 and 23:57. The next try would be
    // eight minutes after the fourth, at 00:05.
    await worker.setClock(tw("2026-11-20", "23:50:00"));
    await worker.proofLog.setBucketFault({ key: FILE, how: "put fails" });
    await fillTo(root, LINES_PER_FILE);
    await worker.proofLog.runAlarm();
    const failed = notMoved();
    for (const time of ["23:51:00", "23:53:00", "23:57:00"]) await at("2026-11-20", time);
    assert.equal(notMoved(), failed + 3);

    // At midnight the move is not due; the publication moves the file before it publishes.
    await worker.proofLog.setBucketFault(null);
    await at("2026-11-21", "00:00:00");
    await untilDirectoryIs([proofLogFileName(0), hashListName(0)]);
    assert.equal(notMoved(), failed + 3);
    assert.equal((await worker.proofLog.stored()).records.length, 0, "the object no longer keeps the file's records");

    // The second file fills at 00:01 and cannot be moved either: it is tried at once, not at 00:05, and that is a first
    // failure, tried again a minute later.
    await worker.setClock(tw("2026-11-21", "00:01:00"));
    await worker.proofLog.setBucketFault({ key: `proof-log/${proofLogFileName(LINES_PER_FILE)}`, how: "put fails" });
    await fillTo(root, 2 * LINES_PER_FILE);
    await worker.proofLog.runAlarm();
    assert.equal(notMoved(), failed + 4, "the try when the second file fills");
    await at("2026-11-21", "00:02:00");
    assert.equal(notMoved(), failed + 5, "the try a minute after the first failure");
    await worker.proofLog.setBucketFault(null);
  });
});

describe("a log file fills while challenges keep being issued", () => {
  test("a challenge every 300 ms, each of which sets the object's alarm, does not keep the file in the object", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    await fillTo(root, LINES_PER_FILE);
    const names = [proofLogFileName(0), hashListName(0)];
    let moved = false;
    for (let i = 0; i < 20 && !moved; i++) {
      await worker.issueChallenge();
      await new Promise((resolve) => setTimeout(resolve, 300));
      moved = JSON.stringify([...(await directory()).keys()]) === JSON.stringify(names);
    }
    assert.ok(moved, "the file is in the bucket within six seconds of challenges");
    await worker.proofLog.runAlarm();
    assert.deepEqual((await worker.proofLog.stored()).records, []);
    assert.equal((await checkProofLog(worker)).length, LINES_PER_FILE);
  });
});
