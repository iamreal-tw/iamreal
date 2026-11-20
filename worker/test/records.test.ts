// `POST /api/v1/records` as the whole Worker answers it in the local workerd
// (test/harness.ts): every error code, their order, the challenge's 10
// minutes and 5 submissions, the CRLs' 3 days, midnight in Taiwan, and what
// a `201` says. The cases are those of the Go backend's server/api_test.go
// for this endpoint, and like them they use a verifier that judges a proof
// by its first byte (test/records.ts, proofText): what is tested here is
// everything but the proof. test/records-real.test.ts has the real proofs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";
import {
  BAD_PROOF,
  CRL_TIME,
  DAY_MS,
  START,
  type Submission,
  TEST_SCOPE,
  cardState,
  circuitOf,
  day,
  freshRoster,
  kindsOf,
  list,
  mustSubmit,
  newCard,
  proofText,
  publishCrl,
  publishG3,
  sub,
  submit,
  submitText,
  tw,
  wantError,
} from "./records.ts";

const PRODUCTION_SCOPE = "iamreal:public:0_______________";
const TEN_MINUTES = 10 * 60 * 1000;

let worker: TestWorker;

const fresh = (settings: Parameters<typeof freshRoster>[1] = {}): Promise<string> => freshRoster(worker, settings);

before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

const state = (card: string): Promise<Record<string, unknown>> => cardState(worker, card);
const count = async (): Promise<unknown> => (await state(newCard())).count;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const slot = async (card: string, platform: string): Promise<any> => ((await state(card)).platforms as Record<string, unknown>)[platform];

