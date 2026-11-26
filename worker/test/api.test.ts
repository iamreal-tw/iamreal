// The API of docs/api/card-proof.md as the whole Worker answers it in the
// local workerd (test/harness.ts): challenges, card-state and config, and
// what every answer under /api/ has in common. The cases are those of the Go
// backend's e159ab9:server/api_test.go for these endpoints.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { readMinAppEntry } from "iamreal-protocol/min-app.ts";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { BAD_PROOF, GOOD_PROOF, circuitOf, mustSubmit, publishCrl, publishG3, sub } from "./records.ts";

const repoText = (path: string): string => readFileSync(join(WORKER_DIR, "..", path), "utf8");

/** Noon in Taiwan on 2026-11-20. */
const NOON = new Date("2026-11-20T04:00:00.000Z");

const TEST_SCOPE = "iamreal-test:public:0__________";
/** Scoped IDs in their one spelling (spec/vectors/scoped-id.json, "encoding"). */
const CARD = "QSP7N676SNSV57YS61FXVMVQDD9ETF5SGJ2N0CNGFF2EN8D0V880";
const OTHER_CARD = "00001W4KYQGM74BGQ5WMHT1K51ENH0C1PS2N1E19M0RY2WJECGR0";
const THIRD_CARD = "0400000000000000000000000000000000000000000000000000";

async function jsonOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

describe("GET /api/v1/config", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  test("the test log's table lists test-example and threads, in ascending order, with the keys in the document's order", async () => {
    const res = await worker.fetch("/api/v1/config");
    assert.equal(res.status, 200);
    assert.equal(
      await res.text(),
      '{"paused":false,"crl_max_age_days":3,"platforms":[{"platform":"test-example","display_name":"Example (no real service)","username_format":"[a-z0-9-]{1,20}"},{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}],"min_app":{"android":{"build":1,"from":"2026-11-20"},"ios":{"build":1,"from":"2026-11-20"}}}',
    );
  });

  test("min_app is one both apps can read (spec/min-app.md)", async () => {
    const config = await jsonOf(await worker.fetch("/api/v1/config"));
    for (const app of ["android", "ios"] as const) assert.notEqual(readMinAppEntry(config, app), null, app);
  });

  test("each format string is the one spec/scope.md writes, character for character", async () => {
    const { platforms } = (await jsonOf(await worker.fetch("/api/v1/config"))) as { platforms: { platform: string; display_name: string; username_format: string }[] };
    const spec = repoText("spec/scope.md");
    assert.equal(platforms.length, 2);
    for (const p of platforms) assert.ok(spec.includes(`| \`${p.platform}\` | ${p.display_name} | \`${p.username_format}\` |`), p.platform);
  });
});

/** Every endpoint of this back end so far, with a request it answers 200. */
const ENDPOINTS = [
  { method: "POST", path: "/api/v1/challenges", body: undefined },
  { method: "POST", path: "/api/v1/card-state", body: JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: CARD }) },
  { method: "GET", path: "/api/v1/config", body: undefined },
] as const;

describe("every answer under /api/", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
    await worker.setClock(NOON);
  });
  after(() => worker.close());

  /** The headers every answer has, and the ones none has. Returns the request ID. */
  function checkHeaders(res: Response, what: string): string {
    assert.equal(res.headers.get("Content-Type"), "application/json", what);
    assert.equal(res.headers.get("Cache-Control"), "no-store", what);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", what);
    const id = res.headers.get("X-Request-Id");
    assert.match(id ?? "", /^[0-9a-f]{16}$/, what);
    assert.equal(res.headers.get("Set-Cookie"), null, what);
    for (const [name] of res.headers) assert.doesNotMatch(name, /^access-control-/i, what);
    return id!;
  }

  test("is JSON, is not cached, carries a request ID of its own, and sets no cookie and no CORS header", async () => {
    const ids = new Set<string>();
    for (const e of ENDPOINTS) {
      const res = await worker.fetch(e.path, { method: e.method, body: e.body });
      assert.equal(res.status, 200, e.path);
      ids.add(checkHeaders(res, e.path));
      await res.text();
    }
    // And the answers that are errors: no such path, another method, a body that is refused (`records` has no other answer to an empty one).
    for (const [method, path] of [["GET", "/api/v1/nothing"], ["GET", "/api/v1/challenges"], ["POST", "/api/v1/card-state"], ["POST", "/api/v1/records"], ["GET", "/api/v1/records"]] as const) {
      const res = await worker.fetch(path, { method });
      ids.add(checkHeaders(res, `${method} ${path}`));
      await res.text();
    }
    assert.equal(ids.size, ENDPOINTS.length + 5);
  });

  test("a path that is no endpoint is 404 not_found", async () => {
    for (const [method, path] of [["GET", "/api/v1/card-state/QSP7N6"], ["GET", "/api/v1/nothing"], ["POST", "/api/v2/challenges"], ["GET", "/api/"], ["GET", "/api/v1/config/"], ["GET", "/api/v1/head"], ["POST", "/api/v1/toString"]] as const) {
      const res = await worker.fetch(path, { method });
      assert.equal(res.status, 404, path);
      assert.deepEqual(await jsonOf(res), { error: "not_found" }, path);
    }
  });

  test("another method is 405 method_not_allowed, with Allow", async () => {
    for (const [method, path, allow] of [["GET", "/api/v1/challenges", "POST"], ["GET", "/api/v1/card-state", "POST"], ["GET", "/api/v1/records", "POST"], ["PUT", "/api/v1/records", "POST"], ["POST", "/api/v1/config", "GET"], ["PUT", "/api/v1/config", "GET"], ["DELETE", "/api/v1/challenges", "POST"], ["HEAD", "/api/v1/config", "GET"]] as const) {
      const res = await worker.fetch(path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get("Allow"), allow, `${method} ${path}`);
      if (method !== "HEAD") assert.deepEqual(await jsonOf(res), { error: "method_not_allowed" }, `${method} ${path}`);
    }
  });

  test("outside /api/, what is neither a page nor a file of one is 404 (the pages: test/pages.test.ts)", async () => {
    for (const path of ["/api", "/apix/v1/config", "/nothing"]) assert.equal((await worker.fetch(path)).status, 404, path);
  });
});

