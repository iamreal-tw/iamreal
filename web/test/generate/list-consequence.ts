// Writes spec/vectors/list-consequence.json. Run from web/:
//
//   node --experimental-strip-types test/generate/list-consequence.ts
//
// The result of every case is written here by hand; if web/'s code
// (test/list-consequence.ts) gives a different one, this stops and writes
// nothing.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { type ListConsequenceCase, type ListConsequenceResult, type ResultRow, listConsequenceResult } from "../list-consequence.ts";

const out = new URL("../../../spec/vectors/list-consequence.json", import.meta.url);

interface Case extends Omit<ListConsequenceCase, "known_platforms"> {
  name: string;
  /** Both platforms of spec/scope.md unless the case says otherwise. */
  known_platforms?: string[];
  result: ListConsequenceResult;
}

const THREADS = { platform: "threads", display_name: "Threads", username_format: "[a-z0-9._]{1,30}" };
const EXAMPLE = { platform: "test-example", display_name: "Example (no real service)", username_format: "[a-z0-9-]{1,20}" };
/** The table of the production log, and of a test log (spec/scope.md). */
const PRODUCTION = [THREADS];
const TEST = [EXAMPLE, THREADS];

type Slot = { current: string | null; last_declared: string | null; switch_count: number };
const EMPTY: Slot = { current: null, last_declared: null, switch_count: 0 };
/** bob on threads, one switch used: the example of docs/api/card-proof.md. */
const BOB: Slot = { current: "bob", last_declared: "bob", switch_count: 1 };

const state = (platforms: Record<string, unknown>, lastCardProof: string | null = "2026-11-04", proofsOnLastDate = lastCardProof === null ? 0 : 1, more: Record<string, unknown> = {}) => ({
  last_card_proof: lastCardProof,
  proofs_on_last_date: proofsOnLastDate,
  daily_limit: 3,
  platforms,
  count: 137,
  ...more,
});
const NEW = state({ threads: EMPTY }, null);
const NEW_TEST = state({ "test-example": EMPTY, threads: EMPTY }, null);

const TODAY = "2026-11-16";
const acc = (platform: string, username: string) => ({ platform, username });
const row = (platform: string, kind: string, username: string, current: string | null, previous: string | null = null, switchesLeft: number | null = null, known = true): ResultRow => ({
  platform,
  known,
  kind,
  username,
  current,
  previous,
  switches_left: switchesLeft,
});
const valid = (accounts: { platform: string; username: string }[], rows: ResultRow[], firstRecord = false): ListConsequenceResult => ({ valid: true, accounts, rows, first_record: firstRecord });

/** The card has `example`, a platform the table does not have; `zzz` has no account. */
const KEPT = state({ threads: BOB, example: { current: "Bob Example", whatever: 1 }, zzz: { current: null } });