describe("reading the request: malformed, scope, platform", () => {
  test("a field that is not in its format is malformed", async () => {
    await fresh();
    const good = await sub(worker, newCard(), await publishG3(worker), "test-example:a-b", "threads:alice");
    const edits: Record<string, Partial<Submission>> = {
      "username in uppercase": { accounts: list("threads:Alice") },
      "username too long": { accounts: list(`threads:${"a".repeat(31)}`) },
      "username empty": { accounts: list("threads:") },
      "username with a quote": { accounts: list('threads:ali"ce') },
      "username with a backslash": { accounts: list("threads:ali\\ce") },
      "username with a line feed": { accounts: list("threads:alice\n") },
      "username with @": { accounts: list("threads:@alice") },
      "username of another platform: a.b": { accounts: list("test-example:a.b") },
      "username of another platform: a-b": { accounts: list("threads:a-b") },
      "a platform twice, same username": { accounts: list("threads:alice", "threads:alice") },
      "a platform twice, other usernames": { accounts: list("threads:alice", "threads:bob") },
      "accounts in descending order": { accounts: list("threads:alice", "test-example:a-b") },
      "accounts null": { accounts: null as never },
      "scoped ID": { scoped_id: good.scoped_id.toLowerCase() },
      "challenge padding bits": { challenge: `${good.challenge.slice(0, 36)}1` },
      "challenge date": { challenge: `2026-02-29${good.challenge.slice(10)}` },
      issuer: { issuer: "G4" },
      "smt_root uppercase": { smt_root: good.smt_root.replace(/[a-f]/, (c) => c.toUpperCase()).padEnd(64, "A").slice(0, 63) + "A" },
      "smt_root not below p": { smt_root: "f".repeat(64) },
      circuit: { circuit: good.circuit.slice(0, 63) },
      "proof one byte short": { proof: Buffer.alloc(14655).toString("base64") },
      "proof one byte long": { proof: Buffer.alloc(14657).toString("base64") },
      "proof without padding": { proof: good.proof.replace(/=+$/, "") },
      "proof in another spelling": { proof: `${good.proof.slice(0, -2)}B=` },
      "proof with a line feed": { proof: `${good.proof.slice(0, 100)}\n${good.proof.slice(101)}` },
    };
    for (const [name, edit] of Object.entries(edits)) await wantError(worker, { ...good, ...edit }, 400, "malformed", name);

    const text = JSON.stringify(good);
    const accounts = '"accounts":[{"platform":"test-example","username":"a-b"},{"platform":"threads","username":"alice"}]';
    assert.ok(text.includes(accounts));
    const withAccounts = (s: string): string => text.replace(accounts, `"accounts":${s}`);
    const bodies: Record<string, string> = {
      empty: "",
      "not JSON": "declare alice",
      "missing field": text.replace('"issuer":"G3",', ""),
      "extra field": text.replace("{", '{"seq":1,'),
      "field twice": text.replace("{", '{"issuer":"G3",'),
      "an action": text.replace("{", '{"action":"declare",'),
      "a username outside the list": text.replace("{", '{"username":"alice",'),
      "accounts missing": text.replace(`${accounts},`, ""),
      "accounts twice": text.replace(accounts, `${accounts},${accounts}`),
      "accounts in another case": text.replace('"accounts":', '"Accounts":'),
      "accounts an object": withAccounts('{"platform":"threads","username":"alice"}'),
      "accounts a string": withAccounts('"[]"'),
      "an account as a string": withAccounts('["threads:alice"]'),
      "a list inside the list": withAccounts('[[{"platform":"threads","username":"alice"}]]'),
      "an account without username": withAccounts('[{"platform":"threads"}]'),
      "an account with an extra key": withAccounts('[{"platform":"threads","username":"alice","note":"x"}]'),
      "a key twice in an account": withAccounts('[{"platform":"threads","username":"alice","username":"bob"}]'),
      "a key in another case": withAccounts('[{"Platform":"threads","username":"alice"}]'),
      "a username that is a number": withAccounts('[{"platform":"threads","username":7}]'),
      "a username null": withAccounts('[{"platform":"threads","username":null}]'),
      "a bad entry and an unknown platform": withAccounts('[{"platform":"instagram","username":"alice"},{"platform":"threads"}]'),
      "a byte order mark": `﻿${text}`,
      "longer than 64 KB": text.replace("{", `{${" ".repeat(65536)}`),
    };
    for (const [name, body] of Object.entries(bodies)) assert.deepEqual(await submitText(worker, body), { status: 400, body: { error: "malformed" } }, name);

    // None of these counted as a submission of the challenge, and none wrote anything.
    assert.equal(await count(), 0);
    // Whitespace and the order of the keys are free; the order of the accounts is not.
    const spaced = withAccounts(' [ {"username":"a-b", "platform":"test-example"} , {"platform":"threads","username":"alice"} ] ').replace("{", "{ ");
    const answer = await submitText(worker, spaced);
    assert.equal(answer.status, 201, JSON.stringify(answer.body));
    assert.equal(kindsOf(answer.body), "test-example first, threads first");
    await wantError(worker, good, 400, "challenge_used");
  });

  test("a scope string that is not this roster's is scope, whatever else is wrong", async () => {
    await fresh();
    const good = await sub(worker, newCard(), await publishG3(worker), "threads:alice");
    for (const scope of [PRODUCTION_SCOPE, "iamreal-test:x:0_______________", "iamreal-test:threads:0_________"]) await wantError(worker, { ...good, scope_string: scope }, 400, "scope", scope);
    const other = { ...good, scope_string: PRODUCTION_SCOPE };
    await wantError(worker, { ...other, accounts: list("instagram:alice") }, 400, "scope");
    await wantError(worker, { ...other, accounts: list("threads:Alice") }, 400, "scope");
    await wantError(worker, { ...other, accounts: null as never }, 400, "scope");
    await wantError(worker, { ...other, proof: BAD_PROOF, challenge: "2026-02-29.x" }, 400, "scope");
  });

  test("a well-shaped list with a platform outside the table is platform, before any other format and before the proof", async () => {
    await fresh();
    const good = await sub(worker, newCard(), await publishG3(worker), "threads:alice");
    const lists = {
      "not in the table": list("instagram:alice"),
      "another spelling": list("Threads:alice"),
      "another spelling, `_`": list("threads_:alice"),
      "next to a good account": list("instagram:alice", "threads:alice"),
      "before a bad username": list("instagram:alice", "threads:Alice"),
      "in order after a good one": list("test-example:a-b", "threads:alice", "x:y"),
      "repeated, unknown": list("x:a", "x:a"),
    };
    for (const [name, accounts] of Object.entries(lists)) {
      await wantError(worker, { ...good, accounts }, 400, "platform", name);
      await wantError(worker, { ...good, accounts, proof: BAD_PROOF }, 400, "platform", `${name}, bad proof`);
      await wantError(worker, { ...good, accounts, issuer: "G4" }, 400, "platform", `${name}, another field malformed`);
    }
    await mustSubmit(worker, good, "threads first");
  });

  test("the production roster takes its own scope and its own table: test-example is platform, the test scope is scope", async () => {
    await fresh({ kind: "production" });
    const root = await publishG3(worker);
    const card = newCard();
    const s = { ...(await sub(worker, card, root, "test-example:a-b", "threads:alice")), scope_string: PRODUCTION_SCOPE };
    await wantError(worker, s, 400, "platform");
    await mustSubmit(worker, { ...s, accounts: list("threads:alice") }, "threads first");
    assert.deepEqual((await cardState(worker, card, PRODUCTION_SCOPE)).platforms, { threads: { current: "alice", last_declared: "alice", switch_count: 0, correction_date: "2026-11-20" } });
    await wantError(worker, await sub(worker, card, root, "threads:alice"), 400, "scope");
  });
});

