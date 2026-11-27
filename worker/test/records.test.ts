// `POST /api/v1/records` as the whole Worker answers it in the local workerd
// (test/harness.ts): every error code, their order, the challenge's 10
// minutes and 5 submissions, the CRLs' 3 days, midnight in Taiwan, and what
// a `201` says. The cases are those of the Go backend's e159ab9:server/api_test.go
// for this endpoint, and like them they use a verifier that judges a proof
// by its first byte (test/records.ts, proofText): what is tested here is
// everything but the proof. test/records-real.test.ts has the real proofs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { MemoryRules } from "iamreal-protocol/rules-memory.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import {
  BAD_PROOF,
  CRL_TIME,
  DAY_MS,
  START,
  type Submission,
  TEST_SCOPE,
  cardState,
  checkProofLog,
  circuitOf,
  day,
  freshProofLog,
  kindsOf,
  list,
  mustSubmit,
  newCard,
  SLOW_PROOF,
  UNVERIFIABLE_PROOF,
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

const fresh = (settings: Parameters<typeof freshProofLog>[1] = {}): Promise<string> => freshProofLog(worker, settings);

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
      // In lowercase it is a root in its format (the number 10): only the case is wrong.
      "smt_root uppercase": { smt_root: `${"0".repeat(63)}A` },
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

  test("a scope string that is not this proof log's is scope, whatever else is wrong", async () => {
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

  test("the production log takes its own scope and its own table: test-example is platform, the test scope is scope", async () => {
    await fresh({ kind: "production" });
    const root = await publishG3(worker);
    const card = newCard();
    const s = { ...(await sub(worker, card, root, "test-example:a-b", "threads:alice")), scope_string: PRODUCTION_SCOPE };
    await wantError(worker, s, 400, "platform");
    await mustSubmit(worker, { ...s, accounts: list("threads:alice") }, "threads first");
    assert.deepEqual((await cardState(worker, card, PRODUCTION_SCOPE)).platforms, { threads: { current: "alice", last_declared: "alice", switch_count: 0 } });
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
    await worker.proofLog.runAlarm();
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

  test("one that expires while its proof is being verified is challenge_unknown at the write: nothing is written, and the submission counted", async () => {
    await fresh();
    const root = await publishG3(worker);
    // With time left, a proof that takes the verifier a millisecond is written like any other.
    await mustSubmit(worker, { ...(await sub(worker, newCard(), root, "threads:alice")), proof: SLOW_PROOF }, "threads first");

    // (That moved the clock a millisecond.) A challenge issued at START:
    await worker.setClock(START);
    const s = await sub(worker, newCard(), root, "threads:alice");
    // One millisecond before its 10 minutes it passes the first look. The verdict comes at 10 minutes exactly.
    await worker.setClock(new Date(START.getTime() + TEN_MINUTES - 1));
    await wantError(worker, { ...s, proof: SLOW_PROOF }, 400, "challenge_unknown");
    assert.equal((await checkProofLog(worker)).length, 1);
    assert.equal((await state(s.scoped_id)).last_card_proof, null);

    // It was one of the challenge's five: within the 10 minutes again, four more that fail, and the next is one too many.
    await worker.setClock(START);
    for (let i = 0; i < 4; i++) await wantError(worker, { ...s, proof: BAD_PROOF }, 400, "proof");
    await wantError(worker, s, 400, "challenge_attempts");
    assert.equal(await count(), 1);
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
    // One line for each round, and no trace of the two that were refused.
    assert.equal((await checkProofLog(worker)).length, 5);
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

  test("when the verifier cannot run: 500, one line that says it was the verifier, nothing written, the challenge still usable, and the submission counted", async () => {
    await fresh();
    const root = await publishG3(worker);
    const s = await sub(worker, newCard(), root, "threads:alice");
    const before = worker.logLines().length;
    const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify({ ...s, proof: proofText(2) }) });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(await res.text()), { error: "internal" });
    const lines = worker.logLines().slice(before);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ event: "internal_error", id: res.headers.get("X-Request-Id"), endpoint: "/api/v1/records", where: "verifier", error: "EngineError" }]);
    assert.equal(await count(), 0);
    assert.equal((await state(s.scoped_id)).last_card_proof, null);
    await mustSubmit(worker, s, "threads first");

    // Each such submission is one of the challenge's five: after five of them, a proof that verifies is one too many.
    const other = await sub(worker, newCard(), root, "threads:alice");
    for (let i = 0; i < 5; i++) assert.deepEqual(await submit(worker, { ...other, proof: UNVERIFIABLE_PROOF }), { status: 500, body: { error: "internal" } });
    await wantError(worker, other, 400, "challenge_attempts");
    assert.equal((await checkProofLog(worker)).length, 1);
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
    // Stale comes before the root, and before the record rules.
    await wantError(worker, await sub(worker, newCard(), `${"0".repeat(63)}1`), 503, "crl_stale");
    // The proof comes before stale: a record that does not verify is `proof` whatever the age of the CRLs.
    await wantError(worker, { ...(await sub(worker, newCard(), root, "threads:alice")), proof: BAD_PROOF }, 400, "proof");
    // A newer CRL with the same tree: the root is accepted again.
    await publishCrl(worker, { issuer: "G3", number: 2, thisUpdate: new Date(CRL_TIME.getTime() + 4 * DAY_MS), serials: [11, 12] });
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    // An issuer without a CRL in the mirror is stale too.
    await wantError(worker, { ...(await sub(worker, newCard(), root, "threads:alice")), issuer: "G2", circuit: circuitOf("G2") }, 503, "crl_stale");
  });
});

