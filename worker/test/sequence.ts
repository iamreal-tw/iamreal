// The long sequence of records that Go's prooflog/ and protocol/'s rules are
// compared on (test/sequence.test.ts, #73): the generator, the files
// exchanged with Go, the counts printed, and the comparison of one
// record's answers.
//
// The files are events.json and answers.json, in the shape of a case of
// spec/vectors/record-rules.json extended with fields that are not in
// spec/ (Sequence, GoAnswers): an agreement between this file and
// prooflog/sequence_test.go only.
import { encodeBase32 } from "iamreal-protocol/base32.ts";
import { type Day, dayOf, formatDay, parseDay } from "iamreal-protocol/date.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import type { CardState, Kind, Reason } from "iamreal-protocol/record-rules.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { scopedIdText } from "iamreal-protocol/scoped-id.ts";
import { type SlotJson, slotToJson } from "../src/slot-json.ts";

export type { SlotJson };

/** An event of spec/vectors/record-rules.json: a well-formed record with the answers of checks 1 and 3. */
export interface SequenceEvent {
  seq: number;
  scope_string: string;
  scoped_id: string;
  accounts: { platform: string; username: string }[];
  challenge: string;
  date: string;
  verifies: boolean;
  crl_dates: string[];
}

/**
 * events.json: a case of the vectors without its answers, and
 * `checkpoint_every`, how often Go lists the accounts (not in spec/).
 */
export interface Sequence {
  name: string;
  proof_log: "test";
  events: SequenceEvent[];
  checkpoint_every: number;
}

/**
 * The random numbers of the generator: mulberry32, a 32-bit state that
 * every call adds 0x6D2B79F5 to and mixes, with 32-bit integer operations
 * only. Written here rather than taken from Node, so that the sequence of a
 * seed does not depend on the version of Node.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How the generator behaves. Tuned so that the sequence of seed 1 and
 * 10,000 records has every reason code, and every kind on every platform, at
 * least 100 times (test/sequence.test.ts prints the counts).
 */
const SHAPE = {
  /**
   * Cards in all; at any time the records are of `window` of them, and the
   * window moves on by one card every `slide` records (after the last card,
   * back to the first).
   */
  cards: 160,
  window: 8,
  slide: 64,
  /** Each platform's accounts: few, so that cards go back to an account and share one. The same names on both platforms are two accounts. */
  usernames: ["alice", "bob", "carol", "dave"],
  /** The chance that the day moves on before a record: 18 records a day, a little over 2 of each card, so that a card often changes an account on the date of its last card proof. */
  nextDay: 1 / 18,
  /** For each platform of a record, the chance that the card wants another account, and that it wants none there. */
  changeAccount: 0.2,
  dropAccount: 0.06,
  /** The chance of an empty list, whatever the card wants. */
  emptyList: 0.05,
  /** The chance that a record sends the challenge of one of the last 30 records again. */
  reuseChallenge: 0.03,
  /** The chance that a record does not verify. */
  noProof: 0.03,
  /** The chance that no CRL behind the record's root fits its date. */
  noRoot: 0.03,
  /**
   * The chance that a record is of a card that left the window not long
   * ago (one of the 20 before it), dated 4 days before the day: a card of
   * the window has almost always a record of a later date, so this is how
   * a record exactly 4 days back is often valid (check 4's bound).
   */
  comeBack: 0.04,
};

/**
 * The record's date against the day: mostly the day, often the day before
 * (a challenge taken before midnight), sometimes 2 to 4 days back (within
 * check 4's 4 days) or 5 to 8 (beyond them), sometimes 1 to 3 days ahead.
 */
function dateOffset(rand: () => number): number {
  const r = rand();
  if (r < 0.84) return 0;
  if (r < 0.92) return -1;
  if (r < 0.95) return -2 - Math.floor(rand() * 3);
  if (r < 0.97) return -5 - Math.floor(rand() * 4);
  return 1 + Math.floor(rand() * 3);
}

