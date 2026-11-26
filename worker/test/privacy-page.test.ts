// The privacy statement (/privacy, #97), through the Worker's HTTP
// (test/harness.ts), against the words of design/copy/privacy.md, read the
// way test/site-pages.test.ts reads the other pages': every line of its
// fourteen sections in order, then the foot; each section's heading; the
// bold and the links privacy.md asks for under its sections; and the foot's
// link to it, on this page and on the others.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { block, codeBlocks, copyLines, copySection, readCopy, squash, visibleText, wantLines } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { getPage, pagesWorld } from "./pages.ts";

let worker: TestWorker;
before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(async () => {
  await worker.close();
});

/** privacy.md's sections: the number and the heading of each "## N. heading". */
function sections(): { n: number; heading: string }[] {
  return [...readCopy("privacy.md").matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), heading: m[2]! }));
}

/** The lines of section `n`'s code block. */
const lines = (n: number): string[] => block("privacy.md", `${n}. `);

/** A section's paragraphs that are points (· ), each without its · . */
const points = (n: number): string[] => lines(n).filter((l) => l.startsWith("· ")).map((l) => l.slice(2));

/** The first sentence of a point, which privacy.md asks for in bold. */
const firstSentence = (point: string): string => point.slice(0, point.indexOf("。") + 1);

describe("the privacy statement", () => {
  test("every line of privacy.md's fourteen sections, in order, then the foot; nothing between", async () => {
    await pagesWorld(worker, "2026-11-18", []);
    const { status, page } = await getPage(worker, "/privacy");
    assert.equal(status, 200);
    const s = sections();
    assert.deepEqual(s.map((x) => x.n), Array.from({ length: 14 }, (_, i) => i + 1), "privacy.md has sections 1 to 14");
    for (const x of s) assert.equal(codeBlocks(copySection("privacy.md", `${x.n}. `)).length, 1, `section ${x.n} has one code block`);
    // Section 1's block begins with the title; each other section's heading comes before its block.
    const want = s.flatMap((x) => [...(x.n === 1 ? [] : [x.heading]), ...copyLines(lines(x.n))]);
    const foot = copyLines(block("home.md", "頁尾"));
    wantLines(page, [...want, ...foot]);
    assert.ok(squash(visibleText(page)).endsWith(squash(want[want.length - 1]!) + foot.map(squash).join("")), "nothing between the last line and the foot");
    // The statement is a commitment: its text is privacy.md's and nothing else, not only in order.
    const main = page.slice(page.indexOf("<main>"), page.indexOf("</main>"));
    assert.equal(squash(visibleText(main)), squash(want.join("")), "the statement's text is exactly privacy.md's");
  });

  test("each section's paragraphs and points as privacy.md writes them: a paragraph of · lines is points of a list, any other a paragraph", async () => {
    const { page } = await getPage(worker, "/privacy");
    const main = page.slice(page.indexOf("<main>"), page.indexOf("</main>"));
    const parts = main.split('<section class="part">');
    assert.equal(parts.length, 14, "the opening, then thirteen sections");
    for (const [i, part] of parts.entries()) {
      const n = i + 1;
      const paragraphs = lines(n).join("\n").split("\n\n").map((p) => p.split("\n"));
      const points = paragraphs.filter((p) => p.every((l) => l.startsWith("· "))).flat().length;
      // Section 1's first paragraph is the title, an <h1>.
      const others = paragraphs.filter((p) => !p.every((l) => l.startsWith("· "))).length - (n === 1 ? 1 : 0);
      assert.equal(part.match(/<li>/g)?.length ?? 0, points, `section ${n}: a point for each · line`);
      assert.equal(part.match(/<p\b/g)?.length ?? 0, others, `section ${n}: a paragraph for each other paragraph`);
    }
  });

  test("the title, and each section's heading as a heading of the page; the tab's title", async () => {
    const { page } = await getPage(worker, "/privacy");
    const title = lines(1)[0]!;
    assert.ok(page.includes(`<h1 class="title">${title}</h1>`), "section 1's first line is the title");
    assert.deepEqual(
      [...page.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]),
      sections().slice(1).map((x) => x.heading),
      "sections 2 to 14's headings, in order",
    );
    assert.ok(page.includes(`<title>${title}｜島民證明</title>`));
  });

  test("in bold: the first sentence of each point of section 2, and section 4's 要知道的事 and the first sentence of each point after it", async () => {
    const { page } = await getPage(worker, "/privacy");
    assert.match(copySection("privacy.md", "2. "), /每一條的開頭一句是粗體/);
    assert.match(copySection("privacy.md", "4. "), /「要知道的事：」是粗體，每一條的開頭一句也是/);
    const four = lines(4);
    const after = four.slice(four.indexOf("要知道的事：")).filter((l) => l.startsWith("· ")).map((l) => l.slice(2));
    assert.equal(after.length, 4, "section 4 has four points after 要知道的事");
    const bold = [...points(2).map(firstSentence), "要知道的事：", ...after.map(firstSentence)];
    assert.deepEqual([...page.matchAll(/<strong>([^<]*)<\/strong>/g)].map((m) => m[1]), bold, "these, and nothing else, in bold");
  });

  test("the links privacy.md asks for under its sections", async () => {
    const { page } = await getPage(worker, "/privacy");
    for (const [n, words, href] of [
      [6, "它的隱私權政策", "https://www.cloudflare.com/privacypolicy/"],
      [8, "了解更多", "/faq#threads-knows"],
      [12, "Apple 的隱私權政策", "https://www.apple.com/legal/privacy/"],
      [12, "Google 的隱私權政策", "https://policies.google.com/privacy"],
      [14, "修改紀錄", "https://github.com/iamreal-tw/iamreal/commits/main/design/copy/privacy.md"],
    ] as const) {
      const section = copySection("privacy.md", `${n}. `);
      assert.ok(section.includes(`「${words}」連到`) && section.includes(href), `privacy.md section ${n} says ${words} goes to ${href}`);
      assert.ok(page.includes(`<a href="${href}">${words}</a>`), `the page links ${words} to ${href}`);
    }
    const main = page.slice(page.indexOf("<main>"), page.indexOf("</main>"));
    assert.equal(main.match(/<a\b/g)?.length, 5, "no other link in the statement");
  });

  test("the foot links to it, on every page: home.md says where", async () => {
    assert.ok(block("home.md", "頁尾")[0]!.includes("隱私權說明"), "home.md's foot has 隱私權說明");
    assert.match(copySection("home.md", "頁尾"), /「隱私權說明」連到「隱私權說明」那一頁（`\/privacy`/);
    for (const path of ["/", "/faq", "/prepare", "/privacy"]) {
      const { page } = await getPage(worker, path);
      const foot = page.slice(page.indexOf('<footer class="foot">'));
      assert.ok(foot.includes('<a href="/privacy">隱私權說明</a>'), `the foot of ${path} links to /privacy`);
    }
  });
});
