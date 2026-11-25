// Hanging a proof on a profile: design/copy/hang.md, laid out after
// design/screens/hang-proof-*.png and hang-*.png. This file only turns data
// into HTML; the Worker (src/visitor.ts) reads the address and the proof log.
//
// With a card's account (/hang/<short ID>): part 2 and the two lines of
// part 3, the first of them a link as a whole. The link is written out
// without https://, selectable, as the page of the card writes it (hang.md:
// 和島民證明頁面上的寫法相同), so on a test log's site in its own domain
// (design/copy/test-site.md); the copy buttons' script (/copy.js) shows the
// button that copies it whole, with https://, hidden without the script.
// Without one (/hang): part 2 as it is 從首頁點進來時, with no script.
//
// Each of the four steps has its picture under its words, and the page of a
// card has one more under the two lines of part 3: what the profile looks
// like with the link on it (hang.md, 示意圖). They are drawn as /check's are
// (./sketch.ts), the profile the same drawing, with what to press framed in
// raspberry. They write the card's account and its address, or hang.md's
// fixed examples on the page without a proof, in the site's own domain.
//
// The title is broken after 掛到 by hand (design/DESIGN.md, 字: 標題的斷行要手動指定).
import { type Html, html } from "./html.ts";
import type { Document, Site } from "./layout.ts";
import { isThreadsUsername } from "./proof.ts";
import { profile, sketch, tag } from "./sketch.ts";

const TITLE = "把島民證明掛到個人檔案";

/** hang.md's examples, for the page without a proof. */
const EXAMPLE_ACCOUNT = "alice";
const EXAMPLE_SHORT = "7K2Q9FM4XD";

/** The link of the card of `short` whole, as 複製連結 copies it and as picture 4 pastes it (the one way the pages write it: scripts/deploy-build-checks.ts). */
const proofLink = (site: Site, short: string): string => `https://${site.host}/p/${short}`;

/**
 * The four steps, each its words and the picture under them, for the account `account` (without its @) and the
 * card of `short`; `what` is what step 4 pastes (hang.md: 剛才複製的連結, or 你的島民證明的連結 without a proof).
 */
function steps(site: Site, account: string, short: string, what: string): Html {
  const link = proofLink(site, short);
  const four: [string, Html][] = [
    [
      "打開你的個人檔案，按「編輯個人檔案」",
      sketch("press", "Threads 的個人檔案（示意）", `你的個人檔案：帳號 @${account}，大頭貼在右邊，最下面兩顆按鈕。要按的是左邊的「編輯個人檔案」。`, profile({ name: null, account: `@${account}`, followers: null, edit: "按這裡" })),
    ],
    [
      "按「連結」",
      sketch(
        "press",
        "按了「編輯個人檔案」之後（示意）",
        "一份清單：名稱、用戶名稱、個人簡介、興趣、連結、精選。要按的是「連結」。",
        html`<div class="screen">
${["名稱", "用戶名稱", "個人簡介", "興趣"].map((item) => html`<p class="row"><span>${item}</span><span class="blank"></span></p>`)}
<p class="row press"><span>連結</span><span class="chevron"></span></p>
${tag("按這裡", "press")}
<p class="row"><span>精選</span><span class="blank"></span></p>
</div>`,
      ),
    ],
    [
      "按「新增連結」",
      sketch(
        "press",
        "按了「連結」之後（示意）",
        "標題是「連結」的畫面，裡面一列「新增連結」，要按的就是它。已經有連結時，會列在「新增連結」上面。",
        html`<div class="screen">
<p class="screen-title">連結</p>
<p class="row press"><span>新增連結</span></p>
${tag("按這裡", "press")}
</div>`,
      ),
    ],
    [
      `在「網址」貼上${what}，按右上角的「完成」`,
      sketch(
        "press",
        "按了「新增連結」之後（示意）",
        `標題是「新增連結」的畫面，兩個欄位：「網址」填著 ${link}，「標題（選填）」空著。貼好網址，再按右上角的「完成」。`,
        html`<div class="screen">
<p class="screen-top"><span class="screen-title">新增連結</span><span class="press">完成</span></p>
<p class="end">${tag("再按這裡", "press")}</p>
<p class="field-label">網址</p>
<p class="field press">${link}</p>
${tag("貼在這裡", "press")}
<p class="field-label">標題（選填）</p>
<p class="field"></p>
</div>`,
      ),
    ],
  ];
  return html`<ol class="steps">
${four.map(([words, picture], i) => html`<li><span class="n">${i + 1}</span><p class="say">${words}</p>
${picture}
</li>`)}
</ol>`;
}

/** /hang: the page from the home page, without a proof. */
export function hangWithout(site: Site): Document {
  const content = html`<section class="hang">
<h1 class="title"><span class="line">把島民證明掛到</span> <span class="line">Threads 的個人檔案</span></h1>
<p class="actions"><a class="button quiet" href="https://www.threads.com/" target="_blank" rel="noopener noreferrer">打開 Threads</a></p>
${steps(site, EXAMPLE_ACCOUNT, EXAMPLE_SHORT, "你的島民證明的連結")}
<p class="none-yet">還沒有島民證明？ <a class="button" href="/proof">我要換島民證明</a></p>
</section>`;
  return { title: TITLE, kind: "hang", content };
}

/** /hang/<short ID>: the page for the card of the short ID `short` (in its one spelling), whose account on Threads is `account`. */
export function hangPage(site: Site, short: string, account: string): Document {
  if (!isThreadsUsername(account)) throw new Error("pages: the account is not in the Threads format");
  const address = `${site.host}/p/${short}`;
  const content = html`<section class="hang">
<h1 class="title"><span class="line">把島民證明掛到</span> <span class="line"><span class="account">@${account}</span> 的個人檔案</span></h1>
<p class="backlink">${address}</p>
<p class="actions"><button type="button" class="copy button" data-copy-text="${proofLink(site, short)}" data-copied="已複製" hidden>複製連結</button> <a class="button quiet" href="https://www.threads.com/@${account}" target="_blank" rel="noopener noreferrer">打開 Threads</a></p>
${steps(site, account, short, "剛才複製的連結")}
<p class="done"><a href="/p/${short}">掛好了嗎？打開你的島民證明看看。</a></p>
<p class="small">頁面上的個人檔案裡看得到這個連結，就成功了。</p>
${sketch(
  "result",
  "掛好之後的個人檔案（示意）",
  `你的個人檔案：帳號 @${account}，簡介下面多了一行粗體的連結 ${address}。訪客在你的個人檔案上找的就是這一行。`,
  profile({ name: null, account: `@${account}`, followers: null, link: { address, found: "訪客找的就是這一行" } }),
)}
</section>`;
  return { title: TITLE, kind: "hang", script: true, content };
}