const NEVER_USED = { current: null, last_declared: null, switch_count: 0, correction_date: null };
const PRODUCTION_SCOPE = "iamreal:public:0_______________";

describe("POST /api/v1/card-state", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
    await worker.setClock(NOON);
  });
  after(() => worker.close());

  const ask = (body: string): Promise<Response> => worker.fetch("/api/v1/card-state", { method: "POST", body });
  const askFor = (card: string): Promise<Response> => ask(JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: card }));

  test("a card with no record is not an error: null, 0, and an entry for every platform of the test log", async () => {
    const res = await askFor(CARD);
    assert.equal(res.status, 200);
    assert.deepEqual(await jsonOf(res), {
      last_card_proof: null,
      proofs_on_last_date: 0,
      platforms: { "test-example": NEVER_USED, threads: NEVER_USED },
      count: 0,
    });
  });

  test("the keys are in the order of the API document, and there is no `head`", async () => {
    assert.equal(
      await (await askFor(CARD)).text(),
      '{"last_card_proof":null,"proofs_on_last_date":0,"platforms":{"test-example":{"current":null,"last_declared":null,"switch_count":0,"correction_date":null},"threads":{"current":null,"last_declared":null,"switch_count":0,"correction_date":null}},"count":0}',
    );
  });

  test("whitespace and another order of the keys are JSON like any other", async () => {
    assert.equal((await ask(` { "scoped_id" : "${CARD}",\n\t"scope_string":"${TEST_SCOPE}" } `)).status, 200);
  });

  const good = `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}"}`;
  const CASES: Record<string, string> = {
    empty: "",
    "not JSON": "card state, please",
    "not an object": `["${TEST_SCOPE}"]`,
    "a string": `"${CARD}"`,
    null: "null",
    "missing key": `{"scope_string":"${TEST_SCOPE}"}`,
    "the other key missing": `{"scoped_id":"${CARD}"}`,
    "no key": "{}",
    "extra key": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}","username":"alice"}`,
    "a platform": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}","platform":"threads"}`,
    "key twice": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}","scoped_id":"${CARD}"}`,
    "the first key twice": `{"scope_string":"${TEST_SCOPE}","scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}"}`,
    "key twice, one spelled with an escape": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}","scoped\\u005fid":"${CARD}"}`,
    "key in another case": `{"Scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}"}`,
    number: `{"scope_string":"${TEST_SCOPE}","scoped_id":7}`,
    "null value": `{"scope_string":"${TEST_SCOPE}","scoped_id":null}`,
    "a list": `{"scope_string":"${TEST_SCOPE}","scoped_id":["${CARD}"]}`,
    "an object": `{"scope_string":{"value":"${TEST_SCOPE}"},"scoped_id":"${CARD}"}`,
    true: `{"scope_string":"${TEST_SCOPE}","scoped_id":true}`,
    "after the object": `${good}{}`,
    "a comma after the last member": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}",}`,
    "single quotes": good.replaceAll('"', "'"),
    "a byte order mark": `﻿${good}`,
    "production scope": `{"scope_string":"${PRODUCTION_SCOPE}","scoped_id":"${CARD}"}`,
    "unknown scope": `{"scope_string":"iamreal-test:public:1__________","scoped_id":"${CARD}"}`,
    "scope of one platform": `{"scope_string":"iamreal-test:threads:0_________","scoped_id":"${CARD}"}`,
    "scope with a line feed after it": `{"scope_string":"${TEST_SCOPE}\\n","scoped_id":"${CARD}"}`,
    "empty scope": `{"scope_string":"","scoped_id":"${CARD}"}`,
    "lowercase scoped ID": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD.toLowerCase()}"}`,
    "short scoped ID": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD.slice(0, 51)}"}`,
    "short ID in place of the scoped ID": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD.slice(0, 10)}"}`,
    "scoped ID not below p": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${"Z".repeat(51)}0"}`,
    "scoped ID with a space after it": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD} "}`,
    "too long": `{"scope_string":"${TEST_SCOPE}","scoped_id":"${CARD}"${" ".repeat(64 * 1024)}}`,
    "nested too deep to be a request": "[".repeat(40_000) + "]".repeat(40_000),
  };
  for (const [name, body] of Object.entries(CASES)) {
    test(`malformed: ${name}`, async () => {
      const res = await ask(body);
      assert.equal(res.status, 400);
      assert.deepEqual(await jsonOf(res), { error: "malformed" });
    });
  }
  for (const c of (JSON.parse(repoText("spec/vectors/scoped-id.json")) as { invalid: { scoped_id: string; reason: string }[] }).invalid) {
    test(`malformed: a scoped ID the specification rejects (${c.reason})`, async () => {
      const res = await askFor(c.scoped_id);
      assert.equal(res.status, 400);
      assert.deepEqual(await jsonOf(res), { error: "malformed" });
    });
  }

  test("malformed: a body that is not UTF-8", async () => {
    const bytes = new TextEncoder().encode(good);
    bytes[20] = 0xff;
    const res = await worker.fetch("/api/v1/card-state", { method: "POST", body: bytes });
    assert.equal(res.status, 400);
    assert.deepEqual(await jsonOf(res), { error: "malformed" });
  });

  test("the limit is 64 KB: a body of exactly that is read, one byte more is malformed", async () => {
    const padded = (length: number): string => good.slice(0, -1) + " ".repeat(length - good.length) + "}";
    assert.equal(padded(64 * 1024).length, 64 * 1024);
    assert.equal((await ask(padded(64 * 1024))).status, 200);
    const res = await ask(padded(64 * 1024 + 1));
    assert.equal(res.status, 400);
    assert.deepEqual(await jsonOf(res), { error: "malformed" });
  });

  test("a card with records: its own items and each slot's, as the records left them", async () => {
    // Written by submitting: threads first (alice) on 11-04; on 11-19 test-example first (a-b) and
    // threads switch (bob); then, the same day, a list without threads (a withdrawal). The proofs
    // are placeholders, so the stand-in verifier (test/records.ts).
    await worker.setVerifier("stand-in");
    await worker.setClock(new Date("2026-11-04T12:00:00+08:00"));
    const root = await publishCrl(worker, { issuer: "G3", number: 1, thisUpdate: new Date("2026-11-03T21:00:00Z"), serials: [11, 12] });
    await mustSubmit(worker, await sub(worker, CARD, root, "threads:alice"), "threads first");
    await worker.setClock(new Date("2026-11-19T12:00:00+08:00"));
    await publishCrl(worker, { issuer: "G3", number: 2, thisUpdate: new Date("2026-11-18T21:00:00Z"), serials: [11, 12] });
    await mustSubmit(worker, await sub(worker, CARD, root, "test-example:a-b", "threads:bob"), "test-example first, threads switch");
    await mustSubmit(worker, await sub(worker, CARD, root, "test-example:a-b"), "test-example refresh, threads withdraw");

    assert.equal(
      await (await askFor(CARD)).text(),
      '{"last_card_proof":"2026-11-19","proofs_on_last_date":2,"platforms":{"test-example":{"current":"a-b","last_declared":"a-b","switch_count":0,"correction_date":"2026-11-19"},"threads":{"current":null,"last_declared":"bob","switch_count":1,"correction_date":"2026-11-19"}},"count":3}',
    );
    // Another card is still one without a record.
    assert.deepEqual(((await jsonOf(await askFor(THIRD_CARD))) as { last_card_proof: unknown }).last_card_proof, null);
  });

  test("a stored state without a slot for a platform of the table, as one written before the platform was added: the empty slot for it", async () => {
    // No record leaves such a row, since the rules keep a slot for every platform of the table: it is written as it is.
    await worker.proofLog.writeCard({
      scope_string: TEST_SCOPE,
      scoped_id: OTHER_CARD,
      seq: 4,
      last_card_proof: "2026-03-02",
      proofs_on_last_date: 3,
      platforms: { threads: { current: "alice", last_declared: "alice", switch_count: 5, correction_date: "2026-03-02" } },
    });
    assert.deepEqual(await jsonOf(await askFor(OTHER_CARD)), {
      last_card_proof: "2026-03-02",
      proofs_on_last_date: 3,
      platforms: { "test-example": NEVER_USED, threads: { current: "alice", last_declared: "alice", switch_count: 5, correction_date: "2026-03-02" } },
      count: 3,
    });
  });

  test("a later record of a card replaces its state, which is still there after the object starts again", async () => {
    await worker.setClock(NOON);
    const root = await publishCrl(worker, { issuer: "G3", number: 3, thisUpdate: new Date("2026-11-19T21:00:00Z"), serials: [11, 12] });
    await mustSubmit(worker, await sub(worker, CARD, root, "test-example:a-b", "threads:carol"), "test-example refresh, threads switch");
    const before = await (await askFor(CARD)).text();
    assert.equal(
      before,
      '{"last_card_proof":"2026-11-20","proofs_on_last_date":1,"platforms":{"test-example":{"current":"a-b","last_declared":"a-b","switch_count":0,"correction_date":"2026-11-19"},"threads":{"current":"carol","last_declared":"carol","switch_count":2,"correction_date":"2026-11-20"}},"count":4}',
    );

    await worker.proofLog.restart();

    assert.equal(await (await askFor(CARD)).text(), before);
  });
});