/**
 * The CRL dates of the record's root. Mostly one CRL that fits (from 3 days
 * before the date to 1 day after, the bounds included), sometimes with
 * another that does not; with the chance SHAPE.noRoot, none that fits,
 * the nearest ones that do not included.
 */
function crlDates(rand: () => number, d: Day): Day[] {
  if (rand() < SHAPE.noRoot) {
    const misses: Day[][] = [[], [d - 4], [d + 2], [d - 9, d + 6]];
    return misses[Math.floor(rand() * misses.length)]!;
  }
  const fits = d - 3 + Math.floor(rand() * 5);
  return rand() < 0.3 ? [d + 2 + Math.floor(rand() * 20), fits] : [fits];
}

/**
 * A sequence of `length` records of the test log (two platforms) from a
 * seed. It knows nothing of the rules: it keeps, for each card, which
 * account it wants on each platform, and sends the lists, dates, challenges
 * and CRL dates that make the rules' cases common: few cards and accounts,
 * dates back and forth around a day that moves on slowly. A longer sequence
 * of the same seed starts with the shorter one.
 */
export function generateSequence({ seed, length, checkpointEvery = 100 }: { seed: number; length: number; checkpointEvery?: number }): Sequence {
  const rand = mulberry32(seed);
  const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => Math.floor(rand() * 256));
  const platforms = platformsOf("test").map((p) => p.platform);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  // 31 random bytes are below the field modulus: a scoped ID in its one spelling.
  const cards = Array.from({ length: SHAPE.cards }, () => ({
    id: scopedIdText(BigInt(`0x${Buffer.from(bytes(31)).toString("hex")}`)),
    wants: new Map(platforms.map((p) => [p, rand() < 0.7 ? pick(SHAPE.usernames) : null])),
  }));
  const challenges: string[] = [];
  let day = dayOf(2026, 1, 1);
  const events: SequenceEvent[] = [];
  for (let i = 0; i < length; i++) {
    if (rand() < SHAPE.nextDay) day++;
    const from = Math.floor(i / SHAPE.slide);
    const comesBack = rand() < SHAPE.comeBack;
    const index = comesBack ? from - 1 - Math.floor(rand() * 20) : from + Math.floor(rand() * SHAPE.window);
    const card = cards[((index % SHAPE.cards) + SHAPE.cards) % SHAPE.cards]!;
    for (const p of platforms) {
      const r = rand();
      if (r < SHAPE.changeAccount) card.wants.set(p, pick(SHAPE.usernames));
      else if (r < SHAPE.changeAccount + SHAPE.dropAccount) card.wants.set(p, null);
    }
    const accounts = rand() < SHAPE.emptyList ? [] : platforms.flatMap((p) => (card.wants.get(p) ? [{ platform: p, username: card.wants.get(p)! }] : []));
    const challenge = challenges.length > 0 && rand() < SHAPE.reuseChallenge ? pick(challenges.slice(-30)) : `${formatDay(day + (comesBack ? -4 : dateOffset(rand)))}.${encodeBase32(bytes(16))}`;
    challenges.push(challenge);
    const date = challenge.slice(0, 10);
    events.push({
      seq: i + 1,
      scope_string: scopeOf("test"),
      scoped_id: card.id,
      accounts,
      challenge,
      date,
      verifies: rand() >= SHAPE.noProof,
      crl_dates: crlDates(rand, parseDay(date)!).map(formatDay),
    });
  }
  return { name: `sequence of seed ${seed}`, proof_log: "test", events, checkpoint_every: checkpointEvery };
}

/** A card's state after a record: last_card_proof null for a card without a valid record. */
export interface CardJson {
  last_card_proof: string | null;
  slots: Record<string, SlotJson>;
}

/** A card's state (protocol/) in the spelling of the vectors' `state`; a slot in the one spelling the back end has (src/slot-json.ts). */
export function cardJsonOf(card: CardState): CardJson {
  return {
    last_card_proof: card.lastCardProof === null ? null : formatDay(card.lastCardProof),
    slots: Object.fromEntries([...card.slots].map(([p, s]) => [p, slotToJson(s)])),
  };
}

