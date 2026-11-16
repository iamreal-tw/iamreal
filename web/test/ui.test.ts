// Which sentence the screen shows for each stop, each state of the card and
// each consequence (src/ui/messages.ts). The screens themselves run in the headless browser
// test (test/e2e/ui.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CardStatus, Consequence, Stop } from "../src/flow.ts";
import { COPY, fill } from "../src/ui/copy.ts";
import { type Message, consequenceView, daysBetween, doneRecord, doneTitle, statusView, stopMessage } from "../src/ui/messages.ts";

const text = (m: Message): string => ("code" in m ? `[${m.code}]` : fill(m.template, m.values));

describe("stops", () => {
  // Every stop the flow can give before or after the PIN, and its sentence.
  const cases: [Stop, string][] = [
    [{ code: "card", card: "component_unreachable" }, COPY.stops.component_unreachable],
    [{ code: "card", card: "no_card" }, COPY.stops.no_card],
    [{ code: "card", card: "pin_incorrect" }, COPY.confirm_card.pin_incorrect],
    [{ code: "card", card: "popup_blocked" }, COPY.confirm_card.popup_blocked],
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
    [{ code: "server", server: "crl_stale", status: 503 }, "內政部的廢止清冊超過 3 天沒有更新，現在不能過卡。"],
    [{ code: "card", card: "card_error", detail: "pin_characters" }, "這一頁不支援含有 +、% 或非英數符號的 PIN。請先到內政部憑證管理中心的網站變更 PIN。"],
    [{ code: "card", card: "card_error", detail: "no_pin" }, "讀卡時發生錯誤（代碼 no_pin）。請重新插卡再試一次。"],
    [{ code: "server", server: "malformed_response", status: 200 }, "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 malformed_response）"],
    [{ code: "server", server: "network", status: 0 }, "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 network）"],
    [{ code: "username" }, COPY.status.bad_username],
    [{ code: "state" }, "[state]"],
    [{ code: "idle" }, "超過 5 分鐘沒有完成，為了不讓 PIN 留在這一頁太久，已經回到開頭。請再讀一次卡片。"],
    [{ code: "blocked", reason: "switch_limit" }, "[switch_limit]"],
    [{ code: "blocked", reason: "daily_limit" }, "[daily_limit]"],
    // The card's state said fewer than 3 today; the server found the fourth when it was sent.
    [{ code: "server", server: "daily_limit", status: 400 }, "這張卡片今天在 Threads 已經過卡 3 次，明天才能再過卡。"],
  ];
  for (const [stop, want] of cases) {
    test(JSON.stringify(stop, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), () => assert.equal(text(stopMessage(stop, "threads")), want));
  }

  test("the component cannot be reached: a link to how to prepare", () => {
    const m = stopMessage({ code: "card", card: "component_unreachable" }, "threads");
    assert.ok(!("code" in m) && m.link === "prepare");
  });

  test("a submission that did not get through: the retry button, and the request ID", () => {
    const m = stopMessage({ code: "server", server: "internal", status: 500, requestId: "0123456789abcdef" }, "threads", true);
    assert.equal(text(m), COPY.stops.submit_failed);
    assert.ok(!("code" in m) && m.retry === true);
    assert.equal(m.requestId, "0123456789abcdef");
  });

  test("every server error carries its request ID", () => {
    for (const server of ["root", "challenge_unknown", "crl_stale", "daily_limit", "malformed_response", "not_found"]) {
      assert.equal(stopMessage({ code: "server", server, status: 400, requestId: "ab" }, "threads").requestId, "ab", server);
    }
  });
});

