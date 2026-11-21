// Clearing the test roster (ADR-0028), done on the local Worker the way
// README.md, "清空測試名冊", tells the operator to: the settings get a new
// name for the roster's object and a new date, the Worker is deployed, and
// roster/ of the data bucket is emptied. Seen through the Worker's HTTP and
// the files of the simulated R2 bucket (test/harness.ts).
//
// The Worker has no endpoint that clears a roster. The object of the
// cleared roster is not deleted by any of this: it stays on Cloudflare with
// what it stored and with its alarm set, and it shares the bucket with the
// new one.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import { EMPTY_FINGERPRINT, fingerprintLine } from "iamreal-protocol/record.ts";
import { unstable_readConfig } from "wrangler";
import { WORKER_DIR } from "./build.ts";
import { type StoredFile, type TestWorker, startWorker } from "./harness.ts";
import { cardState, checkRoster, freshRoster, mustSubmit, newCard, publishG3, sub, tw } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

const text = (file: StoredFile): string => new TextDecoder().decode(file.bytes);
const FIRST_FILE = ["0000000000000000.jsonl", "card-state/2026-11-21.jsonl", "fingerprints.jsonl", "hashes/0000000000000000.txt"];

/** The files of the roster directory in the bucket, by their path in the directory. */
async function directory(): Promise<Map<string, StoredFile>> {
  return new Map((await worker.files("roster/")).map((f) => [f.key.slice("roster/".length), f]));
}

/** What `GET /api/v1/fingerprint` answers. */
async function published(): Promise<{ date: string | null; count: number; fingerprint: string }> {
  const res = await worker.fetch("/api/v1/fingerprint");
  assert.equal(res.status, 200);
  return (await res.json()) as { date: string | null; count: number; fingerprint: string };
}

/** The date the home page says the test roster was last cleared on. */
async function clearedOn(): Promise<string | undefined> {
  return /上次清空：<time>([^<]*)<\/time>/.exec(await (await worker.fetch("/")).text())?.[1];
}

