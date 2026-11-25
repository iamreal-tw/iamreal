// The FAQ (/faq), how to verify the proof log (/verify), hanging a proof on a profile
// (/hang, /hang/<short ID>) and the copy buttons' script (/copy.js), through
// the Worker's HTTP (test/harness.ts), against the words of design/copy/
// (faq.md, verify.md, hang.md), read the way test/pages.test.ts reads them.
// The cases are the Go backend's (e159ab9:server/site_test.go).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { OG_DESCRIPTION, block, codeBlocks, copyLines, copySection, faqCategories, faqQuestions, notOnPage, previewOf, readCopy, squash, testSiteCardAddress, unescapeHtml, visibleText, wantLines, wantPreview } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { CARD_A, CARD_B, cardStarting, checkVisitorHeaders, getPage, pagesWorld, r } from "./pages.ts";
import { newCard } from "./records.ts";

const REPO_DIR = join(WORKER_DIR, "..");
const COPY_DIR = join(REPO_DIR, "design", "copy");

let worker: TestWorker;
let proofDir: string;
before(async () => {
  // A stand-in for the build of web/ (#69): the one file of it the pages link to.
  proofDir = mkdtempSync(join(tmpdir(), "proof-"));
  writeFileSync(join(proofDir, "index.html"), "<p>card proof</p>");
  worker = await startWorker({ proofFiles: proofDir });
  await worker.setVerifier("stand-in");
});
after(async () => {
  await worker.close();
  rmSync(proofDir, { recursive: true, force: true });
});

function faqByQuestion(question: string): ReturnType<typeof faqQuestions>[number] {
  const found = faqQuestions().find((q) => q.question === question);
  assert.ok(found !== undefined, `faq.md has the question ${question}`);
  return found;
}

