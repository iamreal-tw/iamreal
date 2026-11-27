// The home page (/) and the page of a card (/p/<short ID>), through the
// Worker's HTTP (test/harness.ts): every sentence design/copy/ has for the
// case, in order, read from the copy files; the headers; the redirects and
// the 404s; and that what the proof log's object writes shows on the next page.
// What every page shares (the production log, escaping, the methods, the
// 404 page) is here for every page; the other pages are in
// test/lookup-pages.test.ts and test/site-pages.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { icoImages } from "../scripts/favicon.ts";
import { WORKER_DIR } from "./build.ts";
import { OG_DESCRIPTION, OG_SITE, OG_TITLE, TITLE_TAG, block, codeBlocks, copyLines, copySection, faqQuestions, firstMatch, needs, notOnPage, previewOf, squash, testProofLogLine, testSiteCardAddress, visibleText, wantLines, wantPreview } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { CARD_A, CARD_B, CLEARED_ON, FAVICON_PATH, FONT_PATH, OG_IMAGE_PATH, cardStarting, checkVisitorHeaders, getPage, pagesWorld, r, testProofLogMark } from "./pages.ts";
import { DAY_MS, START, wantNoAlarmSoon, freshProofLog, mustSubmit, newCard, publishG3, sub } from "./records.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

/**
 * The proof log of the copy files' examples: card A has the history of
 * proof-page.md section 4 (now @alice, last card proof 2026-11-06, 12 days
 * before 2026-11-18); with `withB`, card B gives its place to @alice too.
 */
async function exampleCards(withB: boolean): Promise<void> {
  const a = cardStarting(CARD_A);
  const b = cardStarting(CARD_B);
  const recs = [r("2026-03-02", a, "threads:bob"), r("2026-05-10", a, "threads:bob"), r("2026-08-01", a, "threads:alice"), r("2026-09-01", b, "threads:alice"), r("2026-11-06", a, "threads:alice"), r("2026-11-15", b, "threads:alice")];
  await pagesWorld(worker, "2026-11-18", withB ? recs : recs.filter((x) => x.card === a));
}

/** The replacements of the example ordinal of proof-page.md (128) by `n`. */
const ordinal = (n: number): string[] => ["第 128 張", `第 ${n} 張`];

/** The titles of proof-page.md section 8's three other cases: withdrawn, two cards, no card. */
function specialTitles(): string[] {
  const titles = [...copySection("proof-page.md", "8. ").matchAll(/標題是「([^」]+)」/g)].map((m) => m[1]!);
  assert.equal(titles.length, 3);
  return titles;
}

/**
 * Section 5 of the page of a card (proof-page.md): in the page's own content,
 * one link only of how to judge it, to /check, with section 5's words; none to
 * /verify; nowhere 驗證通過.
 */
