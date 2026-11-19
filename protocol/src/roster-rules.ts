// What a card proof would do, computed on the device from the facts the
// server reports about one card (docs/api/card-proof.md, card-state) and
// today's date, by the event rules of spec/roster-rules.md. The server sends
// facts, not a conclusion; the device cannot check the facts without the
// whole roster.
import type { Day } from "./date.ts";

/** The state of one slot: one card on one platform (spec/roster-rules.md, "State"). */
export interface SlotState {
  current: string | null;
  lastDeclared: string | null;
  /** Valid switches of the slot, 0 to 5; it never decreases. */
  switchCount: number;
  /** The date of the slot's last valid `first` or `switch`. */
  correctionDate: Day | null;
}

/** The state of one card: its own items, and its slots by platform ID. */
export interface CardState {
  lastCardProof: Day | null;
  /** The number of valid records of the card dated `lastCardProof`; 0 without one. */
  proofsOnLastDate: number;
  slots: Map<string, SlotState>;
}

export const EMPTY_SLOT: Readonly<SlotState> = Object.freeze({ current: null, lastDeclared: null, switchCount: 0, correctionDate: null });

/** At most 3 valid records of a card have the same date (check 6, `daily_limit`). */
export const MAX_PER_DATE = 3;
/** A card has 5 switches on each platform, for good (spec/roster-rules.md, "Switches and corrections"). */
export const MAX_SWITCHES = 5;
/**
 * How many days after today a date in the roster can be: a record's date is
 * at most 3 days after the date of the CRL behind its root
 * (spec/roster-rules.md, "How far dates are trusted").
 */
export const MAX_DAYS_AHEAD = 3;

/** A platform's kind in a valid record. */
export type Kind = "first" | "refresh" | "correction" | "switch" | "withdraw";

/** What the event rules give one slot for one entry: a kind, no kind, or blocked. */
export type SlotOutcome = { kind: Kind } | { kind: "none" } | { kind: "blocked" };

/**
 * The event rules for one slot (spec/roster-rules.md, "Event rules"):
 * `entry` is the account the list has for the slot's platform, or null.
 * The first row that applies gives the kind.
 */
export function slotOutcome(slot: SlotState, entry: string | null, day: Day): SlotOutcome {
  if (entry !== null) {
    if (slot.lastDeclared === null) return { kind: "first" };
    if (slot.lastDeclared === entry) return { kind: "refresh" };
    if (slot.correctionDate === day) return { kind: "correction" };
    if (slot.switchCount < MAX_SWITCHES) return { kind: "switch" };
    return { kind: "blocked" };
  }
  return slot.current !== null ? { kind: "withdraw" } : { kind: "none" };
}

/** The slot after a valid record gave it `kind` on `day` (the table's last column). */
export function applyKind(slot: SlotState, kind: Kind, entry: string | null, day: Day): SlotState {
  switch (kind) {
    case "first":
      return { current: entry, lastDeclared: entry, switchCount: slot.switchCount, correctionDate: day };
    case "refresh":
      return { ...slot, current: entry };
    case "correction":
      return { ...slot, current: entry, lastDeclared: entry };
    case "switch":
      return { current: entry, lastDeclared: entry, switchCount: slot.switchCount + 1, correctionDate: day };
    case "withdraw":
      return { ...slot, current: null };
  }
}

export type ListOutcome =
  | { valid: true; kinds: { platform: string; kind: Kind }[] }
  /** `platform`: for switch_limit, the first platform blocked (not part of the rules' result). */
  | { valid: false; reason: "switch_limit" | "empty"; platform?: string };

/**
 * The event rules for a whole list (spec/roster-rules.md): every platform of
 * `slots` is looked at, whether the list has an entry for it or not. A
 * platform blocked makes the record `switch_limit`; no platform with a kind
 * makes it `empty`; otherwise its kinds, in ascending order of platform.
 * Check 6 (`daily_limit`) is not part of it (dailyLimitReached).
 */
export function listOutcome(slots: ReadonlyMap<string, SlotState>, list: ReadonlyMap<string, string>, day: Day): ListOutcome {
  const platforms = [...new Set([...slots.keys(), ...list.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const kinds: { platform: string; kind: Kind }[] = [];
  for (const platform of platforms) {
    const o = slotOutcome(slots.get(platform) ?? EMPTY_SLOT, list.get(platform) ?? null, day);
    if (o.kind === "blocked") return { valid: false, reason: "switch_limit", platform };
    if (o.kind !== "none") kinds.push({ platform, kind: o.kind });
  }
  return kinds.length === 0 ? { valid: false, reason: "empty" } : { valid: true, kinds };
}

/**
 * True if the card has 3 valid records dated `day`, so that no card proof of
 * any kind is valid on `day` (check 6, `daily_limit`). The state tells the
 * count of one date only, `last_card_proof`'s; for any other date this is
 * false, and the server's rules decide (a record dated a day before
 * `last_card_proof`, around midnight, can still be the fourth of its date).
 */
export function dailyLimitReached(state: { lastCardProof: Day | null; proofsOnLastDate: number }, day: Day): boolean {
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
export function possibleCard(lastCardProof: Day | null, proofsOnLastDate: number, today: Day): boolean {
  if (!Number.isSafeInteger(proofsOnLastDate)) return false;
  if (lastCardProof === null) return proofsOnLastDate === 0;
  if (proofsOnLastDate < 1 || proofsOnLastDate > MAX_PER_DATE) return false;
  return lastCardProof <= today + MAX_DAYS_AHEAD;
}
