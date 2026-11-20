// The whole way, with Go's re-verifying command at the end (#70): fake
// cards write a roster that crosses 1,000 records twice and the date three
// times; the back end publishes it day by day, and the mirror fills the CRL
// archive from a fake MOICA. Then `iamreal-verify`, as it runs by default
// (`-data`), re-verifies everything the back end wrote to the bucket: the
// roster directory, the record hash lists, the fingerprint file, the card
// state file of the last day, the CRL archive.
//
// The records carry placeholder proofs (the stand-in verifier here, the
// fake one of cmd/iamreal-verify's tests there): proofs are compared
// elsewhere (compare.test.ts, records-real.test.ts). Everything else is
// each side's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { parseDay } from "iamreal-protocol/date.ts";
import { EMPTY_FINGERPRINT, LINES_PER_FILE, fingerprintLine, hashListName, nextFingerprint, recordHash, rosterFileName } from "iamreal-protocol/record.ts";
import { WORKER_DIR } from "./build.ts";
import { testIssuerSpki } from "./crls.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { IMMUTABLE, type Submission, TEST_SCOPE, cardState, checkRoster, day, freshRoster, mustSubmit, newCard, publishG3, sub, submit, tw } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

// Without go this is skipped on a developer's machine; where it must run (CI, which GitHub Actions sets, or
// IAMREAL_BB), a missing go is a failure, as in sequence.test.ts.
const hasGo = spawnSync("go", ["version"]).status === 0;
const goRequired = Boolean(process.env.CI) || Boolean(process.env.IAMREAL_BB);
const MINUTE = "public, max-age=60";

