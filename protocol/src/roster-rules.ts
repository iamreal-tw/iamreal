// The roster rules (spec/roster-rules.md, "Per record") as one function that
// keeps nothing: applyRecord takes a record, the state of its card before it
// and the three facts about the rest of the roster the checks read, and gives
// the record's result and the state of the card after it. It does not know
// where the state is kept. The server (one card's state read from and written
// to storage), a recomputation from the first record (rules-memory.ts) and
// the device (applyList: what a list would do, from the facts the server
// reports about one card, docs/api/card-proof.md) all run this code.
import { byBytes } from "./bytes.ts";
import type { Day } from "./date.ts";

/**
 * The version number of these rules (spec/roster-rules.md, "The version
 * number"). A stored card state was computed by one version; the Go
 * implementation has the same constant (roster.RulesVersion).
 */
export const RULES_VERSION = 1;

/** The state of one slot: one card on one platform (spec/roster-rules.md, "State"). */
export interface SlotState {
  current: string | null;
  lastDeclared: string | null;
  /** Valid switches of the slot, 0 to 5; it never decreases. */
  switchCount: number;
  /** The date of the slot's last valid `first` or `switch`. */
  correctionDate: Day | null;
}

/** The state of one card: its own items, and its slots by platform ID. Facts only, no conclusions. */
export interface CardState {
  lastCardProof: Day | null;
  /** The number of valid records of the card dated `lastCardProof`; 0 without one. */
  proofsOnLastDate: number;
  slots: ReadonlyMap<string, SlotState>;
}

/** The card's own items of its state, without its slots. */
export type CardItems = Pick<CardState, "lastCardProof" | "proofsOnLastDate">;

export const EMPTY_SLOT: Readonly<SlotState> = Object.freeze({ current: null, lastDeclared: null, switchCount: 0, correctionDate: null });

/** At most 3 valid records of a card have the same date (check 6, `daily_limit`). */
export const MAX_PER_DATE = 3;
/**
 * A record's date is no earlier than this many days before the latest date
 * among the earlier valid records, of any card (check 4, `date_order`).
 */
export const DATE_ORDER_DAYS = 4;
/** A card has 5 switches on each platform, for good (spec/roster-rules.md, "Switches and corrections"). */
export const MAX_SWITCHES = 5;
/**
 * How many days after today a date in the roster can be: a record's date is
 * at most 3 days after the date of the CRL behind its root
 * (spec/roster-rules.md, "How far dates are trusted").
 */
export const MAX_DAYS_AHEAD = 3;
/**
 * A record's date is at most this many days before the date of the CRL
 * behind its root (spec/revocation-tree.md, "Which roots a record may use").
 */
export const ROOT_DAYS_BEFORE = 1;

/** A platform's kind in a valid record. */
export type Kind = "first" | "refresh" | "correction" | "switch" | "withdraw";

/** An account of a record's list: at most one per platform. */
export interface Account {
  platform: string;
  username: string;
}

/** What a valid record did on one platform. */
export interface PlatformKind {
  platform: string;
  kind: Kind;
}

/** The reason code of an invalid record (spec/roster-rules.md, "Per record"). */
export type Reason = "proof" | "challenge_reused" | "root" | "date_order" | "empty" | "switch_limit" | "daily_limit";

/** The reason codes of checks 5 and 6. */
export type ListReason = "empty" | "switch_limit" | "daily_limit";

/**
 * The result of one record: valid with its kinds, in ascending order of
 * platform and at least one, or invalid with its reason code.
 *
 * `blockedPlatform`, with `switch_limit`, is the first platform blocked. It
 * is an explanation for people: the reason code is the whole result of an
 * invalid record (spec/roster-rules.md, "Output").
 */
export type RecordResult<R extends Reason = Reason> =
  | { valid: true; kinds: PlatformKind[] }
  | (R extends "switch_limit" ? { valid: false; reason: "switch_limit"; blockedPlatform: string } : { valid: false; reason: R });

/** A record as the rules read it: a well-formed record of the roster. */
export interface RuleRecord {
  /**
   * Its list, in ascending order of platform. A platform outside the table
   * or twice, or a list in another order, is not a record: applyRecord
   * throws before any check.
   */
  accounts: readonly Account[];
  /** Its date: the date in its challenge. */
  date: Day;
  /** Whether it verifies (spec/record.md, "Verifying a record"): check 1. */
  verifies: boolean;
}

export interface RecordInput {
  /** The platform IDs of the roster's table (spec/scope.md), in any order. */
  platforms: readonly string[];
  record: RuleRecord;
  /**
   * The state of the record's card before it; newCard for a card without a
   * record. A platform of the table without a slot here has the empty slot:
   * a state stored before the platform was added reads the same.
   */
  card: CardState;
  /** The latest date among the earlier valid records of the roster, of any card; null without one. */
  latestValidDate: Day | null;
  /** Whether the record's challenge appears in an earlier record, valid or invalid, of any card. */
  challengeUsed: boolean;
  /**
   * The CRL dates of the usable CRLs of the record's issuer whose tree has
   * the record's `smt_root` (spec/revocation-tree.md): several, or none.
   */
  crlDates: readonly Day[];
}

