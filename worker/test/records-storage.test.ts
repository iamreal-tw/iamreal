// What the roster's Durable Object keeps between records, seen through the
// Worker's HTTP (test/harness.ts): records submitted at once get consecutive
// `seq`s; an object stopped between every two writes decides as one that
// kept running; a write that fails in the middle leaves nothing; a state
// computed by another version of the rules pauses the roster; and every
// case of spec/vectors/roster-rules.json, run on the object's stored state,
// gives what the same rules give with their state in memory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Day, formatDay, parseDay } from "iamreal-protocol/date.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { MemoryRules } from "iamreal-protocol/rules-memory.ts";
import type { CardState } from "iamreal-protocol/roster-rules.ts";
import { WORKER_DIR } from "./build.ts";
import { type RuleEvent, type TestWorker, startWorker } from "./harness.ts";
import { type Answer, type Submission, TEST_SCOPE, cardState, checkRoster, day, freshRoster, list, mustSubmit, newCard, publishG3, sub, submit, wantError } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

const count = async (): Promise<unknown> => (await cardState(worker, newCard())).count;

describe("records submitted at once", () => {
  test("20 requests at the same moment: 20 records, their `seq`s 1 to 20, each once", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const submissions: Submission[] = [];
    for (let i = 0; i < 20; i++) submissions.push(await sub(worker, newCard(), root, "threads:alice"));
    const answers = await Promise.all(submissions.map((s) => submit(worker, s)));
    for (const a of answers) assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual(answers.map((a) => a.body.seq as number).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(new Set(answers.map((a) => a.body.record_hash)).size, 20);
    // Each record was applied to the state the one before it left: the cards that declare the account, counted one by one.
    assert.deepEqual(answers.map((a) => [a.body.seq, a.body.kinds[0].account_cards]).sort((x, y) => x[0] - y[0]), Array.from({ length: 20 }, (_, i) => [i + 1, i + 1]));
    assert.equal(await count(), 20);
    for (const s of submissions) assert.equal((await cardState(worker, s.scoped_id)).proofs_on_last_date, 1);
    // What is stored is a roster file with its hashes and fingerprints, and each line is the submission that was answered with its `seq`.
    const stored = await checkRoster(worker);
    assert.equal(stored.length, 20);
    for (const [i, s] of submissions.entries()) {
      const { seq, ...fields } = stored[answers[i]!.body.seq - 1]!;
      assert.deepEqual(fields, { scopeString: s.scope_string, scopedId: s.scoped_id, accounts: s.accounts, challenge: s.challenge, issuer: s.issuer, smtRoot: s.smt_root, circuit: s.circuit, proof: s.proof });
      assert.equal(seq, answers[i]!.body.seq);
    }
    assert.deepEqual((await worker.roster.stored()).records.map((r) => r.record_hash).sort(), answers.map((a) => a.body.record_hash as string).sort());
  });

  test("20 requests at the same moment, each giving way to the others while its record is hashed: still 20 records, `seq`s 1 to 20, a roster file that checks", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const submissions: Submission[] = [];
    for (let i = 0; i < 20; i++) submissions.push(await sub(worker, newCard(), root, "threads:alice"));
    // In the local workerd, hashing a record does not let another request in, so the case above never
    // has two requests holding the same count. Here every hash waits 5 ms first, which does let them in.
    await worker.roster.setHashDelay(5);
    const answers = await Promise.all(submissions.map((s) => submit(worker, s)));
    for (const a of answers) assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual(answers.map((a) => a.body.seq as number).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepEqual(answers.map((a) => [a.body.seq, a.body.kinds[0].account_cards]).sort((x, y) => x[0] - y[0]), Array.from({ length: 20 }, (_, i) => [i + 1, i + 1]));
    const stored = await checkRoster(worker);
    assert.equal(stored.length, 20);
    for (const [i, s] of submissions.entries()) assert.equal(stored[answers[i]!.body.seq - 1]!.scopedId, s.scoped_id);
    assert.deepEqual((await worker.roster.stored()).records.map((r) => r.record_hash).sort(), answers.map((a) => a.body.record_hash as string).sort());
    // The requests did cross: some record was hashed for a `seq` another one took, and hashed again.
    assert.ok((await worker.roster.hashes()) > 20);

    // One challenge twice, crossing in the same way: both passed the first look at the challenge, and one is written.
    const twice = await sub(worker, newCard(), root, "threads:alice");
    const two = await Promise.all([submit(worker, twice), submit(worker, { ...twice, scoped_id: newCard() })]);
    assert.deepEqual(two.map((a) => a.status).sort(), [201, 400], JSON.stringify(two.map((a) => a.body)));
    assert.deepEqual(two.find((a) => a.status === 400)!.body, { error: "challenge_used" });
    assert.equal((await checkRoster(worker)).length, 21);
  });

  test("20 requests of one card at the same moment: 3 records of that date, and 17 times daily_limit", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const card = newCard();
    const submissions: Submission[] = [];
    for (let i = 0; i < 20; i++) submissions.push(await sub(worker, card, root, `threads:a${i}`));
    const answers = await Promise.all(submissions.map((s) => submit(worker, s)));
    assert.deepEqual(answers.filter((a) => a.status === 201).map((a) => a.body.seq as number).sort(), [1, 2, 3]);
    for (const a of answers) if (a.status !== 201) assert.deepEqual(a, { status: 400, body: { error: "daily_limit" } });
    assert.equal(await count(), 3);
    assert.equal((await cardState(worker, card)).proofs_on_last_date, 3);
    assert.equal((await checkRoster(worker)).length, 3);
  });
});

