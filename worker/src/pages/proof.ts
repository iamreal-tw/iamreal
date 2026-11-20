// The page of a card: design/copy/proof-page.md. The markup is the Go
// backend's (server/pages/templates/proof.html, proof-missing.html,
// parts.html). This file only turns data into HTML; the Worker
// (src/visitor.ts) reads the address and the roster.
import { formatDay } from "iamreal-protocol/date.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { SHORT_ID_LENGTH } from "iamreal-protocol/scoped-id.ts";
import type { CardsOfShortId, HistoryRow, PageCard } from "../page-data.ts";
import { Html, html } from "./html.ts";
import { type Document, NEEDS } from "./layout.ts";

/** The one platform the pages show: the first version lists Threads only (proof-page.md). The other platforms of a test roster are not shown. */
export const PLATFORM = "threads";

/**
 * The longest account, in characters, written at the full size on the first
 * screen; a longer one is written one size smaller, so that on a phone it
 * stays on one line where it can.
 */
export const LONG_ACCOUNT = 18;

/**
 * Whether `username` is a Threads username in its one spelling, by the
 * platform table (spec/scope.md), which has the same row for Threads in
 * both rosters. The page links to and embeds an account by its name, so a
 * name that is not one stops the page.
 */
function isThreadsUsername(username: string): boolean {
  return platformsOf("production").find((p) => p.platform === PLATFORM)?.format.accepts(username) === true;
}

/** The length of a scoped ID's text form (spec/scoped-id.md). */
const SCOPED_ID_LENGTH = 52;

/**
 * The beginnings of scoped IDs the pages write for them: 10 characters (the
 * short ID), or as many more as it takes for no two of them to be the same
 * (GLOSSARY.md, 島民編號).
 */
export function prefixes(ids: readonly string[]): string[] {
  let n = SHORT_ID_LENGTH;
  while (n < SCOPED_ID_LENGTH && new Set(ids.map((id) => id.slice(0, n))).size < ids.length) n++;
  return ids.map((id) => id.slice(0, n));
}

/** How long ago a date was, as the pages write it: 今天 or N 天前, in whole days. A date after today (the clock stepped back) is written as today. */
function daysAgo(day: number, today: number): string {
  return today - day <= 0 ? "今天" : `${today - day} 天前`;
}

const currentOf = (card: PageCard): string | null => card.slots.find((s) => s.platform === PLATFORM)?.current ?? null;

/** The title of the link preview (proof-page.md, section 8). */
function titleOf(cards: readonly PageCard[]): string {
  if (cards.length > 1) return `這個網址對到 ${cards.length} 張自然人憑證`;
  const account = currentOf(cards[0]!);
  return account === null ? "這張自然人憑證現在沒有把名額給任何帳號" : `一張自然人憑證把 Threads 的名額給了 @${account}`;
}

/**
 * One row of 全部紀錄 (proof-page.md, section 4). After a withdrawal,
 * declaring the account withdrawn is 再次宣告, and declaring another one is
 * written as a switch or a correction from the account withdrawn. A row the
 * page has no words for stops the page, rather than leave the row blank.
 */
function eventOf(row: HistoryRow): string {
  const { kind, before, after } = row;
  if (kind === "first" && after !== null) return `新宣告：@${after}`;
  if (kind === "refresh") {
    if (!row.afterWithdrawal) return "再次過卡";
    if (after !== null) return `再次宣告：@${after}`;
  }
  if (kind === "switch" && before !== null && after !== null) return `更換：@${before} 改成 @${after}`;
  if (kind === "correction" && before !== null && after !== null) return `更正：@${before} 改成 @${after}`;
  if (kind === "withdraw" && before !== null) return `收回：@${before}`;
  throw new Error("pages: no words for a row of the history");
}

