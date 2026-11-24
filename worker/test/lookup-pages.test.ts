// The page of a Threads account (/threads/@<name>) and the proof log page
// (/proof-log), through the Worker's HTTP (test/harness.ts): every sentence
// design/copy/ has for the case (account-page.md, proof-log-page.md), in order,
// read from the copy files; the redirects, the 404s, the lookup box, the
// list a page at a time. The cases are the Go backend's
// (e159ab9:server/visitor_test.go).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { block, codeBlocks, copyLines, copySection, notOnPage, previewOf, readCopy, unescapeHtml, wantLines, wantPreview } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { CARD_A, CARD_B, CLEARED_ON, cardStarting, checkVisitorHeaders, getPage, pagesWorld, r } from "./pages.ts";
import { freshProofLog, mustSubmit, newCard, publishG3, sub } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

/**
 * The proof log of the copy files' examples (test/pages.test.ts): card A gives
 * its place to @alice from 2026-08-01, last card proof 2026-11-06; with
 * `withB`, card B gives its place to @alice too, from a later date than A.
 */
async function exampleCards(withB: boolean): Promise<void> {
  const a = cardStarting(CARD_A);
  const b = cardStarting(CARD_B);
  const recs = [r("2026-03-02", a, "threads:bob"), r("2026-05-10", a, "threads:bob"), r("2026-08-01", a, "threads:alice"), r("2026-09-01", b, "threads:alice"), r("2026-11-06", a, "threads:alice"), r("2026-11-15", b, "threads:alice")];
  await pagesWorld(worker, "2026-11-18", withB ? recs : recs.filter((x) => x.card === a));
}

/** Checks the one embed of the page, as it is decided (sandbox without allow-scripts, no referrer, credentialless). */
function wantEmbed(page: string, username: string): void {
  const want = `<iframe class="threads-profile" src="https://www.threads.com/@${username}/embed/" title="Threads 個人檔案：@${username}" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" credentialless></iframe>`;
  assert.equal(page.split("<iframe").length - 1, 1, "one frame");
  assert.ok(page.includes(want), `the frame is ${want}`);
}