describe("an object that is stopped between every two writes", () => {
  /** Fixed cards and fixed challenges, so that two runs write the same records. */
  const CARDS = ["QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880", "00001W4KYQGM74BGQ5WMHT1K51ENH0C1PS2N1E19M0RY2WJECGR0", "0400000000000000000000000000000000000000000000000000"];
  /** Each step: the day, the card, its list. Among them every kind, a correction, a sixth switch, an empty list and a fourth record of a date. */
  const STEPS: [number, number, string[]][] = [
    [0, 0, ["threads:a"]],
    [0, 0, ["threads:b"]],
    [0, 1, ["test-example:x", "threads:b"]],
    [0, 2, []],
    [1, 0, ["threads:c"]],
    [1, 1, ["threads:b"]],
    [2, 0, ["threads:d"]],
    [3, 0, ["threads:e"]],
    [3, 0, ["test-example:x", "threads:e"]],
    [3, 0, ["test-example:y", "threads:e"]],
    [3, 0, ["threads:e"]],
    [4, 0, ["threads:f"]],
    [5, 0, ["threads:g"]],
    [6, 0, ["threads:h"]],
    [6, 1, []],
    [6, 0, []],
    [6, 2, ["threads:b"]],
  ];

  async function run(restart: boolean): Promise<{ answers: Answer[]; states: unknown[] }> {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const answers: Answer[] = [];
    let today = 0;
    for (const [i, [onDay, card, accounts]] of STEPS.entries()) {
      if (onDay > today) await day(worker, (today = onDay));
      const random = (0x1000 + i).toString(16).padStart(32, "0");
      const s: Submission = { ...(await sub(worker, CARDS[card]!, root, ...accounts)), challenge: await worker.issueChallenge(random) };
      if (restart) await worker.roster.restart();
      answers.push(await submit(worker, s));
      if (restart) await worker.roster.restart();
    }
    return { answers, states: await Promise.all(CARDS.map((c) => cardState(worker, c))) };
  }

  test("answers every submission as one that kept running, and leaves every card in the same state", async () => {
    const kept = await run(false);
    const stopped = await run(true);
    assert.deepEqual(stopped, kept);
    // The run is not one where everything is refused, or everything accepted.
    const codes = kept.answers.map((a) => (a.status === 201 ? "written" : (a.body.error as string)));
    assert.deepEqual([...new Set(codes)].sort(), ["daily_limit", "empty", "switch_limit", "written"]);
    assert.equal((kept.states[0] as { count: number }).count, codes.filter((c) => c === "written").length);
  });
});

