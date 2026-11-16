// Which sentence the screen shows for each stop and under which item of the
// lists; what each item of the lists shows; each state of the card, each
// consequence, done and its link (src/ui/messages.ts); the platform
// definition (src/platforms.ts). The screens themselves run in the headless
// browser test (test/e2e/ui.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CardStatus, Consequence, Done, Progress, Stop } from "../src/flow.ts";
import { PLATFORMS, SITE_DOMAIN, handle, platformOf } from "../src/platforms.ts";
import { scopeFor } from "../src/spec/scope.ts";
import { COPY, fill } from "../src/ui/copy.ts";
import {
  type ItemState,
  type Message,
  PROGRESS_ITEMS,
  READ_ITEMS,
  consequenceView,
  daysBetween,
  doneView,
  firstNotDone,
  itemStates,
  progressButtons,
  readItemOf,
  statusView,
  stopMessage,
} from "../src/ui/messages.ts";

const threads = platformOf("threads");
const text = (m: Message): string => ("code" in m ? `[${m.code}]` : fill(m.template, m.values));
const t = (s: { template: string; values: Record<string, string | number> }): string => fill(s.template, s.values);

describe("the platform definition", () => {
  test("Threads is open; X is listed, not open, with no scope string", () => {
    assert.deepEqual(
      PLATFORMS.map((p) => [p.key, p.name, p.open]),
      [
        ["threads", "Threads", true],
        ["x", "X", false],
      ],
    );
    const x = PLATFORMS.find((p) => p.key === "x")!;
    assert.ok(!("scopeStrings" in x) && !("prefix" in x));
    assert.throws(() => scopeFor("test", "x" as "threads"));
  });

  test("Threads: the prefix, the format hint, the profile page, the account's page, the scope strings", () => {
    assert.equal(handle(threads, "alice"), "@alice");
    assert.equal(COPY.formats[threads.formatHint as "threads"], "帳號只能用英文小寫、數字、句點和底線，最多 30 個字。");
    assert.equal(threads.profileUrl!("alice"), "https://www.threads.com/@alice");
    assert.equal(threads.accountPath("alice"), "threads/@alice");
    assert.equal(scopeFor("test", "threads").scopeString, threads.scopeStrings.test);
    assert.equal(scopeFor("production", "threads").scopeString, threads.scopeStrings.production);
    assert.equal(SITE_DOMAIN, "iamreal.tw");
  });
});

