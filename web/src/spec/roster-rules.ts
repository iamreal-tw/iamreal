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