describe("what the back end writes down about a request", () => {
  test("nothing: after every kind of request, the live log has no line, and no answer repeats what came in", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(NOON);
      // A proof log with a record, written through the API. The mirror's round writes its own lines: the count starts after it.
      await worker.setVerifier("stand-in");
      const root = await publishG3(worker);
      const logged = worker.logLines().length;
      const sent = { headers: { "X-Forwarded-For": "203.0.113.7", "CF-Connecting-IP": "203.0.113.7", "User-Agent": "a-browser-of-the-test/1.0", Cookie: "session=of-the-test" } };
      const challenge = ((await jsonOf(await worker.fetch("/api/v1/challenges", { method: "POST", ...sent }))) as { challenge: string }).challenge;
      const answers: Response[] = [
        await worker.fetch("/api/v1/config", sent),
        await worker.fetch("/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: CARD }), ...sent }),
        await worker.fetch("/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: OTHER_CARD, username: "alice", challenge }), ...sent }),
        await worker.fetch(`/api/v1/card-state/${CARD}?challenge=${challenge}`, sent),
        await worker.fetch("/api/v1/challenges", sent),
      ];
      // A record that is written, the same one again, one whose proof does not verify, and one that cannot be read.
      const record = { scope_string: TEST_SCOPE, scoped_id: CARD, accounts: [{ platform: "threads", username: "alice" }], challenge, issuer: "G3", smt_root: root, circuit: circuitOf("G3"), proof: GOOD_PROOF };
      const second = ((await jsonOf(await worker.fetch("/api/v1/challenges", { method: "POST", ...sent }))) as { challenge: string }).challenge;
      for (const [body, status] of [[record, 201], [record, 400], [{ ...record, challenge: second, proof: BAD_PROOF }, 400], [{ ...record, challenge: second, username: "alice" }, 400]] as const) {
        const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify(body), ...sent });
        assert.equal(res.status, status);
        answers.push(res);
      }
      answers.push(await worker.fetch("/api/v1/records", sent));
      // The state of the card names its account, as it must; nothing else that came in is in any answer.
      for (const res of answers) {
        const text = [await res.text(), ...[...res.headers].map(([name, value]) => `${name}: ${value}`)].join("\n");
        for (const secret of [challenge, second, CARD, OTHER_CARD, root, GOOD_PROOF.slice(0, 64), "203.0.113.7", "a-browser-of-the-test", "of-the-test"]) assert.ok(!text.includes(secret), `an answer holds ${secret}`);
      }
      assert.deepEqual(worker.logLines().slice(logged), []);
    } finally {
      await worker.close();
    }
  });

  test("when the back end itself fails: 500 internal, and one line with the request ID, the endpoint and where, nothing of the request", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(NOON);
      const challenge = await issue(worker);
      await worker.proofLog.breakTables();

      const failed = [
        await worker.fetch("/api/v1/challenges", { method: "POST", headers: { "X-Forwarded-For": "203.0.113.7" } }),
        await worker.fetch("/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: CARD }), headers: { "X-Forwarded-For": "203.0.113.7" } }),
      ];
      const ids: string[] = [];
      for (const res of failed) {
        assert.equal(res.status, 500);
        assert.equal(res.headers.get("Content-Type"), "application/json");
        assert.equal(res.headers.get("Cache-Control"), "no-store");
        ids.push(res.headers.get("X-Request-Id")!);
        assert.deepEqual(await jsonOf(res), { error: "internal" });
      }
      // config does not ask the proof log's object, so it still answers.
      assert.equal((await worker.fetch("/api/v1/config")).status, 200);

      const lines = worker.logLines().filter((l) => l.includes("internal_error"));
      assert.deepEqual(lines.map((l) => JSON.parse(l) as unknown), [
        { event: "internal_error", id: ids[0], endpoint: "/api/v1/challenges", where: "proof_log", error: "Error" },
        { event: "internal_error", id: ids[1], endpoint: "/api/v1/card-state", where: "proof_log", error: "Error" },
      ]);
      const log = worker.logLines().join("\n");
      for (const secret of [challenge, CARD, "203.0.113.7", TEST_SCOPE]) assert.ok(!log.includes(secret), `the log holds ${secret}`);
    } finally {
      await worker.close();
    }
  });
});

