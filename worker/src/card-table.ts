// The card state table of the proof log's Durable Object (proof-log.ts): the
// record rules' state of every card that has a valid record, one row a card.
// Only the rules' state is here, nothing a page shows: it is read before and
// written after each call of the rules (protocol/src/record-rules.ts), and a
// wrong row would accept records that cannot be taken back.
//
// The columns are the items of spec/record-rules.md, "State", and one more:
//
//   last_card_proof, proofs_on_last_date   the card's own items
//   slots                                  the items of each slot, by platform
//   last_seq                               the `seq` of the card's last valid record
//
// `slots` is JSON, an object keyed by platform ID in ascending order, each
// value a slot in the back end's one spelling of it (slot-json.ts). A date
// is `YYYY-MM-DD`. Facts only: how many switches a slot has used, never
// whether another is allowed.
//
// A card without a valid record has no row. A row holds the slots the rules
// gave it; a platform added to the table later has no entry in the rows
// written before, and the rules read a missing slot as the empty one.
//
// A row is checked when it is read (readCard): a state the rules cannot
// have left is not handed on.
import { byBytes } from "iamreal-protocol/bytes.ts";
import type { CardRow } from "iamreal-protocol/card-state-file.ts";
import { type Day, formatDay, parseDay } from "iamreal-protocol/date.ts";
import type { PlatformRow } from "iamreal-protocol/platforms.ts";
import { type CardState, MAX_PER_DATE, type SlotState, possibleSlot } from "iamreal-protocol/record-rules.ts";
import { type SlotJson, slotOfJson, slotToJson } from "./slot-json.ts";

/** The columns of the card state table, and of its copy (`copyCards`). */
const CARD_COLUMNS = `(
  scope_string        TEXT    NOT NULL,
  scoped_id           TEXT    NOT NULL,
  last_card_proof     TEXT    NOT NULL,
  proofs_on_last_date INTEGER NOT NULL,
  slots               TEXT    NOT NULL,
  last_seq            INTEGER NOT NULL,
  PRIMARY KEY (scope_string, scoped_id)
) WITHOUT ROWID`;

export const CARD_TABLE = `CREATE TABLE IF NOT EXISTS cards ${CARD_COLUMNS}`;

/**
 * The copy of the card state table the card state file of a publication is
 * written from (proof-log.ts, `#publish`): made at the moment the publication
 * reads its count, read afterwards while records go on being written to
 * `cards`, and dropped when the publication ends, however it ends. Nothing
 * else reads it, and nothing reads a copy left by an object that stopped
 * in the middle of a publication: the next publication makes its own.
 */
const CARDS_COPY = "cards_copy";

/** A card's row: its state, and the `seq` of its last valid record. */
export interface StoredCard {
  readonly card: CardState;
  readonly lastSeq: number;
}

/**
 * A stored row that is not one the rules can have left: the stored state is
 * broken. The message names the column, never the card or a value.
 */
function corrupt(column: string): Error {
  return new Error(`card state table: ${column} is not a state the rules leave`);
}

const stringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/** The columns of a row of the table, as SQLite gives them. */
type Columns = Record<string, SqlStorageValue>;

const COLUMNS = "last_card_proof, proofs_on_last_date, slots, last_seq";

/**
 * A row of the table read as a state: the columns as they are stored, each
 * of its own type, the slots parsed from their JSON. Throws for a row that
 * cannot be read as a state at all (a date that is not a date, slots that
 * are not JSON of the stored shape); the message names the column, never
 * the card or a value. Whether the state is one the record rules can have
 * left is not asked here: `readCard` asks it, `copiedCards` on purpose
 * does not.
 */
