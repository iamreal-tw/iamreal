// Which sentence of the copy the screen shows for each reason the flow
// stopped (web/README.md, the table of stops) and under which item of the
// lists; what each item of the two lists shows; the card's list and what
// each row says (step 4 of design/copy/card-proof.md); the list to be
// signed (step 5); done (step 6). Pure functions, tested in Node
// (test/ui.test.ts). Where the copy has no sentence, the screen shows the
// code alone: `{ code }`.
import type { AcceptedKind } from "../api.ts";
import type { CardStatus, Consequence, ConsequenceRow, Done, Progress, SlotStatus, Stop } from "../flow.ts";
import { KNOWN_PLATFORMS, SITE_DOMAIN, cardPath, handle, presentationOf } from "../platforms.ts";
import { COPY, type Values, fill } from "./copy.ts";

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

/**
 * Codes of a submission the server did not accept, which the copy has no
 * sentence of their own for (design/copy/card-proof.md, step 5, the row of the other codes,
 * the codes other than the rows below it; `platform`, a list naming a
 * platform the proof log does not accept, is one of them).
 */
const REJECTED = new Set(["scope", "platform", "malformed", "challenge_used", "challenge_attempts", "proof", "root", "date_order"]);

/** The format hint of a platform (design/copy/card-proof.json, `formats`); null if the copy has none. */
export function formatHint(platform: string): Sentence | null {
  const key = presentationOf(platform)?.formatHint ?? null;
  const hint = key === null ? undefined : (COPY.formats as Record<string, string>)[key];
  return hint === undefined ? null : say(hint);
}

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
      // The platform's hint; for a platform the copy has no hint for, the general sentence.
      return formatHint(stop.platform) ?? say(COPY.accounts.format_no_hint);
    case "server": {
      const id = stop.requestId ? { requestId: stop.requestId } : {};
      if (submitFailed) return { ...say(s.submit_failed), retry: true, ...id };
      if (stop.server === "challenge_unknown") return { ...say(s.challenge_expired), ...id };
      // The server's newest CRL is more than 3 days old (docs/api/card-proof.md).
      if (stop.server === "crl_stale") return { ...say(s.server_crl_stale), ...id };
      // The record rules, when the card's state changed since it was asked.
      if (stop.server === "daily_limit") return { ...say(s.daily_limit), ...id };
      if (stop.server === "switch_limit") return { ...say(s.switch_limit), ...id };
      if (stop.server === "empty") return { ...say(s.empty), ...id };
      // The server's operating policy refused a switch the rules allow (none by default).
      if (stop.server === "switch_restricted") return { ...say(s.switch_restricted), ...id };
      if (REJECTED.has(stop.server)) return { ...say(s.rejected, { code: stop.server }), ...id };
      return { ...say(s.server_unreadable, { code: stop.server }), ...id };
    }
    case "blocked":
      // The list is empty and the card declares nothing: accounts.need_one
      if (stop.reason === "empty") return say(COPY.accounts.need_one);
      // The screen offers no change on a day with 3 records; the engine refuses one too.
      if (stop.reason === "daily_limit") return say(s.daily_limit);
      // Another account typed on a row whose 5 switches are used up (switch_limit).
      return say(COPY.accounts.row_cannot_switch);
    // The date changed since step 5, and the list would now do something else: nothing was signed.
    case "date_changed":
      return say(s.date_changed);
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
    // starts with the CRS. The config (the CRL age bound, the platform table) is the server's.
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
export function progressButtons(phase: string, stop?: Stop): ("back" | "read_again" | "retry" | "restart")[] {
  // The date changed: nothing was signed, and the card proof starts again from the beginning (stops.date_changed).
  if (stop?.code === "date_changed") return ["restart"];
  if (phase === "chosen") return ["back"];
  if (phase === "submit_failed") return ["read_again", "retry"];
  return ["read_again"];
}

/** The first item not done (where a step that runs in order stopped). */
export function firstNotDone(states: readonly ItemState[]): number {
  const i = states.findIndex((st) => st !== "done");
  return i < 0 ? states.length - 1 : i;
}

// One platform -------------------------------------------------------------------------

