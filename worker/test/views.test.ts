// The views the proof log's object keeps for the pages (src/views.ts), through
// the Worker's HTTP (test/harness.ts): they are written in the transaction
// of a record, so a write that fails leaves neither; cleared, they are
// written again from the records, row for row what they were; the
// number of cards that declare an account, which the answer of a record
// gives, comes from them and not from every card's stored state; every
// row is the one the record rules' states before and after each record
// give, for one record on two platforms and for every case of
// spec/vectors/record-rules.json; and every statement the pages' reads
// run reads one stretch of one index and sorts nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { type CardState, EMPTY_SLOT, type PlatformKind } from "iamreal-protocol/record-rules.ts";
import { MemoryRules } from "iamreal-protocol/rules-memory.ts";
import { shortId } from "iamreal-protocol/scoped-id.ts";
import { WORKER_DIR } from "./build.ts";
import { type RuleEvent, type TestWorker, startWorker } from "./harness.ts";
import { CARD_A, CARD_B, cardStarting, pagesWorld, r } from "./pages.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import { TEST_SCOPE, wantNoAlarmSoon, cardState, checkProofLog, day, freshProofLog, mustSubmit, newCard, publishCrl, publishG3, sub, submit, tw, wantError } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

const pageOf = async (path: string): Promise<[number, string]> => {
  const res = await worker.fetch(path);
  return [res.status, await res.text()];
};

describe("the views and the record are one transaction", () => {
  // The four tables of the views, in the order a record writes them.
  for (const table of ["view_cards", "view_slots", "view_history", "view_state"] as const) {
    test(`a write that fails at \`${table}\`: 500, and the record, the card's state, the views and the pages are as before`, async () => {
      await freshProofLog(worker);
      const root = await publishG3(worker);
      const card = cardStarting(CARD_A);
      await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
      const state = await cardState(worker, card);
      const views = await worker.proofLog.views();
      const pages = [await pageOf(`/p/${CARD_A}`), await pageOf("/")];

      // One that would change every table: another account for this card, and a first card proof of another.
      const change = await sub(worker, card, root, "threads:bob");
      const other = await sub(worker, cardStarting(CARD_B), root, "threads:carol");
      await worker.proofLog.failWritesTo(table);
      for (const s of [change, other]) {
        const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(s) });
        assert.deepEqual([res.status, JSON.parse(await res.text())], [500, { error: "internal" }]);
      }
      assert.deepEqual(await cardState(worker, card), state);
      assert.deepEqual(await worker.proofLog.views(), views);
      assert.deepEqual([await pageOf(`/p/${CARD_A}`), await pageOf("/")], pages);
      assert.equal((await pageOf(`/p/${CARD_B}`))[0], 404);
      assert.equal((await checkProofLog(worker)).length, 1);

      // Nothing was half written: started again, the object has the same; and the same submissions are then written.
      await worker.proofLog.failWritesTo(null);
      await worker.proofLog.restart();
      assert.deepEqual(await worker.proofLog.views(), views);
      assert.deepEqual((await submit(worker, change)).body.kinds, [{ platform: "threads", kind: "correction", username: "bob", account_cards: 1 }]);
      assert.deepEqual((await submit(worker, other)).body.kinds, [{ platform: "threads", kind: "first", username: "carol", account_cards: 1 }]);
      assert.equal((await checkProofLog(worker)).length, 3);
      assert.match((await pageOf(`/p/${CARD_A}`))[1], /<span class="account">@bob<\/span>/);
      assert.equal((await pageOf(`/p/${CARD_B}`))[0], 200);
    });
  }

  // The other tables of a record (test/records-storage.test.ts has what the API answers for each).
  for (const table of ["records", "cards", "proof_log", "challenges.accepted"] as const) {
    test(`a write that fails at \`${table}\`: the views and the pages are as before`, async () => {
      await freshProofLog(worker);
      const root = await publishG3(worker);
      const card = cardStarting(CARD_A);
      await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
      const views = await worker.proofLog.views();
      const page = await pageOf(`/p/${CARD_A}`);
      await worker.proofLog.failWritesTo(table);
      assert.equal((await submit(worker, await sub(worker, card, root, "threads:bob"))).status, 500);
      await worker.proofLog.failWritesTo(null);
      assert.deepEqual(await worker.proofLog.views(), views);
      assert.deepEqual(await pageOf(`/p/${CARD_A}`), page);
    });
  }
});