describe("stops", () => {
  // Every stop the flow can give, its sentence, and the item of step 2's list it is written under.
  const cases: [Stop, string, number | null][] = [
    [{ code: "card", card: "component_unreachable" }, COPY.stops.component_unreachable, 0],
    [{ code: "card", card: "no_reader" }, "找不到讀卡機。請確認讀卡機已經接上電腦。", 1],
    [{ code: "card", card: "no_card" }, COPY.stops.no_card, 1],
    [{ code: "card", card: "pin_incorrect" }, COPY.pin.pin_incorrect, null],
    [{ code: "card", card: "popup_blocked" }, COPY.common.popup_blocked, null],
    [{ code: "card", card: "card_locked" }, COPY.stops.card_locked, 2],
    [{ code: "card", card: "card_error", detail: "76100009" }, "讀卡時發生錯誤（代碼 76100009）。請重新插卡再試一次。", 2],
    [{ code: "card", card: "card_error" }, "讀卡時發生錯誤（代碼 card_error）。請重新插卡再試一次。", 2],
    [{ code: "certificate", problem: "no_certificate" }, COPY.stops.no_certificate, 2],
    [{ code: "certificate", problem: "expired", notAfter: "2025-03-01" }, "這張卡片的憑證在 2025-03-01 到期，不能過卡。", 3],
    [{ code: "certificate", problem: "not_yet_valid", notBefore: "2026-12-01" }, "這張卡片的憑證從 2026-12-01 才生效，現在不能過卡。", 3],
    [{ code: "certificate", problem: "not_citizen_primary" }, COPY.stops.not_citizen_primary, 3],
    [{ code: "certificate", problem: "unsupported_format" }, COPY.stops.unsupported_format, 3],
    [{ code: "certificate", problem: "ambiguous_certificate" }, "讀到兩張可以過卡的自然人憑證。請只留下要用的那一張，再讀一次。", 3],
    [{ code: "certificate", problem: "unknown_issuer" }, COPY.stops.unknown_issuer, 3],
    [{ code: "artifact", path: "/crs/bn254_g2.dat" }, COPY.stops.artifact, 4],
    [{ code: "engine", detail: "x" }, COPY.stops.engine, 4],
    [{ code: "server", server: "network", status: 0 }, "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 network）", 4],
    [{ code: "server", server: "malformed_response", status: 200 }, "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 malformed_response）", 4],
    [{ code: "revocation", problem: { code: "crl_stale", days: 5, maxDays: 3 } }, "內政部的廢止清冊已經 5 天沒有更新，現在不能過卡。", 5],
    [{ code: "revocation", problem: { code: "crl_unavailable", detail: "index" } }, "現在拿不到可用的內政部廢止清冊，不能過卡。請稍後再試。（代碼 crl_unavailable）", 5],
    [{ code: "revocation", problem: { code: "crl_hash" } }, "現在拿不到可用的內政部廢止清冊，不能過卡。請稍後再試。（代碼 crl_hash）", 5],
    [{ code: "revocation", problem: { code: "crl_unusable", reason: "partitioned" } }, "現在拿不到可用的內政部廢止清冊，不能過卡。請稍後再試。（代碼 crl_unusable）", 5],
    [{ code: "revocation", problem: { code: "crl_rollback", crlNumber: 1n, highest: 2n } }, COPY.stops.crl_rollback, 5],
    [{ code: "revoked" }, COPY.stops.revoked, 5],
    [{ code: "card_signature" }, "讀卡時發生錯誤（代碼 card_signature）。請重新插卡再試一次。", null],
    [{ code: "challenge_malformed" }, "伺服器的回應不正確，現在不能過卡。請稍後再試。（代碼 challenge_malformed）", null],
    [{ code: "challenge_not_today", challengeDate: "2026-11-15", today: "2026-11-16" }, COPY.stops.date_mismatch, null],
    [{ code: "proof_check" }, COPY.stops.proof_check, null],
    [{ code: "server", server: "challenge_unknown", status: 400 }, COPY.stops.challenge_expired, 4],
    [{ code: "server", server: "root", status: 400 }, "這次過卡沒有被接受（代碼 root），名冊沒有變動。", 4],
    [{ code: "server", server: "challenge_used", status: 400 }, "這次過卡沒有被接受（代碼 challenge_used），名冊沒有變動。", 4],
    [{ code: "server", server: "crl_stale", status: 503 }, "內政部的廢止清冊超過 3 天沒有更新，現在不能過卡。", 4],
    [{ code: "card", card: "card_error", detail: "pin_characters" }, "這一頁不支援含有 +、% 或非英數符號的 PIN。請先到內政部憑證管理中心的網站變更 PIN。", 2],
    [{ code: "card", card: "card_error", detail: "no_pin" }, "讀卡時發生錯誤（代碼 no_pin）。請重新插卡再試一次。", 2],
    [{ code: "username" }, "帳號只能用英文小寫、數字、句點和底線，最多 30 個字。", null],
    [{ code: "state" }, "[state]", null],
    [{ code: "idle" }, "超過 5 分鐘沒有完成，為了不讓 PIN 留在這一頁太久，已經回到開頭。請再讀一次卡片。", null],
    [{ code: "blocked", reason: "switch_limit" }, "[switch_limit]", null],
    [{ code: "blocked", reason: "daily_limit" }, "[daily_limit]", null],
    // The card's state said fewer than 3 today; the server found the fourth when it was sent.
    [{ code: "server", server: "daily_limit", status: 400 }, "這張卡片今天在 Threads 已經過卡 3 次，明天才能再過卡。", 4],
  ];
  for (const [stop, want, item] of cases) {
    test(JSON.stringify(stop, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), () => {
      assert.equal(text(stopMessage(stop, threads)), want);
      assert.equal(readItemOf(stop), item);
    });
  }

  test("the component cannot be reached: a link to how to prepare", () => {
    const m = stopMessage({ code: "card", card: "component_unreachable" }, threads);
    assert.ok(!("code" in m) && m.link === "prepare");
  });

  test("a submission that did not get through: the retry button, and the request ID", () => {
    const m = stopMessage({ code: "server", server: "internal", status: 500, requestId: "0123456789abcdef" }, threads, true);
    assert.equal(text(m), COPY.stops.submit_failed);
    assert.ok(!("code" in m) && m.retry === true);
    assert.equal(m.requestId, "0123456789abcdef");
  });

  test("every server error carries its request ID", () => {
    for (const server of ["root", "challenge_unknown", "challenge_used", "crl_stale", "daily_limit", "malformed_response", "not_found"]) {
      assert.equal(stopMessage({ code: "server", server, status: 400, requestId: "ab" }, threads).requestId, "ab", server);
    }
  });
});

