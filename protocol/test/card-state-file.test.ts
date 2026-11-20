// The card state file (spec/roster-rules.md, "The card state file") against
// spec/vectors/card-state-file.json, the file the Go tests read.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type CardRow, cardStateFile, readCardStateFile } from "../src/card-state-file.ts";
import { parseDay } from "../src/date.ts";
import { platformsOf } from "../src/platforms.ts";
import { EMPTY_SLOT, RULES_VERSION, type SlotState } from "../src/roster-rules.ts";
import { vectors } from "./vectors.ts";

const v = vectors("card-state-file.json");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** A card of the vectors, its keys as the specification spells them, as this implementation takes it. */
const rowOf = (c: Json): CardRow => ({
  scopeString: c.scope_string,
  scopedId: c.scoped_id,
  lastSeq: c.last_seq,
  card: {
    lastCardProof: parseDay(c.last_card_proof),
    proofsOnLastDate: c.proofs_on_last_date,
    slots: new Map(
      Object.entries(c.slots as Record<string, Json>).map(([p, s]): [string, SlotState] => [
        p,
        { current: s.current, lastDeclared: s.last_declared, switchCount: s.switch_count, correctionDate: s.correction_date === null ? null : parseDay(s.correction_date) },
      ]),
    ),
  },
});

/** The bytes of a file of the vectors: the UTF-8 encoding of `content`, or the bytes `content_hex` spells. */
const bytesOf = (f: Json): Uint8Array => (f.content_hex === undefined ? new TextEncoder().encode(f.content) : Uint8Array.from(f.content_hex.match(/../g) ?? [], (h: string) => Number.parseInt(h, 16)));

const validFiles: Json[] = v.files.filter((f: Json) => f.valid);

describe("card-state-file.json: the version of the rules its files were computed by", () => {
  test("it is the version of roster-rules.json and of this implementation", () => {
    assert.equal(v.spec, "card-state-file");
    assert.equal(v.rules_version, vectors("roster-rules.json").rules_version);
    assert.equal(v.rules_version, RULES_VERSION);
  });
});

describe("card-state-file.json: writing", () => {
  for (const f of validFiles) {
    test(`${f.name} (${f.roster} roster)`, () => {
      assert.equal(cardStateFile(f.roster, f.cards.map(rowOf)), f.content);
    });
  }

  test("the cards in any order, and with slots in the initial state, give the same file", () => {
    for (const f of validFiles) {
      const rows = f.cards.map(rowOf).reverse();
      for (const r of rows) {
        const slots = new Map(r.card.slots);
        for (const p of [...platformsOf(f.roster)].reverse()) if (!slots.has(p.platform)) slots.set(p.platform, { ...EMPTY_SLOT });
        (r.card as { slots: unknown }).slots = new Map([...slots].reverse());
      }
      assert.equal(cardStateFile(f.roster, rows), f.content, f.name);
    }
  });
});

describe("card-state-file.json: reading", () => {
  for (const f of validFiles) {
    test(`${f.name} (${f.roster} roster)`, () => {
      const read = readCardStateFile(f.roster, bytesOf(f));
      assert.deepEqual(read, { valid: true, rows: f.cards.map(rowOf) });
      // The slots come in ascending order of platform, as the row lists them.
      if (read.valid) for (const [i, r] of read.rows.entries()) assert.deepEqual([...r.card.slots.keys()], Object.keys(f.cards[i].slots));
    });
  }

  const broken: Json[] = v.files.filter((f: Json) => !f.valid);
  test("the vectors have broken files of both codes, and files that are not UTF-8", () => {
    assert.ok(broken.some((f) => f.code === "line") && broken.some((f) => f.code === "order"));
    assert.ok(broken.some((f) => f.content_hex !== undefined));
    for (const f of v.files) assert.equal(f.content === undefined, f.content_hex !== undefined, f.name);
  });
  test("a byte order mark is not dropped: the file as bytes, not as decoded text", () => {
    const f = validFiles.find((k) => k.name === "one card, one slot")!;
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf(f)]);
    // What a decoder gives for these bytes reads as the file without the mark.
    assert.equal(new TextDecoder().decode(withMark), f.content);
    assert.deepEqual(readCardStateFile(f.roster, withMark), { valid: false, line: 1, code: "line" });
  });
  for (const f of broken) {
    test(`broken: ${f.name} (${f.roster} roster)`, () => {
      assert.deepEqual(readCardStateFile(f.roster, bytesOf(f)), { valid: false, line: f.line, code: f.code });
    });
  }

  test("a file of one roster is not a file of the other: the scope string is not accepted", () => {
    for (const f of validFiles.filter((f) => f.cards.length > 0)) {
      const other = f.roster === "production" ? "test" : "production";
      assert.deepEqual(readCardStateFile(other, bytesOf(f)), { valid: false, line: 1, code: "line" }, f.name);
    }
  });
});

