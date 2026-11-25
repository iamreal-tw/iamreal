// Reading design/copy/ for the tests of the pages: the sentences a page must
// show are read from the copy files, never written again in a test. The
// same reading as the Go backend's tests (e159ab9:server/visitor_test.go).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORKER_DIR } from "./build.ts";

const COPY_DIR = join(WORKER_DIR, "..", "design", "copy");

export function readCopy(file: string): string {
  return readFileSync(join(COPY_DIR, file), "utf8");
}

/** The text of the section of `file` whose "## " heading starts with `heading`, up to the next "## ". */
export function copySection(file: string, heading: string): string {
  const text = readCopy(file);
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `${file} has a section ${JSON.stringify(heading)}`);
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ", 3);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The lines of each code block of `text`. */
export function codeBlocks(text: string): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (inside) out.push(current);
      inside = !inside;
      current = [];
    } else if (inside) current.push(line);
  }
  return out;
}

/** Code block `n` of a section. */
export function block(file: string, heading: string, n = 0): string[] {
  const blocks = codeBlocks(copySection(file, heading));
  assert.ok(n < blocks.length, `${file} section ${JSON.stringify(heading)} has a code block ${n}`);
  return blocks[n]!;
}

/** home.md's 〈需要什麼〉, which proof-page.md section 5a quotes. */
export function needs(): string {
  const b = block("home.md", "需要什麼");
  assert.equal(b.length, 1);
  return b[0]!;
}

/**
 * The lines a page must show, from a code block: the example values
 * replaced (pairs of old and new, applied in the order given, so the longer
 * of two overlapping values comes first), placeholders dropped (a line that
 * is all in （）), a link's [ ](網址) and bold's ** **, a button's [ ] and a
 * list item's · taken off, 〈需要什麼〉 put in.
 */
export function copyLines(lines: readonly string[], ...replace: string[]): string[] {
  const out: string[] = [];
  for (let l of lines) {
    l = l.trim();
    if (l === "" || l === "……" || /^（[^）]*）$/.test(l)) continue;
    l = l
      .replace(/^· /, "")
      .replace(LINK, "$1")
      .replace(BOLD, "$1")
      .replace(/\[\s*([^\]]*?)\s*\]/g, "$1")
      .replaceAll("〈需要什麼〉", needs());
    out.push(replaceEach(l, replace));
  }
  return out;
}

/** Replaces as Go's strings.NewReplacer does: at each place, the first pair that matches, and what was put in is not looked at again. */
function replaceEach(s: string, pairs: readonly string[]): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    let matched = false;
    for (let p = 0; p + 1 < pairs.length; p += 2) {
      if (pairs[p] !== "" && s.startsWith(pairs[p]!, i)) {
        out += pairs[p + 1];
        i += pairs[p]!.length;
        matched = true;
        break;
      }
    }
    if (!matched) out += s[i++];
  }
  return out;
}

/** `s` without any white space. */
export const squash = (s: string): string => s.replace(/\s/gu, "");

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#34;": '"', "&#39;": "'" };
export const unescapeHtml = (s: string): string => s.replace(/&(amp|lt|gt|quot|#34|#39);/g, (e) => ENTITIES[e]!);

/** The text of the page's body: tags removed, entities read. */
export function visibleText(page: string): string {
  const body = page.indexOf("<body");
  return unescapeHtml((body < 0 ? page : page.slice(body)).replace(/<[^>]*>/g, " "));
}

/** Checks that every line is on the page, in this order. */
export function wantLines(page: string, lines: readonly string[]): void {
  const text = squash(visibleText(page));
  let at = 0;
  const problems: string[] = [];
  for (const l of lines) {
    const i = text.indexOf(squash(l), at);
    if (i < 0) problems.push(`${text.includes(squash(l)) ? "out of order" : "not on the page"}: ${JSON.stringify(l)}`);
    else at = i + squash(l).length;
  }
  assert.deepEqual(problems, [], `the page's text:\n${visibleText(page).replace(/\s+/g, " ")}`);
}

/** Checks that none of the lines is on the page. */
export function notOnPage(page: string, ...lines: string[]): void {
  const text = squash(visibleText(page));
  for (const l of lines) assert.ok(!text.includes(squash(l)), `on the page, but should not be: ${JSON.stringify(l)}`);
}

export function firstMatch(re: RegExp, s: string): string {
  const m = re.exec(s);
  return m === null ? "" : unescapeHtml(m[1]!);
}

export const TITLE_TAG = /<title>([^<]*)<\/title>/;
export const OG_TITLE = /<meta property="og:title" content="([^"]*)">/;
export const OG_SITE = /<meta property="og:site_name" content="([^"]*)">/;
export const OG_DESCRIPTION = /<meta property="og:description" content="([^"]*)">/;

/**
 * Checks the page's <title> (`title` followed by ｜島民證明), its og:title
 * (`title`) and its og:site_name (`site`); with `site` null, that the page
 * has no link preview at all.
 */
export function wantPreview(page: string, title: string, site: string | null): void {
  assert.equal(firstMatch(TITLE_TAG, page), `${title}｜島民證明`, "<title>");
  if (site === null) {
    assert.ok(!page.includes("og:"), "no link preview on the page");
    return;
  }
  assert.equal(firstMatch(OG_TITLE, page), title, "og:title");
  assert.equal(firstMatch(OG_SITE, page), site, "og:site_name");
}