describe("the FAQ", () => {
  test("every question of faq.md under its category, in order, each a heading with its id and its answer shown; nothing after the last but the foot", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page } = await getPage(worker, "/faq");
    assert.equal(status, 200);
    const categories = faqCategories();
    assert.deepEqual(categories.map((c) => c.name), ["關於隱私", "它能證明什麼", "怎麼用", "誰在做"], "faq.md's four categories, in order");
    const questions = faqQuestions();
    assert.equal(questions.length, 23, "faq.md has the 23 questions the page writes");
    // The title, the categories' names (the list of them), then each category: its name, its questions and their answers.
    const want = [...copyLines(codeBlocks(readCopy("faq.md"))[0]!), ...categories.map((c) => c.name)];
    for (const c of categories) want.push(c.name, ...c.questions.flatMap((q) => [q.question, ...copyLines(q.answer)]));
    const last = want[want.length - 1]!;
    const foot = copyLines(block("home.md", "頁尾"));
    wantLines(page, [...want, ...foot]);
    assert.ok(squash(visibleText(page)).endsWith(squash(last) + foot.map(squash).join("")), "nothing between the last answer and the foot");

    // Each question a heading with its id, its answer shown: no <details>.
    assert.ok(!page.slice(page.indexOf("<main>"), page.indexOf("</main>")).includes("<details"), "no answer is folded");
    const ids = [...page.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!);
    assert.equal(new Set(ids).size, ids.length, "no id twice");
    for (const q of questions) assert.ok(page.includes(`<section class="question" id="${q.id}"><h3>${q.question}</h3>`), `${q.question} is a heading with the id ${q.id}`);

    // The list of the categories: each name a link to its category, in faq.md's order, under the title and above the first question.
    const listName = /螢幕閱讀器唸的名稱是「([^」]*)」/.exec(readCopy("faq.md"))?.[1];
    assert.ok(listName !== undefined, "faq.md names the list of the categories");
    const list = new RegExp(`<nav class="categories" aria-label="${listName}">(.*?)</nav>`, "s").exec(page);
    assert.ok(list !== null, `the page has the list of the categories, named ${listName}`);
    assert.deepEqual(
      [...list[1]!.matchAll(/<a href="([^"]*)">([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]),
      categories.map((c) => [`#${c.id}`, c.name]),
      "each category's name, a link to it",
    );
    assert.ok(page.indexOf(list[0]) > page.indexOf('<h1 class="title">常見問題</h1>') && page.indexOf(list[0]) < page.indexOf(`id="${questions[0]!.id}"`), "the list is under the title, above the first question");
    // Each link lands on its category, and each question is in its own category, in order.
    const sections = page.split(/(?=<section class="category")/).slice(1);
    assert.equal(sections.length, categories.length, "one section a category");
    categories.forEach((c, i) => {
      assert.ok(sections[i]!.startsWith(`<section class="category" id="${c.id}">\n<h2>${c.name}</h2>`), `${c.name}: the section #${c.id}, its name the heading`);
      assert.deepEqual([...sections[i]!.matchAll(/<section class="question" id="([^"]*)">/g)].map((m) => m[1]), c.questions.map((q) => q.id), `${c.name}: its questions, in order`);
    });
    // Every link to a question that a copy file writes goes to one.
    for (const file of readdirSync(COPY_DIR).filter((f) => f.endsWith(".md"))) {
      for (const m of readFileSync(join(COPY_DIR, file), "utf8").matchAll(/\/faq#([A-Za-z0-9_-]+)/g)) assert.ok(ids.includes(m[1]!), `${file} links to /faq#${m[1]}, which is on the page`);
    }

    // The links of the answers.
    const security = faqByQuestion("島民證明服務安全嗎？");
    for (const link of [
      `<a href="/faq#${security.id}">了解更多</a>`,
      '公開在 <a href="https://github.com/iamreal-tw/iamreal">GitHub</a>，',
      '<a href="https://github.com/iamreal-tw/iamreal/blob/main/docs/adr/0004-scoped-ids-and-proofs-are-public.md">完整的說明</a>',
      '<a href="https://github.com/iamreal-tw/iamreal/discussions">GitHub 的討論區</a>留言',
      "<strong>注意：</strong>",
    ]) {
      assert.ok(page.includes(link), `the page has ${link}`);
    }
    assert.ok(existsSync(join(REPO_DIR, "docs", "adr", "0004-scoped-ids-and-proofs-are-public.md")), "the ADR the answer links to is there");
    assert.ok(faqByQuestion("政府會知道我是哪個帳號嗎？").answer[2]!.includes("了解更多"));
    assert.ok(readCopy("faq.md").includes("「了解更多」連到下一題「島民證明服務安全嗎？」"), "faq.md says where 了解更多 goes");

    // The question of the ordinal (#299): in 它能證明什麼, right after the lost card; not on the home page.
    const what = categories.find((c) => c.id === "cat-what")!;
    const ordinal = faqByQuestion("島民證明上的「第 N 張」是什麼？");
    assert.equal(ordinal.id, "ordinal");
    assert.equal(what.questions.findIndex((q) => q.id === "ordinal"), what.questions.findIndex((q) => q.id === "lost-card") + 1);
    notOnPage((await getPage(worker, "/")).page, ordinal.question);

    const { title, site, summary } = previewOf("faq.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
    assert.equal(summary, "");
    assert.doesNotMatch(page, OG_DESCRIPTION);
  });

  test("the home page's eight questions are the FAQ's, the same HTML, the ones faq.md marks, in home.md's order", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const home = (await getPage(worker, "/")).page;
    const faq = (await getPage(worker, "/faq")).page;
    const ids = codeBlocks(copySection("home.md", "常見問題"))[1]!;
    // faq.md says, under each question, whether the home page has it.
    const marked = readCopy("faq.md")
      .split("\n### ")
      .slice(1)
      .filter((q) => q.includes("首頁的常見問題有這一題"))
      .map((q) => /這一題在頁面上的 `id`：`([a-z0-9-]+)`/.exec(q)![1]!);
    assert.deepEqual([...ids].sort(), [...marked].sort(), "home.md lists the questions faq.md marks");
    const folded = [...home.matchAll(/<details><summary>([^<]*)<\/summary>\n(.*?)<\/details>/gs)];
    assert.deepEqual(
      folded.map((f) => f[1]),
      ids.map((id) => faqQuestions().find((q) => q.id === id)!.question),
    );
    for (const [, question, answer] of folded) {
      const q = faqByQuestion(question!);
      const shown = new RegExp(`<section class="question" id="${q.id}"><h3>[^<]*</h3>\\n(.*?)</section>`, "s").exec(faq);
      assert.equal(shown?.[1], answer, `${question}: the home page's answer is the FAQ's`);
    }
  });
});

/**
 * What a copy button reads once it has copied, as `file` writes it (按了之後按鈕寫「…」), checked against
 * card-proof.json's: the one word for it.
 */
function copiedWord(file: string): string {
  const m = /按了之後按鈕寫「([^」]*)」/.exec(readCopy(file));
  const copied = (JSON.parse(readCopy("card-proof.json")) as { done: { copied: string } }).done.copied;
  assert.ok(m !== null && m[1] === copied && copied === "已複製", `${file}: ${m?.[1]}; card-proof.json's copied is ${copied}`);
  return copied;
}

describe("how to verify the proof log", () => {
  test("every sentence of verify.md, in order; the prompt exactly; its copy button, shown by the one script; the preview", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page } = await getPage(worker, "/verify");
    assert.equal(status, 200);
    wantLines(page, [
      ...copyLines(block("verify.md", "1. ")),
      ...copyLines(block("verify.md", "2. ")),
      ...copyLines(block("verify.md", "3. ", 0)),
      ...copyLines(block("verify.md", "3. ", 1)),
      ...copyLines(block("verify.md", "3. ", 2)),
      ...copyLines(block("verify.md", "4. ")),
    ]);
    // The prompt, exactly: one character changed is another prompt.
    const prompt = /<pre class="prompt" id="prompt">(.*?)<\/pre>/s.exec(page);
    assert.equal(prompt === null ? null : unescapeHtml(prompt[1]!), block("verify.md", "3. ", 1).join("\n"), "the prompt is verify.md's");
    // Its copy button (verify.md, section 3), hidden until the script shows it.
    const button = copyLines(block("verify.md", "3. ", 2));
    assert.equal(button.length, 1);
    assert.ok(page.includes(`<button type="button" class="copy" data-copy="prompt" data-copied="${copiedWord("verify.md")}" hidden>${button[0]}</button>`), "the copy button of the prompt");
    assert.ok(page.includes('<a href="https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md">cmd/iamreal-verify</a>'));
    assert.ok(existsSync(join(REPO_DIR, "cmd", "iamreal-verify", "README.md")));
    const { title, site } = previewOf("verify.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
  });
});

