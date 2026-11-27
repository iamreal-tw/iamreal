// The card state file (spec/record-rules.md, "The card state file") against
// spec/vectors/card-state-file.json, the file the Go tests read.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type CardRow, cardStateFile, cardStateFileWriter, readCardStateFile } from "../src/card-state-file.ts";
import { parseDay } from "../src/date.ts";
import { platformsOf } from "../src/platforms.ts";
import { EMPTY_SLOT, RULES_VERSION, type SlotState } from "../src/record-rules.ts";
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
    slots: new Map(
      Object.entries(c.slots as Record<string, Json>).map(([p, s]): [string, SlotState] => [
        p,
        { current: s.current, lastDeclared: s.last_declared, switchCount: s.switch_count },
      ]),
    ),
  },
});

/** The bytes of a file of the vectors: the UTF-8 encoding of `content`, or the bytes `content_hex` spells. */
const bytesOf = (f: Json): Uint8Array => (f.content_hex === undefined ? new TextEncoder().encode(f.content) : Uint8Array.from(f.content_hex.match(/../g) ?? [], (h: string) => Number.parseInt(h, 16)));

const validFiles: Json[] = v.files.filter((f: Json) => f.valid);

describe("card-state-file.json: the version of the rules its files were computed by", () => {
  test("it is the version of record-rules.json and of this implementation", () => {
    assert.equal(v.spec, "card-state-file");
    assert.equal(v.rules_version, vectors("record-rules.json").rules_version);
    assert.equal(v.rules_version, RULES_VERSION);
  });
});

describe("card-state-file.json: writing", () => {
  for (const f of validFiles) {
    test(`${f.name} (${f.proof_log} log)`, () => {
      assert.equal(cardStateFile(f.proof_log, f.cards.map(rowOf)), f.content);
    });
  }

  test("the cards in any order, and with slots in the initial state, give the same file", () => {
    for (const f of validFiles) {
      const rows = f.cards.map(rowOf).reverse();
      for (const r of rows) {
        const slots = new Map(r.card.slots);
        for (const p of [...platformsOf(f.proof_log)].reverse()) if (!slots.has(p.platform)) slots.set(p.platform, { ...EMPTY_SLOT });
        (r.card as { slots: unknown }).slots = new Map([...slots].reverse());
      }
      assert.equal(cardStateFile(f.proof_log, rows), f.content, f.name);
    }
  });
});

describe("card-state-file.json: writing one row at a time", () => {
  for (const f of validFiles) {
    test(`${f.name} (${f.proof_log} log)`, () => {
      const write = cardStateFileWriter(f.proof_log);
      assert.equal(f.cards.map((c: Json) => write(rowOf(c))).join(""), f.content);
    });
  }

  test("each row is checked as it is written: one not in its format, or not after the row before, is refused", () => {
    const f = validFiles.find((k) => k.cards.length >= 2)!;
    const [first, second] = f.cards.map(rowOf) as [CardRow, CardRow];
    const writer = (): ((row: CardRow) => string) => cardStateFileWriter(f.proof_log);
    assert.throws(() => writer()({ ...first, lastSeq: 0 }), /^Error: card state file: last_seq of a card is not in its format$/);
    let write = writer();
    write(second);
    assert.throws(() => write(first), /^Error: card state file: a card is not after the card before it$/);
    write = writer();
    write(first);
    assert.throws(() => write(first), /^Error: card state file: a card is not after the card before it$/);
    // A row refused is not the row before: the next row is compared with the last one written.
    write = writer();
    write(first);
    assert.throws(() => write({ ...second, lastSeq: 0 }));
    assert.equal(write(second), f.content.split("\n")[1] + "\n");
  });
});