describe("the challenge", () => {
  test("one this back end did not issue, or issued 10 minutes ago, is challenge_unknown; a millisecond less is in time", async () => {
    await fresh();
    const root = await publishG3(worker);
    const neverIssued = { ...(await sub(worker, newCard(), root, "threads:alice")), challenge: `2026-11-20.${"0".repeat(26)}` };
    await wantError(worker, neverIssued, 400, "challenge_unknown");

    const issued = tw("2026-11-20", "23:55:00");
    await worker.setClock(issued);
    let s = await sub(worker, newCard(), root, "threads:alice");
    await worker.setClock(new Date(issued.getTime() + TEN_MINUTES));
    await wantError(worker, s, 400, "challenge_unknown", "exactly 10 minutes");

    await worker.setClock(issued);
    s = await sub(worker, newCard(), root, "threads:alice");
    await worker.setClock(new Date(issued.getTime() + TEN_MINUTES - 1));
    // Issued before midnight and submitted after it: the record has the challenge's date.
    assert.ok(s.challenge.startsWith("2026-11-20."));
    await mustSubmit(worker, s, "threads first");
    assert.equal((await state(s.scoped_id)).last_card_proof, "2026-11-20");

    // Once the object has deleted an expired challenge, it is as unknown as before.
    await worker.setClock(issued);
    s = await sub(worker, newCard(), root, "threads:alice");
    await worker.setClock(new Date(issued.getTime() + TEN_MINUTES));
    await worker.roster.runAlarm();
    await wantError(worker, s, 400, "challenge_unknown", "deleted");
    await worker.setClock(issued);
    await wantError(worker, s, 400, "challenge_unknown", "deleted, and the clock put back");
  });

  test("one a record was written for is challenge_used, for any card, however often", async () => {
    await fresh();
    const s = await sub(worker, newCard(), await publishG3(worker), "threads:alice");
    await mustSubmit(worker, s, "threads first");
    for (let i = 0; i < 7; i++) await wantError(worker, s, 400, "challenge_used");
    await wantError(worker, { ...s, scoped_id: newCard() }, 400, "challenge_used");
    await wantError(worker, { ...s, proof: BAD_PROOF }, 400, "challenge_used");
    assert.equal(await count(), 1);
  });

  test("after 4 failed submissions the fifth can succeed; after 5 the sixth is challenge_attempts, and nothing a failed one sent is written", async () => {
    await fresh();
    const root = await publishG3(worker);
    let s = await sub(worker, newCard(), root, "threads:alice");
    for (let i = 0; i < 4; i++) await wantError(worker, { ...s, proof: BAD_PROOF }, 400, "proof");
    assert.equal(await count(), 0);
    assert.equal((await state(s.scoped_id)).last_card_proof, null);
    await mustSubmit(worker, s, "threads first");

    s = await sub(worker, newCard(), root, "threads:alice");
    for (let i = 0; i < 5; i++) await wantError(worker, { ...s, proof: BAD_PROOF }, 400, "proof");
    await wantError(worker, s, 400, "challenge_attempts");
    await wantError(worker, s, 400, "challenge_attempts");
    assert.equal(await count(), 1);
    assert.equal((await state(s.scoped_id)).last_card_proof, null);

    // A submission refused for another reason than its proof counts as well.
    s = await sub(worker, newCard(), root);
    for (let i = 0; i < 5; i++) await wantError(worker, s, 400, "empty");
    await wantError(worker, { ...s, accounts: list("threads:alice") }, 400, "challenge_attempts");
  });

  test("the same challenge submitted twice at once is accepted once", async () => {
    await fresh();
    const root = await publishG3(worker);
    for (let round = 0; round < 5; round++) {
      const s = await sub(worker, newCard(), root, "threads:alice");
      const answers = await Promise.all([submit(worker, s), submit(worker, { ...s, scoped_id: newCard() }), submit(worker, s)]);
      assert.deepEqual(answers.map((a) => a.status).sort(), [201, 400, 400], JSON.stringify(answers.map((a) => a.body)));
      for (const a of answers) if (a.status === 400) assert.deepEqual(a.body, { error: "challenge_used" });
      assert.equal(await count(), round + 1);
    }
  });
});