test("the steps of README.md: the roster is empty, takes records, and is published; the cleared roster's object writes nothing more", async () => {
  // A test roster with a record, published once. The dates are this test's own, not wrangler.jsonc's.
  const replacedLines = (): number => worker.logLines().filter((l) => l.includes('"roster_object_replaced"')).length;
  const clearedName = await freshRoster(worker, { clearedOn: "2026-11-07" });
  const root = await publishG3(worker);
  const card = newCard();
  await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
  await worker.setClock(tw("2026-11-21", "00:00:00"));
  await worker.roster.runAlarm();
  assert.deepEqual([...(await directory()).keys()], FIRST_FILE);
  assert.equal((await published()).count, 1);
  assert.equal(await clearedOn(), "2026-11-07");
  assert.equal(replacedLines(), 0, "the roster's object does not say it was replaced");
  const archive = await worker.files("crl/");

  // Steps 1 and 2: the settings name another object and today's date, and are deployed. A deploy starts every object anew.
  await worker.setClock(tw("2026-11-21", "10:00:00"));
  const cleared = worker.clearedRoster(clearedName);
  await worker.setSettings({ ROSTER_KIND: "test", ROSTER_OBJECT_NAME: `${clearedName}-cleared`, TEST_ROSTER_CLEARED_ON: "2026-11-21" });
  await cleared.restart();
  // The object that was replaced says so once when it starts, and from then on has no alarm set.
  await cleared.hasAlarm();
  assert.equal(await cleared.hasAlarm(), false);
  assert.equal(replacedLines(), 1);
  assert.deepEqual(worker.logLines().filter((l) => l.includes('"roster_object_replaced"')).map((l) => l.slice(l.indexOf("{"))), [JSON.stringify({ event: "roster_object_replaced", object: clearedName })]);
  // The roster is empty at once: no record, nothing published, the card is unknown, the pages say the new date.
  assert.deepEqual(await published(), { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT });
  assert.equal((await cardState(worker, card)).count, 0);
  assert.equal(await clearedOn(), "2026-11-21");

  // Step 3: roster/ of the bucket is emptied; crl/ is left as it is.
  for (const file of await worker.files("roster/")) await worker.deleteFile(file.key);
  assert.deepEqual(await worker.files("crl/"), archive);

  // The new object knows no CRL until the mirror's next round, which tells it the ones the archive index lists.
  assert.deepEqual(await worker.newestCrls(), { G2: [], G3: [] });
  await worker.runSchedule();
  assert.equal((await worker.newestCrls()).G3[0]?.root, root);
  const first = (await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first")) as { seq?: unknown };
  assert.equal(first.seq, 1);

  // The next midnight in Taiwan. The alarm of the cleared roster's object rings as it was set to: it writes nothing.
  await worker.setClock(tw("2026-11-22", "00:00:00"));
  await cleared.runAlarm();
  assert.deepEqual([...(await directory()).keys()], []);
  // The new roster is published: its one record, and a fingerprint file of its one line.
  await worker.roster.runAlarm();
  const now = await directory();
  assert.deepEqual([...now.keys()], ["0000000000000000.jsonl", "card-state/2026-11-22.jsonl", "fingerprints.jsonl", "hashes/0000000000000000.txt"]);
  const line = await published();
  assert.deepEqual([line.date, line.count], ["2026-11-22", 1]);
  assert.equal(text(now.get("fingerprints.jsonl")!), fingerprintLine({ date: parseDay("2026-11-22")!, count: 1, fingerprint: line.fingerprint }));
  assert.equal((await checkRoster(worker)).length, 1);

  // And so on every later date: the cleared roster's object stays silent.
  await worker.setClock(tw("2026-11-23", "00:00:00"));
  await cleared.runAlarm();
  assert.deepEqual(await directory(), now);
  await worker.roster.runAlarm();
  assert.equal(text((await directory()).get("fingerprints.jsonl")!).split("\n").length - 1, 2);
  assert.deepEqual(worker.logLines().filter((l) => l.includes("fingerprint_file_differs") || l.includes("roster_not_published")), []);
  // The new object never said it was replaced; the old one said it the one time it started.
  assert.equal(await cleared.hasAlarm(), false);
  assert.equal(replacedLines(), 1);
});

test("the date wrangler.jsonc says the test roster was last cleared on is not after today", () => {
  // It is the date of the deploy that cleared it (README.md, step 1): a date still to come was typed wrong.
  const clearedOn = parseDay(String(unstable_readConfig({ config: join(WORKER_DIR, "wrangler.jsonc"), env: "test" }, { hideWarnings: true }).vars.TEST_ROSTER_CLEARED_ON));
  assert.ok(clearedOn !== null && clearedOn <= taiwanDay(Date.now()), "TEST_ROSTER_CLEARED_ON is a date, today's in Taiwan or an earlier one");
});

test("roster/ emptied only after the next midnight: nothing is published until then, and the next try after it publishes", async () => {
  const clearedName = await freshRoster(worker);
  await worker.fetch("/api/v1/fingerprint");
  await worker.setClock(tw("2026-11-21", "00:00:00"));
  await worker.roster.runAlarm();
  const old = await directory();
  assert.deepEqual([...old.keys()], ["card-state/2026-11-21.jsonl", "fingerprints.jsonl"]);

  // Steps 1 and 2, on 2026-11-21; step 3 is not done.
  await worker.setClock(tw("2026-11-21", "10:00:00"));
  await worker.setSettings({ ROSTER_KIND: "test", ROSTER_OBJECT_NAME: `${clearedName}-cleared`, TEST_ROSTER_CLEARED_ON: "2026-11-21" });
  await worker.clearedRoster(clearedName).restart();
  assert.deepEqual(await published(), { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT });

  // Midnight: the fingerprint file in the bucket is not the new object's. It writes nothing, and says so.
  const differs = (): number => worker.logLines().filter((l) => l.includes('"fingerprint_file_differs"')).length;
  const before = differs();
  await worker.setClock(tw("2026-11-22", "00:00:00"));
  await worker.roster.runAlarm();
  assert.deepEqual(await directory(), old);
  assert.equal(differs(), before + 1);
  assert.deepEqual(await published(), { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT });

  // Step 3, late. The next try publishes: no deploy, no restart.
  for (const file of await worker.files("roster/")) await worker.deleteFile(file.key);
  await worker.setClock(tw("2026-11-22", "09:00:00"));
  await worker.roster.runAlarm();
  const now = await directory();
  assert.deepEqual([...now.keys()], ["card-state/2026-11-22.jsonl", "fingerprints.jsonl"]);
  assert.equal(text(now.get("fingerprints.jsonl")!), fingerprintLine({ date: parseDay("2026-11-22")!, count: 0, fingerprint: EMPTY_FINGERPRINT }));
});