describe("the page of an account", () => {
  test("one card: section 1 of account-page.md, the profile, the link to the card, the preview", async () => {
    await exampleCards(false);
    const { status, page } = await getPage(worker, "/threads/@alice");
    assert.equal(status, 200);
    wantLines(page, copyLines(block("account-page.md", "1. ", 0)));
    wantEmbed(page, "alice");
    assert.ok(page.includes(`<a href="/p/${CARD_A}">看這張島民證明</a>`), "the link to the card");
    // The account at the size of the page of a card's (account-page.md): the same class, one size smaller past 12 characters.
    assert.ok(page.includes('<span class="account">@alice</span>'), "@alice is at the full size");
    const { title, site } = previewOf("account-page.md", "5. ");
    wantPreview(page, title, site);
  });

  test("two cards: section 2, by the date from which, not by the last card proof", async () => {
    // Card B's last card proof is the more recent; it is second all the same.
    await exampleCards(true);
    const { page } = await getPage(worker, "/threads/@alice");
    wantLines(page, copyLines(block("account-page.md", "2. ", 0)));
    wantEmbed(page, "alice");
  });

  test("a last card proof today is written 今天", async () => {
    await pagesWorld(worker, "2026-11-18", [r("2026-11-18", cardStarting(CARD_A), "threads:alice")]);
    const { page } = await getPage(worker, "/threads/@alice");
    wantLines(page, ["島民編號 7K2Q9FM4XD 開頭 看這張島民證明", "2026-11-18 起", ...copyLines(block("account-page.md", "1. ", 1))]);
    notOnPage(page, "0 天前");
  });

  test("no card: section 3, 200, no profile; an account given once and no longer is one of them", async () => {
    await exampleCards(true);
    for (const name of ["bob", "nobody"]) {
      const { status, page } = await getPage(worker, `/threads/@${name}`);
      assert.equal(status, 200);
      wantLines(page, copyLines(block("account-page.md", "3. "), "@alice", `@${name}`));
      assert.ok(!page.includes("<iframe"), "no profile with no card");
    }
  });

  test("several cards with the same short ID: each under as many characters as tell them apart", async () => {
    const m1 = cardStarting("7K2Q9FM4XD3A");
    const m2 = cardStarting("7K2Q9FM4XD3B");
    await pagesWorld(worker, "2026-11-18", [r("2026-11-01", m2, "threads:alice"), r("2026-11-06", m1, "threads:alice")]);
    const { page } = await getPage(worker, "/threads/@alice");
    wantLines(page, ["島民編號 7K2Q9FM4XD3B 開頭 看這張島民證明 2026-11-01 起", "島民編號 7K2Q9FM4XD3A 開頭 看這張島民證明 2026-11-06 起"]);
  });

  test("an account on another platform of the test log is not one on Threads", async () => {
    await pagesWorld(worker, "2026-11-18", [r("2026-11-01", cardStarting(CARD_A), "test-example:alice")]);
    wantLines((await getPage(worker, "/threads/@alice")).page, copyLines(block("account-page.md", "3. ")));
  });

  test("a name with uppercase letters is redirected (301) to lowercase; one not in the Threads format is the page of section 4, 404, with no profile and no preview, its name not written back; neither asks the proof log's object", async () => {
    await exampleCards(false);
    const notAName = copyLines(block("account-page.md", "4. "));
    const cases = async (): Promise<void> => {
      for (const [typed, to] of [["Alice", "/threads/@alice"], ["ALICE", "/threads/@alice"], ["Carol.TW", "/threads/@carol.tw"]] as const) {
        const res = await worker.fetch(`/threads/@${typed}`, { redirect: "manual" });
        assert.deepEqual([res.status, res.headers.get("location")], [301, to], `@${typed}`);
        checkVisitorHeaders(`@${typed}`, res, { cache: "public, max-age=60", more: ["location"] });
      }
      for (const inUrl of ["a-b", "", "a%20b", "a".repeat(31), "%C3%A5lice", "a/b", "%3Cb%3Ex%22%27", "javascript:alert(1)"]) {
        const { status, page } = await getPage(worker, `/threads/@${inUrl}`);
        assert.equal(status, 404, `@${inUrl}`);
        wantLines(page, notAName);
        notOnPage(page, copyLines(block("account-page.md", "3. "))[1]!);
        assert.ok(page.includes('<a href="/proof-log#q">查一個 Threads 帳號</a>') && !page.includes("<iframe"), `@${inUrl}: the link to the lookup, no profile`);
        assert.ok(!page.includes("<b>x") && !page.includes("&lt;b&gt;") && !page.includes("javascript"), `@${inUrl}: not written back`);
        wantPreview(page, notAName[0]!, null);
      }
    };
    await cases();
    // Without @: no page of an account.
    assert.equal((await getPage(worker, "/threads/alice")).status, 404);

    await worker.proofLog.setStoredSchemaVersion("another");
    await worker.proofLog.restart();
    try {
      const logged = worker.logLines().length;
      const failed = await worker.fetch("/threads/@alice");
      assert.equal(failed.status, 500);
      checkVisitorHeaders("a page that failed", failed, { cache: "no-store" });
      // The one line about it names the page, never the account.
      assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", page: "account", where: "schema", error: "Error" }]);
      await cases();
    } finally {
      await worker.proofLog.setStoredSchemaVersion("the build's");
      await worker.proofLog.restart();
    }
  });
});