describe("a write that fails in the middle", () => {
  // In the order the record is written: its line, the card, the roster's row, the mark on the challenge. The last, `challenges`,
  // fails earlier: when the submission is counted, before the proof is looked at.
  for (const table of ["records", "cards", "roster", "challenges.accepted", "challenges"] as const) {
    test(`at \`${table}\`: 500, and the record, the card's state and the challenge are as before`, async () => {
      await freshRoster(worker);
      const root = await publishG3(worker);
      const card = newCard();
      await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
      const before = await cardState(worker, card);

      const s = await sub(worker, card, root, "test-example:a-b", "threads:bob");
      await worker.roster.failWritesTo(table);
      const logged = worker.logLines().length;
      const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(s) });
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(await res.text()), { error: "internal" });
      assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", id: res.headers.get("X-Request-Id"), endpoint: "/api/v1/records", where: "roster", error: "Error" }]);
      assert.deepEqual(await cardState(worker, card), before);

      await worker.roster.failWritesTo(null);
      await worker.roster.restart();
      assert.deepEqual(await cardState(worker, card), before);
      // The challenge was not marked: the same submission is now written, as the second record.
      const answer = await submit(worker, s);
      assert.equal(answer.status, 201, JSON.stringify(answer.body));
      assert.equal(answer.body.seq, 2);
      assert.deepEqual(answer.body.kinds, [
        { platform: "test-example", kind: "first", username: "a-b", account_cards: 1 },
        { platform: "threads", kind: "correction", username: "bob", account_cards: 1 },
      ]);
      await wantError(worker, s, 400, "challenge_used");
    });
  }
});

describe("a failure after the roster rules accepted the record", () => {
  test("counting the cards of the account fails on another card's broken row: 500, and the record is not written without its answer", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const broken = newCard();
    await mustSubmit(worker, await sub(worker, broken, root, "threads:alice"), "threads first");
    const card = newCard();
    const s = await sub(worker, card, root, "threads:alice");
    // The answer of a `201` counts the cards that declare the account, which reads the row of every card of the scope.
    await worker.roster.breakCard(broken);
    const logged = worker.logLines().length;
    const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(s) });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(await res.text()), { error: "internal" });
    assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", id: res.headers.get("X-Request-Id"), endpoint: "/api/v1/records", where: "roster", error: "Error" }]);
    assert.equal((await checkRoster(worker)).length, 1);
    assert.equal((await cardState(worker, card)).last_card_proof, null);

    // With the row as the rules left it, the same submission is written: its challenge was not marked.
    await worker.roster.writeCard({ scope_string: TEST_SCOPE, scoped_id: broken, seq: 1, last_card_proof: "2026-11-20", proofs_on_last_date: 1, platforms: { threads: { current: "alice", last_declared: "alice", switch_count: 0, correction_date: "2026-11-20" } } });
    const answer = await submit(worker, s);
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    assert.deepEqual([answer.body.seq, answer.body.kinds], [2, [{ platform: "threads", kind: "first", username: "alice", account_cards: 2 }]]);
    assert.equal((await checkRoster(worker)).length, 2);
  });
});

