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
// Without one (/hang): part 2 as it is 從首頁點進來時, with no copy button
// and so without that script.
//
// Each of the four steps has its picture under its words, and the page of a
// card has one more under the two lines of part 3: what the profile looks
// like with the link on it (hang.md, 示意圖). They are drawn as /check's are
// (./sketch.ts), the profile the same drawing, with what to press framed in
// raspberry. They write the card's account and its address, or hang.md's
// fixed examples on the page without a proof, in the site's own domain.
//
// Both pages have the demonstration (hang.md, 示範): the five
// screens of design/motion/hang.json in a row, hidden as the page is sent, and
// that timeline as data the browser does not run. The page without a proof
// writes hang.md's fixed examples in it, and says above its first screen that
// this is the page one has with a proof. The link's last step differs by
// platform (design/motion/README.md, 框): the page has both ways back from the
// links, and the player chooses by the browser it runs in, so the Worker sends
// every device the same page and reads nothing of the device. The player (/demo.js)
// shows it in place of the pictures and plays it; without the player the
// page is the one above. Every box the timeline names is a [data-box]; what a
// change of the screens shows or moves says so in data-on, data-off and
// data-shift (demo/player.js). The paste bubble is inside its box, not the box
// itself: its ring goes on where the bubble was after the bubble is gone
// (design/motion/README.md, 按). Nothing inline: the looks are the style
// sheet's, and what moves is the player's.
//
// The title is broken after 掛到 by hand (design/DESIGN.md, 字: 標題的斷行要手動指定).
import { HANG_TIMELINE_JSON } from "./hang-timeline.ts";
import { Html, html } from "./html.ts";
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
${four.map(([words, picture], i) => html`<li data-step="${i + 1}"><span class="n">${i + 1}</span><p class="say">${words}</p>
${picture}
</li>`)}
</ol>`;
}

/** Where the demonstration's timeline is in the page: the id of its data block. */
const TIMELINE_ID = "hang-timeline";

/** What a screen reader is told of the whole demonstration (hang.md, 示範). */
const DEMO_TOLD = "示範：按「複製連結」，到 Threads 的個人檔案按「編輯個人檔案」、「連結」、「新增連結」，貼上網址後按「完成」，個人檔案上多了一行連結。";

/** The frame around what to press and its label, there while the timeline marks the box. */
const mark = (label?: string, where = ""): Html => html`<span class="mark"></span>${label === undefined ? html`` : html`<span class="mark-tag${where}">${label}</span>`}`;

/** What a box that is pressed has: the ink that darkens it, and the ring. */
const PRESS = html`<span class="pressed"></span><span class="ring"></span>`;

/** A row of the two lists: its words, then a grey bar or what stands in its place. */
const row = (words: string, end: Html = html`<span class="blank"></span>`): Html => html`<p class="row"><span>${words}</span>${end}</p>`;

/**
 * The demonstration for the account `account` (without its @) and the card of `short`, with its button and its
 * timeline. `first` is the small line above the first screen: which page of this site it is.
 */
function demo(site: Site, account: string, short: string, first: string): Html {
  const address = `${site.host}/p/${short}`;
  const link = proofLink(site, short);
  // The links' top has both ways back: 完成 at the right, which the iPhone's demonstration presses, and ✕ at the left,
  // which Android's does. The player says which platform it shows (data-variant), and the style sheet then takes ✕
  // out on the iPhone's and greys 完成 on Android's.
  const linksTop = html`<p class="top"><span class="act close" data-box="x3">✕${mark("按這裡", " beside")}${PRESS}</span><b>連結</b><span class="act" data-box="done3">完成${mark("再按一次", " right")}${PRESS}</span></p>`;
  return html`<div class="demo" data-demo="${TIMELINE_ID}" hidden>