describe("card-state-file.json: the files that are the final state of a case of roster-rules.json", () => {
  const cases: Json[] = vectors("roster-rules.json").cases;
  const linked = validFiles.filter((f) => f.roster_rules_case !== undefined);
  test("there are such files, of both rosters", () => {
    assert.ok(linked.some((f) => f.roster === "production") && linked.some((f) => f.roster === "test"));
  });
  for (const f of linked) {
    test(f.roster_rules_case, () => {
      const c = cases.find((k) => k.name === f.roster_rules_case)!;
      assert.equal(c.roster, f.roster);
      assert.equal(c.events.length, f.count);
      // The `seq` of each card's last valid result.
      const lastSeq = new Map<string, number>();
      c.events.forEach((e: Json, i: number) => {
        if (c.results[i].valid) lastSeq.set(`${e.scope_string} ${e.scoped_id}`, c.results[i].seq);
      });
      const initial = (s: Json): boolean => s.current === null && s.last_declared === null && s.switch_count === 0 && s.correction_date === null;
      const cards = c.state.flatMap((scope: Json) =>
        scope.cards.map((k: Json) => ({
          scope_string: scope.scope_string,
          scoped_id: k.scoped_id,
          last_seq: lastSeq.get(`${scope.scope_string} ${k.scoped_id}`),
          last_card_proof: k.last_card_proof,
          proofs_on_last_date: k.proofs_on_last_date,
          slots: Object.fromEntries(Object.entries(k.slots as Record<string, Json>).filter(([, s]) => !initial(s))),
        })),
      );
      assert.deepEqual(cards, f.cards);
    });
  }
});

describe("what is not written as a card state file", () => {
  const alice = (): Json => structuredClone(validFiles.find((f) => f.name === "one card, one slot")!.cards[0]);
  const refused = (change: (c: Json) => void, roster: "production" | "test" = "production"): void => {
    const c = alice();
    change(c);
    assert.throws(() => cardStateFile(roster, [rowOf(c)]), /^Error: card state file: /);
  };

  test("the card it starts from is written", () => {
    assert.equal(cardStateFile("production", [rowOf(alice())]).split("\n").length, 2);
  });
  test("a card without a valid record: no last_card_proof", () => {
    const row = rowOf(alice());
    assert.throws(() => cardStateFile("production", [{ ...row, card: { ...row.card, lastCardProof: null } }]), /last_card_proof/);
  });
  test("a card given twice, with the same state or another", () => {
    const row = rowOf(alice());
    assert.throws(() => cardStateFile("production", [row, row]), /twice/);
    assert.throws(() => cardStateFile("production", [row, { ...row, lastSeq: 2 }]), /twice/);
  });
  test("a value that would not be a row of this roster", () => {
    refused(() => {}, "test"); // the scope string of the production roster
    refused((c) => (c.scoped_id = c.scoped_id.toLowerCase()));
    refused((c) => (c.last_seq = 0));
    refused((c) => (c.last_seq = 1.5));
    refused((c) => (c.last_seq = Number.MAX_SAFE_INTEGER + 1));
    refused((c) => (c.proofs_on_last_date = -1));
    refused((c) => (c.slots.threads.switch_count = -1));
    refused((c) => (c.slots.threads.switch_count = 0.5));
    refused((c) => (c.slots.threads.current = 'a"b'));
    refused((c) => (c.slots.threads.last_declared = "a-b")); // the format of test-example, not of threads
    refused((c) => (c.slots.threads.current = ""));
    refused((c) => (c.slots["test-example"] = c.slots.threads)); // not a platform of the production roster
  });
  test("a date outside the years a date is written with", () => {
    const row = rowOf(alice());
    const slot = row.card.slots.get("threads")!;
    for (const d of [parseDay("2000-01-01")! - 1, parseDay("2049-12-31")! + 1, 0.5, Number.NaN]) {
      assert.throws(() => cardStateFile("production", [{ ...row, card: { ...row.card, lastCardProof: d } }]), /last_card_proof/);
      assert.throws(() => cardStateFile("production", [{ ...row, card: { ...row.card, slots: new Map([["threads", { ...slot, correctionDate: d }]]) } }]), /slots/);
    }
  });
});