/** A moment given in Taiwan time. */
const tw = (text: string): Date => new Date(`${text}+08:00`);

/** The challenge format of spec/challenge.md, the regular expression it gives for the whole string. */
function challengePattern(): RegExp {
  const m = /^(\[0-9\]\{4\}-.*)$/m.exec(repoText("spec/challenge.md"));
  assert.ok(m, "spec/challenge.md gives the format as a regular expression");
  return new RegExp(`^(?:${m[1]})$`);
}

async function issue(worker: TestWorker): Promise<string> {
  const res = await worker.fetch("/api/v1/challenges", { method: "POST" });
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { challenge: string };
  assert.deepEqual(Object.keys(body), ["challenge"]);
  return body.challenge;
}

describe("POST /api/v1/challenges", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
    await worker.setClock(NOON);
  });
  after(() => worker.close());

  test("a challenge is in the one spelling of spec/challenge.md and dated today in Taiwan", async () => {
    const challenge = await issue(worker);
    assert.match(challenge, challengePattern());
    assert.equal(challenge.length, 37);
    assert.equal(challenge.slice(0, 11), "2026-11-20.");
    // What the device and every re-verifier check (protocol/, tested against spec/vectors/challenge.json).
    assert.notEqual(parseChallenge(challenge), null);
  });

  test("the date is the date in Taiwan at the moment of issuing: it changes at 16:00 UTC", async () => {
    for (const [at, date] of [
      [new Date(tw("2026-11-20T23:59:59").getTime() + 999), "2026-11-20"],
      [tw("2026-11-21T00:00:00"), "2026-11-21"],
      [new Date("2026-12-31T15:59:59Z"), "2026-12-31"],
      [new Date("2026-12-31T16:00:00Z"), "2027-01-01"],
      [new Date("2028-02-28T16:00:00Z"), "2028-02-29"],
    ] as const) {
      await worker.setClock(at);
      const challenge = await issue(worker);
      assert.equal(challenge.slice(0, 10), date, at.toISOString());
      assert.notEqual(parseChallenge(challenge), null);
    }
  });

  test("no two challenges are the same", async () => {
    await worker.setClock(NOON);
    const issued = await Promise.all(Array.from({ length: 50 }, () => issue(worker)));
    assert.equal(new Set(issued).size, 50);
  });

  test("the request carries nothing: a body, whatever it is, is not read", async () => {
    for (const body of ['{"platform":"threads"}', "not JSON", "x".repeat(70_000)]) {
      const res = await worker.fetch("/api/v1/challenges", { method: "POST", body });
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys((await jsonOf(res)) as object), ["challenge"]);
    }
  });

  test("a date no challenge can have (after 2049) is the back end's failure, and no challenge is issued", async () => {
    await worker.setClock(new Date("2050-01-01T00:00:00Z"));
    const before = await worker.proofLog.knownChallenges();
    const res = await worker.fetch("/api/v1/challenges", { method: "POST" });
    assert.equal(res.status, 500);
    assert.deepEqual(await jsonOf(res), { error: "internal" });
    assert.deepEqual(await worker.proofLog.knownChallenges(), before);
  });
});