describe("hanging a proof on a profile", () => {
  test("/hang/<short ID>: part 2 and part 3 of hang.md for the card's account, the link written in the site's own domain, its copy button shown by the one script; the preview", async () => {
    await pagesWorld(worker, "2026-11-18", [r("2026-11-06", cardStarting(CARD_A), "threads:carol.tw")]);
    const { status, page } = await getPage(worker, `/hang/${CARD_A}`);
    assert.equal(status, 200);
    wantLines(page, [...copyLines(block("hang.md", "2. ", 0), "@alice", "@carol.tw", "iamreal.tw/p/", "test.iamreal.tw/p/"), ...copyLines(block("hang.md", "3. "))]);
    // The link is the one the page of the card writes (hang.md, part 2: 和島民證明頁面上的寫法相同): on a test
    // log's site, its own domain (design/copy/test-site.md). 複製連結 copies it whole, with https://.
    const address = testSiteCardAddress(CARD_A);
    assert.ok(copySection("hang.md", "2. ").includes("`https://iamreal.tw/p/7K2Q9FM4XD`"), "hang.md says what 複製連結 copies");
    // On this page the whole first line of part 3 is the link to the card's page (hang.md, part 3).
    const hung = copyLines(block("hang.md", "3. "))[0]!;
    for (const want of [
      `<p class="backlink">${address}</p>`,
      `<button type="button" class="copy button" data-copy-text="https://${address}" data-copied="${copiedWord("hang.md")}" hidden>複製連結</button>`,
      '<a class="button quiet" href="https://www.threads.com/@carol.tw" target="_blank" rel="noopener noreferrer">打開 Threads</a>',
      `<a href="/p/${CARD_A}">${hung}</a>`,
      '<span class="account">@carol.tw</span>',
    ]) {
      assert.ok(page.includes(want), `the page has ${want}`);
    }
    assert.equal(page.split(`href="/p/${CARD_A}"`).length, 2, "one link to the card's page");
    notOnPage(page, "還沒有島民證明？", "https://");
    const { title, site } = previewOf("hang.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
  });

  test("/hang without a proof: the page from the home page, with no script and no button", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page } = await getPage(worker, "/hang");
    assert.equal(status, 200);
    wantLines(page, copyLines(block("hang.md", "2. ", 1)));
    for (const want of ['<a class="button quiet" href="https://www.threads.com/" target="_blank" rel="noopener noreferrer">打開 Threads</a>', '<a class="button" href="/proof">我要換島民證明</a>']) {
      assert.ok(page.includes(want), `the page has ${want}`);
    }
    // No 複製連結, not the two lines of part 3.
    notOnPage(page, "複製連結", "剛才複製的連結", ...copyLines(block("hang.md", "3. ")));
    assert.ok(!page.includes("<button"), "no button");
    const { title, site } = previewOf("hang.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
  });

  test("/hang/<short ID> is the page for one card with an account on Threads only (302 to /hang otherwise); another spelling is redirected (301); one that does not read is answered without the proof log's object", async () => {
    const one = cardStarting(CARD_A);
    const m1 = cardStarting("M4T8XR6PZ13A");
    const m2 = cardStarting("M4T8XR6PZ13B");
    const gone = cardStarting(CARD_B);
    const elsewhere = cardStarting("5PZ8KR3XQW");
    await pagesWorld(worker, "2026-11-18", [
      r("2026-11-01", one, "threads:alice"),
      r("2026-11-01", m1, "threads:bob"),
      r("2026-11-01", m2, "threads:carol"),
      r("2026-11-02", gone, "threads:dave"),
      r("2026-11-03", gone),
      r("2026-11-03", elsewhere, "test-example:alice"),
    ]);
    assert.equal((await getPage(worker, `/hang/${CARD_A}`)).status, 200);
    const unreadable = ["7K2Q9FM4X", "7K2Q9FM4XDD", "7K2Q-FM4XD", "", "a/b", "%3Cb%3Ex%22"];
    const cases: [string, string][] = [["2HD5WN0J8C", "no card"], ["M4T8XR6PZ1", "two cards"], [CARD_B, "withdrawn"], ["5PZ8KR3XQW", "an account on another platform only"], ...unreadable.map((u): [string, string] => [u, "does not read"])];
    const redirects = async (): Promise<void> => {
      for (const [typed, to] of [["7k2q9fm4xd", "/hang/7K2Q9FM4XD"], ["7K2Q9FM4XO", "/hang/7K2Q9FM4X0"], ["lK2Q9FM4XD", "/hang/1K2Q9FM4XD"]] as const) {
        const res = await worker.fetch(`/hang/${typed}`, { redirect: "manual" });
        assert.deepEqual([res.status, res.headers.get("location")], [301, to], `/hang/${typed}`);
        checkVisitorHeaders(`/hang/${typed}`, res, { cache: "public, max-age=60", more: ["location"] });
      }
    };
    for (const [typed, why] of cases) {
      const res = await worker.fetch(`/hang/${typed}`, { redirect: "manual" });
      assert.deepEqual([res.status, res.headers.get("location")], [302, "/hang"], `/hang/${typed} (${why})`);
      checkVisitorHeaders(`/hang/${typed}`, res, { cache: "public, max-age=60", more: ["location"] });
      assert.ok(!(await res.text()).includes("<b>x"), `/hang/${typed}: escaped`);
    }
    await redirects();

    // With an object that answers nothing, a short ID that reads is 500; one that does not, and another spelling,
    // are answered as before: the Worker did not ask.
    await worker.proofLog.setStoredSchemaVersion("another");
    await worker.proofLog.restart();
    try {
      const logged = worker.logLines().length;
      const failed = await worker.fetch(`/hang/${CARD_A}`);
      assert.equal(failed.status, 500);
      checkVisitorHeaders("a page that failed", failed, { cache: "no-store" });
      assert.deepEqual(worker.logLines().slice(logged).map((l) => JSON.parse(l)), [{ event: "internal_error", page: "hang", where: "schema", error: "Error" }]);
      for (const typed of unreadable) assert.deepEqual([(await worker.fetch(`/hang/${typed}`, { redirect: "manual" })).status], [302], `/hang/${typed}`);
      await redirects();
      assert.equal((await getPage(worker, "/hang")).status, 200, "/hang does not ask the proof log");
    } finally {
      await worker.proofLog.setStoredSchemaVersion("the build's");
      await worker.proofLog.restart();
    }
  });
});

