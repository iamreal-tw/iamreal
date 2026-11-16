// Which sentence of the copy the screen shows for each reason the flow
// stopped (web/README.md, the table of stops), for each state of the card
// (section 3 of design/copy/card-proof.md) and for each consequence
// (section 4). Pure functions, tested in Node (test/ui.test.ts). Where the
// copy has no sentence, the screen shows the code alone: `{ code }`.
import type { CardStatus, Consequence, Stop } from "../flow.ts";
import { COPY, type Values } from "./copy.ts";

export interface Sentence {
  template: string;
  values: Values;
}

export type Message =
  | (Sentence & {
      /** A link to the help page after the sentence. */
      link?: "prepare";
      /** The server's X-Request-Id, shown next to the sentence. */
      requestId?: string;
      /** The screen offers the retry button (the same record, sent again). */
      retry?: boolean;
    })
  /** No sentence in the copy: the screen shows the code. */
  | { code: string; requestId?: string };

const s = COPY.stops;
const say = (template: string, values: Values = {}): Sentence => ({ template, values });

/** Codes of a submission the server did not accept (web/README.md, the server's rejections). */
const REJECTED = new Set(["scope", "malformed", "challenge_used", "challenge_attempts", "proof", "crl_stale", "root", "date_order", "not_current", "switch_limit"]);

/**
 * The message for a stop. `submitFailed`: the flow's phase is
 * "submit_failed" (the submission did not get through and can be sent
 * again as it is).
 */
export function stopMessage(stop: Stop, submitFailed = false): Message {
  switch (stop.code) {
    case "card":
      switch (stop.card) {
        case "component_unreachable":
          return { ...say(s.component_unreachable), link: "prepare" };
        case "no_card":
          return say(s.no_card);
        case "pin_incorrect":
          return say(COPY.confirm_card.pin_incorrect);
        case "popup_blocked":
          return say(COPY.confirm_card.popup_blocked);
        case "card_locked":
          return say(s.card_locked);
        case "card_error":
          return say(s.card_error, { code: stop.detail || "card_error" });
      }
      break;
    case "certificate":
      switch (stop.problem) {
        case "expired":
          return stop.notAfter ? say(s.expired, { expiry_date: stop.notAfter }) : { code: "expired" };
        case "not_yet_valid":
          return stop.notBefore ? say(s.not_yet_valid, { valid_from: stop.notBefore }) : { code: "not_yet_valid" };
        case "not_citizen_primary":
          return say(s.not_citizen_primary);
        // Two certificates that both pass: the copy says to use the sentence of an unsupported format.
        case "unsupported_format":
        case "ambiguous_certificate":
          return say(s.unsupported_format);
        case "unknown_issuer":
          return say(s.unknown_issuer);
        case "no_certificate":
          return say(s.no_certificate);
      }
      break;
    case "revocation":
      switch (stop.problem.code) {
        case "crl_stale":
          return say(s.crl_stale, { crl_days: stop.problem.days });
        case "crl_rollback":
          return say(s.crl_rollback);
        case "crl_unavailable":
        case "crl_hash":
        case "crl_unusable":
          return say(s.crl_unavailable, { code: stop.problem.code });
      }
      break;
    case "revoked":
      return say(s.revoked);
    case "card_signature":
      return say(s.card_error, { code: "card_signature" });
    case "challenge_malformed":
      return say(s.server_unreadable, { code: "challenge_malformed" });
    case "challenge_not_today":
      return say(s.date_mismatch);
    case "artifact":
      return say(s.artifact);
    case "engine":
      return say(s.engine);
    case "proof_check":
      return say(s.proof_check);
    case "username":
      return say(COPY.status.bad_username);
    case "server": {
      const id = stop.requestId ? { requestId: stop.requestId } : {};
      if (submitFailed) return { ...say(s.submit_failed), retry: true, ...id };
      if (stop.server === "challenge_unknown") return { ...say(s.challenge_expired), ...id };
      if (REJECTED.has(stop.server)) return { ...say(s.rejected, { code: stop.server }), ...id };
      return { ...say(s.server_unreadable, { code: stop.server }), ...id };
    }
    // The screen does not offer a choice that is not possible; the engine refuses it too. No sentence.
    case "blocked":
      return { code: stop.reason };
    // No sentence in the copy: the wait for the second signature ran out; a step called out of order.
    case "idle":
    case "state":
      break;
  }
  return { code: stop.code };
}

