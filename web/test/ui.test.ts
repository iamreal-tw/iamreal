// Which sentence the screen shows for each stop and under which item of the
// lists; what each item of the lists shows; the card's list and each row's
// lines (step 4), the list to be signed (step 5), done and its link (step 6)
// (src/ui/messages.ts); what the page writes differently per platform
// (src/platforms.ts). The screens themselves run in the headless browser
// test (test/e2e/ui.ts).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PlatformRow } from "../src/api.ts";
import type { CardStatus, Consequence, ConsequenceRow, Done, Progress, SlotStatus, Stop } from "../src/flow.ts";
import { KNOWN_PLATFORMS, SITE_DOMAIN, cardPath, handle, presentationOf } from "../src/platforms.ts";
import { TEST_EXAMPLE } from "../src/presentations/test-example.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { parseUsernameFormat } from "iamreal-protocol/username-format.ts";
import { COPY, fill } from "../src/ui/copy.ts";
import {
  type AccountsView,
  type DeclaredView,
  type FillView,
  type ItemState,
  type Message,
  PROGRESS_ITEMS,
  READ_ITEMS,
  type Sentence,
  accountsView,
  beforeView,
  confirmView,
  daysBetween,
  doneView,
  editListView,
  firstNotDone,
  itemStates,
  onePlatform,
  progressButtons,
  readItemOf,
  rowLines,
  stopMessage,
  switchView,
} from "../src/ui/messages.ts";

const text = (m: Message): string => ("code" in m ? `[${m.code}]` : fill(m.template, m.values));
const t = (s: Sentence): string => fill(s.template, s.values);

// The server's display names differ from the page's own on purpose: the screen shows the page's (src/platforms.ts).
// The production build (which these tests import) has no definition of test-example: the screen names it by its ID.
const EXAMPLE_NAME = "test-example";
const THREADS: PlatformRow = { platform: "threads", displayName: "The server's Threads", format: parseUsernameFormat("[a-z0-9._]{1,30}")! };
const EXAMPLE: PlatformRow = { platform: "test-example", displayName: "The server's example", format: parseUsernameFormat("[a-z0-9-]{1,20}")! };

