// The views the roster's object keeps for the pages (src/views.ts), through
// the Worker's HTTP (test/harness.ts): they are written in the transaction
// of a record, so a write that fails leaves neither; cleared, they are
// written again from the records, row for row what they were; and the
// number of cards that declare an account, which the answer of a record
// gives, comes from them and not from every card's stored state.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";
import { CARD_A, CARD_B, cardStarting, pagesWorld, r } from "./pages.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import { cardState, checkRoster, freshRoster, mustSubmit, newCard, publishCrl, publishG3, sub, submit, tw, wantError } from "./records.ts";

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
      await freshRoster(worker);
      const root = await publishG3(worker);
      const card = cardStarting(CARD_A);
      await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
      const state = await cardState(worker, card);
      const views = await worker.roster.views();
      const pages = [await pageOf(`/p/${CARD_A}`), await pageOf("/")];

      // One that would change every table: another account for this card, and a first card proof of another.
      const change = await sub(worker, card, root, "threads:bob");
      const other = await sub(worker, cardStarting(CARD_B), root, "threads:carol");
      await worker.roster.failWritesTo(table);
      for (const s of [change, other]) {
        const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(s) });
        assert.deepEqual([res.status, JSON.parse(await res.text())], [500, { error: "internal" }]);
      }
      assert.deepEqual(await cardState(worker, card), state);
      assert.deepEqual(await worker.roster.views(), views);
      assert.deepEqual([await pageOf(`/p/${CARD_A}`), await pageOf("/")], pages);
      assert.equal((await pageOf(`/p/${CARD_B}`))[0], 404);
      assert.equal((await checkRoster(worker)).length, 1);

      // Nothing was half written: started again, the object has the same; and the same submissions are then written.
      await worker.roster.failWritesTo(null);
      await worker.roster.restart();
      assert.deepEqual(await worker.roster.views(), views);
      assert.deepEqual((await submit(worker, change)).body.kinds, [{ platform: "threads", kind: "correction", username: "bob", account_cards: 1 }]);
      assert.deepEqual((await submit(worker, other)).body.kinds, [{ platform: "threads", kind: "first", username: "carol", account_cards: 1 }]);
      assert.equal((await checkRoster(worker)).length, 3);
      assert.match((await pageOf(`/p/${CARD_A}`))[1], /<span class="account">@bob<\/span>/);
      assert.equal((await pageOf(`/p/${CARD_B}`))[0], 200);
    });
  }

  // The other tables of a record (test/records-storage.test.ts has what the API answers for each).
  for (const table of ["records", "cards", "roster", "challenges.accepted"] as const) {
    test(`a write that fails at \`${table}\`: the views and the pages are as before`, async () => {
      await freshRoster(worker);
      const root = await publishG3(worker);
      const card = cardStarting(CARD_A);
      await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
      const views = await worker.roster.views();
      const page = await pageOf(`/p/${CARD_A}`);
      await worker.roster.failWritesTo(table);
      assert.equal((await submit(worker, await sub(worker, card, root, "threads:bob"))).status, 500);
      await worker.roster.failWritesTo(null);
      assert.deepEqual(await worker.roster.views(), views);
      assert.deepEqual(await pageOf(`/p/${CARD_A}`), page);
    });
  }
});

describe("the views written again from the records", () => {
  /** A roster with every kind a record can have, on both platforms of the test roster, cards that share a short ID and cards that share an account. */
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
    const views = await worker.roster.views();
    assert.deepEqual(views.view_state, [{ id: 1, seq: 16 }]);
    // Three cards; a slot for each platform a card has used; a row for each kind of each record.
    assert.deepEqual([views.view_cards!.length, views.view_slots!.length], [3, 5]);
    assert.ok(views.view_history!.length > 16);
    const paths = ["/", "/p/E000000000", `/p/${CARD_A}`];
    const pages = await Promise.all(paths.map(pageOf));

    await worker.roster.clearViews();
    assert.deepEqual((await worker.roster.views()).view_state, [{ id: 1, seq: 0 }]);
    assert.equal((await pageOf("/p/E000000000"))[0], 404);
    await worker.roster.restart();
    assert.deepEqual(await worker.roster.views(), views);
    assert.deepEqual(await Promise.all(paths.map(pageOf)), pages);

    // And the roster goes on from them: the next record is written into views that are at the record before it.
    const root = await publishCrl(worker, { issuer: "G3", number: parseDay("2026-11-18")!, thisUpdate: tw("2026-11-18", "05:00:00"), serials: [11, 12] });
    const answer = await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    assert.deepEqual([answer.seq, answer.kinds[0].account_cards], [17, 3]);
  });

  test("a paused roster does not fill them: its records were taken by other rules than this build's", async () => {
    await everyKind();
    const views = await worker.roster.views();
    await worker.roster.clearViews();
    await worker.roster.setStoredRulesVersion("another");
    await worker.roster.restart();
    try {
      assert.deepEqual((await worker.roster.views()).view_state, [{ id: 1, seq: 0 }]);
      // The pages go on, from what the views have.
      assert.equal((await pageOf("/"))[0], 200);
    } finally {
      await worker.roster.setStoredRulesVersion("the build's");
      await worker.roster.restart();
    }
    assert.deepEqual(await worker.roster.views(), views);
  });
});

describe("the number of cards that declare an account", () => {
  test("follows every kind: counted in the state the record leaves", async () => {
    await freshRoster(worker);
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
  });

  test("a card whose stored state is broken does not stop another card's card proof, and is still counted; its own is 500 and writes nothing", async () => {
    await freshRoster(worker);
    const root = await publishG3(worker);
    const broken = cardStarting(CARD_A);
    await mustSubmit(worker, await sub(worker, broken, root, "threads:alice"), "threads first");
    await worker.roster.breakCard(broken);
    try {
      // Another card that declares the same account: written, and the count has the broken card in it.
      const other = await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
      assert.deepEqual(other.kinds, [{ platform: "threads", kind: "first", username: "alice", account_cards: 2 }]);
      // The roster rules are never run on a state that cannot be read: the broken card's own card proof is refused whole.
      const own = await sub(worker, broken, root, "threads:bob");
      const logged = worker.logLines().length;
      const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(own) });
      assert.deepEqual([res.status, JSON.parse(await res.text())], [500, { error: "internal" }]);
      assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", id: res.headers.get("X-Request-Id"), endpoint: "/api/v1/records", where: "roster", error: "Error" }]);
      assert.equal((await checkRoster(worker)).length, 2);
      // Its page is still the one its records left: the pages do not read the rules' state.
      assert.match((await pageOf(`/p/${CARD_A}`))[1], /<span class="account">@alice<\/span>/);

      await worker.roster.mendCard(broken);
      // Mended, the same submission is written: its challenge was not marked.
      assert.deepEqual((await submit(worker, own)).body.kinds, [{ platform: "threads", kind: "correction", username: "bob", account_cards: 1 }]);
      await wantError(worker, own, 400, "challenge_used");
    } finally {
      await worker.roster.mendCard(broken).catch(() => undefined);
    }
  });
});