describe("the views written again from the records", () => {
  /** A proof log with every kind a record can have, on both platforms of the test log, cards that share a short ID and cards that share an account. */
  async function everyKind(): Promise<void> {
    const e = cardStarting("E000000000");
    const m1 = cardStarting("7K2Q9FM4XD3A");
    const m2 = cardStarting("7K2Q9FM4XD3B");
    await pagesWorld(worker, "2026-11-18", [
      r("2026-10-01", e, "threads:bob"),
      r("2026-10-01", m1, "test-example:a-b", "threads:alice"),
      r("2026-10-02", e, "threads:bob"),
      r("2026-10-03", e, "threads:alice"),
      r("2026-10-03", e, "threads:dave"),
      r("2026-10-03", m2, "threads:alice"),
      r("2026-10-04", e),
      r("2026-10-05", e, "threads:dave"),
      r("2026-10-05", m1, "test-example:c-d"),
      r("2026-10-06", e),
      r("2026-10-07", e, "test-example:a-b", "threads:carol.tw"),
      r("2026-10-08", e, "threads:erin"),
      r("2026-10-08", e),
      r("2026-10-08", e, "threads:frank"),
      r("2026-10-09", m2, "threads:alice"),
      r("2026-10-09", m1, "threads:alice"),
    ]);
  }

  test("cleared and filled when the object starts: row for row the views written record by record, and the same pages", async () => {
    await everyKind();
    const views = await worker.proofLog.views();
    assert.deepEqual(views.view_state, [{ id: 1, seq: 16 }]);
    // Three cards; a slot for each platform a card has used; a row for each kind of each record.
    assert.deepEqual([views.view_cards!.length, views.view_slots!.length], [3, 5]);
    assert.ok(views.view_history!.length > 16);
    const paths = ["/", "/p/E000000000", `/p/${CARD_A}`];
    const pages = await Promise.all(paths.map(pageOf));

    await worker.proofLog.clearViews();
    assert.deepEqual((await worker.proofLog.views()).view_state, [{ id: 1, seq: 0 }]);
    assert.equal((await pageOf("/p/E000000000"))[0], 404);
    await worker.proofLog.restart();
    assert.deepEqual(await worker.proofLog.views(), views);
    assert.deepEqual(await Promise.all(paths.map(pageOf)), pages);

    // And the proof log goes on from them: the next record is written into views that are at the record before it.
    const root = await publishCrl(worker, { issuer: "G3", number: parseDay("2026-11-18")!, thisUpdate: tw("2026-11-18", "05:00:00"), serials: [11, 12] });
    const answer = await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    assert.deepEqual([answer.seq, answer.kinds[0].account_cards], [17, 3]);
  });

  /** What a page answers when the back end itself fails: 500, plain text, never kept by a cache. */
  const wantUnavailable = async (path: string): Promise<void> => {
    const res = await worker.fetch(path);
    assert.deepEqual([res.status, res.headers.get("cache-control"), await res.text()], [500, "no-store", "internal error\n"], path);
  };

  test("a paused proof log does not fill them, and with views that are not at its last record it shows no page: not 0 cards, not a card that is not found", async () => {
    await everyKind();
    const views = await worker.proofLog.views();
    const pages = await Promise.all(["/", `/p/${CARD_A}`].map(pageOf));
    const card = (await checkProofLog(worker))[0]!.scopedId;
    const state = await cardState(worker, card);
    // Paused with views that are whole: the pages go on.
    await worker.proofLog.setStoredRulesVersion("another");
    await worker.proofLog.restart();
    try {
      assert.deepEqual(await Promise.all(["/", `/p/${CARD_A}`].map(pageOf)), pages);
      // Paused with views that were cleared: its records were taken by other rules than this build's, so they are not filled.
      await worker.proofLog.clearViews();
      await worker.proofLog.restart();
      assert.deepEqual((await worker.proofLog.views()).view_state, [{ id: 1, seq: 0 }]);
      for (const path of ["/", `/p/${CARD_A}`, "/p/E000000000"]) await wantUnavailable(path);
      // A short ID that does not read needs no proof log, and what is no page is still the 404 page.
      assert.equal((await worker.fetch("/p/nothing")).status, 404);
      assert.equal((await worker.fetch("/nothing")).status, 404);
      // The API says what a paused proof log says.
      assert.equal((await worker.fetch("/api/v1/challenges", { method: "POST" })).status, 503);
      assert.deepEqual(await cardState(worker, card), state);
    } finally {
      await worker.proofLog.setStoredRulesVersion("the build's");
      await worker.proofLog.restart();
    }
    assert.deepEqual(await worker.proofLog.views(), views);
    assert.deepEqual(await Promise.all(["/", `/p/${CARD_A}`].map(pageOf)), pages);
  });

  test("when filling them fails the object still starts: the pages and a submission are 500, challenges and card states go on, and a start once the wait is over fills them", async () => {
    await everyKind();
    const views = await worker.proofLog.views();
    const pages = await Promise.all(["/", `/p/${CARD_A}`].map(pageOf));
    const root = await publishCrl(worker, { issuer: "G3", number: parseDay("2026-11-18")!, thisUpdate: tw("2026-11-18", "05:00:00"), serials: [11, 12] });
    const stored = await checkProofLog(worker);
    const card = stored[0]!.scopedId;
    const state = await cardState(worker, card);
    await worker.proofLog.clearViews();
    await worker.proofLog.failWritesTo("view_cards");
    await worker.proofLog.restart();
    try {
      // Nothing of a half-filled view is kept.
      assert.deepEqual((await worker.proofLog.views()).view_state, [{ id: 1, seq: 0 }]);
      assert.deepEqual([(await worker.proofLog.views()).view_cards, (await worker.proofLog.views()).view_history], [[], []]);
      for (const path of ["/", `/p/${CARD_A}`, "/p/E000000000"]) await wantUnavailable(path);
      // A challenge is issued and a card's state is read as before.
      const submission = await sub(worker, newCard(), root, "threads:alice");
      assert.deepEqual(await cardState(worker, card), state);
      // A submission is the back end's own failure, as docs/api/card-proof.md writes it; nothing is written and the challenge is not used up.
      await wantNoAlarmSoon(worker);
      const logged = worker.logLines().length;
      const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(submission) });
      assert.deepEqual([res.status, res.headers.get("cache-control"), JSON.parse(await res.text())], [500, "no-store", { error: "internal" }]);
      assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", id: res.headers.get("X-Request-Id"), endpoint: "/api/v1/records", where: "proof_log", error: "Error" }]);
      assert.deepEqual(await checkProofLog(worker), stored);
      // Nor is the submission counted against its challenge: sent more often than a challenge takes submissions
      // (five), it is the same 500 each time, never challenge_attempts, and it is still written once the views are filled (below).
      for (let i = 0; i < 6; i++) {
        const again = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(submission) });
        assert.deepEqual([again.status, JSON.parse(await again.text())], [500, { error: "internal" }], `submission ${i + 2}`);
      }
      // A start once the wait after the failure is over (a minute; README.md, "失敗後多久再試") tries again, and says
      // so in one line; and it sets its alarm for the next try, two minutes later after a second failure, which it could.
      const failedAt = tw("2026-11-18", "12:00:00").getTime();
      await worker.setClock(new Date(failedAt + 60 * 1000));
      await worker.proofLog.restart();
      await wantUnavailable("/");
      const alarm = await worker.proofLog.alarmInMs();
      assert.ok(alarm !== null && alarm <= 2 * 60 * 1000, `the alarm is ${alarm} ms ahead`);
      assert.deepEqual(worker.logLines().filter((l) => l.includes("alarm_not_set")), []);
      assert.ok(worker.logLines().filter((l) => l === JSON.stringify({ event: "views_not_filled", error: "Error" })).length >= 2);

      await worker.proofLog.failWritesTo(null);
      await worker.setClock(new Date(failedAt + 3 * 60 * 1000));
      await worker.proofLog.restart();
      assert.deepEqual(await worker.proofLog.views(), views);
      assert.deepEqual(await Promise.all(["/", `/p/${CARD_A}`].map(pageOf)), pages);
      // The submission that was refused is written now: its challenge was neither marked nor counted out.
      const answer = await mustSubmit(worker, submission, "threads first");
      assert.deepEqual([answer.seq, answer.kinds[0].account_cards], [17, 3]);
    } finally {
      await worker.proofLog.failWritesTo(null);
    }
  });
});