/** A record's result in the spelling of the vectors' `results`, without `seq`. */
export interface ResultJson {
  valid: boolean;
  kinds?: { platform: string; kind: string }[];
  reason?: string;
}

/** What is compared for each record: its result, and the state of its card after it. */
export interface Answer {
  result: ResultJson;
  card: CardJson;
}

/** An account and the number of cards that declare it now: `account_cards`. */
export interface AccountCount {
  scope_string: string;
  platform: string;
  username: string;
  account_cards: number;
}

/**
 * answers.json, what Go's prooflog/ writes for a sequence
 * (prooflog/sequence_test.go): the case of the vectors with its `results` and
 * final `state`, and, not in spec/: `rules_version`; for each record,
 * `cards`, the state of its card after it, and `latest_valid_dates`, the
 * latest date among the valid records up to it; and `checkpoints`, every
 * declared account with its number of cards, after every
 * `checkpoint_every` records and after the last; and the final `ordinals`.
 */
export interface GoAnswers {
  rules_version: number;
  name: string;
  proof_log: string;
  events: SequenceEvent[];
  results: (ResultJson & { seq: number })[];
  cards: (CardJson & { scope_string: string; scoped_id: string })[];
  latest_valid_dates: (string | null)[];
  checkpoints: { after: number; accounts: AccountCount[] }[];
  state: unknown[];
  ordinals: { scope_string: string; scoped_id: string; ordinal: number }[];
}

/**
 * The reason codes of spec/record-rules.md, "Per record", and the kinds of
 * "Event rules": every one of protocol/'s types, and no other (a code added
 * there and not here fails the type check).
 */
export const REASONS = Object.keys({ proof: 0, challenge_reused: 0, root: 0, date_order: 0, empty: 0, switch_limit: 0 } satisfies Record<Reason, 0>) as Reason[];
export const KINDS = Object.keys({ first: 0, refresh: 0, switch: 0, withdraw: 0 } satisfies Record<Kind, 0>) as Kind[];

/** How many records have each reason code, and how many (platform, kind) pairs each kind, in all and on each platform (`platform kind`). */
export function statistics(results: readonly ResultJson[]): { valid: number; reasons: Record<string, number>; kinds: Record<string, number>; byPlatform: Record<string, number> } {
  const reasons: Record<string, number> = Object.fromEntries(REASONS.map((r) => [r, 0]));
  const kinds: Record<string, number> = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const byPlatform: Record<string, number> = {};
  let valid = 0;
  for (const r of results) {
    if (!r.valid) {
      reasons[r.reason!] = (reasons[r.reason!] ?? 0) + 1;
      continue;
    }
    valid++;
    for (const k of r.kinds ?? []) {
      kinds[k.kind] = (kinds[k.kind] ?? 0) + 1;
      byPlatform[`${k.platform} ${k.kind}`] = (byPlatform[`${k.platform} ${k.kind}`] ?? 0) + 1;
    }
  }
  return { valid, reasons, kinds, byPlatform };
}

/** The cases of spec/record-rules.md a sequence must hold often (scenarios). */
export type Scenario =
  | "around_midnight"
  | "more_than_4_days_back"
  | "exactly_4_days_back_valid"
  | "fifth_switch"
  | "sixth_switch_blocked"
  | "switch_on_the_same_date"
  | "declared_again_after_withdrawing_all"
  | "account_of_several_cards";