export interface ListOutcome<R extends Reason = Reason> {
  result: RecordResult<R>;
  /**
   * The state of the card after the record. After an invalid record it is
   * the state given, as it was; after a valid one a new state, with a slot
   * for every platform of the table.
   */
  card: CardState;
}

export interface RecordOutcome extends ListOutcome {
  /** The latest date among the valid records of the roster after the record: an invalid record does not move it. */
  latestValidDate: Day | null;
}

/** The state of a card without a valid record: nothing, and an empty slot for every platform. */
export function newCard(platforms: readonly string[]): CardState {
  return { lastCardProof: null, proofsOnLastDate: 0, slots: new Map(platforms.map((p) => [p, { ...EMPTY_SLOT }])) };
}

/**
 * The event rules for one slot (spec/roster-rules.md, "Event rules"):
 * `entry` is the account the list has for the slot's platform, or null. The
 * first row that applies gives the kind and the slot after it; null is no
 * kind, "blocked" is blocked.
 */
function applyEntry(slot: SlotState, entry: string | null, day: Day): { kind: Kind; slot: SlotState } | "blocked" | null {
  if (entry === null) return slot.current === null ? null : { kind: "withdraw", slot: { ...slot, current: null } };
  if (slot.lastDeclared === null) return { kind: "first", slot: { current: entry, lastDeclared: entry, switchCount: slot.switchCount, correctionDate: day } };
  if (slot.lastDeclared === entry) return { kind: "refresh", slot: { ...slot, current: entry } };
  if (slot.correctionDate === day) return { kind: "correction", slot: { ...slot, current: entry, lastDeclared: entry } };
  if (slot.switchCount < MAX_SWITCHES) return { kind: "switch", slot: { current: entry, lastDeclared: entry, switchCount: slot.switchCount + 1, correctionDate: day } };
  return "blocked";
}

/**
 * What the rules are never asked about (spec/roster-rules.md, "What an
 * invalid record changes"): a list that names a platform outside the table
 * or one platform twice, or is not in ascending order of platform, and a
 * state with a slot outside the table. Such a list is a malformed line, not
 * an invalid record: this throws, and no check runs. Go's roster/ stops the
 * same way, before check 1.
 *
 * Returns the table in ascending order and the list by platform.
 */
function readList(platforms: readonly string[], card: CardState, accounts: readonly Account[]): { table: string[]; list: Map<string, string> } {
  const table = [...platforms].sort(byBytes);
  const list = new Map<string, string>();
  let last: string | null = null;
  for (const a of accounts) {
    if (!table.includes(a.platform)) throw new Error(`roster rules: the list names ${JSON.stringify(a.platform)}, a platform outside the table`);
    if (list.has(a.platform)) throw new Error(`roster rules: the list names ${JSON.stringify(a.platform)} twice`);
    if (last !== null && !(last < a.platform)) throw new Error("roster rules: the list is not in ascending order of platform");
    list.set(a.platform, a.username);
    last = a.platform;
  }
  for (const p of card.slots.keys()) {
    if (!table.includes(p)) throw new Error(`roster rules: the card's state has a slot on ${JSON.stringify(p)}, a platform outside the table`);
  }
  return { table, list };
}

/** Checks 5 and 6 and the effects of a valid record, for a list readList accepted. */
function checkList(table: readonly string[], card: CardState, list: ReadonlyMap<string, string>, date: Day): ListOutcome<ListReason> {
  // 5. The event rules, on a copy. One blocked platform blocks the record.
  const slots = new Map<string, SlotState>();
  const kinds: PlatformKind[] = [];
  for (const platform of table) {
    const before = card.slots.get(platform) ?? EMPTY_SLOT;
    const o = applyEntry(before, list.get(platform) ?? null, date);
    if (o === "blocked") return { result: { valid: false, reason: "switch_limit", blockedPlatform: platform }, card };
    slots.set(platform, o === null ? { ...before } : o.slot);
    if (o !== null) kinds.push({ platform, kind: o.kind });
  }
  if (kinds.length === 0) return { result: { valid: false, reason: "empty" }, card };
  // 6. Fewer than 3 earlier valid records of its card have its date.
  const onDate = card.lastCardProof === date ? card.proofsOnLastDate : 0;
  if (onDate >= MAX_PER_DATE) return { result: { valid: false, reason: "daily_limit" }, card };
  return { result: { valid: true, kinds }, card: { lastCardProof: date, proofsOnLastDate: onDate + 1, slots } };
}

/**
 * Checks 5 and 6 and the effects of a valid record: the event rules on every
 * platform of the table, whether the list has an entry for it or not, then
 * the card's 3 records a date. It is the second half of applyRecord, for a
 * record that passed checks 1 to 4; `date` is then no earlier than the
 * card's `lastCardProof`. Like applyRecord, it throws for a list that is not
 * a record's.
 *
 * The device calls it by itself for what a list would do today: of checks 1
 * to 4 it could compute only the card's own half of check 4, and it leaves
 * that one to the server too (web/README.md).
 */
