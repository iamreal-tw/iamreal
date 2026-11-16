// What a card proof would do, computed on the device from the facts the
// server reports about one card (docs/api/card-proof.md, card-state) and
// today's date, by the event rules of spec/roster-rules.md. The server sends
// facts, not a conclusion; the device cannot check the facts without the
// whole roster.
import type { Day } from "./date.ts";

/** The state of one card in one scope (spec/roster-rules.md). */
export interface CardState {
  current: string | null;
  lastDeclared: string | null;
  lastCardProof: Day | null;
  /** One entry per valid switch, in roster order. */
  switchDates: Day[];
}

/**
 * How many days after today a date in the roster can be: a record's date is
 * at most 3 days after the date of the CRL behind its root
 * (spec/roster-rules.md, "How far dates are trusted").
 */
export const MAX_DAYS_AHEAD = 3;

/**
 * False if no roster can give a card this state by the rules of
 * spec/roster-rules.md; the device then does not read the server's answer.
 * Only what follows directly from the rules:
 *
 *   - `current` is set only by a declaration of the same account, which
 *     sets `last_declared` to it too; a withdrawal clears `current` only.
 *     So `current`, when set, is `last_declared`.
 *   - Every valid record sets `last_card_proof`. So `current` or
 *     `last_declared` without `last_card_proof` cannot be.
 *   - A switch is a valid record. So switch dates on a card with nothing
 *     else cannot be.
 *   - No date is more than MAX_DAYS_AHEAD days after today.
 *   - `last_card_proof` is the latest date among the valid records, switches
 *     included. So no switch is dated after it.
 *
 * Anything else is read as the server sends it.
 */
export function possibleState(state: CardState, today: Day): boolean {
  const { current, lastDeclared, lastCardProof, switchDates } = state;
  if (current !== null && current !== lastDeclared) return false;
  if ((current !== null || lastDeclared !== null) && lastCardProof === null) return false;
  if (current === null && lastDeclared === null && lastCardProof === null && switchDates.length > 0) return false;
  if ([lastCardProof, ...switchDates].some((d) => d !== null && d > today + MAX_DAYS_AHEAD)) return false;
  if (lastCardProof !== null && switchDates.some((d) => d > lastCardProof)) return false;
  return true;
}

export const MAX_SWITCHES = 2;
/** The window counts switches dated from `d − 364` on. */
const WINDOW_DAYS = 364;

export type Outcome =
  | { kind: "first" | "refresh" | "switch" | "withdraw" }
  | { kind: "blocked"; reason: "switch_limit" | "not_current" };

/** The kind a `declare` of `username` on `day` would have, or why it is blocked. */
export function declareOutcome(state: CardState, username: string, day: Day): Outcome {
  if (state.lastDeclared === null) return { kind: "first" };
  if (state.lastDeclared === username) return { kind: "refresh" };
  return switchesInWindow(state, day) < MAX_SWITCHES ? { kind: "switch" } : { kind: "blocked", reason: "switch_limit" };
}

/** The kind a `withdraw` of `username` on `day` would have. */
export function withdrawOutcome(state: CardState, username: string): Outcome {
  return state.current !== null && state.current === username ? { kind: "withdraw" } : { kind: "blocked", reason: "not_current" };
}

/** Entries of `switchDates` on or after `day − 364`, including any after `day`. */
export function switchesInWindow(state: CardState, day: Day): number {
  return state.switchDates.filter((d) => d >= day - WINDOW_DAYS).length;
}

/** Switches a declaration on `day` could still make (0 to 2). */
export function switchesLeft(state: CardState, day: Day): number {
  return Math.max(0, MAX_SWITCHES - switchesInWindow(state, day));
}

/**
 * The first date, not before `day`, on which a switch is allowed: the
 * window then holds fewer than 2 entries. With switches s1 ≥ s2 ≥ …, that is
 * the first date d with d − 364 > s2, so d = s2 + 365.
 */
export function nextSwitchDay(state: CardState, day: Day): Day {
  const sorted = [...state.switchDates].sort((a, b) => b - a);
  if (sorted.length < MAX_SWITCHES) return day;
  return Math.max(day, sorted[MAX_SWITCHES - 1]! + WINDOW_DAYS + 1);
}
