// Writes spec/vectors/records-response.json. Run from web/:
//
//   node --experimental-strip-types test/generate/records-response.ts
//
// The result of every case is written here by hand; if web/'s code
// (test/records-response.ts) gives a different one, this stops and writes
// nothing.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { type RecordsResponseResult, type ShownRow, recordsResponseResult } from "../records-response.ts";

const out = new URL("../../../spec/vectors/records-response.json", import.meta.url);

interface Case {
  name: string;
  /** The body's text, or a value to write as JSON. */
  body: string | Record<string, unknown> | unknown[];
  /** What the confirmation screen showed; a first declaration of alice on threads unless the case says otherwise. */
  rows?: (ShownRow & Record<string, unknown>)[];
  result: RecordsResponseResult;
}

const HASH = "3f".repeat(32);
type Kind = { platform: string; kind: string; username: string; account_cards: number | null };
const kind = (platform: string, k: string, username: string, accountCards: number | null = 1): Kind => ({ platform, kind: k, username, account_cards: accountCards });
const shown = (platform: string, k: ShownRow["kind"], username: string): ShownRow => ({ platform, kind: k, username });

const FIRST = [kind("threads", "first", "alice")];
const SHOWN_FIRST = [shown("threads", "first", "alice")];
const answer = (kinds: unknown, more: Record<string, unknown> = {}) => ({ seq: 138, record_hash: HASH, ordinal: 42, kinds, ...more });

/** The answer is read: `seq`, `record_hash`, the ordinal 42 and these kinds. */
const read = (kinds: Kind[] | null, mismatches: string[] = [], seq = 138, ordinal: number | null = 42): RecordsResponseResult => ({ seq, record_hash: HASH, ordinal, kinds, mismatches });
/** The answer is read, the ordinal not. */
const noOrdinal = (kinds: Kind[] | null = FIRST): RecordsResponseResult => read(kinds, [], 138, null);
/** Nothing of the answer is told. */
const NOTHING: RecordsResponseResult = { seq: null, record_hash: null, ordinal: null, kinds: null, mismatches: [] };

// The card's state said threads' account was put there today (a change is a
// correction) and test-example's was not touched.
const SHOWN_TWO = [shown("test-example", "refresh", "a-b"), shown("threads", "correction", "bob")];
const TWO = [kind("test-example", "refresh", "a-b"), kind("threads", "correction", "bob")];

