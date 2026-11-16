// Which sentence the screen shows for each stop and each state of the card
// (src/ui/messages.ts). The screens themselves run in the headless browser
// test (test/e2e/ui.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CardStatus, Stop } from "../src/flow.ts";
import { COPY, fill } from "../src/ui/copy.ts";
import { type Message, daysBetween, statusView, stopMessage } from "../src/ui/messages.ts";

const text = (m: Message): string => ("code" in m ? `[${m.code}]` : fill(m.template, m.values));

describe("stops", () => {
  // Every stop the flow can give before or after the PIN, and its sentence.
  const cases: [Stop, string][] = [
    [{ code: "card", card: "component_unreachable" }, COPY.stops.component_unreachable],
    [{ code: "card", card: "no_card" }, COPY.stops.no_card],
    [{ code: "card", card: "pin_incorrect" }, COPY.before_pin.pin_incorrect],
    [{ code: "card", card: "card_locked" }, COPY.stops.card_locked],
    [{ code: "card", card: "card_error", detail: "76100009" }, "讀卡時發生錯誤（代碼 76100009）。請重新插卡再試一次。"],
    [{ code: "card", card: "card_error" }, "讀卡時發生錯誤（代碼 card_error）。請重新插卡再試一次。"],
    [{ code: "certificate", problem: "no_certificate" }, COPY.stops.no_certificate],
    [{ code: "certificate", problem: "expired", notAfter: "2025-03-01" }, "這張卡片的憑證在 2025-03-01 到期，不能過卡。"],
    [{ code: "certificate", problem: "not_yet_valid", notBefore: "2026-12-01" }, "這張卡片的憑證從 2026-12-01 才生效，現在不能過卡。"],
    [{ code: "certificate", problem: "not_citizen_primary" }, COPY.stops.not_citizen_primary],
    [{ code: "certificate", problem: "unsupported_format" }, COPY.stops.unsupported_format],
    [{ code: "certificate", problem: "ambiguous_certificate" }, COPY.stops.unsupported_format],
    [{ code: "certificate", problem: "unknown_issuer" }, COPY.stops.unknown_issuer],
    [{ code: "revocation", problem: { code: "crl_stale", days: 5, maxDays: 3 } }, "內政部的廢止清冊已經 5 天沒有更新，現在不能過卡。"],
    [{ code: "revocation", problem: { code: "crl_unavailable", detail: "index" } }, "現在拿不到可用的內政部廢止清冊，不能過卡。請稍後再試。（代碼 crl_unavailable）"],
    [{ code: "revocation", problem: { code: "crl_hash" } }, "現在拿不到可用的內政部廢止清冊，不能過卡。請稍後再試。（代碼 crl_hash）"],
    [{ code: "revocation", problem: { code: "crl_unusable", reason: "partitioned" } }, "現在拿不到可用的內政部廢止清冊，不能過卡。請稍後再試。（代碼 crl_unusable）"],
    [{ code: "revocation", problem: { code: "crl_rollback", crlNumber: 1n, highest: 2n } }, COPY.stops.crl_rollback],
    [{ code: "revoked" }, COPY.stops.revoked],
    [{ code: "artifact", path: "/crs/bn254_g2.dat" }, COPY.stops.artifact],
    [{ code: "engine", detail: "x" }, COPY.stops.engine],
    [{ code: "card_signature" }, "讀卡時發生錯誤（代碼 card_signature）。請重新插卡再試一次。"],
    [{ code: "challenge_malformed" }, "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 challenge_malformed）"],
    [{ code: "challenge_not_today", challengeDate: "2026-11-15", today: "2026-11-16" }, COPY.stops.date_mismatch],
    [{ code: "proof_check" }, COPY.stops.proof_check],
    [{ code: "server", server: "challenge_unknown", status: 400 }, COPY.stops.challenge_expired],
    [{ code: "server", server: "root", status: 400 }, "這次過卡沒有被接受（代碼 root），名冊沒有變動。"],
    [{ code: "server", server: "crl_stale", status: 503 }, "這次過卡沒有被接受（代碼 crl_stale），名冊沒有變動。"],
    [{ code: "server", server: "malformed_response", status: 200 }, "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 malformed_response）"],
    [{ code: "server", server: "network", status: 0 }, "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 network）"],
    [{ code: "username" }, COPY.enter.bad_username],
    [{ code: "state" }, "[state]"],
  ];
  for (const [stop, want] of cases) {
    test(JSON.stringify(stop, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), () => assert.equal(text(stopMessage(stop)), want));
  }

  test("the component cannot be reached: a link to how to prepare", () => {
    const m = stopMessage({ code: "card", card: "component_unreachable" });
    assert.ok(!("code" in m) && m.link === "prepare");
  });

  test("a submission that did not get through: the retry button, and the request ID", () => {
    const m = stopMessage({ code: "server", server: "internal", status: 500, requestId: "0123456789abcdef" }, true);
    assert.equal(text(m), COPY.stops.submit_failed);
    assert.ok(!("code" in m) && m.retry === true);
    assert.equal(m.requestId, "0123456789abcdef");
  });

  test("every server error carries its request ID", () => {
    for (const server of ["root", "challenge_unknown", "malformed_response", "not_found"]) {
      assert.equal(stopMessage({ code: "server", server, status: 400, requestId: "ab" }).requestId, "ab", server);
    }
  });
});

