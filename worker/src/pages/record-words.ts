// What one valid record did on one platform, in words: a row of 全部紀錄 on the
// page of a card (design/copy/proof-page.md, section 4) and a row of the
// proof log page's list (design/copy/proof-log-page.md, 清單). The two use the
// same words for the same kinds; the proof log page also names the platform,
// and names the account of 再次過卡, since its rows are of many cards.
import type { HistoryRow } from "../page-data.ts";
import { Html, html } from "./html.ts";

/** How a page writes the accounts of a row. */
export interface RowStyle {
  /** The first account of the row. */
  account(name: string): Html;
  /** The account after 改成. */
  changedTo(name: string): Html;
  /** Whether 再次過卡 names the account. */
  readonly refreshNamesAccount: boolean;
}

/** The page of a card's: `@name`, and 再次過卡 alone. */
export const ON_A_CARD: RowStyle = { account: (name) => html`@${name}`, changedTo: (name) => html`@${name}`, refreshNamesAccount: false };

/** The proof log page's: the first account with its platform, the accounts in bold, and 再次過卡 with its account. */
export function onTheProofLog(platformName: string): RowStyle {
  return { account: (name) => html`${platformName} 的 <b>@${name}</b>`, changedTo: (name) => html`<b>@${name}</b>`, refreshNamesAccount: true };
}

/**
 * One row. After a withdrawal, declaring the account withdrawn is 再次宣告,
 * and declaring another one is written as a switch or a correction from
 * the account withdrawn. A row there are no words for stops the page,
 * rather than leave the row blank.
 */
export function recordWords(row: HistoryRow, a: RowStyle): Html {
  const { kind, before, after } = row;
  if (kind === "first" && after !== null) return html`新宣告：${a.account(after)}`;
  if (kind === "refresh" && !row.afterWithdrawal) {
    if (!a.refreshNamesAccount) return html`再次過卡`;
    if (after !== null) return html`再次過卡：${a.account(after)}`;
  }
  if (kind === "refresh" && row.afterWithdrawal && after !== null) return html`再次宣告：${a.account(after)}`;
  if (kind === "switch" && before !== null && after !== null) return html`更換：${a.account(before)} 改成 ${a.changedTo(after)}`;
  if (kind === "correction" && before !== null && after !== null) return html`更正：${a.account(before)} 改成 ${a.changedTo(after)}`;
  if (kind === "withdraw" && before !== null) return html`收回：${a.account(before)}`;
  throw new Error("pages: no words for a row of the history");
}