/**
 * Whether the screens speak of one platform (design/copy/card-proof.md,
 * the section on one platform): the server's table has one platform the
 * device knows, and the card has no account on a platform the device does
 * not know (one there counts as more than one). The platform's name (the
 * device's own, src/platforms.ts) if so; null otherwise.
 */
export function onePlatform(st: Pick<CardStatus, "tablePlatforms" | "slots">): string | null {
  if (st.tablePlatforms.length !== 1 || !st.slots.every((sl) => sl.row !== null)) return null;
  return presentationOf(st.tablePlatforms[0]!)?.name ?? null;
}

export interface BeforeView {
  /** before.one_proof, or with one platform before.one_proof_single. */
  oneProof: Sentence;
  /** before.listed_together: more than one platform. */
  listedTogether: boolean;
}

/**
 * Step 1. There is no platform table yet, nor the card's accounts: it goes
 * by the platforms the device has its own definition of (src/platforms.ts).
 */
export function beforeView(known: ReadonlySet<string> = KNOWN_PLATFORMS): BeforeView {
  const c = COPY.before;
  const only = known.size === 1 ? presentationOf([...known][0]!) : null;
  return only ? { oneProof: say(c.one_proof_single, { platform: only.name }), listedTogether: false } : { oneProof: say(c.one_proof), listedTogether: true };
}

// Step 4: the card's list ------------------------------------------------------------

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/** A platform's name on the screen: the server's display name, or for a platform the device does not know its ID. */
/**
 * A platform's name on the screen: the device's own (src/platforms.ts), not
 * the display name of the server's table; for a platform the device does
 * not know (`row` null), its ID.
 */
export function platformName(slot: { platform: string; row: unknown }): string {
  return (slot.row === null ? null : presentationOf(slot.platform)?.name) ?? slot.platform;
}

export interface AccountRowView {
  platform: string;
  /** The display name, or the platform ID for a platform the device does not know. */
  name: string;
  /** What the screen writes before the account (`@`); "" for a platform the device does not know (shown as the server sent it). */
  prefix: string;
  /** An account of a platform the device does not know: shown exactly as the server sent it, spaces included. */
  raw: boolean;
  /** The account the row holds now ("" for none): what the field starts with. */
  current: string;
  /** A field the cardholder can type in; false for a platform the device does not know (kept as it is), and on a day with 3 records. */
  editable: boolean;
  /** accounts.preview: the platform has a public page for an account. */
  preview: boolean;
  /** The lines under the row (design/copy/card-proof.md, step 4, the table of the line under each row). */
  lines: Sentence[];
}

export interface AccountsView {
  /**
   * never: the card has no valid record; declared: it declares at least one
   * account now; nothing: it declared before and withdrew everything.
   */
  state: "never" | "declared" | "nothing";
  /** accounts.title, or with one platform accounts.title_single. */
  title: Sentence;
  /** The lines above the list. */
  lead: Message[][];
  rows: AccountRowView[];
  /** The lines below the list, before the button; each line one or two sentences. Nothing follows them: the card proof's screens link to no other page. */
  notes: Sentence[][];
  /** Below the button: accounts.not_yours, or with one platform accounts.not_yours_single; null on a day with 3 records. */
  notYours: Sentence | null;
  /** 3 records of the card today: the list as it is, this sentence, and accounts.restart only. */
  dailyLimit: Sentence | null;
}

/** The lines under one row (step 4, the table of the line under each row). */
export function rowLines(slot: SlotStatus): Sentence[] {
  const a = COPY.accounts;
  if (slot.row === null) return [say(a.row_unknown_platform)];
  if (slot.lastDeclared === null) return [say(a.row_unused)];
  const used = slot.switchCount;
  // The switches left by the record rules: 5 minus the switches used.
  const count =
    used === 0
      ? say(a.row_no_switches_yet, { switches_left: slot.switchesLeft })
      : slot.switchesLeft > 0
        ? say(a.row_switches, { switches_used: used, switches_left: slot.switchesLeft })
        : say(a.row_used_up, { switches_used: used });
  const lines: Sentence[] = [];
  const last = handle(slot.platform, slot.lastDeclared);
  if (slot.current === null) lines.push(say(a.row_withdrawn, { last_declared: last }));
  lines.push(count);
  // An account put there today can be changed today without a switch (a correction), even when none is left.
  if (slot.correctionToday) {
    if (slot.current !== null) lines.push(say(a.row_today));
  } else if (slot.switchesLeft === 0) {
    lines.push(slot.current !== null ? say(a.row_can_clear) : say(a.row_only_back, { last_declared: last }));
  }
  return lines;
}