function howToCheckOnce(what: string, page: string): void {
  const main = page.slice(page.indexOf("<main>"), page.indexOf("</main>"));
  const lines = copyLines(block("proof-page.md", "5. "));
  const words = lines[lines.length - 1]!;
  assert.ok(copySection("proof-page.md", "5. ").includes(`「${words}」是連結，連到「${words}」那一頁（\`check.md\`，\`/check\`）`), "proof-page.md: section 5's link goes to /check");
  assert.deepEqual([...main.matchAll(/<a\s[^>]*href="\/(check|verify)[^"]*"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], m[2]]), [["check", words]], `${what}: one link, to /check, in the page's content`);
  notOnPage(page, "驗證通過");
}

describe("the page of a card", () => {
  test("one card: sections 1 to 5a of proof-page.md, in order; its links, the profile, the preview", async () => {
    await exampleCards(true);
    const { status, page } = await getPage(worker, `/p/${CARD_A}`);
    assert.equal(status, 200);
    wantLines(page, ["1. ", "2. ", "3. ", "4. ", "5. ", "5a. "].flatMap((s) => copyLines(block("proof-page.md", s), ...ordinal(1))));
    // The ordinal above the title, in the secondary colour's small line; not beside the account (proof-page.md section 1).
    assert.ok(page.includes('<p class="ordinal">第 1 張島民證明</p>\n<h1 class="title">'), "the ordinal, right above the title");
    assert.ok(page.includes("<div><dt>順序</dt><dd>第 1 張島民證明</dd></div>"), "順序, the first row of section 4");
    assert.equal(page.split("第 1 張島民證明").length - 1, 2, "the ordinal twice, nowhere else");

    for (const link of ['<a href="/proof" data-count="start_card_proof">我要更新這張證明</a>', '<a href="https://www.threads.com/@alice">Threads 的 @alice</a>', `<a href="/hang/${CARD_A}">把它掛到個人檔案上</a>`, '<a class="button" href="/proof" data-count="start_card_proof">我也要換島民證明</a>']) {
      assert.ok(page.includes(link), `the page has ${link}`);
    }
    howToCheckOnce("one card", page);
    // The address to look for on the profile is written, not a link. A test log's site writes its own domain
    // (design/copy/test-site.md): that is where this card's page is.
    assert.equal(testSiteCardAddress(CARD_A), "test.iamreal.tw/p/7K2Q9FM4XD");
    // The profile, embedded with no script of Threads and nothing sent with the request, right under the address to compare
    // with it (proof-page.md section 3): nothing comes between the two.
    assert.ok(
      page.includes(
        `<p class="backlink">${testSiteCardAddress(CARD_A)}</p>\n<iframe class="threads-profile" src="https://www.threads.com/@alice/embed/" title="Threads 個人檔案：@alice" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" credentialless></iframe>`,
      ),
      "the address, and right under it the embedded profile",
    );
    assert.match(page, /<details class="history">\s*<summary>全部紀錄<\/summary>/, "全部紀錄 is folded");
    const { title, site } = previewOf("proof-page.md", "8. ");
    wantPreview(page, title, site);
    assert.ok(page.includes('<span class="account">@alice</span>'), "@alice is at the full size");
  });

  test("an account longer than 12 characters is written one size smaller, on the page of a card and that of the account", async () => {
    const c12 = cardStarting(CARD_A);
    const c13 = cardStarting(CARD_B);
    await pagesWorld(worker, "2026-11-18", [r("2026-11-01", c12, `threads:${"a".repeat(12)}`), r("2026-11-01", c13, `threads:${"a".repeat(13)}`)]);
    assert.ok((await getPage(worker, `/p/${CARD_A}`)).page.includes(`<span class="account">@${"a".repeat(12)}</span>`));
    assert.ok((await getPage(worker, `/p/${CARD_B}`)).page.includes(`<span class="account long">@${"a".repeat(13)}</span>`));
    // The page of an account writes it at the same size (account-page.md).
    assert.ok((await getPage(worker, `/threads/@${"a".repeat(12)}`)).page.includes(`<span class="account">@${"a".repeat(12)}</span>`));
    assert.ok((await getPage(worker, `/threads/@${"a".repeat(13)}`)).page.includes(`<span class="account long">@${"a".repeat(13)}</span>`));
  });

  test("全部紀錄: every row of the table of section 4, the newest first", async () => {
    const e = cardStarting("E000000000");
    await pagesWorld(worker, "2026-11-18", [
      r("2026-10-01", e, "threads:bob"),
      r("2026-10-02", e, "threads:bob"),
      r("2026-10-03", e, "threads:alice"),
      r("2026-10-03", e, "threads:dave"), // another on the day of a switch: a switch too
      r("2026-10-04", e), // a withdrawal
      r("2026-10-05", e, "threads:dave"), // declared again
      r("2026-10-06", e),
      r("2026-10-07", e, "threads:carol.tw"), // another, after a withdrawal: a switch
      r("2026-10-08", e, "threads:erin"),
      r("2026-10-08", e),
      r("2026-10-08", e, "threads:frank"), // another, after a withdrawal, the day of a switch: a switch too
    ]);
    const table = new Map<string, string>();
    for (const line of copySection("proof-page.md", "4. ").split("\n")) {
      const cells = line.split("|");
      if (cells.length === 4 && !cells[1]!.startsWith("---") && cells[1]!.trim() !== "這一筆紀錄") table.set(cells[1]!.trim(), cells[2]!.trim());
    }
    // 更正 is a row no record has had since version 3 of the record rules (ADR-0018); the copy loses it in #510.
    assert.equal(table.size, 7, "the table of section 4 has the 6 rows this test writes, and 更正");
    const row = (kind: string, date: string, ...accounts: string[]): string => {
      const words = table.get(kind);
      assert.ok(words !== undefined, `proof-page.md section 4 has a row ${kind}`);
      let i = 0;
      return words.replace(/\d{4}-\d{2}-\d{2}/, date).replace(/@[a-z0-9._]+/g, () => `@${accounts[i++]}`);
    };
    const { page } = await getPage(worker, "/p/E000000000");
    wantLines(page, [
      "全部紀錄",
      row("收回之後宣告別的帳號", "2026-10-08", "erin", "frank"),
      row("收回", "2026-10-08", "erin"),
      row("更換", "2026-10-08", "carol.tw", "erin"),
      row("收回之後宣告別的帳號", "2026-10-07", "dave", "carol.tw"),
      row("收回", "2026-10-06", "dave"),
      row("收回之後宣告回同一個帳號", "2026-10-05", "dave"),
      row("收回", "2026-10-04", "dave"),
      row("更換", "2026-10-03", "alice", "dave"),
      row("更換", "2026-10-03", "bob", "alice"),
      row("再次過卡", "2026-10-02"),
      row("新宣告", "2026-10-01", "bob"),
    ]);
    wantLines(page, copyLines(block("proof-page.md", "4. ").slice(0, 5), ...ordinal(1), "2026-03-02", "2026-10-01", "4 次", "11 次", "1 次", "5 次"));
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
      ...copyLines(block("proof-page.md", "6. "), ...ordinal(1), "@alice", "@bob"),
      ...copyLines(block("proof-page.md", "4. ").slice(0, 5), ...ordinal(1), "2026-03-02", "2026-11-01", "4 次", "4 次"),
      ...copyLines(block("proof-page.md", "5. ")),
      ...copyLines(block("proof-page.md", "5a. ")),
    ]);
    // No account and scope of section 1, no section 3, no small lines of section 2 and no link to update.
    const one = block("proof-page.md", "1. ");
    const two = block("proof-page.md", "2. ");
    const three = block("proof-page.md", "3. ");
    notOnPage(page, one[2]!, one[3]!, [...one[7]!].slice(0, 10).join(""), two[1]!, "我要更新這張證明", three[0]!, three.at(-1)!);
    assert.ok(!page.includes("<iframe"), "no profile on the page of a withdrawn card");
    howToCheckOnce("withdrawn", page);
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
      ...copyLines(block("proof-page.md", "1. "), ...ordinal(2)),
      ...copyLines(block("proof-page.md", "2. ")),
      ...copyLines(block("proof-page.md", "3. ")),
      ...copyLines(each, "7K2Q9FM4XD3A", "7K2Q9FM4XD3B"),
      ...copyLines(block("proof-page.md", "6. "), ...ordinal(1), "@alice", "@bob"),
      ...copyLines(block("proof-page.md", "5. ")),
      ...copyLines(block("proof-page.md", "5a. ")),
    ]);
    const text = squash(visibleText(page));
    // Each section by its longest line: a short line may be in the navigation bar or the foot too.
    const longest = (lines: string[]): string => lines.reduce((a, b) => (b.length > a.length ? b : a));
    for (const section of ["5. ", "5a. "]) assert.equal(text.split(squash(longest(copyLines(block("proof-page.md", section))))).length - 1, 1, `section ${section}once`);
    wantPreview(page, specialTitles()[1]!, "島民證明 iamreal.tw");
    howToCheckOnce("two cards", page);
  });

  test("a short ID that resolves to no card, or does not read: 404 with section 9, what was typed written back; one that does not read is answered without the proof log's object", async () => {
    await exampleCards(false);
    const unreadable = ["7K2Q9FM4X", "7K2Q9FM4XDD", "7K2Q9FM4XU", "7K2Q-FM4XD", "", "a/b"];
    for (const typed of ["7K2Q9FM4XE", ...unreadable]) {
      const { status, page } = await getPage(worker, `/p/${typed}`);
      assert.equal(status, 404, `/p/${typed}`);
      wantLines(page, copyLines(block("proof-page.md", "9. "), "7K2Q9FM4XD", typed));
      assert.ok(page.includes(`<span class="typed">${testSiteCardAddress(typed)}</span> 沒有對到任何一張自然人憑證。`), `/p/${typed}: the test site's own domain`);
      assert.ok(page.includes('<a href="/proof-log#q">查一個 Threads 帳號</a>'));
      wantPreview(page, specialTitles()[2]!, "島民證明 iamreal.tw");
    }

    // With an object that answers nothing (its tables are of another version), a short ID that reads is 500
    // and one that does not is still the 404: the Worker did not ask. No alarm rings meanwhile: the lines below are the page's alone.
    await wantNoAlarmSoon(worker);
    await worker.proofLog.setStoredSchemaVersion("another");
    await worker.proofLog.restart();
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
      await worker.proofLog.setStoredSchemaVersion("the build's");
      await worker.proofLog.restart();
    }
  });

  test("a short ID in another spelling is redirected (301) to its one spelling, without the proof log's object", async () => {
    await exampleCards(false);
    await worker.proofLog.setStoredSchemaVersion("another");
    await worker.proofLog.restart();
    try {
      for (const typed of ["7k2q9fm4xd", "7K2Q9FM4xD", "7K2Q9FM4XO", "7K2Q9FM4Xo", "IL2Q9FM4XD", "il2q9fm4xd"]) {
        const res = await worker.fetch(`/p/${typed}`, { redirect: "manual" });
        const to = typed.toUpperCase().replaceAll("O", "0").replace(/[IL]/g, "1");
        assert.deepEqual([res.status, res.headers.get("location")], [301, `/p/${to}`], `/p/${typed}`);
        checkVisitorHeaders(`/p/${typed}`, res, { cache: "public, max-age=60", more: ["location"] });
      }
    } finally {
      await worker.proofLog.setStoredSchemaVersion("the build's");
      await worker.proofLog.restart();
    }
    assert.equal((await getPage(worker, `/p/${CARD_A}`)).status, 200);
  });

  test("a record shows on the next page opened after it is written", async () => {
    await freshProofLog(worker, { clearedOn: CLEARED_ON });
    const root = await publishG3(worker);
    const card = cardStarting(CARD_A);
    assert.equal((await getPage(worker, `/p/${CARD_A}`)).status, 404);
    await mustSubmit(worker, await sub(worker, card, root, "threads:alice"), "threads first");
    let { status, page } = await getPage(worker, `/p/${CARD_A}`);
    assert.equal(status, 200);
    wantLines(page, ["@alice", "上次過卡：今天（2026-11-20）", "過卡次數 1 次", "2026-11-20　新宣告：@alice"]);
    await mustSubmit(worker, await sub(worker, card, root, "threads:bob"), "threads switch");
    ({ status, page } = await getPage(worker, `/p/${CARD_A}`));
    wantLines(page, ["@bob", "過卡次數 2 次", "2026-11-20　更換：@alice 改成 @bob", "2026-11-20　新宣告：@alice"]);
    // An account on another platform of the test log is not shown: the pages list Threads only.
    await mustSubmit(worker, await sub(worker, card, root, "test-example:a-b", "threads:bob"), "test-example first, threads refresh");
    ({ page } = await getPage(worker, `/p/${CARD_A}`));
    wantLines(page, ["過卡次數 3 次", "2026-11-20　再次過卡", "2026-11-20　更換：@alice 改成 @bob"]);
    notOnPage(page, "a-b");
  });
});

