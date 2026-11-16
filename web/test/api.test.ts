// The time limits of the requests to the server (src/api.ts): a server that
// holds its answer, or its answer's body, gets no further than the limit,
// and that counts as no answer (`network`), the same as a failed
// connection. The clock is node:test's mock of setTimeout.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { API_TIMEOUT_MS, FILE_TIMEOUT_MS, type Fetch, ServerError, getBytes, requestCardState, requestChallenge } from "../src/api.ts";
import { dayOf } from "../src/spec/date.ts";

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
    const w = watch(requestCardState(s.fetch, "iamreal-test:threads:0_________", "1".repeat(64), () => true, TODAY));
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