describe("the copy buttons' script", () => {
  test("/copy.js: the old back end's, sent by Static Assets without the Worker, with the pages' headers and an ETag to ask again by; nothing in it reaches another site", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    await worker.seen();
    const res = await worker.fetch("/copy.js");
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "text/javascript; charset=utf-8"]);
    checkVisitorHeaders("/copy.js", res, { cache: "no-cache" });
    const script = await res.text();
    assert.equal(script, readFileSync(join(WORKER_DIR, "site", "copy.js"), "utf8"));
    assert.ok(script.includes('document.querySelectorAll("button[data-copy], button[data-copy-text]")'));
    for (const s of ["http", "fetch", "XMLHttpRequest", "sendBeacon", "import", "eval", "innerHTML", "location"]) assert.ok(!script.includes(s), `copy.js has ${s}`);
    const etag = res.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]+"$/);
    const again = await worker.fetch("/copy.js", { headers: { "If-None-Match": etag! } });
    assert.deepEqual([again.status, await again.text()], [304, ""]);
    checkVisitorHeaders("/copy.js again", again, { cache: "no-cache" });
    assert.equal((await worker.fetch("/copy.js", { headers: { "If-None-Match": '"0000000000000000"' } })).status, 200);
    const head = await worker.fetch("/copy.js", { method: "HEAD" });
    assert.deepEqual([head.status, await head.text(), head.headers.get("etag")], [200, "", etag]);
    // Static Assets' 405 has no Allow.
    for (const method of ["POST", "PUT", "DELETE"]) {
      const no = await worker.fetch("/copy.js", { method });
      assert.deepEqual([no.status, no.headers.get("allow")], [405, null], `${method} /copy.js`);
      checkVisitorHeaders(`${method} /copy.js`, no, { cache: "no-cache" });
    }
    assert.deepEqual(await worker.seen(), [], "the Worker's code ran for none of these requests");
  });
});

