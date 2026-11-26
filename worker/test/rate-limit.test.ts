// The per-IP limits (ADR-0026; issue #418): each class of request within
// its limit and over it, IPv4 by address and IPv6 by /64, the classes
// apart, the page a visitor gets, nothing in the connection log, and limits
// that are settings. Against the whole Worker in the local workerd
// (test/harness.ts), whose Rate Limiting bindings are workerd's own
// simulation. A Worker here is started with limits of a few requests, so
// that going over one takes a few requests; where a request comes from is
// the header Cloudflare would set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { block, copyLines, wantLines, wantPreview } from "./copy.ts";
import { type RateBinding, type TestWorker, startWorker, withRateLimits } from "./harness.ts";
import { TEST_SCOPE, freshProofLog, newCard, publishG3, sub } from "./records.ts";

const LIMITS: Readonly<Record<RateBinding, number>> = { RATE_CHALLENGES: 3, RATE_CARD_STATE: 4, RATE_RECORDS: 2, RATE_PUBLIC_READS: 5, RATE_PAGES: 6, RATE_STARTS: 1000 };

let worker: TestWorker;
before(async () => {
  worker = await startWorker({ rateLimits: LIMITS });
  await worker.setVerifier("stand-in");
  await freshProofLog(worker);
});
after(() => worker.close());

// The local workerd counts in fixed minutes of the clock: a test that fills a class and then expects 429 must
// not have the minute change in between. No test here takes seconds, so each starts with ten of them left.
beforeEach(async () => {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 50));
});

/** A network no other test used: its counts start at zero. */
let networks = 0;
const newIpv4 = (): string => `198.51.${100 + Math.floor(++networks / 250)}.${(networks % 250) + 1}`;

interface Got {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly body: string;
  readonly contentType: string | null;
  readonly cacheControl: string | null;
}
async function ask(path: string, ip: string | null, init: RequestInit = {}): Promise<Got> {
  const res = await worker.fetch(path, { ...init, headers: { ...(ip !== null && { "CF-Connecting-IP": ip }) } });
  return { status: res.status, retryAfter: res.headers.get("Retry-After"), body: await res.text(), contentType: res.headers.get("Content-Type"), cacheControl: res.headers.get("Cache-Control") };
}

/** One request of each class, as `ip`. */
const REQUESTS: Readonly<Record<string, { binding: RateBinding; send: (ip: string | null) => Promise<Got>; ok: number }>> = {
  challenges: { binding: "RATE_CHALLENGES", send: (ip) => ask("/api/v1/challenges", ip, { method: "POST" }), ok: 200 },
  "card-state": { binding: "RATE_CARD_STATE", send: (ip) => ask("/api/v1/card-state", ip, { method: "POST", body: JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: newCard() }) }), ok: 200 },
  // Not a submission: it is counted all the same, before it is read.
  records: { binding: "RATE_RECORDS", send: (ip) => ask("/api/v1/records", ip, { method: "POST", body: "{" }), ok: 400 },
  config: { binding: "RATE_PUBLIC_READS", send: (ip) => ask("/api/v1/config", ip), ok: 200 },
  fingerprint: { binding: "RATE_PUBLIC_READS", send: (ip) => ask("/api/v1/fingerprint", ip), ok: 200 },
  rebuild: { binding: "RATE_PUBLIC_READS", send: (ip) => ask("/api/v1/rebuild", ip), ok: 200 },
  "the home page": { binding: "RATE_PAGES", send: (ip) => ask("/", ip), ok: 200 },
  "a page that asks the proof log nothing": { binding: "RATE_PAGES", send: (ip) => ask("/faq", ip), ok: 200 },
  "an address that is no page": { binding: "RATE_PAGES", send: (ip) => ask("/nothing-here", ip), ok: 404 },
};

const REFUSED_API = { status: 429, retryAfter: "60", body: '{"error":"rate_limited"}', contentType: "application/json", cacheControl: "no-store" };

describe("each class: answered as ever within its limit, 429 and Retry-After over it", () => {
  for (const [name, r] of Object.entries(REQUESTS)) {
    test(name, async () => {
      const ip = newIpv4();
      const limit = LIMITS[r.binding];
      for (let i = 0; i < limit; i++) {
        const got = await r.send(ip);
        assert.equal(got.status, r.ok, `request ${i + 1} of ${limit}: ${got.body.slice(0, 80)}`);
        assert.equal(got.retryAfter, null);
      }
      for (let i = 0; i < 3; i++) {
        const got = await r.send(ip);
        if (r.binding === "RATE_PAGES") assert.deepEqual([got.status, got.retryAfter, got.contentType, got.cacheControl], [429, "60", "text/html; charset=utf-8", "no-store"]);
        else assert.deepEqual(got, REFUSED_API);
      }
      // Another network is answered meanwhile.
      assert.equal((await r.send(newIpv4())).status, r.ok);
    });
  }

  test("the public reads are one class: config, fingerprint and rebuild count together", async () => {
    const ip = newIpv4();
    const reads = [REQUESTS.config!, REQUESTS.fingerprint!, REQUESTS.rebuild!];
    for (let i = 0; i < LIMITS.RATE_PUBLIC_READS; i++) assert.equal((await reads[i % 3]!.send(ip)).status, 200);
    for (const r of reads) assert.equal((await r.send(ip)).status, 429);
  });
});

