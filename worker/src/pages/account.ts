// The page of a Threads account: design/copy/account-page.md. The markup is
// the Go backend's (e159ab9:server/pages/templates/account.html,
// account-not-a-name.html). This file only turns data into HTML; the Worker
// (src/visitor.ts) reads the address and the proof log.
import { formatDay } from "iamreal-protocol/date.ts";
import { shortId } from "iamreal-protocol/scoped-id.ts";
import type { CardsOfAccount } from "../page-data.ts";
import { Html, html } from "./html.ts";
import type { Document } from "./layout.ts";
import { accountName, daysAgo, embed, isThreadsUsername, prefixes } from "./proof.ts";

/**
 * The page of the account `username` on Threads (in its one spelling): the
 * cards that give their place to it now (sections 1 to 3). Laid out as the
 * page of a card: the account and the count, then the profile, embedded
 * once and only when there is a card to compare it with, then the list,
 * which only grows; on a desktop the list in the right column (pages.css).
 */
export function accountPage(username: string, { today, cards }: CardsOfAccount): Document {
  if (!isThreadsUsername(username)) throw new Error("pages: the account is not in the Threads format");
  const heading = html`<h1 class="title"><span class="line">Threads 的</span>
${accountName(username)}</h1>`;
  let content: Html;
  if (cards.length === 0) {
    content = html`<section class="lookup">
${heading}
<p class="count">沒有自然人憑證宣告這個帳號。</p>
<p class="small">名稱要和 Threads 上的完全相同。</p>
</section>`;
  } else {
    const starts = prefixes(cards.map((c) => c.scopedId));
    content = html`<div class="first">
<section class="claim">
${heading}
<p class="count">有 ${cards.length} 張自然人憑證宣告了這個帳號。</p>
<p class="small">任何持卡人都可以宣告任何帳號，張數不代表支持或連署。</p>
</section>
<section class="owner">
<h2 class="ask"><a href="https://www.threads.com/@${username}">個人檔案</a>上有哪一張的連結，才代表 @${username} 承認那一張。</h2>
${embed(username)}
</section>
<section class="cards-of">
<ul class="cards">
${cards.map(
  (c, i) =>
    html`<li><p class="id-line"><span>島民編號 <span class="id">${starts[i]!}</span> 開頭</span> <a href="/p/${shortId(c.scopedId)}">看這張島民證明</a></p><p class="meta"><span>${formatDay(c.since)} 起</span> <span>上次過卡 ${daysAgo(c.lastCardProof, today)}</span></p></li>`,
)}
</ul>
</section>
</div>`;
  }
  return { title: `Threads 的 @${username}`, kind: "account", content };
}

/** A name that cannot be a Threads username (section 4). It does not write the name, and has no link preview. */
export function notAName(): Document {
  const content = html`<section class="missing">
<h1 class="title">Threads 沒有這樣的帳號名稱</h1>
<p>Threads 的帳號名稱只有英文字母、數字、句點和底線。</p>
<p><a href="/proof-log#q">查一個 Threads 帳號</a></p>
</section>`;
  return { title: "Threads 沒有這樣的帳號名稱", kind: "account-not-a-name", preview: false, content };
}