describe("the challenges the proof log's object keeps", () => {
  const ISSUED = tw("2026-11-20T23:55:00");
  const LIFETIME_MS = 10 * 60 * 1000;

  test("a challenge issued is still known after the object starts again", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(ISSUED);
      const first = await issue(worker);
      const second = await issue(worker);
      assert.deepEqual(await worker.proofLog.knownChallenges(), [first, second].sort());

      await worker.proofLog.restart();

      assert.deepEqual(await worker.proofLog.knownChallenges(), [first, second].sort());
      // And it goes on issuing, next to the ones it had.
      const third = await issue(worker);
      assert.deepEqual(await worker.proofLog.knownChallenges(), [first, second, third].sort());
    } finally {
      await worker.close();
    }
  });

  test("an expired challenge is deleted: one issued 10 minutes ago is, one a millisecond younger is not", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(ISSUED);
      const old = await issue(worker);
      await worker.setClock(new Date(ISSUED.getTime() + 1));
      const younger = await issue(worker);

      // A millisecond before the first expires, nothing is deleted.
      await worker.setClock(new Date(ISSUED.getTime() + LIFETIME_MS - 1));
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.knownChallenges(), [old, younger].sort());

      // Exactly 10 minutes after it was issued, after midnight in Taiwan, the first is gone.
      await worker.setClock(new Date(ISSUED.getTime() + LIFETIME_MS));
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.knownChallenges(), [younger]);

      await worker.setClock(new Date(ISSUED.getTime() + LIFETIME_MS + 1));
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.knownChallenges(), []);
      // With nothing left, running it again does nothing.
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.knownChallenges(), []);
    } finally {
      await worker.close();
    }
  });

  test("the table does not keep growing: after hours of issuing, only the challenges of the last 10 minutes are left", async () => {
    const worker = await startWorker();
    try {
      let last: string[] = [];
      // 5 challenges every 4 minutes for 2 hours; the alarm runs after each round.
      for (let minute = 0; minute <= 120; minute += 4) {
        await worker.setClock(new Date(ISSUED.getTime() + minute * 60_000));
        last = await Promise.all(Array.from({ length: 5 }, () => issue(worker)));
        await worker.proofLog.runAlarm();
      }
      // The rounds at minutes 112, 116 and 120 are less than 10 minutes old: of the 155 issued, those 15 are known.
      const known = await worker.proofLog.knownChallenges();
      assert.equal(known.length, 15);
      for (const c of last) assert.ok(known.includes(c));
      // And the object keeps nothing older: its alarm is set for when the round of minute 112 expires, 2 minutes ahead.
      const alarm = await worker.proofLog.alarmInMs();
      assert.ok(alarm !== null && alarm > 110_000 && alarm <= 120_000, `the alarm is ${alarm} ms ahead`);
    } finally {
      await worker.close();
    }
  });

  test("the object wakes itself to delete: until a challenge is issued its alarm is the daily publication's, at midnight in Taiwan; then it is 10 minutes ahead", async () => {
    const worker = await startWorker();
    try {
      // Noon in Taiwan: an object that has only started has its alarm 12 hours ahead (README.md, "每天換日公布證明紀錄").
      await worker.setClock(tw("2026-11-20T12:00:00"));
      const midnight = await worker.proofLog.alarmInMs();
      assert.ok(midnight !== null && midnight > 11.9 * 3600_000 && midnight <= 12 * 3600_000, `the alarm is ${midnight} ms ahead`);
      await issue(worker);
      const wait = await worker.proofLog.alarmInMs();
      assert.ok(wait !== null && wait > 9 * 60_000 && wait <= 10 * 60_000, `the alarm is ${wait} ms ahead`);
      // A second challenge does not move it.
      await issue(worker);
      const later = await worker.proofLog.alarmInMs();
      assert.ok(later !== null && later <= wait, `the alarm moved from ${wait} to ${later} ms ahead`);
    } finally {
      await worker.close();
    }
  });
});