/**
 * How many times each case happens in a sequence, read from its events and
 * Go's answers (the proof log's latest valid date before each record, the
 * state of each card after each record), not from protocol/:
 *
 * - `around_midnight`: a valid record dated the day before the proof log's latest valid date
 * - `more_than_4_days_back`: a `date_order` record dated more than 4 days before it
 * - `exactly_4_days_back_valid`: a valid record dated exactly 4 days before it
 * - `fifth_switch`: a switch that makes the slot's `switch_count` 5
 * - `sixth_switch_blocked`: a `switch_limit` record
 * - `switch_on_the_same_date`: a switch, on any platform, dated the card's last card proof before it: a card that
 *   changes an account on the date it had a valid record is counted a switch too
 * - `declared_again_after_withdrawing_all`: a valid record that declares an account, of a card that had valid records and declared nothing
 * - `account_of_several_cards`: a valid record after which an account of its list is declared by 2 cards or more
 */
export function scenarios(events: readonly SequenceEvent[], answers: Pick<GoAnswers, "results" | "cards" | "latest_valid_dates">): Record<Scenario, number> {
  const count: Record<Scenario, number> = {
    around_midnight: 0,
    more_than_4_days_back: 0,
    exactly_4_days_back_valid: 0,
    fifth_switch: 0,
    sixth_switch_blocked: 0,
    switch_on_the_same_date: 0,
    declared_again_after_withdrawing_all: 0,
    account_of_several_cards: 0,
  };
  /** Each card's state after its last record so far, by scope and scoped ID. */
  const cards = new Map<string, CardJson>();
  events.forEach((e, i) => {
    const result = answers.results[i]!;
    const before = i === 0 ? null : answers.latest_valid_dates[i - 1]!;
    const back = before === null ? null : parseDay(before)! - parseDay(e.date)!;
    const cardKey = `${e.scope_string} ${e.scoped_id}`;
    const cardBefore = cards.get(cardKey);
    const after = answers.cards[i]!;
    cards.set(cardKey, after);
    if (!result.valid) {
      if (result.reason === "date_order" && back !== null && back > 4) count.more_than_4_days_back++;
      if (result.reason === "switch_limit") count.sixth_switch_blocked++;
      return;
    }
    if (back === 1) count.around_midnight++;
    if (back === 4) count.exactly_4_days_back_valid++;
    for (const k of result.kinds ?? []) {
      if (k.kind === "switch" && after.slots[k.platform]!.switch_count === 5) count.fifth_switch++;
      if (k.kind === "switch" && cardBefore?.last_card_proof === e.date) count.switch_on_the_same_date++;
    }
    const declaredNothing = cardBefore !== undefined && cardBefore.last_card_proof !== null && Object.values(cardBefore.slots).every((s) => s.current === null);
    if (declaredNothing && e.accounts.length > 0) count.declared_again_after_withdrawing_all++;
    const shared = e.accounts.some((a) => [...cards].filter(([key, c]) => key.startsWith(`${e.scope_string} `) && c.slots[a.platform]?.current === a.username).length >= 2);
    if (shared) count.account_of_several_cards++;
  });
  return count;
}

/** Where two values differ: a path such as `card.slots.threads.switch_count`, and both values. */
export interface Difference {
  field: string;
  want: unknown;
  got: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const key = (path: string, k: string): string => (/^[a-z_][a-z0-9_]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

/** The first place, in the order of `want`, where `got` differs from it, the path starting with `field`; null if they are the same. */
export function difference(field: string, want: unknown, got: unknown): Difference | null {
  if (Array.isArray(want) && Array.isArray(got)) {
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      const d = difference(`${field}[${i}]`, want[i], got[i]);
      if (d) return d;
    }
    return null;
  }
  if (isObject(want) && isObject(got)) {
    for (const k of [...new Set([...Object.keys(want), ...Object.keys(got)])]) {
      const d = difference(key(field, k), want[k], got[k]);
      if (d) return d;
    }
    return null;
  }
  return Object.is(want, got) ? null : { field, want, got };
}

/**
 * The first field, in the order of `want`, where `got` differs from it; null
 * if they are the same. The result comes before the card, `valid` before the
 * reason and the kinds.
 */
export function firstDifference(want: Answer, got: Answer): Difference | null {
  return difference("result", want.result, got.result) ?? difference("card", want.card, got.card);
}