describe("the number of cards that declare an account", () => {
  test("follows every kind: counted in the state the record leaves", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    const [a, b, c] = [newCard(), newCard(), newCard()];
    const cards = async (card: string, ...accounts: string[]): Promise<[string, string, number][]> =>
      ((await submit(worker, await sub(worker, card, root, ...accounts))).body.kinds as { kind: string; username: string; account_cards: number }[]).map((k) => [k.kind, k.username, k.account_cards]);
    assert.deepEqual(await cards(a, "threads:alice"), [["first", "alice", 1]]);
    assert.deepEqual(await cards(b, "threads:alice"), [["first", "alice", 2]]);
    assert.deepEqual(await cards(c, "test-example:alice"), [["first", "alice", 1]], "another platform is another count");
    assert.deepEqual(await cards(a, "threads:alice"), [["refresh", "alice", 2]]);
    assert.deepEqual(await cards(b, "threads:bob"), [["correction", "bob", 1]]);
    assert.deepEqual(await cards(a), [["withdraw", "alice", 0]]);
    assert.deepEqual(await cards(b, "threads:alice"), [["correction", "alice", 1]]);
    assert.deepEqual(await cards(c, "test-example:alice", "threads:bob"), [["refresh", "alice", 1], ["first", "bob", 1]]);
    // A day later another account is a switch: counted with the card that already declares it.
    await day(worker, 1);
    assert.deepEqual(await cards(b, "threads:bob"), [["switch", "bob", 2]]);
    assert.deepEqual(await cards(c, "test-example:alice", "threads:alice"), [["refresh", "alice", 1], ["switch", "alice", 1]], "the account b left has no card but this one");
  });

  test("a card whose stored state is broken does not stop another card's card proof, and is still counted; its own is 500 and writes nothing", async () => {
    await freshProofLog(worker);
    const root = await publishG3(worker);
    const broken = cardStarting(CARD_A);
    await mustSubmit(worker, await sub(worker, broken, root, "threads:alice"), "threads first");
    await worker.proofLog.breakCard(broken);
    try {
      // Another card that declares the same account: written, and the count has the broken card in it.
      const other = await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
      assert.deepEqual(other.kinds, [{ platform: "threads", kind: "first", username: "alice", account_cards: 2 }]);
      // The record rules are never run on a state that cannot be read: the broken card's own card proof is refused whole.
      const own = await sub(worker, broken, root, "threads:bob");
      await wantNoAlarmSoon(worker);
      const logged = worker.logLines().length;
      const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(own) });
      assert.deepEqual([res.status, JSON.parse(await res.text())], [500, { error: "internal" }]);
      assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", id: res.headers.get("X-Request-Id"), endpoint: "/api/v1/records", where: "proof_log", error: "Error" }]);
      assert.equal((await checkProofLog(worker)).length, 2);
      // Its page is still the one its records left: the pages do not read the rules' state.
      assert.match((await pageOf(`/p/${CARD_A}`))[1], /<span class="account">@alice<\/span>/);

      await worker.proofLog.mendCard(broken);
      // Mended, the same submission is written: its challenge was not marked.
      assert.deepEqual((await submit(worker, own)).body.kinds, [{ platform: "threads", kind: "correction", username: "bob", account_cards: 1 }]);
      await wantError(worker, own, 400, "challenge_used");
    } finally {
      await worker.proofLog.mendCard(broken).catch(() => undefined);
    }
  });
});

