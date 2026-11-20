// The card state table of the roster's Durable Object (roster.ts): the
// roster rules' state of every card that has a valid record, one row a card.
// Only the rules' state is here, nothing a page shows: it is read before and
// written after each call of the rules (protocol/src/roster-rules.ts), and a
// wrong row would accept records that cannot be taken back.
//
// The columns are the items of spec/roster-rules.md, "State", and one more:
//
//   last_card_proof, proofs_on_last_date   the card's own items
//   slots                                  the items of each slot, by platform
//   last_seq                               the `seq` of the card's last valid record
//
// `slots` is JSON, an object keyed by platform ID in ascending order, each
// value with exactly `current`, `last_declared`, `switch_count` and
// `correction_date`: the names and the spelling of `card-state`'s
// `platforms` (docs/api/card-proof.md). A date is `YYYY-MM-DD`. Facts only:
// how many switches a slot has used, never whether another is allowed.
//
// A card without a valid record has no row. A row holds the slots the rules
// gave it; a platform added to the table later has no entry in the rows
// written before, and the rules read a missing slot as the empty one.
import { byBytes } from "iamreal-protocol/bytes.ts";
import { type Day, formatDay, parseDay } from "iamreal-protocol/date.ts";
import type { CardState, SlotState } from "iamreal-protocol/roster-rules.ts";

export const CARD_TABLE = `
CREATE TABLE IF NOT EXISTS cards (
  scope_string        TEXT    NOT NULL,
  scoped_id           TEXT    NOT NULL,
  last_card_proof     TEXT    NOT NULL,
  proofs_on_last_date INTEGER NOT NULL,
  slots               TEXT    NOT NULL,
  last_seq            INTEGER NOT NULL,
  PRIMARY KEY (scope_string, scoped_id)
) WITHOUT ROWID`;

/** A card's row: its state, and the `seq` of its last valid record. */
export interface StoredCard {
  readonly card: CardState;
  readonly lastSeq: number;
}

interface SlotJson {
  current: string | null;
  last_declared: string | null;
  switch_count: number;
  correction_date: string | null;
}

/** A stored row that is not what writeCard writes. The message names the column, never the card. */
function corrupt(column: string): Error {
  return new Error(`card state table: ${column} is not as written`);
}

function dayOfText(text: string, column: string): Day {
  const day = parseDay(text);
  if (day === null) throw corrupt(column);
  return day;
}

const stringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** The state of the card, or null if it has no valid record. */
export function readCard(sql: SqlStorage, scopeString: string, scopedId: string): StoredCard | null {
  const rows = sql.exec("SELECT last_card_proof, proofs_on_last_date, slots, last_seq FROM cards WHERE scope_string = ? AND scoped_id = ?", scopeString, scopedId).toArray();
  const row = rows[0];
  if (row === undefined) return null;
  const { last_card_proof, proofs_on_last_date, slots: slotsText, last_seq } = row;
  if (typeof last_card_proof !== "string") throw corrupt("last_card_proof");
  if (typeof proofs_on_last_date !== "number" || !Number.isSafeInteger(proofs_on_last_date)) throw corrupt("proofs_on_last_date");
  if (typeof last_seq !== "number" || !Number.isSafeInteger(last_seq)) throw corrupt("last_seq");
  if (typeof slotsText !== "string") throw corrupt("slots");
  let parsed: unknown;
  try {
    parsed = JSON.parse(slotsText);
  } catch {
    throw corrupt("slots");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw corrupt("slots");
  const slots = new Map<string, SlotState>();
  for (const [platform, s] of Object.entries(parsed as Record<string, Partial<SlotJson> | null>)) {
    if (typeof s !== "object" || s === null) throw corrupt("slots");
    const { current, last_declared, switch_count, correction_date } = s;
    if (!stringOrNull(current) || !stringOrNull(last_declared) || !stringOrNull(correction_date)) throw corrupt("slots");
    if (typeof switch_count !== "number" || !Number.isSafeInteger(switch_count)) throw corrupt("slots");
    slots.set(platform, {
      current,
      lastDeclared: last_declared,
      switchCount: switch_count,
      correctionDate: correction_date === null ? null : dayOfText(correction_date, "slots"),
    });
  }
  return { card: { lastCardProof: dayOfText(last_card_proof, "last_card_proof"), proofsOnLastDate: proofs_on_last_date, slots }, lastSeq: last_seq };
}

/**
 * Writes the state of a card after a valid record, `seq` being that record's:
 * the card's row is replaced as a whole. A card has a row only once it has a
 * valid record, so `card.lastCardProof` is a date.
 */
export function writeCard(sql: SqlStorage, scopeString: string, scopedId: string, card: CardState, seq: number): void {
  if (card.lastCardProof === null) throw new Error("card state table: a card without a valid record has no row");
  const slots: Record<string, SlotJson> = {};
  for (const platform of [...card.slots.keys()].sort(byBytes)) {
    const s = card.slots.get(platform)!;
    slots[platform] = {
      current: s.current,
      last_declared: s.lastDeclared,
      switch_count: s.switchCount,
      correction_date: s.correctionDate === null ? null : formatDay(s.correctionDate),
    };
  }
  sql.exec(
    "INSERT OR REPLACE INTO cards (scope_string, scoped_id, last_card_proof, proofs_on_last_date, slots, last_seq) VALUES (?, ?, ?, ?, ?, ?)",
    scopeString,
    scopedId,
    formatDay(card.lastCardProof),
    card.proofsOnLastDate,
    JSON.stringify(slots),
    seq,
  );
}
