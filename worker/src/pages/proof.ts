// The page of a card: design/copy/proof-page.md. The markup is the Go
// backend's (e159ab9:server/pages/templates/proof.html, proof-missing.html,
// parts.html). This file only turns data into HTML; the Worker
// (src/visitor.ts) reads the address and the proof log.
import { formatDay } from "iamreal-protocol/date.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { SHORT_ID_LENGTH } from "iamreal-protocol/scoped-id.ts";
import type { CardsOfShortId, PageCard } from "../page-data.ts";
import { Html, html, thousands } from "./html.ts";
import { type Document, type Site } from "./layout.ts";
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

/** The card's ordinal as the page writes it, above the title (proof-page.md, section 1). */
const ordinalOf = (card: PageCard): string => `第 ${thousands(card.ordinal)} 張島民證明`;

/** The title of the link preview (proof-page.md, section 7). */
function titleOf(cards: readonly PageCard[]): string {
  if (cards.length > 1) return `這個網址對到 ${cards.length} 張自然人憑證`;
  const account = currentOf(cards[0]!);
  return account === null ? "這張自然人憑證現在沒有把名額給任何帳號" : `一張自然人憑證宣告了 Threads 的 @${account}`;
}

/**
 * Section 3 of one card (or its part in section 5): the last card proof,
 * every valid record of the card on Threads, newest first, and, while the
 * card gives its place to an account, the two small lines for its holder.
 * `withdrawn` is the account of the latest withdrawal on a card that gives
 * its place to none.
 */
function lastAndRecords(card: PageCard, shortId: string, today: number, giving: boolean, withdrawn: string | null): Html {
  const rows = card.history.filter((row) => row.platform === PLATFORM);
  return html`<section class="last">
<p class="when">上次過卡：${daysAgo(card.lastCardProof, today)}<span class="date">（${formatDay(card.lastCardProof)}）</span></p>${withdrawn === null ? new Html("") : html`
<p class="small">那一天收回了 Threads 的 @${withdrawn}。</p>`}
<h2 class="records">這張自然人憑證的證明紀錄</h2>
<ol class="log">
${rows.map((row) => html`<li><time>${formatDay(row.date)}</time> <span>${recordWords(row, ON_A_CARD)}</span></li>`)}
</ol>${giving ? html`
<p class="small advice">建議持卡人每三個月過卡一次</p>
<p class="small yours">這是你的證明？<a href="/proof" data-count="start_card_proof">過卡更新這張證明</a>・<a href="/hang/${shortId}">把它掛到個人檔案上</a></p>` : new Html("")}
</section>`;
}

/**
 * Sections 1 to 3 of one card, or section 5 for one that gives its place
 * to no account: in this order on a phone; on a desktop sections 1 and 2 in
 * the left column and section 3 in the right (pages.css). `nested` is one
 * of several cards: its title is not the page's.
 */
function firstScreen(site: Site, card: PageCard, shortId: string, today: number, nested: boolean): Html {
  const account = currentOf(card);
  if (account !== null && !isThreadsUsername(account)) throw new Error("pages: a card has an account that is not a Threads username");
  // The title, with the ordinal right above it: a small line in the secondary colour, never beside the account.
  const titled = (inside: Html): Html => html`<p class="ordinal">${ordinalOf(card)}</p>
${nested ? html`<h2 class="title">${inside}</h2>` : html`<h1 class="title">${inside}</h1>`}`;
  if (account === null) {
    // The account of the latest withdrawal on Threads, if there is one.
    const withdrawn = card.history.find((row) => row.platform === PLATFORM && row.kind === "withdraw")?.before ?? null;
    return html`<div class="first">
<section class="claim withdrawn">
${titled(html`這張自然人憑證現在沒有把名額給任何帳號`)}
</section>
${lastAndRecords(card, shortId, today, false, withdrawn)}
</div>`;
  }
  return html`<div class="first">
<section class="claim">
${titled(html`<span class="line">一張台灣國民的自然人憑證</span>
<span class="line">宣告了 Threads 的</span>
${accountName(account)}`)}
</section>
<section class="owner">
<h2 class="ask"><a href="https://www.threads.com/@${account}">個人檔案</a>上有這個連結，才代表 @${account} 承認本證明。</h2>
<p class="backlink">${site.host}/p/${shortId}</p>
${embed(account)}
</section>
${lastAndRecords(card, shortId, today, true, null)}
</div>`;
}

/** proof-page.md, section 4: once on the page, after the last card. */
const MINE = html`<section class="mine">
<p>一張自然人憑證只能換一張島民證明，上面只能宣告一個 Threads 帳號。</p>
<p><a class="button" href="/proof" data-count="start_card_proof">我也要換島民證明</a></p>
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
  if (cards.length === 1) {
    content = firstScreen(site, cards[0]!, shortId, today, false);
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
</article>`,
)}`;
  }
  return { title: titleOf(cards), kind: "proof", content: html`${content}\n${MINE}` };
}

/**
 * The page of a short ID that resolves to no card (proof-page.md, section
 * 8). `typed` is what the visitor typed after /p/, written back on the page
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
