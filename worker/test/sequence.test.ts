// The roster rules over a long sequence of records (#73): Go's roster/ gives
// the answers, and protocol/'s rules, with their state in memory and with
// the state the roster's Durable Object stores, must give each record the
// same result and leave its card, the roster's latest valid date and the
// cards of each account the same. The sequence comes from a generator with
// a fixed seed (test/sequence.ts). worker/README.md says how to run it, what
// it compares, what it does not, and what it found (#9, item 8 of the
// conclusion: these are its second and third layers; the first is
// records-storage.test.ts, the vectors on the object's stored state).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, after, before, describe, test } from "node:test";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { formatDay, parseDay } from "iamreal-protocol/date.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { RULES_VERSION, type RecordResult } from "iamreal-protocol/roster-rules.ts";
import { MemoryRules, type OutputScope } from "iamreal-protocol/rules-memory.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { parseScopedId } from "iamreal-protocol/scoped-id.ts";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { cardState, freshRoster } from "./records.ts";
import {
  type AccountCount,
  type Answer,
  type CardJson,
  type Difference,
  type GoAnswers,
  KINDS,
  REASONS,
  type ResultJson,
  type Scenario,
  type Sequence,
  type SequenceEvent,
  type SlotJson,
  cardJsonOf,
  difference,
  firstDifference,
  generateSequence,
  scenarios,
  statistics,
} from "./sequence.ts";

/** The sequence compared: its seed and length. Another seed is another sequence; the counts it prints must still reach their floors. */
const SEED = 1;
const LENGTH = 10_000;
/** How often the roster's latest valid date and the cards of each account are compared on the Durable Object: after every this many records, and after the last. */
const CHECKPOINT_EVERY = 100;

/**
 * The floors of the scenarios (test/sequence.ts, `scenarios`): about three
 * quarters of what the sequence of seed 1 has, so that a small change of
 * the generator does not fail them and losing a case does.
 */
const SCENARIO_FLOORS: Record<Scenario, number> = {
  around_midnight: 630,
  more_than_4_days_back: 300,
  exactly_4_days_back_valid: 60,
  fifth_switch: 165,
  sixth_switch_blocked: 980,
  correction: 190,
  declared_again_after_withdrawing_all: 230,
  account_of_several_cards: 3300,
};

describe("generateSequence: the same seed, the same records", () => {
  test("two runs with one seed give the same events; another seed gives others", () => {
    const a = generateSequence({ seed: 7, length: 500 });
    assert.deepEqual(generateSequence({ seed: 7, length: 500 }), a);
    assert.notDeepEqual(generateSequence({ seed: 8, length: 500 }), a);
    // A longer run starts with the same records.
    assert.deepEqual(generateSequence({ seed: 7, length: 600 }).events.slice(0, 500), a.events);
  });

  test("every event is a well-formed record of the test roster: seq from 1, its date the challenge's, a list in the table's order and formats", () => {
    const { roster, events } = generateSequence({ seed: 7, length: 2000 });
    assert.equal(roster, "test");
    const table = platformsOf("test");
    events.forEach((e, i) => {
      assert.equal(e.seq, i + 1);
      assert.equal(e.scope_string, scopeOf("test"));
      assert.notEqual(parseScopedId(e.scoped_id), null, e.scoped_id);
      const d = parseChallenge(e.challenge);
      assert.notEqual(d, null, e.challenge);
      assert.equal(formatDay(d!), e.date);
      for (const c of e.crl_dates) assert.notEqual(parseDay(c), null, c);
      const platforms = e.accounts.map((a) => a.platform);
      assert.deepEqual(platforms, table.map((p) => p.platform).filter((p) => platforms.includes(p)), `seq ${e.seq}`);
      for (const a of e.accounts) assert.ok(table.find((p) => p.platform === a.platform)!.format.accepts(a.username), a.username);
    });
  });
});

const answer = (): Answer => ({
  result: { valid: true, kinds: [{ platform: "threads", kind: "switch" }] },
  card: {
    last_card_proof: "2026-03-02",
    proofs_on_last_date: 1,
    slots: {
      "test-example": { current: null, last_declared: null, switch_count: 0, correction_date: null },
      threads: { current: "bob", last_declared: "bob", switch_count: 1, correction_date: "2026-03-02" },
    },
  },
});

