// The roster rules as one function that keeps nothing (src/roster-rules.ts),
// and the state kept in memory around it (src/rules-memory.ts), against
// spec/vectors/roster-rules.json: the same file the Go tests read.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Day, formatDay, parseDay } from "../src/date.ts";
import { platformsOf } from "../src/platforms.ts";
import { MemoryRules } from "../src/rules-memory.ts";
import { type CardState, EMPTY_SLOT, RULES_VERSION, type RecordInput, type SlotState, applyList, applyRecord, dailyLimitReached, newCard, possibleCard, possibleSlot } from "../src/roster-rules.ts";
import { repoFile, vectors } from "./vectors.ts";

/** The two tables of spec/scope.md: the production roster's (threads) and a test roster's (test-example, threads). */
const PRODUCTION = platformsOf("production");
const TEST = platformsOf("test");

const day = (s: string): Day => parseDay(s)!;
const dateText = (d: Day | null): string | null => (d === null ? null : formatDay(d));

/** A card's state in the vectors' spelling: `proofs_on_last_date` and `slots`. */
const slotsOut = (card: CardState) =>
  Object.fromEntries([...card.slots].map(([p, s]) => [p, { current: s.current, last_declared: s.lastDeclared, switch_count: s.switchCount, correction_date: dateText(s.correctionDate) }]));

/** The state in memory in the vectors' spelling of `state`. */
const stateOut = (roster: MemoryRules) =>
  roster.output().map((scope) => ({
    scope_string: scope.scopeString,
    cards: scope.cards.map((c) => {
      const card = roster.card(scope.scopeString, c.scopedId);
      return { scoped_id: c.scopedId, last_card_proof: formatDay(c.lastCardProof), accounts: c.accounts, proofs_on_last_date: card.proofsOnLastDate, slots: slotsOut(card) };
    }),
    accounts: scope.accounts.map((a) => ({ platform: a.platform, username: a.username, cards: a.cards.map((c) => ({ scoped_id: c.scopedId, last_card_proof: formatDay(c.lastCardProof) })) })),
  }));

describe("the version number of the rules", () => {
  // The Go tests check roster.RulesVersion against the same two places (roster/version_test.go).
  test("the constant is the number spec/roster-rules.md states and the vectors carry", () => {
    const stated = /^\*\*These rules are version ([1-9][0-9]*)\.\*\*$/m.exec(new TextDecoder().decode(repoFile("spec/roster-rules.md")));
    assert.notEqual(stated, null, "spec/roster-rules.md states the version in one sentence");
    assert.equal(String(RULES_VERSION), stated![1]);
    assert.equal(vectors("roster-rules.json").rules_version, RULES_VERSION);
  });
});

describe("roster-rules.json: every case, record by record, through the state in memory", () => {
  for (const c of vectors("roster-rules.json").cases) {
    test(c.name, () => {
      const roster = new MemoryRules(platformsOf(c.roster));
      assert.equal(c.events.length, c.results.length);
      c.events.forEach((e: Record<string, any>, i: number) => {
        const before = roster.card(e.scope_string, e.scoped_id);
        const beforeText = JSON.stringify(slotsOut(before));
        const latestBefore = roster.latestValidDate;
        const outcome = roster.apply({
          scopeString: e.scope_string,
          scopedId: e.scoped_id,
          challenge: e.challenge,
          accounts: e.accounts,
          verifies: e.verifies,
          crlDates: e.crl_dates.map(day),
        });
        const { seq, ...want } = c.results[i];
        assert.equal(seq, i + 1);
        assert.deepEqual(outcome.result.valid ? outcome.result : { valid: false, reason: outcome.result.reason }, want, `event ${e.seq}`);
        assert.equal(roster.count, i + 1);
        const after = roster.card(e.scope_string, e.scoped_id);
        if (want.valid) {
          // "Every valid record": the card's date is the record's.
          assert.equal(dateText(after.lastCardProof), e.date, `event ${e.seq}`);
        } else {
          // "What an invalid record changes": nothing of its card, not the roster's latest valid date.
          assert.equal(after.lastCardProof, before.lastCardProof, `event ${e.seq}`);
          assert.equal(after.proofsOnLastDate, before.proofsOnLastDate, `event ${e.seq}`);
          assert.equal(JSON.stringify(slotsOut(after)), beforeText, `event ${e.seq}`);
          assert.equal(roster.latestValidDate, latestBefore, `event ${e.seq}`);
        }
        // Every state the rules produce is one the device reads.
        const today = Math.max(day(e.date), after.lastCardProof ?? day(e.date));
        assert.ok(possibleCard(after, today), `event ${e.seq}: the card's items`);
        for (const [p, slot] of after.slots) assert.ok(possibleSlot(slot, after.lastCardProof), `event ${e.seq}: the slot ${p}`);
      });
      assert.deepEqual(stateOut(roster), c.state);
    });
  }
});

