// The card state file (spec/roster-rules.md, "The card state file"): the
// state the server keeps of every card that has a valid record, one row a
// card, published once a day so that a re-verifier can compare it with the
// states it computes from the roster (ADR-0025). Like a record, a row has
// exactly one spelling: it is written from a template, and read by writing
// it again and comparing bytes.
//
// The format checks each value by itself. Whether a row is a state the
// roster rules can leave (possibleSlot, possibleCard of roster-rules.ts) is
// not checked here, on purpose: the file is there to show a wrong stored
// state to whoever compares, not to hide it.
import { byBytes } from "./bytes.ts";
import { type Day, formatDay, parseDay } from "./date.ts";
import { platformsOf } from "./platforms.ts";
import { MAX_SEQ } from "./record.ts";
import type { CardState, SlotState } from "./roster-rules.ts";
import { type Roster, lookupScope } from "./scope.ts";
import { parseScopedId } from "./scoped-id.ts";

/** A row: a card, its state, and the `seq` of its last valid record. */
export interface CardRow {
  readonly scopeString: string;
  readonly scopedId: string;
  /** The `seq` of the card's last valid record: 1 or more. */
  readonly lastSeq: number;
  /**
   * The card's state. A row lists the slots that are not in the initial
   * state: writing leaves the others out, and reading gives only the listed
   * ones, in ascending order of platform. A platform without a slot here is
   * in the initial state, as for the rules (applyRecord).
   */
  readonly card: CardState;
}

/** Why a card state file is broken: a row that is not in its one spelling, or a row that is not after the row before it. */
export type CardStateFileCode = "line" | "order";

/** A card state file as read: its rows in the order of the file, or the first line that fails (counting from 1) and its code. */
export type CardStateFileRead = { valid: true; rows: CardRow[] } | { valid: false; line: number; code: CardStateFileCode };

const isCount = (n: number, least: number): boolean => Number.isSafeInteger(n) && n >= least && n <= MAX_SEQ;
/** A day number that is a date as the specification writes one: year 2000 to 2049. */
const isDate = (d: Day): boolean => Number.isInteger(d) && parseDay(formatDay(d)) === d;

/** True if every item of the slot has its initial value: such a slot is not listed. */
function isInitial(s: SlotState): boolean {
  return s.current === null && s.lastDeclared === null && s.switchCount === 0 && s.correctionDate === null;
}

/** The slots of a row: those not in the initial state, in ascending order of platform. */
function listedSlots(card: CardState): [string, SlotState][] {
  return [...card.slots].filter(([, s]) => !isInitial(s)).sort(([a], [b]) => byBytes(a, b));
}

/**
 * The first item of `row` that is not in its format for `roster`
 * (spec/roster-rules.md, "The card state file"), by its name in the row, or
 * null if every one is. Only the slots a row lists are looked at.
 */
function rowProblem(roster: Roster, row: CardRow): string | null {
  const { card } = row;
  if (!lookupScope(roster, row.scopeString)) return "scope_string";
  if (parseScopedId(row.scopedId) === null) return "scoped_id";
  if (!isCount(row.lastSeq, 1)) return "last_seq";
  if (card.lastCardProof === null || !isDate(card.lastCardProof)) return "last_card_proof";
  if (!isCount(card.proofsOnLastDate, 0)) return "proofs_on_last_date";
  const table = platformsOf(roster);
  for (const [platform, s] of listedSlots(card)) {
    const tableRow = table.find((p) => p.platform === platform);
    if (tableRow === undefined) return "slots";
    for (const username of [s.current, s.lastDeclared]) if (username !== null && !tableRow.format.accepts(username)) return "slots";
    if (!isCount(s.switchCount, 0)) return "slots";
    if (s.correctionDate !== null && !isDate(s.correctionDate)) return "slots";
  }
  return null;
}

const quoted = (value: string | null): string => (value === null ? "null" : `"${value}"`);

/** The row written from the template and followed by LF. It does not check the values. */
function rowLine(row: CardRow): string {
  const { card } = row;
  const slots = listedSlots(card).map(
    ([platform, s]) =>
      `"${platform}":{"current":${quoted(s.current)},"last_declared":${quoted(s.lastDeclared)},"switch_count":${s.switchCount},"correction_date":${quoted(s.correctionDate === null ? null : formatDay(s.correctionDate))}}`,
  );
  return `{"scope_string":"${row.scopeString}","scoped_id":"${row.scopedId}","last_seq":${row.lastSeq},"last_card_proof":"${formatDay(card.lastCardProof!)}","proofs_on_last_date":${card.proofsOnLastDate},"slots":{${slots.join(",")}}}\n`;
}

