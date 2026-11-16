// Which sentence of the copy the screen shows for each reason the flow
// stopped (web/README.md, the table of stops) and under which item of the
// lists; what each item of the two lists shows; the card's state and what
// can be done (step 4 of design/copy/card-proof.md); the consequence
// (step 5); done (step 6). Pure functions, tested in Node
// (test/ui.test.ts). Where the copy has no sentence, the screen shows the
// code alone: `{ code }`.
import type { CardStatus, Consequence, Done, Progress, Stop } from "../flow.ts";
import { type OpenPlatform, SITE_DOMAIN, handle } from "../platforms.ts";
import { COPY, type Values } from "./copy.ts";

export interface Sentence {
  template: string;
  values: Values;
}

export type HelpTopic = keyof typeof COPY.links;

export type Message =
  | (Sentence & {
      /** A link to the help page after the sentence. */
      link?: HelpTopic;
      /** The server's X-Request-Id, shown on the next line. */
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

/** The format hint of the platform (design/copy/card-proof.json, `formats`). */
export function formatHint(p: OpenPlatform): Sentence {
  const hint = (COPY.formats as Record<string, string>)[p.formatHint];
  if (hint === undefined) throw new Error(`no format hint ${p.formatHint}`);
  return say(hint);
}

/**
 * The message for a stop. `p`: the platform of the card proof, for the
 * sentences that name it. `submitFailed`: the flow's phase is
 * "submit_failed" (the submission did not get through and can be sent
 * again as it is).
 */
export function stopMessage(stop: Stop, p: OpenPlatform, submitFailed = false): Message {
  switch (stop.code) {
    case "card":
      switch (stop.card) {
        case "component_unreachable":
          return { ...say(s.component_unreachable), link: "prepare" };
        case "no_reader":
          return say(s.no_reader);
        case "no_card":
          return say(s.no_card);
        case "pin_incorrect":
          return say(COPY.pin.pin_incorrect);
        case "popup_blocked":
          return say(COPY.common.popup_blocked);
        case "card_locked":
          return say(s.card_locked);
        case "card_error":
          // A PIN the bridge does not send (hipki.ts) has a sentence of its own.
          if (stop.detail === "pin_characters") return say(COPY.pin.pin_characters);
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
        case "unsupported_format":
          return say(s.unsupported_format);
        case "ambiguous_certificate":
          return say(s.two_certificates);
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
      return formatHint(p);
    case "server": {
      const id = stop.requestId ? { requestId: stop.requestId } : {};
      if (submitFailed) return { ...say(s.submit_failed), retry: true, ...id };
      if (stop.server === "challenge_unknown") return { ...say(s.challenge_expired), ...id };
      // The server's newest CRL is more than 3 days old (docs/api/card-proof.md).
      if (stop.server === "crl_stale") return { ...say(s.server_crl_stale), ...id };
      // The card already has 3 valid records today (check 6): the card's state said fewer when it was asked.
      if (stop.server === "daily_limit") return { ...say(s.daily_limit, { platform: p.name }), ...id };
      if (REJECTED.has(stop.server)) return { ...say(s.rejected, { code: stop.server }), ...id };
      return { ...say(s.server_unreadable, { code: stop.server }), ...id };
    }
    // The screen does not offer a choice that is not possible; the engine refuses it too. No sentence.
    case "blocked":
      return { code: stop.reason };
    // The wait for the second signature ran out: the screen is back at step 1.
    case "idle":
      return say(COPY.before.idle);
    // No sentence in the copy: a step called out of order.
    case "state":
      break;
  }
  return { code: stop.code };
}

// The two lists ----------------------------------------------------------------------

/** What an item of a list shows after it: nothing yet, in progress, done, stopped here (common.working, done, halted). */
export type ItemState = "" | "now" | "done" | "halt";

export interface ListItem {
  /** The key of its label in the copy's group (read or progress). */
  key: string;
  /** The engine's Progress events that, all seen, complete the item. */
  doneWhen: Progress[];
}

/**
 * Step 2, reading the card (design/copy/card-proof.md, step 2). The
 * engine does several of these at once after the card is read (config,
 * circuit and engine for the server; crl and tree for the CRL); the list
 * shows them in this order.
 */
export const READ_ITEMS: readonly ListItem[] = [
  { key: "component", doneWhen: ["component"] },
  { key: "reader", doneWhen: ["certificates"] },
  { key: "certificate", doneWhen: ["certificates"] },
  { key: "check", doneWhen: ["certificate"] },
  { key: "server", doneWhen: ["config", "circuit", "engine"] },
  { key: "crl", doneWhen: ["crl", "tree"] },
];

/** Step 5, in progress. The last item is done when the card proof is. */
export const PROGRESS_ITEMS: readonly ListItem[] = [
  { key: "server", doneWhen: ["challenge"] },
  { key: "sign", doneWhen: ["signed"] },
  { key: "compute", doneWhen: ["proved"] },
  { key: "submit", doneWhen: [] },
];

/**
 * Under which item of step 2's list a stop is written (the table of
 * where it stops, card-proof.md step 2); null if the table has no row for it (the
 * screen then writes it under the first item not done).
 */
export function readItemOf(stop: Stop): number | null {
  switch (stop.code) {
    case "card":
      if (stop.card === "component_unreachable") return 0;
      if (stop.card === "no_reader" || stop.card === "no_card") return 1;
      if (stop.card === "card_locked" || stop.card === "card_error") return 2;
      return null;
    case "certificate":
      return stop.problem === "no_certificate" ? 2 : 3;
    // The circuit and the CRS are the page's files from the server; the proof engine
    // starts with the CRS (the table has no row for an engine that cannot start).
    case "artifact":
    case "engine":
    case "server":
      return 4;
    case "revocation":
    case "revoked":
      return 5;
    default:
      return null;
  }
}

/**
 * What each item shows. An item shows done only once every item above it
 * has (the engine does some at once; the list reads top to bottom). While
 * the step runs, the first item not done shows in progress; when it stopped,
 * the item `stoppedAt` shows stopped here and the items after it nothing.
 */
export function itemStates(items: readonly ListItem[], seen: ReadonlySet<Progress>, o: { running: boolean; stoppedAt: number | null; allDone?: boolean }): ItemState[] {
  const out: ItemState[] = [];
  let prefixDone = true;
  for (const [i, item] of items.entries()) {
    const done = o.allDone === true || (item.doneWhen.length > 0 && item.doneWhen.every((p) => seen.has(p)));
    prefixDone = prefixDone && done;
    if (o.stoppedAt !== null) {
      out.push(i < o.stoppedAt ? (prefixDone ? "done" : "") : i === o.stoppedAt ? "halt" : "");
    } else if (prefixDone) {
      out.push("done");
    } else {
      out.push(o.running && (i === 0 || out[i - 1] === "done") ? "now" : "");
    }
  }
  return out;
}

/**
 * The buttons under step 5's list when it stopped (design/copy/card-proof.md,
 * in progress). `phase`: the flow's phase after the stop.
 *
 *   back        progress.back: the PIN is still in the engine ("chosen": the
 *               browser blocked the window of the second signature), so the
 *               confirm screen's button works again
 *   read_again  read.read_again: the engine dropped the PIN (every other
 *               stop: the flow ended, or the second signature was made); the
 *               card proof starts again from reading the card
 *   retry       progress.retry, besides: the submission did not get through
 *               ("submit_failed") and can be sent again as it is
 */
export function progressButtons(phase: string): ("back" | "read_again" | "retry")[] {
  if (phase === "chosen") return ["back"];
  if (phase === "submit_failed") return ["read_again", "retry"];
  return ["read_again"];
}

/** The first item not done (where a step that runs in order stopped). */
export function firstNotDone(states: readonly ItemState[]): number {
  const i = states.findIndex((st) => st !== "done");
  return i < 0 ? states.length - 1 : i;
}

// Step 4: the card's state -----------------------------------------------------------

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

export interface StatusView {
  /** never: no declaration yet; declared: an account now; withdrawn: declared before, withdrawn since. */
  state: "never" | "declared" | "withdrawn";
  /** The lines of the card's state; each line one or more sentences. */
  lines: Message[][];
  /**
   * 3 records of the card today: the lines are shown, and in place of the
   * choices this sentence and the button back to the beginning only.
   */
  dailyLimit: Sentence | null;
  /** False when switches are used up: choose.switch or choose.declare_other cannot be pressed. */
  canSwitch: boolean;
  /** The sentence under that button when it cannot be pressed. */
  switchLimit: Sentence | null;
}

export function statusView(st: CardStatus, p: OpenPlatform): StatusView {
  const c = COPY.choose;
  const dailyLimit = st.dailyLimit ? say(s.daily_limit, { platform: p.name }) : null;
  const canSwitch = st.options.other.kind !== "blocked";
  const switchLimit = canSwitch ? null : say(c.switch_limit, { next_switch_date: st.nextSwitchDate });
  if (st.current !== null) {
    const last: Message =
      st.lastCardProof === null
        ? { code: "no_last_card_proof" }
        : st.lastCardProof === st.today
          ? say(c.last_card_proof_today)
          : say(c.last_card_proof, { days_ago: daysBetween(st.lastCardProof, st.today) });
    const switches = canSwitch ? say(c.switches, { switches_used: st.switchesUsed, switches_left: st.switchesLeft }) : say(c.switches_used_up, { switches_used: st.switchesUsed });
    return { state: "declared", lines: [[say(c.current, { account: handle(p, st.current) })], [last, switches]], dailyLimit, canSwitch, switchLimit };
  }
  if (st.lastDeclared !== null) {
    return { state: "withdrawn", lines: [[say(c.nothing_now)], [say(c.withdrawn, { last_declared: handle(p, st.lastDeclared) })]], dailyLimit, canSwitch, switchLimit };
  }
  return { state: "never", lines: [[say(c.not_declared, { platform: p.name })]], dailyLimit, canSwitch: true, switchLimit: null };
}

// Step 5: the consequence --------------------------------------------------------------

export interface ConsequenceView {
  /** The sentence before the account: what the roster will record. */
  record: Sentence;
  account: string;
  date: string;
  /** For a switch only: how many are left after it, or when the next one is. */
  switchLine: Sentence | null;
  /** The second point: what can be done later, and that no record can be deleted. */
  later: string[];
  button: Sentence;
}

/**
 * The table of step 5 names its rows by what was picked. The button follows
 * what the card proof will be: a declaration of the current account is
 * button_refresh; of the account withdrawn before, button_first (the row of
 * declaring the same account again).
 */
export function consequenceView(cq: Consequence, current: string | null, p: OpenPlatform): ConsequenceView {
  const c = COPY.confirm;
  const account = handle(p, cq.username);
  if (cq.kind === "withdraw") {
    return { record: say(c.record_withdraw, { platform: p.name }), account, date: cq.today, switchLine: null, later: [c.later_withdraw, c.permanent], button: say(c.button_withdraw, { account }) };
  }
  const button = cq.kind === "switch" ? say(c.button_switch, { account }) : cq.kind === "refresh" && current === cq.username ? say(c.button_refresh) : say(c.button_first, { account });
  const switchLine =
    cq.kind !== "switch" ? null : cq.switchesLeftAfter > 0 ? say(c.uses_switch, { switches_left: cq.switchesLeftAfter }) : say(c.uses_last_switch, { next_switch_date: cq.nextSwitchDateAfter });
  return { record: say(c.record_declare, { platform: p.name }), account, date: cq.today, switchLine, later: [c.later, c.permanent], button };
}

// Step 6: done ----------------------------------------------------------------------

/**
 * The title of step 6, by the kind of the record. `current`: the account the
 * card declared before this card proof (CardStatus.current). Declaring again
 * the account withdrawn before is a `refresh` by the roster rules, but to the
 * cardholder a new declaration: done.first.
 */
export function doneTitle(kind: Done["kind"], username: string, current: string | null, p: OpenPlatform): Sentence {
  if (kind === "refresh" && current !== username) return say(COPY.done.first);
  if (kind === "switch") return say(COPY.done.switch, { account: handle(p, username) });
  return say(COPY.done[kind]);
}

export interface DoneView {
  title: Sentence;
  withdraw: boolean;
  account: string;
  date: string;
  shortId: string;
  /** The link to put on the profile, as the screen writes it (no scheme). */
  link: string;
  /** The link as it is copied: a whole https:// URL. */
  url: string;
  /** Other cards declare the account too: why the link carries the short ID. */
  otherCards: Sentence | null;
  /** The roster's line, then the short ID's. */
  record: Sentence;
  shortIdLine: Sentence;
}

/**
 * Step 6. The link is the account's page when the server said this card is
 * the only one declaring the account (`account_cards` 1), and this card's
 * page otherwise: other cards declare it, or the number is not known (the
 * record was found in the card's state, Done.accountCards null).
 */
export function doneView(d: Done, current: string | null, p: OpenPlatform): DoneView {
  const account = handle(p, d.username);
  const path = p.accountPath(d.username) + (d.accountCards === 1 ? "" : `/${d.shortId}`);
  const link = `${SITE_DOMAIN}/${path}`;
  const withdraw = d.kind === "withdraw";
  return {
    title: doneTitle(d.kind, d.username, current, p),
    withdraw,
    account,
    date: d.date,
    shortId: d.shortId,
    link,
    url: `https://${link}`,
    otherCards: d.accountCards !== null && d.accountCards > 1 ? say(COPY.done.other_cards, { account }) : null,
    record: say(withdraw ? COPY.done.record_withdraw : COPY.done.record_declare, { platform: p.name, account }),
    shortIdLine: say(COPY.done.short_id, { platform: p.name, short_id: d.shortId }),
  };
}