describe("the proof", () => {
  test("a record that does not verify is proof, and nothing is written", async () => {
    await fresh();
    const s = { ...(await sub(worker, newCard(), await publishG3(worker), "threads:alice")), proof: BAD_PROOF };
    await wantError(worker, s, 400, "proof");
    assert.equal(await count(), 0);
    assert.equal((await state(s.scoped_id)).last_card_proof, null);
  });

  test("a circuit that is not accepted, or not the issuer's, is proof with the real verifier, and counts as a submission", async () => {
    await fresh();
    const root = await publishG3(worker);
    await worker.setVerifier("real");
    try {
      const s = await sub(worker, newCard(), root, "threads:alice");
      await wantError(worker, { ...s, circuit: "0".repeat(64) }, 400, "proof", "no such circuit");
      await wantError(worker, { ...s, circuit: circuitOf("G2") }, 400, "proof", "the other issuer's circuit");
      await wantError(worker, s, 400, "proof", "placeholder bytes are no proof");
      for (let i = 0; i < 2; i++) await wantError(worker, s, 400, "proof");
      await wantError(worker, s, 400, "challenge_attempts");
    } finally {
      await worker.setVerifier("stand-in");
    }
    assert.equal(await count(), 0);
  });

  test("when the verifier cannot run: 500, one line that says it was the verifier, nothing written, and the challenge still usable", async () => {
    await fresh();
    const s = await sub(worker, newCard(), await publishG3(worker), "threads:alice");
    const before = worker.logLines().length;
    const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify({ ...s, proof: proofText(2) }) });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(await res.text()), { error: "internal" });
    const lines = worker.logLines().slice(before);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ event: "internal_error", id: res.headers.get("X-Request-Id"), endpoint: "/api/v1/records", where: "verifier", error: "EngineError" }]);
    assert.equal(await count(), 0);
    assert.equal((await state(s.scoped_id)).last_card_proof, null);
    await mustSubmit(worker, s, "threads first");
  });
});

describe("the CRLs", () => {
  test("the root of one of the two newest CRLs of the issuer is accepted; the third newest, an unknown one and another issuer's are root", async () => {
    await fresh();
    const a = await publishCrl(worker, { issuer: "G3", number: 1, thisUpdate: new Date(CRL_TIME.getTime() - 2 * DAY_MS), serials: [1] });
    const c = await publishCrl(worker, { issuer: "G3", number: 3, thisUpdate: CRL_TIME, serials: [1, 2, 3] });
    const b = await publishCrl(worker, { issuer: "G3", number: 2, thisUpdate: new Date(CRL_TIME.getTime() - DAY_MS), serials: [1, 2] });
    assert.equal(new Set([a, b, c]).size, 3);
    await wantError(worker, await sub(worker, newCard(), a, "threads:alice"), 400, "root", "the third newest");
    await mustSubmit(worker, await sub(worker, newCard(), b, "threads:alice"), "threads first");
    await mustSubmit(worker, await sub(worker, newCard(), c, "threads:alice"), "threads first");
    await wantError(worker, await sub(worker, newCard(), `${"0".repeat(63)}1`, "threads:alice"), 400, "root", "no CRL's root");
    const g2 = await publishCrl(worker, { issuer: "G2", number: 4, thisUpdate: CRL_TIME, serials: [7] });
    await wantError(worker, await sub(worker, newCard(), g2, "threads:alice"), 400, "root", "a G2 root in a G3 record");
    // A file that is no CRL changes nothing.
    worker.moica.serve("G3", new TextEncoder().encode("not a CRL"));
    await worker.runSchedule();
    await mustSubmit(worker, await sub(worker, newCard(), b, "threads:alice"), "threads first");
  });

  test("on the third day after the CRL date, 23:59:59, a card proof is accepted; on the fourth, 00:00:00, it is crl_stale", async () => {
    await fresh();
    const root = await publishG3(worker); // CRL date 2026-11-20
    await worker.setClock(tw("2026-11-23", "23:59:59"));
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    await worker.setClock(tw("2026-11-24", "00:00:00"));
    await wantError(worker, await sub(worker, newCard(), root, "threads:alice"), 503, "crl_stale");
    // Stale comes before the root, and before the roster rules.
    await wantError(worker, await sub(worker, newCard(), `${"0".repeat(63)}1`), 503, "crl_stale");
    // A newer CRL with the same tree: the root is accepted again.
    await publishCrl(worker, { issuer: "G3", number: 2, thisUpdate: new Date(CRL_TIME.getTime() + 4 * DAY_MS), serials: [11, 12] });
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    // An issuer without a CRL in the mirror is stale too.
    await wantError(worker, { ...(await sub(worker, newCard(), root, "threads:alice")), issuer: "G2", circuit: circuitOf("G2") }, 503, "crl_stale");
  });
});

