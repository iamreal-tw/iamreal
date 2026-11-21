// The home page (/) and the page of a card (/p/<short ID>), through the
// Worker's HTTP (test/harness.ts): every sentence design/copy/ has for the
// case, in order, read from the copy files; the headers; the redirects and
// the 404s; and that what the roster's object writes shows on the next page.
// What every page shares (the production roster, escaping, the methods, the
// 404 page) is here for every page; the other pages are in
// test/lookup-pages.test.ts and test/site-pages.test.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { OG_DESCRIPTION, OG_SITE, OG_TITLE, TITLE_TAG, block, copyLines, copySection, faqQuestions, firstMatch, needs, notOnPage, previewOf, squash, testRosterLine, testSiteCardAddress, visibleText, wantLines, wantPreview } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { CARD_A, CARD_B, CLEARED_ON, cardStarting, checkVisitorHeaders, getPage, pagesWorld, r, testRosterMark, withScript } from "./pages.ts";
import { DAY_MS, START, freshRoster, mustSubmit, newCard, publishG3, sub } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

/**
 * The roster of the copy files' examples: card A has the history of
 * proof-page.md section 4 (now @alice, last card proof 2026-11-06, 12 days
 * before 2026-11-18); with `withB`, card B gives its place to @alice too.
 */
async function exampleCards(withB: boolean): Promise<void> {
  const a = cardStarting(CARD_A);
  const b = cardStarting(CARD_B);
  const recs = [r("2026-03-02", a, "threads:bob"), r("2026-05-10", a, "threads:bob"), r("2026-08-01", a, "threads:alice"), r("2026-09-01", b, "threads:alice"), r("2026-11-06", a, "threads:alice"), r("2026-11-15", b, "threads:alice")];
  await pagesWorld(worker, "2026-11-18", withB ? recs : recs.filter((x) => x.card === a));
}

/** The titles of proof-page.md section 8's three other cases: withdrawn, two cards, no card. */
function specialTitles(): string[] {
  const titles = [...copySection("proof-page.md", "8. ").matchAll(/標題是「([^」]+)」/g)].map((m) => m[1]!);
  assert.equal(titles.length, 3);
  return titles;
}