describe("a roster published over three days, re-verified by Go's iamreal-verify as it runs by default", { skip: !hasGo && !goRequired ? "go is not installed" : false }, () => {
  test("it passes: every record valid, every fingerprint and list the roster's, every card of the card state file the same", async () => {
    assert.ok(hasGo, "go is not installed, and CI or IAMREAL_BB is set: this must run here");
    await freshRoster(worker);
    const root = await publishG3(worker);
    /** Writes records until the roster has `upTo`: each a first card proof of a new card that declares `@alice`, 20 at a time. */
    const fillTo = async (upTo: number): Promise<void> => {
      for (let count = (await cardState(worker, newCard())).count as number; count < upTo; ) {
        const submissions: Submission[] = [];
        for (let i = 0; i < Math.min(20, upTo - count); i++) submissions.push(await sub(worker, newCard(), root, "threads:alice"));
        for (const answer of await Promise.all(submissions.map((s) => submit(worker, s)))) assert.equal(answer.status, 201, JSON.stringify(answer.body));
        count += submissions.length;
      }
    };
    /** The date changes in Taiwan, and the object's alarm rings ten seconds into it. */
    const midnight = async (date: string): Promise<void> => {
      await worker.setClock(tw(date, "00:00:10"));
      await worker.roster.runAlarm();
    };
    const fingerprintAt = new Map<number, string>();
    const noteFingerprint = async (): Promise<number> => {
      const { roster } = await worker.roster.stored();
      fingerprintAt.set(roster.count, roster.fingerprint);
      return roster.count;
    };

    // 2026-11-20: 998 records, among them cards that change their list on later days.
    const [corrects, switches, withdraws, both] = [newCard(), newCard(), newCard(), newCard()];
    for (const card of [corrects, switches, withdraws]) await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    await mustSubmit(worker, await sub(worker, both, root, "test-example:b-oth", "threads:both"), "test-example first, threads first");
    await mustSubmit(worker, await sub(worker, corrects, root, "threads:carol"), "threads correction");
    await fillTo(LINES_PER_FILE - 2);
    assert.equal(await noteFingerprint(), 998);
    await midnight("2026-11-21");

    // 2026-11-21: two records fill the first file, which is moved over the one published at midnight. The next
    // publication finds no last file to write.
    await day(worker, 1);
    await mustSubmit(worker, await sub(worker, switches, root, "threads:bob"), "threads switch");
    await mustSubmit(worker, await sub(worker, withdraws, root), "threads withdraw");
    await worker.roster.runAlarm();
    assert.equal(await noteFingerprint(), 1000);
    await midnight("2026-11-22");

    // 2026-11-22: a second file fills, and three records begin a third.
    await day(worker, 2);
    await mustSubmit(worker, await sub(worker, both, root, "threads:both"), "test-example withdraw, threads refresh");
    await fillTo(2 * LINES_PER_FILE + 2);
    await mustSubmit(worker, await sub(worker, switches, root, "threads:alice"), "threads switch");
    await worker.roster.runAlarm();
    assert.equal(await noteFingerprint(), 2003);

    // 2026-11-23: two records that no fingerprint line covers, written while the card state file of the date is being
    // written, after the publication's moment: one changes a card that is in the file, one is of a new card.
    await worker.setClock(tw("2026-11-23", "00:00:10"));
    const late = [await sub(worker, withdraws, root, "threads:dave"), await sub(worker, newCard(), root, "threads:alice")] as const;
    await worker.roster.setBucketFault({ key: "roster/card-state/2026-11-23.jsonl", how: "put takes a while" });
    const publishing = worker.roster.runAlarm();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await worker.files("roster/card-state/2026-11-23"), [], "the publication is writing the card state file");
    await mustSubmit(worker, late[0], "threads switch");
    await mustSubmit(worker, late[1], "threads first");
    await publishing;
    await worker.roster.setBucketFault(null);
    const records = await checkRoster(worker);
    assert.equal(records.length, 2005);

    // What the bucket holds: two full files, the third as it was at the last midnight, a card state file a day, three lines.
    const files = await worker.files();
    const names = files.map((f) => f.key);
    const lines = [
      ["2026-11-21", 998],
      ["2026-11-22", 1000],
      ["2026-11-23", 2003],
    ] as const;
    assert.deepEqual(
      names.filter((n) => n.startsWith("roster/")),
      [...[0, 1000, 2000].map((b) => `roster/${rosterFileName(b)}`), ...lines.map(([date]) => `roster/card-state/${date}.jsonl`), "roster/fingerprints.jsonl", ...[0, 1000, 2000].map((b) => `roster/${hashListName(b)}`)],
    );
    const fileOf = (key: string) => files.find((f) => f.key === key)!;
    assert.equal(new TextDecoder().decode(fileOf("roster/fingerprints.jsonl").bytes), lines.map(([date, count]) => fingerprintLine({ date: parseDay(date)!, count, fingerprint: fingerprintAt.get(count)! })).join(""));
    for (const f of files.filter((f) => f.key.startsWith("roster/"))) {
      const full = [0, 1000].some((b) => f.key === `roster/${rosterFileName(b)}` || f.key === `roster/${hashListName(b)}`);
      assert.equal(f.cacheControl, full ? IMMUTABLE : MINUTE, f.key);
    }
    assert.equal(new TextDecoder().decode(fileOf(`roster/${rosterFileName(2000)}`).bytes).split("\n").length - 1, 3, "the last file is the three records of the last midnight");

    // A copy of the bucket, and the issuer keys the CRLs of the fake MOICA are signed by.
    mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
    const out = mkdtempSync(join(WORKER_DIR, "test-output", "published-"));
    try {
      for (const f of files) {
        mkdirSync(dirname(join(out, "data", f.key)), { recursive: true });
        writeFileSync(join(out, "data", f.key), f.bytes);
      }
      mkdirSync(join(out, "issuers"));
      for (const issuer of ["G2", "G3"] as const) writeFileSync(join(out, "issuers", `issuer-${issuer}.der`), testIssuerSpki(issuer));
      const run = spawnSync("go", ["test", "-count=1", "-tags", "iamrealtest", "-run", "^TestWorkerData$", "./cmd/iamreal-verify"], { cwd: join(WORKER_DIR, ".."), env: { ...process.env, IAMREAL_WORKER_DATA: out }, encoding: "utf8" });
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const said = readFileSync(join(out, "verify.txt"), "utf8");
      const verified = JSON.parse(readFileSync(join(out, "verify.json"), "utf8")) as { valid: boolean; fingerprint: string; results: { seq: number; valid: boolean }[]; state: { scope_string: string; cards: { scoped_id: string; last_card_proof: string; accounts: { platform: string; username: string }[] }[] }[] };

      // It passes, having checked what the last line covers: 2,003 records, each valid, with the fingerprint they give.
      assert.equal(readFileSync(join(out, "verify.code"), "utf8"), "0", said);
      let fingerprint = EMPTY_FINGERPRINT;
      for (const record of records.slice(0, 2003)) fingerprint = await nextFingerprint(fingerprint, await recordHash(record));
      assert.equal(fingerprint, fingerprintAt.get(2003));
      assert.deepEqual([verified.valid, verified.fingerprint], [true, fingerprint]);
      assert.deepEqual(verified.results.map((r) => [r.seq, r.valid]), Array.from({ length: 2003 }, (_, i) => [i + 1, true]));
      // The fingerprint file, the lists, the CRL archive rebuilt from its CRLs, and the card state file of the last line's date.
      assert.match(said, /fingerprints\.jsonl: 3 line\(s\), every fingerprint is the roster's/);
      assert.match(said, /hashes\/: 3 list\(s\), every list is the roster's/);
      assert.match(said, /rebuilding/);
      const cards = verified.state.find((scope) => scope.scope_string === TEST_SCOPE)!.cards;
      assert.ok(said.includes(`card-state/2026-11-23.jsonl: count 2003 of fingerprints.jsonl, 2003 record(s) re-verified: ${cards.length} card(s) the same, 0 skipped\n`), said);
      assert.equal(cards.length, 2003 - 5, "every record but five is the first of its card");
      assert.deepEqual(said.split("\n").filter((line) => /different|missing|broken|differs|not the/.test(line)), []);

      // The state Go computed of the cards that changed their lists is what the back end answers for them (those the
      // two records after the last line did not touch).
      for (const card of [corrects, switches, both]) {
        const state = (await cardState(worker, card)) as { last_card_proof: string; platforms: Record<string, { current: string | null }> };
        const accounts = Object.keys(state.platforms).sort().flatMap((platform) => (state.platforms[platform]!.current === null ? [] : [{ platform, username: state.platforms[platform]!.current }]));
        assert.deepEqual(cards.find((c) => c.scoped_id === card), { scoped_id: card, last_card_proof: state.last_card_proof, accounts });
      }
      rmSync(out, { recursive: true, force: true });
    } catch (e) {
      throw new Error(`${e instanceof Error ? e.message : String(e)}\nThe copy of the bucket and what Go printed are kept in ${out}`, { cause: e });
    }
  });
});