describe("what a request is counted as", () => {
  test("IPv4 addresses are counted apart, however close", async () => {
    const a = newIpv4();
    for (let i = 0; i < LIMITS.RATE_CHALLENGES; i++) assert.equal((await REQUESTS.challenges!.send(a)).status, 200);
    assert.equal((await REQUESTS.challenges!.send(a)).status, 429);
    // The next address of the same /24 (never one this file's generator gives: its last number is at most 250).
    const [x, y, z, last] = a.split(".");
    const neighbour = `${x}.${y}.${z}.${Number(last) === 250 ? 252 : 251}`;
    for (let i = 0; i < LIMITS.RATE_CHALLENGES; i++) assert.equal((await REQUESTS.challenges!.send(neighbour)).status, 200, neighbour);
    assert.equal((await REQUESTS.challenges!.send(neighbour)).status, 429);
  });

  test("IPv6 addresses of one /64 are counted together, in whatever way they are written; another /64 apart", async () => {
    const n = (++networks).toString(16);
    const same = [`2001:db8:${n}:1::1`, `2001:db8:${n}:1:ffff:ffff:ffff:ffff`, `2001:0DB8:${n}:0001:0:0:0:2`, `2001:db8:${n}:1:a:b:192.0.2.1`];
    for (let i = 0; i < LIMITS.RATE_CHALLENGES; i++) assert.equal((await REQUESTS.challenges!.send(same[i % same.length]!)).status, 200, same[i % same.length]);
    for (const ip of same) assert.equal((await REQUESTS.challenges!.send(ip)).status, 429, ip);
    assert.equal((await REQUESTS.challenges!.send(`2001:db8:${n}:2::1`)).status, 200);
  });

  test("an IPv4 address written as IPv6 is that IPv4 address", async () => {
    const ip = newIpv4();
    for (let i = 0; i < LIMITS.RATE_CHALLENGES; i++) assert.equal((await REQUESTS.challenges!.send(i % 2 === 0 ? ip : `::ffff:${ip}`)).status, 200);
    assert.equal((await REQUESTS.challenges!.send(`::ffff:${ip}`)).status, 429);
    assert.equal((await REQUESTS.challenges!.send(ip)).status, 429);
  });

  test("a request with no address (in the local workerd: from this computer), from a loopback address, or with a text that is no address, is not counted", async () => {
    for (const ip of [null, "127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "not an address", "1.2.3", "2001:db8:::1", "1.2.3.4.5", ""]) {
      for (let i = 0; i < LIMITS.RATE_CHALLENGES + 2; i++) assert.equal((await REQUESTS.challenges!.send(ip)).status, 200, String(ip));
    }
  });
});

describe("the classes are apart", () => {
  test("a network over the limit of one class is answered in every other", async () => {
    for (const [stopped, s] of Object.entries(REQUESTS)) {
      const ip = newIpv4();
      for (let i = 0; i < LIMITS[s.binding]; i++) await s.send(ip);
      assert.equal((await s.send(ip)).status, 429, stopped);
      for (const [other, o] of Object.entries(REQUESTS)) {
        if (o.binding !== s.binding) assert.equal((await o.send(ip)).status, o.ok, `${other}, while ${stopped} is stopped`);
      }
    }
  });
});

describe("what is not counted", () => {
  test("a method the endpoint or the page does not take, and an address under /api/ that is no endpoint", async () => {
    const ip = newIpv4();
    for (let i = 0; i < 12; i++) {
      assert.equal((await ask("/api/v1/challenges", ip)).status, 405);
      assert.equal((await ask("/api/v1/nothing", ip)).status, 404);
      assert.equal((await ask("/", ip, { method: "POST" })).status, 405);
    }
    assert.equal((await REQUESTS.challenges!.send(ip)).status, 200);
    assert.equal((await REQUESTS["the home page"]!.send(ip)).status, 200);
  });
});

describe("the page a visitor gets", () => {
  test("is design/copy/too-many-requests.md, word for word, and says nothing of who was counted", async () => {
    const ip = newIpv4();
    for (let i = 0; i < LIMITS.RATE_PAGES; i++) await ask("/faq", ip);
    const got = await ask("/p/7K2Q9FM4XD", ip);
    assert.equal(got.status, 429);

    // The lines of the copy file, as the other pages' tests read theirs (test/copy.ts).
    const lines = copyLines(block("too-many-requests.md", "頁面"));
    assert.deepEqual(lines, ["請稍後再試", "這個網路送出的請求太多，請過一分鐘再試。"]);
    wantLines(got.body, lines);
    // The section holds those two lines and nothing else.
    const main = /<section class="missing">([\s\S]*?)<\/section>/.exec(got.body)?.[1] ?? "";
    assert.deepEqual([...main.matchAll(/>([^<>\n]+)</g)].map((m) => m[1]), lines);
    // The tab's title, whole; no link preview.
    wantPreview(got.body, lines[0]!, null);
    // Not the address, not the short ID it was asked for.
    assert.ok(!got.body.includes(ip) && !got.body.includes("7K2Q9FM4XD"), "the page says who or what");
    // HEAD is counted too, and gets the headers without the page.
    const head = await ask("/faq", ip, { method: "HEAD" });
    assert.deepEqual([head.status, head.retryAfter, head.body], [429, "60", ""]);
  });
});

describe("a request that is turned away leaves nothing", () => {
  test("a submission over the limit: not counted towards its challenge, no record, no entry in the connection log, no line in the live log", async () => {
    const root = await publishG3(worker);
    await worker.emptyConnectionLog();
    const ip = newIpv4();
    const submission = JSON.stringify(await sub(worker, newCard(), root, "threads:alice"));
    const send = async (): Promise<Got> => ask("/api/v1/records", ip, { method: "POST", body: submission });
    for (let i = 0; i < LIMITS.RATE_RECORDS; i++) assert.equal((await ask("/api/v1/records", ip, { method: "POST", body: "{" })).status, 400);
    const lines = worker.logLines().length;
    for (let i = 0; i < 8; i++) assert.deepEqual(await send(), REFUSED_API);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(await worker.connectionLog(), []);
    assert.deepEqual(worker.logLines().slice(lines), []);
    // The challenge was not counted eight times: from another network the same submission is still taken.
    const res = await worker.fetch("/api/v1/records", { method: "POST", body: submission, headers: { "CF-Connecting-IP": newIpv4() } });
    assert.equal(res.status, 201, await res.text());
  });
});

describe("the limits are settings", () => {
  test("the Worker above runs with the numbers it was started with, not wrangler.jsonc's; the repository's file has the five, each once", () => {
    const config = readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8");
    const limitOf = (text: string, name: string): number => Number(new RegExp(`"name": "${name}", "namespace_id": "[0-9]+", "simple": \\{ "limit": ([0-9]+), "period": 60 \\}`).exec(text)?.[1]);
    const changed = withRateLimits(config, LIMITS);
    for (const [name, limit] of Object.entries(LIMITS)) {
      assert.ok(limitOf(config, name) > limit, `${name}: the repository's limit is above the test's`);
      assert.equal(limitOf(changed, name), limit);
    }
    // Nothing else of the file changes, and a binding that is not there is an error, not a silent no.
    assert.equal(changed.replace(/"limit": [0-9]+/g, ""), config.replace(/"limit": [0-9]+/g, ""));
    assert.throws(() => withRateLimits(config.replace("RATE_PAGES", "RATE_OTHER"), { RATE_PAGES: 1 }));
    // Each counter is its own: no two bindings share a namespace.
    const namespaces = [...config.matchAll(/"namespace_id": "([0-9]+)"/g)].map((m) => m[1]);
    assert.deepEqual([namespaces.length, new Set(namespaces).size], [5, 5]);
  });

  test("another Worker, started with another number for one class, stops that class at that number", async () => {
    const other = await startWorker({ rateLimits: { RATE_PUBLIC_READS: 2 } });
    try {
      const ip = "203.0.113.200";
      assert.deepEqual([(await other.fetch("/api/v1/config", { headers: { "CF-Connecting-IP": ip } })).status, (await other.fetch("/api/v1/config", { headers: { "CF-Connecting-IP": ip } })).status], [200, 200]);
      assert.equal((await other.fetch("/api/v1/config", { headers: { "CF-Connecting-IP": ip } })).status, 429);
    } finally {
      await other.close();
    }
  });
});

describe("the key, by itself", () => {
  // The module is the Worker's; loaded by a path the type check of the tests does not follow (README.md, 型別檢查).
  const load = async (): Promise<{
    networkOf(ip: string): string | null;
    rateKey(kind: string, ip: string | null): string | null;
    withinLimit(env: unknown, kind: string, request: Request): Promise<boolean>;
  }> => (await import(new URL("../src/rate-limit.ts", import.meta.url).href)) as never;

  test("an IPv4 address is itself; an IPv6 address is its first four groups, however it is written; what is no address is nothing", async () => {
    const { networkOf } = await load();
    const cases: [string, string | null][] = [
      ["192.0.2.1", "192.0.2.1"],
      ["0.0.0.0", "0.0.0.0"],
      ["255.255.255.255", "255.255.255.255"],
      ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
      ["2001:0DB8:0001:0002:0000:0000:0000:0001", "2001:db8:1:2::/64"],
      ["2001:db8:1:2::", "2001:db8:1:2::/64"],
      ["2001:db8::1", "2001:db8:0:0::/64"],
      ["2001:db8:0:0:8000::", "2001:db8:0:0::/64"],
      ["1::", "1:0:0:0::/64"],
      ["::", "0:0:0:0::/64"],
      ["::1", "0:0:0:0::/64"],
      ["1:2:3:4:5:6:7::", "1:2:3:4::/64"],
      ["::2:3:4:5:6:7:8", "0:2:3:4::/64"],
      ["1:2:3:4:5:6:192.0.2.1", "1:2:3:4::/64"],
      ["::ffff:192.0.2.1", "192.0.2.1"],
      ["::FFFF:c000:201", "192.0.2.1"],
      // Not addresses.
      ["", null],
      ["1.2.3", null],
      ["1.2.3.4.5", null],
      ["256.1.1.1", null],
      ["01.2.3.4", null],
      ["1.2.3.4 ", null],
      [":::", null],
      ["1:2:3:4:5:6:7", null],
      ["1:2:3:4:5:6:7:8:9", null],
      ["1:2:3:4:5:6:7:8::", null],
      ["::1:2:3:4:5:6:7:8", null],
      ["1::2::3", null],
      ["12345::", null],
      ["g::", null],
      ["fe80::1%eth0", null],
      ["1:2:3:4:5:6:7:1.2.3.4", null],
      ["1.2.3.4::", null],
      ["2001:db8::1/64", null],
    ];
    for (const [ip, want] of cases) assert.equal(networkOf(ip), want, JSON.stringify(ip));
  });

  test("the key is the class and the network; a request with no address, or from this computer, has none", async () => {
    const { rateKey } = await load();
    assert.equal(rateKey("records", "192.0.2.1"), "records:192.0.2.1");
    assert.equal(rateKey("pages", "2001:db8:1:2:3:4:5:6"), "pages:2001:db8:1:2::/64");
    assert.notEqual(rateKey("records", "192.0.2.1"), rateKey("challenges", "192.0.2.1"));
    for (const ip of [null, "", "nonsense", "127.0.0.1", "127.255.255.254", "::1", "::", "::ffff:127.0.0.1"]) assert.equal(rateKey("pages", ip), null, String(ip));
    // Not loopback, though it begins alike.
    assert.equal(rateKey("pages", "12.7.0.1"), "pages:12.7.0.1");
    assert.equal(rateKey("pages", "0:0:0:1::1"), "pages:0:0:0:1::/64");
  });

  test("a binding that fails, or is not there, lets the request through and says so in one line with nothing of the request", async () => {
    const { withinLimit } = await load();
    const request = new Request("https://example.test/p/7K2Q9FM4XD", { headers: { "CF-Connecting-IP": "192.0.2.77" } });
    const said: string[] = [];
    const error = console.error;
    console.error = (line: string) => void said.push(line);
    try {
      assert.equal(await withinLimit({ RATE_PAGES: { limit: () => Promise.reject(new Error("no")) } }, "pages", request), true);
      assert.equal(await withinLimit({}, "records", request), true);
      // A binding that answers is asked with the key, and its answer is the answer.
      const keys: string[] = [];
      const binding = { limit: ({ key }: { key: string }) => (keys.push(key), Promise.resolve({ success: false })) };
      assert.equal(await withinLimit({ RATE_PAGES: binding }, "pages", request), false);
      assert.deepEqual(keys, ["pages:192.0.2.77"]);
    } finally {
      console.error = error;
    }
    assert.deepEqual(said.map((l) => JSON.parse(l) as unknown), [
      { event: "rate_limit_unavailable", class: "pages", error: "Error" },
      { event: "rate_limit_unavailable", class: "records", error: "TypeError" },
    ]);
    for (const line of said) assert.ok(!line.includes("192.0.2.77") && !line.includes("7K2Q9FM4XD"), line);
  });
});
