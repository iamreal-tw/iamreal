// The FAQ (/faq), how to verify the proof log (/verify), how to check an account's proof
// (/check), what a card proof needs (/prepare), hanging a proof on a profile
// (/hang, /hang/<short ID>) and the copy buttons' script (/copy.js), through
// the Worker's HTTP (test/harness.ts), against the words of design/copy/
// (faq.md, verify.md, check.md, prepare.md, hang.md), read the way
// test/pages.test.ts reads them.
// The cases are the Go backend's (e159ab9:server/site_test.go).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { OG_DESCRIPTION, block, codeBlocks, copyLines, copySection, faqAnswerHtml, faqCategories, faqLinks, faqQuestions, notOnPage, previewOf, readCopy, squash, testSiteCardAddress, unescapeHtml, visibleText, wantLines, wantPreview } from "./copy.ts";
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
  test("every question of faq.md under its category, in order, each folded with its id, its answer under it; nothing after the last but the foot", async () => {
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

    // Each question folded, as the home page's are (faq.md, at the top; home.md, 常見問題): a <details> with its id, the
    // question its <summary>, which opens and closes it without a script and from the keyboard. None is open when the page
    // opens; the copy buttons' script (copy.js) opens the one the address names (/faq#<id>), web/test/worker-card-proof.ts
    // in a browser.
    const ids = [...page.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]!);
    assert.equal(new Set(ids).size, ids.length, "no id twice");
    for (const q of questions) assert.ok(page.includes(`<details class="question" id="${q.id}"><summary>${q.question}</summary>\n`), `${q.question} is folded, with the id ${q.id}`);
    const main = page.slice(page.indexOf("<main>"), page.indexOf("</main>"));
    assert.equal(main.match(/<details\b/g)?.length, questions.length, "a <details> a question, and no other");
    assert.doesNotMatch(main, /<details\b[^>]*\sopen\b/, "every question folded when the page opens");
    assert.ok(/每一題可以展開，一開始收起來/.test(readCopy("faq.md")) && /每一題可以展開，一開始收起來/.test(readCopy("home.md")), "faq.md folds its questions the way home.md does");
    assert.match(readCopy("faq.md"), /連到某一題時，那一題展開/, "faq.md says a link to a question opens it");

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
      assert.deepEqual([...sections[i]!.matchAll(/<details class="question" id="([^"]*)">/g)].map((m) => m[1]), c.questions.map((q) => q.id), `${c.name}: its questions, in order`);
    });
    // Every link to a question that a copy file writes goes to one.
    for (const file of readdirSync(COPY_DIR).filter((f) => f.endsWith(".md"))) {
      for (const m of readFileSync(join(COPY_DIR, file), "utf8").matchAll(/\/faq#([A-Za-z0-9_-]+)/g)) assert.ok(ids.includes(m[1]!), `${file} links to /faq#${m[1]}, which is on the page`);
    }

    // Each answer exactly as faq.md writes it: its paragraphs, its list, its bold and its links.
    for (const q of questions) {
      const shown = new RegExp(`<details class="question" id="${q.id}"><summary>[^<]*</summary>\\n(.*?)</details>`, "s").exec(page);
      assert.equal(shown?.[1], faqAnswerHtml(q.answer), `${q.question}: the answer is faq.md's`);
    }
    // An answer answers the question: it sends no one to another page of the site or another question to read on (faq.md, at the top).
    // Its links go out of the site; a link to a feature of the site, the one other kind faq.md allows, would be named here.
    for (const q of questions) {
      for (const { words, href } of faqLinks(q.answer)) assert.match(href, /^https:\/\/(?![^/]*iamreal\.tw)/, `${q.question}: ${words} goes to ${href}, not out of the site`);
    }

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
      const shown = new RegExp(`<details class="question" id="${q.id}"><summary>[^<]*</summary>\\n(.*?)</details>`, "s").exec(faq);
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

/** hang.md's pictures (part 2, 示意圖): the four steps' and the one of the result, each its words (its title first) and what a screen reader is told. */
function hangPictures(): { picture: string[]; told: string[] }[] {
  const section = copySection("hang.md", "2. ");
  const pictures = section.slice(section.indexOf("\n### 示意圖\n")).split("\n#### ").slice(1);
  assert.deepEqual(pictures.map((p) => p.slice(0, p.indexOf("\n"))), ["圖 1", "圖 2", "圖 3", "圖 4", "結果圖"], "hang.md has four pictures of the steps and one of the result");
  return pictures.map((p) => {
    const blocks = codeBlocks(p);
    assert.equal(blocks.length, 2, `hang.md, ${p.slice(0, p.indexOf("\n"))}: two code blocks`);
    return { picture: blocks[0]!, told: blocks[1]! };
  });
}

/**
 * Checks the page of hanging a proof against hang.md: every line of `lines` (part 2, then part 3 if it is
 * there) in order, each step's picture after its words and the picture of the result after the two lines of
 * part 3, as hang.md writes them with the examples replaced; each picture its title, what a screen reader is
 * told and its pieces hidden from a screen reader; no inline style.
 */
/** The words of the five screens of the demonstration (hang.md, 示範): the code block that starts with `first`. */
function demoWords(first: string): string[] {
  const found = codeBlocks(copySection("hang.md", "示範")).filter((b) => b[0] === first);
  assert.equal(found.length, 1, `hang.md has one block of the demonstration's words that starts with ${first}`);
  return found[0]!;
}

/** The page of hanging a proof without its demonstration and the demonstration's timeline. */
function withoutDemo(page: string): string {
  const out = page.replace(/<div class="how">\s*<div class="demo"[\s\S]*?<script type="application\/json" id="hang-timeline">[^<]*<\/script>\s*/, "").replace(/<\/ol>\s*<\/div>/, "</ol>");
  assert.ok(!out.includes('class="demo') && !out.includes("hang-timeline"), "the demonstration is one block of the page");
  return out;
}

function wantHangPage(page: string, lines: readonly string[], withResult: boolean, ...replace: string[]): void {
  const pictures = hangPictures().map((p) => ({ picture: copyLines(p.picture, ...replace), told: copyLines(p.told, ...replace).join("") }));
  const shown = withResult ? pictures : pictures.slice(0, 4);
  const told = (p: (typeof pictures)[number]): string[] => [p.picture[0]!, p.told, ...p.picture.slice(1)];
  const want: string[] = [];
  const steps: number[] = [];
  for (const line of lines) {
    want.push(line);
    const n = /^([1-4])\u3000/.exec(line)?.[1];
    if (n === undefined) continue;
    steps.push(Number(n));
    want.push(...told(pictures[Number(n) - 1]!));
  }
  assert.deepEqual(steps, [1, 2, 3, 4], "hang.md has four steps, a picture after each");
  if (withResult) want.push(...told(pictures[4]!));
  wantLines(page, want);
  const figures = [...page.matchAll(/<figure class="sketch[^"]*">([\s\S]*?)<\/figure>/g)].map((m) => m[1]!);
  assert.equal(figures.length, shown.length, `${shown.length} pictures`);
  for (const [i, p] of shown.entries()) {
    const m = /^\s*<figcaption>([^<]*)<\/figcaption>\s*<p class="sr">([^<]*)<\/p>\s*<div class="sketch-body" aria-hidden="true">([\s\S]*)<\/div>\s*$/.exec(figures[i]!);
    assert.ok(m !== null, `picture ${i + 1}: its title, what a screen reader is told and its hidden pieces:\n${figures[i]}`);
    assert.deepEqual([unescapeHtml(m[1]!), unescapeHtml(m[2]!), squash(visibleText(m[3]!))], [p.picture[0], p.told, squash(p.picture.slice(1).join(""))], `picture ${i + 1}: its words`);
    assert.match(p.picture[0]!, /（示意）$/, `picture ${i + 1}: its title says it is an illustration`);
  }
  assert.doesNotMatch(page, /\sstyle=/, "no inline style");
}

describe("hanging a proof on a profile", () => {
  test("/hang/<short ID>: part 2 and part 3 of hang.md for the card's account, a picture under each step and one of the result, the link written in the site's own domain, its copy button shown by the one script; the preview", async () => {
    await pagesWorld(worker, "2026-11-18", [r("2026-11-06", cardStarting(CARD_A), "threads:carol.tw")]);
    const { status, page: whole } = await getPage(worker, `/hang/${CARD_A}`);
    assert.equal(status, 200);
    const onTestSite = ["@alice", "@carol.tw", "iamreal.tw/p/", "test.iamreal.tw/p/"];
    // Without the demonstration (hidden as the page is sent, the next test's), the page is the one it was: what a browser shows when the player does not run.
    const page = withoutDemo(whole);
    wantHangPage(page, [...copyLines(block("hang.md", "2. ", 0), ...onTestSite), ...copyLines(block("hang.md", "3. "))], true, ...onTestSite);
    // The pictures write the card's account, not the example's.
    assert.ok(!page.includes("alice"), "no @alice on the page of @carol.tw");
    assert.equal([...page.matchAll(/<script\b/g)].length, 3, "three scripts, all files of this site: the counts', the copy buttons' and the demonstration's player");
    // The link is the one the page of the card writes (hang.md, part 2: 和島民證明頁面上的寫法相同): on a test
    // log's site, its own domain (design/copy/test-site.md). 複製連結 copies it whole, with https://.
    const address = testSiteCardAddress(CARD_A);
    assert.ok(copySection("hang.md", "2. ").includes("`https://iamreal.tw/p/7K2Q9FM4XD`"), "hang.md says what 複製連結 copies");
    // On this page the whole first line of part 3 is the link to the card's page (hang.md, part 3).
    const hung = copyLines(block("hang.md", "3. "))[0]!;
    for (const want of [
      `<p class="backlink">${address}</p>`,
      `<button type="button" class="copy button" data-copy-text="https://${address}" data-copied="${copiedWord("hang.md")}" data-count="copy_proof_link" hidden>複製連結</button>`,
      '<a class="button quiet" href="https://www.threads.com/@carol.tw" target="_blank" rel="noopener noreferrer">打開 Threads</a>',
      `<a href="/p/${CARD_A}">${hung}</a>`,
      '<span class="account">@carol.tw</span>',
    ]) {
      assert.ok(page.includes(want), `the page has ${want}`);
    }
    assert.equal(page.split(`href="/p/${CARD_A}"`).length, 2, "one link to the card's page");
    // The link is written without https://; only picture 4 writes it whole, as 複製連結 copied it into 網址.
    notOnPage(page.replace(/<figure class="sketch press">[\s\S]*?<\/figure>/g, ""), "還沒有島民證明？", "https://");
    const { title, site } = previewOf("hang.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
  });

  test("/hang/<short ID> has the demonstration of hang.md, hidden until its player shows it: the five screens with the card's account and address, the timeline of design/motion/ as data, the one sentence for a screen reader, the button's two words", async () => {
    await pagesWorld(worker, "2026-11-18", [r("2026-11-06", cardStarting(CARD_A), "threads:carol.tw")]);
    const { page } = await getPage(worker, `/hang/${CARD_A}`);
    const demo = /<div class="demo" data-demo="hang-timeline" hidden>([\s\S]*?)<script type="application\/json" id="hang-timeline">([^<]*)<\/script>/.exec(page);
    assert.ok(demo !== null, "the demonstration is in the page, hidden, with its timeline after it");
    // The timeline is design/motion/hang.json, whole, and nothing a browser runs.
    assert.deepEqual(JSON.parse(demo[2]!), JSON.parse(readFileSync(join(WORKER_DIR, "..", "design", "motion", "hang.json"), "utf8")));
    const section = copySection("hang.md", "示範");
    // One element for a screen reader, told the one sentence; everything in it hidden.
    const told = /\| 畫面寫 \|\n\|---\|\n\| (.*) \|/.exec(section)?.[1];
    assert.ok(told !== undefined && told.startsWith("示範："), "hang.md has the sentence for a screen reader");
    const picture = /<div class="demo-picture" role="img" aria-label="([^"]*)">\s*<div class="demo-row" aria-hidden="true">([\s\S]*)<\/div>\s*<\/div>\s*<p class="demo-control">/.exec(demo[1]!);
    assert.ok(picture !== null, "the picture is one image with a label, its screens hidden from a screen reader");
    assert.equal(unescapeHtml(picture[1]!), told);
    // The words of the five screens, in order, with the card's account and the site's own address.
    const words = demoWords("把島民證明掛到");
    assert.equal(squash(visibleText(picture[2]!)), squash(copyLines(words, "@alice", "@carol.tw", "iamreal.tw/p/", "test.iamreal.tw/p/").join("")));
    // No small titles over the screens, no labels beside what is pressed: only the line a visitor looks for has one.
    assert.ok(!picture[2]!.includes('class="kick"') && !picture[2]!.includes("mark-tag"), "the demonstration has no titles over its screens and no labels on what is pressed");
    // Every box the timeline names is in the page once, both platforms' way back among them.
    const timeline = JSON.parse(demo[2]!) as { boxes: Record<string, string> };
    const boxes = [...picture[2]!.matchAll(/data-box="([^"]*)"/g)].map((m) => m[1]!);
    assert.deepEqual([...boxes].sort(), Object.keys(timeline.boxes).sort());
    // What a change of the screens shows or moves is one of the timeline's six.
    const changes = [...picture[2]!.matchAll(/data-(?:on|off)="([^"]*)"|data-shift="([^"]*)"/g)].flatMap((m) => (m[1] !== undefined ? [m[1]] : m[2]!.split(" ").map((s) => s.split(":")[0]!)));
    assert.deepEqual([...new Set(changes)].sort(), ["copied", "linkListed", "linkOnProfile", "pasteMenu", "pasted", "resultLabel"]);
    // The button's two words are hang.md's; as sent it says the one that plays.
    const [stop, replay] = [/\| 示範還在動 \| (.*) \|/.exec(section)?.[1], /\| 停了或動完了 \| (.*) \|/.exec(section)?.[1]];
    assert.deepEqual([stop, replay], ["停止", "再看一次"]);
    assert.ok(demo[1]!.includes(`<button type="button" class="button quiet" data-demo-button data-stop="${stop}" data-replay="${replay}">${replay}</button>`));
    // Each of the four steps says which it is, for the player to mark.
    assert.deepEqual([...page.matchAll(/<li data-step="(\d)">/g)].map((m) => m[1]), ["1", "2", "3", "4"]);
    assert.doesNotMatch(page, /\sstyle=/, "no inline style");
  });

  test("an account of 30 characters is written whole in the demonstration, on lines the style sheet cuts at their end", async () => {
    const long = "abcdefghij.klmnopqrst_uvwxyz12";
    await pagesWorld(worker, "2026-11-18", [r("2026-11-06", cardStarting(CARD_A), `threads:${long}`)]);
    const { page } = await getPage(worker, `/hang/${CARD_A}`);
    assert.ok(page.includes(`<span class="clip">@${long}</span>`) && page.includes(`<span class="handle clip">@${long}</span>`));
    const css = readFileSync(join(WORKER_DIR, "site", "pages.css"), "utf8");
    assert.match(css, /body\.hang \.shot \.clip \{\s*min-width: 0;\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;\s*\}/);
  });

  test("/hang without a proof: the page from the home page, a picture under each step, no copy button; its demonstration writes hang.md's examples and says which page its first screen is", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page: whole } = await getPage(worker, "/hang");
    assert.equal(status, 200);
    const page = withoutDemo(whole);
    // The demonstration: the example account and address, in the site's own domain; no card's.
    const row = /<div class="demo-row" aria-hidden="true">([\s\S]*)<\/div>\s*<\/div>\s*<p class="demo-control">/.exec(whole)?.[1];
    assert.ok(row !== undefined, "the demonstration is in the page");
    const words = demoWords("把島民證明掛到");
    assert.equal(squash(visibleText(row)), squash(copyLines(words, "iamreal.tw/p/", "test.iamreal.tw/p/").join("")));
    // The player and nothing else: no copy button, so not its script.
    assert.deepEqual(whole.match(/<script src="[^"]*"/g), ['<script src="/count.js"', '<script src="/demo.js"']);
    // The pictures write hang.md's examples, in the site's own domain.
    wantHangPage(page, copyLines(block("hang.md", "2. ", 1)), false, "iamreal.tw/p/", "test.iamreal.tw/p/");
    for (const want of ['<a class="button quiet" href="https://www.threads.com/" target="_blank" rel="noopener noreferrer">打開 Threads</a>', '<a class="button" href="/proof" data-count="start_card_proof">我要換島民證明</a>']) {
      assert.ok(page.includes(want), `the page has ${want}`);
    }
    // No 複製連結, not the two lines of part 3.
    notOnPage(page, "複製連結", "剛才複製的連結", ...copyLines(block("hang.md", "3. ")));
    assert.ok(!page.includes("<button"), "no button but the demonstration's");
    const { title, site } = previewOf("hang.md", "連結被貼出去時的預覽");
    wantPreview(page, title, site);
  });

  test("the page is the same for every device: it has both ways back from the links, for the player to choose in the browser; the Worker reads nothing of the device", async () => {
    await pagesWorld(worker, "2026-11-18", [r("2026-11-06", cardStarting(CARD_A), "threads:carol.tw")]);
    const section = copySection("hang.md", "示範");
    assert.ok(section.includes("由示範的那支程式在瀏覽器裡決定") && section.includes("裡有 `Android` 的是 Android 的版本"), "hang.md says the rule");
    const agents: (string | null)[] = [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "",
      null,
    ];
    for (const path of ["/hang", `/hang/${CARD_A}`]) {
      const pages: string[] = [];
      for (const agent of agents) {
        const res = await worker.fetch(path, { headers: agent === null ? {} : { "User-Agent": agent } });
        assert.equal(res.status, 200, path);
        checkVisitorHeaders(path, res, { cache: "public, max-age=60", script: true });
        assert.doesNotMatch(res.headers.get("vary") ?? "", /User-Agent/i, `${path}: nothing in the answer depends on the device`);
        pages.push(await res.text());
      }
      assert.equal(new Set(pages).size, 1, `${path}: the same page whatever the device says it is`);
      // The page says no platform; the player does, in the browser. Both ways back are boxes: ✕ at the left, 完成 at the right.
      assert.ok(pages[0]!.includes('<div class="demo" data-demo="hang-timeline" hidden>') && !pages[0]!.includes("data-variant"), `${path}: no platform chosen in the page`);
      assert.match(pages[0]!, /<p class="top"><span class="act close" data-box="x3">✕[\s\S]*?<\/span><b>連結<\/b><span class="act" data-box="done3">完成/, `${path}: both ways back from the links`);
    }
    // The player chooses by what the browser says it is, and tells the style sheet; the style sheet draws each platform's top.
    const player = readFileSync(join(WORKER_DIR, "demo", "player.js"), "utf8");
    assert.ok(player.includes('const variant = /Android/.test(navigator.userAgent) ? "android" : "ios";') && player.includes("demo.dataset.variant = variant;"));
    const css = readFileSync(join(WORKER_DIR, "site", "pages.css"), "utf8");
    assert.match(css, /body\.hang \.demo\[data-variant="ios"\] \.shot \[data-box="x3"\] \{\s*display: none;\s*\}/);
    assert.match(css, /body\.hang \.demo\[data-variant="android"\] \.shot \[data-box="done3"\] \{\s*color: var\(--dot\);\s*\}/);
    // The Worker's code for the pages does not look at the device.
    for (const file of ["visitor.ts", join("pages", "hang.ts"), join("pages", "layout.ts")]) assert.doesNotMatch(readFileSync(join(WORKER_DIR, "src", file), "utf8").replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""), /user-agent/i, `src/${file} reads no User-Agent`);
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

describe("the demonstration's player", () => {
  test("/demo.js: sent by Static Assets without the Worker, with the pages' headers; it is the file of the repository, and nothing in it reaches another site or asks for anything", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    await worker.seen();
    const res = await worker.fetch("/demo.js");
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "text/javascript; charset=utf-8"]);
    checkVisitorHeaders("/demo.js", res, { cache: "no-cache" });
    const script = await res.text();
    assert.equal(script, readFileSync(join(WORKER_DIR, "site", "demo.js"), "utf8"));
    // Without its comments: no address, no request, no code made from text, no HTML written, no other page gone to.
    const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const s of ["http", "fetch", "XMLHttpRequest", "sendBeacon", "WebSocket", "import", "eval", "Function(", "innerHTML", "location", "cookie", "localStorage", ".style"]) assert.ok(!code.includes(s), `demo.js has ${s}`);
    assert.doesNotMatch(script, /[^\x00-\x7f]/, "ASCII only: Static Assets sends no charset on Cloudflare");
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await worker.fetch("/demo.js", { method })).status, 405, `${method} /demo.js`);
    assert.deepEqual(await worker.seen(), [], "the Worker's code ran for none of these requests");
  });
});