/** card-proof.json's sentences that prepare.md says again. */
function cardProofSentences(): { componentUnreachable: string; noReader: string; readAgain: string; popupBlocked: string; pinIncorrect: string } {
  const c = JSON.parse(readCopy("card-proof.json")) as { stops: Record<string, string>; read: Record<string, string>; common: Record<string, string>; pin: Record<string, string> };
  return { componentUnreachable: c.stops.component_unreachable!, noReader: c.stops.no_reader!, readAgain: c.read.read_again!, popupBlocked: c.common.popup_blocked!, pinIncorrect: c.pin.pin_incorrect! };
}

describe("what a card proof needs", () => {
  test("every sentence of prepare.md, in order, then the foot; its two links to MOICA's site; the preview", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page } = await getPage(worker, "/prepare");
    assert.equal(status, 200);
    const want = ["1. ", "2. ", "3. ", "4. "].flatMap((heading) => copyLines(block("prepare.md", heading)));
    const foot = copyLines(block("home.md", "頁尾"));
    wantLines(page, [...want, ...foot]);
    assert.ok(squash(visibleText(page)).endsWith(squash(want[want.length - 1]!) + foot.map(squash).join("")), "nothing between the last situation and the foot");
    // The two links, to the addresses prepare.md gives under their sections.
    for (const [heading, words, href] of [
      ["3. ", "內政部憑證管理中心的下載頁", "https://moica.nat.gov.tw/rac_plugin.html"],
      ["4. ", "內政部憑證管理中心的網站", "https://moica.nat.gov.tw/"],
    ] as const) {
      assert.ok(copySection("prepare.md", heading).includes(`「${words}」是連結，連到 \`${href}\``), `prepare.md ${heading} says where ${words} goes`);
      assert.ok(page.includes(`<a href="${href}">${words}</a>`), `the page links ${words} to ${href}`);
    }
    const { title, site, summary } = previewOf("prepare.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
    assert.equal(summary, "");
    assert.doesNotMatch(page, OG_DESCRIPTION);
  });

  test("the sentences it shares with the card proof's screens are card-proof.json's", () => {
    const useReader = (JSON.parse(readCopy("card-proof.json")) as { app: Record<string, string> }).app.use_reader!;
    assert.ok(block("prepare.md", "3. ").join("\n").includes(`選「${useReader}」`), `prepare.md step 4 says 選「${useReader}」`);
    const situations = block("prepare.md", "4. ").join("\n");
    const s = cardProofSentences();
    const [unreachable] = s.componentUnreachable.split("。");
    const [noReader, checkReader] = s.noReader.split("。");
    const [popupHeading, popupBody] = [s.popupBlocked.slice(0, s.popupBlocked.indexOf("。")), s.popupBlocked.slice(s.popupBlocked.indexOf("。") + 1)];
    for (const shared of [`過卡時說「${unreachable}」`, `按「${s.readAgain}」`, `過卡時說「${noReader}」`, `${checkReader}。`, `${popupHeading}\n${popupBody}`, s.pinIncorrect.slice(s.pinIncorrect.indexOf("。") + 1)]) {
      assert.ok(situations.includes(shared), `prepare.md section 4 says ${JSON.stringify(shared)}`);
    }
  });
});

