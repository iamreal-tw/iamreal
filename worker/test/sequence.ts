// The long sequence of records that Go's roster/ and protocol/'s rules are
// compared on (test/sequence.test.ts, #73): the generator, the answers in
// the spelling of spec/vectors/roster-rules.json, and the comparison of
// one record's answers.
import { encodeBase32 } from "iamreal-protocol/base32.ts";
import { type Day, dayOf, formatDay, parseDay } from "iamreal-protocol/date.ts";
import { platformsOf } from "iamreal-protocol/platforms.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { scopedIdText } from "iamreal-protocol/scoped-id.ts";

/** An event of spec/vectors/roster-rules.json: a well-formed record with the answers of checks 1 and 3. */
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

/** A sequence: a case of the vectors without its answers. */
export interface Sequence {
  name: string;
  roster: "test";
  events: SequenceEvent[];
}

/**
 * The random numbers of the generator: mulberry32, a 32-bit state that
 * every call adds 0x6D2B79F5 to and mixes. Written here rather than taken
 * from the language, so that one seed gives the same sequence on every
 * machine and every version of Node; any language with 32-bit integer
 * arithmetic can run it.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How the generator behaves. Tuned so that a sequence of 10,000 records
 * has every reason code and every kind at least 100 times
 * (test/sequence.test.ts prints the counts).
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
  /** The chance that the day moves on before a record: 18 records a day, a little over 2 of each card, so that a card's fourth of a date is common. */
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
};

/**
 * The record's date against the day: mostly the day, often the day before
 * (a challenge taken before midnight), sometimes a few days back (more than
 * check 4's 4 days or less), sometimes up to 3 days ahead.
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
 * A sequence of `length` records of the test roster (two platforms) from a
 * seed. It knows nothing of the rules: it keeps, for each card, which
 * account it wants on each platform, and sends the lists, dates, challenges
 * and CRL dates that make the rules' cases common: few cards and accounts,
 * dates back and forth around a day that moves on slowly. A longer sequence
 * of the same seed starts with the shorter one.
 */
export function generateSequence({ seed, length }: { seed: number; length: number }): Sequence {
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
    const card = cards[(Math.floor(i / SHAPE.slide) + Math.floor(rand() * SHAPE.window)) % SHAPE.cards]!;
    for (const p of platforms) {
      const r = rand();
      if (r < SHAPE.changeAccount) card.wants.set(p, pick(SHAPE.usernames));
      else if (r < SHAPE.changeAccount + SHAPE.dropAccount) card.wants.set(p, null);
    }
    const accounts = rand() < SHAPE.emptyList ? [] : platforms.flatMap((p) => (card.wants.get(p) ? [{ platform: p, username: card.wants.get(p)! }] : []));
    const challenge = challenges.length > 0 && rand() < SHAPE.reuseChallenge ? pick(challenges.slice(-30)) : `${formatDay(day + dateOffset(rand))}.${encodeBase32(bytes(16))}`;
    challenges.push(challenge);
    const date = challenge.slice(0, 10);
    const d = parseDay(date)!;
    events.push({
      seq: i + 1,
      scope_string: scopeOf("test"),
      scoped_id: card.id,
      accounts,
      challenge,
      date,
      verifies: rand() >= SHAPE.noProof,
      crl_dates: crlDates(rand, d).map(formatDay),
    });
  }
  return { name: `sequence of seed ${seed}`, roster: "test", events };
}

/** A slot in the spelling of the vectors' `state` (and of `card-state`'s `platforms`). */
export interface SlotJson {
  current: string | null;
  last_declared: string | null;
  switch_count: number;
  correction_date: string | null;
}

/** A card's state after a record: last_card_proof null for a card without a valid record. */
export interface CardJson {
  last_card_proof: string | null;
  proofs_on_last_date: number;
  slots: Record<string, SlotJson>;
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

/**
 * What Go's roster/ writes for a sequence (roster/sequence_test.go,
 * answers.json): the case of the vectors with its `results` and final
 * `state`, and `cards`, the state of each record's card after it.
 */
export interface GoAnswers extends Omit<Sequence, "roster"> {
  rules_version: number;
  roster: string;
  results: (ResultJson & { seq: number })[];
  cards: (CardJson & { scope_string: string; scoped_id: string })[];
  state: unknown[];
}

/** The reason codes of spec/roster-rules.md, "Per record", and the kinds of "Event rules". */
export const REASONS = ["proof", "challenge_reused", "root", "date_order", "empty", "switch_limit", "daily_limit"] as const;
export const KINDS = ["first", "refresh", "correction", "switch", "withdraw"] as const;

/** How many records have each reason code, and how many (platform, kind) pairs each kind, on each platform and in all. */
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

/** The first field where two answers differ: a path such as `card.slots.threads.switch_count`, and both values. */
export interface Difference {
  field: string;
  want: unknown;
  got: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const key = (path: string, k: string): string => (/^[a-z_][a-z0-9_]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

function differ(path: string, want: unknown, got: unknown): Difference | null {
  if (Array.isArray(want) && Array.isArray(got)) {
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      const d = differ(`${path}[${i}]`, want[i], got[i]);
      if (d) return d;
    }
    return null;
  }
  if (isObject(want) && isObject(got)) {
    for (const k of [...new Set([...Object.keys(want), ...Object.keys(got)])]) {
      const d = differ(key(path, k), want[k], got[k]);
      if (d) return d;
    }
    return null;
  }
  return Object.is(want, got) ? null : { field: path, want, got };
}

/**
 * The first field, in the order of `want`, where `got` differs from it; null
 * if they are the same. The result comes before the card, `valid` before the
 * reason and the kinds.
 */
export function firstDifference(want: Answer, got: Answer): Difference | null {
  return differ("result", want.result, got.result) ?? differ("card", want.card, got.card);
}
