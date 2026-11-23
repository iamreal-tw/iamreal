// The page of a Threads account: design/copy/account-page.md. The markup is
// the Go backend's (e159ab9:server/pages/templates/account.html,
// account-not-a-name.html). This file only turns data into HTML; the Worker
// (src/visitor.ts) reads the address and the proof log.
import { formatDay } from "iamreal-protocol/date.ts";
import { shortId } from "iamreal-protocol/scoped-id.ts";
import type { CardsOfAccount } from "../page-data.ts";
import { Html, html } from "./html.ts";
import type { Document } from "./layout.ts";
import { daysAgo, embed, isThreadsUsername, prefixes } from "./proof.ts";

/**
 * The page of the account `username` on Threads (in its one spelling): the
 * cards that give their place to it now (sections 1 to 3). The profile is
 * embedded once, under the list, and only when there is a card to compare
 * it with.
 */
export function accountPage(username: string, { today, cards }: CardsOfAccount): Document {
  if (!isThreadsUsername(username)) throw new Error("pages: the account is not in the Threads format");
  let inside: Html;
  if (cards.length === 0) inside = html`<p>沒有自然人憑證把名額給這個帳號。<br>名稱要和 Threads 上的完全相同。</p>`;
  else {
    const starts = prefixes(cards.map((c) => c.scopedId));
    inside = html`<p>有 ${cards.length} 張自然人憑證把它在 Threads 的名額給了這個帳號。</p>
<ul class="cards">
${cards.map(
  (c, i) =>
    html`<li><span class="id-line">島民編號 <span class="id">${starts[i]!}</span> 開頭</span> <span>${formatDay(c.since)} 起</span> <span>上次過卡 ${daysAgo(c.lastCardProof, today)}</span> <a href="/p/${shortId(c.scopedId)}">看這張島民證明</a></li>`,
)}
</ul>
<p>帳號主人承認的是哪一張，看 @${username} 的個人檔案上放的是哪一張的連結：</p>
${embed(username)}
<p class="small">任何持卡人都可以把名額給任何帳號，張數不代表支持或連署。</p>`;
  }
  const content = html`<section class="lookup">
<h1 class="title">Threads 的 <span class="account">@${username}</span></h1>
${inside}
</section>`;
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