describe("the object's timed work shares its one alarm", () => {
  const START = tw("2026-11-20T12:00:00");
  const MINUTE = 60_000;
  const DAY = 24 * 60 * MINUTE;
  const at = (minutes: number): Date => new Date(START.getTime() + minutes * MINUTE);
  /** The alarm is `minutes` ahead, give or take the seconds the test itself took. */
  async function alarmIsAhead(worker: TestWorker, minutes: number, what: string): Promise<void> {
    const wait = await worker.proofLog.alarmInMs();
    assert.ok(wait !== null && wait > (minutes - 0.5) * MINUTE && wait <= minutes * MINUTE, `${what}: the alarm is ${wait} ms ahead, not ${minutes} minutes`);
  }

  test("other work that already holds the alarm, far ahead, does not keep an expired challenge: the alarm moves to the challenge's 10 minutes", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(START);
      // START is noon in Taiwan, and the object's own daily publication is due at midnight: the other work is due before that.
      await worker.proofLog.setExtraWork(at(11 * 60), DAY);
      await alarmIsAhead(worker, 11 * 60, "with only the other work");

      const challenge = await issue(worker);
      await alarmIsAhead(worker, 10, "once a challenge is issued");

      await worker.setClock(at(10));
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.knownChallenges(), []);
      assert.ok(!(await worker.proofLog.knownChallenges()).includes(challenge));
      // The other work was not due and did not run; the alarm is now its own.
      assert.deepEqual(await worker.proofLog.extraWorkRuns(), []);
      await alarmIsAhead(worker, 10 * 60 + 50, "with the challenge gone");
    } finally {
      await worker.close();
    }
  });

  test("two pieces due at different times each run once, at their own time, and the alarm is always the earlier of the two", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(START);
      const challenge = await issue(worker);
      await alarmIsAhead(worker, 10, "with only the challenge");
      await worker.proofLog.setExtraWork(at(3), DAY);
      await alarmIsAhead(worker, 3, "with other work due sooner");

      // Woken before anything is due: nothing runs.
      await worker.setClock(at(1));
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.extraWorkRuns(), []);
      assert.deepEqual(await worker.proofLog.knownChallenges(), [challenge]);
      await alarmIsAhead(worker, 2, "woken early");

      // At 3 minutes the other work runs; the challenge is not touched.
      await worker.setClock(at(3));
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.extraWorkRuns(), [at(3)]);
      assert.deepEqual(await worker.proofLog.knownChallenges(), [challenge]);
      await alarmIsAhead(worker, 7, "after the other work ran");

      // At 10 minutes the challenge is deleted; the other work, due again a day later, does not run.
      await worker.setClock(at(10));
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.knownChallenges(), []);
      assert.deepEqual(await worker.proofLog.extraWorkRuns(), [at(3)]);
      // The other work is due a day after it ran; before that comes midnight in Taiwan, 12 hours after START, and the daily publication.
      await alarmIsAhead(worker, 12 * 60 - 10, "with the challenge gone and the other work a day ahead");

      // Both due at once: both run.
      const second = await issue(worker);
      await worker.setClock(at(24 * 60 + 3));
      await worker.proofLog.runAlarm();
      assert.deepEqual(await worker.proofLog.extraWorkRuns(), [at(3), at(24 * 60 + 3)]);
      assert.ok(!(await worker.proofLog.knownChallenges()).includes(second));
    } finally {
      await worker.close();
    }
  });

  test("an alarm that rings by itself sets the next one: after the work that was due, the alarm is the challenge's, with no request in between", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(START);
      await issue(worker);
      await worker.proofLog.setExtraWork(START, DAY);
      // Nothing is asked of the object while its alarm rings, a second from now, so nothing but the alarm's own handler sets the next.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.deepEqual(await worker.proofLog.extraWorkRuns(), [START]);
      await alarmIsAhead(worker, 10, "once the alarm rang by itself");
    } finally {
      await worker.close();
    }
  });

  test("challenges issued more often than the alarm's least wait do not keep pushing the alarm away: work that is due runs within seconds", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(START);
      await issue(worker);
      // Work that is due now, while a challenge is issued every 300 ms for three seconds: each of them sets the alarm.
      await worker.proofLog.setExtraWork(START, DAY);
      for (let i = 0; i < 10; i++) {
        await issue(worker);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      assert.deepEqual(await worker.proofLog.extraWorkRuns(), [START]);
      // The alarm is then the challenges' own again.
      await alarmIsAhead(worker, 10, "once the other work ran");
    } finally {
      await worker.close();
    }
  });
});

/** The one line the back end wrote about each of its own failures, in order. */
const failuresIn = (worker: TestWorker): { endpoint: string; where: string; error: string; id: string }[] =>
  worker
    .logLines()
    .filter((l) => l.includes("internal_error"))
    .map((l) => JSON.parse(l) as { endpoint: string; where: string; error: string; id: string });