describe("the counts' script", () => {
  test("/count.js: sent by Static Assets without the Worker, with the pages' headers; it is the file of the repository; its one request is to this origin's counts, and it reads no card proof device ID", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    await worker.seen();
    const res = await worker.fetch("/count.js");
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "text/javascript; charset=utf-8"]);
    checkVisitorHeaders("/count.js", res, { cache: "no-cache" });
    const script = await res.text();
    assert.equal(script, readFileSync(join(WORKER_DIR, "site", "count.js"), "utf8"));
    // Without its comments: one request, to a path of this origin; no other kind of request, no address, no code made from text.
    const code = script.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.deepEqual(code.match(/fetch\(/g), ["fetch("]);
    assert.ok(code.includes('fetch("/api/v1/counts", {'));
    for (const s of ["http", "XMLHttpRequest", "sendBeacon", "WebSocket", "import", "eval", "Function(", "innerHTML", "location", "cookie", "localStorage", "card_proof_device_id", "device_id", ".style"]) assert.ok(!code.includes(s), `count.js has ${s}`);
    assert.doesNotMatch(script, /[^\x00-\x7f]/, "ASCII only: Static Assets sends no charset on Cloudflare");
    for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await worker.fetch("/count.js", { method })).status, 405, `${method} /count.js`);
    assert.deepEqual(await worker.seen(), [], "the Worker's code ran for none of these requests");
  });
});

