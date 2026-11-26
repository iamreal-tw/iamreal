// The counts the card proof page sends (src/counts.ts; spec/counts.md):
// the code for each way a card proof stops, the two names worked out from
// a `User-Agent`, and the card proof device ID's 31 days. The table is the
// one of spec/vectors/counts.json, the file the back end's tests read; the
// counts a card proof sends step by step are in test/flow.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEVICE_ID_DAYS, DEVICE_ID_KEY, cardProofCounts, deviceIdOn, familiesOf, reasonOf } from "../src/counts.ts";
import type { Stop } from "../src/flow.ts";
import { readCount } from "iamreal-protocol/counts.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import { vectors } from "./vectors.ts";

const TABLE = vectors("counts.json").table as { steps: Record<string, string[]>; reasons: Record<string, string[]>; card_proof_actions: Record<string, string[]>; browsers: string[]; oses: string[] };

describe("the reason code of a stop", () => {
  /** Every way the flow stops (src/flow.ts, `Stop`), with what a real one holds besides its codes. */
  const STOPS: [Stop, string][] = [
    [{ code: "card", card: "component_unreachable" }, "component_unreachable"],
    [{ code: "card", card: "no_reader" }, "no_reader"],
    [{ code: "card", card: "no_card" }, "no_card"],
    [{ code: "card", card: "pin_incorrect" }, "pin_incorrect"],
    [{ code: "card", card: "card_locked" }, "card_locked"],
    [{ code: "card", card: "card_error", detail: "0x76100006_A5" }, "card_error"],
    [{ code: "card", card: "popup_blocked" }, "popup_blocked"],
    [{ code: "certificate", problem: "no_certificate" }, "no_certificate"],
    [{ code: "certificate", problem: "expired", notAfter: "2026-03-01" }, "cert_expired"],
    [{ code: "certificate", problem: "not_yet_valid", notBefore: "2027-01-01" }, "cert_not_yet_valid"],
    [{ code: "certificate", problem: "not_citizen_primary" }, "cert_not_citizen_primary"],
    [{ code: "certificate", problem: "unsupported_format" }, "cert_unsupported_format"],
    [{ code: "certificate", problem: "unknown_issuer" }, "cert_unknown_issuer"],
    [{ code: "certificate", problem: "ambiguous_certificate" }, "cert_ambiguous"],
    [{ code: "revocation", problem: { code: "crl_unavailable", detail: "GET /crl/index.jsonl: 503" } }, "crl_unavailable"],
    [{ code: "revocation", problem: { code: "crl_hash" } }, "crl_hash"],
    [{ code: "revocation", problem: { code: "crl_unusable", reason: "signature" } }, "crl_unusable"],
    [{ code: "revocation", problem: { code: "crl_rollback", crlNumber: 99n, highest: 100n } }, "crl_rollback"],
    [{ code: "revocation", problem: { code: "crl_stale", days: 4, maxDays: 3 } }, "crl_stale"],
    [{ code: "revoked" }, "revoked"],
    [{ code: "card_signature" }, "card_signature"],
    [{ code: "challenge_malformed" }, "challenge_malformed"],
    [{ code: "challenge_not_today", challengeDate: "2026-11-15", today: "2026-11-16" }, "challenge_not_today"],
    [{ code: "blocked", reason: "switch_limit", platform: "threads" }, "blocked_switch_limit"],
    [{ code: "blocked", reason: "empty" }, "blocked_empty"],
    [{ code: "blocked", reason: "daily_limit" }, "blocked_daily_limit"],
    [{ code: "idle" }, "idle"],
    [{ code: "artifact", path: "/circuits/card_proof_rs4096.json" }, "artifact"],
    [{ code: "engine", detail: "RuntimeError: unreachable at wasm://wasm/0123abcd" }, "engine"],
    [{ code: "proof_check" }, "proof_check"],
    [{ code: "username", platform: "threads" }, "username"],
    [{ code: "date_changed" }, "date_changed"],
    [{ code: "state" }, "state"],
    [{ code: "server", server: "network", status: 0 }, "server_network"],
    [{ code: "server", server: "malformed_response", status: 200, requestId: "0123456789abcdef" }, "server_malformed_response"],
    [{ code: "server", server: "paused", status: 503 }, "server_paused"],
    [{ code: "server", server: "rate_limited", status: 429 }, "server_rate_limited"],
    [{ code: "server", server: "busy", status: 503 }, "server_busy"],
    [{ code: "server", server: "internal", status: 500, requestId: "fedcba9876543210" }, "server_internal"],
    [{ code: "server", server: "crl_stale", status: 503 }, "server_crl_stale"],
    [{ code: "server", server: "challenge_attempts", status: 400 }, "server_challenge_attempts"],
    [{ code: "server", server: "proof", status: 400 }, "server_proof"],
    [{ code: "server", server: "switch_restricted", status: 403 }, "server_switch_restricted"],
    // A code the table has no reason for, an HTTP status without a code, and a code that is no code at all.
    [{ code: "server", server: "slow_down", status: 503 }, "server_other"],
    [{ code: "server", server: "http_502", status: 502 }, "server_other"],
    [{ code: "server", server: "other", status: 400 }, "server_other"],
    [{ code: "server", server: "constructor", status: 400 }, "server_other"],
  ];

  for (const [stop, reason] of STOPS) {
    test(`${JSON.stringify(stop, (_, v) => (typeof v === "bigint" ? String(v) : (v as unknown)))} is ${reason}`, () => {
      assert.equal(reasonOf(stop), reason);
      // A reason the table has for the web page.
      assert.ok(TABLE.reasons[reason]?.includes("web"), `${reason} is not the web page's in spec/vectors/counts.json`);
    });
  }

  test("every reason the server can answer with is asked here: the table's `server_` reasons, each from its code", () => {
    for (const reason of Object.keys(TABLE.reasons).filter((r) => r.startsWith("server_") && r !== "server_other")) {
      assert.equal(reasonOf({ code: "server", server: reason.slice("server_".length), status: 400 }), reason);
    }
  });
});

