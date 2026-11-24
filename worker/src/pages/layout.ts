// What every page of the visitors has: the document around its content, the
// navigation bar and the foot (design/copy/home.md, 導覽列 and 頁尾;
// design/DESIGN.md, 元件), and on a test log the mark above everything else
// (design/copy/test-site.md).
import { Html, html } from "./html.ts";

/** Where the style sheet is served, and what the pages link to. */
export const CSS_PATH = "/pages.css";

/** Where the copy buttons' script is (site/copy.js, sent by Static Assets): the one script of the pages, loaded by /verify and /hang/<short ID> only. */
export const COPY_JS_PATH = "/copy.js";

/** What every page says about the site that makes it. */
export interface Site {
  /**
   * For a test log, the date it was last cleared on, `YYYY-MM-DD`: every
   * page then says so at its top and asks not to be indexed. Null for the
   * production log.
   */
  readonly testProofLogClearedOn: string | null;
  /**
   * The site's domain, as a page writes it where it writes its own address
   * (`iamreal.tw/p/…`; on a test log's site its own,
   * design/copy/test-site.md).
   */
  readonly host: string;
}

/** What the layout reads of a page. */
export interface Document {
  /** The title of the link preview (og:title); the <title> is it followed by ｜島民證明, or `tabTitle` if there is one. */
  readonly title: string;
  readonly tabTitle?: string;
  /** False for a page with no link preview at all (no og:title, no og:site_name). */
  readonly preview?: boolean;
  /** True for a page that loads the copy buttons' script (`COPY_JS_PATH`). */
  readonly script?: boolean;
  /** og:description, for the one page that has one. */
  readonly description?: string;
  /** Which page: the class of <body>. */
  readonly kind: string;
  readonly content: Html;
}

/** The mark, as web/src/ui/logo.ts draws it; its colours are classes of the style sheet. */
const LOGO = new Html(
  '<svg class="logo" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><g class="logo-card"><g transform="rotate(-9 27 39)"><rect x="3" y="24" width="46" height="30" rx="5.5" class="logo-card-body"></rect><rect x="9.5" y="31" width="10" height="8" rx="2" class="logo-chip"></rect></g></g><g class="logo-island"><path d="M14.84 45.97 L13.85 48.00 L13.07 50.14 L12.75 52.17 L12.77 54.25 L12.55 56.14 L12.16 58.00 L10.62 57.46 L9.79 56.13 L9.59 53.94 L8.48 51.29 L8.06 50.54 L6.45 49.06 L4.99 48.32 L3.86 47.23 L4.01 47.32 L3.18 45.85 L2.54 44.28 L1.23 39.83 L0.78 38.76 L0.17 37.78 L0.00 36.81 L0.21 35.73 L0.77 34.12 L1.12 32.49 L0.84 30.29 L0.95 28.10 L1.37 27.13 L8.83 13.81 L10.85 10.98 L12.10 9.59 L13.14 8.02 L14.13 6.04 L15.34 4.22 L16.21 3.67 L20.49 2.04 L21.82 0.48 L22.89 0.00 L24.10 0.03 L24.89 0.77 L25.58 1.65 L26.31 2.12 L28.21 2.98 L29.04 3.81 L29.42 5.25 L28.26 6.60 L27.69 7.83 L27.58 9.18 L27.79 11.01 L27.82 12.85 L26.37 17.16 L24.83 19.84 L24.41 21.18 L23.94 24.50 L23.03 27.84 L22.26 32.06 L20.99 36.41 L20.28 38.23 L19.38 39.98 L17.25 43.27 Z" transform="translate(31.5 3) scale(0.97)" class="logo-island-body" stroke-width="2.6" stroke-linejoin="round" paint-order="stroke"></path></g></svg>',
);

/** home.md's 〈需要什麼〉: the one place it is written. The home page shows it once (第一屏), the page of a card once (section 5a). */
export const NEEDS = "需要實體的自然人憑證，和手機，或讀卡機和電腦。";

/** The four links of the navigation bar (home.md, 導覽列), and its one button. */
const NAV_LINKS = html`<a href="/verify">怎麼驗證島民證明</a>
<a href="/proof-log">證明紀錄</a>
<a href="/faq">常見問題</a>
<a href="https://github.com/iamreal-tw/iamreal">GitHub</a>`;
const NAV_BUTTON = html`<a class="button nav-button" href="/proof">我要換島民證明</a>`;

/**
 * The navigation bar (home.md, 導覽列; design/DESIGN.md, 元件). On a wide
 * screen the links and the button are in the bar; on a narrow one the style
 * sheet hides them and shows the menu instead: a <details>, which opens
 * without a script and from the keyboard, with the same links and button.
 * The two are in the document once each, and the style sheet shows one.
 * The links and the button are one group, so that where they do not fit
 * beside the name they go to the next row together.
 */
const NAV = html`<header class="top">
<div class="bar">
<a class="home" href="/">${LOGO}<b>島民證明</b><span class="domain">iamreal.tw</span></a>
<div class="wide">
<nav class="links">
${NAV_LINKS}
</nav>
${NAV_BUTTON}
</div>
<details class="menu"><summary>選單</summary>
<nav>
${NAV_LINKS}
${NAV_BUTTON}
</nav>
</details>
</div>
</header>`;

/** The foot (home.md, 頁尾). */
const FOOT = html`<footer class="foot">
<div class="bar">
<span class="site"><b>島民證明</b><span>iamreal.tw</span></span>
<a href="/verify">怎麼驗證島民證明</a>
<a href="/proof-log">證明紀錄</a>
<a href="/faq">常見問題</a>
<a href="/prepare">過卡需要什麼</a>
<a href="https://github.com/iamreal-tw/iamreal/discussions">意見回饋</a>
<a href="https://github.com/iamreal-tw/iamreal">GitHub</a>
</div>
</footer>`;

/** The whole document of a page. */
export function layout(site: Site, d: Document): string {
  const test = site.testProofLogClearedOn;
  return html`<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${test === null ? new Html("") : new Html('<meta name="robots" content="noindex">\n')}<title>${d.tabTitle ?? `${d.title}｜島民證明`}</title>
${d.preview === false ? new Html("") : html`<meta property="og:title" content="${d.title}">
<meta property="og:site_name" content="島民證明 iamreal.tw">
`}${d.description === undefined ? new Html("") : html`<meta property="og:description" content="${d.description}">
`}<link rel="stylesheet" href="${CSS_PATH}">
${d.script === true ? html`<script src="${COPY_JS_PATH}" defer></script>
` : new Html("")}</head>
<body class="${d.kind}">
${test === null ? new Html("") : html`<p class="test-proof-log">測試的證明紀錄　不定期清空，上次清空：<time>${test}</time></p>
`}${NAV}
<main>
${d.content}
</main>
${FOOT}
</body>
</html>
`.text;
}