export const PLATFORM_NAMES = { threads: "Threads" } as const;
export type PlatformKey = keyof typeof PLATFORM_NAMES;

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/** Section 3: the card's state, and which choices the screen offers. */
export interface StatusView {
  /** never: no declaration yet; declared: an account now; withdrawn: declared before, withdrawn since. */
  state: "never" | "declared" | "withdrawn";
  /** The first sentence. */
  first: Sentence;
  /** For a declared card: the last card proof, and the switches of the past year. */
  facts: Message[];
  /** False when switches are used up: status.switch or status.declare_other cannot be pressed. */
  canSwitch: boolean;
  /** The sentence next to that button when it cannot be pressed. */
  switchLimit: Sentence | null;
}

export function statusView(st: CardStatus, platform: PlatformKey): StatusView {
  const c = COPY.status;
  const canSwitch = st.options.other.kind !== "blocked";
  const switchLimit = canSwitch ? null : say(c.switch_limit, { next_switch_date: st.nextSwitchDate });
  if (st.current !== null) {
    return {
      state: "declared",
      first: say(c.current, { account: st.current }),
      facts: [
        st.lastCardProof !== null ? say(c.last_card_proof, { days_ago: daysBetween(st.lastCardProof, st.today) }) : { code: "no_last_card_proof" },
        say(c.switches, { switches_used: st.switchesUsed, switches_left: st.switchesLeft }),
      ],
      canSwitch,
      switchLimit,
    };
  }
  if (st.lastDeclared !== null) {
    return { state: "withdrawn", first: say(c.withdrawn, { last_declared: st.lastDeclared }), facts: [], canSwitch, switchLimit };
  }
  return { state: "never", first: say(c.not_declared, { platform: PLATFORM_NAMES[platform] }), facts: [], canSwitch: true, switchLimit: null };
}

/** Section 4: what the roster will record, and the button of the last click. */
export interface ConsequenceView {
  record: Sentence;
  /** consequence.uses_switch, for a switch only. */
  switchLine: Sentence | null;
  /** The paragraph before the buttons: what can be done later, and that no record can be deleted. */
  later: string[];
  button: Sentence;
}

/**
 * The table of section 4 names its rows by what was picked. The button
 * follows what the card proof will be: a declaration of the current account
 * is button_refresh; of the account withdrawn before, button_first (the row
 * of declaring the same account again).
 */
export function consequenceView(cq: Consequence, current: string | null, platform: PlatformKey): ConsequenceView {
  const c = COPY.consequence;
  const values = { today: cq.today, platform: PLATFORM_NAMES[platform], account: cq.username };
  if (cq.kind === "withdraw") {
    return { record: say(c.record_withdraw, values), switchLine: null, later: [c.later_withdraw, c.permanent], button: say(c.button_withdraw, { account: cq.username }) };
  }
  const button =
    cq.kind === "switch"
      ? say(c.button_switch, { account: cq.username })
      : cq.kind === "refresh" && current === cq.username
        ? say(c.button_refresh)
        : say(c.button_first, { account: cq.username });
  return {
    record: say(c.record_declare, values),
    switchLine: cq.kind === "switch" ? say(c.uses_switch, { switches_left: cq.switchesLeftAfter }) : null,
    later: [c.later, c.permanent],
    button,
  };
}

/** The first line of section 6 (done), by the kind of the record. */
export function doneTitle(kind: "first" | "refresh" | "switch" | "withdraw", account: string): Sentence {
  return say(COPY.done[kind], { account });
}

/** The record line of section 6, after done.seq. */
export function doneRecord(kind: "first" | "refresh" | "switch" | "withdraw", date: string, account: string, platform: PlatformKey): Sentence {
  return say(kind === "withdraw" ? COPY.done.record_withdraw : COPY.done.record_declare, { today: date, platform: PLATFORM_NAMES[platform], account });
}