describe("a stored state of a card that the rules cannot have left", () => {
  const GOOD = {
    scope_string: TEST_SCOPE,
    scoped_id: CARD,
    seq: 7,
    last_card_proof: "2026-11-19",
    proofs_on_last_date: 2,
    platforms: {
      "test-example": { current: "a-b", last_declared: "a-b", switch_count: 0, correction_date: "2026-11-04" },
      threads: { current: "bob", last_declared: "bob", switch_count: 5, correction_date: "2026-11-19" },
    },
  };
  const threads = (slot: { current?: string | null; last_declared?: string | null; switch_count?: number; correction_date?: string | null }): object => ({ ...GOOD, platforms: { ...GOOD.platforms, threads: { ...GOOD.platforms.threads, ...slot } } });
  const BROKEN: Record<string, object> = {
    "switch_count 99": threads({ switch_count: 99 }),
    "switch_count 6, one more than the rules give": threads({ switch_count: 6 }),
    "switch_count -1": threads({ switch_count: -1 }),
    "switch_count 1.5": threads({ switch_count: 1.5 }),
    "proofs_on_last_date 0": { ...GOOD, proofs_on_last_date: 0 },
    "proofs_on_last_date 4, one more than the rules allow": { ...GOOD, proofs_on_last_date: 4 },
    "the seq of the last record is 0": { ...GOOD, seq: 0 },
    "an account not in the format of its platform: uppercase on threads": threads({ current: "Bob", last_declared: "Bob" }),
    "an account in the format of another platform: a-b on threads": threads({ current: "a-b", last_declared: "a-b" }),
    "an account with a line feed": threads({ current: "bob\n", last_declared: "bob\n" }),
    "a withdrawn account not in the format": threads({ current: null, last_declared: "@bob" }),
    "a slot on a platform outside the table": { ...GOOD, platforms: { ...GOOD.platforms, instagram: GOOD.platforms.threads } },
    "current is not last_declared": threads({ current: "alice" }),
    "an account without the date it was declared on": threads({ correction_date: null }),
    "a correction_date after the last card proof": threads({ correction_date: "2026-11-20" }),
    "switches without an account": threads({ current: null, last_declared: null, correction_date: null, switch_count: 1 }),
  };

  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
    await worker.setClock(NOON);
  });
  after(() => worker.close());
  const ask = (card: string): Promise<Response> => worker.fetch("/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: card }) });

  test("the state every case below starts from is one the rules leave: it is answered", async () => {
    await worker.proofLog.writeCard(GOOD);
    const res = await ask(CARD);
    assert.equal(res.status, 200);
    assert.deepEqual(await jsonOf(res), { last_card_proof: "2026-11-19", proofs_on_last_date: 2, platforms: GOOD.platforms, count: 0 });
  });

  for (const [name, card] of Object.entries(BROKEN)) {
    test(`is not handed on: ${name} is 500, with one line that says the proof log's object failed`, async () => {
      await worker.proofLog.writeCard(card as never);
      const before = failuresIn(worker).length;

      const res = await ask(CARD);

      assert.equal(res.status, 500);
      assert.deepEqual(await jsonOf(res), { error: "internal" });
      assert.deepEqual(failuresIn(worker).slice(before), [{ event: "internal_error", id: res.headers.get("X-Request-Id"), endpoint: "/api/v1/card-state", where: "proof_log", error: "Error" }]);
      // Another card is answered as before.
      assert.equal((await ask(OTHER_CARD)).status, 200);
    });
  }

  test("nothing of the broken state is in the log", () => {
    const log = worker.logLines().join("\n");
    for (const secret of [CARD, "Bob", "@bob", "instagram", "a-b", TEST_SCOPE]) assert.ok(!log.includes(secret), `the log holds ${secret}`);
  });
});