describe("the lists of steps 2 and 5", () => {
  const states = (seen: Progress[], o: { running?: boolean; stoppedAt?: number | null; allDone?: boolean } = {}): ItemState[] =>
    itemStates(READ_ITEMS, new Set(seen), { running: o.running ?? true, stoppedAt: o.stoppedAt ?? null, allDone: o.allDone });

  test("the labels are the copy's, in its order", () => {
    assert.deepEqual(
      READ_ITEMS.map((i) => (COPY.read as Record<string, string>)[i.key]),
      ["連上內政部的元件", "找到讀卡機和卡片", "讀取卡片上的憑證", "檢查憑證", "連上島民的伺服器", "下載內政部的廢止清冊，確認憑證沒有被廢止"],
    );
    assert.deepEqual(
      PROGRESS_ITEMS.map((i) => (COPY.progress as Record<string, string>)[i.key]),
      ["連上島民的伺服器", "卡片簽章", "在這台裝置上計算，大約 10 到 30 秒", "送出"],
    );
  });

  test("top to bottom: the first item not done is in progress, the ones after it show nothing", () => {
    assert.deepEqual(states([]), ["now", "", "", "", "", ""]);
    assert.deepEqual(states(["component"]), ["done", "now", "", "", "", ""]);
    assert.deepEqual(states(["component", "certificates"]), ["done", "done", "done", "now", "", ""]);
    assert.deepEqual(states([], { running: false }), ["", "", "", "", "", ""]);
  });

  test("things done at once: an item shows done only after every item above it", () => {
    // The CRL and the tree are done before the server's three things.
    const crlFirst: Progress[] = ["component", "certificates", "certificate", "crl", "tree", "config"];
    assert.deepEqual(states(crlFirst), ["done", "done", "done", "done", "now", ""]);
    assert.deepEqual(states([...crlFirst, "engine", "circuit"]), ["done", "done", "done", "done", "done", "done"]);
    assert.deepEqual(states([], { allDone: true }), ["done", "done", "done", "done", "done", "done"]);
  });

  test("stopped: the item stopped at, nothing after it; an item above it not done shows nothing", () => {
    assert.deepEqual(states(["component"], { running: false, stoppedAt: 1 }), ["done", "halt", "", "", "", ""]);
    // The CRL stopped while the server's item was not done yet.
    assert.deepEqual(states(["component", "certificates", "certificate", "config"], { running: false, stoppedAt: 5 }), ["done", "done", "done", "done", "", "halt"]);
    // The certificates came back, but none can be used: stopped at item 3 although its event came.
    assert.deepEqual(states(["component", "certificates"], { running: false, stoppedAt: 2 }), ["done", "done", "halt", "", "", ""]);
  });

  test("the buttons after step 5 stopped: by whether the engine still holds the PIN", () => {
    // The phase the engine is in after each stop of proceed() and resubmit() (src/flow.ts).
    const cases: [string, string, string[]][] = [
      ["the browser blocked the window of the second signature (the PIN kept)", "chosen", ["back"]],
      ["the submission did not get through (the PIN dropped after the second signature)", "submit_failed", ["read_again", "retry"]],
      ["the challenge expired on the server (challenge_unknown)", "stopped", ["read_again"]],
      ["a challenge of another day", "stopped", ["read_again"]],
      ["the server refused the record", "stopped", ["read_again"]],
      ["the server's 3 records today", "stopped", ["read_again"]],
      ["the card's signature does not verify", "stopped", ["read_again"]],
      ["the device cannot prove", "stopped", ["read_again"]],
    ];
    for (const [label, phase, want] of cases) assert.deepEqual(progressButtons(phase), want, label);
    assert.equal(COPY.read.read_again, "再讀一次卡片");
    assert.equal(COPY.progress.back, "回到上一步");
  });

  test("step 5 stops where it got to: the first item not done", () => {
    const p = (seen: Progress[]) => itemStates(PROGRESS_ITEMS, new Set(seen), { running: false, stoppedAt: null });
    assert.equal(firstNotDone(p([])), 0);
    assert.equal(firstNotDone(p(["challenge"])), 1);
    assert.equal(firstNotDone(p(["challenge", "signed", "proved"])), 3);
    assert.deepEqual(itemStates(PROGRESS_ITEMS, new Set<Progress>(["challenge", "signed", "proved"]), { running: false, stoppedAt: 3 }), ["done", "done", "done", "halt"]);
  });
});