const CASES: Case[] = [
  // --- An answer that is read, the same as the screen said ----------------
  { name: "the example of docs/api/card-proof.md: a first declaration", body: answer(FIRST), result: read(FIRST) },
  { name: "two platforms, in ascending order", body: answer(TWO), rows: SHOWN_TWO, result: read(TWO) },
  {
    name: "every kind",
    body: answer([kind("a", "first", "u1"), kind("b", "refresh", "u2"), kind("c", "correction", "u3"), kind("d", "switch", "u4"), kind("e", "withdraw", "u5", 0)]),
    rows: [shown("a", "first", "u1"), shown("b", "refresh", "u2"), shown("c", "correction", "u3"), shown("d", "switch", "u4"), shown("e", "withdraw", "u5")],
    result: read([kind("a", "first", "u1"), kind("b", "refresh", "u2"), kind("c", "correction", "u3"), kind("d", "switch", "u4"), kind("e", "withdraw", "u5", 0)]),
  },
  {
    name: "a withdrawal: the account withdrawn, which no card declares after it",
    body: answer([kind("threads", "withdraw", "alice", 0)]),
    rows: [shown("threads", "withdraw", "alice")],
    result: read([kind("threads", "withdraw", "alice", 0)]),
  },
  { name: "other cards declare the account too", body: answer([kind("threads", "first", "alice", 3)]), result: read([kind("threads", "first", "alice", 3)]) },
  {
    name: "the rows as the confirmation screen had them: their other fields are not compared",
    body: answer([kind("threads", "switch", "carol")]),
    rows: [{ platform: "threads", known: true, kind: "switch", username: "carol", current: "bob", previous: "bob", switches_left: 3 }],
    result: read([kind("threads", "switch", "carol")]),
  },
  {
    name: "fields the device does not know are ignored, in the answer and in an element",
    body: answer([{ ...kind("threads", "first", "alice"), note: "x" }], { more: [1, 2] }),
    result: read(FIRST),
  },
  { name: "the keys in another order, whitespace between the tokens", body: ` {\n "kinds" : [ { "username" : "alice", "account_cards" : 1, "kind" : "first", "platform" : "threads" } ],\n "ordinal" : 42 , "record_hash" : "${HASH}", "seq" : 138 }\n`, result: read(FIRST) },
  { name: "numbers are read by their value: 138.0, 4.2e1 and 1e0", body: `{"seq":138.0,"record_hash":"${HASH}","ordinal":4.2e1,"kinds":[{"platform":"threads","kind":"first","username":"alice","account_cards":1e0}]}`, result: read(FIRST) },
  { name: "the first record of a proof log: seq 1, ordinal 1", body: answer(FIRST, { seq: 1, ordinal: 1 }), result: read(FIRST, [], 1, 1) },
  { name: "the largest seq read", body: answer(FIRST, { seq: 9007199254740991 }), result: read(FIRST, [], 9007199254740991) },
  { name: "the largest ordinal read", body: answer(FIRST, { ordinal: 9007199254740991 }), result: read(FIRST, [], 138, 9007199254740991) },
  { name: "an ordinal above seq is read as it is: the device does not check it", body: answer(FIRST, { ordinal: 139 }), result: read(FIRST, [], 138, 139) },
  {
    name: "an account on a platform the device does not know: any username every format allows",
    body: answer([kind("example", "refresh", "Bob Example!")]),
    rows: [shown("example", "refresh", "Bob Example!")],
    result: read([kind("example", "refresh", "Bob Example!")]),
  },
  {
    name: "a platform ID of 21 characters, and a username with the last printable character",
    body: answer([kind("a".repeat(21), "first", "~alice~")]),
    rows: [shown("a".repeat(21), "first", "~alice~")],
    result: read([kind("a".repeat(21), "first", "~alice~")]),
  },

  // --- Nothing of the answer is told --------------------------------------
  { name: "nothing told: an empty body", body: "", result: NOTHING },
  { name: "nothing told: not JSON", body: "<html>201 Created</html>", result: NOTHING },
  { name: "nothing told: JSON cut short", body: `{"seq":138,"record_hash":"${HASH}","kinds":[`, result: NOTHING },
  { name: "nothing told: something after the value", body: JSON.stringify(answer(FIRST)) + "{}", result: NOTHING },
  { name: "nothing told: an array", body: [answer(FIRST)], result: NOTHING },
  { name: "nothing told: a string", body: '"created"', result: NOTHING },
  { name: "nothing told: null", body: "null", result: NOTHING },
  { name: "nothing told: no seq", body: { record_hash: HASH, kinds: FIRST }, result: NOTHING },
  { name: "nothing told: seq 0", body: answer(FIRST, { seq: 0 }), result: NOTHING },
  { name: "nothing told: a negative seq", body: answer(FIRST, { seq: -1 }), result: NOTHING },
  { name: "nothing told: a seq with a fraction", body: answer(FIRST, { seq: 138.5 }), result: NOTHING },
  { name: "nothing told: a seq in a string", body: answer(FIRST, { seq: "138" }), result: NOTHING },
  { name: "nothing told: seq null", body: answer(FIRST, { seq: null }), result: NOTHING },
  { name: "nothing told: a seq of 2^53", body: `{"seq":9007199254740992,"record_hash":"${HASH}","kinds":${JSON.stringify(FIRST)}}`, result: NOTHING },
  { name: "nothing told: no record_hash", body: { seq: 138, kinds: FIRST }, result: NOTHING },
  { name: "nothing told: a record_hash in capitals", body: answer(FIRST, { record_hash: "3F".repeat(32) }), result: NOTHING },
  { name: "nothing told: a record_hash of 63 characters", body: answer(FIRST, { record_hash: HASH.slice(1) }), result: NOTHING },
  { name: "nothing told: a record_hash of 65 characters", body: answer(FIRST, { record_hash: HASH + "3" }), result: NOTHING },
  { name: "nothing told: a record_hash not in hex", body: answer(FIRST, { record_hash: "g".repeat(64) }), result: NOTHING },
  { name: "nothing told: a record_hash with 0x", body: answer(FIRST, { record_hash: "0x" + HASH.slice(2) }), result: NOTHING },
  { name: "nothing told: a record_hash that is a number", body: answer(FIRST, { record_hash: 3 }), result: NOTHING },
  { name: "nothing told, and nothing compared: the screen's rows would differ from these kinds", body: { record_hash: HASH, ordinal: 42, kinds: [kind("threads", "switch", "bob")] }, result: NOTHING },
  { name: "nothing told, not even an ordinal that could be read", body: answer(FIRST, { seq: 0 }), result: NOTHING },

  // --- seq and record_hash read, the kinds not ----------------------------
  { name: "kinds not read: none", body: { seq: 138, record_hash: HASH, ordinal: 42 }, result: read(null) },
  { name: "kinds not read: null", body: answer(null), result: read(null) },
  { name: "kinds not read: an empty list", body: answer([]), result: read(null) },
  { name: "kinds not read: an object", body: answer({ threads: "first" }), result: read(null) },
  { name: "kinds not read: an element that is not an object", body: answer(["first"]), result: read(null) },
  { name: "kinds not read: an element that is null, after one that is read", body: answer([kind("test-example", "refresh", "a-b"), null]), rows: SHOWN_TWO, result: read(null) },
  { name: "kinds not read: no platform", body: answer([{ kind: "first", username: "alice", account_cards: 1 }]), result: read(null) },
  { name: "kinds not read: a platform that is not an ID (a capital)", body: answer([kind("Threads", "first", "alice")]), result: read(null) },
  { name: "kinds not read: a platform of 22 characters", body: answer([kind("a".repeat(22), "first", "alice")]), result: read(null) },
  { name: "kinds not read: an empty platform", body: answer([kind("", "first", "alice")]), result: read(null) },
  { name: "kinds not read: a kind the device does not know", body: answer([kind("threads", "declare", "alice")]), result: read(null) },
  { name: "kinds not read: a kind in capitals", body: answer([kind("threads", "First", "alice")]), result: read(null) },
  { name: "kinds not read: a kind that is not a string", body: answer([{ platform: "threads", kind: 1, username: "alice", account_cards: 1 }]), result: read(null) },
  { name: "kinds not read: no kind", body: answer([{ platform: "threads", username: "alice", account_cards: 1 }]), result: read(null) },
  { name: "kinds not read: no username", body: answer([{ platform: "threads", kind: "first", account_cards: 1 }]), result: read(null) },
  { name: "kinds not read: an empty username", body: answer([kind("threads", "first", "")]), result: read(null) },
  { name: "kinds not read: a username with a quotation mark", body: answer([kind("threads", "first", 'al"ice')]), result: read(null) },
  { name: "kinds not read: a username with a backslash", body: answer([kind("threads", "first", "al\\ice")]), result: read(null) },
  { name: "kinds not read: a username with a line break", body: answer([kind("threads", "first", "alice\n")]), result: read(null) },
  { name: "kinds not read: a username with U+007F", body: answer([kind("threads", "first", "alice\u007f")]), result: read(null) },
  { name: "kinds not read: a username beyond ASCII", body: answer([kind("threads", "first", "alicé")]), result: read(null) },
  { name: "kinds not read: a username that is null", body: answer([{ platform: "threads", kind: "withdraw", username: null, account_cards: 0 }]), result: read(null) },
  { name: "kinds not read: the platforms in descending order", body: answer([TWO[1], TWO[0]]), rows: SHOWN_TWO, result: read(null) },
  { name: "kinds not read: a platform twice", body: answer([kind("threads", "first", "alice"), kind("threads", "first", "alice")]), result: read(null) },
  { name: "kinds not read, and nothing compared: the screen's rows would differ from these kinds", body: answer([kind("threads", "switch", "bob"), "x"]), result: read(null) },

  // --- An ordinal that is not a count of at least 1: that number alone is not known ---
  { name: "ordinal not known: none", body: { seq: 138, record_hash: HASH, kinds: FIRST }, result: noOrdinal() },
  { name: "ordinal not known: null", body: answer(FIRST, { ordinal: null }), result: noOrdinal() },
  { name: "ordinal not known: 0", body: answer(FIRST, { ordinal: 0 }), result: noOrdinal() },
  { name: "ordinal not known: negative", body: answer(FIRST, { ordinal: -42 }), result: noOrdinal() },
  { name: "ordinal not known: with a fraction", body: answer(FIRST, { ordinal: 42.5 }), result: noOrdinal() },
  { name: "ordinal not known: in a string", body: answer(FIRST, { ordinal: "42" }), result: noOrdinal() },
  { name: "ordinal not known: true", body: answer(FIRST, { ordinal: true }), result: noOrdinal() },
  { name: "ordinal not known: an array", body: answer(FIRST, { ordinal: [42] }), result: noOrdinal() },
  { name: "ordinal not known: 2^53", body: `{"seq":138,"record_hash":"${HASH}","ordinal":9007199254740992,"kinds":${JSON.stringify(FIRST)}}`, result: noOrdinal() },
  { name: "ordinal not known, and the kinds not read: seq and record_hash still told", body: answer([], { ordinal: "42" }), result: noOrdinal(null) },
  {
    name: "ordinal not known: what the screen said is still compared",
    body: answer([TWO[0], kind("threads", "switch", "bob")], { ordinal: -1 }),
    rows: SHOWN_TWO,
    result: { ...read([TWO[0]!, kind("threads", "switch", "bob")], ["threads"]), ordinal: null },
  },

  // --- account_cards that is not a count: that number alone is not known ---
  { name: "account_cards not known: none", body: answer([{ platform: "threads", kind: "first", username: "alice" }]), result: read([kind("threads", "first", "alice", null)]) },
  { name: "account_cards not known: null", body: answer([kind("threads", "first", "alice", null)]), result: read([kind("threads", "first", "alice", null)]) },
  { name: "account_cards not known: in a string", body: answer([{ ...FIRST[0], account_cards: "2" }]), result: read([kind("threads", "first", "alice", null)]) },
  { name: "account_cards not known: negative", body: answer([kind("threads", "first", "alice", -1)]), result: read([kind("threads", "first", "alice", null)]) },
  { name: "account_cards not known: with a fraction", body: answer([kind("threads", "first", "alice", 1.5)]), result: read([kind("threads", "first", "alice", null)]) },
  { name: "account_cards not known: true", body: answer([{ ...FIRST[0], account_cards: true }]), result: read([kind("threads", "first", "alice", null)]) },
  { name: "account_cards not known: 2^53", body: `{"seq":138,"record_hash":"${HASH}","ordinal":42,"kinds":[{"platform":"threads","kind":"first","username":"alice","account_cards":9007199254740992}]}`, result: read([kind("threads", "first", "alice", null)]) },
  {
    name: "account_cards not known on one platform: the other's is read",
    body: answer([kind("test-example", "refresh", "a-b", 2), { platform: "threads", kind: "correction", username: "bob" }]),
    rows: SHOWN_TWO,
    result: read([kind("test-example", "refresh", "a-b", 2), kind("threads", "correction", "bob", null)]),
  },

  // --- Where the answer differs from what the screen said -----------------
  {
    name: "differs: a switch, where the screen said a correction",
    body: answer([TWO[0], kind("threads", "switch", "bob")]),
    rows: SHOWN_TWO,
    result: read([TWO[0]!, kind("threads", "switch", "bob")], ["threads"]),
  },
  {
    name: "differs: another account",
    body: answer([TWO[0], kind("threads", "correction", "carol")]),
    rows: SHOWN_TWO,
    result: read([TWO[0]!, kind("threads", "correction", "carol")], ["threads"]),
  },
  {
    name: "differs: the account in another case",
    body: answer([kind("example", "refresh", "bob example")]),
    rows: [shown("example", "refresh", "Bob Example")],
    result: read([kind("example", "refresh", "bob example")], ["example"]),
  },
  { name: "differs: a platform the screen showed is not in the answer", body: answer([TWO[1]]), rows: SHOWN_TWO, result: read([TWO[1]!], ["test-example"]) },
  {
    name: "differs: a platform the screen did not show",
    body: answer([...TWO, kind("x-new", "withdraw", "zed", 0)]),
    rows: SHOWN_TWO,
    result: read([...TWO, kind("x-new", "withdraw", "zed", 0)], ["x-new"]),
  },
  {
    name: "differs: a withdrawal, where the screen said the account stays",
    body: answer([kind("test-example", "withdraw", "a-b", 0), TWO[1]]),
    rows: SHOWN_TWO,
    result: read([kind("test-example", "withdraw", "a-b", 0), TWO[1]!], ["test-example"]),
  },
  {
    name: "differs on two platforms: both, in ascending order",
    body: answer([kind("test-example", "first", "a-b"), kind("threads", "switch", "bob")]),
    rows: SHOWN_TWO,
    result: read([kind("test-example", "first", "a-b"), kind("threads", "switch", "bob")], ["test-example", "threads"]),
  },
  {
    name: "differs: another platform altogether, each on one side only",
    body: answer([kind("test-example", "first", "alice")]),
    result: read([kind("test-example", "first", "alice")], ["test-example", "threads"]),
  },
  {
    name: "account_cards is not compared: only the kind and the account",
    body: answer([kind("threads", "first", "alice", 7)]),
    result: read([kind("threads", "first", "alice", 7)]),
  },
];

const cases = [];
for (const c of CASES) {
  const input = { body: typeof c.body === "string" ? c.body : JSON.stringify(c.body), rows: c.rows ?? SHOWN_FIRST };
  assert.deepEqual(await recordsResponseResult(input), c.result, c.name);
  cases.push({ name: c.name, ...input, result: c.result });
}
assert.equal(new Set(cases.map((c) => c.name)).size, cases.length, "every case has its own name");

writeFileSync(
  out,
  JSON.stringify(
    {
      spec: "records-response",
      status: "draft",
      note: "The answer to a submission (the 201 of POST /api/v1/records) as the device reads it, and where it differs from what the confirmation screen said. Each case has the body's text as the server sent it (body), the rows the confirmation screen showed (rows) and the result: seq, record_hash, ordinal, kinds and mismatches.",
      generated_by: "web/test/generate/records-response.ts",
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${cases.length} cases written to spec/vectors/records-response.json`);
