// The views: the tables of the proof log's Durable Object (proof-log.ts) that are
// derived from the records for the pages visitors read. They hold what each
// valid record changed, as the record rules computed it (protocol/,
// applyRecord): nothing here decides a kind. The records are what counts.
// The views are written in the transaction that writes a record, and can be
// cleared and written again from the records at any time (`clearViews`,
// `writeViewsOf`; proof-log.ts, `#fillViews`, which reads the records where
// they are); they reflect exactly the records 1 to `viewSeq`.
//
// The first four tables are the ones of the Go backend (e159ab9:server/store/sqlite_view.go).
// A date is a day number (protocol/, `Day`: days since 1970-01-01), so that
// dates compare as numbers; an account that is none is NULL. Every table of
// cards is keyed by the scope string, since a proof log can hold two scopes
// while one is retired; `view_ordinals` is keyed by the ordinal, which counts
// the cards of every scope together.
//
//   view_state    one row, the `seq` of the last record the views reflect
//   view_cards    one row per card with a valid record
//   view_slots    one row per slot on which a valid record of the card has
//                 had a kind. `last_card_proof` is the card's as of the last
//                 record with a kind on the slot, so that the counts are
//                 answered from one index. For a slot with an account that
//                 is the card's last card proof: a valid record has a kind
//                 on every slot that has an account before it (refresh,
//                 switch, correction or withdraw), so every valid record of
//                 the card writes it.
//   view_history  one row per valid record and platform on which it has a kind;
//                 the proof log page lists it by `seq` (view_history_log)
//   view_ordinals one row per card with a valid record: its ordinal
//                 (spec/record-rules.md, "The ordinal"), given by the card's
//                 first valid record, of whatever scope, and never changed.
//                 The table came after the other four: an object whose views
//                 were filled before it has the views at the last record
//                 and no ordinal, and fills them again when it starts
//                 (`ordinalsOwed`).
//
// The rules' own state of a card is not here (card-table.ts): that one
// cannot be thrown away, and a page never reads it.
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import type { Day } from "iamreal-protocol/date.ts";
import type { PlatformRow } from "iamreal-protocol/platforms.ts";
import { type ProofLogRecord, readRecordLine } from "iamreal-protocol/record.ts";
import { type CardState, EMPTY_SLOT, type Kind, type PlatformKind, applyList, newCard } from "iamreal-protocol/record-rules.ts";
import { SHORT_ID_LENGTH, shortId } from "iamreal-protocol/scoped-id.ts";
import type { AccountCard, Counts, HistoryRow, LogRow, PageCard } from "./page-data.ts";
import type { ProofLogKind } from "./settings.ts";