/** The order of the rows: by scope string, then by scoped ID, by byte values. */
const byCard = (a: CardRow, b: CardRow): number => byBytes(a.scopeString, b.scopeString) || byBytes(a.scopedId, b.scopedId);

/**
 * The card state file of `cards` for a roster of `roster`: one row a card,
 * in the order of the file whatever order they are given in. The file is
 * returned as text; every character is ASCII, and the file's bytes are its
 * UTF-8 encoding. No card gives the empty file.
 *
 * `cards` are the cards that have a valid record, each with the `seq` of
 * its last one. Throws if a card cannot be written as a row (it has no
 * `lastCardProof`, or a value is outside its format: the message names the
 * item, never the card or the value) or if a card is given twice. It does
 * not judge whether a state is one the rules can leave.
 */
export function cardStateFile(roster: Roster, cards: Iterable<CardRow>): string {
  const rows = [...cards].sort(byCard);
  const lines: string[] = [];
  rows.forEach((row, i) => {
    const problem = rowProblem(roster, row);
    if (problem !== null) throw new Error(`card state file: ${problem} of a card is not in its format`);
    if (i > 0 && byCard(rows[i - 1]!, row) === 0) throw new Error("card state file: a card is given twice");
    lines.push(rowLine(row));
  });
  return lines.join("");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const stringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/**
 * The row a line of a card state file of `roster` is, or null if the line
 * is not in its one spelling: `line` is the line's text up to and including
 * its LF. The line is parsed, every value checked against its format, and
 * the row written again from the template; if the text differs, it is
 * malformed. That one comparison refuses whatever JSON allows beyond the
 * template, a slot in the initial state and slots in another order.
 */
function readRow(roster: Roster, line: string): CardRow | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  const { scope_string, scoped_id, last_seq, last_card_proof, proofs_on_last_date, slots } = v;
  if (typeof scope_string !== "string" || typeof scoped_id !== "string" || typeof last_card_proof !== "string") return null;
  if (typeof last_seq !== "number" || typeof proofs_on_last_date !== "number" || !isObject(slots)) return null;
  const read = new Map<string, SlotState>();
  for (const platform of Object.keys(slots).sort(byBytes)) {
    const s = slots[platform];
    if (!isObject(s)) return null;
    const { current, last_declared, switch_count, correction_date } = s;
    if (!stringOrNull(current) || !stringOrNull(last_declared) || !stringOrNull(correction_date) || typeof switch_count !== "number") return null;
    const correctionDate = correction_date === null ? null : parseDay(correction_date);
    if (correction_date !== null && correctionDate === null) return null;
    read.set(platform, { current, lastDeclared: last_declared, switchCount: switch_count, correctionDate });
  }
  const lastCardProof = parseDay(last_card_proof);
  if (lastCardProof === null) return null;
  const row: CardRow = { scopeString: scope_string, scopedId: scoped_id, lastSeq: last_seq, card: { lastCardProof, proofsOnLastDate: proofs_on_last_date, slots: read } };
  if (rowProblem(roster, row) !== null) return null;
  return rowLine(row) === line ? row : null;
}

const LF = 0x0a;

/**
 * The text of bytes that are all ASCII, or null. Every byte of a row is
 * ASCII, so nothing is decoded as UTF-8: a decoder would drop a byte order
 * mark or replace bytes that are not UTF-8 before the row is looked at.
 */
function asciiText(bytes: Uint8Array): string | null {
  let out = "";
  for (const b of bytes) {
    if (b > 0x7f) return null;
    out += String.fromCharCode(b);
  }
  return out;
}

/**
 * Reads a card state file of a roster of `roster` (spec/roster-rules.md,
 * "The card state file"): `file` is the bytes of the whole file, as
 * downloaded and not decoded. Lines are checked one at a time, in order;
 * for each, that it is a row in its one spelling (`line`), then that its
 * card is after the card of the row before (`order`: also the same card
 * twice). The first failure ends the check. Bytes after the last LF, an
 * empty line, a byte order mark and any other byte outside ASCII fail the
 * first check on the line where they occur. The empty file has no row.
 */
export function readCardStateFile(roster: Roster, file: Uint8Array): CardStateFileRead {
  const rows: CardRow[] = [];
  let start = 0;
  while (start < file.length) {
    const line = rows.length + 1;
    const end = file.indexOf(LF, start);
    const text = end < 0 ? null : asciiText(file.subarray(start, end + 1));
    const row = text === null ? null : readRow(roster, text);
    if (row === null) return { valid: false, line, code: "line" };
    if (rows.length > 0 && byCard(rows[rows.length - 1]!, row) >= 0) return { valid: false, line, code: "order" };
    rows.push(row);
    start = end + 1;
  }
  return { valid: true, rows };
}