<div class="demo-picture" role="img" aria-label="${DEMO_TOLD}">
<div class="demo-row" aria-hidden="true">
<div class="shot s0" data-box="s0"><p class="kick">${first}</p>
<p class="heading"><span>把島民證明掛到</span><span class="cut"><span class="clip">@${account}</span> 的個人檔案</span></p>
<p class="address">${address}</p>
<p class="pair"><span class="main" data-box="copy"><span class="swap"><span data-off="copied">複製連結</span><span class="over" data-on="copied">已複製</span></span>${mark()}${PRESS}</span><span class="second" data-box="open">打開 Threads${mark()}${PRESS}</span></p>
<p class="lines"><span class="blank"></span><span class="blank"></span><span class="blank"></span><span class="blank"></span></p>
</div>
<div class="shot s1" data-box="s1"><p class="kick">Threads 的個人檔案（示意）</p>
<p class="who"><span><span class="blank name"></span><span class="handle clip">@${account}</span></span><span class="avatar"></span></p>
<p class="bio"><span class="blank"></span><span class="blank"></span></p>
<div class="below">
<p class="link-row" data-box="linkrow" data-on="linkOnProfile"><span class="link-icon"></span><span class="clip">${address}</span><span class="found" data-on="resultLabel"></span><span class="found-tag" data-on="resultLabel">訪客找的就是這一行</span></p>
<div class="rest" data-shift="linkOnProfile:38 resultLabel:46">
<p class="blank followers"></p>
<p class="buttons"><span data-box="edit">編輯個人檔案${mark("按這裡")}${PRESS}</span><span><span class="blank"></span></span></p>
</div>
</div>
</div>
<div class="shot s2" data-box="s2"><p class="kick">按了「編輯個人檔案」之後（示意）</p>
<p class="top"><b>編輯個人檔案</b></p>
${["名稱", "用戶名稱", "個人簡介", "興趣"].map((item) => row(item))}
<p class="row" data-box="links"><span>連結</span><span class="chevron"></span>${mark("按這裡")}${PRESS}</p>
${row("精選")}
</div>
<div class="shot s3" data-box="s3"><p class="kick">按了「連結」之後（示意）</p>
${linksTop}
<div class="below">
<p class="row added" data-on="linkListed"><span class="clip">${address}</span></p>
<p class="row" data-box="add" data-shift="linkListed:54"><span>新增連結</span>${mark("按這裡")}${PRESS}</p>
</div>
</div>
<div class="shot s4" data-box="s4"><p class="kick">按了「新增連結」之後（示意）</p>
<p class="top"><b>新增連結</b><span class="act" data-box="done4">完成${mark("再按這裡", " right")}${PRESS}</span></p>
<p class="field-label">網址</p>
<p class="field" data-box="urlfield"><span class="clip" data-on="pasted">${link}</span><span class="paste-at" data-box="paste"><span class="paste" data-on="pasteMenu" data-off="pasted">貼上</span>${PRESS}</span>${mark("貼在這裡", " right")}${PRESS}</p>
<p class="field-label">標題（選填）</p>
<p class="field"></p>
</div>
</div>
</div>
<p class="demo-control"><button type="button" class="button quiet" data-demo-button data-stop="停止" data-replay="再看一次">再看一次</button></p>
</div>
<script type="application/json" id="${TIMELINE_ID}">${new Html(HANG_TIMELINE_JSON.replaceAll("<", "\\u003c"))}</script>`;
}

/** /hang: the page from the home page, without a proof. */
export function hangWithout(site: Site): Document {
  const content = html`<section class="hang">
<h1 class="title"><span class="line">把島民證明掛到</span> <span class="line">Threads 的個人檔案</span></h1>
<p class="actions"><a class="button quiet" href="https://www.threads.com/" target="_blank" rel="noopener noreferrer">打開 Threads</a></p>
<div class="how">
${demo(site, EXAMPLE_ACCOUNT, EXAMPLE_SHORT, "有了島民證明之後的這一頁")}
${steps(site, EXAMPLE_ACCOUNT, EXAMPLE_SHORT, "你的島民證明的連結")}
</div>
<p class="none-yet">還沒有島民證明？ <a class="button" href="/proof" data-count="start_card_proof">我要換島民證明</a></p>
</section>`;
  return { title: TITLE, kind: "hang", demo: true, content };
}

/** /hang/<short ID>: the page for the card of the short ID `short` (in its one spelling), whose account on Threads is `account`. */
export function hangPage(site: Site, short: string, account: string): Document {
  if (!isThreadsUsername(account)) throw new Error("pages: the account is not in the Threads format");
  const address = `${site.host}/p/${short}`;
  const content = html`<section class="hang">
<h1 class="title"><span class="line">把島民證明掛到</span> <span class="line"><span class="account">@${account}</span> 的個人檔案</span></h1>
<p class="backlink">${address}</p>
<p class="actions"><button type="button" class="copy button" data-copy-text="${proofLink(site, short)}" data-copied="已複製" data-count="copy_proof_link" hidden>複製連結</button> <a class="button quiet" href="https://www.threads.com/@${account}" target="_blank" rel="noopener noreferrer">打開 Threads</a></p>
<div class="how">
${demo(site, account, short, "島民證明的畫面")}
${steps(site, account, short, "剛才複製的連結")}
</div>
<p class="done"><a href="/p/${short}">掛好了嗎？打開你的島民證明看看。</a></p>
<p class="small">頁面上的個人檔案裡看得到這個連結，就成功了。</p>
${sketch(
  "result",
  "掛好之後的個人檔案（示意）",
  `你的個人檔案：帳號 @${account}，簡介下面多了一行粗體的連結 ${address}。訪客在你的個人檔案上找的就是這一行。`,
  profile({ name: null, account: `@${account}`, followers: null, link: { address, found: "訪客找的就是這一行" } }),
)}
</section>`;
  return { title: TITLE, kind: "hang", script: true, demo: true, content };
}