/** check.md's four steps, each its three code blocks: the words on the left, the words of the picture (its title first), and what a screen reader is told of the picture. */
function checkSteps(): { text: string[]; picture: string[]; told: string[] }[] {
  const blocks = codeBlocks(copySection("check.md", "2. "));
  assert.equal(blocks.length, 1 + 4 * 3, "check.md section 2: its heading, then three blocks for each of the four steps");
  return [0, 1, 2, 3].map((i) => ({ text: blocks[1 + 3 * i]!, picture: blocks[2 + 3 * i]!, told: blocks[3 + 3 * i]! }));
}

/** The lines of check.md's pictures and steps 1 and 2, as a site with this domain writes them (check.md, 測試網站). */
const onSite = (lines: readonly string[], host: string): string[] => copyLines(lines, "iamreal.tw", host);

/** The last line of a picture that is a sentence under it rather than a piece of it (check.md, steps 3 and 4). */
const NOTE_OF_STEP = [false, false, true, true];

describe("how to check an account's proof", () => {
  test("every sentence of check.md, in order, then the foot; each step's picture after its words, the picture's pieces hidden from a screen reader, which is told it in words; the preview", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page } = await getPage(worker, "/check");
    assert.equal(status, 200);
    const host = "test.iamreal.tw";
    const steps = checkSteps();
    const want = [
      ...copyLines(block("check.md", "1. ")),
      ...copyLines(block("check.md", "2. ", 0)),
      ...steps.flatMap((s, i) => [...(i < 2 ? onSite(s.text, host) : copyLines(s.text)), ...onSite(s.picture.slice(0, 1), host), ...onSite(s.told, host), ...onSite(s.picture.slice(1), host)]),
      ...copyLines(block("check.md", "3. ")),
      ...copyLines(block("check.md", "4. ")),
    ];
    const foot = copyLines(block("home.md", "頁尾"));
    wantLines(page, [...want, ...foot]);
    assert.ok(squash(visibleText(page)).endsWith(squash(want[want.length - 1]!) + foot.map(squash).join("")), "nothing between the last situation and the foot");

    // Each step's 惡意手法: a <details> closed until it is opened, its <summary> the word.
    const tricks = [...page.matchAll(/<details class="trick">\s*<summary>([^<]*)<\/summary>/g)].map((m) => m[1]);
    assert.deepEqual(tricks, ["惡意手法", "惡意手法", "惡意手法", "惡意手法"], "four 惡意手法, each a <details> with its <summary>");
    assert.doesNotMatch(page, /<details[^>]*\sopen/, "every 惡意手法 is closed");

    // Each picture: its title, what a screen reader is told, its pieces hidden from it, and (steps 3 and 4) the sentence under it.
    const figures = [...page.matchAll(/<figure class="sketch[^"]*">([\s\S]*?)<\/figure>/g)].map((m) => m[1]!);
    assert.equal(figures.length, 4, "a picture for each step");
    for (const [i, s] of steps.entries()) {
      const figure = figures[i]!;
      const picture = onSite(s.picture, host);
      const note = NOTE_OF_STEP[i] ? picture[picture.length - 1]! : null;
      const pieces = picture.slice(1, note === null ? undefined : -1);
      const m = /^\s*<figcaption>([^<]*)<\/figcaption>\s*<p class="sr">([^<]*)<\/p>\s*<div class="sketch-body" aria-hidden="true">([\s\S]*)<\/div>\s*(?:<p class="sketch-note">([^<]*)<\/p>\s*)?$/.exec(figure);
      assert.ok(m !== null, `step ${i + 1}: the picture is its title, what a screen reader is told, its hidden pieces and its sentence:\n${figure}`);
      assert.deepEqual([unescapeHtml(m[1]!), unescapeHtml(m[2]!), squash(visibleText(m[3]!)), m[4] === undefined ? null : unescapeHtml(m[4])], [picture[0], onSite(s.told, host).join(""), squash(pieces.join("")), note], `step ${i + 1}: the words of the picture`);
      assert.match(picture[0]!, /（示意）$/, `step ${i + 1}: its title says it is an illustration`);
    }

    // Its two links: the proof log, at its lookup box, and how to verify the proof log.
    const situations = page.slice(page.indexOf('<section class="situations">'));
    for (const [href, words] of [["/proof-log#q", "證明紀錄"], ["/verify", "如何驗證證明紀錄"]] as const) {
      assert.ok(copySection("check.md", "4. ").includes(`「${words}」是連結，連到`) && copySection("check.md", "4. ").includes(`\`${href}\``), `check.md says where ${words} goes`);
      assert.ok(situations.includes(`<a href="${href}">${words}</a>`), `the page links ${words} to ${href}`);
    }
    const { title, site, summary } = previewOf("check.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
    assert.equal(summary, "");
    assert.doesNotMatch(page, OG_DESCRIPTION);
  });
});