describe("the record rules", () => {
  test("date_order: more than 4 days before the proof log's latest date, or before the card's own last card proof", async () => {
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

  test("what a 201 says: the fields in the document's order, the hash of the record, the card's ordinal, each platform's kind, account and how many cards declare it", async () => {
    await fresh();
    const root = await publishG3(worker);
    const [a, b, c] = [newCard(), newCard(), newCard()];
    // The ordinal, by hand: a's first card proof is the proof log's first, b's the second, c's the third; later card
    // proofs, another account, a withdrawal of everything and declaring again keep each card's.
    const steps: [number, string, string[], number, [string, string, string, number][]][] = [
      [0, a, ["threads:alice"], 1, [["threads", "first", "alice", 1]]],
      [0, b, ["test-example:alice", "threads:alice"], 2, [["test-example", "first", "alice", 1], ["threads", "first", "alice", 2]]],
      [1, a, ["threads:bob"], 1, [["threads", "switch", "bob", 1]]],
      [1, b, ["test-example:alice"], 2, [["test-example", "refresh", "alice", 1], ["threads", "withdraw", "alice", 0]]],
      [1, a, ["threads:carol"], 1, [["threads", "switch", "carol", 1]]],
      [1, c, ["threads:dave"], 3, [["threads", "first", "dave", 1]]],
      [1, b, [], 2, [["test-example", "withdraw", "alice", 0]]],
      [2, a, ["test-example:alice", "threads:alice"], 1, [["test-example", "first", "alice", 1], ["threads", "switch", "alice", 1]]],
      [2, b, ["threads:bob"], 2, [["threads", "switch", "bob", 1]]],
    ];
    let today = 0;
    const ordinals: number[] = [];
    for (const [i, [onDay, card, accounts, ordinal, want]] of steps.entries()) {
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
        ordinal,
        kinds: want.map(([platform, kind, username, account_cards]) => ({ platform, kind, username, account_cards })),
      });
      ordinals.push(answer.body.ordinal as number);
    }
    // The same ordinals computed from the proof log by protocol/'s rules, which test/sequence.test.ts compares with Go's
    // prooflog/: every record of it is valid, and each answer's ordinal is that of the record's card.
    const memory = new MemoryRules(platformsOf("test"));
    const records = await checkProofLog(worker);
    for (const r of records) {
      const date = parseChallenge(r.challenge)!;
      assert.equal(memory.apply({ scopeString: r.scopeString, scopedId: r.scopedId, challenge: r.challenge, accounts: r.accounts, verifies: true, crlDates: [date] }).result.valid, true);
    }
    const ordinalOf = new Map(memory.output().flatMap((scope) => scope.cards.map((card) => [card.scopedId, card.ordinal] as const)));
    assert.deepEqual(ordinals, records.map((r) => ordinalOf.get(r.scopedId)));

    const refused = await submit(worker, await sub(worker, newCard(), root));
    assert.deepEqual(refused, { status: 400, body: { error: "empty" } });
    const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(await sub(worker, a, root, "test-example:alice", "threads:alice")) });
    assert.match(await res.text(), /^\{"seq":10,"record_hash":"[0-9a-f]{64}","ordinal":1,"kinds":\[\{"platform":"test-example","kind":"refresh","username":"alice","account_cards":1\},\{"platform":"threads","kind":"refresh","username":"alice","account_cards":1\}\]\}$/);
  });

  test("empty and switch_limit: the whole list is refused, nothing is recorded for any platform, and the state does not change", async () => {
    await fresh();
    const root = await publishG3(worker);
    const card = newCard();
    await wantError(worker, await sub(worker, card, root), 400, "empty");
    await mustSubmit(worker, await sub(worker, card, root, "threads:a"), "threads first");
    // Another account on the day of the first is a switch too (ADR-0018).
    await mustSubmit(worker, await sub(worker, card, root, "threads:b"), "threads switch");
    for (const [i, u] of ["c", "d", "e", "f"].entries()) {
      await day(worker, i + 1);
      await mustSubmit(worker, await sub(worker, card, root, `threads:${u}`), "threads switch");
    }
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:f"), "test-example first, threads refresh");
    assert.deepEqual(await slot(card, "threads"), { current: "f", last_declared: "f", switch_count: 5 });
    // A sixth on the day of the fifth is refused as on any other.
    await wantError(worker, await sub(worker, card, root, "test-example:a-b", "threads:g"), 400, "switch_limit");
    await day(worker, 5);
    const before = await state(card);
    await wantError(worker, await sub(worker, card, root, "test-example:c-d", "threads:i"), 400, "switch_limit");
    assert.deepEqual(await state(card), before);
    await mustSubmit(worker, await sub(worker, card, root, "test-example:c-d", "threads:f"), "test-example switch, threads refresh");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:c-d"), "test-example refresh, threads withdraw");
    await mustSubmit(worker, await sub(worker, card, root), "test-example withdraw");
    await day(worker, 6);
    await wantError(worker, await sub(worker, card, root), 400, "empty");
    await mustSubmit(worker, await sub(worker, card, root, "threads:f"), "threads refresh");
    await wantError(worker, await sub(worker, card, root, "threads:i"), 400, "switch_limit");
    assert.equal(await count(), 11);
    // The stored proof log has the eleven records that were written, and nothing of the five that were refused.
    const stored = await checkProofLog(worker);
    assert.equal(stored.length, 11);
    assert.ok(stored.every((r) => r.scopedId === card));
    assert.deepEqual(stored.map((r) => r.accounts.map((a) => `${a.platform}:${a.username}`).join(",")), [
      "threads:a", "threads:b", "threads:c", "threads:d", "threads:e", "threads:f",
      "test-example:a-b,threads:f", "test-example:c-d,threads:f", "test-example:c-d", "", "threads:f",
    ]);
  });

  test("daily_limit, the back end's limit (settings.ts, DAILY_LIMITS): no fourth record of a card on one date; a challenge issued before midnight still counts for that date, and the next day is free again", async () => {
    await fresh();
    const root = await publishG3(worker);
    await worker.setClock(tw("2026-11-20", "23:55:00"));
    const card = newCard();
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    await wantError(worker, await sub(worker, newCard(), root), 400, "empty");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:bob"), "test-example first, threads switch");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b"), "test-example refresh, threads withdraw");
    assert.deepEqual([(await state(card)).last_card_proof, (await state(card)).proofs_on_last_date], ["2026-11-20", 3]);
    const fourth = await sub(worker, card, root, "test-example:a-b", "threads:bob");
    await wantError(worker, fourth, 400, "daily_limit");
    // A list that does nothing is empty before it is one too many.
    await wantError(worker, await sub(worker, card, root, "test-example:a-b"), 400, "daily_limit");
    await wantError(worker, await sub(worker, card, root), 400, "daily_limit");
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    assert.equal(await count(), 4);
    assert.equal((await checkProofLog(worker)).length, 4);
    assert.deepEqual([(await state(card)).proofs_on_last_date, (await slot(card, "threads")).current], [3, null]);

    await worker.setClock(tw("2026-11-21", "00:00:00"));
    // The challenge of 23:55 has the date of the day before: after midnight it is still that day's fourth.
    await wantError(worker, fourth, 400, "daily_limit");
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:bob"), "test-example refresh, threads refresh");
    assert.deepEqual([(await state(card)).last_card_proof, (await state(card)).proofs_on_last_date], ["2026-11-21", 1]);
  });
});

describe("the order of the codes when several apply", () => {
  test("challenge_unknown, challenge_used, challenge_attempts, proof, crl_stale, root, the record rules", async () => {
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

describe("which verifier `records` asks in the test build", () => {
  let own: TestWorker;
  before(async () => {
    own = await startWorker();
  });
  after(() => own.close());

  test("the deployed one, unless a test asks for the stand-in: placeholder bytes the stand-in accepts are proof", async () => {
    await freshProofLog(own);
    const root = await publishG3(own);
    await wantError(own, await sub(own, newCard(), root, "threads:alice"), 400, "proof");
    assert.equal((await checkProofLog(own)).length, 0);
  });

  test("the deployed one again once the whole Worker has started again, whatever a test chose before", async () => {
    await freshProofLog(own);
    const root = await publishG3(own);
    await own.setVerifier("stand-in");
    await mustSubmit(own, await sub(own, newCard(), root, "threads:alice"), "threads first");
    await own.restart();
    // The clock and the settings went with the restart: the same again, on a new proof log.
    await freshProofLog(own);
    await wantError(own, await sub(own, newCard(), await publishG3(own), "threads:alice"), 400, "proof");
    assert.equal((await checkProofLog(own)).length, 0);
  });
});
