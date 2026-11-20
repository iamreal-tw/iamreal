// The roster rules over a long sequence of records (#73): Go's roster/ gives
// the answers, and protocol/'s rules, with their state in memory and with
// the state the roster's Durable Object stores, must give each record the
// same result and leave its card in the same state. The sequence comes from
// a generator with a fixed seed (test/sequence.ts). worker/README.md says how
// to run it, what it compares and what it found (#9, item 8 of the
// conclusion: these are its second and third layers; the first is
// records-storage.test.ts, the vectors on the object's stored state).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { type Day, formatDay, parseDay } from "iamreal-protocol/date.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { type CardState, RULES_VERSION, type RecordResult } from "iamreal-protocol/roster-rules.ts";
import { MemoryRules } from "iamreal-protocol/rules-memory.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { parseScopedId } from "iamreal-protocol/scoped-id.ts";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { cardState, freshRoster } from "./records.ts";
import { type Answer, type CardJson, type GoAnswers, KINDS, REASONS, type ResultJson, type Sequence, type SequenceEvent, firstDifference, generateSequence, statistics } from "./sequence.ts";

/** The sequence compared: its seed and length. Another seed is another sequence; the counts it prints must still reach 100. */
const SEED = 1;
const LENGTH = 10_000;

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

// The answers come from Go. Without go the comparison is skipped on a
// computer; where the whole check is expected (CI, which GitHub Actions
// sets, or IAMREAL_BB), a missing go is a failure, as in workflows.test.ts.
const hasGo = spawnSync("go", ["version"]).status === 0;
const goRequired = Boolean(process.env.CI) || Boolean(process.env.IAMREAL_BB);
const skip = !hasGo && !goRequired ? "go is not installed: no answers from Go's roster/" : false;

const dateText = (d: Day | null): string | null => (d === null ? null : formatDay(d));
/** protocol/'s result without the explanation for people (`blockedPlatform`): the reason code is the whole result of an invalid record. */
const resultOf = (r: RecordResult): ResultJson => (r.valid ? { valid: true, kinds: r.kinds } : { valid: false, reason: r.reason });
const cardOf = (c: CardState): CardJson => ({
  last_card_proof: dateText(c.lastCardProof),
  proofs_on_last_date: c.proofsOnLastDate,
  slots: Object.fromEntries([...c.slots].map(([p, s]) => [p, { current: s.current, last_declared: s.lastDeclared, switch_count: s.switchCount, correction_date: dateText(s.correctionDate) }])),
});