describe("a stored state computed by another version of the roster rules", () => {
  test("challenges and records are 503 paused and nothing is written; card-state and config go on; with the build's version again, so does everything", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const card = newCard();
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    const s = await sub(worker, card, root, "threads:bob");
    const before = await cardState(worker, card);

    await worker.roster.setStoredRulesVersion("another");
    await worker.roster.restart();
    const logged = worker.logLines().length;
    const challenge = await worker.fetch("/api/v1/challenges", { method: "POST" });
    assert.deepEqual([challenge.status, JSON.parse(await challenge.text())], [503, { error: "paused" }]);
    // More often than a challenge can be submitted: none of these counts (see the end).
    for (let i = 0; i < 6; i++) await wantError(worker, s, 503, "paused");
    // Paused comes before the challenge: one this roster never issued gets the same answer, not `challenge_unknown`.
    await wantError(worker, { ...s, challenge: `2026-11-20.${"0".repeat(26)}` }, 503, "paused");
    // What is wrong with the request itself is still said first: that needs no roster.
    await wantError(worker, { ...s, issuer: "G4" }, 400, "malformed");
    await wantError(worker, { ...s, accounts: list("instagram:alice") }, 400, "platform");
    assert.deepEqual(await cardState(worker, card), before);
    assert.equal((await worker.fetch("/api/v1/config")).status, 200);
    // Not a failure of the back end: no line.
    assert.deepEqual(worker.logLines().slice(logged), []);

    await worker.roster.setStoredRulesVersion("the build's");
    await worker.roster.restart();
    // The refused submissions were not counted, and the challenge is still the one issued before.
    await mustSubmit(worker, s, "threads correction");
    assert.equal(await count(), 2);
  });
});

describe("spec/vectors/roster-rules.json on the object's stored state", () => {
  interface Case {
    readonly name: string;
    readonly roster: "production" | "test";
    readonly events: (RuleEvent & { date: string })[];
    readonly results: { seq: number; valid: boolean; reason?: string; kinds?: unknown }[];
    readonly state: { scope_string: string; cards: { scoped_id: string; last_card_proof: string; proofs_on_last_date: number; slots: Record<string, unknown> }[] }[];
  }
  const { cases } = JSON.parse(readFileSync(join(WORKER_DIR, "..", "spec", "vectors", "roster-rules.json"), "utf8")) as { cases: Case[] };
  const dateText = (d: Day | null): string | null => (d === null ? null : formatDay(d));
  /** A card's state from memory, in the spelling of `card-state`'s answer without `count`. */
  const answerOf = (card: CardState): Record<string, unknown> => ({
    last_card_proof: dateText(card.lastCardProof),
    proofs_on_last_date: card.proofsOnLastDate,
    platforms: Object.fromEntries([...card.slots].map(([p, s]) => [p, { current: s.current, last_declared: s.lastDeclared, switch_count: s.switchCount, correction_date: dateText(s.correctionDate) }])),
  });
  const stored = async (scope: string, card: string): Promise<Record<string, unknown>> => {
    const { count: _, ...state } = await cardState(worker, card, scope);
    return state;
  };

  test("every case: each record's result is the vectors', and after each record the card's stored state is the one in memory; the object is stopped between every two records", async () => {
    assert.ok(cases.length >= 61);
    let events = 0;
    for (const c of cases) {
      await freshRoster(worker, { kind: c.roster });
      const memory = new MemoryRules(platformsOf(c.roster));
      for (const [i, e] of c.events.entries()) {
        const what = `${c.name}, event ${e.seq}`;
        const { seq, ...want } = c.results[i]!;
        assert.equal(seq, e.seq, what);
        const inMemory = memory.apply({ scopeString: e.scope_string, scopedId: e.scoped_id, challenge: e.challenge, accounts: e.accounts, verifies: e.verifies, crlDates: e.crl_dates.map((d) => parseDay(d)!) });
        const { valid, reason, kinds } = await worker.roster.applyRuleEvent(e);
        assert.deepEqual(valid ? { valid, kinds } : { valid, reason }, want, what);
        assert.deepEqual(valid ? { valid, kinds } : { valid, reason }, inMemory.result.valid ? inMemory.result : { valid: false, reason: inMemory.result.reason }, what);
        await worker.roster.restart();
        assert.deepEqual(await stored(e.scope_string, e.scoped_id), answerOf(memory.card(e.scope_string, e.scoped_id)), what);
        events++;
      }
      // The state at the end is the one the vectors give.
      for (const scope of c.state) {
        for (const card of scope.cards) {
          assert.deepEqual(await stored(scope.scope_string, card.scoped_id), { last_card_proof: card.last_card_proof, proofs_on_last_date: card.proofs_on_last_date, platforms: card.slots }, `${c.name}, card ${card.scoped_id}`);
        }
      }
    }
    assert.ok(events >= 287);
  });
});
