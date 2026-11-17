// Which sentence of the copy the screen shows for each reason the flow
// stopped (web/README.md, the table of stops) and under which item of the
// lists; what each item of the two lists shows; the card's list and what
// each row says (step 4 of design/copy/card-proof.md); the list to be
// signed (step 5); done (step 6). Pure functions, tested in Node
// (test/ui.test.ts). Where the copy has no sentence, the screen shows the
// code alone: `{ code }`.
import type { AcceptedKind } from "../api.ts";
import type { CardStatus, Consequence, ConsequenceRow, Done, Progress, SlotStatus, Stop } from "../flow.ts";
import { SITE_DOMAIN, cardPath, handle, presentationOf } from "../platforms.ts";
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

/**
 * Codes of a submission the server did not accept, which the copy has no
 * sentence of their own for (design/copy/card-proof.md, step 5, the row of the other codes,
 * the codes other than the rows below it; `platform`, a list naming a
 * platform the roster does not accept, is one of them).
 */
const REJECTED = new Set(["scope", "platform", "malformed", "challenge_used", "challenge_attempts", "proof", "root", "date_order", "switch_restricted"]);

/** The format hint of a platform (design/copy/card-proof.json, `formats`); null if the copy has none. */
export function formatHint(platform: string): Sentence | null {
  const key = presentationOf(platform).formatHint;
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
      // The platform's hint; a platform the copy has no hint for shows the code.
      return formatHint(stop.platform) ?? { code: "username" };
    case "server": {
      const id = stop.requestId ? { requestId: stop.requestId } : {};
      if (submitFailed) return { ...say(s.submit_failed), retry: true, ...id };
      if (stop.server === "challenge_unknown") return { ...say(s.challenge_expired), ...id };
      // The server's newest CRL is more than 3 days old (docs/api/card-proof.md).
      if (stop.server === "crl_stale") return { ...say(s.server_crl_stale), ...id };
      // The roster rules, when the card's state changed since it was asked.
      if (stop.server === "daily_limit") return { ...say(s.daily_limit), ...id };
      if (stop.server === "switch_limit") return { ...say(s.switch_limit), ...id };
      if (stop.server === "empty") return { ...say(s.empty), ...id };
      if (REJECTED.has(stop.server)) return { ...say(s.rejected, { code: stop.server }), ...id };
      return { ...say(s.server_unreadable, { code: stop.server }), ...id };
    }
    case "blocked":
      // The list is empty and the card declares nothing: accounts.need_one
      if (stop.reason === "empty") return say(COPY.accounts.need_one);
      // The screen offers no change on a day with 3 records; the engine refuses one too.
      if (stop.reason === "daily_limit") return say(s.daily_limit);
      // A switch the row says cannot be made (its lines say why): no sentence for typing one anyway.
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

// Step 4: the card's list ------------------------------------------------------------

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/**
 * Whether the web page offers the 4th and 5th switch in the app (after the
 * app is out, the rows of 3 or 4 switches are accounts.row_app_only; before,
 * accounts.row_app_later). Decided by the build, like the choice of device on step 1.
 */
export const APP_RELEASED = false;

/** A platform's name on the screen: the server's display name, or for a platform the device does not know its ID. */
export function platformName(slot: { platform: string; row: { displayName: string } | null }): string {
  return slot.row === null ? slot.platform : slot.row.displayName;
}

export interface AccountRowView {
  platform: string;
  /** The display name, or the platform ID for a platform the device does not know. */
  name: string;
  /** What the screen writes before the account (`@`); "" for a platform the device does not know (shown as the server sent it). */
  prefix: string;
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
  /** The lines above the list. */
  lead: Message[][];
  rows: AccountRowView[];
  /** The lines below the list, before the button; each a sentence, and whether links.more follows it. */
  notes: { sentences: Sentence[]; more: boolean }[];
  /** 3 records of the card today: the list as it is, this sentence, and accounts.restart only. */
  dailyLimit: Sentence | null;
}

/** The lines under one row (step 4, the table of the line under each row). */
export function rowLines(slot: SlotStatus): Sentence[] {
  const a = COPY.accounts;
  if (slot.row === null) return [say(a.row_unknown_platform)];
  if (slot.lastDeclared === null) return [say(a.row_unused)];
  const used = slot.switchCount;
  // The switches left are what the web page can still make: 3 minus the switches used.
  const count =
    used === 0
      ? say(a.row_no_switches_yet, { switches_left: slot.webSwitchesLeft })
      : slot.webSwitchesLeft > 0
        ? say(a.row_switches, { switches_used: used, switches_left: slot.webSwitchesLeft })
        : used < 5
          ? say(APP_RELEASED ? a.row_app_only : a.row_app_later, { switches_used: used })
          : say(a.row_used_up, { switches_used: used });
  const lines: Sentence[] = [];
  const last = handle(slot.platform, slot.lastDeclared);
  if (slot.current === null) lines.push(say(a.row_withdrawn, { last_declared: last }));
  lines.push(count);
  // An account put there today can be changed today without a switch (a correction), even when none is left.
  if (slot.correctionToday) {
    if (slot.current !== null) lines.push(say(a.row_today));
  } else if (slot.webSwitchesLeft === 0) {
    lines.push(slot.current !== null ? say(a.row_can_clear) : say(a.row_only_back, { last_declared: last }));
  }
  return lines;
}

export function accountsView(st: CardStatus): AccountsView {
  const a = COPY.accounts;
  const daily = st.dailyLimit;
  const rows: AccountRowView[] = st.slots.map((slot) => ({
    platform: slot.platform,
    name: platformName(slot),
    prefix: slot.row === null ? "" : presentationOf(slot.platform).prefix,
    current: slot.current ?? "",
    editable: slot.row !== null && !daily,
    preview: slot.row !== null && !daily && presentationOf(slot.platform).profileUrl !== null,
    lines: daily ? [] : rowLines(slot),
  }));
  const anyPreview = rows.some((r) => r.preview);
  const preview = anyPreview ? [{ sentences: [say(a.preview_note)], more: false }] : [];
  const last: Message =
    st.lastCardProof === null ? { code: "no_last_card_proof" } : st.lastCardProof === st.today ? say(a.last_card_proof_today) : say(a.last_card_proof, { days_ago: daysBetween(st.lastCardProof, st.today) });
  const dailyLimit = daily ? say(s.daily_limit) : null;
  if (st.accounts.length > 0) {
    return {
      state: "declared",
      lead: [[say(a.current), last]],
      rows,
      notes: daily ? [] : [{ sentences: [say(a.how_refresh)], more: false }, { sentences: [say(a.how_change), say(a.switches_limited)], more: true }, ...preview],
      dailyLimit,
    };
  }
  if (st.lastCardProof !== null) {
    return {
      state: "nothing",
      lead: [[say(a.nothing_now)], [say(a.fill_one)]],
      rows,
      notes: daily ? [] : [{ sentences: [say(a.how_change), say(a.switches_limited)], more: true }, ...preview],
      dailyLimit,
    };
  }
  return {
    state: "never",
    lead: [[say(a.none_yet)], [say(a.fill_one)]],
    rows,
    notes: daily ? [] : [{ sentences: [say(a.one_per_platform), say(a.switches_limited)], more: true }, ...preview],
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
  if (r.webSwitchesLeftAfter === 0) return say(c.uses_last_switch);
  return say(c.uses_switch, { switches_left: r.webSwitchesLeftAfter! });
}

export interface ConfirmRowView {
  platform: string;
  name: string;
  /** The platform ID, shown beside the name: the display name comes from the server. */
  id: string;
  account: string;
  lines: Sentence[];
}

export interface ConfirmView {
  intro: string;
  rows: ConfirmRowView[];
  date: string;
  /** confirm.withdraw_stays: an account is withdrawn. */
  withdrawStays: boolean;
  /** confirm.listed_together: the list is not empty. */
  listedTogether: boolean;
  /** The second point: what can be done later, and that no record can be deleted. */
  later: string;
  button: string;
}

/** Every row of the list unchanged: card proof again. */
function allUnchanged(rows: readonly { kind: string; username: string; current: string | null }[]): boolean {
  return rows.every((r) => r.kind === "refresh" && r.current === r.username);
}

export function confirmView(cq: Consequence): ConfirmView {
  const c = COPY.confirm;
  const empty = cq.accounts.length === 0;
  const rows = cq.rows.map((r) => ({
    platform: r.platform,
    name: platformName(r),
    id: r.platform,
    account: r.row === null ? r.username : handle(r.platform, r.username),
    lines: [kindSentence(r), switchSentence(r)].filter((x): x is Sentence => x !== null),
  }));
  return {
    intro: empty ? c.intro_withdraw_all : c.intro,
    rows,
    date: cq.today,
    withdrawStays: cq.rows.some((r) => r.kind === "withdraw"),
    listedTogether: !empty,
    later: (empty ? c.later_withdraw : c.later) + c.permanent,
    button: empty ? c.button_withdraw_all : allUnchanged(cq.rows) ? c.button_refresh : c.button_declare,
  };
}

// Step 6: done ----------------------------------------------------------------------

export interface DoneRecordRow {
  platform: string;
  name: string;
  account: string;
  /** What the server says was recorded on this platform; null where it has nothing for a platform the screen said it would. */
  kind: Sentence | null;
  /** The server's answer differs from what step 5 said for this platform. */
  mismatch: boolean;
}

export interface DoneView {
  title: Sentence;
  /** The list is empty: no animation, no card, no link, no advice. */
  withdrawAll: boolean;
  /** The card's list after this record: what the card shows. */
  card: { name: string; account: string }[];
  date: string;
  shortId: string;
  /** The link to put on the profiles, as the screen writes it (no scheme): the card's page. */
  link: string;
  /** The link as it is copied: a whole https:// URL. */
  url: string;
  /** The card's first record: the sentence about a new card. */
  newCard: boolean;
  /** An account was withdrawn and the list is not empty: its link can be taken down. */
  withdrawnLink: boolean;
  /** The roster's line (record_list, record_withdraw_all), or null when the answer's kinds could not be read. */
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

export function doneView(d: Done): DoneView {
  const t = COPY.done;
  const expected = new Map(d.expected.map((r) => [r.platform, r]));
  const nameOf = (platform: string): string => {
    const r = expected.get(platform);
    return r ? platformName(r) : platform;
  };
  const accountOf = (platform: string, username: string): string => (expected.get(platform)?.row === null ? username : handle(platform, username));
  const link = `${SITE_DOMAIN}/${cardPath(d.shortId)}`;
  const rows: DoneRecordRow[] = [];
  if (d.kinds !== null) {
    for (const k of d.kinds) {
      const e = expected.get(k.platform);
      // The sentence of the kind recorded; kinds.switch names the account the screen knew was replaced.
      const previous = e ? e.previous ?? e.current : null;
      const sentence = (k.kind === "switch" || k.kind === "correction") && previous === null ? null : kindSentence({ ...k, current: e ? e.current : null, previous });
      rows.push({ platform: k.platform, name: nameOf(k.platform), account: accountOf(k.platform, k.username), kind: sentence, mismatch: d.mismatches.includes(k.platform) });
    }
    for (const e of d.expected) {
      if (d.kinds.some((k) => k.platform === e.platform)) continue;
      rows.push({ platform: e.platform, name: nameOf(e.platform), account: accountOf(e.platform, e.username), kind: null, mismatch: true });
    }
    rows.sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0));
  }
  const withdrawAll = d.accounts.length === 0;
  const withdrew = (d.kinds ?? d.expected).some((k) => k.kind === "withdraw");
  return {
    title: doneTitle(d),
    withdrawAll,
    card: d.accounts.map((a) => ({ name: nameOf(a.platform), account: accountOf(a.platform, a.username) })),
    date: d.date,
    shortId: d.shortId,
    link,
    url: `https://${link}`,
    newCard: d.firstRecord,
    withdrawnLink: withdrew && !withdrawAll,
    record: d.kinds === null ? null : say(withdrawAll ? t.record_withdraw_all : t.record_list),
    rows,
    kindsUnreadable: d.kinds === null,
    otherCards: (d.kinds ?? [])
      .filter((k: AcceptedKind) => k.kind !== "withdraw" && k.accountCards !== null && k.accountCards > 1)
      .map((k) => say(t.other_cards, { account: accountOf(k.platform, k.username) })),
    shortIdLine: say(t.short_id, { short_id: d.shortId }),
  };
}