describe("the roster rules", () => {
  test("date_order: more than 4 days before the roster's latest date, or before the card's own last card proof", async () => {
    await fresh();
    await publishCrl(worker, { issuer: "G3", number: 1, thisUpdate: CRL_TIME, serials: [5] });
    const root = await publishCrl(worker, { issuer: "G3", number: 2, thisUpdate: new Date(CRL_TIME.getTime() + 5 * DAY_MS), serials: [5] });
    await worker.setClock(tw("2026-11-25", "12:00:00"));
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    await worker.setClock(START);
    await wantError(worker, await sub(worker, newCard(), root, "threads:alice"), 400, "date_order");
    // date_order comes before empty.
    await wantError(worker, await sub(worker, newCard(), root), 400, "date_order");
    await worker.setClock(tw("2026-11-21", "12:00:00"));
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");

    // A card that took two challenges around midnight and submits the later-dated one first.
    const card = newCard();
    await worker.setClock(tw("2026-11-25", "23:58:00"));
    const earlier = await sub(worker, card, root, "threads:alice");
    await worker.setClock(tw("2026-11-26", "00:01:00"));
    const later = await sub(worker, card, root, "threads:alice");
    await mustSubmit(worker, later, "threads first");
    await wantError(worker, earlier, 400, "date_order");
    assert.equal((await state(card)).last_card_proof, "2026-11-26");
  });

  test("what a 201 says: the fields in the document's order, the hash of the record, each platform's kind, account and how many cards declare it", async () => {
    await fresh();
    const root = await publishG3(worker);
    const [a, b] = [newCard(), newCard()];
    const steps: [number, string, string[], [string, string, string, number][]][] = [
      [0, a, ["threads:alice"], [["threads", "first", "alice", 1]]],
      [0, b, ["test-example:alice", "threads:alice"], [["test-example", "first", "alice", 1], ["threads", "first", "alice", 2]]],
      [1, a, ["threads:bob"], [["threads", "switch", "bob", 1]]],
      [1, b, ["test-example:alice"], [["test-example", "refresh", "alice", 1], ["threads", "withdraw", "alice", 0]]],
      [1, a, ["threads:carol"], [["threads", "correction", "carol", 1]]],
      [1, b, [], [["test-example", "withdraw", "alice", 0]]],
      [2, a, ["test-example:alice", "threads:alice"], [["test-example", "first", "alice", 1], ["threads", "switch", "alice", 1]]],
    ];
    let today = 0;
    for (const [i, [onDay, card, accounts, want]] of steps.entries()) {
      if (onDay > today) await day(worker, (today = onDay));
      const s = await sub(worker, card, root, ...accounts);
      const answer = await submit(worker, s);
      assert.equal(answer.status, 201, `step ${i + 1}: ${JSON.stringify(answer.body)}`);
      // The record hash, computed here from the preimage as spec/record.md writes it.
      const accountsText = `[${s.accounts.map((x) => `{"platform":"${x.platform}","username":"${x.username}"}`).join(",")}]`;
      const preimage = ["iamreal-record-v1", i + 1, s.scope_string, s.scoped_id, accountsText, s.challenge, s.issuer, s.smt_root, s.circuit, s.proof].join("\n");
      assert.deepEqual(answer.body, {
        seq: i + 1,
        record_hash: createHash("sha256").update(preimage).digest("hex"),
        kinds: want.map(([platform, kind, username, account_cards]) => ({ platform, kind, username, account_cards })),
      });
    }
    const refused = await submit(worker, await sub(worker, newCard(), root));
    assert.deepEqual(refused, { status: 400, body: { error: "empty" } });
    const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(await sub(worker, a, root, "test-example:alice", "threads:alice")) });
    assert.match(await res.text(), /^\{"seq":8,"record_hash":"[0-9a-f]{64}","kinds":\[\{"platform":"test-example","kind":"refresh","username":"alice","account_cards":1\},\{"platform":"threads","kind":"refresh","username":"alice","account_cards":1\}\]\}$/);
  });

  test("empty and switch_limit: the whole list is refused, nothing is recorded for any platform, and the state does not change", async () => {
    await fresh();
    const root = await publishG3(worker);
    const card = newCard();
    await wantError(worker, await sub(worker, card, root), 400, "empty");
    await mustSubmit(worker, await sub(worker, card, root, "threads:a"), "threads first");
    await mustSubmit(worker, await sub(worker, card, root, "threads:b"), "threads correction");
    for (const [i, u] of ["c", "d", "e", "f", "g"].entries()) {
      await day(worker, i + 1);
      await mustSubmit(worker, await sub(worker, card, root, `threads:${u}`), "threads switch");
    }
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:h"), "test-example first, threads correction");
    assert.deepEqual(await slot(card, "threads"), { current: "h", last_declared: "h", switch_count: 5, correction_date: "2026-11-25" });
    await day(worker, 6);
    const before = await state(card);
    await wantError(worker, await sub(worker, card, root, "test-example:c-d", "threads:i"), 400, "switch_limit");
    assert.deepEqual(await state(card), before);
    await mustSubmit(worker, await sub(worker, card, root, "test-example:c-d", "threads:h"), "test-example switch, threads refresh");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:c-d"), "test-example refresh, threads withdraw");
    await mustSubmit(worker, await sub(worker, card, root), "test-example withdraw");
    await day(worker, 7);
    await wantError(worker, await sub(worker, card, root), 400, "empty");
    await mustSubmit(worker, await sub(worker, card, root, "threads:h"), "threads refresh");
    await wantError(worker, await sub(worker, card, root, "threads:i"), 400, "switch_limit");
    assert.equal(await count(), 12);
  });

  test("daily_limit: the fourth record of a card on one date; a challenge issued before midnight still counts for that date, and the next day is free again", async () => {
    await fresh();
    const root = await publishG3(worker);
    await worker.setClock(tw("2026-11-20", "23:55:00"));
    const card = newCard();
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    await wantError(worker, await sub(worker, newCard(), root), 400, "empty");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:bob"), "test-example first, threads correction");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b"), "test-example refresh, threads withdraw");
    assert.deepEqual([(await state(card)).last_card_proof, (await state(card)).proofs_on_last_date], ["2026-11-20", 3]);
    const fourth = await sub(worker, card, root, "test-example:a-b", "threads:bob");
    await wantError(worker, fourth, 400, "daily_limit");
    // A list that does nothing is empty before it is one too many.
    await wantError(worker, await sub(worker, card, root, "test-example:a-b"), 400, "daily_limit");
    await wantError(worker, await sub(worker, card, root), 400, "daily_limit");
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    assert.equal(await count(), 4);
    assert.deepEqual([(await state(card)).proofs_on_last_date, (await slot(card, "threads")).current], [3, null]);

    await worker.setClock(tw("2026-11-21", "00:00:00"));
    // The challenge of 23:55 has the date of the day before: after midnight it is still that day's fourth.
    await wantError(worker, fourth, 400, "daily_limit");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:bob"), "test-example refresh, threads refresh");
    assert.deepEqual([(await state(card)).last_card_proof, (await state(card)).proofs_on_last_date], ["2026-11-21", 1]);
  });
});

