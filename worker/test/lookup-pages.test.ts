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
import { parseDay } from "iamreal-protocol/date.ts";
import { shortId } from "iamreal-protocol/scoped-id.ts";
import { WORKER_DIR } from "./build.ts";
import { block, codeBlocks, copyLines, copySection, notOnPage, previewOf, readCopy, unescapeHtml, wantLines, wantPreview } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { CARD_A, CARD_B, CLEARED_ON, cardStarting, checkVisitorHeaders, getPage, pagesWorld, r } from "./pages.ts";
import { freshProofLog, mustSubmit, newCard, publishCrl, publishG3, sub, tw, wantError } from "./records.ts";

/** What a page's copy file says of its preview's image: the one image of every page (proof-page.md, section 8, 預覽圖). */
const SAME_IMAGE_NOTE = "圖是每一頁同一張（`proof-page.md`「預覽圖」）";

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
    // getPage (pages.ts) checks the image on every page with a preview; the copy file points at the same image.
    assert.ok(copySection("account-page.md", "5. ").includes(SAME_IMAGE_NOTE), "account-page.md section 5: the image of every page");
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
  /** The line of the two links (proof-log-page.md, 下載): its index in the whole page, and the words of each link. */
  const linkLine = (): { at: number; download: string; verify: string } => {
    const all = wholePage();
    const at = all.findIndex((l) => /\u3000{2,}/.test(l));
    const [download, verify, ...rest] = (all[at] ?? "").split(/\u3000{2,}/);
    assert.ok(at > 4 && download !== undefined && verify !== undefined && rest.length === 0, "proof-log-page.md: one line of two links, after the sentence above the list");
    assert.ok(copySection("proof-log-page.md", "下載").includes(`「${verify}」連到 \`verify.md\` 那一頁`), `proof-log-page.md: ${verify} goes to /verify`);
    return { at, download, verify };
  };
  /** The sentence where the list is when the proof log has no record yet. */
  const empty = (): string => block("proof-log-page.md", "清單")[0]!;
  /** The table of proof-log-page.md's 清單: what a row writes for each kind of record. */
  const table = (): Map<string, string> => {
    const t = new Map<string, string>();
    for (const line of copySection("proof-log-page.md", "清單").split("\n")) {
      const cells = line.split("|");
      if (cells.length === 4 && !cells[1]!.startsWith("---") && cells[1]!.trim() !== "這一筆紀錄") t.set(cells[1]!.trim(), cells[2]!.trim());
    }
    return t;
  };
  /** One row of the list: the date, the beginning of the card's scoped ID, and what the table writes for the kind, with these accounts. */
  const row = (date: string, short: string, kind: string, ...accounts: string[]): string => {
    const words = table().get(kind);
    assert.ok(words !== undefined, `proof-log-page.md's 清單 has a row ${kind}`);
    let i = 0;
    const written = words.replace(/@[a-z0-9._]+/g, () => `@${accounts[i++]}`);
    assert.equal(i, accounts.length, `${kind}: as many accounts as the table writes`);
    return `${date} 島民編號 ${short} 開頭 ${written}`;
  };
  /** The third card of the copy's example. */
  const CARD_C = "9Q4C2XN7B4";

  test("the lookup box before the numbers, the sentence and the two links above the list, every valid record on Threads by its place in the proof log, the latest first, a withdrawal too; the download; the preview", async () => {
    const [a, b, c, gone, old] = [cardStarting(CARD_A), cardStarting(CARD_B), cardStarting(CARD_C), cardStarting("8BN3TX5RJM"), newCard()];
    await pagesWorld(worker, "2026-11-18", [
      r("2026-08-01", old, "threads:erin"), // 109 days before: counted, not in the last three months
      r("2026-11-01", b, "threads:bob"),
      r("2026-11-10", gone, "threads:dave"),
      r("2026-11-10", c, "threads:carol"),
      r("2026-11-12", gone), // withdrawn: no longer counted, and listed
      r("2026-11-17", c, "threads:carol.tw"),
      r("2026-11-18", b, "threads:bob"), // a card proof again: listed, as the latest but one
      r("2026-11-18", a, "threads:alice"),
    ]);
    const { status, page } = await getPage(worker, "/proof-log");
    assert.equal(status, 200);
    wantLines(page, wholePage("1,284", "4", "1,031", "3").filter((l) => l !== "更多"));
    wantLines(page, [
      row("2026-11-18", CARD_A, "新宣告", "alice"),
      row("2026-11-18", CARD_B, "再次過卡", "bob"),
      row("2026-11-17", CARD_C, "更換", "carol", "carol.tw"),
      row("2026-11-12", "8BN3TX5RJM", "收回", "dave"),
      row("2026-11-10", CARD_C, "新宣告", "carol"),
      row("2026-11-10", "8BN3TX5RJM", "新宣告", "dave"),
      row("2026-11-01", CARD_B, "新宣告", "bob"),
      row("2026-08-01", shortId(old), "新宣告", "erin"),
    ]);
    assert.equal(rows(page), 8);
    notOnPage(page, "更多", empty());
    for (const want of [`<li><a href="/p/${CARD_A}"><time>2026-11-18</time>`, `<li><a href="/p/8BN3TX5RJM"><time>2026-11-12</time>`, '<form method="get" action="/proof-log">', '<input type="text" id="q" name="q" value=""', `<a href="/verify">${linkLine().verify}</a>`]) {
      assert.ok(page.includes(want), `the page has ${want}`);
    }
    assert.ok(page.indexOf('id="q"') < page.indexOf("現在有"), "the lookup box is before the numbers");
    assert.ok(!page.includes("<iframe"), "no profile on the proof log page");
    const { title, site } = previewOf("proof-log-page.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
    // getPage (pages.ts) checks the image on every page with a preview; the copy file points at the same image.
    assert.ok(copySection("proof-log-page.md", "連結被貼出去時的預覽").includes(SAME_IMAGE_NOTE), "proof-log-page.md's preview: the image of every page");
  });

  test("every kind of record as the table of 清單 writes it; a card's 3 valid records of one day, all of them; a record refused is not listed", async () => {
    assert.equal(table().size, 7, "the table of 清單 has the 7 rows this test writes");
    const e = cardStarting("E000000000");
    await pagesWorld(worker, "2026-10-08", [
      r("2026-10-01", e, "threads:bob"),
      r("2026-10-02", e, "threads:bob"),
      r("2026-10-03", e, "threads:alice"),
      r("2026-10-03", e, "threads:dave"), // a correction
      r("2026-10-04", e), // a withdrawal
      r("2026-10-05", e, "threads:dave"), // declared again
      r("2026-10-06", e),
      r("2026-10-07", e, "threads:carol.tw"), // another, after a withdrawal: a switch
      r("2026-10-08", e, "threads:erin"),
      r("2026-10-08", e),
      r("2026-10-08", e, "threads:frank"), // another, after a withdrawal, the day of a switch: a correction
    ]);
    // A fourth card proof of the card that day is refused (daily_limit): nothing is written, so nothing is listed.
    const root = await publishCrl(worker, { issuer: "G3", number: parseDay("2026-10-08")!, thisUpdate: tw("2026-10-08", "05:00:00"), serials: [11, 12] });
    await wantError(worker, await sub(worker, e, root, "threads:frank"), 400, "daily_limit");
    const { page } = await getPage(worker, "/proof-log");
    const id = "E000000000";
    wantLines(page, [
      row("2026-10-08", id, "更正", "erin", "frank"),
      row("2026-10-08", id, "收回", "erin"),
      row("2026-10-08", id, "更換", "carol.tw", "erin"),
      row("2026-10-07", id, "收回之後宣告別的帳號", "dave", "carol.tw"),
      row("2026-10-06", id, "收回", "dave"),
      row("2026-10-05", id, "收回之後宣告回同一個帳號", "dave"),
      row("2026-10-04", id, "收回", "dave"),
      row("2026-10-03", id, "更正", "alice", "dave"),
      row("2026-10-03", id, "更換", "bob", "alice"),
      row("2026-10-02", id, "再次過卡", "bob"),
      row("2026-10-01", id, "新宣告", "bob"),
    ]);
    assert.equal(rows(page), 11);
  });

  test("下載全部的證明紀錄 links to the part of iamreal-verify's README about downloading", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { page } = await getPage(worker, "/proof-log");
    assert.ok(copySection("proof-log-page.md", "下載").includes("「下載全部的證明紀錄」連到 `cmd/iamreal-verify/README.md` 講下載的那一段"));
    assert.ok(readFileSync(join(WORKER_DIR, "..", "cmd", "iamreal-verify", "README.md"), "utf8").includes("\n## 下載\n"), "the README has a section 下載");
    const { download, verify } = linkLine();
    assert.ok(page.includes(`<a href="https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md#下載">${download}</a> <a href="/verify">${verify}</a>`));
    assert.ok(!page.includes('href="/proof-log/"'));
  });

  test("no record yet: the two links below the numbers, one sentence where the list is, without the sentence above the list and without 更多", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page } = await getPage(worker, "/proof-log");
    assert.equal(status, 200);
    const all = wholePage("1,284", "0", "1,031", "0");
    // The two links are below the numbers, before where the list is, as with records (proof-log-page.md, 下載).
    wantLines(page, [...all.slice(0, 4), all[linkLine().at]!, empty()]);
    notOnPage(page, all[4]!, "更多");
    assert.ok(!page.includes("<li>"), "no row");
  });

  test("50 at a time; 更多 links to the records before the last one listed, by its place in the proof log: one written meanwhile neither repeats a row nor skips one; a place that does not read lists from the latest", async () => {
    const pad = (n: number): string => String(n).padStart(2, "0");
    const recs = Array.from({ length: 52 }, (_, i) => r(`2026-10-${pad(1 + Math.floor(i / 3))}`, newCard(), `threads:a${pad(i)}`));
    await pagesWorld(worker, "2026-11-18", recs);
    const { page } = await getPage(worker, "/proof-log");
    assert.equal(rows(page), 50);
    assert.ok(page.includes("@a51") && page.includes("@a02") && !page.includes("@a01"));
    const more = /<a href="(\/proof-log\?after=[^"]*)">更多<\/a>/.exec(page);
    assert.ok(more !== null, "更多");
    // The place is the last row's: the seq of a02's record.
    assert.equal(unescapeHtml(more[1]!), "/proof-log?after=3");
    // A record written after the first page was opened: the next page is still the rest of the same list.
    const root = await publishCrl(worker, { issuer: "G3", number: parseDay("2026-11-18")!, thisUpdate: tw("2026-11-18", "05:00:00"), serials: [11, 12] });
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:a52"), "threads first");
    const next = (await getPage(worker, unescapeHtml(more[1]!))).page;
    assert.equal(rows(next), 2);
    wantLines(next, ["新宣告：Threads 的 @a01", "新宣告：Threads 的 @a00"]);
    notOnPage(next, "@a02", "@a52", "更多", empty());
    // The first page now starts with it.
    const again = (await getPage(worker, "/proof-log")).page;
    assert.equal(rows(again), 50);
    wantLines(again, ["@a52", "@a51"]);
    assert.ok(again.includes('<a href="/proof-log?after=4">更多</a>'));
    // Exactly 50 after a place: all of them, and no 更多 to a page with nothing on it.
    const fifty = (await getPage(worker, "/proof-log?after=51")).page;
    assert.equal(rows(fifty), 50);
    assert.ok(fifty.includes("@a49") && fifty.includes("@a00") && !fifty.includes("@a50"));
    notOnPage(fifty, "更多");
    for (const after of ["nothing", "0", "03", "+3", "-3", "3.0", "%203", "2026-10-01.3", "9007199254740992"]) {
      const bad = (await getPage(worker, `/proof-log?after=${after}`)).page;
      assert.ok(rows(bad) === 50 && bad.includes("@a52"), `after=${after}: from the latest`);
    }
    // After the first record: no row, and not the sentence of an empty proof log.
    const end = (await getPage(worker, "/proof-log?after=1")).page;
    assert.equal(rows(end), 0);
    notOnPage(end, empty(), "更多");
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
      // The place is before every record: read, it would leave the list empty.
      const { status, page } = await getPage(worker, `/proof-log?q=${q}&after=1`);
      assert.equal(status, 200, `q=${q}`);
      wantLines(page, ["查一個 Threads 帳號", "@查", bad, "現在有"]);
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
    wantLines((await getPage(worker, "/proof-log")).page, ["現在有 1 張島民證明，其中 1 張在過去三個月內過卡。", row("2026-11-20", CARD_A, "新宣告", "alice")]);
    await mustSubmit(worker, await sub(worker, card, root, "threads:bob"), "threads correction");
    wantLines((await getPage(worker, "/threads/@alice")).page, ["沒有自然人憑證把名額給這個帳號。"]);
    wantLines((await getPage(worker, "/threads/@bob")).page, ["有 1 張自然人憑證"]);
    const proofLog = (await getPage(worker, "/proof-log")).page;
    wantLines(proofLog, ["現在有 1 張島民證明", row("2026-11-20", CARD_A, "更正", "alice", "bob"), row("2026-11-20", CARD_A, "新宣告", "alice")]);
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
