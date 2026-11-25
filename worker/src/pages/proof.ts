// The page of a card: design/copy/proof-page.md. The markup is the Go
// backend's (e159ab9:server/pages/templates/proof.html, proof-missing.html,
// parts.html). This file only turns data into HTML; the Worker
// (src/visitor.ts) reads the address and the proof log.
import { formatDay } from "iamreal-protocol/date.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { SHORT_ID_LENGTH } from "iamreal-protocol/scoped-id.ts";
import type { CardsOfShortId, PageCard } from "../page-data.ts";
import { Html, html, thousands } from "./html.ts";
import { type Document, NEEDS, type Site } from "./layout.ts";
import { ON_A_CARD, recordWords } from "./record-words.ts";

/** The one platform the pages show: the first version lists Threads only (proof-page.md). The other platforms of a test log are not shown. */
export const PLATFORM = "threads";

/**
 * The longest account, in characters, written at the full size on the first
 * screen of the page of a card and of an account (design/DESIGN.md, 字: 76
 * and 48 pixels, about as many characters as fill the column on a desktop
 * and the width of a phone); a longer one is written one size smaller, so
 * that it stays on one line where it can.
 */
const LONG_ACCOUNT = 12;

/** The account as the first screen of the page of a card and of an account writes it: the largest words, one size smaller when it is long. */
export function accountName(account: string): Html {
  return html`<span class="${account.length > LONG_ACCOUNT ? "account long" : "account"}">@${account}</span>`;
}

/**
 * Whether `username` is a Threads username in its one spelling, by the
 * platform table (spec/scope.md), which has the same row for Threads in
 * both proof logs. The page links to and embeds an account by its name, so a
 * name that is not one stops the page.
 */