describe("the setting that says which proof log the environment serves", () => {
  const cardState = (worker: TestWorker, scope: string): Promise<Response> => worker.fetch("/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: scope, scoped_id: CARD }) });

  // The name of a test log's object starts with `test-`, that of the production log's does not.
  const WRONG: [why: string, kind: string, name: string][] = [
    ["a kind that names no proof log", "staging", "test-1"],
    ["an empty kind", "", "test-1"],
    ["a kind in another case", "Test", "test-1"],
    ["a kind with a space after it", "production ", "proof-log-1"],
    ["the production log on the test log's object", "production", "test-1"],
    ["the production log on any object named as a test one", "production", "test-"],
    ["the test log on an object not named as a test one", "test", "proof-log-1"],
    ["the test log on an object named `test` without the hyphen", "test", "test"],
    ["the test log on an object named in another case", "test", "Test-1"],
  ];
  for (const [why, kind, name] of WRONG) {
    test(`${why} (PROOF_LOG_KIND ${JSON.stringify(kind)}, PROOF_LOG_OBJECT_NAME ${JSON.stringify(name)}): every endpoint is 500, the line says it is the settings, and the object is not asked`, async () => {
      const worker = await startWorker({ settings: { PROOF_LOG_KIND: kind, PROOF_LOG_OBJECT_NAME: name } });
      try {
        await worker.setClock(NOON);
        const answers = [
          await worker.fetch("/api/v1/challenges", { method: "POST" }),
          await cardState(worker, TEST_SCOPE),
          await cardState(worker, PRODUCTION_SCOPE),
          await worker.fetch("/api/v1/config"),
        ];
        for (const res of answers) {
          assert.equal(res.status, 500);
          assert.deepEqual(await jsonOf(res), { error: "internal" });
        }
        assert.deepEqual(
          failuresIn(worker).map((l) => [l.endpoint, l.where, l.id]),
          [
            ["/api/v1/challenges", "settings", answers[0]!.headers.get("X-Request-Id")],
            ["/api/v1/card-state", "settings", answers[1]!.headers.get("X-Request-Id")],
            ["/api/v1/card-state", "settings", answers[2]!.headers.get("X-Request-Id")],
            ["/api/v1/config", "settings", answers[3]!.headers.get("X-Request-Id")],
          ],
        );
        // What does not need the settings is as ever.
        assert.equal((await worker.fetch("/api/v1/nothing")).status, 404);
        assert.equal((await worker.fetch("/api/v1/config", { method: "POST" })).status, 405);

        // With settings that fit the same object, it turns out never to have issued a challenge.
        await worker.setSettings({ PROOF_LOG_KIND: name.startsWith("test-") ? "test" : "production", PROOF_LOG_OBJECT_NAME: name });
        assert.deepEqual(await worker.proofLog.knownChallenges(), []);
        const first = await issue(worker);
        assert.deepEqual(await worker.proofLog.knownChallenges(), [first]);
      } finally {
        await worker.close();
      }
    });
  }

  test("the production log: its table has threads only, it takes its own scope, and the test log's scope is malformed", async () => {
    const worker = await startWorker({ settings: { PROOF_LOG_KIND: "production", PROOF_LOG_OBJECT_NAME: "production-of-the-test" } });
    try {
      await worker.setClock(NOON);
      const config = await worker.fetch("/api/v1/config");
      assert.equal(config.status, 200);
      const text = await config.text();
      assert.equal(text, '{"paused":false,"crl_max_age_days":3,"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}],"min_app":{"android":{"build":1,"from":"2026-11-20"},"ios":{"build":1,"from":"2026-11-20"}}}');
      // The row is the one under "Production log" in spec/scope.md, and no row is a test platform.
      const spec = repoText("spec/scope.md");
      assert.ok(spec.slice(spec.indexOf("**Production log**", spec.indexOf("## Platforms")), spec.indexOf("**Test logs only**", spec.indexOf("## Platforms"))).includes("| `threads` | Threads | `[a-z0-9._]{1,30}` |"));
      assert.ok(!text.includes("test-"));
      for (const app of ["android", "ios"] as const) assert.notEqual(readMinAppEntry(JSON.parse(text), app), null, app);

      const state = await cardState(worker, PRODUCTION_SCOPE);
      assert.equal(state.status, 200);
      assert.deepEqual(await jsonOf(state), { last_card_proof: null, proofs_on_last_date: 0, platforms: { threads: NEVER_USED }, count: 0 });

      const other = await cardState(worker, TEST_SCOPE);
      assert.equal(other.status, 400);
      assert.deepEqual(await jsonOf(other), { error: "malformed" });

      assert.equal((await issue(worker)).slice(0, 10), "2026-11-20");

      // A stored slot on a test platform is not a state of this proof log.
      await worker.proofLog.writeCard({
        scope_string: PRODUCTION_SCOPE,
        scoped_id: CARD,
        seq: 1,
        last_card_proof: "2026-11-19",
        proofs_on_last_date: 1,
        platforms: { "test-example": { current: "a-b", last_declared: "a-b", switch_count: 0, correction_date: "2026-11-19" } },
      });
      assert.equal((await cardState(worker, PRODUCTION_SCOPE)).status, 500);
    } finally {
      await worker.close();
    }
  });

  test("tables made by another version than the build's: the object reads and writes nothing, the endpoints that ask it are 500 and the line says it is the schema, until the version is the build's again", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(NOON);
      const challenge = await issue(worker);
      assert.equal((await cardState(worker, TEST_SCOPE)).status, 200);

      // As a deploy of a build with another version would find it: the stored version differs when the object starts.
      await worker.proofLog.setStoredSchemaVersion("another");
      await worker.proofLog.restart();

      const refuse = async (): Promise<Response[]> => {
        const answers = [await worker.fetch("/api/v1/challenges", { method: "POST" }), await cardState(worker, TEST_SCOPE)];
        for (const res of answers) {
          assert.equal(res.status, 500);
          assert.deepEqual(await jsonOf(res), { error: "internal" });
        }
        return answers;
      };
      const refused = await refuse();
      assert.deepEqual(
        failuresIn(worker).map((l) => [l.endpoint, l.where, l.id]),
        [
          ["/api/v1/challenges", "schema", refused[0]!.headers.get("X-Request-Id")],
          ["/api/v1/card-state", "schema", refused[1]!.headers.get("X-Request-Id")],
        ],
      );
      // What does not ask the object is as ever: config, which the Worker answers by itself, and the paths that are no endpoint.
      assert.equal((await worker.fetch("/api/v1/config")).status, 200);
      assert.equal((await worker.fetch("/api/v1/nothing")).status, 404);
      assert.equal((await worker.fetch("/api/v1/challenges")).status, 405);
      assert.equal((await worker.fetch("/nothing")).status, 404);
      // The alarm deletes nothing, however late it is: the challenge is still known once the version is the build's again (below).
      await worker.setClock(new Date(NOON.getTime() + 60 * 60_000));
      await worker.proofLog.runAlarm();
      // Starting again does not make the stored version the build's.
      await worker.proofLog.restart();
      await refuse();
      assert.deepEqual(failuresIn(worker).map((l) => l.where), ["schema", "schema", "schema", "schema"]);

      await worker.setClock(NOON);
      await worker.proofLog.setStoredSchemaVersion("the build's");
      await worker.proofLog.restart();
      assert.equal((await cardState(worker, TEST_SCOPE)).status, 200);
      const next = await issue(worker);
      assert.deepEqual(await worker.proofLog.knownChallenges(), [challenge, next].sort());
    } finally {
      await worker.close();
    }
  });

  test("a running test log whose setting is changed to production: nothing answers, the object keeps what it had, and it goes on once the setting is put back", async () => {
    const worker = await startWorker();
    try {
      await worker.setClock(NOON);
      const challenge = await issue(worker);
      assert.equal((await cardState(worker, TEST_SCOPE)).status, 200);

      // As a deploy with the wrong setting would: the setting changes and the object starts again.
      await worker.setSettings({ PROOF_LOG_KIND: "production" });
      await worker.proofLog.restart();
      for (const res of [await worker.fetch("/api/v1/challenges", { method: "POST" }), await cardState(worker, PRODUCTION_SCOPE), await cardState(worker, TEST_SCOPE), await worker.fetch("/api/v1/config")]) {
        assert.equal(res.status, 500);
        assert.deepEqual(await jsonOf(res), { error: "internal" });
      }
      assert.deepEqual(failuresIn(worker).map((l) => l.where), ["settings", "settings", "settings", "settings"]);

      // The object was stopped and nothing has started it since: with the setting put back it starts from what it stored.
      await worker.setSettings({});
      await assert.rejects(worker.proofLog.restart(), /not currently running/);
      assert.deepEqual(await worker.proofLog.knownChallenges(), [challenge]);
      assert.equal((await cardState(worker, TEST_SCOPE)).status, 200);
      const next = await issue(worker);
      assert.deepEqual(await worker.proofLog.knownChallenges(), [challenge, next].sort());
    } finally {
      await worker.close();
    }
  });
});
