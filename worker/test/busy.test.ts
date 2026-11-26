// The site-wide limit and an overloaded proof log (ADR-0026; issue #32),
// against the whole Worker in the local workerd (test/harness.ts):
// - only `GET /api/v1/config?start`, the one a client asks for when a card
//   proof starts, is counted against the site-wide limit; over it, 503
//   `busy` with Retry-After, while a `config` without the mark answers as
//   ever, from the same network or any other;
// - a proof log's object that turns every call away as overloaded: every
//   API endpoint that asks it answers 503 `busy` with Retry-After, every page
//   that reads it answers the page of too many people
//   (design/copy/too-many-requests.md, "人太多的時候"), and what does not
//   ask it answers as ever.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { block, copyLines, wantLines } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { TEST_SCOPE, freshProofLog, newCard } from "./records.ts";

/** A site-wide limit of a few starts, so that going over it takes a few requests. */
const STARTS = 3;

let worker: TestWorker;
before(async () => {
  worker = await startWorker({ rateLimits: { RATE_STARTS: STARTS } });
  await worker.setVerifier("stand-in");
  await freshProofLog(worker);
});
after(() => worker.close());

// The local workerd counts in fixed minutes of the clock (test/rate-limit.test.ts): each test starts with ten seconds of its minute left.
beforeEach(async () => {
  await worker.overloadProofLog(false);
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
});

let networks = 0;
const newIpv4 = (): string => `203.0.113.${++networks}`;

async function ask(path: string, ip: string | null, init: RequestInit = {}): Promise<{ status: number; retryAfter: string | null; body: string; cacheControl: string | null }> {
  const res = await worker.fetch(path, { ...init, headers: { ...(ip !== null && { "CF-Connecting-IP": ip }) } });
  return { status: res.status, retryAfter: res.headers.get("Retry-After"), body: await res.text(), cacheControl: res.headers.get("Cache-Control") };
}

describe("the site-wide limit: card proofs that start in a minute", () => {
  test("config?start from many networks: the first ones answer, the next is 503 busy with Retry-After; config without the mark answers all the while", async () => {
    // Waits for a fresh minute: the starts of this test are the minute's only ones.
    await new Promise((resolve) => setTimeout(resolve, 60_000 - (Date.now() % 60_000) + 50));
    for (let i = 0; i < STARTS; i++) {
      const got = await ask("/api/v1/config?start", newIpv4());
      assert.equal(got.status, 200, `start ${i + 1}`);
      assert.ok(JSON.parse(got.body).platforms.length > 0);
    }
    const over = await ask("/api/v1/config?start", newIpv4());
    assert.equal(over.status, 503, "one start more, from yet another network");
    assert.deepEqual(JSON.parse(over.body), { error: "busy" });
    assert.equal(over.retryAfter, "60");
    assert.equal(over.cacheControl, "no-store");
    // Without the mark: not counted, and not refused.
    for (const ip of [newIpv4(), newIpv4(), null]) assert.equal((await ask("/api/v1/config", ip)).status, 200);
    // Nor are the card proof's other requests.
    assert.equal((await ask("/api/v1/challenges", newIpv4(), { method: "POST" })).status, 200);
  });
});

describe("the proof log's object overloaded", () => {
  test("the API: every endpoint that asks the object answers 503 busy with Retry-After; config answers", async () => {
    await worker.overloadProofLog(true);
    for (const [path, init] of [
      ["/api/v1/challenges", { method: "POST" }],
      ["/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: newCard() }) }],
      ["/api/v1/fingerprint", {}],
      ["/api/v1/rebuild", {}],
    ] as const) {
      const got = await ask(path, newIpv4(), init);
      assert.equal(got.status, 503, path);
      assert.deepEqual(JSON.parse(got.body), { error: "busy" }, path);
      assert.equal(got.retryAfter, "60", path);
    }
    assert.equal((await ask("/api/v1/config", newIpv4())).status, 200, "config asks the object nothing");
  });

  test("the pages that read the object: the page of too many people, 503, Retry-After, not kept; the others as ever", async () => {
    await worker.overloadProofLog(true);
    const want = copyLines(block("too-many-requests.md", "人太多的時候"));
    for (const path of ["/", "/p/7K2Q9FM4XD", "/threads/@alice", "/proof-log"]) {
      const got = await ask(path, newIpv4());
      assert.equal(got.status, 503, path);
      assert.equal(got.retryAfter, "60", path);
      assert.equal(got.cacheControl, "no-store", path);
      wantLines(got.body, want);
      assert.ok(got.body.includes(`<title>${want[0]}｜島民證明</title>`), path);
    }
    for (const path of ["/faq", "/prepare", "/privacy"]) assert.equal((await ask(path, newIpv4())).status, 200, path);
    await worker.overloadProofLog(false);
    assert.equal((await ask("/", newIpv4())).status, 200, "the object back: the home page again");
  });
});