describe("the card's state (section 3)", () => {
  const base: CardStatus = {
    scopedId: "X",
    shortId: "7K2Q9F",
    current: null,
    lastDeclared: null,
    lastCardProof: null,
    options: { refresh: null, declareBack: null, other: { kind: "first" }, withdraw: null },
    switchesUsed: 0,
    switchesLeft: 2,
    nextSwitchDate: "2026-11-16",
    dailyLimit: false,
    today: "2026-11-16",
    count: 0,
    head: "0".repeat(64),
  };
  const view = (s: Partial<CardStatus>) => {
    const v = statusView({ ...base, ...s }, "threads");
    return { state: v.state, first: fill(v.first.template, v.first.values), facts: v.facts.map(text), canSwitch: v.canSwitch, switchLimit: v.switchLimit && fill(v.switchLimit.template, v.switchLimit.values) };
  };

  test("never declared", () => {
    assert.deepEqual(view({}), { state: "never", first: "這張卡片在 Threads 還沒有宣告過。", facts: [], canSwitch: true, switchLimit: null });
  });

  test("declared: the last card proof and the switches of the past year", () => {
    const d = { current: "alice", lastDeclared: "alice", lastCardProof: "2026-11-04", switchesUsed: 1, switchesLeft: 1 };
    assert.deepEqual(view({ ...d, options: { refresh: { kind: "refresh" }, declareBack: null, other: { kind: "switch" }, withdraw: { kind: "withdraw" } } }), {
      state: "declared",
      first: "這張卡片目前宣告的是 @alice。",
      facts: ["上次過卡是 12 天前。", "過去一年更換過 1 次，還可以更換 1 次。"],
      canSwitch: true,
      switchLimit: null,
    });
    const used = view({ ...d, switchesUsed: 2, switchesLeft: 0, nextSwitchDate: "2027-03-02", options: { refresh: { kind: "refresh" }, declareBack: null, other: { kind: "blocked", reason: "switch_limit" }, withdraw: { kind: "withdraw" } } });
    assert.equal(used.canSwitch, false);
    assert.equal(used.switchLimit, "一年最多更換兩次，下一次可以更換是 2027-03-02。");
    assert.deepEqual(used.facts, ["上次過卡是 12 天前。", "過去一年更換過 2 次，還可以更換 0 次。"]);
  });

  test("declared, the last card proof today: 今天, not 0 天前", () => {
    const d = { current: "alice", lastDeclared: "alice", lastCardProof: "2026-11-16", options: { refresh: { kind: "refresh" as const }, declareBack: null, other: { kind: "switch" as const }, withdraw: { kind: "withdraw" as const } } };
    assert.deepEqual(view(d).facts, ["上次過卡是今天。", "過去一年更換過 0 次，還可以更換 2 次。"]);
    assert.deepEqual(view({ ...d, lastCardProof: "2026-11-15" }).facts[0], "上次過卡是 1 天前。");
  });

  test("3 records today: that sentence alone, whatever the card declares", () => {
    const full = {
      state: "daily_limit",
      first: "這張卡片今天在 Threads 已經過卡 3 次，明天才能再過卡。",
      facts: [],
      canSwitch: false,
      switchLimit: null,
    };
    const options = { refresh: { kind: "refresh" as const }, declareBack: null, other: { kind: "switch" as const }, withdraw: { kind: "withdraw" as const } };
    assert.deepEqual(view({ current: "alice", lastDeclared: "alice", lastCardProof: "2026-11-16", options, dailyLimit: true }), full);
    const withdrawn = { refresh: null, declareBack: { kind: "refresh" as const }, other: { kind: "blocked" as const, reason: "switch_limit" as const }, withdraw: null };
    assert.deepEqual(view({ lastDeclared: "bob", lastCardProof: "2026-11-16", options: withdrawn, dailyLimit: true }), full);
  });

  test("withdrawn", () => {
    const w = { lastDeclared: "bob", lastCardProof: "2026-11-10", options: { refresh: null, declareBack: { kind: "refresh" as const }, other: { kind: "switch" as const }, withdraw: null } };
    assert.deepEqual(view(w), { state: "withdrawn", first: "這張卡片目前沒有宣告。上一次宣告的是 @bob，已經收回。", facts: [], canSwitch: true, switchLimit: null });
    const used = view({ ...w, nextSwitchDate: "2027-03-02", options: { ...w.options, other: { kind: "blocked", reason: "switch_limit" } } });
    assert.equal(used.canSwitch, false);
    assert.equal(used.switchLimit, "一年最多更換兩次，下一次可以更換是 2027-03-02。");
  });

  test("days between two dates", () => {
    assert.equal(daysBetween("2026-11-04", "2026-11-16"), 12);
    assert.equal(daysBetween("2025-11-16", "2026-11-16"), 365);
    assert.equal(daysBetween("2026-11-16", "2026-11-16"), 0);
  });
});