function stateOf(row: Columns): StoredCard & { card: { lastCardProof: Day } } {
  const { last_card_proof, proofs_on_last_date, slots: slotsText, last_seq } = row;
  const lastCardProof = typeof last_card_proof === "string" ? parseDay(last_card_proof) : null;
  if (lastCardProof === null) throw corrupt("last_card_proof");
  if (typeof proofs_on_last_date !== "number") throw corrupt("proofs_on_last_date");
  if (typeof last_seq !== "number") throw corrupt("last_seq");
  let parsed: unknown;
  try {
    parsed = typeof slotsText === "string" ? JSON.parse(slotsText) : null;
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw corrupt("slots");
  const slots = new Map<string, SlotState>();
  for (const [platform, s] of Object.entries(parsed as Record<string, Partial<SlotJson> | null>)) {
    if (typeof s !== "object" || s === null) throw corrupt("slots");
    const { current, last_declared, switch_count, correction_date } = s;
    if (!stringOrNull(current) || !stringOrNull(last_declared) || !stringOrNull(correction_date) || typeof switch_count !== "number") throw corrupt("slots");
    const slot = slotOfJson({ current, last_declared, switch_count, correction_date });
    if (slot === null) throw corrupt("slots");
    slots.set(platform, slot);
  }
  return { card: { lastCardProof, proofsOnLastDate: proofs_on_last_date, slots }, lastSeq: last_seq };
}

/**
 * The state of the card, or null if it has no valid record.
 *
 * Throws if the row is not a state the record rules can have left for a
 * card of this proof log (spec/record-rules.md, "State"; `platforms` is the
 * proof log's table):
 *
 *   - `last_card_proof` is a date; `proofs_on_last_date` is 1 to 3; `last_seq` is 1 or more;
 *   - every slot is on a platform of the table;
 *   - its `switch_count` is 0 to 5, its dates are dates, and its items fit
 *     each other and the card's last card proof (protocol/, possibleSlot);
 *   - `current` and `last_declared` are in the `username` format of the platform.
 *
 * The limits are the constants of protocol/, not numbers of this file.
 */
export function readCard(sql: SqlStorage, platforms: readonly PlatformRow[], scopeString: string, scopedId: string): StoredCard | null {
  const row = sql.exec(`SELECT ${COLUMNS} FROM cards WHERE scope_string = ? AND scoped_id = ?`, scopeString, scopedId).toArray()[0];
  if (row === undefined) return null;
  const stored = stateOf(row);
  const { card, lastSeq } = stored;
  if (!Number.isSafeInteger(card.proofsOnLastDate) || card.proofsOnLastDate < 1 || card.proofsOnLastDate > MAX_PER_DATE) throw corrupt("proofs_on_last_date");
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 1) throw corrupt("last_seq");
  for (const [platform, slot] of card.slots) {
    const tableRow = platforms.find((p) => p.platform === platform);
    if (tableRow === undefined || !possibleSlot(slot, card.lastCardProof)) throw corrupt("slots");
    for (const username of [slot.current, slot.lastDeclared]) if (username !== null && !tableRow.format.accepts(username)) throw corrupt("slots");
  }
  return stored;
}

/**
 * Makes a copy of the card state table as it is now, in place of any copy
 * there is: SQLite copies the rows, and none of them passes through
 * JavaScript.
 */
export function copyCards(sql: SqlStorage): void {
  dropCardsCopy(sql);
  sql.exec(`CREATE TABLE ${CARDS_COPY} ${CARD_COLUMNS}`);
  sql.exec(`INSERT INTO ${CARDS_COPY} (scope_string, scoped_id, ${COLUMNS}) SELECT scope_string, scoped_id, ${COLUMNS} FROM cards`);
}

/** Drops the copy of the card state table, if there is one. */
export function dropCardsCopy(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS ${CARDS_COPY}`);
}

/**
 * Rows of the copy of the card state table (`copyCards`) as rows of the
 * card state file (spec/record-rules.md, "The card state file"): at most
 * `limit` of them, those that come after the card of `after` (or from the
 * first, with null), in the order of the file. Each call is a query of its
 * own, read to its end before it returns, so that nothing is held open
 * while the caller waits.
 *
 * Unlike `readCard`, this does not ask whether a row is a state the record
 * rules can have left: the card state file is published so that whoever
 * compares it finds a stored state that is wrong, and a reading that
 * refused such a row would hide it. It throws only for a row that cannot be
 * read as a state at all (`stateOf`). Whether every value is in the format
 * of a row, and the rows in the order of the file, is for protocol/'s
 * `cardStateFileWriter`.
 */
export function copiedCards(sql: SqlStorage, after: CardRow | null, limit: number): CardRow[] {
  const from = after === null ? "" : "WHERE (scope_string, scoped_id) > (?, ?)";
  const keys = after === null ? [] : [after.scopeString, after.scopedId];
  const out: CardRow[] = [];
  for (const row of sql.exec(`SELECT scope_string, scoped_id, ${COLUMNS} FROM ${CARDS_COPY} ${from} ORDER BY scope_string, scoped_id LIMIT ?`, ...keys, limit)) {
    if (typeof row.scope_string !== "string" || typeof row.scoped_id !== "string") throw corrupt("the card");
    out.push({ scopeString: row.scope_string, scopedId: row.scoped_id, ...stateOf(row) });
  }
  return out;
}

/**
 * Writes the state of a card after a valid record, `seq` being that record's:
 * the card's row is replaced as a whole. A card has a row only once it has a
 * valid record, so `card.lastCardProof` is a date.
 */
export function writeCard(sql: SqlStorage, scopeString: string, scopedId: string, card: CardState, seq: number): void {
  if (card.lastCardProof === null) throw new Error("card state table: a card without a valid record has no row");
  const slots: Record<string, SlotJson> = {};
  for (const platform of [...card.slots.keys()].sort(byBytes)) slots[platform] = slotToJson(card.slots.get(platform)!);
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