describe("a count as it is sent", () => {
  /** The counts with a fetch that records, a storage in memory and a clock the test moves. */
  function page(userAgent: string): { sent: Record<string, unknown>[]; counts: ReturnType<typeof cardProofCounts>; storage: Map<string, string>; requests: { path: string; method: string | undefined }[] } {
    const sent: Record<string, unknown>[] = [];
    const requests: { path: string; method: string | undefined }[] = [];
    const storage = new Map<string, string>();
    const counts = cardProofCounts({
      fetch: async (path, init) => {
        requests.push({ path, method: init?.method });
        sent.push(JSON.parse(init!.body!) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      },
      storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
      clock: () => Date.UTC(2026, 10, 16, 4),
      random: (bytes) => crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>),
      userAgent,
    });
    return { sent, counts, storage, requests };
  }
  const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  test("every step, reason and action the table has for the web page is sent as a count the table takes, to POST /api/v1/counts; the User-Agent is in none", async () => {
    const userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
    const p = page(userAgent);
    const forWeb = (codes: Record<string, string[]>): string[] => Object.keys(codes).filter((c) => codes[c]!.includes("web"));
    for (const step of forWeb(TABLE.steps)) p.counts.step(step as never);
    for (const reason of forWeb(TABLE.reasons)) p.counts.retry(reason as never);
    for (const action of forWeb(TABLE.card_proof_actions)) p.counts.action(action as never);
    p.counts.stop("idle");
    await settled();
    assert.equal(p.sent.length, forWeb(TABLE.steps).length + forWeb(TABLE.reasons).length + forWeb(TABLE.card_proof_actions).length + 1);
    assert.ok(p.requests.every((r) => r.path === "/api/v1/counts" && r.method === "POST"));
    for (const c of p.sent) {
      assert.deepEqual(readCount(c), c);
      assert.deepEqual([c.client, c.browser, c.os], ["web", "safari", "macos"]);
    }
    for (const part of ["Mozilla", "605.1.15", "18.1", "10_15_7"]) assert.ok(!JSON.stringify(p.sent).includes(part), part);
  });

  test("a storage that refuses to be read or written: the counts go on with an ID that lasts as long as the page", async () => {
    const sent: Record<string, unknown>[] = [];
    const counts = cardProofCounts({
      fetch: async (_path, init) => {
        sent.push(JSON.parse(init!.body!) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      },
      storage: {
        getItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
        setItem: () => {
          throw new DOMException("denied", "SecurityError");
        },
      },
      clock: () => Date.UTC(2026, 10, 16, 4),
      random: (bytes) => crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>),
      userAgent: "",
    });
    counts.step("open");
    counts.step("read");
    await settled();
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.device_id, sent[1]!.device_id);
    assert.equal(counts.deviceId(), sent[0]!.device_id);
    assert.deepEqual([sent[0]!.browser, sent[0]!.os], ["other", "other"]);
    assert.deepEqual(readCount(sent[0]), sent[0]);
  });

  test("a fetch that throws at once, and a random source that fails: nothing is thrown at the caller", async () => {
    const throwing = cardProofCounts({
      fetch: () => {
        throw new Error("not a same-origin path");
      },
      storage: { getItem: () => null, setItem: () => undefined },
      clock: () => 0,
      random: (bytes) => crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>),
      userAgent: "",
    });
    throwing.step("open");
    throwing.stop("idle");
    const noRandom = cardProofCounts({
      fetch: async () => assert.fail("a count without its IDs was sent"),
      storage: { getItem: () => null, setItem: () => undefined },
      clock: () => 0,
      random: () => {
        throw new Error("no random source");
      },
      userAgent: "",
    });
    noRandom.step("open");
    // And the submission goes without a device ID rather than not at all.
    assert.equal(noRandom.deviceId(), null);
    await settled();
  });
});