describe("the card's state", () => {
  const base: CardStatus = {
    scopedId: "X",
    shortId: "7K2Q9F",
    current: null,
    lastDeclared: null,
    lastCardProof: null,
    outcome: { kind: "first" },
    switchesLeft: 2,
    switchesLeftAfter: 2,
    nextSwitchDate: "2026-11-16",
    username: "alice",
    today: "2026-11-16",
    count: 0,
    head: "0".repeat(64),
  };
  const view = (action: "declare" | "withdraw", s: Partial<CardStatus>) => {
    const v = statusView(action, { ...base, ...s }, "threads");
    return { first: text(v.first), button: v.button && fill(v.button.template, v.button.values), record: v.record && fill(v.record.template, v.record.values) };
  };

  test("the four rows of the copy", () => {
    assert.deepEqual(view("declare", {}), {
      first: "這張卡片還沒有宣告過。",
      button: "宣告給 @alice",
      record: "2026-11-16，有一張有效的自然人憑證宣告了 Threads 的 @alice。",
    });
    assert.deepEqual(view("declare", { current: "alice", lastDeclared: "alice", lastCardProof: "2026-11-04", outcome: { kind: "refresh" } }).first, "這張卡片目前宣告的是 @alice，上次過卡是 12 天前。");
    assert.equal(view("declare", { outcome: { kind: "refresh" }, current: "alice", lastDeclared: "alice", lastCardProof: "2026-11-04" }).button, "再次過卡");
    const sw = view("declare", { current: "bob", lastDeclared: "bob", lastCardProof: "2026-11-04", outcome: { kind: "switch" }, switchesLeft: 2, switchesLeftAfter: 1 });
    assert.equal(sw.first, "這張卡片目前宣告的是 @bob。改成 @alice 會用掉一次更換，之後今年還剩 1 次。");
    assert.equal(sw.button, "改成 @alice");
    const blocked = view("declare", { current: "bob", lastDeclared: "bob", outcome: { kind: "blocked", reason: "switch_limit" }, nextSwitchDate: "2027-03-02" });
    assert.equal(blocked.first, "這張卡片目前宣告的是 @bob。一年最多更換兩次，下一次可以更換是 2027-03-02。");
    assert.equal(blocked.button, null);
  });

  test("withdrawal", () => {
    assert.deepEqual(view("withdraw", { current: "alice", lastDeclared: "alice", outcome: { kind: "withdraw" }, username: "alice" }), {
      first: "這張卡片目前宣告的是 @alice。",
      button: "收回對 @alice 的宣告",
      record: "2026-11-16，有一張有效的自然人憑證收回了對 Threads 的 @alice 的宣告。",
    });
    assert.deepEqual(view("withdraw", { outcome: { kind: "blocked", reason: "not_current" }, username: null }), {
      first: "這張卡片目前沒有宣告任何帳號。",
      button: null,
      record: null,
    });
  });

  test("a card whose declaration was withdrawn: the copy has no first sentence, the code is shown", () => {
    assert.equal(view("declare", { lastDeclared: "alice", lastCardProof: "2026-11-04", outcome: { kind: "refresh" } }).first, "[refresh_after_withdraw]");
    assert.equal(view("declare", { lastDeclared: "bob", outcome: { kind: "switch" } }).first, "[switch_after_withdraw]");
    assert.equal(view("declare", { lastDeclared: "bob", outcome: { kind: "blocked", reason: "switch_limit" } }).first, "[switch_limit_after_withdraw]");
  });

  test("days between two dates", () => {
    assert.equal(daysBetween("2026-11-04", "2026-11-16"), 12);
    assert.equal(daysBetween("2025-11-16", "2026-11-16"), 365);
    assert.equal(daysBetween("2026-11-16", "2026-11-16"), 0);
  });
});