const cases: Case[] = [
  // --- What a list does, row by row ---------------------------------------
  {
    name: "another account on a later date is a switch",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }),
    today: TODAY,
    accounts: [acc("threads", "carol")],
    result: valid([acc("threads", "carol")], [row("threads", "switch", "carol", "bob", "bob", 3)]),
  },
  {
    name: "the same account is a refresh",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "an account left out is withdrawn; the row names it",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }),
    today: TODAY,
    accounts: [],
    result: valid([], [row("threads", "withdraw", "bob", "bob")]),
  },
  {
    name: "another account on the date of the card's last card proof is a switch too",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }, TODAY),
    today: TODAY,
    accounts: [acc("threads", "carol")],
    result: valid([acc("threads", "carol")], [row("threads", "switch", "carol", "bob", "bob", 3)]),
  },
  {
    name: "after a withdrawal, another account is a switch from the last one declared",
    platforms: PRODUCTION,
    card_state: state({ threads: { ...BOB, current: null } }),
    today: TODAY,
    accounts: [acc("threads", "carol")],
    result: valid([acc("threads", "carol")], [row("threads", "switch", "carol", null, "bob", 3)]),
  },
  {
    name: "after a withdrawal, the same account again is a refresh",
    platforms: PRODUCTION,
    card_state: state({ threads: { ...BOB, current: null } }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", null)]),
  },
  {
    name: "a card without a record: a first declaration, and its first record",
    platforms: PRODUCTION,
    card_state: NEW,
    today: TODAY,
    accounts: [acc("threads", "alice")],
    result: valid([acc("threads", "alice")], [row("threads", "first", "alice", null)], true),
  },
  {
    name: "the fifth switch leaves none",
    platforms: PRODUCTION,
    card_state: state({ threads: { ...BOB, switch_count: 4 } }),
    today: TODAY,
    accounts: [acc("threads", "carol")],
    result: valid([acc("threads", "carol")], [row("threads", "switch", "carol", "bob", "bob", 0)]),
  },
  {
    name: "no switch left: another account is switch_limit, naming the platform",
    platforms: PRODUCTION,
    card_state: state({ threads: { ...BOB, switch_count: 5 } }),
    today: TODAY,
    accounts: [acc("threads", "carol")],
    result: { valid: false, reason: "switch_limit", platform: "threads" },
  },
  {
    name: "no switch left: the same account is a refresh, and leaving it out a withdrawal",
    platforms: PRODUCTION,
    card_state: state({ threads: { ...BOB, switch_count: 5 } }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "no switch left: another account on the date of the fifth switch is switch_limit too",
    platforms: PRODUCTION,
    card_state: state({ threads: { ...BOB, switch_count: 5 } }, TODAY),
    today: TODAY,
    accounts: [acc("threads", "carol")],
    result: { valid: false, reason: "switch_limit", platform: "threads" },
  },
  {
    name: "the empty list for a card without a record is empty",
    platforms: PRODUCTION,
    card_state: NEW,
    today: TODAY,
    accounts: [],
    result: { valid: false, reason: "empty" },
  },
  {
    name: "the empty list after everything was withdrawn is empty",
    platforms: PRODUCTION,
    card_state: state({ threads: { ...BOB, current: null } }),
    today: TODAY,
    accounts: [],
    result: { valid: false, reason: "empty" },
  },
  {
    name: "the server's daily_limit of records today: daily_limit, whatever the list",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }, TODAY, 3),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: { valid: false, reason: "daily_limit" },
  },
  {
    name: "the limit is the answer's daily_limit: 2 records today and a daily_limit of 2",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }, TODAY, 2, { daily_limit: 2 }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: { valid: false, reason: "daily_limit" },
  },
  {
    name: "the limit is the answer's daily_limit: 4 records today and a daily_limit of 5, allowed",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }, TODAY, 4, { daily_limit: 5 }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "a daily_limit of 0: no list today, also for a card without a record",
    platforms: PRODUCTION,
    card_state: state({ threads: EMPTY }, null, 0, { daily_limit: 0 }),
    today: TODAY,
    accounts: [acc("threads", "alice")],
    result: { valid: false, reason: "daily_limit" },
  },
  {
    name: "the record rules come first: switch_limit, not daily_limit",
    platforms: PRODUCTION,
    card_state: state({ threads: { ...BOB, switch_count: 5 } }, TODAY, 3),
    today: TODAY,
    accounts: [acc("threads", "carol")],
    result: { valid: false, reason: "switch_limit", platform: "threads" },
  },
  {
    name: "3 valid records on the last date, and today is later: allowed",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }, "2026-11-15", 3),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "a last card proof up to 3 days after today is read; the list is computed on today",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }, "2026-11-19"),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "two platforms: a first on one and a switch on the other, in ascending order of platform",
    platforms: TEST,
    card_state: state({ "test-example": EMPTY, threads: BOB }),
    today: TODAY,
    accounts: [acc("test-example", "carol"), acc("threads", "dave")],
    result: valid([acc("test-example", "carol"), acc("threads", "dave")], [row("test-example", "first", "carol", null), row("threads", "switch", "dave", "bob", "bob", 3)]),
  },
  {
    name: "two platforms: a platform with no switch left blocks the whole list",
    platforms: TEST,
    card_state: state({ "test-example": EMPTY, threads: { ...BOB, switch_count: 5 } }),
    today: TODAY,
    accounts: [acc("test-example", "carol"), acc("threads", "dave")],
    result: { valid: false, reason: "switch_limit", platform: "threads" },
  },
  {
    name: "two platforms: a platform left empty that had nothing has no row",
    platforms: TEST,
    card_state: NEW_TEST,
    today: TODAY,
    accounts: [acc("threads", "alice")],
    result: valid([acc("threads", "alice")], [row("threads", "first", "alice", null)], true),
  },

  // --- Platforms the device does not know ---------------------------------
  {
    name: "an account on a platform the device does not know stays in the list as it is, in its place",
    platforms: PRODUCTION,
    card_state: KEPT,
    today: TODAY,
    accounts: [acc("threads", "carol")],
    result: valid([acc("example", "Bob Example"), acc("threads", "carol")], [row("example", "refresh", "Bob Example", "Bob Example", null, null, false), row("threads", "switch", "carol", "bob", "bob", 3)]),
  },
  {
    name: "the empty list does not withdraw an account the device keeps",
    platforms: PRODUCTION,
    card_state: KEPT,
    today: TODAY,
    accounts: [],
    result: valid([acc("example", "Bob Example")], [row("example", "refresh", "Bob Example", "Bob Example", null, null, false), row("threads", "withdraw", "bob", "bob")]),
  },
  {
    name: "a row of the table the device cannot read is a platform it does not know",
    platforms: [{ platform: "example", display_name: "Example", username_format: "[a-z" }, THREADS],
    card_state: KEPT,
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("example", "Bob Example"), acc("threads", "bob")], [row("example", "refresh", "Bob Example", "Bob Example", null, null, false), row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "a row of the table the device has no definition of is a platform it does not know",
    platforms: TEST,
    known_platforms: ["threads"],
    card_state: state({ "test-example": { current: "carol", last_declared: "carol", switch_count: 0 }, threads: BOB }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("test-example", "carol"), acc("threads", "bob")], [row("test-example", "refresh", "carol", "carol", null, null, false), row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "a row the device has no definition of, without an account: not offered, no row",
    platforms: TEST,
    known_platforms: ["threads"],
    card_state: state({ "test-example": { ...BOB, current: null, last_declared: "carol" }, threads: BOB }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "a kept account is checked only as any username, not against its row's format",
    platforms: TEST,
    known_platforms: ["threads"],
    card_state: state({ "test-example": { current: "Bob Example", last_declared: "Bob Example", switch_count: 0 }, threads: BOB }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("test-example", "Bob Example"), acc("threads", "bob")], [row("test-example", "refresh", "Bob Example", "Bob Example", null, null, false), row("threads", "refresh", "bob", "bob")]),
  },
  {
    name: "no definition for any platform of the table: nothing is offered, every account is kept",
    platforms: PRODUCTION,
    known_platforms: [],
    card_state: state({ threads: BOB }),
    today: TODAY,
    accounts: [],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob", null, null, false)]),
  },
  {
    name: "a row the device has no definition of cannot be named by the list",
    platforms: TEST,
    known_platforms: ["threads"],
    card_state: state({ "test-example": EMPTY, threads: BOB }),
    today: TODAY,
    accounts: [acc("test-example", "carol"), acc("threads", "bob")],
    result: { not_offered: true },
  },
  {
    name: "a platform of the table without an entry in the state is not offered",
    platforms: TEST,
    card_state: state({ threads: BOB }),
    today: TODAY,
    accounts: [acc("threads", "bob")],
    result: valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob")]),
  },

  // --- A list that is not one for this state ------------------------------
  {
    name: "the list names a platform of the table that is not offered",
    platforms: TEST,
    card_state: state({ threads: BOB }),
    today: TODAY,
    accounts: [acc("test-example", "bob"), acc("threads", "bob")],
    result: { not_offered: true },
  },
  {
    name: "the list names a platform outside the table",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }),
    today: TODAY,
    accounts: [acc("instagram", "bob"), acc("threads", "bob")],
    result: { not_offered: true },
  },
  {
    name: "the list names a platform whose account the device keeps",
    platforms: PRODUCTION,
    card_state: KEPT,
    today: TODAY,
    accounts: [acc("example", "Bob Example"), acc("threads", "bob")],
    result: { not_offered: true },
  },
  {
    name: "a username outside its platform's format",
    platforms: PRODUCTION,
    card_state: state({ threads: BOB }),
    today: TODAY,
    accounts: [acc("threads", "Bob")],
    result: { valid: false, reason: "username", platform: "threads" },
  },
  ...["王小明", 'a"b', "a b", "a\\b", "bob\n", "x".repeat(31)].map(
    (u): Case => ({
      name: `a username outside its platform's format: ${JSON.stringify(u)}`,
      platforms: PRODUCTION,
      card_state: state({ threads: BOB }),
      today: TODAY,
      accounts: [acc("threads", u)],
      result: { valid: false, reason: "username", platform: "threads" },
    }),
  ),
  {
    name: "two usernames outside their formats: the first platform in ascending order",
    platforms: TEST,
    card_state: NEW_TEST,
    today: TODAY,
    accounts: [acc("test-example", "a_b"), acc("threads", "a-b")],
    result: { valid: false, reason: "username", platform: "test-example" },
  },
];

