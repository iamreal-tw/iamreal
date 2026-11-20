// A measurement, not a test (`pnpm test` runs test/*.test.ts only): the
// daily publication of a roster whose card state table has many cards, in
// the local workerd (#183; README.md, "大小的上限"). It fills the table of
// the test roster's object with made-up cards through the test build's door,
// then times, from here:
//
//   - copying the card state table to its snapshot, and dropping it, alone
//     (each three times);
//   - the whole publication at midnight, the alarm's run;
//   - the longest a request to the object waited during the publication:
//     one is sent every 10 ms, the next once the one before is answered.
//
// and checks that the card state file in the bucket is, byte for byte, the
// file protocol/'s `cardStateFile` writes for the same cards at once.
//
//   node --experimental-strip-types test/publication-size.ts [cards]
//
// `cards` is 200,000 if not given. A card is a row of the table only: the
// roster has no record, so the publication writes no roster file.
import assert from "node:assert/strict";
import { type CardRow, cardStateFile } from "iamreal-protocol/card-state-file.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import type { SlotState } from "iamreal-protocol/roster-rules.ts";
import { type CardToWrite, startWorker } from "./harness.ts";
import { TEST_SCOPE, cardState, freshRoster, newCard, tw } from "./records.ts";

const count = Number(process.argv[2] ?? 200_000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("the number of cards is a positive integer");

/** A made-up card: every third has a slot on both platforms, every seventh withdrew its Threads account, switches 0 to 5. */
function cardOf(i: number): { door: CardToWrite; row: CardRow } {
  const scopedId = newCard();
  const slots: [string, SlotState][] = [["threads", { current: i % 7 === 0 ? null : `user.${i}`, lastDeclared: `user.${i}`, switchCount: i % 6, correctionDate: null }]];
  if (i % 3 === 0) slots.push(["test-example", { current: `user-${i}`, lastDeclared: `user-${i}`, switchCount: 0, correctionDate: parseDay("2026-11-19") }]);
  const json = Object.fromEntries(slots.map(([p, s]) => [p, { current: s.current, last_declared: s.lastDeclared, switch_count: s.switchCount, correction_date: s.correctionDate === null ? null : "2026-11-19" }]));
  return {
    door: { scope_string: TEST_SCOPE, scoped_id: scopedId, seq: i + 1, last_card_proof: "2026-11-20", proofs_on_last_date: 1, platforms: json },
    row: { scopeString: TEST_SCOPE, scopedId, lastSeq: i + 1, card: { lastCardProof: parseDay("2026-11-20"), proofsOnLastDate: 1, slots: new Map(slots) } },
  };
}

const ms = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;
const worker = await startWorker();
try {
  await freshRoster(worker);
  await cardState(worker, newCard()); // the object starts on the date before the one it is published on

  const rows: CardRow[] = [];
  let start = process.hrtime.bigint();
  for (let i = 0; i < count; ) {
    const batch: CardToWrite[] = [];
    for (; batch.length < 5000 && i < count; i++) {
      const { door, row } = cardOf(i);
      batch.push(door);
      rows.push(row);
    }
    await worker.roster.writeCards(batch);
  }
  console.log(`${count} cards written to the card state table in ${ms(start).toFixed(0)} ms`);

  const tables = await worker.roster.tables();
  for (let run = 1; run <= 3; run++) {
    start = process.hrtime.bigint();
    await worker.roster.snapshot(false);
    const copied = ms(start);
    start = process.hrtime.bigint();
    await worker.roster.snapshot(true);
    console.log(`snapshot, run ${run}: copied in ${copied.toFixed(0)} ms, dropped in ${ms(start).toFixed(0)} ms`);
  }

  await worker.setClock(tw("2026-11-21", "00:00:00"));
  let publishing = true;
  let longest = 0;
  const asking = (async () => {
    while (publishing) {
      const asked = process.hrtime.bigint();
      await worker.roster.kept();
      longest = Math.max(longest, ms(asked));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  start = process.hrtime.bigint();
  await worker.roster.runAlarm();
  const published = ms(start);
  publishing = false;
  await asking;
 console.log(`published in ${published.toFixed(0)} ms; the longest a request to the object waited meanwhile: ${longest.toFixed(0)} ms`);

  const files = await worker.files("roster/");
  assert.deepEqual(
    files.map((f) => f.key),
    ["roster/card-state/2026-11-21.jsonl", "roster/fingerprints.jsonl"],
  );
  const expected = new TextEncoder().encode(cardStateFile("test", rows));
  const written = files[0]!.bytes;
  assert.equal(written.length, expected.length, "the length of the card state file");
  assert.ok(Buffer.from(written).equals(Buffer.from(expected)), "the card state file is the one cardStateFile writes");
  assert.deepEqual(await worker.roster.tables(), tables, "no snapshot is left");
  console.log(`the card state file (${written.length} bytes) is, byte for byte, the one cardStateFile writes for the same cards`);
} finally {
  await worker.close();
}
