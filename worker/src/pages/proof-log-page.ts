// The proof log page: design/copy/proof-log-page.md. The markup is the Go
// backend's (its proof log page's template at e159ab9), but for the link of
// 下載整份證明紀錄, which goes to the part of iamreal-verify's README about
// downloading (proof-log-page.md, 下載): the proof log is on the data domain
// (ADR-0027), not under /proof-log/. This file only turns data into HTML; the
// Worker (src/visitor.ts) reads the address and the proof log.
import { formatDay, parseDay } from "iamreal-protocol/date.ts";
import { shortId } from "iamreal-protocol/scoped-id.ts";
import type { Counts, LatestPlace, LatestSlot } from "../page-data.ts";
import { Html, html, thousands } from "./html.ts";
import type { Document } from "./layout.ts";

/** How many slots the proof log page lists at a time (proof-log-page.md, 清單). */
export const PAGE_SIZE = 50;

/** Where 下載整份證明紀錄 goes: the section 下載 of iamreal-verify's README. */
const DOWNLOAD = "https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md#下載";

/** A place in the list as ?after= carries it: the date and the seq, `2026-11-17.123`. */
export function formatPlace(p: LatestPlace): string {
  return `${formatDay(p.since)}.${p.sinceSeq}`;
}

/** The largest seq the Go backend reads as a place; above it, its list started from the latest slot. */
const MAX_INT64 = 2n ** 63n - 1n;
/** The largest seq that reads as a place here, as a number the proof log's SQLite is given: no record has a larger one, so the list after it is the same. */
const MAX_SEQ = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Reads what `formatPlace` writes, as the Go backend's `ParsePosition`
 * reads it: a date, a dot and a seq that is not 0, written without a sign or
 * a leading zero, at most 2^64 − 1. Null if it does not read: the list then
 * starts from the latest slot. A seq above 2^63 − 1 reads, and starts the
 * list from the latest slot too (`place` null), as it did in Go.
 */
export function readPlace(s: string): { readonly place: LatestPlace | null } | null {
  if (s.length < 12 || s[10] !== ".") return null;
  const since = parseDay(s.slice(0, 10));
  const digits = s.slice(11);
  if (since === null || !/^[1-9][0-9]*$/.test(digits) || digits.length > 20) return null;
  const seq = BigInt(digits);
  if (seq > 2n ** 64n - 1n) return null;
  if (seq > MAX_INT64) return { place: null };
  return { place: { since, sinceSeq: Number(seq > MAX_SEQ ? MAX_SEQ : seq) } };
}

/** What the proof log page shows. */
export interface ProofLogView {
  readonly counts: Counts;
  /** The slots listed: at most PAGE_SIZE. */
  readonly slots: readonly LatestSlot[];
  /** There are slots after the last one listed. */
  readonly more: boolean;
  /** The list starts after a place (?after=), not at the latest slot. */
  readonly after: boolean;
  /** What the visitor typed in the lookup box, for a lookup that is not in the Threads format; null otherwise. */
  readonly badQuery: string | null;
}

export function proofLogPage(v: ProofLogView): Document {
  const empty = v.slots.length === 0 && !v.after;
  const last = v.slots[v.slots.length - 1];
  const list = empty
    ? html`
<p>證明紀錄裡還沒有島民證明。</p>`
    : html`
<p class="small">列在這裡，只代表有一張自然人憑證把名額給了這個帳號。帳號主人承不承認，要點進那一張看。</p>
<ul class="rows">${
        v.slots.length === 0
          ? new Html("")
          : html`
${v.slots.map((s) => html`<li><a href="/p/${shortId(s.scopedId)}"><time>${formatDay(s.since)}</time> <span class="who">Threads 的 @${s.username}</span> <span class="id-line">島民編號 <span class="id">${shortId(s.scopedId)}</span> 開頭</span></a></li>`)}`
      }
</ul>${
        v.more && last !== undefined
          ? html`
<p class="more"><a href="/proof-log?after=${formatPlace(last)}">更多</a></p>`
          : new Html("")
      }`;
  const content = html`<section class="numbers">
<h1 class="title">證明紀錄</h1>
<p>現在有 ${thousands(v.counts.declared)} 張島民證明，其中 ${thousands(v.counts.recent)} 張在過去三個月內過卡。</p>
</section>
<section class="query">
<form method="get" action="/proof-log">
<p><label for="q">查一個 Threads 帳號</label></p>
<p class="field"><span class="at">@</span><input type="text" id="q" name="q" value="${v.badQuery ?? ""}" autocomplete="off" autocapitalize="none" spellcheck="false"> <button type="submit">查</button></p>${
    v.badQuery === null
      ? new Html("")
      : html`
<p class="small bad">Threads 的帳號名稱只有英文字母、數字、句點和底線。</p>`
  }
</form>
</section>
<section class="latest">
<h2>最近換出的島民證明</h2>${list}
</section>
<section class="download">
<p><a href="${DOWNLOAD}">下載整份證明紀錄</a> <a href="/verify">怎麼驗證島民證明</a></p>
</section>`;
  return { title: "證明紀錄", kind: "proof_log", content };
}