export function accountsView(st: CardStatus): AccountsView {
  const a = COPY.accounts;
  const daily = st.dailyLimit;
  // One platform (onePlatform): the title and two lines name it.
  const single = onePlatform(st);
  const title = single !== null ? say(a.title_single, { platform: single }) : say(a.title);
  const fillOne = single !== null ? say(a.fill_one_single, { platform: single }) : say(a.fill_one);
  const onePer = single !== null ? say(a.one_per_platform_single, { platform: single }) : say(a.one_per_platform);
  const rows: AccountRowView[] = st.slots.map((slot) => ({
    platform: slot.platform,
    name: platformName(slot),
    prefix: slot.row === null ? "" : (presentationOf(slot.platform)?.prefix ?? ""),
    raw: slot.row === null,
    current: slot.current ?? "",
    editable: slot.row !== null && !daily,
    preview: slot.row !== null && !daily && (presentationOf(slot.platform)?.profileUrl ?? null) !== null,
    lines: daily ? [] : rowLines(slot),
  }));
  const anyPreview = rows.some((r) => r.preview);
  const preview = anyPreview ? [[say(a.preview_note)]] : [];
  const notYours = daily ? null : single !== null ? say(a.not_yours_single, { platform: single }) : say(a.not_yours);
  const last: Message =
    st.lastCardProof === null ? { code: "no_last_card_proof" } : st.lastCardProof === st.today ? say(a.last_card_proof_today) : say(a.last_card_proof, { days_ago: daysBetween(st.lastCardProof, st.today) });
  const dailyLimit = daily ? say(s.daily_limit) : null;
  if (st.accounts.length > 0) {
    return {
      state: "declared",
      title,
      lead: [[say(a.current), last]],
      rows,
      notes: daily ? [] : [[say(a.how_refresh)], [say(a.how_change), say(a.switches_limited)], ...preview],
      notYours,
      dailyLimit,
    };
  }
  if (st.lastCardProof !== null) {
    return {
      state: "nothing",
      title,
      lead: [[say(a.nothing_now)], [fillOne]],
      rows,
      notes: daily ? [] : [[say(a.how_change), say(a.switches_limited)], ...preview],
      notYours,
      dailyLimit,
    };
  }
  return {
    state: "never",
    title,
    lead: [[say(a.none_yet)], [fillOne]],
    rows,
    notes: daily ? [] : [[onePer, say(a.switches_limited)], ...preview],
    notYours,
    dailyLimit,
  };
}

// Step 5: the list to be signed ------------------------------------------------------

/** The sentence of what a row does (step 5, the table of what each row does; step 6 uses the same). */
export function kindSentence(r: { kind: ConsequenceRow["kind"]; username: string; current: string | null; previous: string | null; platform: string }): Sentence {
  const k = COPY.kinds;
  switch (r.kind) {
    case "first":
      return say(k.first);
    case "refresh":
      // The account it declares now: unchanged; declared again after a withdrawal: not a switch.
      return r.current === r.username ? say(k.unchanged) : say(k.again);
    case "correction":
    case "switch":
      return say(k.switch, { previous: handle(r.platform, r.previous ?? "") });
    case "withdraw":
      return say(k.withdraw);
  }
}

/** For a switch or a correction, the sentence after it: what it uses up (step 5, the table after it). */
export function switchSentence(r: ConsequenceRow): Sentence | null {
  const c = COPY.confirm;
  if (r.kind === "correction") return say(c.switch_not_counted);
  if (r.kind !== "switch") return null;
  if (r.switchesLeftAfter === 0) return say(c.uses_final_switch);
  return say(c.uses_switch, { switches_left: r.switchesLeftAfter! });
}

/** What step 5 writes under a row: what it does, and for a switch or a correction what it uses up. */
export function rowSentences(r: ConsequenceRow): Sentence[] {
  return [kindSentence(r), switchSentence(r)].filter((x): x is Sentence => x !== null);
}