describe("the back end's policy on switches", () => {
  /** A card with three switches on threads and a slot on test-example, on day 4. */
  async function threeSwitches(): Promise<{ card: string; root: string }> {
    const root = await publishG3(worker);
    const card = newCard();
    await mustSubmit(worker, await sub(worker, card, root, "threads:a"), "threads first");
    for (const [i, u] of ["b", "c", "d"].entries()) {
      await day(worker, i + 1);
      await mustSubmit(worker, await sub(worker, card, root, `threads:${u}`), "threads switch");
    }
    await mustSubmit(worker, await sub(worker, card, root, "threads:dd"), "threads correction");
    await day(worker, 4);
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:dd"), "test-example first, threads refresh");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:c-d", "threads:dd"), "test-example correction, threads refresh");
    return { card, root };
  }

  test("by default there is none: the fourth and the fifth switch are written, the sixth is the rules' switch_limit", async () => {
    await fresh();
    const { card, root } = await threeSwitches();
    await mustSubmit(worker, await sub(worker, card, root, "test-example:c-d", "threads:e"), "test-example refresh, threads switch");
    await day(worker, 5);
    await mustSubmit(worker, await sub(worker, card, root, "test-example:c-d", "threads:f"), "test-example refresh, threads switch");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:c-d", "threads:ff"), "test-example refresh, threads correction");
    await day(worker, 6);
    await wantError(worker, await sub(worker, card, root, "threads:g"), 400, "switch_limit");
  });

  test("when it is on: a fourth switch the rules accept is 403 switch_restricted and nothing is written; a record without a switch is never refused for it; the rules' own codes come first", async () => {
    await fresh({ restrictLateSwitches: true });
    const { card, root } = await threeSwitches();
    const fourth = await sub(worker, card, root, "test-example:c-d", "threads:e");
    const before = await state(card);
    await wantError(worker, fourth, 403, "switch_restricted");
    assert.deepEqual(await state(card), before);
    assert.equal(await count(), 7);
    await mustSubmit(worker, { ...fourth, accounts: list("test-example:c-d") }, "test-example refresh, threads withdraw");
    // The card's third record of the day was written: a fourth is the rules' daily_limit, not the policy's code.
    await wantError(worker, await sub(worker, card, root, "threads:e"), 400, "daily_limit");
    await day(worker, 5);
    await wantError(worker, await sub(worker, card, root, "threads:e"), 403, "switch_restricted");
    await wantError(worker, await sub(worker, newCard(), root), 400, "empty");
    // A first switch of another slot is not a late one.
    await mustSubmit(worker, await sub(worker, card, root, "test-example:e-f"), "test-example switch");
  });

  test("a value of the setting that is neither true nor false: nothing answers", async () => {
    await worker.setSettings({ ROSTER_KIND: "test", ROSTER_OBJECT_NAME: await fresh(), RESTRICT_LATE_SWITCHES: "yes" });
    for (const [method, path] of [["POST", "/api/v1/challenges"], ["GET", "/api/v1/config"], ["POST", "/api/v1/records"]] as const) assert.equal((await worker.fetch(path, { method })).status, 500, path);
  });
});

