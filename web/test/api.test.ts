// The time limits of the requests to the server (src/api.ts): a server that
// holds its answer, or its answer's body, gets no further than the limit,
// and that counts as no answer (`network`), the same as a failed
// connection. The clock is node:test's mock of setTimeout.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { API_TIMEOUT_MS, FILE_TIMEOUT_MS, type Fetch, ServerError, dataOriginFetch, getBytes, requestCardState, requestChallenge, requestConfig } from "../src/api.ts";
import { dayOf } from "iamreal-protocol/date.ts";

const TODAY = dayOf(2026, 11, 16);

/** A server that never answers; the request ends only when its signal aborts. Records the signals. */
function silent(): { fetch: Fetch; signals: AbortSignal[] } {
  const signals: AbortSignal[] = [];
  const fetch: Fetch = (_path, init) =>
    new Promise((_, reject) => {
      if (init?.signal) {
        signals.push(init.signal);
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }
    });
  return { fetch, signals };
}

/** A server that sends its headers, then holds the body until the request is aborted. */
const stalledBody: Fetch = async (_path, init) => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"challenge":'));
      init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
};

/** Settles `p` into a value the test can look at without awaiting it. */
function watch<T>(p: Promise<T>): { state: () => "pending" | "resolved" | "rejected"; error: () => unknown } {
  let state: "pending" | "resolved" | "rejected" = "pending";
  let error: unknown;
  p.then(
    () => (state = "resolved"),
    (e) => {
      state = "rejected";
      error = e;
    },
  );
  return { state: () => state, error: () => error };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

const isNetwork = (e: unknown) => e instanceof ServerError && e.code === "network" && e.status === 0;

describe("time limits of the requests (src/api.ts)", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("card-state not answered: no answer after API_TIMEOUT_MS, and the request is aborted", async () => {
    const s = silent();
    const w = watch(requestCardState(s.fetch, "iamreal-test:public:0__________", "1".repeat(64), [], TODAY));
    await flush();
    mock.timers.tick(API_TIMEOUT_MS - 1);
    await flush();
    assert.equal(w.state(), "pending", "still waiting just under the limit");
    mock.timers.tick(1);
    await flush();
    assert.equal(w.state(), "rejected");
    assert.ok(isNetwork(w.error()), String(w.error()));
    assert.equal(s.signals.length, 1);
    assert.equal(s.signals[0]!.aborted, true, "the request itself is aborted");
  });

  test("a fetch that ignores the signal is not waited for either", async () => {
    const never: Fetch = () => new Promise(() => undefined);
    const w = watch(requestChallenge(never));
    await flush();
    mock.timers.tick(API_TIMEOUT_MS);
    await flush();
    assert.ok(isNetwork(w.error()), String(w.error()));
  });

  test("the headers come, the body does not: no answer, not a malformed one", async () => {
    const w = watch(requestChallenge(stalledBody));
    await flush();
    mock.timers.tick(API_TIMEOUT_MS);
    await flush();
    await flush();
    assert.equal(w.state(), "rejected");
    assert.ok(isNetwork(w.error()), String(w.error()));
  });

  test("a static file (CRL, circuit, CRS) has the longer FILE_TIMEOUT_MS", async () => {
    assert.ok(FILE_TIMEOUT_MS > API_TIMEOUT_MS);
    const s = silent();
    const w = watch(getBytes(s.fetch, "/crl/index.jsonl"));
    await flush();
    mock.timers.tick(API_TIMEOUT_MS);
    await flush();
    assert.equal(w.state(), "pending", "a large file is still coming after API_TIMEOUT_MS");
    mock.timers.tick(FILE_TIMEOUT_MS - API_TIMEOUT_MS);
    await flush();
    assert.ok(isNetwork(w.error()), String(w.error()));
    assert.equal(s.signals[0]!.aborted, true);
  });

  test("an answer in time is read as before", async () => {
    const ok: Fetch = async () => new Response(JSON.stringify({ challenge: "x" }), { status: 200 });
    assert.equal(await requestChallenge(ok), "x");
  });
});