describe("the consequence (section 4)", () => {
  const cq = (kind: Consequence["kind"], username = "alice", switchesLeftAfter = 1): Consequence => ({
    action: kind === "withdraw" ? "withdraw" : "declare",
    username,
    kind,
    switchesLeftAfter,
    today: "2026-11-16",
  });
  const view = (c: Consequence, current: string | null) => {
    const v = consequenceView(c, current, "threads");
    return { record: fill(v.record.template, v.record.values), switchLine: v.switchLine && fill(v.switchLine.template, v.switchLine.values), later: v.later, button: fill(v.button.template, v.button.values) };
  };
  const declared = "2026-11-16，有一張有效的自然人憑證宣告了 Threads 的 @alice，";
  const later = [COPY.consequence.later, COPY.consequence.permanent];

  test("the rows of the table", () => {
    assert.deepEqual(view(cq("first"), null), { record: declared, switchLine: null, later, button: "宣告給 @alice" });
    assert.deepEqual(view(cq("refresh"), "alice"), { record: declared, switchLine: null, later, button: "再次過卡" });
    assert.deepEqual(view(cq("switch"), "bob"), { record: declared, switchLine: "這會用掉一次更換，之後一年內還剩 1 次。", later, button: "改成 @alice" });
    assert.deepEqual(view(cq("withdraw"), "alice"), {
      record: "2026-11-16，有一張有效的自然人憑證收回了對 Threads 的 @alice 的宣告，",
      switchLine: null,
      later: [COPY.consequence.later_withdraw, COPY.consequence.permanent],
      button: "收回對 @alice 的宣告",
    });
  });

  test("declaring again the account withdrawn before: the row of a first declaration, no switch", () => {
    assert.deepEqual(view(cq("refresh"), null), { record: declared, switchLine: null, later, button: "宣告給 @alice" });
  });

  test("a switch that leaves none", () => {
    assert.equal(view(cq("switch", "carol", 0), "bob").switchLine, "這會用掉一次更換，之後一年內還剩 0 次。");
  });
});

describe("done (section 6)", () => {
  test("the first line and the record line", () => {
    const t = (s: { template: string; values: Record<string, string | number> }) => fill(s.template, s.values);
    assert.equal(t(doneTitle("first", "alice", null)), "已宣告。");
    assert.equal(t(doneTitle("refresh", "alice", "alice")), "已再次過卡。");
    assert.equal(t(doneTitle("switch", "alice", "bob")), "已改成 @alice。");
    assert.equal(t(doneTitle("withdraw", "alice", "alice")), "已收回。");
    // Declaring again the account withdrawn before: a refresh by the roster rules, 已宣告 on the screen.
    assert.equal(t(doneTitle("refresh", "alice", null)), "已宣告。");
    assert.equal(t(doneRecord("first", "2026-11-16", "alice", "threads")), "2026-11-16，有一張有效的自然人憑證宣告了 Threads 的 @alice。");
    assert.equal(t(doneRecord("withdraw", "2026-11-16", "alice", "threads")), "2026-11-16，有一張有效的自然人憑證收回了對 Threads 的 @alice 的宣告。");
  });
});