describe("every row of the views", () => {
  test("one record that withdraws on test-example and switches on threads: the history of both platforms and both slots, row for row", async () => {
    const card = cardStarting(CARD_A);
    await pagesWorld(worker, "2026-11-18", [r("2026-11-10", card, "test-example:a-b", "threads:alice"), r("2026-11-11", card, "threads:bob")]);
    const [d10, d11] = [parseDay("2026-11-10")!, parseDay("2026-11-11")!];
    const key = { scope_string: TEST_SCOPE, scoped_id: card };
    assert.deepEqual(await worker.proofLog.views(), {
      view_state: [{ id: 1, seq: 2 }],
      view_cards: [{ ...key, short_id: CARD_A, first_date: d10, last_card_proof: d11, card_proofs: 2 }],
      // test-example has no account and so no date from which; threads gives its place to bob from the second record.
      view_slots: [
        { ...key, platform: "test-example", current: null, since_date: null, since_seq: null, switch_count: 0, last_card_proof: d11 },
        { ...key, platform: "threads", current: "bob", since_date: d11, since_seq: 2, switch_count: 1, last_card_proof: d11 },
      ],
      view_history: [
        { seq: 1, platform: "test-example", ...key, date: d10, kind: "first", after_withdrawal: 0, before_username: null, after_username: "a-b" },
        { seq: 1, platform: "threads", ...key, date: d10, kind: "first", after_withdrawal: 0, before_username: null, after_username: "alice" },
        { seq: 2, platform: "test-example", ...key, date: d11, kind: "withdraw", after_withdrawal: 0, before_username: "a-b", after_username: null },
        { seq: 2, platform: "threads", ...key, date: d11, kind: "switch", after_withdrawal: 0, before_username: "alice", after_username: "bob" },
      ],
    });
  });

  /** A row of a view, as `worker.proofLog.views()` gives it. */
  type Row = Record<string, string | number | null>;
  /** An event of spec/vectors/record-rules.json: what the object's door takes, and the record's date. */
  type VectorEvent = RuleEvent & { readonly date: string };

  /**
   * The views as the record rules' states say they should be, kept here
   * from the state of each card just before and just after each valid
   * record, and from nothing src/views.ts computes: a card's first date is
   * the earliest of its records' and its number of card proofs counts
   * them; a slot gives its place to its current account from the record
   * that made it its current account, and keeps that date and `seq` while
   * the account stays; a slot's last card proof is its card's as of the
   * last record with a kind on it; a row of the history has the slot's last
   * declared account before the record and its current account after it.
   * The Go backend's fixture kept the same (e159ab9:server/store/views_fixture_test.go, `keep`).
   */
  class WantedViews {
    readonly #cards = new Map<string, Row>();
    readonly #slots = new Map<string, Row>();
    readonly #history: Row[] = [];

    add(e: VectorEvent, kinds: readonly PlatformKind[], before: CardState, after: CardState): void {
      const date = parseDay(e.date)!;
      const key = { scope_string: e.scope_string, scoped_id: e.scoped_id };
      const cardKey = `${e.scope_string}\n${e.scoped_id}`;
      const card = this.#cards.get(cardKey);
      this.#cards.set(cardKey, {
        ...key,
        short_id: shortId(e.scoped_id),
        first_date: card === undefined ? date : Math.min(card.first_date as number, date),
        last_card_proof: after.lastCardProof,
        card_proofs: card === undefined ? 1 : (card.card_proofs as number) + 1,
      });
      for (const { platform, kind } of kinds) {
        const b = before.slots.get(platform) ?? EMPTY_SLOT;
        const a = after.slots.get(platform)!;
        const slotKey = `${cardKey}\n${platform}`;
        const slot = this.#slots.get(slotKey);
        const since = a.current === null ? { since_date: null, since_seq: null } : a.current !== b.current ? { since_date: date, since_seq: e.seq } : { since_date: slot!.since_date!, since_seq: slot!.since_seq! };
        this.#slots.set(slotKey, { ...key, platform, current: a.current, ...since, switch_count: a.switchCount, last_card_proof: after.lastCardProof });
        this.#history.push({
          seq: e.seq,
          platform,
          ...key,
          date,
          kind,
          after_withdrawal: b.current === null && b.lastDeclared !== null ? 1 : 0,
          before_username: b.lastDeclared,
          after_username: a.current,
        });
      }
    }

    /** The rows of each view, in the order of its primary key, as `worker.proofLog.views()` gives them. */
    rows(): Record<string, Row[]> {
      const by =
        (...columns: string[]) =>
        (x: Row, y: Row): number => {
          for (const c of columns) if (x[c] !== y[c]) return x[c]! < y[c]! ? -1 : 1;
          return 0;
        };
      return {
        view_cards: [...this.#cards.values()].sort(by("scope_string", "scoped_id")),
        view_slots: [...this.#slots.values()].sort(by("scope_string", "scoped_id", "platform")),
        view_history: [...this.#history].sort(by("seq", "platform")),
      };
    }
  }

  test("every case of spec/vectors/record-rules.json: what each valid record writes is the rows the record rules' states give", async () => {
    interface Case {
      readonly name: string;
      readonly proof_log: "production" | "test";
      readonly events: readonly VectorEvent[];
      readonly results: readonly { seq: number; valid: boolean; reason?: string; kinds?: readonly PlatformKind[] }[];
    }
    const { cases } = JSON.parse(readFileSync(join(WORKER_DIR, "..", "spec", "vectors", "record-rules.json"), "utf8")) as { cases: Case[] };
    // Floors from the vectors as they are now (61 cases, 224 valid records): a file read short, or a loop cut short, fails.
    assert.ok(cases.length >= 61);
    let written = 0;
    for (const c of cases) {
      await freshProofLog(worker, { kind: c.proof_log });
      const memory = new MemoryRules(platformsOf(c.proof_log));
      const want = new WantedViews();
      for (const [i, e] of c.events.entries()) {
        const what = `${c.name}, event ${e.seq}`;
        const before = memory.card(e.scope_string, e.scoped_id);
        const outcome = memory.apply({ scopeString: e.scope_string, scopedId: e.scoped_id, challenge: e.challenge, accounts: e.accounts, verifies: e.verifies, crlDates: e.crl_dates.map((d) => parseDay(d)!) });
        // The object writes the views of a valid record as a submission does (src/views.ts, `viewOf`, `writeView`); the result is the vectors'.
        const { date: _date, ...event } = e;
        const result = await worker.proofLog.applyRuleEvent(event);
        const { seq: _, ...vector } = c.results[i]!;
        assert.deepEqual(result.valid ? { valid: true, kinds: result.kinds } : { valid: false, reason: result.reason }, vector, what);
        assert.equal(outcome.result.valid, result.valid, what);
        if (outcome.result.valid) {
          want.add(e, outcome.result.kinds, before, outcome.card);
          written++;
        }
      }
      // No record is stored for an event, so the views say they reflect none (test-build/index.ts, `testApplyRuleEvent`).
      assert.deepEqual(await worker.proofLog.views(), { view_state: [{ id: 1, seq: 0 }], ...want.rows() }, c.name);
    }
    assert.ok(written >= 224, `${written} valid records`);
  });
});