describe("the page of a card", () => {
  test("one card: sections 1 to 5a of proof-page.md, in order; its links, the profile, the preview", async () => {
    await exampleCards(true);
    const { status, page } = await getPage(worker, `/p/${CARD_A}`);
    assert.equal(status, 200);
    wantLines(page, ["1. ", "2. ", "3. ", "4. ", "5. ", "5a. "].flatMap((s) => copyLines(block("proof-page.md", s))));

    for (const link of ['<a href="/proof">我要更新這張證明</a>', '<a href="https://www.threads.com/@alice">Threads 的 @alice</a>', '<a href="/verify">怎麼驗證</a>', '<a class="button" href="/proof">我也要換島民證明</a>']) {
      assert.ok(page.includes(link), `the page has ${link}`);
    }
    // The address to look for on the profile is written, not a link. A test roster's site writes its own domain
    // (design/copy/test-site.md): that is where this card's page is.
    assert.equal(testSiteCardAddress(CARD_A), "test.iamreal.tw/p/7K2Q9FM4XD");
    assert.ok(page.includes(`<p class="backlink">${testSiteCardAddress(CARD_A)}</p>`));
    // The profile, embedded with no script of Threads and nothing sent with the request.
    assert.ok(
      page.includes('<iframe class="threads-profile" src="https://www.threads.com/@alice/embed/" title="Threads 個人檔案：@alice" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" credentialless></iframe>'),
      "the embedded profile",
    );
    assert.match(page, /<details class="history">\s*<summary>全部紀錄<\/summary>/, "全部紀錄 is folded");
    const { title, site } = previewOf("proof-page.md", "8. ");
    wantPreview(page, title, site);
    assert.ok(page.includes('<span class="account">@alice</span>'), "@alice is at the full size");
  });

  test("an account longer than 18 characters is written one size smaller", async () => {
    const c18 = cardStarting(CARD_A);
    const c19 = cardStarting(CARD_B);
    await pagesWorld(worker, "2026-11-18", [r("2026-11-01", c18, `threads:${"a".repeat(18)}`), r("2026-11-01", c19, `threads:${"a".repeat(19)}`)]);
    assert.ok((await getPage(worker, `/p/${CARD_A}`)).page.includes(`<span class="account">@${"a".repeat(18)}</span>`));
    assert.ok((await getPage(worker, `/p/${CARD_B}`)).page.includes(`<span class="account long">@${"a".repeat(19)}</span>`));
  });

  test("全部紀錄: every row of the table of section 4, the newest first", async () => {
    const e = cardStarting("E000000000");
    await pagesWorld(worker, "2026-11-18", [
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
    const table = new Map<string, string>();
    for (const line of copySection("proof-page.md", "4. ").split("\n")) {
      const cells = line.split("|");
      if (cells.length === 4 && !cells[1]!.startsWith("---") && cells[1]!.trim() !== "這一筆紀錄") table.set(cells[1]!.trim(), cells[2]!.trim());
    }
    assert.equal(table.size, 7, "the table of section 4 has the 7 rows this test writes");
    const row = (kind: string, date: string, ...accounts: string[]): string => {
      const words = table.get(kind);
      assert.ok(words !== undefined, `proof-page.md section 4 has a row ${kind}`);
      let i = 0;
      return words.replace(/\d{4}-\d{2}-\d{2}/, date).replace(/@[a-z0-9._]+/g, () => `@${accounts[i++]}`);
    };
    const { page } = await getPage(worker, "/p/E000000000");
    wantLines(page, [
      "全部紀錄",
      row("更正", "2026-10-08", "erin", "frank"),
      row("收回", "2026-10-08", "erin"),
      row("更換", "2026-10-08", "carol.tw", "erin"),
      row("收回之後宣告別的帳號", "2026-10-07", "dave", "carol.tw"),
      row("收回", "2026-10-06", "dave"),
      row("收回之後宣告回同一個帳號", "2026-10-05", "dave"),
      row("收回", "2026-10-04", "dave"),
      row("更正", "2026-10-03", "alice", "dave"),
      row("更換", "2026-10-03", "bob", "alice"),
      row("再次過卡", "2026-10-02"),
      row("新宣告", "2026-10-01", "bob"),
    ]);
    wantLines(page, copyLines(block("proof-page.md", "4. ").slice(0, 4), "2026-03-02", "2026-10-01", "4 次", "11 次", "1 次", "3 次"));
  });

  test("no switch is written as 0 switches; a last card proof today is written 今天", async () => {
    const c = cardStarting(CARD_A);
    await pagesWorld(worker, "2026-11-18", [r("2026-11-01", c, "threads:alice"), r("2026-11-06", c, "threads:alice")]);
    let { page } = await getPage(worker, `/p/${CARD_A}`);
    wantLines(page, copyLines(block("proof-page.md", "4. ", 1)));
    wantLines(page, copyLines(block("proof-page.md", "2. ", 0)));

    await pagesWorld(worker, "2026-11-18", [r("2026-11-18", c, "threads:alice")]);
    ({ page } = await getPage(worker, `/p/${CARD_A}`));
    wantLines(page, copyLines(block("proof-page.md", "2. ", 1)));
    notOnPage(page, "0 天前");
  });

  test("withdrawn from every account: section 6, then 4 and 5; the account is that of the latest withdrawal", async () => {
    const c = cardStarting(CARD_A);
    await pagesWorld(worker, "2026-11-18", [r("2026-11-01", c, "threads:alice"), r("2026-11-05", c), r("2026-11-10", c, "threads:bob"), r("2026-11-15", c)]);
    const { status, page } = await getPage(worker, `/p/${CARD_A}`);
    assert.equal(status, 200);
    wantLines(page, [
      ...copyLines(block("proof-page.md", "6. "), "@alice", "@bob"),
      ...copyLines(block("proof-page.md", "4. ").slice(0, 4), "2026-03-02", "2026-11-01", "4 次", "4 次"),
      ...copyLines(block("proof-page.md", "5. ")),
      ...copyLines(block("proof-page.md", "5a. ")),
    ]);
    // No account and scope of section 1, no section 3, no small lines of section 2 and no link to update.
    const one = block("proof-page.md", "1. ");
    const two = block("proof-page.md", "2. ");
    notOnPage(page, one[0]!, one[1]!, [...one[5]!].slice(0, 10).join(""), two[1]!, two[2]!, "我要更新這張證明", block("proof-page.md", "3. ")[0]!);
    assert.ok(!page.includes("<iframe"), "no profile on the page of a withdrawn card");
    wantPreview(page, specialTitles()[0]!, "島民證明 iamreal.tw");
  });

  test("a short ID of two cards: section 7, both in the order of their scoped IDs, each under as many characters as tell them apart; sections 5 and 5a once", async () => {
    const m1 = cardStarting("7K2Q9FM4XD3A");
    const m2 = cardStarting("7K2Q9FM4XD3B");
    await pagesWorld(worker, "2026-11-18", [r("2026-11-01", m2, "threads:bob"), r("2026-11-06", m1, "threads:alice"), r("2026-11-15", m2)]);
    const { status, page } = await getPage(worker, `/p/${CARD_A}`);
    assert.equal(status, 200);
    const each = block("proof-page.md", "7. ", 1);
    wantLines(page, [
      ...copyLines(block("proof-page.md", "7. ", 0)),
      ...copyLines(each, "7K2Q9FM4XD3A", "7K2Q9FM4XD3A"),
      ...copyLines(block("proof-page.md", "1. ")),
      ...copyLines(block("proof-page.md", "2. ")),
      ...copyLines(block("proof-page.md", "3. ")),
      ...copyLines(each, "7K2Q9FM4XD3A", "7K2Q9FM4XD3B"),
      ...copyLines(block("proof-page.md", "6. "), "@alice", "@bob"),
      ...copyLines(block("proof-page.md", "5. ")),
      ...copyLines(block("proof-page.md", "5a. ")),
    ]);
    const text = squash(visibleText(page));
    for (const section of ["5. ", "5a. "]) assert.equal(text.split(squash(copyLines(block("proof-page.md", section))[0]!)).length - 1, 1, `section ${section}once`);
    wantPreview(page, specialTitles()[1]!, "島民證明 iamreal.tw");
  });

  test("a short ID that resolves to no card, or does not read: 404 with section 9, what was typed written back; one that does not read is answered without the roster's object", async () => {
    await exampleCards(false);
    const unreadable = ["7K2Q9FM4X", "7K2Q9FM4XDD", "7K2Q9FM4XU", "7K2Q-FM4XD", "", "a/b"];
    for (const typed of ["7K2Q9FM4XE", ...unreadable]) {
      const { status, page } = await getPage(worker, `/p/${typed}`);
      assert.equal(status, 404, `/p/${typed}`);
      wantLines(page, copyLines(block("proof-page.md", "9. "), "7K2Q9FM4XD", typed));
      assert.ok(page.includes(`<span class="typed">${testSiteCardAddress(typed)}</span> 沒有對到任何一張自然人憑證。`), `/p/${typed}: the test site's own domain`);
      assert.ok(page.includes('<a href="/roster#q">查一個 Threads 帳號</a>'));
      wantPreview(page, specialTitles()[2]!, "島民證明 iamreal.tw");
    }

    // With an object that answers nothing (its tables are of another version), a short ID that reads is 500
    // and one that does not is still the 404: the Worker did not ask.
    await worker.roster.setStoredSchemaVersion("another");
    await worker.roster.restart();
    try {
      const logged = worker.logLines().length;
      const failed = await worker.fetch(`/p/${CARD_A}`);
      assert.equal(failed.status, 500);
      assert.equal(await failed.text(), "internal error\n");
      checkVisitorHeaders("a page that failed", failed, { cache: "no-store" });
      // The one line about it names the page, never the short ID.
      assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", page: "card", where: "schema", error: "Error" }]);
      assert.equal((await worker.fetch("/")).status, 500);
      for (const typed of unreadable) assert.equal((await getPage(worker, `/p/${typed}`)).status, 404, `/p/${typed}`);
    } finally {
      await worker.roster.setStoredSchemaVersion("the build's");
      await worker.roster.restart();
    }
  });

  test("a short ID in another spelling is redirected (301) to its one spelling, without the roster's object", async () => {
    await exampleCards(false);
    await worker.roster.setStoredSchemaVersion("another");
    await worker.roster.restart();
    try {
      for (const typed of ["7k2q9fm4xd", "7K2Q9FM4xD", "7K2Q9FM4XO", "7K2Q9FM4Xo", "IL2Q9FM4XD", "il2q9fm4xd"]) {
        const res = await worker.fetch(`/p/${typed}`, { redirect: "manual" });
        const to = typed.toUpperCase().replaceAll("O", "0").replace(/[IL]/g, "1");
        assert.deepEqual([res.status, res.headers.get("location")], [301, `/p/${to}`], `/p/${typed}`);
        checkVisitorHeaders(`/p/${typed}`, res, { cache: "public, max-age=60", more: ["location"] });
      }
    } finally {
      await worker.roster.setStoredSchemaVersion("the build's");
      await worker.roster.restart();
    }
    assert.equal((await getPage(worker, `/p/${CARD_A}`)).status, 200);
  });

  test("a record shows on the next page opened after it is written", async () => {
    await freshRoster(worker, { clearedOn: CLEARED_ON });
    const root = await publishG3(worker);
    const card = cardStarting(CARD_A);
    assert.equal((await getPage(worker, `/p/${CARD_A}`)).status, 404);
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    let { status, page } = await getPage(worker, `/p/${CARD_A}`);
    assert.equal(status, 200);
    wantLines(page, ["@alice", "上次過卡：今天（2026-11-20）", "過卡 1 次", "2026-11-20　新宣告：@alice"]);
    await mustSubmit(worker, await sub(worker, card, root, "threads:bob"), "threads correction");
    ({ status, page } = await getPage(worker, `/p/${CARD_A}`));
    wantLines(page, ["@bob", "過卡 2 次", "2026-11-20　更正：@alice 改成 @bob", "2026-11-20　新宣告：@alice"]);
    // An account on another platform of the test roster is not shown: the pages list Threads only.
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:bob"), "test-example first, threads refresh");
    ({ page } = await getPage(worker, `/p/${CARD_A}`));
    wantLines(page, ["過卡 3 次", "2026-11-20　再次過卡", "2026-11-20　更正：@alice 改成 @bob"]);
    notOnPage(page, "a-b");
  });
});

describe("the home page", () => {
  /** Three cards with an account now, two of them with a card proof in the last 90 days; one that withdrew. */
  async function homeWorld(): Promise<void> {
    const gone = newCard();
    await pagesWorld(worker, "2026-11-18", [
      r("2026-08-01", newCard(), "threads:carol"),
      r("2026-11-10", gone, "threads:dave"),
      r("2026-11-12", gone),
      r("2026-11-17", cardStarting(CARD_B), "threads:bob"),
      r("2026-11-18", cardStarting(CARD_A), "threads:alice"),
    ]);
  }

  test("every sentence of home.md, in order, with the seven answers of faq.md; its links, the preview", async () => {
    await homeWorld();
    const { status, page } = await getPage(worker, "/");
    assert.equal(status, 200);
    const six = copyLines(block("home.md", "6. "));
    assert.deepEqual([six.length, six[0], six[8]], [9, "常見問題", "更多常見問題"], "home.md section 6");
    const questions = faqQuestions();
    const answers = six.slice(1, 8).flatMap((q) => {
      const found = questions.find((f) => f.question === q);
      assert.ok(found !== undefined, `faq.md has the question ${q}`);
      return [q, ...copyLines(found.answer)];
    });
    wantLines(page, [
      ...copyLines(block("home.md", "導覽列")),
      ...copyLines(block("home.md", "1. ", 0)),
      ...copyLines(block("home.md", "1. ", 1)),
      ...copyLines(block("home.md", "2. "), "1,284", "3", "1,031", "2"),
      ...copyLines(block("home.md", "3. ")),
      ...copyLines(block("home.md", "4. ")),
      ...copyLines(block("home.md", "5. ", 0)),
      ...copyLines(block("home.md", "5. ", 1)),
      six[0]!,
      ...answers,
      six[8]!,
      ...copyLines(block("home.md", "7. ")),
      ...copyLines(block("home.md", "8. ")),
      ...copyLines(block("home.md", "9. ")),
    ]);

    for (const link of ['<a href="/roster">看已經換出的島民證明</a>', '<a href="/hang">掛到 Threads 的個人檔案上</a>', '<a href="/verify">零知識證明</a>', '<a href="/faq">更多常見問題</a>']) {
      assert.ok(page.includes(link), `the page has ${link}`);
    }
    // The one main action, in section 1 and section 8.
    assert.equal(page.split('<a class="button big" href="/proof">我要換島民證明</a>').length - 1, 2);
    // The seven questions fold, each its own <details>.
    for (const q of six.slice(1, 8)) assert.ok(page.includes(`<details><summary>${q}</summary>`), `${q} is a <details>`);
    assert.equal(page.split("<details>").length - 1, 7);
    // The small proof is not a link yet.
    const mini = /<div class="mini-proof">.*?<\/div>/s.exec(page)?.[0] ?? "";
    assert.ok(mini !== "" && !mini.includes("<a ") && !mini.includes("點進去看看"), "the small proof");
    // 〈需要什麼〉 twice: sections 1 and 8.
    assert.equal(squash(visibleText(page)).split(squash(needs())).length - 1, 2);

    const { title, site, summary } = previewOf("home.md", "連結被貼出去時的預覽");
    assert.equal(firstMatch(TITLE_TAG, page), "島民證明｜iamreal.tw");
    assert.ok(copySection("home.md", "連結被貼出去時的預覽").includes("`島民證明｜iamreal.tw`"), "home.md gives the <title>");
    assert.deepEqual([firstMatch(OG_TITLE, page), firstMatch(OG_SITE, page), firstMatch(OG_DESCRIPTION, page)], [title, site, summary]);
    const first = copyLines(block("home.md", "1. ", 0));
    assert.equal(summary, first[1]! + first[2]!, "the summary is the first screen's two lines");
  });

  test("the two numbers follow the roster: a declaration, a withdrawal, and a last card proof 90 and 91 days ago", async () => {
    await freshRoster(worker, { clearedOn: CLEARED_ON });
    const root = await publishG3(worker);
    const numbers = async (): Promise<string[]> => {
      const { page } = await getPage(worker, "/");
      const text = visibleText(page).replace(/\s+/g, " ");
      return [/現在有 ([\d,]+) 張島民證明/.exec(text)?.[1] ?? "", /其中 ([\d,]+) 張在過去三個月內過卡/.exec(text)?.[1] ?? ""];
    };
    wantLines((await getPage(worker, "/")).page, ["現在有 0 張島民證明", "其中 0 張在過去三個月內過卡"]);
    const a = newCard();
    await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads first");
    assert.deepEqual(await numbers(), ["1", "1"]);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    // A card with an account on another platform only is not one of them.
    await mustSubmit(worker, await sub(worker, newCard(), root, "test-example:a-b"), "test-example first");
    assert.deepEqual(await numbers(), ["2", "2"]);
    await mustSubmit(worker, await sub(worker, a, root), "threads withdraw");
    assert.deepEqual(await numbers(), ["1", "1"]);
    // 90 days after that card proof it still counts as recent; 91 days after, it does not. "Today" is Taiwan's date.
    await worker.setClock(new Date(START.getTime() + 90 * DAY_MS + 11 * 3600 * 1000));
    assert.deepEqual(await numbers(), ["1", "1"]);
    await worker.setClock(new Date(START.getTime() + 90 * DAY_MS + 12 * 3600 * 1000));
    assert.deepEqual(await numbers(), ["1", "0"]);
  });

  test("a number above 999 is written with a comma", async () => {
    // What the page does with a number is the page's, whatever the roster has: a roster of a thousand cards is not built here.
    const { thousands } = await import("../src/pages/html.ts");
    assert.deepEqual([0, 7, 999, 1000, 1284, 1234567].map(thousands), ["0", "7", "999", "1,000", "1,284", "1,234,567"]);
    assert.ok(block("home.md", "2. ").join("\n").includes("1,284"));
  });
});

describe("every page", () => {
  test("the production roster: no mark of a test roster and no noindex; the pages are otherwise the same", async () => {
    await pagesWorld(worker, "2026-11-18", [r("2026-11-06", cardStarting(CARD_A), "threads:alice")], { kind: "production" });
    for (const path of ["/", `/p/${CARD_A}`, "/p/7K2Q9FM4XE", "/threads/@alice", "/threads/@a-b", "/roster", "/faq", "/verify", "/hang", `/hang/${CARD_A}`]) {
      const { page } = await getPage(worker, path, { test: false });
      assert.ok(!page.includes("noindex") && !page.includes("上次清空"), path);
    }
    const card = (await getPage(worker, `/p/${CARD_A}`, { test: false })).page;
    wantLines(card, copyLines(block("proof-page.md", "1. ")));
    // The production site's domain, as proof-page.md writes it, in both places that write the page's address.
    assert.ok(card.includes('<p class="backlink">iamreal.tw/p/7K2Q9FM4XD</p>') && !card.includes("test.iamreal.tw"));
    const missing = (await getPage(worker, "/p/7K2Q9FM4XE", { test: false })).page;
    assert.ok(missing.includes('<span class="typed">iamreal.tw/p/7K2Q9FM4XE</span>') && !missing.includes("test.iamreal.tw"));
    const hang = (await getPage(worker, `/hang/${CARD_A}`, { test: false })).page;
    assert.ok(hang.includes('<p class="backlink">iamreal.tw/p/7K2Q9FM4XD</p>') && hang.includes('data-copy-text="https://iamreal.tw/p/7K2Q9FM4XD"') && !hang.includes("test.iamreal.tw"));
    const none = await getPage(worker, "/nothing", { test: false });
    assert.equal(none.status, 404);
    wantLines(none.page, copyLines(block("not-found.md", "頁面")));
    // The style sheet's headers are fixed when the Worker is uploaded: a production roster's site is in test/proof-files.test.ts.
  });

  test("the test roster: the mark says the date of the setting, as design/copy/test-site.md writes it", async () => {
    await freshRoster(worker, { clearedOn: "2026-12-31" });
    const page = await (await worker.fetch("/")).text();
    assert.ok(page.includes(testRosterMark("2026-12-31")));
    assert.equal(testRosterMark("2026-12-31"), '<p class="test-roster">測試名冊　不定期清空，上次清空：<time>2026-12-31</time></p>');
    assert.equal(testRosterLine("2026-12-31"), "測試名冊　不定期清空，上次清空：2026-12-31");
    // A date that is not one: the test site serves no page rather than a mark without its date.
    await freshRoster(worker, { clearedOn: "soon" });
    assert.equal((await worker.fetch("/")).status, 500);
    assert.equal((await worker.fetch("/p/7K2Q9FM4X")).status, 500);
    assert.equal((await worker.fetch("/nothing")).status, 500);
  });

  test("what the address has is escaped", async () => {
    await exampleCards(false);
    for (const path of ["/p/%3Cb%3Ex%22%27&amp;", "/p/javascript:alert(1)", "/p/%3Cscript%3Ealert(1)%3C/script%3E", "/p/%E5%B3%B6", "/threads/@%3Cb%3Ex%22%27", "/threads/@javascript:alert(1)", "/roster?q=%3Cb%3Ex%22%27"]) {
      const { status, page } = await getPage(worker, path);
      assert.equal(status, path.startsWith("/roster") ? 200 : 404, path);
      assert.ok(!page.includes("<b>x") && !page.includes(`x"'`) && !page.includes('href="javascript') && !page.includes('src="javascript'), `${path}: escaped`);
    }
    assert.ok((await getPage(worker, "/p/%3Cb%3Ex%22%27&amp;")).page.includes("test.iamreal.tw/p/&lt;b&gt;x&#34;&#39;&amp;amp;"));
    assert.ok((await getPage(worker, "/roster?q=%3Cb%3Ex%22")).page.includes('value="&lt;b&gt;x&#34;"'), "the lookup box's value is escaped");
    // The page for what is no page writes nothing of the address back.
    const none = (await getPage(worker, "/%3Cb%3Ex%22%27?q=%3Ci%3E")).page;
    assert.ok(!none.includes("<b>x") && !none.includes("&lt;b&gt;") && !none.includes("<i>") && !none.includes("&lt;i&gt;"));
  });

  test("the pages, the style sheet and the script take GET and HEAD only; HEAD has the headers of GET", async () => {
    await exampleCards(false);
    for (const path of ["/", `/p/${CARD_A}`, "/p/7K2Q9FM4XE", "/nothing", "/pages.css", "/threads/@alice", "/threads/@a-b", "/roster", "/faq", "/verify", "/hang", `/hang/${CARD_A}`, "/copy.js"]) {
      const file = path === "/pages.css" || path === "/copy.js";
      const cache = file ? "no-cache" : "public, max-age=60";
      const head = await worker.fetch(path, { method: "HEAD" });
      assert.equal(head.status, ["/p/7K2Q9FM4XE", "/nothing", "/threads/@a-b"].includes(path) ? 404 : 200, `HEAD ${path}`);
      assert.equal(await head.text(), "");
      checkVisitorHeaders(`HEAD ${path}`, head, { cache, script: withScript(path), more: path === "/copy.js" ? ["etag"] : [] });
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const res = await worker.fetch(path, { method });
        // The pages and the script are the Worker's; the style sheet is sent by Static Assets, whose 405 has no Allow.
        // A 405 runs no script: its policy is the pages' without one.
        assert.deepEqual([res.status, res.headers.get("allow")], [405, path === "/pages.css" ? null : "GET, HEAD"], `${method} ${path}`);
        checkVisitorHeaders(`${method} ${path}`, res, { cache: path === "/pages.css" ? "no-cache" : "no-store", more: ["allow"] });
      }
    }
  });

  test("the style sheet: the old back end's, sent by Static Assets without the Worker, with the pages' headers and an ETag to ask again by", async () => {
    await freshRoster(worker, { clearedOn: CLEARED_ON });
    await worker.seen();
    const res = await worker.fetch("/pages.css");
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "text/css; charset=utf-8"]);
    checkVisitorHeaders("/pages.css", res, { cache: "no-cache" });
    const css = await res.text();
    assert.ok(css.includes(".test-roster {") && css.includes(".threads-profile"));
    // The Go backend's, for as long as that one is in the repository, byte for byte but for one rule added after
    // the mark of a test roster: the date in it is not broken at a hyphen on a narrow screen.
    const added = `
/* The date beside it stays on one line: on a narrow screen the line breaks before the date, not at a hyphen in it. */
.test-roster time {
  white-space: nowrap;
}
`;
    assert.equal(css.split(added).length, 2, "the style sheet has the added rule once");
    assert.ok(css.includes(`  letter-spacing: 0.1em;\n}\n${added}\n[hidden] {`), "right after the rule of the mark");
    const old = join(WORKER_DIR, "..", "server", "pages", "style.css");
    if (existsSync(old)) assert.equal(css.replace(added, ""), readFileSync(old, "utf8"));
    // Nothing of another origin, and no script.
    assert.doesNotMatch(css, /url\(|@import|https?:|expression\(/i);
    const etag = res.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]+"$/);
    const again = await worker.fetch("/pages.css", { headers: { "If-None-Match": etag! } });
    assert.equal(again.status, 304);
    checkVisitorHeaders("/pages.css again", again, { cache: "no-cache" });
    assert.deepEqual(await worker.seen(), [], "the Worker's code ran for neither request");
  });

  test("what is not a page is the 404 page of design/copy/not-found.md, with what every page has; under /api/ it stays the API's answer", async () => {
    await freshRoster(worker, { clearedOn: CLEARED_ON });
    const lines = copyLines(block("not-found.md", "頁面"));
    assert.deepEqual(lines, ["找不到這一頁", "這個網址沒有對到任何頁面。請確認網址有沒有抄錯。", "回到首頁"]);
    // Among them what is near a page but none: a slash too many, another case, the old back end's /roster/ of the
    // roster's files (now on the data domain), a page of an account without its @.
    for (const path of ["/index.html", "/pages.css/", "/favicon.ico", "/P/7K2Q9FM4XD", "/p", "/FAQ", "/faq/", "/roster/", "/roster/fingerprints.jsonl", "/verify/", "/threads/alice", "/threads", "/copy.js/", "/nothing?q=1"]) {
      // getPage checks the headers (noindex among them), the mark of the test roster with its date, the navigation bar and the foot.
      const { status, page } = await getPage(worker, path);
      assert.equal(status, 404, path);
      wantLines(page, lines);
      assert.ok(page.includes('<h1 class="title">找不到這一頁</h1>') && page.includes('<a href="/">回到首頁</a>'), path);
      assert.equal(firstMatch(TITLE_TAG, page), "找不到這一頁｜島民證明");
      wantPreview(page, "找不到這一頁", "島民證明 iamreal.tw");
    }
    // The roster is not asked: with an object that answers nothing, the page is the same.
    await worker.roster.setStoredSchemaVersion("another");
    await worker.roster.restart();
    try {
      assert.equal((await getPage(worker, "/nothing")).status, 404);
    } finally {
      await worker.roster.setStoredSchemaVersion("the build's");
      await worker.roster.restart();
    }
    // Nothing but the pages is cached, and what is not there under /api/ is the API's own 404.
    for (const [path, method] of [["/api/v1/config", "GET"], ["/api/v1/challenges", "POST"], ["/api/v1/nothing", "GET"]] as const) {
      assert.equal((await worker.fetch(path, { method })).headers.get("cache-control"), "no-store", path);
    }
    const api = await worker.fetch("/api/v1/nothing");
    assert.deepEqual([api.status, api.headers.get("content-type"), api.headers.get("x-robots-tag")], [404, "application/json", null]);
  });
});
