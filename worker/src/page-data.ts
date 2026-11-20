// What the visitors' pages read of the roster, behind one interface
// (ADR-0026): the pages ask `PageData` and know nothing of where the answer
// comes from. Now it comes from the roster's Durable Object, from the views
// it writes with each record (views.ts). If the pages' reads have to leave
// the object, this is the piece that is replaced; src/index.ts is the only
// place that says which one it is.
import type { Day } from "iamreal-protocol/date.ts";
import type { Kind } from "iamreal-protocol/roster-rules.ts";
import { rosterOf } from "./roster.ts";

/** The home page's two numbers (design/copy/home.md, section 2). */
export interface Counts {
  /** The cards that give their place on the platform to an account now. */
  readonly declared: number;
  /** Those among them whose last card proof is today or up to 90 days before, by Taiwan's date. */
  readonly recent: number;
}

/** What one valid record of a card did on one platform. */
export interface HistoryRow {
  /** The record's date. */
  readonly date: Day;
  readonly platform: string;
  /** The roster rules' kind. */
  readonly kind: Kind;
  /** The slot had been declared before and had no account just before this record. */
  readonly afterWithdrawal: boolean;
  /** The slot's last declared account just before the record; null for a first declaration. For a withdrawal it is the account withdrawn. */
  readonly before: string | null;
  /** The slot's account after the record; null after a withdrawal. */
  readonly after: string | null;
}

/** One card, as a page shows it. */
export interface PageCard {
  readonly scopedId: string;
  /** The earliest date among the card's valid records. */
  readonly firstCardProof: Day;
  /** The latest date among them. */
  readonly lastCardProof: Day;
  /** The number of the card's valid records. */
  readonly cardProofs: number;
  /** One entry for every platform on which a valid record of the card has had a kind, in ascending order of platform. */
  readonly slots: readonly { readonly platform: string; readonly current: string | null; readonly switchCount: number }[];
  /** What the card's valid records did, the newest first; a record with a kind on several platforms has a row for each. */
  readonly history: readonly HistoryRow[];
}

/** The cards of a short ID, in ascending order of scoped ID, and the date they were read on. */
export interface CardsOfShortId {
  /** Today, by Taiwan's date, on the clock of whoever answered. */
  readonly today: Day;
  readonly cards: readonly PageCard[];
}

export interface PageData {
  /** The numbers of the home page for a platform. */
  counts(platform: string): Promise<Counts>;
  /** The cards whose scoped ID starts with this short ID (in its one spelling); none is an empty list. */
  cards(shortId: string): Promise<CardsOfShortId>;
}

/** The page data that asks the roster's Durable Object. */
export function pageDataOfRoster(env: Env): PageData {
  return {
    counts: (platform) => rosterOf(env).pageCounts(platform),
    cards: (shortId) => rosterOf(env).pageCards(shortId),
  };
}