describe("the card proof device ID's 31 days", () => {
  const day = (text: string): number => parseDay(text)!;
  const fixed = (byte: number) => (bytes: Uint8Array): Uint8Array => bytes.fill(byte);
  const stored = (value: string | null) => {
    const storage = new Map<string, string>(value === null ? [] : [[DEVICE_ID_KEY, value]]);
    return { storage, api: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } };
  };
  const OLD = "aa".repeat(16);
  const NEW = "bb".repeat(16);
  const never = (): string => assert.fail("the storage works");

  test("31 days", () => assert.equal(DEVICE_ID_DAYS, 31));

  test("none stored: a new one, with today's date", () => {
    const s = stored(null);
    assert.equal(deviceIdOn(day("2026-11-16"), s.api, fixed(0xbb), never), NEW);
    assert.equal(s.storage.get(DEVICE_ID_KEY), `${NEW}.2026-11-16`);
  });

  for (const [today, kept] of [["2026-11-16", true], ["2026-12-16", true], ["2026-12-17", false], ["2027-11-16", false]] as const) {
    test(`made on 2026-11-16, asked on ${today}: ${kept ? "the same" : "another, and the old one is gone"}`, () => {
      const s = stored(`${OLD}.2026-11-16`);
      assert.equal(deviceIdOn(day(today), s.api, fixed(0xbb), never), kept ? OLD : NEW);
      assert.equal(s.storage.get(DEVICE_ID_KEY), kept ? `${OLD}.2026-11-16` : `${NEW}.${today}`);
      assert.equal(s.storage.size, 1);
    });
  }

  for (const value of [OLD, `${OLD}.`, `${OLD}.2026-13-01`, `${OLD.toUpperCase()}.2026-11-16`, `${OLD.slice(1)}.2026-11-16`, `${OLD}.2026-11-17`, `{"id":"${OLD}"}`, ""]) {
    test(`a stored value that is not an ID and the date it was made on, or is dated after today, is replaced: ${JSON.stringify(value)}`, () => {
      const s = stored(value);
      assert.equal(deviceIdOn(day("2026-11-16"), s.api, fixed(0xbb), never), NEW);
      assert.equal(s.storage.get(DEVICE_ID_KEY), `${NEW}.2026-11-16`);
    });
  }
});

describe("the browser and the operating system, from a User-Agent", () => {
  const CASES: [string, string, string][] = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "chrome", "windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0", "edge", "windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0", "firefox", "windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", "safari", "macos"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "chrome", "macos"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "firefox", "linux"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "chrome", "chromeos"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", "chrome", "android"],
    ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36", "samsung", "android"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", "safari", "ios"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1", "chrome", "ios"],
    ["Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15", "firefox", "ios"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 OPR/101.0.0.0", "other", "windows"],
    ["curl/8.7.1", "other", "other"],
    ["", "other", "other"],
  ];
  for (const [userAgent, browser, os] of CASES) {
    test(`${userAgent || "(empty)"}: ${browser} on ${os}`, () => {
      assert.deepEqual(familiesOf(userAgent), { browser, os });
      assert.ok(TABLE.browsers.includes(browser) && TABLE.oses.includes(os));
    });
  }
});