describe("the card's state (step 4)", () => {
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
    const v = statusView({ ...base, ...s }, threads);
    return { state: v.state, lines: v.lines.map((l) => l.map(text).join("")), dailyLimit: v.dailyLimit && t(v.dailyLimit), canSwitch: v.canSwitch, switchLimit: v.switchLimit && t(v.switchLimit) };
  };
  const declared = { current: "alice", lastDeclared: "alice", lastCardProof: "2026-11-04", switchesUsed: 1, switchesLeft: 1, options: { refresh: { kind: "refresh" as const }, declareBack: null, other: { kind: "switch" as const }, withdraw: { kind: "withdraw" as const } } };

  test("never declared", () => {
    assert.deepEqual(view({}), { state: "never", lines: ["這張卡片在 Threads 還沒有宣告過。"], dailyLimit: null, canSwitch: true, switchLimit: null });
  });

  test("declared: the last card proof and the switches of the past year, on one line", () => {
    assert.deepEqual(view(declared), {
      state: "declared",
      lines: ["這張卡片目前宣告的是 @alice。", "上次過卡是 12 天前。過去一年更換過 1 次，還可以更換 1 次。"],
      dailyLimit: null,
      canSwitch: true,
      switchLimit: null,
    });
  });

  test("declared, switches used up: 不能再更換, and the sentence under the button", () => {
    const used = view({ ...declared, switchesUsed: 2, switchesLeft: 0, nextSwitchDate: "2027-03-02", options: { ...declared.options, other: { kind: "blocked", reason: "switch_limit" } } });
    assert.deepEqual(used.lines, ["這張卡片目前宣告的是 @alice。", "上次過卡是 12 天前。過去一年更換過 2 次，不能再更換。"]);
    assert.equal(used.canSwitch, false);
    assert.equal(used.switchLimit, "一年最多更換兩次，下一次可以更換是 2027-03-02。");
  });

  test("declared, the last card proof today: 今天, not 0 天前", () => {
    assert.equal(view({ ...declared, lastCardProof: "2026-11-16", switchesUsed: 0, switchesLeft: 2 }).lines[1], "上次過卡是今天。過去一年更換過 0 次，還可以更換 2 次。");
    assert.equal(view({ ...declared, lastCardProof: "2026-11-15" }).lines[1]!.startsWith("上次過卡是 1 天前。"), true);
  });

  test("withdrawn: two lines", () => {
    const w = { lastDeclared: "bob", lastCardProof: "2026-11-10", options: { refresh: null, declareBack: { kind: "refresh" as const }, other: { kind: "switch" as const }, withdraw: null } };
    assert.deepEqual(view(w), { state: "withdrawn", lines: ["這張卡片目前沒有宣告。", "上一次宣告的是 @bob，已經收回。"], dailyLimit: null, canSwitch: true, switchLimit: null });
    const used = view({ ...w, nextSwitchDate: "2027-03-02", options: { ...w.options, other: { kind: "blocked", reason: "switch_limit" } } });
    assert.equal(used.canSwitch, false);
    assert.equal(used.switchLimit, "一年最多更換兩次，下一次可以更換是 2027-03-02。");
  });

  test("3 records today: the state's lines stay, and the sentence in place of the choices", () => {
    const sentence = "這張卡片今天在 Threads 已經過卡 3 次，明天才能再過卡。";
    const d = view({ ...declared, lastCardProof: "2026-11-16", dailyLimit: true });
    assert.equal(d.state, "declared");
    assert.deepEqual(d.lines, ["這張卡片目前宣告的是 @alice。", "上次過卡是今天。過去一年更換過 1 次，還可以更換 1 次。"]);
    assert.equal(d.dailyLimit, sentence);
    const w = view({ lastDeclared: "bob", lastCardProof: "2026-11-16", dailyLimit: true, options: { refresh: null, declareBack: { kind: "refresh" }, other: { kind: "switch" }, withdraw: null } });
    assert.deepEqual([w.state, w.lines, w.dailyLimit], ["withdrawn", ["這張卡片目前沒有宣告。", "上一次宣告的是 @bob，已經收回。"], sentence]);
  });

  test("days between two dates", () => {
    assert.equal(daysBetween("2026-11-04", "2026-11-16"), 12);
    assert.equal(daysBetween("2025-11-16", "2026-11-16"), 365);
    assert.equal(daysBetween("2026-11-16", "2026-11-16"), 0);
  });
});