describe("what the page writes per platform, and the scope string", () => {
  test("Threads: the name, the prefix, the format hint, the profile page", () => {
    const p = presentationOf("threads")!;
    assert.equal(p.name, "Threads");
    assert.equal(handle("threads", "alice"), "@alice");
    assert.equal(COPY.formats[p.formatHint as "threads"], "帳號只能用英文小寫、數字、句點和底線，最多 30 個字。");
    assert.equal(p.profileUrl!("alice"), "https://www.threads.com/@alice");
  });
  test("the production build knows Threads only; test-example is in the headless tests' build", () => {
    assert.deepEqual([...KNOWN_PLATFORMS], ["threads"]);
    assert.equal(presentationOf("test-example"), null);
    // A platform the page does not know: the account as it is.
    assert.equal(handle("test-example", "a-b"), "a-b");
    assert.equal(TEST_EXAMPLE.name, "Example (no real service)");
    assert.equal(TEST_EXAMPLE.formatHint, null);
    assert.equal(TEST_EXAMPLE.profileUrl, null);
  });
  test("the card's page and the scope strings: one for the public proof log, none per platform", () => {
    assert.equal(SITE_DOMAIN, "iamreal.tw");
    assert.equal(cardPath("7K2Q9FM4XD"), "p/7K2Q9FM4XD");
    assert.equal(scopeOf("production"), "iamreal:public:0_______________");
    assert.equal(scopeOf("test"), "iamreal-test:public:0__________");
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
    // Also a platform table the device cannot read (config) and a card's state it cannot read (card-state).
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
    [{ code: "server", server: "root", status: 400 }, "這次過卡沒有被接受（代碼 root），證明紀錄沒有變動。", 4],
    [{ code: "server", server: "challenge_used", status: 400 }, "這次過卡沒有被接受（代碼 challenge_used），證明紀錄沒有變動。", 4],
    [{ code: "server", server: "platform", status: 400 }, "這次過卡沒有被接受（代碼 platform），證明紀錄沒有變動。", 4],
    // The server's operating policy refused a switch the rules allow (none by default): its own sentence.
    [{ code: "server", server: "switch_restricted", status: 403 }, "這個平台目前不接受更多次更換。", 4],
    [{ code: "server", server: "crl_stale", status: 503 }, "內政部的廢止清冊超過 3 天沒有更新，現在不能過卡。", 4],
    // The operator stopped taking card proofs, or the server stopped by itself (docs/api/card-proof.md, paused).
    [{ code: "server", server: "paused", status: 503 }, COPY.stops.paused, 4],
    // The record rules, when the card's state changed after it was asked.
    [{ code: "server", server: "daily_limit", status: 400 }, "這張卡片今天已經過卡 3 次，明天才能再過卡。", 4],
    [{ code: "server", server: "switch_limit", status: 400 }, "清單裡有一個平台不能再更換，整份清單都沒有記下，證明紀錄沒有變動。請再讀一次卡片。", 4],
    [{ code: "server", server: "empty", status: 400 }, "這張卡片現在沒有宣告任何帳號，沒有可以收回的，證明紀錄沒有變動。請再讀一次卡片。", 4],
    [{ code: "card", card: "card_error", detail: "pin_characters" }, "這一頁不支援含有 +、% 或非英數符號的 PIN。請先到內政部憑證管理中心的網站變更 PIN。", 2],
    [{ code: "card", card: "card_error", detail: "no_pin" }, "讀卡時發生錯誤（代碼 no_pin）。請重新插卡再試一次。", 2],
    [{ code: "username", platform: "threads" }, "帳號只能用英文小寫、數字、句點和底線，最多 30 個字。", null],
    // No hint in the copy for a platform the page has nothing of its own for: the code.
    [{ code: "username", platform: "test-example" }, "帳號的格式不對。請照平台上顯示的帳號填。", null],
    [{ code: "state" }, "[state]", null],
    [{ code: "idle" }, "超過 5 分鐘沒有完成，為了不讓 PIN 留在這一頁太久，已經回到開頭。請再讀一次卡片。", null],
    [{ code: "blocked", reason: "empty" }, "請至少填一個帳號。", null],
    [{ code: "blocked", reason: "daily_limit" }, "這張卡片今天已經過卡 3 次，明天才能再過卡。", null],
    // A switch the row says cannot be made: no sentence in the copy for typing one anyway.
    [{ code: "blocked", reason: "switch_limit", platform: "threads" }, "這一列不能改成別的帳號。請填回原本的帳號，或清空。", null],
    // The date changed since step 5 (midnight): nothing signed, back to the beginning.
    [{ code: "date_changed" }, "日期換了一天，這次改動的結果會和剛才畫面說的不同，所以卡片沒有簽，證明紀錄也沒有記下任何東西。請回到開頭重新過卡。", null],
  ];
  for (const [stop, want, item] of cases) {
    test(JSON.stringify(stop, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), () => {
      assert.equal(text(stopMessage(stop)), want);
      assert.equal(readItemOf(stop), item);
    });
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

  test("paused when sending: its own sentence, no retry; only 回到開頭", () => {
    const stop = { code: "server", server: "paused", status: 503, requestId: "ab" } as const;
    const m = stopMessage(stop, true);
    assert.equal(text(m), COPY.stops.paused);
    assert.ok(!("code" in m) && !m.retry);
    assert.equal(m.requestId, "ab");
    for (const phase of ["submit_failed", "stopped", "chosen"]) assert.deepEqual(progressButtons(phase, stop), ["restart"], phase);
  });

  test("every server error carries its request ID", () => {
    for (const server of ["paused", "root", "challenge_unknown", "challenge_used", "crl_stale", "daily_limit", "switch_limit", "empty", "switch_restricted", "malformed_response", "not_found"]) {
      assert.equal(stopMessage({ code: "server", server, status: 400, requestId: "ab" }).requestId, "ab", server);
    }
  });
});

describe("the lists of steps 2 and 5", () => {
  const states = (seen: Progress[], o: { running?: boolean; stoppedAt?: number | null; allDone?: boolean } = {}): ItemState[] =>
    itemStates(READ_ITEMS, new Set(seen), { running: o.running ?? true, stoppedAt: o.stoppedAt ?? null, allDone: o.allDone });

  test("the labels are the copy's, in its order", () => {
    assert.deepEqual(
      READ_ITEMS.map((i) => (COPY.read as Record<string, string>)[i.key]),
      ["連上內政部的元件", "找到讀卡機和卡片", "讀取卡片上的憑證", "檢查憑證", "連上島民證明的伺服器", "下載內政部的廢止清冊，確認憑證沒有被廢止"],
    );
    assert.deepEqual(
      PROGRESS_ITEMS.map((i) => (COPY.progress as Record<string, string>)[i.key]),
      ["連上島民證明的伺服器", "卡片簽章", "正在這台裝置計算，產生零知識證明，大約 10 到 30 秒", "送出"],
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
    // The date changed since step 5: nothing was signed; back to the beginning only.
    assert.deepEqual(progressButtons("stopped", { code: "date_changed" }), ["restart"]);
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

const TODAY = "2026-11-16";

/** A slot as the engine reports it (CardStatus.slots). */
function slot(row: PlatformRow | null, o: Partial<SlotStatus> = {}): SlotStatus {
  const switchCount = o.switchCount ?? 0;
  return {
    platform: row?.platform ?? "x-new",
    row,
    current: null,
    lastDeclared: null,
    ...o,
    switchCount,
    switchesLeft: 5 - switchCount,
  };
}

function status(slots: SlotStatus[], o: Partial<CardStatus> = {}): CardStatus {
  return {
    scopedId: "7K2Q9FM4XD" + "0".repeat(42),
    shortId: "7K2Q9FM4XD",
    lastCardProof: "2026-11-04",
    slots,
    tablePlatforms: slots.filter((s) => s.row !== null).map((s) => s.platform),
    accounts: slots.flatMap((s) => (s.current === null ? [] : [{ platform: s.platform, username: s.current }])),
    dailyLimit: false,
    today: TODAY,
    count: 1,
    ...o,
  };
}

const declared = (u: string, o: Partial<SlotStatus> = {}) => slot(THREADS, { current: u, lastDeclared: u, ...o });
const lines = (s: SlotStatus) => rowLines(s).map(t);

describe("your accounts (step 4)", () => {
  const leadOf = (v: { lead: Message[][] }) => v.lead.map((l) => l.map(text).join(""));
  const fillOf = (v: AccountsView): FillView => {
    assert.equal(v.mode, "fill");
    return v as FillView;
  };
  const declaredOf = (v: AccountsView): DeclaredView => {
    assert.equal(v.mode, "declared");
    return v as DeclaredView;
  };

  test("one platform, never declared: the field alone, the preview note; no rules of switching", () => {
    const v = fillOf(accountsView(status([slot(THREADS)], { lastCardProof: null })));
    assert.equal(v.state, "never");
    assert.equal(t(v.title), "你的 Threads 帳號");
    assert.deepEqual(leadOf(v), ["這張卡片還沒有宣告過帳號。", "填上你要宣告的 Threads 帳號。"]);
    assert.deepEqual(
      v.rows.map((r) => [r.platform, r.name, r.prefix, r.current, r.editable, r.preview, r.lines.map(t)]),
      [["threads", "Threads", "@", "", true, true, []]],
    );
    assert.deepEqual(
      v.notes.map((n) => n.map(t).join("")),
      ["預覽會在新分頁開平台上這個帳號的頁面，讓你確認沒有打錯。"],
    );
    assert.equal(v.dailyLimit, null);
  });

  test("one platform, everything withdrawn: the same screen, with what was withdrawn and the switches left under the field", () => {
    const v = fillOf(accountsView(status([slot(THREADS, { lastDeclared: "bob", switchCount: 1 })])));
    assert.equal(v.state, "nothing");
    assert.deepEqual(leadOf(v), ["這張卡片目前沒有宣告任何帳號。", "填上你要宣告的 Threads 帳號。"]);
    assert.deepEqual(v.rows[0]!.lines.map(t), ["上一次宣告的是 @bob，已經收回。填回 @bob 不算更換。", "更換過 1 次，還可以更換 4 次。"]);
    assert.deepEqual(
      v.notes.map((n) => n.map(t).join("")),
      ["預覽會在新分頁開平台上這個帳號的頁面，讓你確認沒有打錯。"],
    );
  });

  test("one platform, declared: the account, the last card proof, 更新島民證明 and the two other actions", () => {
    const v = declaredOf(accountsView(status([declared("alice", { switchCount: 1 })])));
    assert.equal(v.state, "declared");
    assert.equal(t(v.title), "你的 Threads 帳號");
    assert.deepEqual(
      v.current.map((c) => [c.name, c.account, c.raw, c.line === null ? null : t(c.line)]),
      [[null, "@alice", false, null]],
    );
    assert.equal(text(v.last), "上次過卡是 12 天前");
    assert.equal(t(v.refreshNote), "宣告帳號不變，把島民證明上的日期更新成今天。");
    assert.equal(v.switchAccount, true);
    assert.equal(t(v.withdraw!), "收回對 @alice 的宣告");
    assert.equal(v.editList, false);
    assert.equal(v.dailyLimit, null);
    // The last card proof today: 今天, not 0 天前.
    assert.equal(text(declaredOf(accountsView(status([declared("alice")], { lastCardProof: TODAY }))).last), "上次過卡是今天");
  });

  test("more than one platform, declared: the accounts by platform, 修改帳號清單 in place of switching and withdrawing", () => {
    const v = declaredOf(accountsView(status([slot(EXAMPLE), declared("alice"), slot(null, { platform: "x-new", current: "a-b", lastDeclared: "a-b" })])));
    assert.equal(t(v.title), "你的帳號");
    assert.deepEqual(
      v.current.map((c) => [c.name, c.account, c.raw, c.line === null ? null : t(c.line)]),
      [
        ["Threads", "@alice", false, null],
        ["x-new", "a-b", true, "這一頁還不認得這個平台。這個帳號會原樣保留，在這裡不能修改。"],
      ],
    );
    assert.deepEqual([v.switchAccount, v.withdraw, v.editList], [false, null, true]);
  });

  test("more than one platform, 修改帳號清單: one row per platform with its line, how to change the list", () => {
    const v = editListView(status([slot(EXAMPLE), declared("alice", { switchCount: 1 })]));
    assert.equal(v.state, "declared");
    assert.equal(t(v.title), "你的帳號");
    assert.deepEqual(leadOf(v), ["這是這張卡片目前宣告的帳號。"]);
    assert.deepEqual(
      v.rows.map((r) => [r.current, r.lines.map(t)]),
      [
        ["", ["還沒有宣告過。"]],
        ["alice", ["更換過 1 次，還可以更換 4 次。"]],
      ],
    );
    assert.deepEqual(
      v.notes.map((n) => n.map(t).join("")),
      ["填上空白的是新宣告，清空是收回，改成別的帳號是更換。一張卡終身最多只能更換宣告的帳號 5 次。", "預覽會在新分頁開平台上這個帳號的頁面，讓你確認沒有打錯。"],
    );
  });

  test("more than one platform, never declared or everything withdrawn: the list to fill, as before", () => {
    const never = fillOf(accountsView(status([slot(EXAMPLE), slot(THREADS)], { lastCardProof: null })));
    assert.deepEqual(leadOf(never), ["這張卡片還沒有宣告過帳號。", "填上你要宣告的帳號，至少一個。沒有要宣告的平台留空白。"]);
    assert.deepEqual(
      never.rows.map((r) => [r.platform, r.name, r.prefix, r.editable, r.preview, r.lines.map(t)]),
      [
        ["test-example", EXAMPLE_NAME, "", true, false, ["還沒有宣告過。"]],
        ["threads", "Threads", "@", true, true, ["還沒有宣告過。"]],
      ],
    );
    assert.deepEqual(
      never.notes.map((n) => n.map(t).join("")),
      ["一張卡片在每個平台只能宣告一個帳號，之後改成別的帳號是更換。一張卡終身最多只能更換宣告的帳號 5 次。", "預覽會在新分頁開平台上這個帳號的頁面，讓你確認沒有打錯。"],
    );
    const nothing = fillOf(accountsView(status([slot(EXAMPLE), slot(THREADS, { lastDeclared: "bob" })])));
    assert.deepEqual(leadOf(nothing), ["這張卡片目前沒有宣告任何帳號。", "填上你要宣告的帳號，至少一個。沒有要宣告的平台留空白。"]);
    assert.deepEqual(nothing.notes[0]!.map(t).join(""), "填上空白的是新宣告，清空是收回，改成別的帳號是更換。一張卡終身最多只能更換宣告的帳號 5 次。");
  });

  test("改成別的帳號: the account now, an empty field, what it does and the switches left after it", () => {
    const v = switchView(status([declared("alice", { switchCount: 1 })]));
    assert.equal(t(v.title), "你的 Threads 帳號");
    assert.equal(t(v.intro), "這張卡片目前宣告 @alice。");
    assert.deepEqual([v.row!.platform, v.row!.current, v.row!.editable, v.row!.preview, v.row!.lines], ["threads", "", true, true, []]);
    assert.deepEqual(v.lines.map(t), ["改了之後，@alice 不再是這張卡片宣告的帳號。", "一張卡終身最多更換 5 次，這次之後還可以更換 3 次。"]);
    assert.equal(t(v.previewNote!), "預覽會在新分頁開平台上這個帳號的頁面，讓你確認沒有打錯。");
    // The last one.
    assert.deepEqual(switchView(status([declared("alice", { switchCount: 4 })])).lines.map(t)[1], "用掉最後一次更換。這次之後，這個平台不能再更換。");
    // Used up: no field, the reason only.
    const used = switchView(status([declared("alice", { switchCount: 5 })]));
    assert.equal(used.row, null);
    assert.deepEqual(used.lines.map(t), ["已經更換 5 次，這個平台不能再更換。"]);
    assert.equal(used.previewNote, null);
  });

  test("the line under each row, by its counts", () => {
    assert.deepEqual(lines(slot(THREADS)), ["還沒有宣告過。"]);
    assert.deepEqual(lines(declared("alice")), ["還沒有更換過，還可以更換 5 次。"]);
    assert.deepEqual(lines(declared("alice", { switchCount: 2 })), ["更換過 2 次，還可以更換 3 次。"]);
    // Withdrawn: the account withdrawn first, then the count.
    assert.deepEqual(lines(slot(THREADS, { lastDeclared: "bob", switchCount: 1 })), ["上一次宣告的是 @bob，已經收回。填回 @bob 不算更換。", "更換過 1 次，還可以更換 4 次。"]);
    // 3 or 4 switches: the rest of the 5, on the web too.
    assert.deepEqual(lines(declared("alice", { switchCount: 3 })), ["更換過 3 次，還可以更換 2 次。"]);
    assert.deepEqual(lines(declared("alice", { switchCount: 4 })), ["更換過 4 次，還可以更換 1 次。"]);
    // 5: used up; the row can be cleared.
    assert.deepEqual(lines(declared("alice", { switchCount: 5 })), ["已經更換 5 次，這個平台不能再更換。", "這一列不能改成別的帳號，可以清空。"]);
    assert.deepEqual(lines(slot(THREADS, { lastDeclared: "bob", switchCount: 5 })), ["上一次宣告的是 @bob，已經收回。填回 @bob 不算更換。", "已經更換 5 次，這個平台不能再更換。", "這個平台只能填回 @bob。"]);
  });

  test("a platform the device does not know: a row as the server sent it, which cannot be changed", () => {
    const v = editListView(status([slot(null, { platform: "test-example", current: "alice-b", lastDeclared: "alice-b" }), declared("alice")]));
    const r = v.rows[0]!;
    assert.deepEqual([r.platform, r.name, r.prefix, r.current, r.editable, r.preview], ["test-example", "test-example", "", "alice-b", false, false]);
    assert.deepEqual(r.lines.map(t), ["這一頁還不認得這個平台。這個帳號會原樣保留，在這裡不能修改。"]);
  });

  test("3 records today: the accounts as they are, no action, the sentence in place of the buttons", () => {
    const v = declaredOf(accountsView(status([slot(EXAMPLE, { current: "a-b", lastDeclared: "a-b" }), declared("alice")], { lastCardProof: TODAY, dailyLimit: true })));
    assert.equal(text(v.last), "上次過卡是今天");
    assert.deepEqual(v.current.map((c) => [c.name, c.account]), [["test-example", "a-b"], ["Threads", "@alice"]]);
    assert.deepEqual([v.switchAccount, v.withdraw, v.editList], [false, null, false]);
    assert.equal(t(v.dailyLimit!), "這張卡片今天已經過卡 3 次，明天才能再過卡。");
    // One platform: the title names it.
    assert.equal(t(accountsView(status([declared("alice")], { lastCardProof: TODAY, dailyLimit: true })).title), "你的 Threads 帳號");
    // Everything withdrawn, 3 records today: the rows as they are, nothing to type in.
    const none = fillOf(accountsView(status([slot(THREADS, { lastDeclared: "bob" })], { lastCardProof: TODAY, dailyLimit: true })));
    assert.ok(none.rows.every((r) => !r.editable && !r.preview && r.lines.length === 0));
    assert.deepEqual(none.notes, []);
    assert.equal(t(none.dailyLimit!), "這張卡片今天已經過卡 3 次，明天才能再過卡。");
  });

  test("one platform: one platform of the table the device knows, and no account on a platform it does not know", () => {
    // The platform's name: the device's own, not the server's display name.
    assert.equal(onePlatform(status([slot(THREADS)])), "Threads");
    assert.equal(onePlatform(status([declared("alice")])), "Threads");
    assert.equal(onePlatform(status([slot(EXAMPLE), slot(THREADS)])), null);
    // An account on a platform the device does not know counts as more than one.
    assert.equal(onePlatform(status([slot(null, { platform: "test-example", current: "a-b", lastDeclared: "a-b" }), declared("alice")])), null);
    // The table's platforms count, not the rows the card's state has an entry for.
    assert.equal(onePlatform(status([slot(THREADS)], { tablePlatforms: ["test-example", "threads"] })), null);
    assert.equal(onePlatform(status([], { tablePlatforms: [] })), null);
  });

  test("step 1: by the platforms the device knows; one says nothing of the proof, more than one say they are listed together", () => {
    // The production build knows Threads only.
    const one = beforeView();
    assert.deepEqual([one.oneProof, one.listedTogether], [null, false]);
    assert.deepEqual(beforeView(new Set(["threads"])), one);
    const more = beforeView(new Set(["test-example", "threads"]));
    assert.equal(t(more.oneProof!), "一張自然人憑證換一張島民證明，上面列出這張卡片宣告的帳號，每個平台最多一個。");
    assert.equal(more.listedTogether, true);
  });

  test("days between two dates", () => {
    assert.equal(daysBetween("2026-11-04", "2026-11-16"), 12);
    assert.equal(daysBetween("2025-11-16", "2026-11-16"), 365);
  });
});

/** A row of a consequence (Consequence.rows). */
function crow(o: Partial<ConsequenceRow> & Pick<ConsequenceRow, "kind" | "username">): ConsequenceRow {
  return { platform: "threads", row: THREADS, current: null, previous: null, switchesLeftAfter: null, ...o };
}
function consequence(rows: ConsequenceRow[], o: Partial<Consequence> = {}): Consequence {
  return { accounts: rows.filter((r) => r.kind !== "withdraw").map((r) => ({ platform: r.platform, username: r.username })), rows, firstRecord: false, today: TODAY, ...o };
}

/** Step 5's view: with one platform, its name; with more, the names of the test's table. */
const cv = (cq: Consequence, single: string | null = null) => confirmView(cq, single, single !== null ? [single] : ["Example", "Threads"]);

describe("confirm (step 5)", () => {
  const rowsOf = (cq: Consequence) => cv(cq).rows.map((r) => [r.name, r.id, r.account, r.lines.map(t)]);
  const pointsOf = (v: { points: Sentence[] }) => v.points.map(t);

  test("each row: the platform's name and ID, the account, what happens", () => {
    const cq = consequence([
      crow({ platform: "test-example", row: EXAMPLE, kind: "first", username: "a-b" }),
      crow({ kind: "switch", username: "carol.tw", current: "alice", previous: "alice", switchesLeftAfter: 1 }),
    ]);
    assert.deepEqual(rowsOf(cq), [
      [EXAMPLE_NAME, "test-example", "a-b", ["新宣告"]],
      ["Threads", "threads", "@carol.tw", ["更換，原本是 @alice。", "用掉一次更換，不會恢復。之後還可以更換 1 次。"]],
    ]);
    const v = confirmView(cq, null, ["Example", "Threads"]);
    assert.equal(v.intro, "按下後，證明紀錄會公開記下這張卡片的帳號清單：");
    assert.equal(v.listedTogether, true);
    assert.equal(v.withdrawStays, false);
    // Each platform of the screens named, where one platform would be.
    assert.deepEqual(pointsOf(v), [
      "證明紀錄不包含姓名、生日、身分證字號和卡號。Example、Threads、政府、我們都查不出這是誰的卡片。",
      "之後拿著這張卡片和 PIN 的人，都能查詢、更新、收回或更換這張證明宣告的 Example、Threads 帳號。所有紀錄公開後無法刪除，這樣任何人才能驗證。",
    ]);
    assert.equal(v.button, "宣告這份清單");
    assert.equal(v.date, TODAY);
  });

  test("the words that no record can be deleted are their own part of the sentence (shown in bold)", () => {
    const v = cv(consequence([crow({ kind: "first", username: "alice" })]), "Threads");
    const later = v.points[1]!;
    assert.equal(later.values.cannot_delete, "所有紀錄公開後無法刪除");
  });

  test("the kinds of a row", () => {
    const one = (r: ConsequenceRow) => rowsOf(consequence([r]))[0]![3];
    assert.deepEqual(one(crow({ kind: "refresh", username: "alice", current: "alice" })), ["不變"]);
    assert.deepEqual(one(crow({ kind: "refresh", username: "bob", current: null })), ["再次宣告，不算更換"]);
    assert.deepEqual(one(crow({ kind: "withdraw", username: "alice", current: "alice" })), ["收回"]);
    // Withdrawn before, another account: a switch from the account withdrawn.
    assert.deepEqual(one(crow({ kind: "switch", username: "carol", current: null, previous: "bob", switchesLeftAfter: 4 })), ["更換，原本是 @bob。", "用掉一次更換，不會恢復。之後還可以更換 4 次。"]);
    // The third and the fourth: the switches left of the 5.
    assert.deepEqual(one(crow({ kind: "switch", username: "carol", current: "bob", previous: "bob", switchesLeftAfter: 2 })), ["更換，原本是 @bob。", "用掉一次更換，不會恢復。之後還可以更換 2 次。"]);
    assert.deepEqual(one(crow({ kind: "switch", username: "carol", current: "bob", previous: "bob", switchesLeftAfter: 1 })), ["更換，原本是 @bob。", "用掉一次更換，不會恢復。之後還可以更換 1 次。"]);
    // The fifth.
    assert.deepEqual(one(crow({ kind: "switch", username: "carol", current: "bob", previous: "bob", switchesLeftAfter: 0 })), ["更換，原本是 @bob。", "用掉最後一次更換。這次之後，這個平台不能再更換。"]);
    // A platform the device does not know: the account as the server sent it, unchanged.
    assert.deepEqual(rowsOf(consequence([crow({ platform: "x-new", row: null, kind: "refresh", username: "alice-b", current: "alice-b" })])), [["x-new", "x-new", "alice-b", ["不變"]]]);
  });

  test("the button by the whole list: 更新島民證明 when nothing changes", () => {
    assert.equal(cv(consequence([crow({ kind: "refresh", username: "alice", current: "alice" })])).button, "更新島民證明");
    assert.equal(cv(consequence([crow({ kind: "refresh", username: "alice", current: "alice" })]), "Threads").button, "更新島民證明");
    assert.equal(cv(consequence([crow({ kind: "refresh", username: "bob", current: null })])).button, "宣告這份清單");
    assert.equal(cv(consequence([crow({ kind: "refresh", username: "alice", current: "alice" }), crow({ platform: "test-example", row: EXAMPLE, kind: "withdraw", username: "a-b", current: "a-b" })])).button, "宣告這份清單");
  });

  test("more than one platform, an account withdrawn: its row, and that the record stays", () => {
    const cq = consequence([crow({ platform: "test-example", row: EXAMPLE, kind: "withdraw", username: "a-b", current: "a-b" }), crow({ kind: "refresh", username: "alice", current: "alice" })]);
    const v = cv(cq);
    assert.deepEqual(rowsOf(cq)[0], [EXAMPLE_NAME, "test-example", "a-b", ["收回"]]);
    assert.equal(v.withdrawStays, true);
    assert.equal(v.listedTogether, true);
  });

  test("one platform: that it is made public is in the first sentence; the platform named in the two points", () => {
    const one = cv(consequence([crow({ kind: "first", username: "alice" })]), "Threads");
    assert.equal(one.listedTogether, false);
    assert.equal(one.intro, "按下後，證明紀錄會記下新的證明並公開給所有人：");
    assert.deepEqual(pointsOf(one), [
      "證明紀錄不包含姓名、生日、身分證字號和卡號。Threads、政府、我們都查不出這是誰的卡片。",
      "之後拿著這張卡片和 PIN 的人，都能查詢、更新、收回或更換這張證明宣告的 Threads 帳號。所有紀錄公開後無法刪除，這樣任何人才能驗證。",
    ]);
    assert.equal(one.button, "宣告這個帳號");
    // A switch or declared again: 宣告這個帳號.
    assert.equal(cv(consequence([crow({ kind: "switch", username: "bob", current: "alice", previous: "alice", switchesLeftAfter: 4 })]), "Threads").button, "宣告這個帳號");
    assert.equal(cv(consequence([crow({ kind: "refresh", username: "bob", current: null })]), "Threads").button, "宣告這個帳號");
  });

  test("everything withdrawn: the other first sentence, the three points, the button naming the account (one platform)", () => {
    const one = cv(consequence([crow({ kind: "withdraw", username: "alice", current: "alice" })]), "Threads");
    assert.equal(one.intro, "按下後，證明紀錄會公開記下這張卡片不再宣告任何帳號：");
    assert.equal(one.listedTogether, false);
    assert.equal(one.withdrawStays, false);
    assert.deepEqual(pointsOf(one), [
      "歷史證明紀錄無法刪除，依然看得出這張卡片過去曾宣告過的帳號。",
      "證明紀錄不包含姓名、生日、身分證字號和卡號。Threads、政府、我們都查不出這是誰的卡片。",
      "之後拿著這張卡片和 PIN 的人，都能查詢或再宣告。",
    ]);
    assert.equal(one.button, "收回對 @alice 的宣告");
    // More than one platform: the same points, 收回所有帳號.
    const more = confirmView(consequence([crow({ kind: "withdraw", username: "alice", current: "alice" }), crow({ platform: "test-example", row: EXAMPLE, kind: "withdraw", username: "a-b", current: "a-b" })]), null, ["Example", "Threads"]);
    assert.deepEqual([more.listedTogether, more.withdrawStays, more.button], [false, false, "收回所有帳號"]);
    assert.equal(more.points.length, 3);
  });
});

describe("after the submission: hang it (step 6), done and share (the last step)", () => {
  const ID = "7K2Q9FM4XD" + "0".repeat(42);
  function done(expected: ConsequenceRow[], kinds: Done["kinds"], o: Partial<Done> = {}): Done {
    const accounts = expected.filter((r) => r.kind !== "withdraw").map((r) => ({ platform: r.platform, username: r.username }));
    return {
      seq: 2,
      recordHash: "0".repeat(64),
      ordinal: 128,
      kinds,
      expected,
      mismatches: [],
      firstRecord: false,
      date: TODAY,
      scopedId: ID,
      shortId: "7K2Q9FM4XD",
      accounts,
      record: { scope_string: scopeOf("test"), scoped_id: ID, accounts, challenge: `${TODAY}.x`, issuer: "G3", smt_root: "", circuit: "", proof: "" },
      ...o,
    };
  }
  const k = (platform: string, kind: ConsequenceRow["kind"], username: string, accountCards: number | null = 1) => ({ platform, kind, username, accountCards });

  test("the last step's title: by what this card proof did", () => {
    const title = (expected: ConsequenceRow[], kinds: Done["kinds"], single: string | null, o: Partial<Done> = {}): string => t(doneView(done(expected, kinds, o), single).title);
    const first = [crow({ kind: "first", username: "alice" })];
    assert.equal(title(first, [k("threads", "first", "alice")], "Threads", { firstRecord: true }), "恭喜你完成島民證明");
    assert.equal(title(first, [k("threads", "first", "alice")], null, { firstRecord: true }), "恭喜你完成島民證明");
    const same = [crow({ kind: "refresh", username: "alice", current: "alice" })];
    assert.equal(title(same, [k("threads", "refresh", "alice")], "Threads"), "島民證明已更新");
    assert.equal(title(same, [k("threads", "refresh", "alice")], null), "島民證明已更新");
    // Declared again after everything was withdrawn, the same account or a new one: with one platform, like a new declaration.
    const back = [crow({ kind: "refresh", username: "alice", current: null })];
    assert.equal(title(back, [k("threads", "refresh", "alice")], "Threads"), "恭喜你完成島民證明");
    assert.equal(title(first, [k("threads", "first", "alice")], "Threads"), "恭喜你完成島民證明");
    assert.equal(title(back, [k("threads", "refresh", "alice")], null), "島民證明已更新");
    // A switch: with one platform, the account it is now.
    const sw = [crow({ kind: "switch", username: "carol.tw", current: "alice", previous: "alice", switchesLeftAfter: 4 })];
    assert.equal(title(sw, [k("threads", "switch", "carol.tw")], "Threads"), "島民證明換成 @carol.tw 了");
    assert.equal(title(sw, [k("threads", "switch", "carol.tw")], null), "島民證明已更新");
    const all = [crow({ kind: "withdraw", username: "alice", current: "alice" })];
    assert.equal(title(all, [k("threads", "withdraw", "alice", 0)], "Threads"), "已全部收回");
    assert.equal(title(same, null, "Threads"), "證明紀錄已經記下這次過卡");
  });

  test("step 6 is short for a card proof again with one platform: the question, the link, the card's page", () => {
    const same = [crow({ kind: "refresh", username: "alice", current: "alice" })];
    const v = doneView(done(same, [k("threads", "refresh", "alice")]), "Threads");
    assert.equal(v.short, true);
    assert.equal(t(v.stillThere!), "你的 Threads 個人檔案上，還有這個連結嗎？");
    assert.equal(t(v.why), "在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。");
    // The whole step: anything else, more than one platform, the kinds not read, what was recorded differs.
    const sw = [crow({ kind: "switch", username: "carol.tw", current: "alice", previous: "alice", switchesLeftAfter: 4 })];
    assert.equal(doneView(done(sw, [k("threads", "switch", "carol.tw")]), "Threads").short, false);
    assert.equal(doneView(done(same, [k("threads", "refresh", "alice")]), null).short, false);
    assert.equal(doneView(done(same, null), "Threads").short, false);
    assert.equal(doneView(done(same, [k("threads", "switch", "alice")], { mismatches: ["threads"] }), "Threads").short, false);
    assert.equal(doneView(done(sw, [k("threads", "switch", "carol.tw")]), "Threads").stillThere, null);
  });

  test("the last step: the card's ordinal, then the invitation to share; without an ordinal, the invitation alone", () => {
    const expected = [crow({ kind: "first", username: "alice" })];
    assert.equal(t(doneView(done(expected, [k("threads", "first", "alice")], { ordinal: 1284 })).ordinal!), "這是第 1,284 張島民證明。");
    assert.equal(doneView(done(expected, [k("threads", "first", "alice")], { ordinal: null })).ordinal, null);
  });

  test("the card's page is the link; the card lists the list after the record; the rows of the record", () => {
    const expected = [crow({ platform: "test-example", row: EXAMPLE, kind: "first", username: "a-b" }), crow({ kind: "refresh", username: "alice", current: "alice" })];
    const v = doneView(done(expected, [k("test-example", "first", "a-b"), k("threads", "refresh", "alice")]));
    assert.equal(v.link, "iamreal.tw/p/7K2Q9FM4XD");
    assert.equal(v.url, "https://iamreal.tw/p/7K2Q9FM4XD");
    assert.deepEqual(v.card, [
      { name: EXAMPLE_NAME, account: "a-b", raw: false },
      { name: "Threads", account: "@alice", raw: false },
    ]);
    assert.equal(t(v.record!), "有一張有效的自然人憑證宣告了這份帳號清單：");
    assert.deepEqual(
      v.rows.map((r) => [r.name, r.account, t(r.kind!), r.mismatch]),
      [
        [EXAMPLE_NAME, "a-b", "新宣告", false],
        ["Threads", "@alice", "不變", false],
      ],
    );
    assert.equal(t(v.shortIdLine), "這張卡片的島民編號開頭是 7K2Q9FM4XD。");
    assert.equal(v.newCard, false);
    assert.equal(v.withdrawnLink, false);
    assert.deepEqual(v.otherCards, []);
  });

  test("step 6's heading and why: every account's profile, or with one platform this platform's; the card names the platforms only with more than one", () => {
    const expected = [crow({ kind: "first", username: "alice" })];
    const several = doneView(done(expected, [k("threads", "first", "alice")]), null);
    assert.deepEqual([t(several.hangTitle), t(several.why)], [COPY.hang.title, COPY.done.anyone]);
    assert.deepEqual(several.card, [{ name: "Threads", account: "@alice", raw: false }]);
    const one = doneView(done(expected, [k("threads", "first", "alice")]), "Threads");
    assert.deepEqual([t(one.hangTitle), t(one.why)], ["把證明掛上你的 Threads 個人檔案", "在個人檔案添加證明連結，別人才知道這個帳號承認這張證明。"]);
    assert.deepEqual(one.card, [{ name: null, account: "@alice", raw: false }]);
    assert.equal(t(one.recordedOn), "2026-11-16 記進了證明紀錄。");
  });

  test("where the links go: the QR code to /hang/ on the build's site, 打開你的島民證明 to the card's page on this one, each account's profile, Threads' page to post the link from", () => {
    const expected = [crow({ platform: "test-example", row: EXAMPLE, kind: "first", username: "a-b" }), crow({ kind: "first", username: "alice" })];
    const v = doneView(done(expected, [k("test-example", "first", "a-b"), k("threads", "first", "alice")]));
    assert.equal(v.hangUrl, "https://iamreal.tw/hang/7K2Q9FM4XD");
    assert.equal(v.proofPath, "/p/7K2Q9FM4XD");
    // test-example has no public page.
    assert.deepEqual(v.profiles.map((p) => [t(p.text), p.url]), [["打開 @alice 的 Threads 個人檔案", "https://www.threads.com/@alice"]]);
    // The sentence with the card's ordinal, and on the line under it the card's page.
    const text = encodeURIComponent("我剛剛換了第 128 張島民證明，宣告本帳號背後是一名台灣人。\nhttps://iamreal.tw/p/7K2Q9FM4XD");
    assert.deepEqual(
      v.shares.map((sh) => [t(sh.button), sh.url]),
      [["分享到 Threads", `https://www.threads.com/intent/post?text=${text}`]],
    );
    assert.equal(v.showRecord, false);
  });

  test("the text suggested for sharing: the card's ordinal, with a comma every three digits; without an ordinal, the sentence without a number", () => {
    const expected = [crow({ kind: "first", username: "alice" })];
    const shared = (ordinal: number | null): string => {
      const url = new URL(doneView(done(expected, [k("threads", "first", "alice")], { ordinal })).shares[0]!.url);
      assert.deepEqual([...url.searchParams.keys()], ["text"]);
      const [sentence, link] = url.searchParams.get("text")!.split("\n");
      assert.equal(link, "https://iamreal.tw/p/7K2Q9FM4XD");
      return sentence!;
    };
    assert.equal(shared(1), "我剛剛換了第 1 張島民證明，宣告本帳號背後是一名台灣人。");
    assert.equal(shared(999), "我剛剛換了第 999 張島民證明，宣告本帳號背後是一名台灣人。");
    assert.equal(shared(1284), "我剛剛換了第 1,284 張島民證明，宣告本帳號背後是一名台灣人。");
    assert.equal(shared(1234567), "我剛剛換了第 1,234,567 張島民證明，宣告本帳號背後是一名台灣人。");
    assert.equal(shared(null), "我剛剛換了一張島民證明，宣告本帳號背後是一名台灣人。");
  });

  test("the record's line: the list, or with one platform the account", () => {
    const expected = [crow({ kind: "first", username: "alice" })];
    assert.equal(t(doneView(done(expected, [k("threads", "first", "alice")]), null).record!), "有一張有效的自然人憑證宣告了這份帳號清單：");
    assert.equal(t(doneView(done(expected, [k("threads", "first", "alice")]), "Threads").record!), "有一張有效的自然人憑證宣告了這個帳號：");
    // Everything withdrawn, one platform or not: the line of a withdrawal.
    const all = [crow({ kind: "withdraw", username: "alice", current: "alice" })];
    assert.equal(t(doneView(done(all, [k("threads", "withdraw", "alice", 0)]), "Threads").record!), "有一張有效的自然人憑證收回了所有帳號的宣告：");
  });

  test("the card's first record: the sentence about a new card", () => {
    assert.equal(doneView(done([crow({ kind: "first", username: "alice" })], [k("threads", "first", "alice")], { firstRecord: true })).newCard, true);
  });

  test("an account withdrawn, the list not empty: its link can be taken down; the withdrawn account in the record", () => {
    const expected = [crow({ platform: "test-example", row: EXAMPLE, kind: "withdraw", username: "a-b", current: "a-b" }), crow({ kind: "refresh", username: "alice", current: "alice" })];
    const v = doneView(done(expected, [k("test-example", "withdraw", "a-b", 0), k("threads", "refresh", "alice")]));
    assert.equal(v.withdrawnLink, true);
    assert.deepEqual(v.card, [{ name: "Threads", account: "@alice", raw: false }]);
    assert.deepEqual(v.rows.map((r) => [r.account, t(r.kind!)]), [["a-b", "收回"], ["@alice", "不變"]]);
  });

  test("everything withdrawn: no card, no link, the links can be taken down; the record line of a withdrawal", () => {
    const all = [crow({ kind: "withdraw", username: "alice", current: "alice" })];
    const v = doneView(done(all, [k("threads", "withdraw", "alice", 0)]));
    assert.equal(v.withdrawAll, true);
    assert.equal(t(v.unlink), "已經收回的帳號，個人檔案上的連結可以拿掉。");
    assert.equal(t(v.record!), "有一張有效的自然人憑證收回了所有帳號的宣告：");
    assert.equal(t(doneView(done(all, [k("threads", "withdraw", "alice", 0)]), "Threads").unlink), "你可以拿掉 Threads 個人檔案上的證明連結。");
  });

  test("other cards declare an account of the list: one sentence for each", () => {
    const expected = [crow({ platform: "test-example", row: EXAMPLE, kind: "first", username: "a-b" }), crow({ kind: "first", username: "alice" })];
    const v = doneView(done(expected, [k("test-example", "first", "a-b", 1), k("threads", "first", "alice", 2)]));
    assert.deepEqual(v.otherCards.map(t), ["還有別的卡片也宣告了 @alice。任何持卡人都可以宣告任何帳號；帳號主人承認哪一張，看個人檔案上放的是哪一張的連結。"]);
    // A number the device could not read, or a withdrawal still declared by others: no sentence.
    assert.deepEqual(doneView(done(expected, [k("test-example", "first", "a-b", null), k("threads", "first", "alice", null)])).otherCards, []);
  });

  test("the kinds could not be read: the card and the link, the date and the one sentence", () => {
    const v = doneView(done([crow({ kind: "first", username: "alice" })], null));
    assert.equal(v.record, null);
    assert.equal(v.kindsUnreadable, true);
    assert.deepEqual(v.rows, []);
    assert.deepEqual(v.card, [{ name: "Threads", account: "@alice", raw: false }]);
    assert.equal(v.link, "iamreal.tw/p/7K2Q9FM4XD");
  });

  test("the server recorded something else than step 5 said: the server's kind, and the code", () => {
    // Step 5 said the account stays (a card's state that hid the switch); the server recorded a switch.
    const expected = [crow({ kind: "refresh", username: "bob", current: "bob" })];
    const v = doneView(done(expected, [k("threads", "switch", "bob")], { mismatches: ["threads"] }));
    // kinds.switch names the account the screen took for the current one.
    assert.deepEqual(v.rows.map((r) => [r.account, t(r.kind!), r.mismatch]), [["@bob", "更換，原本是 @bob。", true]]);
    // Only now is what the proof log recorded shown.
    assert.equal(v.showRecord, true);
    // On top, before the title; under the row what step 5 said, and that a switch was used.
    assert.equal(t(v.mismatch!), "證明紀錄記下的，和你確認時畫面說的不同。請看下面標出來的地方。");
    assert.deepEqual(
      v.rows.map((r) => [t(r.expected!), r.switchUsed]),
      [["確認時畫面說的是：不變", true]],
    );
    // A platform the server reports and step 5 did not, and the other way round.
    const w = doneView(done([crow({ kind: "refresh", username: "alice", current: "alice" })], [k("test-example", "withdraw", "a-b", 0)], { mismatches: ["test-example", "threads"] }));
    assert.deepEqual(w.rows.map((r) => [r.platform, r.kind === null ? null : t(r.kind), r.mismatch]), [["test-example", "收回", true], ["threads", null, true]]);
    assert.deepEqual(
      w.rows.map((r) => [t(r.expected!), r.switchUsed]),
      [
        ["確認時畫面說的是：沒有這個平台", false],
        ["確認時畫面說的是：不變", false],
      ],
    );
    // No difference: nothing of it.
    const same = doneView(done(expected, [k("threads", "refresh", "bob")]));
    assert.equal(same.mismatch, null);
    assert.equal(same.showRecord, false);
    assert.ok(same.rows.every((r) => r.expected === null && !r.switchUsed));
  });

  test("a switch recorded where step 5 said a switch too: not 'a switch was used' again", () => {
    const expected = [crow({ kind: "switch", username: "bob", current: "alice", previous: "alice", switchesLeftAfter: 3 })];
    const v = doneView(done(expected, [k("threads", "switch", "carol")], { mismatches: ["threads"] }));
    assert.deepEqual(v.rows.map((r) => r.switchUsed), [false]);
  });

  test("an answer the device could not read at all (a 201): the title of a record made, no rows", () => {
    const v = doneView(done([crow({ kind: "first", username: "alice" })], null, { seq: null, recordHash: null }));
    assert.equal(t(v.title), "證明紀錄已經記下這次過卡");
    assert.equal(v.kindsUnreadable, true);
  });

  test("an account of a platform the device does not know is shown as it is (spaces kept)", () => {
    const row = slot(null, { platform: "x-new", current: "a  b ", lastDeclared: "a  b " });
    const a = editListView(status([row]));
    assert.deepEqual([a.rows[0]!.current, a.rows[0]!.raw, a.rows[0]!.name], ["a  b ", true, "x-new"]);
    const d4 = accountsView(status([row]));
    assert.deepEqual(d4.mode === "declared" ? d4.current.map((c) => [c.account, c.raw]) : null, [["a  b ", true]]);
    const cq = consequence([crow({ platform: "x-new", row: null, kind: "refresh", username: "a  b ", current: "a  b " })]);
    assert.deepEqual(cv(cq).rows.map((r) => [r.account, r.raw]), [["a  b ", true]]);
    const d = doneView(done(cq.rows, [k("x-new", "refresh", "a  b ")]));
    assert.deepEqual(d.card, [{ name: "x-new", account: "a  b ", raw: true }]);
    assert.deepEqual(d.rows.map((r) => [r.account, r.raw]), [["a  b ", true]]);
  });
});