describe("the copy buttons' script", () => {
  test("/copy.js: the old back end's and the FAQ's lines, sent by Static Assets without the Worker, with the pages' headers and an ETag to ask again by; nothing in it reaches another site", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    await worker.seen();
    const res = await worker.fetch("/copy.js");
    assert.deepEqual([res.status, res.headers.get("content-type")], [200, "text/javascript; charset=utf-8"]);
    checkVisitorHeaders("/copy.js", res, { cache: "no-cache" });
    const script = await res.text();
    assert.equal(script, readFileSync(join(WORKER_DIR, "site", "copy.js"), "utf8"));
    assert.ok(script.includes('document.querySelectorAll("button[data-copy], button[data-copy-text]")'));
    // On the FAQ it opens the question the address names, when the page opens and when the part after # changes.
    assert.ok(script.includes("document.getElementById(address.slice(hash + 1))") && script.includes('addEventListener("hashchange"'));
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

/**
 * check.md's four steps (its "### 第 n 步"), each its three code blocks: the words on the left, the words of the picture (its
 * title first), and what a screen reader is told of the picture; and whether the picture's last line is the sentence under it
 * rather than a piece of it (check.md says 最後一句在圖的下面).
 */
function checkSteps(): { text: string[]; picture: string[]; told: string[]; note: boolean }[] {
  const steps = copySection("check.md", "2. ").split("\n### 第 ").slice(1);
  assert.equal(steps.length, 4, "check.md section 2 has four steps");
  return steps.map((step, i) => {
    assert.ok(step.startsWith(`${i + 1} 步\n`), `check.md step ${i + 1}`);
    const blocks = codeBlocks(step);
    assert.equal(blocks.length, 3, `check.md step ${i + 1}: three code blocks`);
    return { text: blocks[0]!, picture: blocks[1]!, told: blocks[2]!, note: step.includes("最後一句在圖的下面") };
  });
}

/** The lines of check.md's pictures and steps 1 and 2, as a site with this domain writes them (check.md, 測試網站). */
const onSite = (lines: readonly string[], host: string): string[] => copyLines(lines, "iamreal.tw", host);

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
      const note = s.note ? picture[picture.length - 1]! : null;
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
    const pages = ["/", `/p/${CARD_A}`, "/p/7K2Q9FM4XE", "/threads/@alice", "/threads/@a-b", "/proof-log", "/proof-log?q=a-b", "/faq", "/verify", "/check", "/prepare", "/privacy", "/hang", `/hang/${CARD_A}`, "/nothing"];
    const links = new Set<string>();
    for (const path of pages) {
      const { page } = await getPage(worker, path);
      for (const m of page.matchAll(/\s(?:href|src|action)="(\/(?!\/)[^"]*)"/g)) links.add(unescapeHtml(m[1]!).replace(/#.*/, ""));
    }
    for (const want of ["/", "/proof", "/prepare", "/privacy", "/verify", "/proof-log", "/faq", "/hang", `/p/${CARD_A}`, "/pages.css", "/copy.js"]) assert.ok(links.has(want), `a page links to ${want}`);
    assert.ok([...links].some((l) => l.startsWith("/proof-log?after=")), "更多 is among them");
    const failing: string[] = [];
    for (const link of links) {
      const res = await worker.fetch(link, { redirect: "manual" });
      if (res.status !== 200) failing.push(`${link}: ${res.status}`);
    }
    assert.deepEqual(failing, []);
  });
});