/** Sections 1 to 4, or 6 and 4, of one card. `nested` is one of several cards: its title is not the page's. */
function cardSections(card: PageCard, shortId: string, today: number, nested: boolean): Html {
  const account = currentOf(card);
  if (account !== null && !isThreadsUsername(account)) throw new Error("pages: a card has an account that is not a Threads username");
  const rows = card.history.filter((row) => row.platform === PLATFORM);
  const heading = (inside: Html): Html => (nested ? html`<h2 class="title">${inside}</h2>` : html`<h1 class="title">${inside}</h1>`);
  const when = html`<p class="when">上次過卡：${daysAgo(card.lastCardProof, today)}（${formatDay(card.lastCardProof)}）</p>`;
  let top: Html;
  if (account !== null) {
    top = html`<section class="claim">
${heading(html`<span class="line">一張台灣國民的自然人憑證，</span>
<span class="line">把它在 Threads 唯一的名額給了</span>
<span class="${account.length > LONG_ACCOUNT ? "account long" : "account"}">@${account}</span>`)}
<p class="small scope">這張證明只涵蓋 Threads 上的 @${account}。名稱不同的帳號、Instagram 或其他平台上同名的帳號，都不在這張證明裡。</p>
</section>
<section class="last">
${when}
<p class="small">那一天檢查過：這張自然人憑證在效期內，不在廢止清冊上。之後有沒有被廢止，要等下一次過卡才知道。</p>
<p class="small">島民建議持卡人每季過卡一次。隔得越久，這張證明的說服力越低。 <a href="/proof">我要更新這張證明</a></p>
</section>
<section class="owner">
<h2 class="ask">帳號主人承認嗎？你需要自己看。</h2>
<p>@${account} 的個人檔案上有這個連結，才代表帳號主人承認：</p>
<p class="backlink">iamreal.tw/p/${shortId}</p>
<iframe class="threads-profile" src="https://www.threads.com/@${account}/embed/" title="Threads 個人檔案：@${account}" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" credentialless></iframe>
<p class="small">@${account} 的個人檔案上沒有 ${shortId}，代表帳號主人可能沒有承認這張證明。</p>
<p class="small">個人檔案顯示不出來時，請到 Threads 上看：<a href="https://www.threads.com/@${account}">Threads 的 @${account}</a></p>
</section>`;
  } else {
    // The account of the latest withdrawal on Threads, if there is one.
    const withdrawn = rows.find((row) => row.kind === "withdraw")?.before ?? null;
    top = html`<section class="claim withdrawn">
${heading(html`這張自然人憑證現在沒有把名額給任何帳號`)}
</section>
<section class="last">
${when}${withdrawn === null ? new Html("") : html`
<p class="small">那一天收回了 Threads 的 @${withdrawn}。</p>`}
</section>`;
  }
  const switches = card.slots.find((s) => s.platform === PLATFORM)?.switchCount ?? 0;
  return html`${top}
<section class="record">
<h2>這張自然人憑證在名冊上的紀錄</h2>
<ul class="facts">
<li>第一次過卡：${formatDay(card.firstCardProof)}</li>
<li>過卡 ${card.cardProofs} 次</li>
<li>在 Threads 更換過 ${switches} 次帳號（一張自然人憑證最多 5 次）</li>
</ul>
<details class="history">
<summary>全部紀錄</summary>
<ol class="log">
${rows.map((row) => html`<li><time>${formatDay(row.date)}</time> <span>${eventOf(row)}</span></li>`)}
</ol>
</details>
</section>`;
}

/** proof-page.md, section 5. */
const VERIFY = html`<section class="verify">
<p>這份證明是在持卡人的裝置上算出來的，永久公布在名冊上。任何人都可以驗證名冊上的每一份證明，都來自一張有效的自然人憑證。</p>
<p><a href="/verify">怎麼驗證</a></p>
</section>`;

/** proof-page.md, section 5a; the last line is home.md's 〈需要什麼〉. */
const MINE = html`<section class="mine">
<p>一張自然人憑證可以換一張 Threads 的島民證明，上面寫著你的 Threads 帳號。</p>
<p><a class="button" href="/proof">我也要換島民證明</a></p>
<p class="small">${NEEDS}</p>
</section>`;

/**
 * The page of the short ID `shortId` (in its one spelling) for the cards it
 * resolves to: one or more, in ascending order of scoped ID. A short ID
 * that resolves to no card has the page of `proofMissing`.
 */
export function proofPage(shortId: string, { today, cards }: CardsOfShortId): Document {
  if (cards.length === 0) throw new Error("pages: no card for the short ID");
  let content: Html;
  if (cards.length === 1) content = cardSections(cards[0]!, shortId, today, false);
  else {
    const starts = prefixes(cards.map((c) => c.scopedId));
    content = html`<section class="many">
<h1 class="title">這個網址對到 ${cards.length} 張自然人憑證</h1>
<p class="small">它們的島民編號開頭 10 個字元碰巧相同，彼此沒有關聯。</p>
</section>
${cards.map(
  (card, i) => html`<article class="one-of-many">
<p class="prefix">島民編號 <span class="id">${starts[i]!}</span> 開頭</p>
${cardSections(card, shortId, today, true)}
</article>`,
)}`;
  }
  return { title: titleOf(cards), kind: "proof", content: html`${content}\n${VERIFY}\n${MINE}` };
}

/**
 * The page of a short ID that resolves to no card (proof-page.md, section
 * 9). `typed` is what the visitor typed after /p/, written back on the page
 * as it is, escaped.
 */
export function proofMissing(typed: string): Document {
  const content = html`<section class="missing">
<h1 class="title">找不到這張島民證明</h1>
<p><span class="typed">iamreal.tw/p/${typed}</span> 沒有對到任何一張自然人憑證。請確認網址有沒有抄錯。</p>
<p>如果你是從某個帳號的個人檔案點進來的，請留意這張島民證明並不存在。</p>
<p><a href="/roster#q">查一個 Threads 帳號</a></p>
</section>`;
  return { title: "找不到這張島民證明", kind: "proof-missing", content };
}