describe("card-state-file.json: reading", () => {
  for (const f of validFiles) {
    test(`${f.name} (${f.proof_log} log)`, () => {
      const read = readCardStateFile(f.proof_log, bytesOf(f));
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
    assert.deepEqual(readCardStateFile(f.proof_log, withMark), { valid: false, line: 1, code: "line" });
  });
  for (const f of broken) {
    test(`broken: ${f.name} (${f.proof_log} log)`, () => {
      assert.deepEqual(readCardStateFile(f.proof_log, bytesOf(f)), { valid: false, line: f.line, code: f.code });
    });
  }

  test("a file of one proof log is not a file of the other: the scope string is not accepted", () => {
    for (const f of validFiles.filter((f) => f.cards.length > 0)) {
      const other = f.proof_log === "production" ? "test" : "production";
      assert.deepEqual(readCardStateFile(other, bytesOf(f)), { valid: false, line: 1, code: "line" }, f.name);
    }
  });
});

describe("card-state-file.json: the files that are the final state of a case of record-rules.json", () => {
  const cases: Json[] = vectors("record-rules.json").cases;
  const linked = validFiles.filter((f) => f.record_rules_case !== undefined);
  test("there are such files, of both proof logs", () => {
    assert.ok(linked.some((f) => f.proof_log === "production") && linked.some((f) => f.proof_log === "test"));
  });
  for (const f of linked) {
    test(f.record_rules_case, () => {
      const c = cases.find((k) => k.name === f.record_rules_case)!;
      assert.equal(c.proof_log, f.proof_log);
      assert.equal(c.events.length, f.count);
      // The `seq` of each card's last valid result.
      const lastSeq = new Map<string, number>();
      c.events.forEach((e: Json, i: number) => {
        if (c.results[i].valid) lastSeq.set(`${e.scope_string} ${e.scoped_id}`, c.results[i].seq);
      });
      const initial = (s: Json): boolean => s.current === null && s.last_declared === null && s.switch_count === 0;
      const cards = c.state.flatMap((scope: Json) =>
        scope.cards.map((k: Json) => ({
          scope_string: scope.scope_string,
          scoped_id: k.scoped_id,
          last_seq: lastSeq.get(`${scope.scope_string} ${k.scoped_id}`),
          last_card_proof: k.last_card_proof,
          slots: Object.fromEntries(Object.entries(k.slots as Record<string, Json>).filter(([, s]) => !initial(s))),
        })),
      );
      assert.deepEqual(cards, f.cards);
    });
  }
});

describe("what is not written as a card state file", () => {
  const alice = (): Json => structuredClone(validFiles.find((f) => f.name === "one card, one slot")!.cards[0]);
  const refused = (change: (c: Json) => void, proofLog: "production" | "test" = "production"): void => {
    const c = alice();
    change(c);
    assert.throws(() => cardStateFile(proofLog, [rowOf(c)]), /^Error: card state file: /);
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
  test("a value that would not be a row of this proof log", () => {
    refused(() => {}, "test"); // the scope string of the production log
    refused((c) => (c.scoped_id = c.scoped_id.toLowerCase()));
    refused((c) => (c.last_seq = 0));
    refused((c) => (c.last_seq = 1.5));
    refused((c) => (c.last_seq = Number.MAX_SAFE_INTEGER + 1));
    refused((c) => (c.slots.threads.switch_count = -1));
    refused((c) => (c.slots.threads.switch_count = 0.5));
    refused((c) => (c.slots.threads.current = 'a"b'));
    refused((c) => (c.slots.threads.last_declared = "a-b")); // the format of test-example, not of threads
    refused((c) => (c.slots.threads.current = ""));
    refused((c) => (c.slots["test-example"] = c.slots.threads)); // not a platform of the production log
  });
  test("a date outside the years a date is written with", () => {
    const row = rowOf(alice());
    for (const d of [parseDay("2000-01-01")! - 1, parseDay("2049-12-31")! + 1, 0.5, Number.NaN]) {
      assert.throws(() => cardStateFile("production", [{ ...row, card: { ...row.card, lastCardProof: d } }]), /last_card_proof/);
    }
  });
});