// --- Reading the platform table ---------------------------------------------

const readsTable = (name: string, platforms: unknown, readable: boolean): Case => ({
  name: `the table: ${name}`,
  platforms,
  card_state: state({ threads: BOB }),
  today: TODAY,
  accounts: [acc("threads", "bob")],
  result: readable ? valid([acc("threads", "bob")], [row("threads", "refresh", "bob", "bob")]) : { unread: "platforms" },
});
const named = (display_name: unknown) => [{ ...THREADS, display_name }];
cases.push(
  readsTable("not in ascending order of platform", [THREADS, { platform: "example", display_name: "Example", username_format: "[a-z]{1,9}" }], false),
  readsTable("a platform twice", [THREADS, THREADS], false),
  readsTable("a platform twice, once in a row it cannot read", [{ ...THREADS, username_format: "a+" }, THREADS], false),
  readsTable("no row it can read: the format", [{ ...THREADS, username_format: "[a-z0-9._]+" }], false),
  readsTable("no row it can read: no display name", [{ platform: "threads", username_format: "[a-z0-9._]{1,30}" }], false),
  readsTable("no row at all", [], false),
  readsTable("not a list", { threads: THREADS }, false),
  readsTable("an element that names no platform ID is passed over; fields it does not know are ignored", [1, null, { platform: "Threads" }, { platform: 7 }, { ...THREADS, more: true }], true),
  readsTable("a display name of 100 UTF-16 code units", named("x".repeat(100)), true),
  readsTable("a display name of 101 UTF-16 code units", named("x".repeat(101)), false),
  readsTable("a display name of 50 characters outside the BMP: 100 code units", named("😀".repeat(50)), true),
  readsTable("a display name of 51 characters outside the BMP: 102 code units", named("😀".repeat(51)), false),
  readsTable("an empty display name", named(""), false),
  readsTable("a display name with a control character", named("Th\u0007reads"), false),
  readsTable("a display name with a C1 control character", named("Th\u0085reads"), false),
  readsTable("a display name with a line separator", named("Th reads"), false),
  readsTable("a display name with a paragraph separator", named("Th reads"), false),
  readsTable("a display name with DEL", named("Th\u007freads"), false),
  readsTable("a display name with a space and non-ASCII", named("Threads 脆"), true),
);
// The one form of a format, `[…]{m,n}` (spec/scope.md). Each readable one accepts `bob`.
const formatted = (username_format: string) => [{ ...THREADS, username_format }];
for (const f of ["[a-z]{1,9}", "[-a-z]{1,3}", "[a-z-]{3,3}", "[a-cb-o]{1,999999999}", "[bo]{3,3}"]) cases.push(readsTable(`the format ${f}`, formatted(f), true));
for (const f of [
  "[^a-z]{1,9}",
  "[!-~]{1,9}",
  "[a-z]{01,9}",
  "[a-z]{1,1234567890}",
  "[o-b]{1,3}",
  "[a-z ]{1,9}",
  '[a-z"]{1,9}',
  "[a-z\\]{1,9}",
  "[a-z\t]{1,9}",
  "[a-zé]{1,9}",
  "[a-z]{0,9}",
  "[a-z]{9,1}",
  "[a-z]{1,9}x",
  "x[a-z]{1,9}",
  "[a-z[]{1,9}",
  "[a-z]{1}",
  "[a-z]{1,}",
  "[a-z]{,9}",
  "[]{1,9}",
  "[a-z]+",
  "[a-z]{1,9}{1,9}",
]) {
  cases.push(readsTable(`the format ${JSON.stringify(f)}`, formatted(f), false));
}