describe("the pages' reads", () => {
  test("every statement reads one stretch of one index, or of a table's primary key, and sorts nothing: the ones src/views.ts names for each read", async () => {
    // Two cards of one short ID that give their place to one account, so that the reads of a card run once for each.
    await pagesWorld(worker, "2026-11-18", [r("2026-11-10", cardStarting(CARD_A), "threads:alice"), r("2026-11-11", cardStarting(CARD_A), "threads:alice")]);
    const plans = await worker.proofLog.pagePlans({ platform: "threads", short_id: CARD_A, username: "alice", before: 2 });
    for (const { read, statement, plan } of plans) {
      // One step, which looks up a range of the index by its first columns: no SCAN, no other table, no USE TEMP B-TREE for an ORDER BY.
      assert.equal(plan.length, 1, `${read}: ${statement}\n${plan.join("\n")}`);
      assert.match(plan[0]!, /^SEARCH view_[a-z]+ USING (?:(?:COVERING )?INDEX [a-z_]+|PRIMARY KEY) \(scope_string=\? AND .+\)$/, `${read}: ${statement}`);
    }
    const used = plans.map(({ read, plan }) => [read, /USING (?:COVERING )?INDEX ([a-z_]+)/.exec(plan[0]!)?.[1] ?? /^SEARCH (view_[a-z]+) USING PRIMARY KEY/.exec(plan[0]!)![1] + " primary key"]);
    assert.deepEqual(used, [
      ["counts", "view_slots_recency"],
      ["cards", "view_cards_short_id"],
      ["cards", "view_slots primary key"],
      ["cards", "view_history_card"],
      ["cards", "view_slots primary key"],
      ["cards", "view_history_card"],
      ["account", "view_slots_account"],
      ["log", "view_slots_recency"],
      ["log", "view_history_log"],
      ["log before", "view_slots_recency"],
      ["log before", "view_history_log"],
      ["account cards", "view_slots_account"],
    ]);
  });
});