describe("confirm (step 5)", () => {
  const cq = (kind: Consequence["kind"], username = "alice", switchesLeftAfter = 1, nextSwitchDateAfter = "2026-11-16"): Consequence => ({
    action: kind === "withdraw" ? "withdraw" : "declare",
    username,
    kind,
    switchesLeftAfter,
    nextSwitchDateAfter,
    today: "2026-11-16",
  });
  const view = (c: Consequence, current: string | null) => {
    const v = consequenceView(c, current, threads);
    return { record: t(v.record), account: v.account, date: v.date, switchLine: v.switchLine && t(v.switchLine), later: v.later.join(""), button: t(v.button) };
  };
  const declared = { record: "有一張有效的自然人憑證宣告了 Threads 的這個帳號：", account: "@alice", date: "2026-11-16" };
  const later = "之後可以用同一張卡片收回宣告，或更換帳號（一年最多兩次）。所有紀錄公開後無法刪除，這樣任何人才能驗證。";

  test("the rows of the table", () => {
    assert.deepEqual(view(cq("first"), null), { ...declared, switchLine: null, later, button: "宣告給 @alice" });
    assert.deepEqual(view(cq("refresh"), "alice"), { ...declared, switchLine: null, later, button: "再次過卡" });
    assert.deepEqual(view(cq("switch"), "bob"), { ...declared, switchLine: "這會用掉一次更換，之後還可以再更換 1 次。", later, button: "改成 @alice" });
    assert.deepEqual(view(cq("withdraw"), "alice"), {
      record: "有一張有效的自然人憑證收回了對 Threads 的這個帳號的宣告：",
      account: "@alice",
      date: "2026-11-16",
      switchLine: null,
      later: "之後可以用同一張卡片再宣告。所有紀錄公開後無法刪除，這樣任何人才能驗證。",
      button: "收回對 @alice 的宣告",
    });
  });

  test("declaring again the account withdrawn before: the row of a first declaration, no switch", () => {
    assert.deepEqual(view(cq("refresh"), null), { ...declared, switchLine: null, later, button: "宣告給 @alice" });
  });

  test("a switch that uses the last one: when the next one is", () => {
    assert.equal(view(cq("switch", "carol", 0, "2027-03-02"), "bob").switchLine, "這會用掉一次更換。下一次可以更換是 2027-03-02。");
  });
});