// --- Reading the card's state -----------------------------------------------

const readsState = (name: string, card_state: unknown, readable: boolean): Case => ({
  name: `the state: ${name}`,
  platforms: PRODUCTION,
  card_state,
  today: TODAY,
  accounts: [],
  result: readable ? valid([], [row("threads", "withdraw", "bob", "bob")]) : { unread: "card_state" },
});
const bob = (o: Partial<Slot> | Record<string, unknown>) => ({ ...BOB, ...o });
const without = (o: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const base = state({ threads: BOB });
cases.push(
  readsState("fields it does not know are ignored, in the answer and in an entry", { ...state({ threads: { ...BOB, next: 2 } }), head: "x" }, true),
  readsState("without last_card_proof", without(base, "last_card_proof"), false),
  readsState("without proofs_on_last_date", without(base, "proofs_on_last_date"), false),
  readsState("without platforms", without(base, "platforms"), false),
  readsState("without count", without(base, "count"), false),
  readsState("a negative count", { ...base, count: -1 }, false),
  readsState("a count of 2^53 - 1", { ...base, count: 2 ** 53 - 1 }, true),
  readsState("a count of 2^53", { ...base, count: 2 ** 53 }, false),
  readsState("proofs_on_last_date 1 without a last card proof", state({ threads: EMPTY }, null, 1), false),
  readsState("a date that does not exist", state({ threads: BOB }, "2026-02-30"), false),
  readsState("a count with a fraction", { ...base, count: 1.5 }, false),
  readsState("proofs_on_last_date with a fraction", { ...base, proofs_on_last_date: 1.5 }, false),
  readsState("proofs_on_last_date a string", { ...base, proofs_on_last_date: "1" }, false),
  readsState("proofs_on_last_date 0 with a last card proof", { ...base, proofs_on_last_date: 0 }, false),
  readsState("proofs_on_last_date 4, more than daily_limit: the server's count is read as it is", { ...base, proofs_on_last_date: 4 }, true),
  readsState("without daily_limit", without(base, "daily_limit"), false),
  readsState("daily_limit a string", { ...base, daily_limit: "3" }, false),
  readsState("daily_limit -1", { ...base, daily_limit: -1 }, false),
  readsState("daily_limit with a fraction", { ...base, daily_limit: 2.5 }, false),
  readsState("daily_limit null", { ...base, daily_limit: null }, false),
  readsState("a last card proof 4 days after today", state({ threads: BOB }, "2026-11-20"), false),
  readsState("a date not in its one spelling", state({ threads: BOB }, "2026-11-4"), false),
  readsState("a date before 2000", state({ threads: BOB }, "1999-12-31"), false),
  readsState("an account but no last card proof", state({ threads: BOB }, null, 1), false),
  readsState("switch_count 6", state({ threads: bob({ switch_count: 6 }) }), false),
  readsState("switch_count -1", state({ threads: bob({ switch_count: -1 }) }), false),
  readsState("switch_count missing", state({ threads: without(BOB, "switch_count") }), false),
  readsState("current missing", state({ threads: without(BOB, "current") }), false),
  readsState("last_declared missing", state({ threads: without(BOB, "last_declared") }), false),
  readsState("a correction_date, a field of an earlier version, is ignored", state({ threads: { ...BOB, correction_date: "2026-03-02" } }), true),
  readsState("current outside the platform's format", state({ threads: bob({ current: "Bob", last_declared: "Bob" }) }), false),
  readsState("current not last_declared", state({ threads: bob({ current: "carol" }) }), false),
  readsState("switches without an account ever declared", state({ threads: { ...EMPTY, switch_count: 1 } }, null), false),
  readsState("an entry that is not an object", state({ threads: [] }), false),
  readsState("platforms not an object", { ...base, platforms: [] }, false),
  readsState("not an object", [], false),
  readsState("a platform it does not know, not a platform ID", state({ threads: BOB, Example: { current: "bob" } }), false),
  readsState("a platform it does not know, an account no platform allows", state({ threads: BOB, example: { current: 'a"b' } }), false),
  readsState("a platform it does not know, an empty account", state({ threads: BOB, example: { current: "" } }), false),
  readsState("a platform it does not know, without current", state({ threads: BOB, example: { last_declared: null } }), false),
  readsState("a platform it does not know, not an object", state({ threads: BOB, example: "bob" }), false),
  readsState("a platform it does not know, an account but no last card proof", state({ threads: EMPTY, example: { current: "bob" } }, null), false),
  readsState("a platform it does not know with no account: passed over, whatever its ID", state({ threads: BOB, Example: { current: null } }), true),
);

const names = new Set<string>();
for (const c of cases) {
  assert.ok(!names.has(c.name), `two cases named ${c.name}`);
  names.add(c.name);
  c.known_platforms ??= ["test-example", "threads"];
  const { name, result, known_platforms, ...rest } = c;
  assert.deepEqual(await listConsequenceResult({ ...rest, known_platforms }), result, name);
}

const file = {
  spec: "list-consequence",
  status: "draft",
  note: "Each case: `platforms` is the `platforms` of GET /api/v1/config and `card_state` the answer of POST /api/v1/card-state, as the server sent them; `known_platforms` the platforms the device has its own definition of; `today` the device's date in Taiwan; `accounts` the cardholder's list for the platforms offered. `result` is one of: `unread` (which answer the device cannot read); `not_offered` (the list names a platform that is not offered: a mistake of the program, not of the cardholder); `valid: false` with `reason` (`empty`, `switch_limit` with `platform`, `daily_limit` when the server writes no more records of the card today, or `username` with `platform`); `valid: true` with the list the card signs, a row per platform the list does something on, and `first_record`. null means none.",
  generated_by: "web/test/generate/list-consequence.ts",
  cases: cases.map(({ name, platforms, card_state, known_platforms, today, accounts, result }) => ({ name, platforms, card_state, known_platforms, today, accounts, result })),
};
writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
console.log(`${cases.length} cases written to spec/vectors/list-consequence.json`);