export function applyList(platforms: readonly string[], card: CardState, accounts: readonly Account[], date: Day): ListOutcome<ListReason> {
  const { table, list } = readList(platforms, card, accounts);
  return checkList(table, card, list, date);
}

/**
 * The roster rules for one record (spec/roster-rules.md, "Per record"): the
 * six checks in order, the first that fails giving the reason code. It reads
 * nothing but its input, changes none of it and keeps nothing; the same
 * input gives the same outcome.
 *
 * What the caller keeps between records: the card's state (`card` of the
 * outcome), the roster's latest valid date (`latestValidDate` of the
 * outcome) and, whatever the result, that the record's challenge is used.
 * When it throws, the input was not a record, and the caller keeps nothing.
 */
export function applyRecord(input: RecordInput): RecordOutcome {
  const { platforms, record, card, latestValidDate, challengeUsed, crlDates } = input;
  const { date } = record;
  const { table, list } = readList(platforms, card, record.accounts);
  const invalid = (reason: Exclude<Reason, ListReason>): RecordOutcome => ({ result: { valid: false, reason }, card, latestValidDate });
  // 1. The record verifies.
  if (!record.verifies) return invalid("proof");
  // 2. Its challenge appears in no earlier record.
  if (challengeUsed) return invalid("challenge_reused");
  // 3. Its root is recognized for its issuer and date.
  if (!crlDates.some((crl) => crl - ROOT_DAYS_BEFORE <= date && date <= crl + MAX_DAYS_AHEAD)) return invalid("root");
  // 4. Its date is no earlier than 4 days before the latest valid date, and
  // no earlier than its card's last card proof.
  if (latestValidDate !== null && date < latestValidDate - DATE_ORDER_DAYS) return invalid("date_order");
  if (card.lastCardProof !== null && date < card.lastCardProof) return invalid("date_order");
  // 5 and 6.
  const o = checkList(table, card, list, date);
  return { ...o, latestValidDate: o.result.valid && (latestValidDate === null || date > latestValidDate) ? date : latestValidDate };
}

/**
 * True if the card has 3 valid records dated `day`, so that no card proof of
 * any kind is valid on `day` (check 6, `daily_limit`): what applyList finds
 * for any list the event rules accept, without needing a list. A card's
 * dates do not go back (check 4), so the count of `day` is
 * `proofs_on_last_date` when `day` is `last_card_proof` and 0 when it is
 * later; a `day` before it is `date_order`, and this is false.
 */
export function dailyLimitReached(state: CardItems, day: Day): boolean {
  return state.lastCardProof === day && state.proofsOnLastDate >= MAX_PER_DATE;
}

/**
 * False if no roster can give a slot this state by the rules (the device
 * then does not read the server's answer). Only what follows directly from
 * the event rules:
 *
 *   - `current` is set only together with `last_declared` (first, refresh,
 *     correction, switch), and a withdrawal clears `current` only. So
 *     `current`, when set, is `last_declared`.
 *   - `last_declared` is first set by a `first`, which sets
 *     `correction_date`; nothing clears either. So one is set exactly when
 *     the other is.
 *   - `switch_count` is 0 to 5, and grows only by a switch, which needs a
 *     `last_declared` already.
 *   - `correction_date` is the date of a valid record of the card, so it is
 *     no later than `last_card_proof`; every slot's items come from valid
 *     records, so none is set without `last_card_proof`.
 */
export function possibleSlot(slot: SlotState, lastCardProof: Day | null): boolean {
  const { current, lastDeclared, switchCount, correctionDate } = slot;
  if (!Number.isSafeInteger(switchCount) || switchCount < 0 || switchCount > MAX_SWITCHES) return false;
  if (current !== null && current !== lastDeclared) return false;
  if ((lastDeclared === null) !== (correctionDate === null)) return false;
  if (lastDeclared === null && switchCount > 0) return false;
  if (lastDeclared !== null && lastCardProof === null) return false;
  if (correctionDate !== null && lastCardProof !== null && correctionDate > lastCardProof) return false;
  return true;
}

/**
 * False if no roster can give a card these items: `proofs_on_last_date`
 * counts the valid records dated `last_card_proof`, at most 3 of a date
 * (check 6), so it is 0 without `last_card_proof` and 1 to 3 with it; and no
 * date is more than MAX_DAYS_AHEAD days after today.
 */
export function possibleCard(card: CardItems, today: Day): boolean {
  const { lastCardProof, proofsOnLastDate } = card;
  if (!Number.isSafeInteger(proofsOnLastDate)) return false;
  if (lastCardProof === null) return proofsOnLastDate === 0;
  if (proofsOnLastDate < 1 || proofsOnLastDate > MAX_PER_DATE) return false;
  return lastCardProof <= today + MAX_DAYS_AHEAD;
}