export function isThreadsUsername(username: string): boolean {
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

/**
 * The profile of a Threads account, embedded with no script of Threads
 * (sandbox without allow-scripts), no referrer and no credentials. The
 * account must be a Threads username already checked; it is escaped all the
 * same.
 */
export function embed(account: string): Html {
  return html`<iframe class="threads-profile" src="https://www.threads.com/@${account}/embed/" title="Threads 個人檔案：@${account}" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" credentialless></iframe>`;
}

/** How long ago a date was, as the pages write it: 今天 or N 天前, in whole days. A date after today (the clock stepped back) is written as today. */
export function daysAgo(day: number, today: number): string {
  return today - day <= 0 ? "今天" : `${today - day} 天前`;
}

const currentOf = (card: PageCard): string | null => card.slots.find((s) => s.platform === PLATFORM)?.current ?? null;

/** The card's ordinal as the page writes it, above the title and in section 4 (proof-page.md, sections 1 and 4). */
const ordinalOf = (card: PageCard): string => `第 ${thousands(card.ordinal)} 張島民證明`;

/** The title of the link preview (proof-page.md, section 8). */
function titleOf(cards: readonly PageCard[]): string {
  if (cards.length > 1) return `這個網址對到 ${cards.length} 張自然人憑證`;
  const account = currentOf(cards[0]!);
  return account === null ? "這張自然人憑證現在沒有把名額給任何帳號" : `一張自然人憑證把 Threads 的名額給了 @${account}`;
}

/**
 * The first screen of one card: sections 1 and 2 (or 6) in one column, and
 * section 3 in the other. `nested` is one of several cards: its title is
 * not the page's.
 */
function firstScreen(site: Site, card: PageCard, shortId: string, today: number, nested: boolean): Html {
  const account = currentOf(card);
  if (account !== null && !isThreadsUsername(account)) throw new Error("pages: a card has an account that is not a Threads username");
  // The title, with the ordinal right above it: a small line in the secondary colour, never beside the account.
  const titled = (inside: Html): Html => html`<p class="ordinal">${ordinalOf(card)}</p>
${nested ? html`<h2 class="title">${inside}</h2>` : html`<h1 class="title">${inside}</h1>`}`;
  const when = html`<p class="when">上次過卡：${daysAgo(card.lastCardProof, today)}<span class="date">（${formatDay(card.lastCardProof)}）</span></p>`;
  if (account === null) {
    // The account of the latest withdrawal on Threads, if there is one.
    const withdrawn = card.history.find((row) => row.platform === PLATFORM && row.kind === "withdraw")?.before ?? null;
    return html`<div class="first">
<div class="column">
<section class="claim withdrawn">
${titled(html`這張自然人憑證現在沒有把名額給任何帳號`)}
</section>
<section class="last">
${when}${withdrawn === null ? new Html("") : html`
<p class="small">那一天收回了 Threads 的 @${withdrawn}。</p>`}
</section>
</div>
</div>`;
  }
  return html`<div class="first">
<div class="column">
<section class="claim">
${titled(html`<span class="line">一張台灣國民的自然人憑證，</span>
<span class="line">把它在 Threads 唯一的名額給了</span>
${accountName(account)}`)}
<p class="small scope">這張證明只涵蓋 Threads 上的 @${account}。名稱不同的帳號、Instagram 或其他平台上同名的帳號，都和這張證明無關。</p>
</section>
<section class="last">
${when}
<p class="small">過卡日當天，這張自然人憑證在效期內，不在廢止清冊上。無法判斷卡片是否依然有效，要等下一次過卡才知道。因此越久沒過卡，這張證明的說服力越低，建議持卡人每三個月過卡一次。</p>
<p class="small"><a href="/proof">我要更新這張證明</a></p>
</section>
</div>
<section class="owner">
<h2 class="ask">帳號主人承認這張證明嗎？</h2>
<p>@${account} 的個人檔案上有這個連結，才代表帳號主人承認這張證明：</p>
<p class="backlink">${site.host}/p/${shortId}</p>
${embed(account)}
<p class="small">@${account} 的個人檔案上沒有 ${shortId}，代表帳號主人可能沒有承認這張證明。</p>
<p class="small">個人檔案顯示不出來時，請到 Threads 上看：<a href="https://www.threads.com/@${account}">Threads 的 @${account}</a></p>
<p class="small yours">這是你的帳號？<a href="/hang/${shortId}">把它掛到個人檔案上</a></p>
</section>
</div>`;
}

/** Section 4 of one card. */
function record(card: PageCard): Html {
  const rows = card.history.filter((row) => row.platform === PLATFORM);
  const switches = card.slots.find((s) => s.platform === PLATFORM)?.switchCount ?? 0;
  return html`<section class="record">
<h2>這張自然人憑證的證明紀錄</h2>
<dl class="facts">
<div><dt>順序</dt><dd>${ordinalOf(card)}</dd></div>
<div><dt>第一次過卡</dt><dd>${formatDay(card.firstCardProof)}</dd></div>
<div><dt>過卡次數</dt><dd>${card.cardProofs} 次</dd></div>
<div><dt>更換帳號</dt><dd>在 Threads 更換過 ${switches} 次帳號（一張自然人憑證最多 5 次）</dd></div>
</dl>
<details class="history">
<summary>全部紀錄</summary>
<ol class="log">
${rows.map((row) => html`<li><time>${formatDay(row.date)}</time> <span>${recordWords(row, ON_A_CARD)}</span></li>`)}
</ol>
</details>
</section>`;
}

/** proof-page.md, section 5: the page's one way on, to how to check an account's proof (/check). */
const HOW_TO_CHECK = html`<section class="how-to-check">
<h2>如何檢查</h2>
<p>這張證明是在持卡人的裝置上算出來的，永久公布在證明紀錄裡。看一個帳號有沒有台灣人背書，要看哪幾個地方、小心哪些手法：</p>
<p><a href="/check">如何檢查 Threads 帳號的島民證明</a></p>
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
 * that resolves to no card has the page of `proofMissing`. The page's own
 * address is written with the site's domain (`site.host`).
 */
export function proofPage(site: Site, shortId: string, { today, cards }: CardsOfShortId): Document {
  if (cards.length === 0) throw new Error("pages: no card for the short ID");
  let content: Html;
  // Section 4 beside section 5 (one card), or each card's section 4 under its first screen and section 5 once, after the last (several).
  if (cards.length === 1) {
    content = html`${firstScreen(site, cards[0]!, shortId, today, false)}
<div class="second">
${record(cards[0]!)}
${HOW_TO_CHECK}
</div>`;
  } else {
    const starts = prefixes(cards.map((c) => c.scopedId));
    content = html`<section class="many">
<h1 class="title">這個網址對到 ${cards.length} 張自然人憑證</h1>
<p class="small">它們的島民編號開頭 10 個字元碰巧相同，彼此沒有關聯。</p>
</section>
${cards.map(
  (card, i) => html`<article class="one-of-many">
<p class="prefix">島民編號 <span class="id">${starts[i]!}</span> 開頭</p>
${firstScreen(site, card, shortId, today, true)}
<div class="second">
${record(card)}
</div>
</article>`,
)}
<div class="second">
${HOW_TO_CHECK}
</div>`;
  }
  return { title: titleOf(cards), kind: "proof", content: html`${content}\n${MINE}` };
}

/**
 * The page of a short ID that resolves to no card (proof-page.md, section
 * 9). `typed` is what the visitor typed after /p/, written back on the page
 * as it is, escaped.
 */
export function proofMissing(site: Site, typed: string): Document {
  const content = html`<section class="missing">
<h1 class="title">找不到這張島民證明</h1>
<p><span class="typed">${site.host}/p/${typed}</span> 沒有對到任何一張自然人憑證。請確認網址有沒有抄錯。</p>
<p>如果你是從某個帳號的個人檔案點進來的，請留意這張島民證明並不存在。</p>
<p><a href="/proof-log#q">查一個 Threads 帳號</a></p>
</section>`;
  return { title: "找不到這張島民證明", kind: "proof-missing", content };
}