/** The sections of home.md the home page shows, in its order: the navigation bar and the foot are every page's. */
const HOME_SECTIONS = ["導覽列", "第一屏", "為什麼", "不必公開你是誰", "一起能改變什麼", "常見問題", "結尾", "頁尾"];

/** The question of faq.md with this id and its answer, as lines of the page. */
function homeQuestion(faq: ReturnType<typeof faqQuestions>, id: string): string[] {
  const q = faq.find((f) => f.id === id);
  assert.ok(q !== undefined, `faq.md has a question with the id ${id}`);
  return [q.question, ...copyLines(q.answer)];
}

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

  test("every sentence of home.md, in order, with the eight answers of faq.md; its links, its figures, the preview", async () => {
    await homeWorld();
    const { status, page } = await getPage(worker, "/");
    assert.equal(status, 200);
    const faq = faqQuestions();
    const want: string[] = [];
    for (const section of HOME_SECTIONS) {
      const blocks = codeBlocks(copySection("home.md", section));
      if (section === "常見問題") {
        // The heading and the link to the FAQ around the eight questions, each with its answer in faq.md.
        const [around, ids] = blocks;
        const [heading, more] = copyLines(around!);
        assert.equal(ids!.length, 8, "home.md 常見問題 lists eight questions");
        want.push(heading!, ...ids!.flatMap((id) => homeQuestion(faq, id)), more!);
        continue;
      }
      // The navigation bar and the foot as on a wide screen (the narrow one: test/pages.ts, checkNavAndFoot).
      if (section === "導覽列" || section === "頁尾") {
        want.push(...copyLines(blocks[0]!));
        continue;
      }
      // The example numbers of 一起能改變什麼 are this proof log's.
      for (const b of blocks) want.push(...copyLines(b, ...(section === "一起能改變什麼" ? ["1,284", "3", "1,031", "2"] : [])));
    }
    wantLines(page, want);
    // What #335 took out of home.md: no longer in the copy file, so written here once, to be sure they left the page too.
    notOnPage(
      page,
      "一起建立更值得信任的網路環境。",
      "讓人以為大家都在用。",
      "這些帳號背後是不是真的有那麼多人，只讀內容分不出來。",
      "在 Threads 只能替一個帳號背書。",
      "其他服務可以建立在島民證明上。",
      "島民證明只代表有一個自然人憑證宣稱持有某帳號",
      "這個比例不代表台灣民意",
      "你今天換的這張證明，不只是給自己看的。",
      "怎麼換",
    );

    for (const [href, words] of [
      ["/proof-log", "看其他人的島民證明"],
      ["/proof", "更新我的島民證明"],
      ["/proof-log", "看一張島民證明的樣子"],
      ["/faq", "更多常見問題"],
      ["/hang", "用你的帳號承認這張證明"],
    ]) {
      assert.match(page, new RegExp(`<a (class="[^"]*" )?href="${href}"( data-count="start_card_proof")?>${words}</a>`), `the page links ${words} to ${href}`);
    }
    // The one main action, on the first screen and at the end.
    assert.equal(page.split('<a class="button big" href="/proof" data-count="start_card_proof">我要換島民證明</a>').length - 1, 2);
    // The eight questions fold, each its own <details>, in home.md's order.
    const ids = codeBlocks(copySection("home.md", "常見問題"))[1]!;
    const summaries = [...page.matchAll(/<details><summary>([^<]*)<\/summary>/g)].map((m) => m[1]);
    assert.deepEqual(summaries, ids.map((id) => faq.find((q) => q.id === id)!.question));
    // The ratio bar: two of the three cards with an account had a card proof in the last three months.
    assert.match(page, /<rect class="part" width="66.7%"/);
    // 〈需要什麼〉 once, on the first screen.
    assert.equal(squash(visibleText(page)).split(squash(needs())).length - 1, 1);
    assert.ok(block("home.md", "第一屏").includes("〈需要什麼〉"));

    // Each figure: one sentence for a screen reader, its dots hidden from it.
    for (const [section, n] of [["第一屏", 1], ["不必公開你是誰", 1], ["一起能改變什麼", 2]] as const) {
      const said = block("home.md", section, n);
      assert.equal(said.length, 1, `home.md ${section}: a figure's one sentence`);
      assert.ok(page.includes(`<figcaption class="sr">${said[0]}</figcaption>`), `${section}: the figure says ${said[0]}`);
    }
    const svgs = [...page.slice(page.indexOf("<main>")).matchAll(/<svg\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(svgs.length >= 3, "the dots are drawn");
    for (const svg of svgs) assert.match(svg, /aria-hidden="true"/, "a screen reader does not read the dots");

    const { title, site, summary } = previewOf("home.md", "連結被貼出去時的預覽");
    assert.equal(firstMatch(TITLE_TAG, page), "島民證明｜iamreal.tw");
    assert.ok(copySection("home.md", "連結被貼出去時的預覽").includes("`島民證明｜iamreal.tw`"), "home.md gives the <title>");
    assert.deepEqual([firstMatch(OG_TITLE, page), firstMatch(OG_SITE, page), firstMatch(OG_DESCRIPTION, page)], [title, site, summary]);
    const first = copyLines(block("home.md", "第一屏"));
    assert.equal(summary, first[1]! + first[2]! + first[3]!, "the summary is the headline and the first line under it");
  });

  test("the two numbers follow the proof log: a declaration, a withdrawal, and a last card proof 90 and 91 days ago", async () => {
    await freshProofLog(worker, { clearedOn: CLEARED_ON });
    const root = await publishG3(worker);
    const numbers = async (): Promise<string[]> => {
      const { page } = await getPage(worker, "/");
      const text = visibleText(page).replace(/\s+/g, " ");
      // The ratio bar: as long as the first number, its filled part the second (home.md, 一起能改變什麼).
      const filled = /<svg class="ratio"[^>]*>.*?<rect class="part" width="([^"]*)"/s.exec(page)?.[1] ?? "";
      return [/現在有 ([\d,]+) 張島民證明/.exec(text)?.[1] ?? "", /其中 ([\d,]+) 張在過去三個月內過卡/.exec(text)?.[1] ?? "", filled];
    };
    wantLines((await getPage(worker, "/")).page, ["現在有 0 張島民證明", "其中 0 張在過去三個月內過卡"]);
    // No card yet: the bar is all track.
    assert.deepEqual(await numbers(), ["0", "0", "0%"]);
    const a = newCard();
    await mustSubmit(worker, await sub(worker, a, root, "threads:alice"), "threads first");
    assert.deepEqual(await numbers(), ["1", "1", "100%"]);
    await mustSubmit(worker, await sub(worker, newCard(), root, "threads:alice"), "threads first");
    // A card with an account on another platform only is not one of them.
    await mustSubmit(worker, await sub(worker, newCard(), root, "test-example:a-b"), "test-example first");
    assert.deepEqual(await numbers(), ["2", "2", "100%"]);
    await mustSubmit(worker, await sub(worker, a, root), "threads withdraw");
    assert.deepEqual(await numbers(), ["1", "1", "100%"]);
    // 90 days after that card proof it still counts as recent; 91 days after, it does not. "Today" is Taiwan's date.
    await worker.setClock(new Date(START.getTime() + 90 * DAY_MS + 11 * 3600 * 1000));
    assert.deepEqual(await numbers(), ["1", "1", "100%"]);
    await worker.setClock(new Date(START.getTime() + 90 * DAY_MS + 12 * 3600 * 1000));
    assert.deepEqual(await numbers(), ["1", "0", "0%"]);
  });

  test("the first screen's dots: the 15 placed by hand and 你 where they were; from column 32 to 119, teal dots in every 8 columns, at most one in each block of 8 by 7", async () => {
    // #335, 首頁: the dots of the final design stay; a wide window shows teal dots at its right too.
    await homeWorld();
    const placed = [[9, 4], [21, 6], [30, 9], [11, 13], [26, 2], [17, 17], [31, 19], [8, 23], [23, 24], [28, 29], [11, 31], [19, 34], [30, 35], [4, 8], [20, 12]];
    /** The column and row of each dot of the first screen (design/tokens.json, --dot-pitch: 18px, the first at 9). */
    const heroDots = async (): Promise<{ proof: number[][]; you: number[][] }> => {
      const { page } = await getPage(worker, "/");
      const svg = /<figure class="hero-field">[\s\S]*?<svg[^>]*>([\s\S]*?)<\/svg>/.exec(page)?.[1] ?? "";
      const cells = (cls: string): number[][] =>
        [...svg.matchAll(new RegExp(`<circle class="${cls}" cx="(\\d+)" cy="(\\d+)"`, "g"))].map((m) => [(Number(m[1]) - 9) / 18, (Number(m[2]) - 9) / 18]);
      return { proof: cells("proof"), you: cells("you") };
    };
    const { proof, you } = await heroDots();
    assert.deepEqual(you, [[14, 11]], "你");
    const byHand = proof.filter(([c]) => c! < 32);
    assert.deepEqual(byHand, placed, "the dots placed by hand");
    const added = proof.filter(([c]) => c! >= 32);
    // A wide first screen is 691px high (design/screens/home-desktop.png): rows 0 to 37 show whole, none is cut by its lower edge.
    for (const [c, r] of added) assert.ok(Number.isInteger(c) && Number.isInteger(r) && c! <= 119 && r! >= 0 && r! <= 37, `a dot on the grid, from column 32 to 119, row 0 to 37: ${c}, ${r}`);
    for (let band = 32; band < 120; band += 8) assert.ok(added.some(([c]) => c! >= band && c! < band + 8), `a teal dot in columns ${band} to ${band + 7}`);
    const blocks = added.map(([c, r]) => `${Math.floor((c! - 32) / 8)},${Math.floor(r! / 7)}`);
    assert.equal(new Set(blocks).size, blocks.length, "at most one dot in each block of 8 columns by 7 rows");
  });

  test("a number above 999 is written with a comma", async () => {
    // What the page does with a number is the page's, whatever the proof log has: a proof log of a thousand cards is not built here.
    const { thousands } = await import("../src/pages/html.ts");
    assert.deepEqual([0, 7, 999, 1000, 1284, 1234567].map(thousands), ["0", "7", "999", "1,000", "1,284", "1,234,567"]);
    assert.ok(block("home.md", "一起能改變什麼", 1).join("\n").includes("1,284"));
  });
});

