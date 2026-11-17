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
import { SITE_DOMAIN, cardPath, handle, presentationOf } from "../src/platforms.ts";
import { scopeOf } from "../src/spec/scope.ts";
import { parseUsernameFormat } from "../src/spec/username-format.ts";
import { COPY, fill } from "../src/ui/copy.ts";
import {
  type ItemState,
  type Message,
  PROGRESS_ITEMS,
  READ_ITEMS,
  type Sentence,
  accountsView,
  confirmView,
  daysBetween,
  doneView,
  firstNotDone,
  itemStates,
  progressButtons,
  readItemOf,
  rowLines,
  stopMessage,
} from "../src/ui/messages.ts";

const text = (m: Message): string => ("code" in m ? `[${m.code}]` : fill(m.template, m.values));
const t = (s: Sentence): string => fill(s.template, s.values);

const THREADS: PlatformRow = { platform: "threads", displayName: "Threads", format: parseUsernameFormat("[a-z0-9._]{1,30}")! };
const EXAMPLE: PlatformRow = { platform: "test-example", displayName: "Example (no real service)", format: parseUsernameFormat("[a-z0-9-]{1,20}")! };

describe("what the page writes per platform, and the scope string", () => {
  test("Threads: the prefix, the format hint, the profile page", () => {
    const p = presentationOf("threads");
    assert.equal(handle("threads", "alice"), "@alice");
    assert.equal(COPY.formats[p.formatHint as "threads"], "帳號只能用英文小寫、數字、句點和底線，最多 30 個字。");
    assert.equal(p.profileUrl!("alice"), "https://www.threads.com/@alice");
  });
  test("a platform the page has nothing of its own for: no prefix, no hint, no preview", () => {
    const p = presentationOf("test-example");
    assert.equal(handle("test-example", "a-b"), "a-b");
    assert.equal(p.formatHint, null);
    assert.equal(p.profileUrl, null);
  });
  test("the card's page and the scope strings: one for the public roster, none per platform", () => {
    assert.equal(SITE_DOMAIN, "iamreal.tw");
    assert.equal(cardPath("7K2Q9FM4XD"), "card/7K2Q9FM4XD");
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
    [{ code: "server", server: "root", status: 400 }, "這次過卡沒有被接受（代碼 root），名冊沒有變動。", 4],
    [{ code: "server", server: "challenge_used", status: 400 }, "這次過卡沒有被接受（代碼 challenge_used），名冊沒有變動。", 4],
    [{ code: "server", server: "platform", status: 400 }, "這次過卡沒有被接受（代碼 platform），名冊沒有變動。", 4],
    // The server's own policy on the fourth and fifth switch: no sentence of its own, the row of the other codes.
    [{ code: "server", server: "switch_restricted", status: 403 }, "這次過卡沒有被接受（代碼 switch_restricted），名冊沒有變動。", 4],
    [{ code: "server", server: "crl_stale", status: 503 }, "內政部的廢止清冊超過 3 天沒有更新，現在不能過卡。", 4],
    // The roster rules, when the card's state changed after it was asked.
    [{ code: "server", server: "daily_limit", status: 400 }, "這張卡片今天已經過卡 3 次，明天才能再過卡。", 4],
    [{ code: "server", server: "switch_limit", status: 400 }, "清單裡有一個平台不能再更換，整份清單都沒有記下，名冊沒有變動。請再讀一次卡片。", 4],
    [{ code: "server", server: "empty", status: 400 }, "這張卡片現在沒有宣告任何帳號，沒有可以收回的，名冊沒有變動。請再讀一次卡片。", 4],
    [{ code: "card", card: "card_error", detail: "pin_characters" }, "這一頁不支援含有 +、% 或非英數符號的 PIN。請先到內政部憑證管理中心的網站變更 PIN。", 2],
    [{ code: "card", card: "card_error", detail: "no_pin" }, "讀卡時發生錯誤（代碼 no_pin）。請重新插卡再試一次。", 2],
    [{ code: "username", platform: "threads" }, "帳號只能用英文小寫、數字、句點和底線，最多 30 個字。", null],
    // No hint in the copy for a platform the page has nothing of its own for: the code.
    [{ code: "username", platform: "test-example" }, "[username]", null],
    [{ code: "state" }, "[state]", null],
    [{ code: "idle" }, "超過 5 分鐘沒有完成，為了不讓 PIN 留在這一頁太久，已經回到開頭。請再讀一次卡片。", null],
    [{ code: "blocked", reason: "empty" }, "請至少填一個帳號。", null],
    [{ code: "blocked", reason: "daily_limit" }, "這張卡片今天已經過卡 3 次，明天才能再過卡。", null],
    // A switch the row says cannot be made: no sentence in the copy for typing one anyway.
    [{ code: "blocked", reason: "switch_limit", platform: "threads" }, "[switch_limit]", null],
    [{ code: "blocked", reason: "web_switch_limit", platform: "threads" }, "[web_switch_limit]", null],
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

  test("every server error carries its request ID", () => {
    for (const server of ["root", "challenge_unknown", "challenge_used", "crl_stale", "daily_limit", "switch_limit", "empty", "switch_restricted", "malformed_response", "not_found"]) {
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

const TODAY = "2026-11-16";

/** A slot as the engine reports it (CardStatus.slots). */
function slot(row: PlatformRow | null, o: Partial<SlotStatus> = {}): SlotStatus {
  const switchCount = o.switchCount ?? 0;
  return {
    platform: row?.platform ?? "x-new",
    row,
    current: null,
    lastDeclared: null,
    correctionDate: null,
    correctionToday: false,
    ...o,
    switchCount,
    switchesLeft: 5 - switchCount,
    webSwitchesLeft: Math.max(0, 3 - switchCount),
  };
}

function status(slots: SlotStatus[], o: Partial<CardStatus> = {}): CardStatus {
  return {
    scopedId: "7K2Q9FM4XD" + "0".repeat(42),
    shortId: "7K2Q9FM4XD",
    lastCardProof: "2026-11-04",
    slots,
    accounts: slots.flatMap((s) => (s.current === null ? [] : [{ platform: s.platform, username: s.current }])),
    dailyLimit: false,
    today: TODAY,
    count: 1,
    head: "0".repeat(64),
    ...o,
  };
}

const declared = (u: string, o: Partial<SlotStatus> = {}) => slot(THREADS, { current: u, lastDeclared: u, correctionDate: "2026-03-02", ...o });
const lines = (s: SlotStatus) => rowLines(s).map(t);

describe("your accounts (step 4)", () => {
  test("never declared: two lines on top, one row per platform of the table, the notes of a first declaration", () => {
    const v = accountsView(status([slot(EXAMPLE), slot(THREADS)], { lastCardProof: null }));
    assert.equal(v.state, "never");
    assert.deepEqual(v.lead.map((l) => l.map(text).join("")), ["這張卡片還沒有宣告過帳號。", "填上你要宣告的帳號，至少一個。沒有要宣告的平台留空白。"]);
    assert.deepEqual(
      v.rows.map((r) => [r.platform, r.name, r.prefix, r.current, r.editable, r.preview, r.lines.map(t)]),
      [
        ["test-example", "Example (no real service)", "", "", true, false, ["還沒有宣告過。"]],
        ["threads", "Threads", "@", "", true, true, ["還沒有宣告過。"]],
      ],
    );
    assert.deepEqual(
      v.notes.map((n) => [n.sentences.map(t).join(""), n.more]),
      [
        ["一張卡片在每個平台只能宣告一個帳號，之後改成別的帳號是更換。更換的次數有限，用掉就不會恢復。", true],
        ["預覽會在新分頁開平台上這個帳號的頁面，讓你確認沒有打錯。", false],
      ],
    );
    assert.equal(v.dailyLimit, null);
  });

  test("declared: the list and the last card proof on one line; card proof again, how to change", () => {
    const v = accountsView(status([slot(EXAMPLE), declared("alice", { switchCount: 1 })]));
    assert.equal(v.state, "declared");
    assert.deepEqual(v.lead.map((l) => l.map(text).join("")), ["這是這張卡片目前宣告的帳號。上次過卡是 12 天前。"]);
    assert.deepEqual(
      v.rows.map((r) => [r.current, r.lines.map(t)]),
      [
        ["", ["還沒有宣告過。"]],
        ["alice", ["更換過 1 次，還可以更換 2 次。"]],
      ],
    );
    assert.deepEqual(
      v.notes.map((n) => n.sentences.map(t).join("")),
      ["什麼都不改，直接按「下一步」，就是再次過卡：把上次過卡的日期更新成今天。", "填上空白的是新宣告，清空是收回，改成別的帳號是更換。更換的次數有限，用掉就不會恢復。", "預覽會在新分頁開平台上這個帳號的頁面，讓你確認沒有打錯。"],
    );
  });

  test("the last card proof today: 上次過卡是今天, not 0 天前", () => {
    const v = accountsView(status([declared("alice", { correctionDate: TODAY, correctionToday: true })], { lastCardProof: TODAY }));
    assert.deepEqual(v.lead.map((l) => l.map(text).join("")), ["這是這張卡片目前宣告的帳號。上次過卡是今天。"]);
  });

  test("everything withdrawn: two lines on top, no card proof again", () => {
    const v = accountsView(status([slot(THREADS, { lastDeclared: "bob", correctionDate: "2026-03-02" })]));
    assert.equal(v.state, "nothing");
    assert.deepEqual(v.lead.map((l) => l.map(text).join("")), ["這張卡片目前沒有宣告任何帳號。", "填上你要宣告的帳號，至少一個。沒有要宣告的平台留空白。"]);
    assert.ok(!v.notes.some((n) => n.sentences.some((x) => x.template === COPY.accounts.how_refresh)));
  });

  test("the line under each row, by its counts", () => {
    assert.deepEqual(lines(slot(THREADS)), ["還沒有宣告過。"]);
    assert.deepEqual(lines(declared("alice")), ["還沒有更換過，還可以更換 3 次。"]);
    assert.deepEqual(lines(declared("alice", { switchCount: 2 })), ["更換過 2 次，還可以更換 1 次。"]);
    // Put there today: changing it today is a correction, after the count.
    assert.deepEqual(lines(declared("alice", { switchCount: 1, correctionDate: TODAY, correctionToday: true })), ["更換過 1 次，還可以更換 2 次。", "今天才宣告的帳號，今天改掉不另外算一次更換。"]);
    // Withdrawn: the account withdrawn first, then the count.
    assert.deepEqual(lines(slot(THREADS, { lastDeclared: "bob", correctionDate: "2026-03-02", switchCount: 1 })), ["上一次宣告的是 @bob，已經收回。填回 @bob 不算更換。", "更換過 1 次，還可以更換 2 次。"]);
    // 3 or 4 switches: none left on the web (the app not out yet); the row can be cleared.
    assert.deepEqual(lines(declared("alice", { switchCount: 3 })), ["已經更換 3 次，目前不能再更換。之後請用島民 app。", "這一列不能改成別的帳號，可以清空。"]);
    assert.deepEqual(lines(declared("alice", { switchCount: 4 })), ["已經更換 4 次，目前不能再更換。之後請用島民 app。", "這一列不能改成別的帳號，可以清空。"]);
    assert.deepEqual(lines(declared("alice", { switchCount: 5 })), ["已經更換 5 次，這個平台不能再更換。", "這一列不能改成別的帳號，可以清空。"]);
    assert.deepEqual(lines(slot(THREADS, { lastDeclared: "bob", correctionDate: "2026-03-02", switchCount: 5 })), ["上一次宣告的是 @bob，已經收回。填回 @bob 不算更換。", "已經更換 5 次，這個平台不能再更換。", "這個平台只能填回 @bob。"]);
    // Used up, but put there today: it can still be changed today.
    assert.deepEqual(lines(declared("alice", { switchCount: 5, correctionDate: TODAY, correctionToday: true })), ["已經更換 5 次，這個平台不能再更換。", "今天才宣告的帳號，今天改掉不另外算一次更換。"]);
  });

  test("a platform the device does not know: a row as the server sent it, which cannot be changed", () => {
    const v = accountsView(status([slot(null, { platform: "test-example", current: "alice-b", lastDeclared: "alice-b" }), declared("alice")]));
    const r = v.rows[0]!;
    assert.deepEqual([r.platform, r.name, r.prefix, r.current, r.editable, r.preview], ["test-example", "test-example", "", "alice-b", false, false]);
    assert.deepEqual(r.lines.map(t), ["這一頁還不認得這個平台。這個帳號會原樣保留，在這裡不能修改。"]);
  });

  test("3 records today: the list as it is, no line under the rows, the sentence in place of the button", () => {
    const v = accountsView(status([slot(EXAMPLE, { current: "a-b", lastDeclared: "a-b", correctionDate: TODAY, correctionToday: true }), declared("alice")], { lastCardProof: TODAY, dailyLimit: true }));
    assert.deepEqual(v.lead.map((l) => l.map(text).join("")), ["這是這張卡片目前宣告的帳號。上次過卡是今天。"]);
    assert.ok(v.rows.every((r) => !r.editable && !r.preview && r.lines.length === 0));
    assert.equal(t(v.dailyLimit!), "這張卡片今天已經過卡 3 次，明天才能再過卡。");
    assert.deepEqual(v.notes, []);
  });

  test("days between two dates", () => {
    assert.equal(daysBetween("2026-11-04", "2026-11-16"), 12);
    assert.equal(daysBetween("2025-11-16", "2026-11-16"), 365);
  });
});

/** A row of a consequence (Consequence.rows). */
function crow(o: Partial<ConsequenceRow> & Pick<ConsequenceRow, "kind" | "username">): ConsequenceRow {
  return { platform: "threads", row: THREADS, current: null, previous: null, switchesLeftAfter: null, webSwitchesLeftAfter: null, ...o };
}
function consequence(rows: ConsequenceRow[], o: Partial<Consequence> = {}): Consequence {
  return { accounts: rows.filter((r) => r.kind !== "withdraw").map((r) => ({ platform: r.platform, username: r.username })), rows, firstRecord: false, today: TODAY, ...o };
}

describe("confirm (step 5)", () => {
  const rowsOf = (cq: Consequence) => confirmView(cq).rows.map((r) => [r.name, r.id, r.account, r.lines.map(t)]);

  test("each row: the platform's name and ID, the account, what happens", () => {
    const cq = consequence([
      crow({ platform: "test-example", row: EXAMPLE, kind: "first", username: "a-b" }),
      crow({ kind: "switch", username: "carol.tw", current: "alice", previous: "alice", switchesLeftAfter: 3, webSwitchesLeftAfter: 1 }),
    ]);
    assert.deepEqual(rowsOf(cq), [
      ["Example (no real service)", "test-example", "a-b", ["新宣告"]],
      ["Threads", "threads", "@carol.tw", ["更換，原本是 @alice。", "用掉一次更換，不會恢復。之後還可以更換 1 次。"]],
    ]);
    const v = confirmView(cq);
    assert.equal(v.intro, "按下後，名冊會公開記下這張卡片的帳號清單：");
    assert.equal(v.listedTogether, true);
    assert.equal(v.withdrawStays, false);
    assert.equal(v.later, "之後可以用同一張卡片收回或更換帳號。所有紀錄公開後無法刪除，這樣任何人才能驗證。");
    assert.equal(v.button, "宣告這份清單");
    assert.equal(v.date, TODAY);
  });

  test("the kinds of a row", () => {
    const one = (r: ConsequenceRow) => rowsOf(consequence([r]))[0]![3];
    assert.deepEqual(one(crow({ kind: "refresh", username: "alice", current: "alice" })), ["不變"]);
    assert.deepEqual(one(crow({ kind: "refresh", username: "bob", current: null })), ["再次宣告，不算更換"]);
    assert.deepEqual(one(crow({ kind: "withdraw", username: "alice", current: "alice" })), ["收回"]);
    assert.deepEqual(one(crow({ kind: "correction", username: "bob", current: "alice", previous: "alice" })), ["更換，原本是 @alice。", "今天才宣告的帳號，這次改掉不另外算一次更換。"]);
    // Withdrawn before, another account: a switch from the account withdrawn.
    assert.deepEqual(one(crow({ kind: "switch", username: "carol", current: null, previous: "bob", switchesLeftAfter: 4, webSwitchesLeftAfter: 2 })), ["更換，原本是 @bob。", "用掉一次更換，不會恢復。之後還可以更換 2 次。"]);
    // The third: none left on the web after it.
    assert.deepEqual(one(crow({ kind: "switch", username: "carol", current: "bob", previous: "bob", switchesLeftAfter: 2, webSwitchesLeftAfter: 0 })), ["更換，原本是 @bob。", "用掉一次更換，不會恢復。這次之後，目前不能再更換。"]);
    // The fifth (the app's).
    assert.deepEqual(one(crow({ kind: "switch", username: "carol", current: "bob", previous: "bob", switchesLeftAfter: 0, webSwitchesLeftAfter: 0 })), ["更換，原本是 @bob。", "用掉最後一次更換。這次之後，這個平台不能再更換。"]);
    // A platform the device does not know: the account as the server sent it, unchanged.
    assert.deepEqual(rowsOf(consequence([crow({ platform: "x-new", row: null, kind: "refresh", username: "alice-b", current: "alice-b" })])), [["x-new", "x-new", "alice-b", ["不變"]]]);
  });

  test("the button by the whole list", () => {
    assert.equal(confirmView(consequence([crow({ kind: "refresh", username: "alice", current: "alice" })])).button, "再次過卡");
    assert.equal(confirmView(consequence([crow({ kind: "refresh", username: "bob", current: null })])).button, "宣告這份清單");
    assert.equal(confirmView(consequence([crow({ kind: "refresh", username: "alice", current: "alice" }), crow({ platform: "test-example", row: EXAMPLE, kind: "withdraw", username: "a-b", current: "a-b" })])).button, "宣告這份清單");
  });

  test("an account withdrawn: its row, and that the record stays", () => {
    const cq = consequence([crow({ platform: "test-example", row: EXAMPLE, kind: "withdraw", username: "a-b", current: "a-b" }), crow({ kind: "refresh", username: "alice", current: "alice" })]);
    const v = confirmView(cq);
    assert.deepEqual(rowsOf(cq)[0], ["Example (no real service)", "test-example", "a-b", ["收回"]]);
    assert.equal(v.withdrawStays, true);
    assert.equal(v.listedTogether, true);
  });

  test("everything withdrawn: the other first sentence, no listed together, the other second point, the button", () => {
    const v = confirmView(consequence([crow({ kind: "withdraw", username: "alice", current: "alice" })]));
    assert.equal(v.intro, "按下後，名冊會公開記下這張卡片不再宣告任何帳號：");
    assert.equal(v.listedTogether, false);
    assert.equal(v.withdrawStays, true);
    assert.equal(v.later, "之後可以用同一張卡片再宣告。所有紀錄公開後無法刪除，這樣任何人才能驗證。");
    assert.equal(v.button, "收回所有帳號");
  });
});

describe("done (step 6)", () => {
  const ID = "7K2Q9FM4XD" + "0".repeat(42);
  function done(expected: ConsequenceRow[], kinds: Done["kinds"], o: Partial<Done> = {}): Done {
    const accounts = expected.filter((r) => r.kind !== "withdraw").map((r) => ({ platform: r.platform, username: r.username }));
    return {
      seq: 2,
      recordHash: "0".repeat(64),
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

  test("the titles", () => {
    const first = [crow({ kind: "first", username: "alice" })];
    assert.equal(t(doneView(done(first, [k("threads", "first", "alice")], { firstRecord: true })).title), "你換到一張島民名片了");
    const same = [crow({ kind: "refresh", username: "alice", current: "alice" })];
    assert.equal(t(doneView(done(same, [k("threads", "refresh", "alice")])).title), "島民名片更新好了");
    const back = [crow({ kind: "refresh", username: "alice", current: null })];
    assert.equal(t(doneView(done(back, [k("threads", "refresh", "alice")])).title), "島民名片改好了");
    const sw = [crow({ kind: "switch", username: "carol", current: "alice", previous: "alice", switchesLeftAfter: 4, webSwitchesLeftAfter: 2 })];
    assert.equal(t(doneView(done(sw, [k("threads", "switch", "carol")])).title), "島民名片改好了");
    const all = [crow({ kind: "withdraw", username: "alice", current: "alice" })];
    assert.equal(t(doneView(done(all, [k("threads", "withdraw", "alice", 0)])).title), "已全部收回");
    assert.equal(t(doneView(done(same, null)).title), "名冊已經記下這次過卡");
  });

  test("the card's page is the link; the card lists the list after the record; the rows of the record", () => {
    const expected = [crow({ platform: "test-example", row: EXAMPLE, kind: "first", username: "a-b" }), crow({ kind: "refresh", username: "alice", current: "alice" })];
    const v = doneView(done(expected, [k("test-example", "first", "a-b"), k("threads", "refresh", "alice")]));
    assert.equal(v.link, "iamreal.tw/card/7K2Q9FM4XD");
    assert.equal(v.url, "https://iamreal.tw/card/7K2Q9FM4XD");
    assert.deepEqual(v.card, [
      { name: "Example (no real service)", account: "a-b" },
      { name: "Threads", account: "@alice" },
    ]);
    assert.equal(t(v.record!), "有一張有效的自然人憑證宣告了這份帳號清單：");
    assert.deepEqual(
      v.rows.map((r) => [r.name, r.account, t(r.kind!), r.mismatch]),
      [
        ["Example (no real service)", "a-b", "新宣告", false],
        ["Threads", "@alice", "不變", false],
      ],
    );
    assert.equal(t(v.shortIdLine), "這張卡片的島民編號開頭是 7K2Q9FM4XD。");
    assert.equal(v.newCard, false);
    assert.equal(v.withdrawnLink, false);
    assert.deepEqual(v.otherCards, []);
  });

  test("the card's first record: the sentence about a new card", () => {
    assert.equal(doneView(done([crow({ kind: "first", username: "alice" })], [k("threads", "first", "alice")], { firstRecord: true })).newCard, true);
  });

  test("an account withdrawn, the list not empty: its link can be taken down; the withdrawn account in the record", () => {
    const expected = [crow({ platform: "test-example", row: EXAMPLE, kind: "withdraw", username: "a-b", current: "a-b" }), crow({ kind: "refresh", username: "alice", current: "alice" })];
    const v = doneView(done(expected, [k("test-example", "withdraw", "a-b", 0), k("threads", "refresh", "alice")]));
    assert.equal(v.withdrawnLink, true);
    assert.deepEqual(v.card, [{ name: "Threads", account: "@alice" }]);
    assert.deepEqual(v.rows.map((r) => [r.account, t(r.kind!)]), [["a-b", "收回"], ["@alice", "不變"]]);
  });

  test("everything withdrawn: no card, no link; the record line of a withdrawal", () => {
    const v = doneView(done([crow({ kind: "withdraw", username: "alice", current: "alice" })], [k("threads", "withdraw", "alice", 0)]));
    assert.equal(v.withdrawAll, true);
    assert.equal(v.withdrawnLink, false);
    assert.equal(t(v.record!), "有一張有效的自然人憑證收回了所有帳號的宣告：");
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
    assert.deepEqual(v.card, [{ name: "Threads", account: "@alice" }]);
    assert.equal(v.link, "iamreal.tw/card/7K2Q9FM4XD");
  });

  test("the server recorded something else than step 5 said: the server's kind, and the code", () => {
    // Step 5 said a correction (not counted); the server recorded a switch.
    const expected = [crow({ kind: "correction", username: "bob", current: "alice", previous: "alice" })];
    const v = doneView(done(expected, [k("threads", "switch", "bob")], { mismatches: ["threads"] }));
    assert.deepEqual(v.rows.map((r) => [r.account, t(r.kind!), r.mismatch]), [["@bob", "更換，原本是 @alice。", true]]);
    // A platform the server reports and step 5 did not, and the other way round.
    const w = doneView(done([crow({ kind: "refresh", username: "alice", current: "alice" })], [k("test-example", "withdraw", "a-b", 0)], { mismatches: ["test-example", "threads"] }));
    assert.deepEqual(w.rows.map((r) => [r.platform, r.kind === null ? null : t(r.kind), r.mismatch]), [["test-example", "收回", true], ["threads", null, true]]);
  });
});