describe("the platform table of config (src/api.ts)", () => {
  const answer =
    (body: unknown): Fetch =>
    async () =>
      new Response(JSON.stringify(body), { status: 200 });
  const row = (platform: unknown, username_format: unknown, display_name: unknown = "Name") => ({ platform, display_name, username_format });

  test("paused: true or false as sent; absent (an older server), false", async () => {
    for (const [paused, want] of [[true, true], [false, false], [undefined, false]] as const) {
      const c = await requestConfig(answer({ ...(paused === undefined ? {} : { paused }), crl_max_age_days: 3, platforms: [row("threads", "[a]{1,1}")] }));
      assert.equal(c.paused, want, String(paused));
    }
  });

  test("the rows read, in order; a row it cannot read is a platform it does not know; fields it does not know ignored", async () => {
    const c = await requestConfig(
      answer({
        crl_max_age_days: 3,
        extra: true,
        platforms: [
          row("aaa", "(a|b)+"),
          row("test-example", "[a-z0-9-]{1,20}", "Example (no real service)"),
          { ...row("threads", "[a-z0-9._]{1,30}", "Threads"), more: 1 },
          row("u-new", "[a-z]{1,5}", "Tab\tname"),
          "x",
          row(5, "[a]{1,1}"),
        ],
      }),
    );
    assert.equal(c.crlMaxAgeDays, 3);
    assert.deepEqual(
      c.platforms.map((r) => [r.platform, r.displayName, r.format.text]),
      [
        ["test-example", "Example (no real service)", "[a-z0-9-]{1,20}"],
        ["threads", "Threads", "[a-z0-9._]{1,30}"],
      ],
    );
    assert.equal(c.platforms[1]!.format.accepts("alice.b"), true);
    assert.equal(c.platforms[1]!.format.accepts("a-b"), false);
  });

  for (const [label, body] of [
    ["no table", { crl_max_age_days: 3 }],
    ["not a list", { crl_max_age_days: 3, platforms: { threads: row("threads", "[a]{1,1}") } }],
    ["no row", { crl_max_age_days: 3, platforms: [] }],
    ["no row it can read", { crl_max_age_days: 3, platforms: [row("threads", "[a-z]*")] }],
    ["out of order", { crl_max_age_days: 3, platforms: [row("threads", "[a]{1,1}"), row("test-example", "[a]{1,1}")] }],
    ["twice", { crl_max_age_days: 3, platforms: [row("threads", "[a]{1,1}"), row("threads", "[a]{1,1}")] }],
    ["twice, once unreadable", { crl_max_age_days: 3, platforms: [row("threads", "[a]{1,1}"), row("threads", "a")] }],
    ["no CRL age", { platforms: [row("threads", "[a]{1,1}")] }],
    ["a negative CRL age", { crl_max_age_days: -1, platforms: [row("threads", "[a]{1,1}")] }],
    ["paused that is not true or false", { paused: "yes", crl_max_age_days: 3, platforms: [row("threads", "[a]{1,1}")] }],
  ] as const) {
    test(`not read: ${label}`, async () => {
      await assert.rejects(requestConfig(answer(body)), (e) => e instanceof ServerError && e.code === "malformed_response");
    });
  }
});

describe("the data domain's fetch (src/api.ts)", () => {
  /** The calls a fetch got: the URL and the options. */
  function recording(): { fetchFn: typeof fetch; calls: [string, RequestInit][] } {
    const calls: [string, RequestInit][] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response("x");
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  test("asks the data domain for the path, with no credentials, no cache, no redirect, no referrer", async () => {
    const r = recording();
    await dataOriginFetch("https://data.iamreal.tw", r.fetchFn)("/crl/index.jsonl");
    assert.equal(r.calls.length, 1);
    const [url, init] = r.calls[0]!;
    assert.equal(url, "https://data.iamreal.tw/crl/index.jsonl");
    assert.equal(init.method, "GET");
    assert.equal(init.mode, "cors");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.body, undefined);
    assert.equal(init.headers, undefined);
  });

  test("an empty origin is the page's own", async () => {
    const r = recording();
    await dataOriginFetch("", r.fetchFn)("/crl/index.jsonl");
    assert.equal(r.calls[0]![0], "/crl/index.jsonl");
  });

  test("only a path, and only GET", () => {
    const f = dataOriginFetch("https://data.iamreal.tw", recording().fetchFn);
    for (const p of ["crl/index.jsonl", "//elsewhere.example/crl/index.jsonl", "https://elsewhere.example/"]) {
      assert.throws(() => f(p), `path ${p}`);
    }
    assert.throws(() => f("/crl/index.jsonl", { method: "POST", body: "{}" }));
  });
});
