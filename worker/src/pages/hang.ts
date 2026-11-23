// Hanging a proof on a profile: design/copy/hang.md. The markup is the Go
// backend's (e159ab9:server/pages/templates/hang.html). This file only turns data
// into HTML; the Worker (src/visitor.ts) reads the address and the proof log.
//
// With a card's account (/hang/<short ID>): part 2 and the two lines of
// part 3. The link is written out without https://, selectable, as the page
// of the card writes it (hang.md: 和島民證明頁面上的寫法相同), so on a test
// log's site in its own domain (design/copy/test-site.md); the copy
// buttons' script (/copy.js) shows the button that copies it whole, with
// https://, hidden without the script. Without one (/hang): part 2 as it is
// 從首頁點進來時, with no script. No pictures yet (hang.md, 還沒定的).
import { html } from "./html.ts";
import type { Document, Site } from "./layout.ts";
import { isThreadsUsername } from "./proof.ts";

const TITLE = "把島民證明掛到個人檔案";

/** /hang: the page from the home page, without a proof. */
export function hangWithout(): Document {
  const content = html`<section class="hang">
<h1 class="title">把島民證明掛到 Threads 的個人檔案</h1>
<p class="actions"><a class="button quiet" href="https://www.threads.com/" target="_blank" rel="noopener noreferrer">打開 Threads</a></p>
<ol class="steps">
<li><span class="n">1</span><div>打開你的個人檔案，按「編輯個人檔案」</div></li>
<li><span class="n">2</span><div>按「連結」，貼上你的島民證明的連結</div></li>
<li><span class="n">3</span><div>存檔</div></li>
</ol>
<p class="none-yet">還沒有島民證明？ <a class="button" href="/proof">我要換島民證明</a></p>
</section>`;
  return { title: TITLE, kind: "hang", content };
}

/** /hang/<short ID>: the page for the card of the short ID `short` (in its one spelling), whose account on Threads is `account`. */
export function hangPage(site: Site, short: string, account: string): Document {
  if (!isThreadsUsername(account)) throw new Error("pages: the account is not in the Threads format");
  const content = html`<section class="hang">
<h1 class="title">把島民證明掛到 <span class="account">@${account}</span> 的個人檔案</h1>
<p class="backlink">${site.host}/p/${short}</p>
<p class="actions"><button type="button" class="copy button" data-copy-text="https://${site.host}/p/${short}" data-copied="已複製" hidden>複製連結</button> <a class="button quiet" href="https://www.threads.com/@${account}" target="_blank" rel="noopener noreferrer">打開 Threads</a></p>
<ol class="steps">
<li><span class="n">1</span><div>打開你的個人檔案，按「編輯個人檔案」</div></li>
<li><span class="n">2</span><div>按「連結」，貼上剛才複製的連結</div></li>
<li><span class="n">3</span><div>存檔</div></li>
</ol>
<p class="done">掛好了嗎？<a href="/p/${short}">打開你的島民證明</a>看看。</p>
<p>頁面上的個人檔案裡看得到這個連結，就成功了。</p>
</section>`;
  return { title: TITLE, kind: "hang", script: true, content };
}