describe("firstDifference: which field of a record's answer differs", () => {
  test("the same answer: none", () => {
    assert.equal(firstDifference(answer(), answer()), null);
  });

  test("a slot's item: its path, with both values", () => {
    const got = answer();
    got.card.slots.threads!.switch_count = 2;
    assert.deepEqual(firstDifference(answer(), got), { field: "card.slots.threads.switch_count", want: 1, got: 2 });
  });

  test("the result: valid against invalid, then the reason, then the kinds", () => {
    assert.deepEqual(firstDifference(answer(), { ...answer(), result: { valid: false, reason: "daily_limit" } }), { field: "result.valid", want: true, got: false });
    assert.deepEqual(firstDifference({ ...answer(), result: { valid: false, reason: "root" } }, { ...answer(), result: { valid: false, reason: "date_order" } }), { field: "result.reason", want: "root", got: "date_order" });
    assert.deepEqual(firstDifference(answer(), { ...answer(), result: { valid: true, kinds: [{ platform: "threads", kind: "correction" }] } }), { field: "result.kinds[0].kind", want: "switch", got: "correction" });
  });

  test("a slot one side does not have, an item one side does not have", () => {
    const got = answer();
    delete got.card.slots["test-example"];
    assert.deepEqual(firstDifference(answer(), got), { field: 'card.slots["test-example"]', want: { current: null, last_declared: null, switch_count: 0, correction_date: null }, got: undefined });
    assert.deepEqual(firstDifference(answer(), { ...answer(), result: { valid: true, kinds: [] } }), { field: "result.kinds[0]", want: { platform: "threads", kind: "switch" }, got: undefined });
  });
});

describe("statistics: the reason codes and kinds of a sequence's results", () => {
  test("every code and kind is listed, also with 0; kinds are counted once per platform", () => {
    const s = statistics([
      { valid: false, reason: "root" },
      { valid: true, kinds: [{ platform: "test-example", kind: "withdraw" }, { platform: "threads", kind: "first" }] },
      { valid: true, kinds: [{ platform: "threads", kind: "refresh" }] },
    ]);
    assert.equal(s.valid, 2);
    assert.deepEqual(s.reasons, { proof: 0, challenge_reused: 0, root: 1, date_order: 0, empty: 0, switch_limit: 0, daily_limit: 0 });
    assert.deepEqual(s.kinds, { first: 1, refresh: 1, correction: 0, switch: 0, withdraw: 1 });
    assert.deepEqual(s.byPlatform, { "test-example withdraw": 1, "threads first": 1, "threads refresh": 1 });
  });
});

describe("scenarios: the cases a sequence must hold often, counted from its events and Go's answers", () => {
  const slot = (current: string | null, lastDeclared = current, switchCount = 0): SlotJson => ({ current, last_declared: lastDeclared, switch_count: switchCount, correction_date: lastDeclared === null ? null : "2026-03-01" });
  const card = (lastCardProof: string | null, threads: SlotJson): CardJson => ({ last_card_proof: lastCardProof, proofs_on_last_date: 1, slots: { "test-example": slot(null), threads } });
  const event = (seq: number, scopedId: string, date: string, username?: string): SequenceEvent => ({
    seq,
    scope_string: scopeOf("test"),
    scoped_id: scopedId,
    accounts: username === undefined ? [] : [{ platform: "threads", username }],
    challenge: `${date}.00000000000000000000000000`,
    date,
    verifies: true,
    crl_dates: [date],
  });
  const kinds = (kind: string): ResultJson => ({ valid: true, kinds: [{ platform: "threads", kind }] });

  test("each case where it happens, and only there", () => {
    const events = [
      event(1, "A", "2026-03-05", "alice"),
      event(2, "B", "2026-03-04", "alice"), // a day back: around midnight; alice now has two cards
      event(3, "C", "2026-03-01", "bob"), // 4 days back, valid
      event(4, "D", "2026-02-28", "bob"), // 5 days back
      event(5, "A", "2026-03-05"), // A withdraws everything
      event(6, "A", "2026-03-06", "alice"), // and declares again; alice has two cards again
      event(7, "C", "2026-03-06", "carol"), // the fifth switch
      event(8, "C", "2026-03-07", "dave"), // the sixth, blocked
      event(9, "C", "2026-03-06", "erin"), // a correction
    ];
    const results: ResultJson[] = [kinds("first"), kinds("first"), kinds("first"), { valid: false, reason: "date_order" }, kinds("withdraw"), kinds("refresh"), kinds("switch"), { valid: false, reason: "switch_limit" }, kinds("correction")];
    const cards = [
      card("2026-03-05", slot("alice")),
      card("2026-03-04", slot("alice")),
      card("2026-03-01", slot("bob")),
      card(null, slot(null)),
      card("2026-03-05", slot(null, "alice")),
      card("2026-03-06", slot("alice")),
      card("2026-03-06", slot("carol", "carol", 5)),
      card("2026-03-06", slot("carol", "carol", 5)),
      card("2026-03-06", slot("erin", "erin", 5)),
    ];
    const latest = ["2026-03-05", "2026-03-05", "2026-03-05", "2026-03-05", "2026-03-05", "2026-03-06", "2026-03-06", "2026-03-06", "2026-03-06"];
    assert.deepEqual(scenarios(events, { results: results.map((r, i) => ({ ...r, seq: i + 1 })), cards: cards.map((c, i) => ({ ...c, scope_string: scopeOf("test"), scoped_id: events[i]!.scoped_id })), latest_valid_dates: latest }), {
      around_midnight: 1,
      more_than_4_days_back: 1,
      exactly_4_days_back_valid: 1,
      fifth_switch: 1,
      sixth_switch_blocked: 1,
      correction: 1,
      declared_again_after_withdrawing_all: 1,
      account_of_several_cards: 2,
    });
  });
});