/** The alt text of the image of every page's link preview (proof-page.md, section 8, 預覽圖; its code block 1 is the words on the image). */
export function previewImageAlt(): string {
  assert.ok(copySection("proof-page.md", "8. ").includes("\n### 預覽圖\n"), "proof-page.md section 8 has 預覽圖");
  const alt = block("proof-page.md", "8. ", 2);
  assert.equal(alt.length, 1, "the alt text is one line");
  return alt[0]!;
}

/** The 標題, 網站 and, if there is one, 摘要 lines of a copy file's preview block. */
export function previewOf(file: string, heading: string): { title: string; site: string; summary: string } {
  const value = (label: string): string => (block(file, heading).find((l) => l.startsWith(`${label}：`)) ?? "").slice(label.length + 1);
  return { title: value("標題"), site: value("網站"), summary: value("摘要") };
}

/** One question of faq.md: its category (the "## " heading), its heading, its answer (the code block) and its id on the page. */
export interface FaqQuestion {
  readonly category: string;
  readonly question: string;
  readonly id: string;
  readonly answer: string[];
}

/** One category of faq.md: its name (the "## " heading), its id on the page and its questions, in order. */
export interface FaqCategory {
  readonly name: string;
  readonly id: string;
  readonly questions: FaqQuestion[];
}

/** Every category of faq.md, in order, each with its questions in order. */
export function faqCategories(): FaqCategory[] {
  const out: FaqCategory[] = [];
  // The parts after the last category ("連結被貼出去時的預覽", "還沒定的") have no id and no questions.
  for (const part of readCopy("faq.md").split("\n## ").slice(1)) {
    const name = part.slice(0, part.indexOf("\n"));
    const [head, ...rest] = part.split("\n### ");
    const ids = [...head!.matchAll(/這一類在頁面上的 `id`：`([a-z0-9-]+)`/g)];
    if (ids.length === 0 && rest.length === 0) continue;
    assert.equal(ids.length, 1, `faq.md category ${JSON.stringify(name)} has one id`);
    const questions = rest.map((q) => {
      const question = q.slice(0, q.indexOf("\n"));
      const body = q.slice(q.indexOf("\n") + 1);
      const blocks = codeBlocks(body);
      const qids = [...body.matchAll(/這一題在頁面上的 `id`：`([a-z0-9-]+)`/g)];
      assert.deepEqual([blocks.length, qids.length], [1, 1], `faq.md ${JSON.stringify(question)} has one answer and one id`);
      return { category: name, question, id: qids[0]![1]!, answer: blocks[0]! };
    });
    assert.ok(questions.length > 0, `faq.md category ${JSON.stringify(name)} has questions`);
    out.push({ name, id: ids[0]![1]!, questions });
  }
  assert.ok(out.length > 0, "faq.md has categories");
  return out;
}

/** Every question of faq.md, in order. */
export function faqQuestions(): FaqQuestion[] {
  return faqCategories().flatMap((c) => c.questions);
}

/** A link in a copy file's code block: [字](網址). */
const LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g;
/** Bold in a copy file's code block: **字**. */
const BOLD = /\*\*([^*]+)\*\*/g;

/** The links of an answer of faq.md: the words and where they go, in order. */
export function faqLinks(answer: readonly string[]): { words: string; href: string }[] {
  return answer.flatMap((l) => [...l.matchAll(LINK)].map((m) => ({ words: m[1]!, href: m[2]! })));
}

/**
 * An answer of faq.md as the page writes it (faq.md, at the top): a blank
 * line a new paragraph, the paragraphs that start with · one list, **字**
 * bold, [字](網址) a link.
 */
export function faqAnswerHtml(answer: readonly string[]): string {
  const inline = (s: string): string =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replace(LINK, '<a href="$2">$1</a>')
      .replace(BOLD, "<strong>$1</strong>");
  const paragraphs = answer.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== "");
  const out: string[] = [];
  let items: string[] = [];
  const endList = (): void => {
    if (items.length > 0) out.push('<ul class="dots">', ...items, "</ul>");
    items = [];
  };
  for (const p of paragraphs) {
    if (p.startsWith("· ")) items.push(`<li>${inline(p.slice(2))}</li>`);
    else {
      endList();
      out.push(`<p>${inline(p)}</p>`);
    }
  }
  endList();
  return out.join("\n");
}

/** The address of a page of a card as a test log's site writes it (design/copy/test-site.md), for this short ID or whatever was typed in its place. */
export function testSiteCardAddress(shortId: string): string {
  const lines = block("test-site.md", "寫出島民證明網址的地方");
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.endsWith("/p/7K2Q9FM4XD"));
  return lines[0]!.replace("7K2Q9FM4XD", shortId);
}

/** The sentence beside the mark of a test log (design/copy/test-site.md), with this date in it. */
export function testProofLogLine(date: string): string {
  const lines = block("test-site.md", "測試的證明紀錄的標示");
  assert.equal(lines.length, 1);
  return lines[0]!.replace(/\d{4}-\d{2}-\d{2}/, date);
}