describe(`a sequence of ${LENGTH} records of seed ${SEED}: Go's roster/ gives the answers`, { skip }, () => {
  let dir: string;
  let keep = false;
  let sequence: Sequence;
  let go: GoAnswers;
  let worker: TestWorker | undefined;
  let goMs: number;

  before(() => {
    assert.ok(hasGo, "go is not installed, and CI or IAMREAL_BB is set: this comparison must run here");
    sequence = generateSequence({ seed: SEED, length: LENGTH });
    dir = mkdtempSync(join(tmpdir(), "iamreal-sequence-"));
    writeFileSync(join(dir, "events.json"), JSON.stringify(sequence));
    const started = performance.now();
    const run = spawnSync("go", ["test", "-count=1", "-run", "^TestSequenceAnswers$", "./roster"], { cwd: join(WORKER_DIR, ".."), env: { ...process.env, IAMREAL_ROSTER_SEQUENCE: dir }, encoding: "utf8" });
    goMs = performance.now() - started;
    assert.equal(run.status, 0, run.stdout + run.stderr);
    go = JSON.parse(readFileSync(join(dir, "answers.json"), "utf8")) as GoAnswers;
  });
  after(async () => {
    await worker?.close();
    if (!keep) rmSync(dir, { recursive: true, force: true });
  });

  /** Fails at the first record whose answer from `side` is not Go's, naming the record, its card and the field. */
  const compare = (side: string, i: number, e: SequenceEvent, got: Answer): void => {
    const { seq: _, ...result } = go.results[i]!;
    const { scope_string: __, scoped_id: ___, ...card } = go.cards[i]!;
    const d = firstDifference({ result, card }, got);
    if (d === null) return;
    keep = true;
    assert.fail(`record ${i + 1} of ${LENGTH} (seq ${e.seq}), card ${e.scoped_id}, ${d.field}: Go ${JSON.stringify(d.want)}, ${side} ${JSON.stringify(d.got)}. The events and Go's answers are kept in ${dir}`);
  };

  test("Go answered every event, by the version of the rules protocol/ has", (t) => {
    t.diagnostic(`Go's answers, compiling its test included: ${Math.round(goMs)} ms`);
    assert.equal(go.rules_version, RULES_VERSION);
    assert.deepEqual(go.events, sequence.events);
    assert.equal(go.results.length, LENGTH);
    assert.equal(go.cards.length, LENGTH);
    go.results.forEach((r, i) => assert.equal(r.seq, i + 1));
    go.cards.forEach((c, i) => assert.equal(c.scoped_id, sequence.events[i]!.scoped_id));
  });

  test("every reason code and every kind at least 100 times", (t) => {
    const s = statistics(go.results);
    t.diagnostic(`valid ${s.valid}, invalid ${LENGTH - s.valid}`);
    for (const [k, n] of Object.entries(s.reasons)) t.diagnostic(`reason ${k}: ${n}`);
    for (const [k, n] of Object.entries(s.kinds)) t.diagnostic(`kind ${k}: ${n}`);
    for (const [k, n] of Object.entries(s.byPlatform).sort()) t.diagnostic(`  ${k}: ${n}`);
    for (const r of REASONS) assert.ok(s.reasons[r]! >= 100, `${r}: ${s.reasons[r]}`);
    for (const k of KINDS) assert.ok(s.kinds[k]! >= 100, `${k}: ${s.kinds[k]}`);
  });

  test("with the state in memory (MemoryRules): every record's result and its card after it are Go's, and so is the final state", (t) => {
    const started = performance.now();
    const memory = new MemoryRules(platformsOf("test"));
    sequence.events.forEach((e, i) => {
      const o = memory.apply({ scopeString: e.scope_string, scopedId: e.scoped_id, challenge: e.challenge, accounts: e.accounts, verifies: e.verifies, crlDates: e.crl_dates.map((d) => parseDay(d)!) });
      compare("memory", i, e, { result: resultOf(o.result), card: cardOf(memory.card(e.scope_string, e.scoped_id)) });
    });
    const state = memory.output().map((scope) => ({
      scope_string: scope.scopeString,
      cards: scope.cards.map((c) => {
        const { proofs_on_last_date, slots } = cardOf(memory.card(scope.scopeString, c.scopedId));
        return { scoped_id: c.scopedId, last_card_proof: formatDay(c.lastCardProof), accounts: c.accounts, proofs_on_last_date, slots };
      }),
      accounts: scope.accounts.map((a) => ({ platform: a.platform, username: a.username, cards: a.cards.map((c) => ({ scoped_id: c.scopedId, last_card_proof: formatDay(c.lastCardProof) })) })),
    }));
    assert.deepEqual(state, go.state);
    t.diagnostic(`${LENGTH} records in memory: ${Math.round(performance.now() - started)} ms`);
  });

  test("with the state the Durable Object stores, the object stopped between every two records: every record's result and its card after it are Go's", async (t) => {
    const started = performance.now();
    worker = await startWorker();
    await freshRoster(worker, { kind: "test" });
    for (const [i, e] of sequence.events.entries()) {
      let got: Answer;
      try {
        const r = await worker.roster.applyRuleEvent(e);
        await worker.roster.restart();
        // A state the object refuses to read (src/card-table.ts, readCard) is a `500` here.
        const { count: _, platforms, ...items } = await cardState(worker, e.scoped_id, e.scope_string);
        const result: ResultJson = r.valid ? { valid: true, kinds: r.kinds! } : { valid: false, reason: r.reason! };
        got = { result, card: { ...(items as Omit<CardJson, "slots">), slots: platforms as CardJson["slots"] } };
      } catch (err) {
        keep = true;
        throw new Error(`record ${i + 1} of ${LENGTH} (seq ${e.seq}), card ${e.scoped_id}: the Durable Object failed. The events and Go's answers are kept in ${dir}`, { cause: err });
      }
      compare("Durable Object", i, e, got);
    }
    t.diagnostic(`${LENGTH} records on the Durable Object, the Worker's start included: ${Math.round((performance.now() - started) / 1000)} s`);
  });
});