// The answers come from Go. Without go the comparison is skipped on a
// computer; where the whole check is expected (CI, which GitHub Actions
// sets, or IAMREAL_BB), a missing go is a failure, as in workflows.test.ts.
const hasGo = spawnSync("go", ["version"]).status === 0;
const goRequired = Boolean(process.env.CI) || Boolean(process.env.IAMREAL_BB);
const skip = !hasGo && !goRequired ? "go is not installed: no answers from Go's roster/" : false;

// The run on the Durable Object's storage takes about 107 s, nearly all the
// time of this file, so it runs only when asked for: IAMREAL_SEQUENCE_STORAGE=1.
// The run in memory (under a second) runs with every `pnpm test`. When to ask
// for it is in README.md, "名冊規則和 Go 的 roster/ 逐筆比對".
const storageSkip = process.env.IAMREAL_SEQUENCE_STORAGE === "1" ? false : "IAMREAL_SEQUENCE_STORAGE is not 1: the run on the Durable Object's storage (about 107 s) is not asked for";

/** protocol/'s result without the explanation for people (`blockedPlatform`): the reason code is the whole result of an invalid record. */
const resultOf = (r: RecordResult): ResultJson => (r.valid ? { valid: true, kinds: r.kinds } : { valid: false, reason: r.reason });

/** Every account of the output with its number of cards, in the spelling of Go's checkpoints. */
const accountCounts = (scopes: readonly OutputScope[]): AccountCount[] =>
  scopes.flatMap((s) => s.accounts.map((a) => ({ scope_string: s.scopeString, platform: a.platform, username: a.username, account_cards: a.cards.length })));