describe("the links", () => {
  test("every link to this site on the home page, the page of a card, the navigation bar, the foot and the pages of this file and of test/lookup-pages.test.ts is 200, with no redirect", async () => {
    const recs = Array.from({ length: 51 }, (_, i) => r("2026-11-01", newCard(), `threads:a${String(i).padStart(2, "0")}`));
    await pagesWorld(worker, "2026-11-18", [...recs, r("2026-11-06", cardStarting(CARD_A), "threads:alice")]);
    const pages = ["/", `/p/${CARD_A}`, "/p/7K2Q9FM4XE", "/threads/@alice", "/threads/@a-b", "/proof-log", "/proof-log?q=a-b", "/faq", "/verify", "/check", "/prepare", "/hang", `/hang/${CARD_A}`, "/nothing"];
    const links = new Set<string>();
    for (const path of pages) {
      const { page } = await getPage(worker, path);
      for (const m of page.matchAll(/\s(?:href|src|action)="(\/(?!\/)[^"]*)"/g)) links.add(unescapeHtml(m[1]!).replace(/#.*/, ""));
    }
    for (const want of ["/", "/proof", "/prepare", "/verify", "/proof-log", "/faq", "/hang", `/p/${CARD_A}`, "/pages.css", "/copy.js"]) assert.ok(links.has(want), `a page links to ${want}`);
    assert.ok([...links].some((l) => l.startsWith("/proof-log?after=")), "更多 is among them");
    const failing: string[] = [];
    for (const link of links) {
      const res = await worker.fetch(link, { redirect: "manual" });
      if (res.status !== 200) failing.push(`${link}: ${res.status}`);
    }
    // /privacy is the FAQ's link to the full privacy notice (design/copy/privacy.md), a page neither back end makes yet.
    assert.deepEqual(failing, ["/privacy: 404"]);
  });
});