describe("applyRecord: one record, the state of its card, three facts about the roster", () => {
  const today = day("2026-11-16");
  const alice: SlotState = { current: "alice", lastDeclared: "alice", switchCount: 1, correctionDate: day("2026-03-02") };
  const card = (o: Partial<SlotState> = {}, lastCardProof = day("2026-11-04"), proofsOnLastDate = 1): CardState => ({ lastCardProof, proofsOnLastDate, slots: new Map([["threads", { ...alice, ...o }]]) });
  const input = (o: Partial<RecordInput> = {}, accounts = [{ platform: "threads", username: "bob" }], verifies = true): RecordInput => ({
    platforms: PRODUCTION,
    record: { accounts, date: today, verifies },
    card: card(),
    latestValidDate: day("2026-11-15"),
    challengeUsed: false,
    crlDates: [today],
    ...o,
  });

  test("a valid record: its kinds, the card after it, the roster's latest valid date", () => {
    assert.deepEqual(applyRecord(input()), {
      result: { valid: true, kinds: [{ platform: "threads", kind: "switch" }] },
      card: { lastCardProof: today, proofsOnLastDate: 1, slots: new Map([["threads", { current: "bob", lastDeclared: "bob", switchCount: 2, correctionDate: today }]]) },
      latestValidDate: today,
    });
  });

  test("the first record of a card and of the roster", () => {
    assert.deepEqual(applyRecord(input({ card: newCard(PRODUCTION), latestValidDate: null })), {
      result: { valid: true, kinds: [{ platform: "threads", kind: "first" }] },
      card: { lastCardProof: today, proofsOnLastDate: 1, slots: new Map([["threads", { current: "bob", lastDeclared: "bob", switchCount: 0, correctionDate: today }]]) },
      latestValidDate: today,
    });
  });

  test("a valid record dated before the roster's latest valid date does not move it back", () => {
    const o = applyRecord(input({ latestValidDate: day("2026-11-18") }));
    assert.equal(o.result.valid, true);
    assert.equal(o.latestValidDate, day("2026-11-18"));
  });

  test("the checks in order: the first that fails gives the code", () => {
    const blocked = card({ switchCount: 5 }, today, 3);
    // Everything wrong at once, then one check fewer each time.
    const all: RecordInput = input({ card: blocked, challengeUsed: true, crlDates: [], latestValidDate: day("2026-11-21") }, undefined, false);
    assert.deepEqual(applyRecord(all).result, { valid: false, reason: "proof" });
    const verifies = { ...all, record: { ...all.record, verifies: true } };
    assert.deepEqual(applyRecord(verifies).result, { valid: false, reason: "challenge_reused" });
    assert.deepEqual(applyRecord({ ...verifies, challengeUsed: false }).result, { valid: false, reason: "root" });
    const rooted = { ...verifies, challengeUsed: false, crlDates: [today] };
    assert.deepEqual(applyRecord(rooted).result, { valid: false, reason: "date_order" });
    const ordered = { ...rooted, latestValidDate: day("2026-11-20") };
    assert.deepEqual(applyRecord(ordered), { result: { valid: false, reason: "switch_limit", blockedPlatform: "threads" }, card: blocked, latestValidDate: day("2026-11-20") });
    // The same account: nothing blocked, and the fourth record of the date.
    assert.deepEqual(applyRecord({ ...ordered, record: { ...ordered.record, accounts: [{ platform: "threads", username: "alice" }] } }).result, { valid: false, reason: "daily_limit" });
  });

  test("check 3: the CRL date minus 1 day to the CRL date plus 3 days; one CRL that fits is enough", () => {
    const reason = (crlDates: Day[]) => {
      const r = applyRecord(input({ crlDates })).result;
      return r.valid ? "valid" : r.reason;
    };
    assert.equal(reason([today + 1]), "valid");
    assert.equal(reason([today + 2]), "root");
    assert.equal(reason([today - 3]), "valid");
    assert.equal(reason([today - 4]), "root");
    assert.equal(reason([today - 9, today, today + 9]), "valid");
    assert.equal(reason([]), "root");
  });

  test("check 4: 4 days before the roster's latest valid date; not before the card's own last card proof", () => {
    const reason = (o: Partial<RecordInput>) => {
      const r = applyRecord(input(o)).result;
      return r.valid ? "valid" : r.reason;
    };
    assert.equal(reason({ latestValidDate: today + 4 }), "valid");
    assert.equal(reason({ latestValidDate: today + 5 }), "date_order");
    assert.equal(reason({ card: card({}, today) }), "valid");
    assert.equal(reason({ card: card({}, today + 1) }), "date_order");
  });

  test("an invalid record gives back the state it was given, and the latest valid date as it was", () => {
    for (const o of [input({ challengeUsed: true }), input({ crlDates: [] }), input({ card: card({ switchCount: 5 }) }), input({}, undefined, false)]) {
      const out = applyRecord(o);
      assert.equal(out.result.valid, false);
      assert.equal(out.card, o.card);
      assert.equal(out.latestValidDate, o.latestValidDate);
    }
  });

  test("it keeps nothing and changes nothing: the same input twice gives the same outcome", () => {
    const frozen = input({ card: Object.freeze({ lastCardProof: today, proofsOnLastDate: 1, slots: new Map([["threads", Object.freeze({ ...alice })]]) }) });
    Object.freeze(frozen);
    Object.freeze(frozen.record);
    const text = JSON.stringify([frozen, [...frozen.card.slots]]);
    const first = applyRecord(frozen);
    const second = applyRecord(frozen);
    assert.deepEqual(first, second);
    assert.equal(first.card.proofsOnLastDate, 2);
    assert.equal(JSON.stringify([frozen, [...frozen.card.slots]]), text);
    assert.notEqual(first.card.slots, frozen.card.slots);
  });

  test("a platform of the table without a slot in the state has the empty slot; the state after has every platform", () => {
    const o = applyRecord(input({ platforms: [...TEST].reverse(), card: card() }, [{ platform: "test-example", username: "carol" }, { platform: "threads", username: "alice" }]));
    assert.deepEqual(o.result, { valid: true, kinds: [{ platform: "test-example", kind: "first" }, { platform: "threads", kind: "refresh" }] });
    assert.deepEqual([...o.card.slots.keys()], ["test-example", "threads"]);
    assert.deepEqual(o.card.slots.get("test-example"), { current: "carol", lastDeclared: "carol", switchCount: 0, correctionDate: today });
    // Left alone, the new platform has no kind and stays empty.
    const left = applyRecord(input({ platforms: [...TEST].reverse(), card: card() }, [{ platform: "threads", username: "alice" }]));
    assert.deepEqual(left.result, { valid: true, kinds: [{ platform: "threads", kind: "refresh" }] });
    assert.deepEqual(left.card.slots.get("test-example"), EMPTY_SLOT);
  });

  test("not a record of the roster: an error, not a reason code, before any check", () => {
    const outside = [{ platform: "example", username: "bob" }];
    const twice = [{ platform: "threads", username: "bob" }, { platform: "threads", username: "carol" }];
    const unordered = [{ platform: "threads", username: "bob" }, { platform: "test-example", username: "carol" }];
    const two = { platforms: TEST };
    // threads has no `-`; test-example has it (spec/scope.md).
    const format = [{ platform: "threads", username: "a-b" }];
    // Each of checks 1 to 4 would fail first; none gives the record a code.
    const failing: [string, Partial<RecordInput>, boolean][] = [
      ["every check passes", {}, true],
      ["check 1", {}, false],
      ["check 2", { challengeUsed: true }, true],
      ["check 3", { crlDates: [] }, true],
      ["check 4, the roster's date", { latestValidDate: today + 5 }, true],
      ["check 4, the card's date", { card: card({}, today + 1) }, true],
    ];
    for (const [label, o, verifies] of failing) {
      assert.throws(() => applyRecord(input(o, outside, verifies)), /outside the table/, label);
      assert.throws(() => applyRecord(input(o, twice, verifies)), /twice/, label);
      assert.throws(() => applyRecord(input({ ...two, ...o }, unordered, verifies)), /ascending order/, label);
      assert.throws(() => applyRecord(input(o, format, verifies)), /not in the format of threads/, label);
      assert.throws(() => applyRecord(input({ ...o, card: { ...(o.card ?? card()), slots: new Map([["example", { ...alice }]]) } }, undefined, verifies)), /outside the table/, label);
    }
    assert.throws(() => applyList(PRODUCTION, card(), outside, today), /outside the table/);
    assert.throws(() => applyList(PRODUCTION, card(), twice, today), /twice/);
    assert.throws(() => applyList(TEST, card(), unordered, today), /ascending order/);
    assert.throws(() => applyList(PRODUCTION, card(), format, today), /not in the format of threads/);
    // The same username on the platform whose format has it is a record.
    assert.equal(applyList(TEST, newCard(TEST), [{ platform: "test-example", username: "a-b" }], today).result.valid, true);
  });

  test("a list wrong in several ways: the first thing wrong, account by account, as Go's roster/ reports it", () => {
    const err = (accounts: { platform: string; username: string }[]) => {
      try {
        applyList(TEST, newCard(TEST), accounts, today);
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    };
    // Per account: the platform, then its place after the one before, then its username.
    assert.match(err([{ platform: "example", username: "A" }]), /outside the table/);
    assert.match(err([{ platform: "threads", username: "A" }, { platform: "example", username: "bob" }]), /not in the format of threads/);
    assert.match(err([{ platform: "threads", username: "bob" }, { platform: "threads", username: "A" }]), /twice/);
    assert.match(err([{ platform: "threads", username: "bob" }, { platform: "test-example", username: "A" }]), /ascending order/);
    assert.match(err([{ platform: "threads", username: "bob" }, { platform: "example", username: "A" }]), /outside the table/);
    assert.match(err([{ platform: "test-example", username: "a-b" }, { platform: "threads", username: "a-b" }]), /not in the format of threads/);
  });
});

describe("applyList: checks 5 and 6, what the device computes before signing", () => {
  const today = day("2026-11-16");
  const slot = (o: Partial<SlotState>): SlotState => ({ current: "alice", lastDeclared: "alice", switchCount: 1, correctionDate: day("2026-03-02"), ...o });
  const one = (s: SlotState, entry: string | null, lastCardProof: Day | null = day("2026-11-04"), n = 1) =>
    applyList(PRODUCTION, { lastCardProof, proofsOnLastDate: n, slots: new Map([["threads", s]]) }, entry === null ? [] : [{ platform: "threads", username: entry }], today);
  const kindOf = (s: SlotState, entry: string | null) => {
    const o = one(s, entry);
    return o.result.valid ? o.result.kinds.map((k) => k.kind).join() : o.result.reason;
  };

  test("the event rules on one slot: first, refresh, correction, switch, blocked; withdraw", () => {
    assert.equal(kindOf(EMPTY_SLOT, "alice"), "first");
    assert.equal(kindOf(EMPTY_SLOT, null), "empty");
    assert.equal(kindOf(slot({}), "alice"), "refresh");
    assert.equal(kindOf(slot({ current: null }), "alice"), "refresh");
    assert.equal(kindOf(slot({}), "bob"), "switch");
    assert.equal(kindOf(slot({ correctionDate: today }), "bob"), "correction");
    assert.equal(kindOf(slot({ switchCount: 5 }), "bob"), "switch_limit");
    // After the fifth, a correction on its date is still a correction.
    assert.equal(kindOf(slot({ switchCount: 5, correctionDate: today }), "bob"), "correction");
    assert.equal(kindOf(slot({}), null), "withdraw");
    assert.equal(kindOf(slot({ current: null }), null), "empty");
  });

  test("the slot after each kind", () => {
    const after = (s: SlotState, entry: string | null) => one(s, entry).card.slots.get("threads");
    assert.deepEqual(after(EMPTY_SLOT, "alice"), { current: "alice", lastDeclared: "alice", switchCount: 0, correctionDate: today });
    assert.deepEqual(after(slot({ current: null }), "alice"), slot({}));
    assert.deepEqual(after(slot({ correctionDate: today }), "bob"), { current: "bob", lastDeclared: "bob", switchCount: 1, correctionDate: today });
    assert.deepEqual(after(slot({}), "bob"), { current: "bob", lastDeclared: "bob", switchCount: 2, correctionDate: today });
    assert.deepEqual(after(slot({}), null), slot({ current: null }));
  });

  test("a blocked platform names itself and blocks the other platforms' changes", () => {
    const card: CardState = { lastCardProof: day("2026-11-04"), proofsOnLastDate: 1, slots: new Map([["test-example", { ...EMPTY_SLOT }], ["threads", slot({ switchCount: 5 })]]) };
    const o = applyList(TEST, card, [{ platform: "test-example", username: "carol" }, { platform: "threads", username: "bob" }], today);
    assert.deepEqual(o, { result: { valid: false, reason: "switch_limit", blockedPlatform: "threads" }, card });
  });

  test("3 records today: nothing more today; tomorrow again", () => {
    assert.deepEqual(one(slot({}), "alice", today, 3).result, { valid: false, reason: "daily_limit" });
    assert.equal(one(slot({}), "alice", today, 2).card.proofsOnLastDate, 3);
    assert.equal(one(slot({}), "alice", today - 1, 3).card.proofsOnLastDate, 1);
    // `empty` and `switch_limit` come before `daily_limit`.
    assert.deepEqual(one(slot({ current: null }), null, today, 3).result, { valid: false, reason: "empty" });
    assert.deepEqual(one(slot({ switchCount: 5 }), "bob", today, 3).result, { valid: false, reason: "switch_limit", blockedPlatform: "threads" });

    const s = { lastCardProof: today, proofsOnLastDate: 3 };
    assert.equal(dailyLimitReached(s, today), true);
    assert.equal(dailyLimitReached(s, today + 1), false);
    assert.equal(dailyLimitReached({ ...s, proofsOnLastDate: 2 }, today), false);
    // The last card proof dated after today: a card proof dated today is date_order, not daily_limit.
    assert.equal(dailyLimitReached(s, today - 1), false);
    assert.equal(dailyLimitReached({ lastCardProof: null, proofsOnLastDate: 0 }, today), false);
  });
});

describe("states the rules cannot produce", () => {
  test("possibleSlot, possibleCard", () => {
    const today = day("2026-11-16");
    const lcp = day("2026-11-04");
    const ok: SlotState = { current: "bob", lastDeclared: "bob", switchCount: 1, correctionDate: day("2026-03-02") };
    assert.equal(possibleSlot(ok, lcp), true);
    assert.equal(possibleSlot(EMPTY_SLOT, null), true);
    assert.equal(possibleSlot({ ...ok, current: null }, lcp), true);
    for (const [label, s, l] of [
      ["current is not last_declared", { ...ok, current: "alice" }, lcp],
      ["last_declared without correction_date", { ...ok, correctionDate: null }, lcp],
      ["correction_date without last_declared", { ...EMPTY_SLOT, correctionDate: lcp }, lcp],
      ["switches without an account ever", { ...EMPTY_SLOT, switchCount: 1 }, lcp],
      ["6 switches", { ...ok, switchCount: 6 }, lcp],
      ["-1 switches", { ...ok, switchCount: -1 }, lcp],
      ["1.5 switches", { ...ok, switchCount: 1.5 }, lcp],
      ["an account without a last card proof", ok, null],
      ["correction_date after the last card proof", { ...ok, correctionDate: day("2026-11-05") }, lcp],
    ] as const) {
      assert.equal(possibleSlot(s as SlotState, l), false, label);
    }
    for (const n of [1, 2, 3]) assert.equal(possibleCard({ lastCardProof: lcp, proofsOnLastDate: n }, today), true, String(n));
    for (const n of [0, 4, -1, 1.5, NaN, Infinity]) assert.equal(possibleCard({ lastCardProof: lcp, proofsOnLastDate: n }, today), false, String(n));
    assert.equal(possibleCard({ lastCardProof: null, proofsOnLastDate: 0 }, today), true);
    for (const n of [1, 3, -1, 0.5]) assert.equal(possibleCard({ lastCardProof: null, proofsOnLastDate: n }, today), false, String(n));
    assert.equal(possibleCard({ lastCardProof: day("2026-11-19"), proofsOnLastDate: 1 }, today), true);
    assert.equal(possibleCard({ lastCardProof: day("2026-11-20"), proofsOnLastDate: 1 }, today), false);
  });
});

describe("the state in memory", () => {
  const r = { scopeString: "iamreal:public:0_______________", scopedId: "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880", accounts: [{ platform: "threads", username: "alice" }], verifies: true, crlDates: [day("2026-01-01")] };
  const first = "2026-01-01.GQ6BW1FY2H0WBP91MMG57JWPF0";
  const second = "2026-01-01.6X8F69SF344E6ZS8XB8ADN57VG";

  test("not a well-formed record: an error, and nothing changes", () => {
    const rules = new MemoryRules(PRODUCTION);
    assert.equal(rules.apply({ ...r, challenge: first }).result.valid, true);
    const snapshot = () => JSON.stringify([rules.count, rules.latestValidDate, rules.output(), [...rules.card(r.scopeString, r.scopedId).slots]]);
    const before = snapshot();
    const outside = [{ platform: "example", username: "alice" }];
    const twice = [{ platform: "threads", username: "alice" }, { platform: "threads", username: "bob" }];
    assert.throws(() => rules.apply({ ...r, challenge: "2026-01-01" }), /challenge/);
    // Whatever else is wrong with it: it does not verify, its root is not recognized, its challenge was used.
    for (const o of [{}, { verifies: false }, { crlDates: [] }]) {
      assert.throws(() => rules.apply({ ...r, ...o, challenge: second, accounts: outside }), /outside the table/);
      assert.throws(() => rules.apply({ ...r, ...o, challenge: second, accounts: twice }), /twice/);
      assert.throws(() => rules.apply({ ...r, ...o, challenge: second, accounts: [{ platform: "threads", username: "a-b" }] }), /not in the format of threads/);
    }
    assert.throws(() => rules.apply({ ...r, challenge: first, accounts: outside }), /outside the table/);
    assert.equal(snapshot(), before);
    // The challenge of the records that threw is not used: a record with it is valid.
    assert.deepEqual(rules.apply({ ...r, challenge: second }).result, { valid: true, kinds: [{ platform: "threads", kind: "refresh" }] });
    assert.equal(rules.count, 2);
  });
});