describe("the proof log page", () => {
  /** proof-log-page.md's first block: the whole page. */
  const wholePage = (...replace: string[]): string[] => copyLines(codeBlocks(readCopy("proof-log-page.md"))[0]!, ...replace);
  const rows = (page: string): number => page.split('<li><a href="/p/').length - 1;

  test("the numbers, the lookup box, the latest first by the date from which, the download; a withdrawn card is neither counted nor listed; the preview", async () => {
    const [a, b, old, gone] = [cardStarting(CARD_A), cardStarting(CARD_B), newCard(), newCard()];
    await pagesWorld(worker, "2026-11-18", [
      r("2026-08-01", old, "threads:carol"), // 109 days before: counted, not in the last three months
      r("2026-11-10", gone, "threads:dave"),
      r("2026-11-12", gone), // withdrawn
      r("2026-11-17", b, "threads:bob"),
      r("2026-11-18", a, "threads:alice"),
      r("2026-11-18", old, "threads:carol"), // a refresh: now in the last three months, and its row stays where it was
    ]);
    const { status, page } = await getPage(worker, "/proof-log");
    assert.equal(status, 200);
    wantLines(page, wholePage("1,284", "3", "1,031", "3").filter((l) => l !== "更多"));
    wantLines(page, ["2026-11-17 Threads 的 @bob", "2026-08-01 Threads 的 @carol"]);
    notOnPage(page, "@dave", "更多", block("proof-log-page.md", "清單")[0]!);
    for (const want of [`<a href="/p/${CARD_A}"><time>2026-11-18</time>`, '<form method="get" action="/proof-log">', '<input type="text" id="q" name="q" value=""', '<a href="/verify">怎麼驗證島民證明</a>']) {
      assert.ok(page.includes(want), `the page has ${want}`);
    }
    assert.ok(!page.includes("<iframe"), "no profile on the proof log page");
    const { title, site } = previewOf("proof-log-page.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
  });

  test("下載整份證明紀錄 links to the part of iamreal-verify's README about downloading", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { page } = await getPage(worker, "/proof-log");
    assert.ok(copySection("proof-log-page.md", "下載").includes("「下載整份證明紀錄」連到 `cmd/iamreal-verify/README.md` 講下載的那一段"));
    assert.ok(readFileSync(join(WORKER_DIR, "..", "cmd", "iamreal-verify", "README.md"), "utf8").includes("\n## 下載\n"), "the README has a section 下載");
    assert.ok(page.includes('<a href="https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md#下載">下載整份證明紀錄</a> <a href="/verify">怎麼驗證島民證明</a>'));
    assert.ok(!page.includes('href="/proof-log/"'));
  });

  test("no card yet: one sentence where the list is, without the sentence above the list and without 更多", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page } = await getPage(worker, "/proof-log");
    assert.equal(status, 200);
    const all = wholePage("1,284", "0", "1,031", "0");
    wantLines(page, [...all.slice(0, 5), ...copyLines(block("proof-log-page.md", "清單")), all[all.length - 1]!]);
    notOnPage(page, all[5]!, "更多");
    assert.ok(!page.includes("<li>"), "no row");
  });

  test("50 at a time; 更多 is a link to the next ones, the same list from where the page stopped; a place that does not read lists from the start", async () => {
    const recs = Array.from({ length: 52 }, (_, i) => r(`2026-10-${String(1 + Math.floor(i / 3)).padStart(2, "0")}`, newCard(), `threads:a${String(i).padStart(2, "0")}`));
    await pagesWorld(worker, "2026-11-18", recs);
    const { page } = await getPage(worker, "/proof-log");
    assert.equal(rows(page), 50);
    const more = /<a href="(\/proof-log\?after=[^"]*)">更多<\/a>/.exec(page);
    assert.ok(more !== null, "更多");
    // The place is the last row's: its date and the seq of the record from which (the third card proof).
    assert.equal(unescapeHtml(more[1]!), "/proof-log?after=2026-10-01.3");
    const next = (await getPage(worker, unescapeHtml(more[1]!))).page;
    assert.equal(rows(next), 2);
    // Exactly 50 after a place: all of them, and no 更多 to a page with nothing on it. The second row is a50's,
    // from 2026-10-17 by the 51st card proof.
    const fifty = (await getPage(worker, "/proof-log?after=2026-10-17.51")).page;
    assert.equal(rows(fifty), 50);
    assert.ok(fifty.includes("@a49") && fifty.includes("@a00") && !fifty.includes("@a50"));
    notOnPage(fifty, "更多");
    wantLines(next, ["Threads 的 @a01", "Threads 的 @a00"]);
    notOnPage(next, "@a02", "更多", block("proof-log-page.md", "清單")[0]!);
    for (const after of ["nothing", "2026-10-01", "2026-10-01.", "2026-10-01.0", "2026-10-01.03", "2026-10-01.+3", "2026-13-01.3", "2026-10-01x3", "2026-10-01.18446744073709551616", "2026-10-01.9223372036854775808"]) {
      const bad = (await getPage(worker, `/proof-log?after=${after}`)).page;
      assert.ok(rows(bad) === 50 && bad.includes("@a51"), `after=${after}: from the start`);
    }
    // After the last one: no row, and not the sentence of an empty proof log.
    const end = (await getPage(worker, "/proof-log?after=2026-10-01.1")).page;
    assert.equal(rows(end), 0);
    notOnPage(end, block("proof-log-page.md", "清單")[0]!, "更多");
  });

  test("the lookup box: a name, with or without @, in any case and with spaces around it, goes to its page (303); nothing is the page as it is; anything else is the page with what was typed and one more line", async () => {
    await exampleCards(false);
    for (const [q, to] of [
      ["alice", "/threads/@alice"],
      ["%40Alice", "/threads/@alice"],
      ["@CAROL.tw", "/threads/@carol.tw"],
      ["%20alice%20", "/threads/@alice"],
      ["%20%40Alice%09", "/threads/@alice"],
      ["%E3%80%80alice", "/threads/@alice"],
      ["+alice+", "/threads/@alice"],
      ["%C2%85alice", "/threads/@alice"],
    ] as const) {
      const res = await worker.fetch(`/proof-log?q=${q}`, { redirect: "manual" });
      assert.deepEqual([res.status, res.headers.get("location")], [303, to], `q=${q}`);
      checkVisitorHeaders(`q=${q}`, res, { cache: "public, max-age=60", more: ["location"] });
    }
    const bad = block("proof-log-page.md", "查詢")[0]!;
    for (const q of ["", "%20%20", "%40", "%20%40%20"]) {
      const { status, page } = await getPage(worker, `/proof-log?q=${q}`);
      assert.equal(status, 200, `q=${q}`);
      notOnPage(page, bad);
      assert.ok(page.includes('name="q" value=""'), `q=${q}: the box is empty`);
    }
    for (const [q, kept] of [["a-b", "a-b"], ["%40%40alice", "@alice"], ["a%20b", "a b"], ["%40%C3%A5lice%20", "ålice"], ["%EF%BB%BFalice", "﻿alice"], ["%3Cb%3Ex%22", "&lt;b&gt;x&#34;"], ["a%00b", "a\uFFFDb"]] as const) {
      // The place is before @alice's row (from 2026-08-01, the third card proof): read, it would leave the list empty.
      const { status, page } = await getPage(worker, `/proof-log?q=${q}&after=2026-08-01.1`);
      assert.equal(status, 200, `q=${q}`);
      wantLines(page, ["查一個 Threads 帳號", "@查", bad, "最近換出的島民證明"]);
      assert.ok(page.includes(`name="q" value="${kept}"`), `q=${q}: the box keeps ${kept}`);
      assert.ok(!page.includes("<b>x"), `q=${q}: escaped`);
      // ?after= is not read with a lookup that is not a name: the list is from the start.
      assert.ok(page.includes("@alice"), `q=${q}: the list from the start`);
    }
  });

  test("a record shows on the next page opened after it is written, the numbers too: the Worker keeps no copy of them", async () => {
    await freshProofLog(worker, { clearedOn: CLEARED_ON });
    const root = await publishG3(worker);
    const card = cardStarting(CARD_A);
    wantLines((await getPage(worker, "/threads/@alice")).page, ["沒有自然人憑證把名額給這個帳號。"]);
    wantLines((await getPage(worker, "/proof-log")).page, ["現在有 0 張島民證明"]);
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    wantLines((await getPage(worker, "/threads/@alice")).page, ["有 1 張自然人憑證", "島民編號 7K2Q9FM4XD 開頭 看這張島民證明 2026-11-20 起 上次過卡 今天"]);
    wantLines((await getPage(worker, "/proof-log")).page, ["現在有 1 張島民證明，其中 1 張在過去三個月內過卡。", "2026-11-20 Threads 的 @alice"]);
    await mustSubmit(worker, await sub(worker, card, root, "threads:bob"), "threads correction");
    wantLines((await getPage(worker, "/threads/@alice")).page, ["沒有自然人憑證把名額給這個帳號。"]);
    wantLines((await getPage(worker, "/threads/@bob")).page, ["有 1 張自然人憑證"]);
    const proofLog = (await getPage(worker, "/proof-log")).page;
    wantLines(proofLog, ["現在有 1 張島民證明", "2026-11-20 Threads 的 @bob"]);
    notOnPage(proofLog, "@alice");
  });

  test("with an object that answers nothing, the page is 500, and a lookup that goes to a page of an account is answered without it", async () => {
    await exampleCards(false);
    await worker.proofLog.setStoredSchemaVersion("another");
    await worker.proofLog.restart();
    try {
      const logged = worker.logLines().length;
      const failed = await worker.fetch("/proof-log?q=%3Cb%3E");
      assert.equal(failed.status, 500);
      checkVisitorHeaders("a page that failed", failed, { cache: "no-store" });
      // The one line about it names the page, never what was typed.
      assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", page: "proof_log", where: "schema", error: "Error" }]);
      assert.equal((await worker.fetch("/proof-log?q=alice", { redirect: "manual" })).status, 303);
    } finally {
      await worker.proofLog.setStoredSchemaVersion("the build's");
      await worker.proofLog.restart();
    }
  });
});