describe("every page", () => {
  test("the production log: no mark of a test log and no noindex; the pages are otherwise the same", async () => {
    await pagesWorld(worker, "2026-11-18", [r("2026-11-06", cardStarting(CARD_A), "threads:alice")], { kind: "production" });
    for (const path of ["/", `/p/${CARD_A}`, "/p/7K2Q9FM4XE", "/threads/@alice", "/threads/@a-b", "/proof-log", "/faq", "/verify", "/check", "/prepare", "/privacy", "/hang", `/hang/${CARD_A}`]) {
      const { page } = await getPage(worker, path, { test: false });
      assert.ok(!page.includes("noindex") && !page.includes("上次清空"), path);
    }
    const card = (await getPage(worker, `/p/${CARD_A}`, { test: false })).page;
    wantLines(card, copyLines(block("proof-page.md", "1. "), ...ordinal(1)));
    // The production site's domain, as proof-page.md writes it, in both places that write the page's address.
    assert.ok(card.includes('<p class="backlink">iamreal.tw/p/7K2Q9FM4XD</p>') && !card.includes("test.iamreal.tw"));
    const missing = (await getPage(worker, "/p/7K2Q9FM4XE", { test: false })).page;
    assert.ok(missing.includes('<span class="typed">iamreal.tw/p/7K2Q9FM4XE</span>') && !missing.includes("test.iamreal.tw"));
    const hang = (await getPage(worker, `/hang/${CARD_A}`, { test: false })).page;
    assert.ok(hang.includes('<p class="backlink">iamreal.tw/p/7K2Q9FM4XD</p>') && hang.includes('data-copy-text="https://iamreal.tw/p/7K2Q9FM4XD"') && !hang.includes("test.iamreal.tw"));
    const check = (await getPage(worker, "/check", { test: false })).page;
    assert.ok(check.includes("網域要一字不差是 iamreal.tw。") && check.includes("iamreal.tw/p/7K2Q9FM4XD") && !check.includes("test.iamreal.tw"), "/check writes the production site's domain");
    const none = await getPage(worker, "/nothing", { test: false });
    assert.equal(none.status, 404);
    wantLines(none.page, copyLines(block("not-found.md", "頁面")));
    // The style sheet's headers are fixed when the Worker is uploaded: a production log's site is in test/proof-files.test.ts.
  });

  test("the test log: the mark says the date of the setting, as design/copy/test-site.md writes it", async () => {
    await freshProofLog(worker, { clearedOn: "2026-12-31" });
    const page = await (await worker.fetch("/")).text();
    assert.ok(page.includes(testProofLogMark("2026-12-31")));
    assert.equal(testProofLogMark("2026-12-31"), '<p class="test-proof-log">測試的證明紀錄　不定期清空，上次清空：<time>2026-12-31</time></p>');
    assert.equal(testProofLogLine("2026-12-31"), "測試的證明紀錄　不定期清空，上次清空：2026-12-31");
    // A date that is not one: the test site serves no page rather than a mark without its date.
    await freshProofLog(worker, { clearedOn: "soon" });
    assert.equal((await worker.fetch("/")).status, 500);
    assert.equal((await worker.fetch("/p/7K2Q9FM4X")).status, 500);
    assert.equal((await worker.fetch("/nothing")).status, 500);
  });

  test("what the address has is escaped", async () => {
    await exampleCards(false);
    for (const path of ["/p/%3Cb%3Ex%22%27&amp;", "/p/javascript:alert(1)", "/p/%3Cscript%3Ealert(1)%3C/script%3E", "/p/%E5%B3%B6", "/threads/@%3Cb%3Ex%22%27", "/threads/@javascript:alert(1)", "/proof-log?q=%3Cb%3Ex%22%27"]) {
      const { status, page } = await getPage(worker, path);
      assert.equal(status, path.startsWith("/proof-log") ? 200 : 404, path);
      assert.ok(!page.includes("<b>x") && !page.includes(`x"'`) && !page.includes('href="javascript') && !page.includes('src="javascript'), `${path}: escaped`);
    }
    assert.ok((await getPage(worker, "/p/%3Cb%3Ex%22%27&amp;")).page.includes("test.iamreal.tw/p/&lt;b&gt;x&#34;&#39;&amp;amp;"));
    assert.ok((await getPage(worker, "/proof-log?q=%3Cb%3Ex%22")).page.includes('value="&lt;b&gt;x&#34;"'), "the lookup box's value is escaped");
    // A NUL is written as U+FFFD, as the Go backend's html/template wrote it, in text and in a value.
    for (const [path, want] of [["/p/a%00b", "test.iamreal.tw/p/a\uFFFDb"], ["/proof-log?q=a%00b", 'value="a\uFFFDb"']] as const) {
      const { page } = await getPage(worker, path);
      assert.ok(page.includes(want) && !page.includes("\0"), `${path}: the NUL is U+FFFD`);
    }
    // The page for what is no page writes nothing of the address back.
    const none = (await getPage(worker, "/%3Cb%3Ex%22%27?q=%3Ci%3E")).page;
    assert.ok(!none.includes("<b>x") && !none.includes("&lt;b&gt;") && !none.includes("<i>") && !none.includes("&lt;i&gt;"));
  });

  test("the pages, the style sheet, the script, the typeface, the link preview's image and the icon take GET and HEAD only; HEAD has the headers of GET", async () => {
    await exampleCards(false);
    for (const path of ["/", `/p/${CARD_A}`, "/p/7K2Q9FM4XE", "/nothing", "/pages.css", "/threads/@alice", "/threads/@a-b", "/proof-log", "/faq", "/verify", "/check", "/prepare", "/privacy", "/hang", `/hang/${CARD_A}`, "/copy.js", "/count.js", FONT_PATH, OG_IMAGE_PATH, FAVICON_PATH]) {
      // The style sheet, the scripts, the typeface, the image and the icon are files of Static Assets.
      const file = path === "/pages.css" || path === "/copy.js" || path === "/count.js" || path === FONT_PATH || path === OG_IMAGE_PATH || path === FAVICON_PATH;
      const cache = file ? "no-cache" : "public, max-age=60";
      const head = await worker.fetch(path, { method: "HEAD" });
      const found = !["/p/7K2Q9FM4XE", "/nothing", "/threads/@a-b"].includes(path);
      assert.equal(head.status, found ? 200 : 404, `HEAD ${path}`);
      assert.equal(await head.text(), "");
      // A page that is found loads the counts' script (and some another); a file, or a page that is not found, none.
      checkVisitorHeaders(`HEAD ${path}`, head, { cache, script: found && !file });
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const res = await worker.fetch(path, { method });
        // The pages are the Worker's; the style sheet, the script, the typeface and the image are sent by Static Assets, whose 405 has no
        // Allow. A 405 runs no script: its policy is the pages' without one.
        assert.deepEqual([res.status, res.headers.get("allow")], [405, file ? null : "GET, HEAD"], `${method} ${path}`);
        checkVisitorHeaders(`${method} ${path}`, res, { cache: file ? "no-cache" : "no-store", more: ["allow"] });
      }
    }
  });

  test("the style sheet: site/pages.css, sent by Static Assets without the Worker, with the pages' headers and an ETag to ask again by", async () => {
    await freshProofLog(worker, { clearedOn: CLEARED_ON });
    await worker.seen();
    const res = await worker.fetch("/pages.css");
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "text/css; charset=utf-8"]);
    checkVisitorHeaders("/pages.css", res, { cache: "no-cache" });
    const css = await res.text();
    assert.equal(css, readFileSync(join(WORKER_DIR, "site", "pages.css"), "utf8"));
    // Nothing of another origin, and no script: the one address is the typeface of this site (test/style-sheet.test.ts).
    assert.doesNotMatch(css, /@import|https?:|expression\(/i);
    assert.deepEqual([...css.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]), [`"${FONT_PATH}"`]);
    const etag = res.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]+"$/);
    const again = await worker.fetch("/pages.css", { headers: { "If-None-Match": etag! } });
    assert.equal(again.status, 304);
    checkVisitorHeaders("/pages.css again", again, { cache: "no-cache" });
    assert.deepEqual(await worker.seen(), [], "the Worker's code ran for neither request");
  });

  test("the typeface: the subset of design/fonts/, sent by Static Assets without the Worker, with the pages' headers and an ETag to ask again by", async () => {
    await freshProofLog(worker, { clearedOn: CLEARED_ON });
    await worker.seen();
    const res = await worker.fetch(FONT_PATH);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^font\/woff2\b/);
    checkVisitorHeaders(FONT_PATH, res, { cache: "no-cache" });
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(WORKER_DIR, "..", "design", "fonts", "GenRyuMin2TW-B.woff2"))), "the subset of design/fonts/, byte for byte");
    const etag = res.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]+"$/);
    const again = await worker.fetch(FONT_PATH, { headers: { "If-None-Match": etag! } });
    assert.equal(again.status, 304);
    checkVisitorHeaders(`${FONT_PATH} again`, again, { cache: "no-cache" });
    // Nothing else under /fonts/ is a file, and the Worker does not answer for it either.
    assert.equal((await worker.fetch("/fonts/GenRyuMin2TW-R.woff2")).status, 404);
    assert.deepEqual(await worker.seen(), [], "the Worker's code ran for none of the requests");
  });

  test("the link preview's image: design/screens/og-image.png, 1200 by 630, sent by Static Assets without the Worker, with the pages' headers and an ETag to ask again by", async () => {
    await freshProofLog(worker, { clearedOn: CLEARED_ON });
    await worker.seen();
    const res = await worker.fetch(OG_IMAGE_PATH);
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "image/png"]);
    checkVisitorHeaders(OG_IMAGE_PATH, res, { cache: "no-cache" });
    const png = Buffer.from(await res.arrayBuffer());
    assert.ok(png.equals(readFileSync(join(WORKER_DIR, "..", "design", "screens", "og-image.png"))), "design/screens/og-image.png, byte for byte");
    // The PNG signature, then the IHDR chunk: its width and height (https://www.w3.org/TR/png-3/#11IHDR). The pages say the same.
    assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.toString("latin1", 12, 16) === "IHDR", "a PNG");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
    const etag = res.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]+"$/);
    const again = await worker.fetch(OG_IMAGE_PATH, { headers: { "If-None-Match": etag! } });
    assert.equal(again.status, 304);
    checkVisitorHeaders(`${OG_IMAGE_PATH} again`, again, { cache: "no-cache" });
    assert.deepEqual(await worker.seen(), [], "the Worker's code ran for neither request");
  });

  test("the icon: site/favicon.ico, the mark at 16, 32 and 48 pixels, sent by Static Assets without the Worker, with the pages' headers and an ETag to ask again by", async () => {
    await freshProofLog(worker, { clearedOn: CLEARED_ON });
    await worker.seen();
    const res = await worker.fetch(FAVICON_PATH);
    assert.equal(res.status, 200);
    // Static Assets names the type from the extension, as it does for the other files.
    assert.match(res.headers.get("content-type") ?? "", /^image\/(x-icon|vnd\.microsoft\.icon)$/);
    checkVisitorHeaders(FAVICON_PATH, res, { cache: "no-cache" });
    const ico = Buffer.from(await res.arrayBuffer());
    assert.ok(ico.equals(readFileSync(join(WORKER_DIR, "site", "favicon.ico"))), "site/favicon.ico, byte for byte");
    assert.deepEqual(icoImages(ico).map((i) => i.size), [16, 32, 48]);
    const etag = res.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]+"$/);
    const again = await worker.fetch(FAVICON_PATH, { headers: { "If-None-Match": etag! } });
    assert.equal(again.status, 304);
    checkVisitorHeaders(`${FAVICON_PATH} again`, again, { cache: "no-cache" });
    assert.deepEqual(await worker.seen(), [], "the Worker's code ran for neither request");
  });

  test("what is not a page is the 404 page of design/copy/not-found.md, with what every page has; under /api/ it stays the API's answer", async () => {
    await freshProofLog(worker, { clearedOn: CLEARED_ON });
    const lines = copyLines(block("not-found.md", "頁面"));
    assert.deepEqual(lines, ["找不到這一頁", "這個網址沒有對到任何頁面。請確認網址有沒有抄錯。", "回到首頁"]);
    // Among them what is near a page but none: a slash too many, another case, the path of the proof log's files on
    // the data domain (the old back end had its files on this domain), a page of an account without its @.
    for (const path of ["/index.html", "/pages.css/", "/favicon.ico/", "/P/7K2Q9FM4XD", "/p", "/FAQ", "/faq/", "/proof-log/", "/proof-log/fingerprints.jsonl", "/verify/", "/threads/alice", "/threads", "/copy.js/", "/nothing?q=1"]) {
      // getPage checks the headers (noindex among them), the mark of the test log with its date, the navigation bar and the foot.
      const { status, page } = await getPage(worker, path);
      assert.equal(status, 404, path);
      wantLines(page, lines);
      assert.ok(page.includes('<h1 class="title">找不到這一頁</h1>') && page.includes('<a href="/">回到首頁</a>'), path);
      assert.equal(firstMatch(TITLE_TAG, page), "找不到這一頁｜島民證明");
      wantPreview(page, "找不到這一頁", "島民證明 iamreal.tw");
    }
    // The proof log is not asked: with an object that answers nothing, the page is the same.
    await worker.proofLog.setStoredSchemaVersion("another");
    await worker.proofLog.restart();
    try {
      assert.equal((await getPage(worker, "/nothing")).status, 404);
    } finally {
      await worker.proofLog.setStoredSchemaVersion("the build's");
      await worker.proofLog.restart();
    }
    // Nothing but the pages is cached, and what is not there under /api/ is the API's own 404.
    for (const [path, method] of [["/api/v1/config", "GET"], ["/api/v1/challenges", "POST"], ["/api/v1/nothing", "GET"]] as const) {
      assert.equal((await worker.fetch(path, { method })).headers.get("cache-control"), "no-store", path);
    }
    const api = await worker.fetch("/api/v1/nothing");
    assert.deepEqual([api.status, api.headers.get("content-type"), api.headers.get("x-robots-tag")], [404, "application/json", null]);
  });
});