describe("done (step 6)", () => {
  const done = (o: Partial<Done>): Done => ({
    seq: 138,
    recordHash: "a".repeat(64),
    accountCards: 1,
    kind: "first",
    date: "2026-11-16",
    scopedId: "X",
    shortId: "7K2Q9F",
    username: "alice",
    record: {} as Done["record"],
    ...o,
  });
  const view = (d: Done, current: string | null = null) => {
    const v = doneView(d, current, threads);
    return { title: t(v.title), link: v.link, url: v.url, otherCards: v.otherCards && t(v.otherCards), record: t(v.record) + t(v.shortIdLine), withdraw: v.withdraw };
  };

  test("the titles", () => {
    assert.equal(view(done({})).title, "你換到一張島民證明了");
    assert.equal(view(done({ kind: "refresh" }), "alice").title, "島民證明更新好了");
    // Declaring again the account withdrawn before: a refresh by the roster rules, a new proof to the cardholder.
    assert.equal(view(done({ kind: "refresh" }), null).title, "你換到一張島民證明了");
    assert.equal(view(done({ kind: "switch", username: "carol.tw" }), "alice").title, "島民證明改成 @carol.tw 了");
    assert.equal(view(done({ kind: "withdraw" }), "alice").title, "已收回");
  });

  test("the only card that declares the account: the account's link", () => {
    assert.deepEqual(view(done({ accountCards: 1 })), {
      title: "你換到一張島民證明了",
      link: "iamreal.tw/threads/@alice",
      url: "https://iamreal.tw/threads/@alice",
      otherCards: null,
      record: "有一張有效的自然人憑證宣告了 Threads 的 @alice。這張卡片在 Threads 的島民編號開頭是 7K2Q9F。",
      withdraw: false,
    });
  });

  test("other cards declare the account: this card's link, and why", () => {
    const v = view(done({ accountCards: 3 }));
    assert.equal(v.link, "iamreal.tw/threads/@alice/7K2Q9F");
    assert.equal(v.url, "https://iamreal.tw/threads/@alice/7K2Q9F");
    assert.equal(v.otherCards, "已經有別的卡片宣告了 @alice，所以這個連結帶著你的島民編號，只指向你這一張。");
  });

  test("the record found in the card's state (no account_cards): this card's link, no sentence about other cards", () => {
    const v = view(done({ seq: null, recordHash: null, accountCards: null }));
    assert.equal(v.link, "iamreal.tw/threads/@alice/7K2Q9F");
    assert.equal(v.otherCards, null);
  });

  test("withdrawn: the record line of a withdrawal", () => {
    const v = view(done({ kind: "withdraw", accountCards: 0 }), "alice");
    assert.equal(v.withdraw, true);
    assert.equal(v.record, "有一張有效的自然人憑證收回了對 Threads 的 @alice 的宣告。這張卡片在 Threads 的島民編號開頭是 7K2Q9F。");
  });
});
