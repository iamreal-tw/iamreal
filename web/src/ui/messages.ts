// Which sentence of the copy the screen shows for each reason the flow
// stopped (web/README.md, the table of stops), and for each state of the
// card (screen 3 of design/copy/card-proof.md). Pure functions, tested in Node
// (test/ui.test.ts). Where the copy has no sentence, the screen shows the
// code alone: `{ code }`.
import type { CardStatus, Stop } from "../flow.ts";
import type { Action } from "../spec/declaration-code.ts";
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
          return say(COPY.before_pin.pin_incorrect);
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
      return say(COPY.enter.bad_username);
    case "server": {
      const id = stop.requestId ? { requestId: stop.requestId } : {};
      if (submitFailed) return { ...say(s.submit_failed), retry: true, ...id };
      if (stop.server === "challenge_unknown") return { ...say(s.challenge_expired), ...id };
      if (REJECTED.has(stop.server)) return { ...say(s.rejected, { code: stop.server }), ...id };
      return { ...say(s.server_unreadable, { code: stop.server }), ...id };
    }
    case "blocked":
    case "state":
      break;
  }
  return { code: stop.code };
}

export const PLATFORM_NAMES = { threads: "Threads" } as const;

export interface StatusView {
  /** The first sentence: what the server says about this card. */
  first: Message;
  /** The button of the last click, or null (only the cancel button). */
  button: Sentence | null;
  /** The line the roster will record (after `status.record_intro`), or null if the account is not known. */
  record: Sentence | null;
}

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/**
 * Screen 3 (the card's state and the consequence) for a card's status. The copy writes the
 * first sentence for a card that holds an account now; for a card whose last
 * declaration was withdrawn (current is null, but it declared before), it has
 * none, and the screen shows a code.
 */
export function statusView(action: Action, st: CardStatus, platform: keyof typeof PLATFORM_NAMES): StatusView {
  const c = COPY.status;
  const p = PLATFORM_NAMES[platform];
  if (action === "withdraw") {
    if (st.outcome.kind === "withdraw" && st.username !== null) {
      return {
        first: say(c.withdraw_current, { account: st.username }),
        button: say(c.button_withdraw, { account: st.username }),
        record: say(c.record_withdraw, { today: st.today, platform: p, account: st.username }),
      };
    }
    return { first: say(c.withdraw_none), button: null, record: null };
  }
  const account = st.username!;
  const record = say(c.record_declare, { today: st.today, platform: p, account });
  switch (st.outcome.kind) {
    case "first":
      return { first: say(c.not_declared), button: say(c.button_first, { account }), record };
    case "refresh":
      return {
        first:
          st.current === account && st.lastCardProof !== null
            ? say(c.current_same, { account, days_ago: daysBetween(st.lastCardProof, st.today) })
            : { code: "refresh_after_withdraw" },
        button: say(c.button_refresh),
        record,
      };
    case "switch":
      return {
        first: st.current !== null ? say(c.current_other, { current: st.current, account, switches_left: st.switchesLeftAfter }) : { code: "switch_after_withdraw" },
        button: say(c.button_switch, { account }),
        record,
      };
    case "blocked":
      return {
        first: st.current !== null ? say(c.switch_limit, { current: st.current, next_switch_date: st.nextSwitchDate }) : { code: "switch_limit_after_withdraw" },
        button: null,
        record,
      };
    case "withdraw":
      break;
  }
  return { first: { code: st.outcome.kind }, button: null, record };
}

/** The first line of screen 5 (done), by the kind of the record. */
export function doneTitle(kind: "first" | "refresh" | "switch" | "withdraw", account: string): Sentence {
  return say(COPY.done[kind], { account });
}