export interface ConfirmRowView {
  platform: string;
  name: string;
  /** The platform ID, shown beside the name. */
  id: string;
  account: string;
  /** An account of a platform the device does not know, shown exactly as sent. */
  raw: boolean;
  lines: Sentence[];
}

export interface ConfirmView {
  intro: string;
  rows: ConfirmRowView[];
  date: string;
  /** confirm.withdraw_stays: an account is withdrawn. */
  withdrawStays: boolean;
  /** confirm.listed_together: the list is not empty, and the screens speak of more than one platform (onePlatform). */
  listedTogether: boolean;
  /** confirm.listed_single, in its place: the list is not empty, and the screens speak of one platform. */
  listedSingle: Sentence | null;
  /** The second point: what can be done later, and that no record can be deleted. */
  later: string;
  button: string;
}

/** Every row of the list unchanged: card proof again. */
function allUnchanged(rows: readonly { kind: string; username: string; current: string | null }[]): boolean {
  return rows.every((r) => r.kind === "refresh" && r.current === r.username);
}

/** `single`: the one platform's name when the screens speak of one platform (onePlatform of the card's status); null otherwise. */
export function confirmView(cq: Consequence, single: string | null = null): ConfirmView {
  const c = COPY.confirm;
  const empty = cq.accounts.length === 0;
  const rows = cq.rows.map((r) => ({
    platform: r.platform,
    name: platformName(r),
    id: r.platform,
    account: r.row === null ? r.username : handle(r.platform, r.username),
    raw: r.row === null,
    lines: rowSentences(r),
  }));
  return {
    intro: empty ? c.intro_withdraw_all : single !== null ? c.intro_single : c.intro,
    rows,
    date: cq.today,
    withdrawStays: cq.rows.some((r) => r.kind === "withdraw"),
    listedTogether: !empty && single === null,
    listedSingle: !empty && single !== null ? say(c.listed_single, { platform: single }) : null,
    later: (empty ? c.later_withdraw : c.later) + c.permanent,
    button: empty ? c.button_withdraw_all : allUnchanged(cq.rows) ? c.button_refresh : single !== null ? c.button_declare_single : c.button_declare,
  };
}

// Step 6: done ----------------------------------------------------------------------

export interface DoneRecordRow {
  platform: string;
  name: string;
  account: string;
  /** An account of a platform the device does not know, shown exactly as sent. */
  raw: boolean;
  /** What the server says was recorded on this platform; null where it has nothing for a platform the screen said it would. */
  kind: Sentence | null;
  /** The server's answer differs from what step 5 said for this platform. */
  mismatch: boolean;
  /** Where it differs: what step 5 said for this row (done.mismatch_expected). */
  expected: Sentence | null;
  /** Where it differs and the server recorded a switch that step 5 did not call one: done.mismatch_switch_used. */
  switchUsed: boolean;
}

export interface DoneView {
  title: Sentence;
  /** done.advice, or with one platform done.advice_single. */
  advice: Sentence;
  /** The list is empty: no animation, no card, no link, no advice. */
  withdrawAll: boolean;
  /** The card's list after this record: what the card shows. */
  card: { name: string; account: string; raw: boolean }[];
  /** What the server recorded differs from what step 5 said: done.mismatch, above the title. */
  mismatch: Sentence | null;
  date: string;
  shortId: string;
  /** Where to put the link: done.put_link, or with one platform done.put_link_single. */
  putLink: Sentence;
  /** The link to put on the profiles, as the screen writes it (no scheme): the card's page. */
  link: string;
  /** The link as it is copied: a whole https:// URL. */
  url: string;
  /** The card's first record: the sentence about a new card. */
  newCard: boolean;
  /** An account was withdrawn and the list is not empty: its link can be taken down. */
  withdrawnLink: boolean;
  /** The proof log's line (record_list, with one platform record_single, record_withdraw_all), or null when the answer's kinds could not be read. */
  record: Sentence | null;
  rows: DoneRecordRow[];
  /** done.kinds_unreadable */
  kindsUnreadable: boolean;
  /** One per account of the list that other cards declare too (`account_cards` above 1). */
  otherCards: Sentence[];
  shortIdLine: Sentence;
}

