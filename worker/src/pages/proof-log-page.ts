// The proof log page: design/copy/proof-log-page.md. Every valid record on
// Threads, by its place in the proof log, the latest first, 50 at a time; the
// link 更多 carries the `seq` of the last one listed. Below the numbers,
// before the list (proof-log-page.md, 下載), 下載全部的證明紀錄 goes to the
// part of iamreal-verify's README about downloading: the proof log is on the
// data domain (ADR-0027), not under /proof-log/. This file only turns data into HTML; the Worker
// (src/visitor.ts) reads the address and the proof log.
import { formatDay } from "iamreal-protocol/date.ts";
import { shortId } from "iamreal-protocol/scoped-id.ts";
import type { Counts, LogRow } from "../page-data.ts";
import { Html, html, thousands } from "./html.ts";
import type { Document } from "./layout.ts";
import { onTheProofLog, recordWords } from "./record-words.ts";

/** How many records the proof log page lists at a time (proof-log-page.md, 清單). */
export const PAGE_SIZE = 50;

/** Where 下載全部的證明紀錄 goes: the section 下載 of iamreal-verify's README. */
const DOWNLOAD = "https://github.com/iamreal-tw/iamreal/blob/main/cmd/iamreal-verify/README.md#下載";

const ON_THREADS = onTheProofLog("Threads");

/**
 * Reads `?after=`: the `seq` of the last record of the page before, written
 * without a sign or a leading zero, at most 2^53 − 1. Null if it does not
 * read: the list then starts from the latest record.
 */
export function readAfter(s: string): number | null {
  if (!/^[1-9][0-9]{0,15}$/.test(s)) return null;
  const seq = Number(s);
  return Number.isSafeInteger(seq) ? seq : null;
}

/** What the proof log page shows. */
export interface ProofLogView {
  readonly counts: Counts;
  /** The records listed: at most PAGE_SIZE, the latest first. */
  readonly rows: readonly LogRow[];
  /** There are records before the last one listed. */
  readonly more: boolean;
  /** The list starts before a record (?after=), not at the latest one. */
  readonly after: boolean;
  /** What the visitor typed in the lookup box, for a lookup that is not in the Threads format; null otherwise. */
  readonly badQuery: string | null;
}

export function proofLogPage(v: ProofLogView): Document {
  const empty = v.rows.length === 0 && !v.after;
  const last = v.rows[v.rows.length - 1];
  const list = empty
    ? html`
<p class="none">證明紀錄裡還沒有島民證明。</p>`
    : html`
<ol class="rows">${
        v.rows.length === 0
          ? new Html("")
          : html`
${v.rows.map((row) => html`<li><a href="/p/${shortId(row.scopedId)}"><time>${formatDay(row.date)}</time> <span class="id-line">島民編號 <span class="id">${shortId(row.scopedId)}</span> 開頭</span> <span class="what">${recordWords(row, ON_THREADS)}</span></a></li>`)}`
      }
</ol>${
        v.more && last !== undefined
          ? html`
<p class="more"><a href="/proof-log?after=${last.seq}">更多</a></p>`
          : new Html("")
      }`;
  const content = html`<div class="head">
<h1 class="title">證明紀錄</h1>
<section class="query">
<form method="get" action="/proof-log">
<p><label for="q">查一個 Threads 帳號</label></p>
<p class="field"><span class="box"><span class="at">@</span><input type="text" id="q" name="q" value="${v.badQuery ?? ""}" autocomplete="off" autocapitalize="none" spellcheck="false"></span> <button type="submit">查</button></p>${
    v.badQuery === null
      ? new Html("")
      : html`
<p class="small bad">Threads 的帳號名稱只有英文字母、數字、句點和底線。</p>`
  }
</form>
</section>
<section class="numbers">
<p>現在有 ${thousands(v.counts.declared)} 張島民證明，其中 ${thousands(v.counts.recent)} 張在過去三個月內過卡。</p>${
    empty
      ? new Html("")
      : html`
<p class="small">每一列是一張自然人憑證的一次過卡：新宣告、更換、收回或再次過卡。每張自然人憑證對應到唯一的島民編號。帳號主人承不承認，要點進那一張看。</p>`
  }
<p class="download"><a href="${DOWNLOAD}">下載全部的證明紀錄</a> <a href="/verify">如何驗證證明紀錄</a></p>
</section>
</div>
<section class="log">${list}
</section>`;
  return { title: "證明紀錄", kind: "proof_log", content };
}
