// The site-wide limit and an overloaded proof log (ADR-0026; issue #32),
// against the whole Worker in the local workerd (test/harness.ts):
// - only `GET /api/v1/config?start`, the one a client asks for when a card
//   proof starts, is counted against the site-wide limit; over it, 503
//   `busy` with Retry-After, while a `config` without the mark answers as
//   ever, from the same network or any other; the next minute, starts
//   answer again;
// - the limit is kept by one Durable Object (src/starts.ts), not by a Rate
//   Limiting binding, whose count on Cloudflare is one to each machine;
// - asked of the Worker's own code with a made-up environment: an object
//   that fails, or a setting that is no number, lets the start through and
//   says so in one line;
// - a proof log's object that turns every call away as overloaded: every
//   API endpoint that asks it answers 503 `busy` with Retry-After, every page
//   that reads it answers the page of too many people
//   (design/copy/too-many-requests.md, "人太多的時候"), and what does not
//   ask it answers as ever.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { unstable_readConfig } from "wrangler";
import { WORKER_DIR } from "./build.ts";
import { block, copyLines, wantLines } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { TEST_SCOPE, freshProofLog, newCard } from "./records.ts";

/** A site-wide limit of a few starts, so that going over it takes a few requests. */
const STARTS = 3;

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
  const proofLog = await freshProofLog(worker);
  await worker.setSettings({ PROOF_LOG_KIND: "test", PROOF_LOG_OBJECT_NAME: proofLog, CARD_PROOF_STARTS_PER_MINUTE: String(STARTS) });
});
after(() => worker.close());

beforeEach(() => worker.overloadProofLog(false));

let networks = 0;
const newIpv4 = (): string => `203.0.113.${++networks}`;

/** The clock of the test, a minute at a time: each test that counts starts has minutes no other test had. */
let minutes = 0;
const nextMinute = (): Promise<void> => worker.setClock(new Date(Date.UTC(2026, 10, 27, 1, ++minutes, 30)));

async function ask(path: string, ip: string | null, init: RequestInit = {}): Promise<{ status: number; retryAfter: string | null; body: string; cacheControl: string | null }> {
  const res = await worker.fetch(path, { ...init, headers: { ...(ip !== null && { "CF-Connecting-IP": ip }) } });
  return { status: res.status, retryAfter: res.headers.get("Retry-After"), body: await res.text(), cacheControl: res.headers.get("Cache-Control") };
}

describe("the site-wide limit: card proofs that start in a minute", () => {
  test("config?start from many networks: the first ones answer, the next is 503 busy with Retry-After; config without the mark answers all the while", async () => {
    await nextMinute();
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

  test("the next minute, as many start again; the refused ones of the minute before took no place", async () => {
    await nextMinute();
    for (let i = 0; i < STARTS + 2; i++) await ask("/api/v1/config?start", newIpv4());
    assert.equal((await ask("/api/v1/config?start", newIpv4())).status, 503);
    await nextMinute();
    for (let i = 0; i < STARTS; i++) assert.equal((await ask("/api/v1/config?start", newIpv4())).status, 200, `start ${i + 1} of the next minute`);
    assert.equal((await ask("/api/v1/config?start", newIpv4())).status, 503);
  });

  test("a request with no address (in the local workerd: from this computer) is counted too", async () => {
    await nextMinute();
    for (let i = 0; i < STARTS; i++) assert.equal((await ask("/api/v1/config?start", null)).status, 200);
    assert.equal((await ask("/api/v1/config?start", null)).status, 503);
  });

  // The limit was a Rate Limiting binding with one key for the whole site, and on Cloudflare it did not
  // hold: the binding keeps a count on each machine, and requests that each open a connection come in on
  // many of them (README.md, "全站的總量上限"). The local workerd has one count, so no test here can show
  // that; this one keeps the limit where there is one count for the site.
  test("is kept by one Durable Object of its own, not by a Rate Limiting binding; its number is a setting", () => {
    const config = unstable_readConfig({ config: join(WORKER_DIR, "wrangler.jsonc"), env: "test" }, { hideWarnings: true });
    assert.deepEqual(
      config.durable_objects.bindings.filter((b: { name: string }) => b.name === "STARTS"),
      [{ name: "STARTS", class_name: "Starts" }],
    );
    assert.ok(!config.ratelimits.some((r: { name: string }) => /START/.test(r.name)), "no Rate Limiting binding counts starts");
    assert.match(String(config.vars.CARD_PROOF_STARTS_PER_MINUTE), /^[1-9][0-9]*$/);
    assert.ok(config.migrations.some((m: { new_sqlite_classes?: string[] }) => m.new_sqlite_classes?.includes("Starts")), "a migration makes the class");
  });
});

describe("the site-wide limit, by itself", () => {
  // The module is the Worker's; loaded by a path the type check of the tests does not follow (README.md, 型別檢查).
  const load = async (): Promise<{ withinStarts(env: unknown): Promise<boolean> }> => (await import(new URL("../src/rate-limit.ts", import.meta.url).href)) as never;

  /** An environment with `settings` whose starts' object answers `answer`, and the names and numbers it was asked with. */
  const withObject = (answer: () => Promise<boolean>, settings: { CARD_PROOF_STARTS_PER_MINUTE?: string } = { CARD_PROOF_STARTS_PER_MINUTE: "60" }) => {
    const asked: { name: string; perMinute: number }[] = [];
    let name = "";
    const env = {
      ...settings,
      STARTS: {
        idFromName: (n: string) => ((name = n), { name: n }),
        get: () => ({ start: (n: number) => (asked.push({ name, perMinute: n }), answer()) }),
      },
    };
    return { env, asked };
  };

  test("the object's answer is the answer; it is asked with the setting's number, and there is one of it", async () => {
    const { withinStarts } = await load();
    const yes = withObject(() => Promise.resolve(true));
    const no = withObject(() => Promise.resolve(false), { CARD_PROOF_STARTS_PER_MINUTE: "7" });
    assert.equal(await withinStarts(yes.env), true);
    assert.equal(await withinStarts(no.env), false);
    assert.deepEqual([...yes.asked, ...no.asked], [
      { name: "starts", perMinute: 60 },
      { name: "starts", perMinute: 7 },
    ]);
  });

  test("an object that fails or is not there, or a setting that is no number, lets the start through and says so in one line", async () => {
    const { withinStarts } = await load();
    const said: string[] = [];
    const error = console.error;
    console.error = (line: string) => void said.push(line);
    try {
      assert.equal(await withinStarts(withObject(() => Promise.reject(new Error("no"))).env), true);
      assert.equal(await withinStarts({ CARD_PROOF_STARTS_PER_MINUTE: "60" }), true);
      for (const set of [undefined, "", "-1", "1.5", "07", "sixty", "100001"]) {
        const { env, asked } = withObject(() => Promise.resolve(false), set === undefined ? {} : { CARD_PROOF_STARTS_PER_MINUTE: set });
        assert.equal(await withinStarts(env), true, String(set));
        assert.deepEqual(asked, [], `${set}: the object is not asked`);
      }
    } finally {
      console.error = error;
    }
    assert.deepEqual(
      said.map((l) => JSON.parse(l) as { event: string; class: string }).map((l) => [l.event, l.class]),
      new Array(9).fill(["rate_limit_unavailable", "starts"]),
    );
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
