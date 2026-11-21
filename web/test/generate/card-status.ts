// Writes spec/vectors/card-status.json. Run from web/:
//
//   node --experimental-strip-types test/generate/card-status.ts
//
// The result of every case is written here by hand; if web/'s code
// (test/card-status.ts) gives a different one, this stops and writes
// nothing.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { type CardStatusCase, type CardStatusResult, type StatusRow, cardStatusResult } from "../card-status.ts";

const out = new URL("../../../spec/vectors/card-status.json", import.meta.url);

interface Case extends Omit<CardStatusCase, "known_platforms" | "today"> {
  name: string;
  /** 2026-11-16 unless the case says otherwise. */
  today?: string;
  /** Both platforms of spec/scope.md unless the case says otherwise. */
  known_platforms?: string[];
  result: CardStatusResult;
}

const THREADS = { platform: "threads", display_name: "Threads", username_format: "[a-z0-9._]{1,30}" };
const EXAMPLE = { platform: "test-example", display_name: "Example (no real service)", username_format: "[a-z0-9-]{1,20}" };
const PRODUCTION = [THREADS];
const TEST = [EXAMPLE, THREADS];
const TODAY = "2026-11-16";

type Slot = { current: string | null; last_declared: string | null; switch_count: number; correction_date: string | null };
const EMPTY: Slot = { current: null, last_declared: null, switch_count: 0, correction_date: null };
const slot = (current: string | null, lastDeclared: string | null, switchCount: number, correctionDate: string | null): Slot => ({ current, last_declared: lastDeclared, switch_count: switchCount, correction_date: correctionDate });
const state = (platforms: Record<string, unknown>, lastCardProof: string | null, proofsOnLastDate = lastCardProof === null ? 0 : 1) => ({ last_card_proof: lastCardProof, proofs_on_last_date: proofsOnLastDate, platforms, count: 137 });
const row = (platform: string, current: string | null, lastDeclared: string | null, switchCount: number, switchesLeft: number, correctionToday = false): StatusRow => ({
  platform,
  known: true,
  current,
  last_declared: lastDeclared,
  switch_count: switchCount,
  switches_left: switchesLeft,
  correction_today: correctionToday,
});
const kept = (platform: string, current: string): StatusRow => ({ platform, known: false, current });