describe(`a sequence of ${LENGTH} records of seed ${SEED}: Go's roster/ gives the answers`, { skip }, () => {
  let dir: string | undefined;
  let sequence: Sequence;
  let go: GoAnswers;
  let worker: TestWorker | undefined;
  let goMs = 0;
  /** Whether anything of this suite failed: the files are kept then, and deleted otherwise. */
  let failed = false;

  /** A test of this suite: a failure keeps the files. */
  const check = (name: string, fn: (t: TestContext) => void | Promise<void>, options: { skip?: string | false } = {}): void => {
    test(name, options, async (t) => {
      try {
        await fn(t);
      } catch (err) {
        failed = true;
        throw err;
      }
    });
  };
  const kept = (): string => `The events and Go's answers are kept in ${dir}`;

  before(() => {
    // Until Go's answers are read, a failure here keeps the files.
    failed = true;
    sequence = generateSequence({ seed: SEED, length: LENGTH, checkpointEvery: CHECKPOINT_EVERY });
    const output = join(WORKER_DIR, "test-output");
    mkdirSync(output, { recursive: true });
    dir = mkdtempSync(join(output, "sequence-"));
    writeFileSync(join(dir, "events.json"), JSON.stringify(sequence));
    assert.ok(hasGo, `go is not installed, and CI or IAMREAL_BB is set: this comparison must run here. ${kept()}`);
    const started = performance.now();
    const run = spawnSync("go", ["test", "-count=1", "-run", "^TestSequenceAnswers$", "./roster"], { cwd: join(WORKER_DIR, ".."), env: { ...process.env, IAMREAL_ROSTER_SEQUENCE: dir }, encoding: "utf8" });
    goMs = performance.now() - started;
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}\n${kept()}`);
    go = JSON.parse(readFileSync(join(dir, "answers.json"), "utf8")) as GoAnswers;
    failed = false;
  });
  after(async () => {
    await worker?.close();
    if (dir !== undefined && !failed) rmSync(dir, { recursive: true, force: true });
  });

  /** Go's answer for the i-th record, in the shape compared. */
  const goAnswer = (i: number): Answer => {
    const { valid, kinds, reason } = go.results[i]!;
    const { last_card_proof, proofs_on_last_date, slots } = go.cards[i]!;
    return { result: { valid, ...(kinds && { kinds }), ...(reason && { reason }) }, card: { last_card_proof, proofs_on_last_date, slots } };
  };
  /** Fails, naming the record, its card, the field and both values. */
  const fail = (side: string, i: number, e: SequenceEvent, d: Difference): never =>
    assert.fail(`record ${i + 1} of ${LENGTH} (seq ${e.seq}), card ${e.scoped_id}, ${d.field}: Go ${JSON.stringify(d.want)}, ${side} ${JSON.stringify(d.got)}. ${kept()}`);
  /** The accounts Go lists after the record with this seq, if it is a checkpoint. */
  const checkpoint = (seq: number): AccountCount[] | undefined => go.checkpoints.find((c) => c.after === seq)?.accounts;

  check("Go answered every event, by the version of the rules protocol/ has", (t) => {
    t.diagnostic(`Go's answers, compiling its test included: ${Math.round(goMs)} ms`);
    assert.equal(go.rules_version, RULES_VERSION);
    assert.deepEqual(go.events, sequence.events);
    assert.equal(go.results.length, LENGTH);
    assert.equal(go.cards.length, LENGTH);
    assert.equal(go.latest_valid_dates.length, LENGTH);
    assert.deepEqual(
      go.checkpoints.map((c) => c.after),
      [...Array(LENGTH / CHECKPOINT_EVERY).keys()].map((i) => (i + 1) * CHECKPOINT_EVERY),
    );
    go.results.forEach((r, i) => assert.equal(r.seq, i + 1));
    go.cards.forEach((c, i) => assert.equal(c.scoped_id, sequence.events[i]!.scoped_id));
  });

  check("every reason code, every kind on every platform and every scenario often enough", (t) => {
    const s = statistics(go.results);
    t.diagnostic(`valid ${s.valid}, invalid ${LENGTH - s.valid}`);
    for (const [k, n] of Object.entries(s.reasons)) t.diagnostic(`reason ${k}: ${n}`);
    for (const [k, n] of Object.entries(s.kinds)) t.diagnostic(`kind ${k}: ${n}`);
    for (const [k, n] of Object.entries(s.byPlatform).sort()) t.diagnostic(`  ${k}: ${n}`);
    const found = scenarios(sequence.events, go);
    for (const [k, n] of Object.entries(found)) t.diagnostic(`scenario ${k}: ${n} (at least ${SCENARIO_FLOORS[k as Scenario]})`);
    for (const r of REASONS) assert.ok(s.reasons[r]! >= 100, `${r}: ${s.reasons[r]}`);
    for (const { platform } of platformsOf("test")) {
      for (const k of KINDS) assert.ok((s.byPlatform[`${platform} ${k}`] ?? 0) >= 100, `${platform} ${k}: ${s.byPlatform[`${platform} ${k}`]}`);
    }
    for (const [k, n] of Object.entries(found)) assert.ok(n >= SCENARIO_FLOORS[k as Scenario], `${k}: ${n}`);
  });

  check("with the state in memory (MemoryRules): every record's result, its card and the latest valid date after it, the cards of each account at every checkpoint, and the final state are Go's", (t) => {
    const started = performance.now();
    const memory = new MemoryRules(platformsOf("test"));
    sequence.events.forEach((e, i) => {
      const o = memory.apply({ scopeString: e.scope_string, scopedId: e.scoped_id, challenge: e.challenge, accounts: e.accounts, verifies: e.verifies, crlDates: e.crl_dates.map((d) => parseDay(d)!) });
      const latest = memory.latestValidDate === null ? null : formatDay(memory.latestValidDate);
      const accounts = checkpoint(e.seq);
      const d =
        firstDifference(goAnswer(i), { result: resultOf(o.result), card: cardJsonOf(memory.card(e.scope_string, e.scoped_id)) }) ??
        difference("latest_valid_date", go.latest_valid_dates[i], latest) ??
        (accounts === undefined ? null : difference("accounts", accounts, accountCounts(memory.output())));
      if (d) fail("memory", i, e, d);
    });
    const state = memory.output().map((scope) => ({
      scope_string: scope.scopeString,
      cards: scope.cards.map((c) => {
        const { proofs_on_last_date, slots } = cardJsonOf(memory.card(scope.scopeString, c.scopedId));
        return { scoped_id: c.scopedId, last_card_proof: formatDay(c.lastCardProof), accounts: c.accounts, proofs_on_last_date, slots };
      }),
      accounts: scope.accounts.map((a) => ({ platform: a.platform, username: a.username, cards: a.cards.map((c) => ({ scoped_id: c.scopedId, last_card_proof: formatDay(c.lastCardProof) })) })),
    }));
    const d = difference("state", go.state, state);
    if (d) assert.fail(`the final state, ${d.field}: Go ${JSON.stringify(d.want)}, memory ${JSON.stringify(d.got)}. ${kept()}`);
    t.diagnostic(`${LENGTH} records in memory: ${Math.round(performance.now() - started)} ms`);
  });

  check("with the state the Durable Object stores, the object stopped between every two records: every record's result and its card after it, and at every checkpoint the latest valid date and the cards of each account, are Go's", async (t) => {
    const started = performance.now();
    worker = await startWorker();
    await freshRoster(worker, { kind: "test" });
    let checkpoints = 0;
    for (const [i, e] of sequence.events.entries()) {
      let got: Answer;
      let atCheckpoint: { latest: string | null; accounts: AccountCount[] } | undefined;
      try {
        const r = await worker.roster.applyRuleEvent(e);
        await worker.roster.restart();
        // A state the object refuses to read (src/card-table.ts, readCard) is a `500` here.
        const { platforms, last_card_proof, proofs_on_last_date } = (await cardState(worker, e.scoped_id, e.scope_string)) as { platforms: CardJson["slots"]; last_card_proof: string | null; proofs_on_last_date: number };
        const result: ResultJson = r.valid ? { valid: true, kinds: r.kinds! } : { valid: false, reason: r.reason! };
        got = { result, card: { last_card_proof, proofs_on_last_date, slots: platforms } };
        if (checkpoint(e.seq) !== undefined) {
          const rules = await worker.roster.ruleState(e.scope_string, e.scoped_id);
          atCheckpoint = { latest: rules.latest_valid_date, accounts: rules.accounts.map((a) => ({ scope_string: e.scope_string, ...a })) };
        }
      } catch (err) {
        throw new Error(`record ${i + 1} of ${LENGTH} (seq ${e.seq}), card ${e.scoped_id}: the Durable Object failed. ${kept()}`, { cause: err });
      }
      const d =
        firstDifference(goAnswer(i), got) ??
        (atCheckpoint === undefined ? null : (difference("latest_valid_date", go.latest_valid_dates[i], atCheckpoint.latest) ?? difference("accounts", checkpoint(e.seq), atCheckpoint.accounts)));
      if (d) fail("Durable Object", i, e, d);
      if (atCheckpoint) checkpoints++;
    }
    assert.equal(checkpoints, LENGTH / CHECKPOINT_EVERY);
    t.diagnostic(`${LENGTH} records and ${checkpoints} checkpoints on the Durable Object, the Worker's start included: ${Math.round((performance.now() - started) / 1000)} s`);
  }, { skip: storageSkip });
});