/** The title of step 6 (the table of titles), by what the server says was recorded. */
export function doneTitle(d: Done): Sentence {
  const t = COPY.done;
  if (d.kinds === null) return say(t.recorded_only);
  if (d.firstRecord) return say(t.first);
  if (d.accounts.length === 0) return say(t.withdraw_all);
  const current = new Map(d.expected.map((r) => [r.platform, r.current]));
  return allUnchanged(d.kinds.map((k) => ({ ...k, current: current.get(k.platform) ?? null }))) ? say(t.refresh) : say(t.changed);
}

/** `single`: the one platform's name when the screens speak of one platform (onePlatform of the card's status before this card proof); null otherwise. */
export function doneView(d: Done, single: string | null = null): DoneView {
  const t = COPY.done;
  const expected = new Map(d.expected.map((r) => [r.platform, r]));
  // A platform step 5 did not show (the server's answer differs) is named as the device knows it.
  const rowOf = (platform: string): { platform: string; row: unknown } => expected.get(platform) ?? { platform, row: presentationOf(platform) };
  const nameOf = (platform: string): string => platformName(rowOf(platform));
  const rawOf = (platform: string): boolean => rowOf(platform).row === null;
  const accountOf = (platform: string, username: string): string => (rawOf(platform) ? username : handle(platform, username));
  // done.mismatch_expected: step 5's sentences of the row, or that it had no such row.
  const expectedOf = (platform: string): Sentence => {
    const e = expected.get(platform);
    const said = e ? rowSentences(e).map((x) => fill(x.template, x.values)).join("") : t.mismatch_no_platform;
    return say(t.mismatch_expected, { expected: said });
  };
  const link = `${SITE_DOMAIN}/${cardPath(d.shortId)}`;
  const rows: DoneRecordRow[] = [];
  if (d.kinds !== null) {
    for (const k of d.kinds) {
      const e = expected.get(k.platform);
      // The sentence of the kind recorded; kinds.switch names the account the screen knew was replaced.
      const previous = e ? e.previous ?? e.current : null;
      const sentence = (k.kind === "switch" || k.kind === "correction") && previous === null ? null : kindSentence({ ...k, current: e ? e.current : null, previous });
      const mismatch = d.mismatches.includes(k.platform);
      rows.push({
        platform: k.platform,
        name: nameOf(k.platform),
        account: accountOf(k.platform, k.username),
        raw: rawOf(k.platform),
        kind: sentence,
        mismatch,
        expected: mismatch ? expectedOf(k.platform) : null,
        switchUsed: mismatch && k.kind === "switch" && e?.kind !== "switch",
      });
    }
    for (const e of d.expected) {
      if (d.kinds.some((k) => k.platform === e.platform)) continue;
      rows.push({ platform: e.platform, name: nameOf(e.platform), account: accountOf(e.platform, e.username), raw: rawOf(e.platform), kind: null, mismatch: true, expected: expectedOf(e.platform), switchUsed: false });
    }
    rows.sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0));
  }
  const withdrawAll = d.accounts.length === 0;
  const withdrew = (d.kinds ?? d.expected).some((k) => k.kind === "withdraw");
  return {
    title: doneTitle(d),
    advice: single !== null ? say(t.advice_single) : say(t.advice),
    withdrawAll,
    card: d.accounts.map((a) => ({ name: nameOf(a.platform), account: accountOf(a.platform, a.username), raw: rawOf(a.platform) })),
    mismatch: d.mismatches.length > 0 ? say(t.mismatch) : null,
    date: d.date,
    shortId: d.shortId,
    putLink: single !== null ? say(t.put_link_single, { platform: single }) : say(t.put_link),
    link,
    url: `https://${link}`,
    newCard: d.firstRecord,
    withdrawnLink: withdrew && !withdrawAll,
    record: d.kinds === null ? null : say(withdrawAll ? t.record_withdraw_all : single !== null ? t.record_single : t.record_list),
    rows,
    kindsUnreadable: d.kinds === null,
    otherCards: (d.kinds ?? [])
      .filter((k: AcceptedKind) => k.kind !== "withdraw" && k.accountCards !== null && k.accountCards > 1)
      .map((k) => say(t.other_cards, { account: accountOf(k.platform, k.username) })),
    shortIdLine: say(t.short_id, { short_id: d.shortId }),
  };
}