const CASES: Case[] = [
  {
    name: "a card without a record",
    platforms: PRODUCTION,
    card_state: state({ threads: EMPTY }, null),
    result: { last_card_proof: null, days_since: null, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", null, null, 0, 5)] },
  },
  {
    name: "an account declared 12 days ago, never switched",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("alice", "alice", 0, "2026-11-04") }, "2026-11-04"),
    result: { last_card_proof: "2026-11-04", days_since: 12, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", "alice", "alice", 0, 5)] },
  },
  {
    name: "one switch used: four left",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("bob", "bob", 1, "2026-03-02") }, "2026-11-04"),
    result: { last_card_proof: "2026-11-04", days_since: 12, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", "bob", "bob", 1, 4)] },
  },
  {
    name: "an account put there today: a change today is a correction",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("alice", "alice", 0, TODAY) }, TODAY),
    result: { last_card_proof: TODAY, days_since: 0, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", "alice", "alice", 0, 5, true)] },
  },
  {
    name: "the same state a day later: no longer a correction",
    today: "2026-11-17",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("alice", "alice", 0, TODAY) }, TODAY),
    result: { last_card_proof: TODAY, days_since: 1, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", "alice", "alice", 0, 5)] },
  },
  {
    name: "withdrawn: the account last declared stays",
    platforms: PRODUCTION,
    card_state: state({ threads: slot(null, "bob", 2, "2026-03-02") }, "2026-11-04"),
    result: { last_card_proof: "2026-11-04", days_since: 12, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", null, "bob", 2, 3)] },
  },
  {
    name: "five switches used: none left",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("bob", "bob", 5, "2026-03-02") }, "2026-11-04"),
    result: { last_card_proof: "2026-11-04", days_since: 12, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", "bob", "bob", 5, 0)] },
  },
  {
    name: "three records today: the daily limit",
    platforms: PRODUCTION,
    card_state: state({ threads: slot(null, "bob", 5, TODAY) }, TODAY, 3),
    result: { last_card_proof: TODAY, days_since: 0, daily_limit: true, known_platforms: ["threads"], rows: [row("threads", null, "bob", 5, 0, true)] },
  },
  {
    name: "two records today: not the daily limit",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("alice", "alice", 0, TODAY) }, TODAY, 2),
    result: { last_card_proof: TODAY, days_since: 0, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", "alice", "alice", 0, 5, true)] },
  },
  {
    name: "three records on an earlier date: not today's limit",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("alice", "alice", 0, "2026-11-04") }, "2026-11-15", 3),
    result: { last_card_proof: "2026-11-15", days_since: 1, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", "alice", "alice", 0, 5)] },
  },
  {
    name: "a record dated tomorrow by the server's clock: minus one day",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("alice", "alice", 0, "2026-11-17") }, "2026-11-17"),
    result: { last_card_proof: "2026-11-17", days_since: -1, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", "alice", "alice", 0, 5)] },
  },
  {
    name: "two platforms the device knows, in ascending order",
    platforms: TEST,
    card_state: state({ threads: slot("alice", "alice", 0, "2026-11-04"), "test-example": EMPTY }, "2026-11-04"),
    result: {
      last_card_proof: "2026-11-04",
      days_since: 12,
      daily_limit: false,
      known_platforms: ["test-example", "threads"],
      rows: [row("test-example", null, null, 0, 5), row("threads", "alice", "alice", 0, 5)],
    },
  },
  {
    name: "an account on a platform the device has no definition of is kept, shown as it is",
    platforms: TEST,
    known_platforms: ["threads"],
    card_state: state({ threads: slot("alice", "alice", 1, "2026-03-02"), "test-example": slot("alice-b", "alice-b", 3, "2026-03-02") }, "2026-11-04"),
    result: {
      last_card_proof: "2026-11-04",
      days_since: 12,
      daily_limit: false,
      known_platforms: ["threads"],
      rows: [kept("test-example", "alice-b"), row("threads", "alice", "alice", 1, 4)],
    },
  },
  {
    name: "a platform the device does not know, without an account, has no row",
    platforms: TEST,
    known_platforms: ["threads"],
    card_state: state({ threads: EMPTY, "test-example": EMPTY }, null),
    result: { last_card_proof: null, days_since: null, daily_limit: false, known_platforms: ["threads"], rows: [row("threads", null, null, 0, 5)] },
  },
  {
    name: "a platform the device knows without an entry in the state is not offered, but is a platform of the table",
    platforms: TEST,
    card_state: state({ threads: EMPTY }, null),
    result: { last_card_proof: null, days_since: null, daily_limit: false, known_platforms: ["test-example", "threads"], rows: [row("threads", null, null, 0, 5)] },
  },
  {
    name: "a table that cannot be read",
    platforms: { threads: THREADS },
    card_state: state({ threads: EMPTY }, null),
    result: { unread: "platforms" },
  },
  {
    name: "a state that cannot be read: six switches",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("bob", "bob", 6, "2026-03-02") }, "2026-11-04"),
    result: { unread: "card_state" },
  },
  {
    name: "a state that cannot be read: four records on the last date",
    platforms: PRODUCTION,
    card_state: state({ threads: slot("bob", "bob", 1, "2026-03-02") }, TODAY, 4),
    result: { unread: "card_state" },
  },
];

const cases = [];
for (const c of CASES) {
  const input = { platforms: c.platforms, card_state: c.card_state, known_platforms: c.known_platforms ?? ["test-example", "threads"], today: c.today ?? TODAY };
  assert.deepEqual(await cardStatusResult(input), c.result, c.name);
  cases.push({ name: c.name, ...input, result: c.result });
}
assert.equal(new Set(cases.map((c) => c.name)).size, cases.length, "every case has its own name");

writeFileSync(
  out,
  JSON.stringify(
    {
      spec: "list-consequence",
      status: "draft",
      note: "The card's state as the screen of its accounts shows it (list-consequence.md, \"The card's state, as shown\"). Each case has the two answers as the server sent them, the platforms the device has its own definition of, and today's date in Taiwan. How the answers are read, and every way one cannot be read, is in list-consequence.json.",
      generated_by: "web/test/generate/card-status.ts",
      cases,
    },
    null,
    2,
  ) + "\n",
);
console.log(`${cases.length} cases written to spec/vectors/card-status.json`);