/** The tables and their indexes. Every statement can run again on an object that has them. */
export const VIEW_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS view_state (
     id  INTEGER PRIMARY KEY CHECK (id = 1),
     seq INTEGER NOT NULL
   )`,
  "INSERT OR IGNORE INTO view_state (id, seq) VALUES (1, 0)",
  `CREATE TABLE IF NOT EXISTS view_cards (
     scope_string    TEXT    NOT NULL,
     scoped_id       TEXT    NOT NULL,
     short_id        TEXT    NOT NULL,
     first_date      INTEGER NOT NULL,
     last_card_proof INTEGER NOT NULL,
     card_proofs     INTEGER NOT NULL,
     PRIMARY KEY (scope_string, scoped_id)
   ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS view_cards_short_id ON view_cards (scope_string, short_id)",
  `CREATE TABLE IF NOT EXISTS view_slots (
     scope_string    TEXT    NOT NULL,
     scoped_id       TEXT    NOT NULL,
     platform        TEXT    NOT NULL,
     current         TEXT,
     since_date      INTEGER,
     since_seq       INTEGER,
     switch_count    INTEGER NOT NULL,
     last_card_proof INTEGER NOT NULL,
     PRIMARY KEY (scope_string, scoped_id, platform),
     CHECK ((current IS NULL) = (since_date IS NULL) AND (current IS NULL) = (since_seq IS NULL))
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS view_slots_account ON view_slots
     (scope_string, platform, current, since_date, since_seq, last_card_proof) WHERE current IS NOT NULL`,
  // An index no read uses any more, taken off the objects that have it (README.md, 衍生表).
  "DROP INDEX IF EXISTS view_slots_latest",
  `CREATE INDEX IF NOT EXISTS view_slots_recency ON view_slots
     (scope_string, platform, last_card_proof, current) WHERE current IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS view_history (
     seq              INTEGER NOT NULL,
     platform         TEXT    NOT NULL,
     scope_string     TEXT    NOT NULL,
     scoped_id        TEXT    NOT NULL,
     date             INTEGER NOT NULL,
     kind             TEXT    NOT NULL,
     after_withdrawal INTEGER NOT NULL,
     before_username  TEXT,
     after_username   TEXT,
     PRIMARY KEY (seq, platform)
   ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS view_history_card ON view_history (scope_string, scoped_id, date, seq, platform)",
  `CREATE INDEX IF NOT EXISTS view_history_log ON view_history
     (scope_string, platform, seq, scoped_id, date, kind, after_withdrawal, before_username, after_username)`,
  `CREATE TABLE IF NOT EXISTS view_ordinals (
     ordinal      INTEGER PRIMARY KEY,
     scope_string TEXT    NOT NULL,
     scoped_id    TEXT    NOT NULL
   )`,
  // One ordinal a card: the write of a later record of the card is ignored (`writeView`).
  "CREATE UNIQUE INDEX IF NOT EXISTS view_ordinals_card ON view_ordinals (scope_string, scoped_id)",
];

/** The five tables, each with the columns of its primary key. */
export const VIEW_TABLE_KEYS = {
  view_state: "id",
  view_cards: "scope_string, scoped_id",
  view_ordinals: "ordinal",
  view_slots: "scope_string, scoped_id, platform",
  view_history: "seq, platform",
} as const;

/**
 * How far back the counts look for a recent card proof: a last card proof
 * on the given date or up to 90 days before it, both included
 * (design/copy/home.md, 一起能改變什麼).
 */
export const RECENT_DAYS = 90;

/** What a valid record did on one platform, and the slot as it is after it. */
interface SlotChange {
  readonly platform: string;
  readonly kind: Kind;
  /** The slot had been declared before and had no account just before this record. */
  readonly afterWithdrawal: boolean;
  /** The slot's last declared account just before the record; null for a first declaration. For a withdrawal it is the account withdrawn. */
  readonly before: string | null;
  /** The slot's current account after the record; null after a withdrawal. */
  readonly after: string | null;
  readonly switchCount: number;
  /**
   * Whether this record starts the slot giving its place to `after`: a
   * first declaration, a switch, a correction, or declaring again after a
   * withdrawal. A refresh of the current account does not.
   */
  readonly since: boolean;
}

/** What one valid record changes in the views. */
export interface View {
  readonly seq: number;
  readonly scopeString: string;
  readonly scopedId: string;
  /** The record's date. */
  readonly date: Day;
  /** The card's last card proof after the record. */
  readonly lastCardProof: Day;
  /** One entry for every platform on which the record has a kind, in the order of the rules' result. */
  readonly changes: readonly SlotChange[];
}

/**
 * What a valid record changes in the views: `kinds` is the rules' result
 * for it, `before` the state of its card just before it and `after` just
 * after it.
 */
export function viewOf(record: { seq: number; scopeString: string; scopedId: string }, date: Day, kinds: readonly PlatformKind[], before: CardState, after: CardState): View {
  if (after.lastCardProof === null) throw new Error("views: the card has no last card proof after a valid record");
  const changes = kinds.map(({ platform, kind }): SlotChange => {
    const b = before.slots.get(platform) ?? EMPTY_SLOT;
    const a = after.slots.get(platform);
    if (a === undefined) throw new Error("views: a kind on a platform the card's state has no slot for");
    const afterWithdrawal = b.current === null && b.lastDeclared !== null;
    return {
      platform,
      kind,
      afterWithdrawal,
      before: b.lastDeclared,
      after: a.current,
      switchCount: a.switchCount,
      since: kind === "first" || kind === "switch" || kind === "correction" || (kind === "refresh" && afterWithdrawal),
    };
  });
  return { seq: record.seq, scopeString: record.scopeString, scopedId: record.scopedId, date, lastCardProof: after.lastCardProof, changes };
}

/** A row of `view_history` as the pages take it. */
function historyRowOf(h: { date: number; platform: string; kind: string; after_withdrawal: number; before_username: string | null; after_username: string | null }): HistoryRow {
  return { date: h.date, platform: h.platform, kind: h.kind as Kind, afterWithdrawal: h.after_withdrawal !== 0, before: h.before_username, after: h.after_username };
}

/** The `seq` of the last record the views reflect. */
export function viewSeq(sql: SqlStorage): number {
  return sql.exec<{ seq: number }>("SELECT seq FROM view_state WHERE id = 1").one().seq;
}

/**
 * Whether the views have cards and no ordinal: they were filled before
 * `view_ordinals` was a table, and must be filled again from the records
 * although `viewSeq` is at the last record. Views written since have an
 * ordinal for every card, in the transaction of its first valid record. It
 * reads at most one row of each table.
 */
export function ordinalsOwed(sql: SqlStorage): boolean {
  return sql.exec<{ owed: number }>("SELECT EXISTS (SELECT 1 FROM view_cards) AND NOT EXISTS (SELECT 1 FROM view_ordinals) AS owed").one().owed === 1;
}

/**
 * Writes what one valid record changes and moves `view_state` to its `seq`.
 * The views must be at the record before it: otherwise this throws, and the
 * transaction it is in writes nothing.
 */
export function writeView(sql: SqlStorage, v: View): void {
  if (viewSeq(sql) !== v.seq - 1) throw new Error("views: not at the record before this one");
  if (v.scopedId.length < SHORT_ID_LENGTH) throw new Error("views: the scoped ID is shorter than a short ID");
  sql.exec(
    `INSERT INTO view_cards (scope_string, scoped_id, short_id, first_date, last_card_proof, card_proofs) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT (scope_string, scoped_id) DO UPDATE SET
       first_date = MIN(first_date, excluded.first_date), last_card_proof = excluded.last_card_proof, card_proofs = card_proofs + 1`,
    v.scopeString,
    v.scopedId,
    shortId(v.scopedId),
    v.date,
    v.lastCardProof,
  );
  // The card's first valid record gives it the next ordinal; a card that has one keeps it.
  sql.exec(
    "INSERT OR IGNORE INTO view_ordinals (ordinal, scope_string, scoped_id) SELECT COALESCE(MAX(ordinal), 0) + 1, ?, ? FROM view_ordinals",
    v.scopeString,
    v.scopedId,
  );
  for (const c of v.changes) {
    // A change that does not start the slot's giving (a refresh of the current account) keeps `since`; a withdrawal
    // clears it. A slot gets its row with its first declaration.
    const kept = sql
      .exec<{ since_date: number | null; since_seq: number | null }>("SELECT since_date, since_seq FROM view_slots WHERE scope_string = ? AND scoped_id = ? AND platform = ?", v.scopeString, v.scopedId, c.platform)
      .toArray()[0];
    const starts = c.since && c.after !== null;
    const keeps = !c.since && c.after !== null;
    const sinceDate = starts ? v.date : keeps ? (kept?.since_date ?? null) : null;
    const sinceSeq = starts ? v.seq : keeps ? (kept?.since_seq ?? null) : null;
    sql.exec(
      "INSERT OR REPLACE INTO view_slots (scope_string, scoped_id, platform, current, since_date, since_seq, switch_count, last_card_proof) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      v.scopeString,
      v.scopedId,
      c.platform,
      c.after,
      sinceDate,
      sinceSeq,
      c.switchCount,
      v.lastCardProof,
    );
    sql.exec(
      "INSERT INTO view_history (seq, platform, scope_string, scoped_id, date, kind, after_withdrawal, before_username, after_username) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      v.seq,
      c.platform,
      v.scopeString,
      v.scopedId,
      v.date,
      c.kind,
      c.afterWithdrawal ? 1 : 0,
      c.before,
      c.after,
    );
  }
  sql.exec("UPDATE view_state SET seq = ? WHERE id = 1", v.seq);
}

/** Clears the views: they then reflect no record. The caller runs it in a transaction. */
export function clearViews(sql: SqlStorage): void {
  for (const table of Object.keys(VIEW_TABLE_KEYS)) if (table !== "view_state") sql.exec(`DELETE FROM ${table}`);
  sql.exec("UPDATE view_state SET seq = 0 WHERE id = 1");
}

/** A line of the log file, the LF included, with the `seq` its record must have. */
export interface NumberedLine {
  readonly seq: number;
  readonly line: string;
}

/** The record rules' state of every card met so far while the views are written again, by scope string and scoped ID. */
export type CardsSoFar = Map<string, CardState>;

/**
 * Writes what a run of the proof log's lines changes in the views: `lines` are
 * lines of the log file with the `seq` each must have, in order, the
 * first being the record after the last one the views reflect. `cards` is
 * the state the records before them left, and is brought up to the last of
 * them: empty for the proof log's first line, then the same map for each run
 * that follows. The caller runs it in a transaction.
 *
 * Every line is one the back end wrote, so it passed the record rules'
 * checks 1 to 4 when it was written; what it did on each platform is
 * computed again by the same rules (protocol/, `applyList`: checks 5 and 6
 * and the effects), from the states the records before it leave. A line
 * that is not well formed, or a record the rules do not take, throws: the
 * transaction then leaves the views as they were before this run.
 */
export function writeViewsOf(sql: SqlStorage, kind: ProofLogKind, platforms: readonly PlatformRow[], cards: CardsSoFar, lines: Iterable<NumberedLine>): void {
  for (const row of lines) {
    const record: ProofLogRecord | null = readRecordLine(kind, row.line);
    const date = record === null ? null : parseChallenge(record.challenge);
    if (record === null || date === null || record.seq !== row.seq) throw new Error("views: a stored record is not a well-formed line");
    const key = `${record.scopeString}\n${record.scopedId}`;
    const before = cards.get(key) ?? newCard(platforms);
    const outcome = applyList(platforms, before, record.accounts, date);
    if (!outcome.result.valid) throw new Error("views: a stored record is not one the record rules take");
    cards.set(key, outcome.card);
    writeView(sql, viewOf(record, date, outcome.result.kinds, before, outcome.card));
  }
}

/** The rows of the records table (proof-log.ts), in the order of `seq`, as `writeViewsOf` takes them. */
export function storedLines(sql: SqlStorage): Iterable<NumberedLine> {
  return sql.exec<{ seq: number; line: string }>("SELECT seq, line FROM records ORDER BY seq");
}

/**
 * The number of cards of a scope whose account on a platform is this
 * username now. It reads the index `view_slots_account`, a row a card, and
 * no card's stored state.
 */
export function accountCards(sql: SqlStorage, scopeString: string, platform: string, username: string): number {
  return sql.exec<{ cards: number }>("SELECT COUNT(*) AS cards FROM view_slots INDEXED BY view_slots_account WHERE scope_string = ? AND platform = ? AND current = ?", scopeString, platform, username).one().cards;
}

/**
 * The cards of a scope whose account on a platform is this username now,
 * by the date from which each gives its place to it, the earliest first,
 * and cards of the same date by the `seq` of that record. It reads the
 * index `view_slots_account`, which covers it. The Go backend's
 * `AccountCards` (e159ab9:server/store/sqlite_view.go).
 */
export function cardsOfAccount(sql: SqlStorage, scopeString: string, platform: string, username: string): AccountCard[] {
  return sql
    .exec<{ scoped_id: string; since_date: number; last_card_proof: number }>(
      `SELECT scoped_id, since_date, last_card_proof FROM view_slots INDEXED BY view_slots_account
       WHERE scope_string = ? AND platform = ? AND current = ? ORDER BY since_date, since_seq`,
      scopeString,
      platform,
      username,
    )
    .toArray()
    .map((row) => ({ scopedId: row.scoped_id, since: row.since_date, lastCardProof: row.last_card_proof }));
}

/**
 * At most `n` of the valid records of a scope that have a kind on a
 * platform, with what each did there, the latest first by `seq`. With
 * `before`, only the records before that `seq`: passing the `seq` of the
 * last record returned gives the next ones, whatever was written since. It
 * reads the index `view_history_log` backwards, which covers it.
 */
export function logRows(sql: SqlStorage, scopeString: string, platform: string, before: number | null, n: number): LogRow[] {
  type Row = { seq: number; scoped_id: string; date: number; kind: string; after_withdrawal: number; before_username: string | null; after_username: string | null };
  const select = `SELECT seq, scoped_id, date, kind, after_withdrawal, before_username, after_username FROM view_history INDEXED BY view_history_log
     WHERE scope_string = ? AND platform = ?`;
  const order = "ORDER BY seq DESC LIMIT ?";
  const rows = before === null ? sql.exec<Row>(`${select} ${order}`, scopeString, platform, n) : sql.exec<Row>(`${select} AND seq < ? ${order}`, scopeString, platform, before, n);
  return rows
    .toArray()
    .map((h): LogRow => ({ seq: h.seq, scopedId: h.scoped_id, ...historyRowOf({ ...h, platform }) }));
}

/**
 * The home page's two numbers (design/copy/home.md, 一起能改變什麼): the cards
 * that give their place on the platform to an account now, and those among
 * them whose last card proof is `today` or up to 90 days before it. It
 * reads the index `view_slots_recency`.
 */
export function counts(sql: SqlStorage, scopeString: string, platform: string, today: Day): Counts {
  const row = sql
    .exec<{ declared: number; recent: number }>(
      "SELECT COUNT(*) AS declared, COALESCE(SUM(last_card_proof >= ?), 0) AS recent FROM view_slots INDEXED BY view_slots_recency WHERE scope_string = ? AND platform = ? AND current IS NOT NULL",
      today - RECENT_DAYS,
      scopeString,
      platform,
    )
    .one();
  return { declared: row.declared, recent: row.recent };
}

/**
 * The ordinal of a card with a valid record (spec/record-rules.md, "The
 * ordinal"), by the index `view_ordinals_card`. A card the views list has
 * one; this throws for one they do not.
 */
export function ordinalOf(sql: SqlStorage, scopeString: string, scopedId: string): number {
  const ordinal = sql.exec<{ ordinal: number }>("SELECT ordinal FROM view_ordinals INDEXED BY view_ordinals_card WHERE scope_string = ? AND scoped_id = ?", scopeString, scopedId).toArray()[0]?.ordinal;
  if (ordinal === undefined) throw new Error("views: a card without an ordinal");
  return ordinal;
}

/**
 * The cards of a short ID, in ascending order of scoped ID, each with its
 * ordinal, its slots (in ascending order of platform) and its valid
 * records, the newest first. It reads the index `view_cards_short_id`, then
 * for each card the index `view_ordinals_card`, the primary key of
 * `view_slots` and the index `view_history_card`.
 */
export function cardsOfShortId(sql: SqlStorage, scopeString: string, short: string): PageCard[] {
  const cards = sql
    .exec<{ scoped_id: string; last_card_proof: number }>(
      "SELECT scoped_id, last_card_proof FROM view_cards INDEXED BY view_cards_short_id WHERE scope_string = ? AND short_id = ? ORDER BY scoped_id",
      scopeString,
      short,
    )
    .toArray();
  return cards.map((card): PageCard => {
    const ordinal = ordinalOf(sql, scopeString, card.scoped_id);
    const slots = sql
      .exec<{ platform: string; current: string | null }>("SELECT platform, current FROM view_slots WHERE scope_string = ? AND scoped_id = ? ORDER BY platform", scopeString, card.scoped_id)
      .toArray();
    const history = sql
      .exec<{ date: number; platform: string; kind: string; after_withdrawal: number; before_username: string | null; after_username: string | null }>(
        `SELECT date, platform, kind, after_withdrawal, before_username, after_username FROM view_history INDEXED BY view_history_card
         WHERE scope_string = ? AND scoped_id = ? ORDER BY date DESC, seq DESC, platform DESC`,
        scopeString,
        card.scoped_id,
      )
      .toArray();
    return {
      scopedId: card.scoped_id,
      ordinal,
      lastCardProof: card.last_card_proof,
      slots: slots.map((s) => ({ platform: s.platform, current: s.current })),
      history: history.map(historyRowOf),
    };
  });
}