describe("the order of the codes when several apply", () => {
  test("challenge_unknown, challenge_used, challenge_attempts, proof, crl_stale, root, the roster rules", async () => {
    await fresh();
    const root = await publishG3(worker);
    const unknownRoot = `${"0".repeat(63)}1`;
    // Everything wrong at once, but the format: an unknown challenge comes first.
    const all = { ...(await sub(worker, newCard(), unknownRoot)), proof: BAD_PROOF };
    await wantError(worker, { ...all, challenge: `2026-11-20.${"0".repeat(26)}` }, 400, "challenge_unknown");
    // A known challenge: the proof comes before the root and the rules.
    await wantError(worker, all, 400, "proof");
    // A proof that verifies: the root comes before the rules (the list is empty).
    await wantError(worker, { ...all, proof: proofText(0) }, 400, "root");
    // A good root: the rules.
    await wantError(worker, { ...all, proof: proofText(0), smt_root: root }, 400, "empty");
    // Those were three submissions. After the fifth, attempts come before the proof, the root and the rules.
    await wantError(worker, all, 400, "proof");
    await wantError(worker, all, 400, "proof");
    await wantError(worker, all, 400, "challenge_attempts");
    // A challenge a record was written for: used comes before attempts and everything after.
    const used = await sub(worker, newCard(), root, "threads:alice");
    for (let i = 0; i < 4; i++) await wantError(worker, { ...used, proof: BAD_PROOF }, 400, "proof");
    await mustSubmit(worker, used, "threads first");
    await wantError(worker, { ...used, proof: BAD_PROOF, smt_root: unknownRoot, accounts: [] }, 400, "challenge_used");
    // An expired challenge is unknown even if a record was written for it.
    await worker.setClock(new Date(START.getTime() + TEN_MINUTES));
    await wantError(worker, used, 400, "challenge_unknown");
  });
});
