// Rebuilding from the proof log (ADR-0033, "從證明紀錄重建"): everything the
// proof log's object keeps that can be computed from the records is computed
// again, from the first record, and put in place of what the object has.
//
//   - the record rules' state of each card, and the latest valid date
//   - the views the pages read
//   - the count of records and the proof log fingerprint
//   - the challenges that were used
//
// and, for an object that has nothing (its storage is gone, or it is a new
// object for a proof log that is in the data bucket), the records of the
// last log file, the list of the full files and the lines of the fingerprint
// file.
//
// How it goes:
//
//   1. `beginRebuild` makes the tables the result is computed into, apart
//      from the object's own: the same tables under other names (`staged`).
//   2. `rebuildStep` reads one log file, or the records the object still
//      keeps, and applies the record rules to each record in order. One step
//      is one transaction; the rebuild goes on at the next step, so it can
//      break off anywhere and nothing the object answers from has changed.
//   3. The last step compares what was computed with the last line of the
//      fingerprint file, at that line's count. Only if they are the same
//      does it put every table in place, in one transaction (`swap`).
//
// Whether a record is valid is not decided here. Every record of the proof
// log was written by a back end that had the record rules accept it, so each
// is applied with the rules of this build (protocol/, `applyList`: the checks
// on the card's own state and the effects), as the views are filled
// (views.ts, `writeViewsOf`). A record these rules do not take ends the
// rebuild without a swap, with the `seq` in the reason: this file does not
// go on past it as if it were invalid.
//
// What starts a rebuild, and when a step runs, is the object's
// (proof-log.ts); this file reads no setting and no clock.
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { type Day, formatDay, parseDay } from "iamreal-protocol/date.ts";
import type { PlatformRow } from "iamreal-protocol/platforms.ts";
import { EMPTY_FINGERPRINT, type FingerprintLine, LINES_PER_FILE, fingerprintLine, nextFingerprint, proofLogFileName, readRecordLine, recordHash } from "iamreal-protocol/record.ts";
import { RULES_VERSION, applyList, newCard } from "iamreal-protocol/record-rules.ts";
import { sha256Hex } from "iamreal-protocol/bytes.ts";
import { CARD_TABLE, readCard, recordsOnDate, writeCard } from "./card-table.ts";
import { FINGERPRINT_FILE, type FileBucket, PROOF_LOG_DIRECTORY } from "./proof-log-files.ts";
import type { ProofLogKind } from "./settings.ts";
import { VIEW_TABLES, viewOf, writeView } from "./views.ts";

/** What this file uses of the object's storage: its SQLite, and its transactions (a Durable Object's SQLite takes no BEGIN of its own). */
export type RebuildStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** The tables the pages' views are, by the statements that make them: the names after `CREATE TABLE IF NOT EXISTS`. */
const VIEW_TABLE_NAMES: readonly string[] = VIEW_TABLES.flatMap((statement) => /^CREATE TABLE IF NOT EXISTS (view_[a-z_]+) /.exec(statement)?.[1] ?? []);

/** What a staged table is called: the object's own name with this in front. */
const STAGE = "rebuild_";

/**
 * A statement of card-table.ts or views.ts with the staged tables in place
 * of the object's own: every name that starts with `view_` (the tables of
 * the views and their indexes), and the card state table where a statement
 * names it as a table. The statements that go through this are the ones
 * that make those tables, `readCard`, `writeCard` and `writeView`, and
 * `checkStaged` refuses any other table.
 */
function stagedStatement(statement: string): string {
  return statement.replace(/\bview_/g, `${STAGE}view_`).replace(/\b(FROM|INTO|EXISTS) cards\b/g, `$1 ${STAGE}cards`);
}

/** Throws unless every table a staged statement names is a staged one: a statement that would read or write the object's own tables never runs. */
function checkStaged(statement: string): void {
  // Where a statement names a table or an index: after FROM, INTO, JOIN, INDEXED BY, UPDATE (not the UPDATE of ON CONFLICT … DO UPDATE SET),
  // CREATE TABLE and CREATE INDEX with their IF NOT EXISTS, the ON of CREATE INDEX, and DROP … IF EXISTS.
  const names = [
    ...statement.matchAll(/\b(?:FROM|INTO|JOIN|INDEXED BY)\s+([A-Za-z_]+)/g),
    ...statement.matchAll(/\bUPDATE\s+(?!SET\b)([A-Za-z_]+)/g),
    ...statement.matchAll(/\b(?:TABLE|INDEX) IF NOT EXISTS\s+([A-Za-z_]+)(?:\s+ON\s+([A-Za-z_]+))?/g),
    ...statement.matchAll(/\bDROP (?:TABLE|INDEX) IF EXISTS\s+([A-Za-z_]+)/g),
  ].flatMap((m) => m.slice(1).filter((name) => name !== undefined));
  if (names.length === 0) throw new Error("rebuild: a staged statement names no table");
  for (const name of names) if (!name.startsWith(STAGE)) throw new Error(`rebuild: a staged statement names ${name}`);
}

/** The object's storage, for card-table.ts and views.ts to read and write the staged tables through. */
function staged(sql: SqlStorage): SqlStorage {
  return {
    exec: (statement: string, ...bindings: unknown[]) => {
      const to = stagedStatement(statement);
      checkStaged(to);
      return sql.exec(to, ...bindings);
    },
  } as unknown as SqlStorage;
}

/**
 * The one table of this file that stays: what the last rebuild was and how
 * far it is. A new table, so SCHEMA_VERSION is unchanged (proof-log.ts).
 *
 * `token` names the rebuild (the operator's, proof-log.ts); `status` is
 * `running`, `swapped` or `refused`; `source` is where the records are read
 * from, `object` (the files this object moved and the records it keeps) or
 * `bucket` (the files of the data bucket alone); `records` how many records
 * are applied so far and `fingerprint` the proof log fingerprint after them;
 * `latest_date` the latest date among them; `published_count` and
 * `published_fingerprint` the last line of the fingerprint file, what the
 * result is compared with, NULL for a proof log never published, and
 * `fingerprint_at_published` what was computed at that count; `reason` why
 * nothing was put in place, for `refused`.
 */
export const REBUILD_STATE_TABLE = `CREATE TABLE IF NOT EXISTS rebuild_state (
   id                       INTEGER PRIMARY KEY CHECK (id = 1),
   token                    TEXT    NOT NULL,
   status                   TEXT    NOT NULL,
   source                   TEXT    NOT NULL,
   records                  INTEGER NOT NULL,
   fingerprint              TEXT    NOT NULL,
   latest_date              TEXT,
   published_count          INTEGER,
   published_fingerprint    TEXT,
   published_date           TEXT,
   fingerprint_at_published TEXT,
   reason                   TEXT,
   started_ms               INTEGER NOT NULL,
   ended_ms                 INTEGER
 )`;

/** The staged tables besides those of the cards and the views: the same columns as the object's own (proof-log.ts, `TABLES`), and the challenges of the last records. */
const OTHER_STAGED_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${STAGE}records (seq INTEGER PRIMARY KEY, line TEXT NOT NULL, record_hash TEXT NOT NULL, fingerprint TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${STAGE}full_files (records_before INTEGER PRIMARY KEY, fingerprint_after TEXT NOT NULL, file_sha256 TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ${STAGE}published (date TEXT PRIMARY KEY, count INTEGER NOT NULL, fingerprint TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS ${STAGE}challenges (challenge TEXT PRIMARY KEY) WITHOUT ROWID`,
];

/** Every staged table, by its name. */
const STAGED_TABLE_NAMES: readonly string[] = [...VIEW_TABLE_NAMES.map((name) => STAGE + name), `${STAGE}cards`, `${STAGE}cards_at_published`, `${STAGE}records`, `${STAGE}full_files`, `${STAGE}published`, `${STAGE}challenges`];

export type RebuildStatus = "running" | "swapped" | "refused";

/** What is known of the last rebuild: `rebuildProgress`. */
export interface RebuildProgress {
  readonly token: string;
  readonly status: RebuildStatus;
  /** The number of records applied so far; for one that ended, how far it came. */
  readonly records: number;
  /** Why nothing was put in place; null unless `status` is `refused`. */
  readonly reason: string | null;
}

/** Why a rebuild ends without putting anything in place. The message is the reason, as the operator reads it. */
export class RebuildRefused extends Error {}

interface StateRow extends Record<string, SqlStorageValue> {
  token: string;
  status: string;
  source: string;
  records: number;
  fingerprint: string;
  latest_date: string | null;
  published_count: number | null;
  published_fingerprint: string | null;
  published_date: string | null;
  fingerprint_at_published: string | null;
  reason: string | null;
}

function stateRow(sql: SqlStorage): StateRow | null {
  return sql.exec<StateRow>("SELECT token, status, source, records, fingerprint, latest_date, published_count, published_fingerprint, published_date, fingerprint_at_published, reason FROM rebuild_state WHERE id = 1").toArray()[0] ?? null;
}

/** The last rebuild this object began, or null if it never began one. */
export function rebuildProgress(sql: SqlStorage): RebuildProgress | null {
  const row = stateRow(sql);
  if (row === null) return null;
  if (row.status !== "running" && row.status !== "swapped" && row.status !== "refused") throw new Error("rebuild_state: a status that is none");
  return { token: row.token, status: row.status, records: row.records, reason: row.reason };
}

function dropStaged(sql: SqlStorage): void {
  for (const name of STAGED_TABLE_NAMES) sql.exec(`DROP TABLE IF EXISTS ${name}`);
}

/** The lines of the fingerprint file as the bucket has it, or none without a file. Throws `RebuildRefused` for a file that is not lines written from the template, in order of date. */
async function fingerprintFileLines(bucket: FileBucket): Promise<FingerprintLine[]> {
  const stored = await bucket.get(FINGERPRINT_FILE);
  if (stored === null) return [];
  const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(await stored.arrayBuffer());
  const lines: FingerprintLine[] = [];
  for (const piece of text.split("\n").slice(0, -1)) {
    let line: FingerprintLine | null = null;
    try {
      const v = JSON.parse(piece) as { date?: unknown; count?: unknown; fingerprint?: unknown };
      const date = typeof v.date === "string" ? parseDay(v.date) : null;
      if (date !== null && typeof v.count === "number" && typeof v.fingerprint === "string") line = { date, count: v.count, fingerprint: v.fingerprint };
      if (line !== null && fingerprintLine(line) !== `${piece}\n`) line = null;
    } catch {
      line = null;
    }
    const before = lines.at(-1);
    if (line === null || (before !== undefined && (line.date <= before.date || line.count < before.count))) throw new RebuildRefused("the fingerprint file in the data bucket is not lines of the fingerprint file in order");
    lines.push(line);
  }
  if (!text.endsWith("\n") && text !== "") throw new RebuildRefused("the fingerprint file in the data bucket does not end with a line");
  return lines;
}

/**
 * Begins the rebuild named `token`, in place of any rebuild begun before:
 * makes the staged tables, empty, and notes what the result will be compared
 * with. An object that has no record, no full file and no published line
 * reads the proof log from the data bucket alone, with the bucket's
 * fingerprint file; every other object reads the files it moved, each by the
 * SHA-256 it wrote it with, and the records it keeps, and is compared with
 * its own last published line.
 */
export async function beginRebuild(storage: RebuildStorage, bucket: FileBucket, token: string, time: number): Promise<void> {
  const sql = storage.sql;
  const own = sql.exec<{ count: number; kept: number; files: number; lines: number }>("SELECT (SELECT count FROM proof_log WHERE id = 1) AS count, (SELECT COUNT(*) FROM records) AS kept, (SELECT COUNT(*) FROM full_files) AS files, (SELECT COUNT(*) FROM published) AS lines").one();
  const fromBucket = own.count === 0 && own.kept === 0 && own.files === 0 && own.lines === 0;
  const bucketLines = fromBucket ? await fingerprintFileLines(bucket) : [];
  const lastOwn = sql.exec<{ date: string; count: number; fingerprint: string }>("SELECT date, count, fingerprint FROM published ORDER BY date DESC LIMIT 1").toArray()[0];
  const last = fromBucket ? bucketLines.at(-1) : lastOwn === undefined ? undefined : { date: parseDay(lastOwn.date), count: lastOwn.count, fingerprint: lastOwn.fingerprint };
  if (last !== undefined && last.date === null) throw new Error("published: a date is not a date");
  storage.transactionSync(() => {
    dropStaged(sql);
    const to = staged(sql);
    to.exec(CARD_TABLE);
    for (const statement of VIEW_TABLES) to.exec(statement);
    for (const statement of OTHER_STAGED_TABLES) sql.exec(statement);
    for (const line of bucketLines) sql.exec(`INSERT INTO ${STAGE}published (date, count, fingerprint) VALUES (?, ?, ?)`, formatDay(line.date), line.count, line.fingerprint);
    sql.exec("DELETE FROM rebuild_state");
    sql.exec(
      "INSERT INTO rebuild_state (id, token, status, source, records, fingerprint, published_count, published_fingerprint, published_date, started_ms) VALUES (1, ?, 'running', ?, 0, ?, ?, ?, ?, ?)",
      token,
      fromBucket ? "bucket" : "object",
      EMPTY_FINGERPRINT,
      last?.count ?? null,
      last?.fingerprint ?? null,
      last === undefined ? null : formatDay(last.date!),
      time,
    );
    // A last line of no records: the states at that count are no state at all, kept now, before any record is applied.
    if (last?.count === 0) snapshotAtPublished(sql);
  });
}

/** What a step reads of the proof log: lines in order, the first being the record after those applied so far. */
interface Run {
  readonly lines: readonly string[];
  /** For a full file of the bucket source: its SHA-256, to note among the full files. */
  readonly fileSha256: string | null;
  /** Whether these are the proof log's last records. */
  readonly last: boolean;
  /** For the object's own source: what the object keeps of the proof log fingerprint after these lines. */
  readonly ownFingerprintAfter: string | null;
}

/** A log file of the data bucket as it is there, whatever it holds: its lines, each with its LF, and its SHA-256; null without a file. */
async function fileOfBucket(bucket: FileBucket, before: number): Promise<{ lines: string[]; sha256: string } | null> {
  const key = PROOF_LOG_DIRECTORY + proofLogFileName(before);
  const stored = await bucket.get(key);
  if (stored === null) return null;
  const bytes = new Uint8Array(await stored.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new RebuildRefused(`${key} is not UTF-8`);
  }
  if (text !== "" && !text.endsWith("\n")) throw new RebuildRefused(`${key} does not end with LF`);
  const lines = text.split("\n").slice(0, -1).map((line) => `${line}\n`);
  if (lines.length > LINES_PER_FILE) throw new RebuildRefused(`${key} has more than ${LINES_PER_FILE} lines`);
  return { lines, sha256: await sha256Hex(bytes) };
}

/** The next run of lines after the first `applied` records. */
async function nextRun(sql: SqlStorage, bucket: FileBucket, source: string, applied: number): Promise<Run> {
  if (applied % LINES_PER_FILE !== 0) throw new Error("rebuild: a step does not begin at a log file");
  if (source === "bucket") {
    const file = await fileOfBucket(bucket, applied);
    if (file === null) return { lines: [], fileSha256: null, last: true, ownFingerprintAfter: null };
    const full = file.lines.length === LINES_PER_FILE;
    return { lines: file.lines, fileSha256: full ? file.sha256 : null, last: !full, ownFingerprintAfter: null };
  }
  const file = sql.exec<{ file_sha256: string; fingerprint_after: string }>("SELECT file_sha256, fingerprint_after FROM full_files WHERE records_before = ?", applied).toArray()[0];
  if (file !== undefined) {
    // A bucket that does not answer throws here, and the step is tried again; a file that is not the one this object
    // wrote ends the rebuild, with what the operator has to look at.
    const stored = await fileOfBucket(bucket, applied);
    const key = PROOF_LOG_DIRECTORY + proofLogFileName(applied);
    if (stored === null) throw new RebuildRefused(`${key} is not in the bucket`);
    if (stored.sha256 !== file.file_sha256) throw new RebuildRefused(`${key} is not the bytes that were written`);
    if (stored.lines.length !== LINES_PER_FILE) throw new RebuildRefused(`${key} is not ${LINES_PER_FILE} lines`);
    const lines = stored.lines;
    return { lines, fileSha256: null, last: false, ownFingerprintAfter: file.fingerprint_after };
  }
  const kept = sql.exec<{ seq: number; line: string; fingerprint: string }>("SELECT seq, line, fingerprint FROM records ORDER BY seq").toArray();
  if (kept.length > 0 && kept[0]!.seq !== applied + 1) throw new RebuildRefused("the records the object keeps do not begin after its full files");
  return { lines: kept.map((row) => row.line), fileSha256: null, last: true, ownFingerprintAfter: kept.at(-1)?.fingerprint ?? null };
}

/** What a step needs besides the storage and the bucket. */
export interface RebuildParts {
  readonly kind: ProofLogKind;
  readonly platforms: readonly PlatformRow[];
  /** Today's date in Taiwan: the challenges of records dated the day before it or later are kept as used. */
  readonly today: Day;
  /** The object's clock, in milliseconds. */
  readonly time: number;
}

/**
 * One step of the rebuild that is running: reads the next log file, or the
 * records the object keeps, applies them, and, after the last of them,
 * compares and puts the result in place. Returns whether another step is
 * needed.
 *
 * Throws `RebuildRefused` when the rebuild cannot end with a swap: the
 * rebuild is then over, `refused`, with that reason, and the staged tables
 * are dropped. That is every failure but one: a bucket that does not answer
 * throws whatever it throws, and leaves the rebuild as it was before the
 * step, to be tried again.
 */
export async function rebuildStep(storage: RebuildStorage, bucket: FileBucket, parts: RebuildParts): Promise<"more" | "done"> {
  const sql = storage.sql;
  const state = stateRow(sql);
  if (state === null || state.status !== "running") throw new Error("rebuild: no rebuild is running");
  try {
    const run = await nextRun(sql, bucket, state.source, state.records);
    // The hashes first: they wait, and nothing is written while anything waits.
    let fingerprint = state.fingerprint;
    let atPublished = state.fingerprint_at_published ?? (state.published_count === 0 ? EMPTY_FINGERPRINT : null);
    const applied: { seq: number; line: string; hash: string; fingerprint: string }[] = [];
    for (const [i, line] of run.lines.entries()) {
      const seq = state.records + i + 1;
      const record = readRecordLine(parts.kind, line);
      if (record === null || record.seq !== seq) throw new RebuildRefused(`record ${seq} is not a well-formed line of the proof log`);
      const hash = await recordHash(record);
      fingerprint = await nextFingerprint(fingerprint, hash);
      if (seq === state.published_count) atPublished = fingerprint;
      applied.push({ seq, line, hash, fingerprint });
    }
    if (run.ownFingerprintAfter !== null && run.ownFingerprintAfter !== fingerprint) throw new RebuildRefused(`the proof log fingerprint after record ${state.records + run.lines.length} is not the one the object kept`);

    const to = staged(sql);
    const count = state.records + run.lines.length;
    let latest = state.latest_date === null ? null : parseDay(state.latest_date);
    const apply = (): void => {
      for (const row of applied) {
        const record = readRecordLine(parts.kind, row.line)!;
        const date = parseChallenge(record.challenge);
        if (date === null) throw new RebuildRefused(`record ${row.seq} has a challenge without a date`);
        const stored = readCard(to, parts.platforms, record.scopeString, record.scopedId);
        const before = stored?.card ?? newCard(parts.platforms);
        const outcome = applyList(parts.platforms, before, record.accounts, date);
        if (!outcome.result.valid) throw new RebuildRefused(`record ${row.seq} is not one the record rules of this build take (${outcome.result.reason})`);
        // The back end's count of the card's records of the date, whatever its daily limit was when they were written.
        writeCard(to, record.scopeString, record.scopedId, outcome.card, recordsOnDate(before.lastCardProof, stored?.proofsOnLastDate ?? 0, date) + 1, row.seq);
        writeView(to, viewOf(record, date, outcome.result.kinds, before, outcome.card));
        if (latest === null || date > latest) latest = date;
        // A challenge is good for ten minutes and carries its date: one of an earlier date than yesterday's has expired.
        if (date >= parts.today - 1) sql.exec(`INSERT OR IGNORE INTO ${STAGE}challenges (challenge) VALUES (?)`, record.challenge);
        if (state.source === "bucket" && run.fileSha256 === null) sql.exec(`INSERT INTO ${STAGE}records (seq, line, record_hash, fingerprint) VALUES (?, ?, ?, ?)`, row.seq, row.line, row.hash, row.fingerprint);
        // The states after exactly the published count: what the card state file of that line is written from.
        if (row.seq === state.published_count) snapshotAtPublished(sql);
      }
      if (run.fileSha256 !== null) sql.exec(`INSERT INTO ${STAGE}full_files (records_before, fingerprint_after, file_sha256) VALUES (?, ?, ?)`, state.records, fingerprint, run.fileSha256);
      sql.exec("UPDATE rebuild_state SET records = ?, fingerprint = ?, latest_date = ?, fingerprint_at_published = ? WHERE id = 1", count, fingerprint, latest === null ? null : formatDay(latest), atPublished);
      if (run.last) {
        // Read from the bucket alone, there is nothing but the fingerprint file to say that these files are the proof log.
        if (state.source === "bucket" && state.published_count === null && count > 0) throw new RebuildRefused("the data bucket has log files and no line of the fingerprint file to compare them with");
        if (state.published_count !== null) {
          if (count < state.published_count) throw new RebuildRefused(`the proof log has ${count} records, fewer than the ${state.published_count} of the last line of the fingerprint file`);
          if (atPublished !== state.published_fingerprint) throw new RebuildRefused(`the proof log fingerprint after ${state.published_count} records is not the one of the last line of the fingerprint file`);
        }
        swap(sql, state.source, count, fingerprint, latest, parts.time);
      }
    };
    try {
      storage.transactionSync(apply);
    } catch (e) {
      // Nothing in the transaction waits for anything, so what failed there fails the same way at every try: a row the
      // tables do not take, a state that is none. The rebuild ends rather than hold card proofs back for good. Only
      // the kind of the error is kept, as in the object's log lines: a message can carry what a record holds.
      if (e instanceof RebuildRefused) throw e;
      throw new RebuildRefused(`the records after record ${state.records} could not be applied (${e instanceof Error ? e.name : "unknown"})`);
    }
    return run.last ? "done" : "more";
  } catch (e) {
    if (e instanceof RebuildRefused) {
      storage.transactionSync(() => {
        dropStaged(sql);
        sql.exec("UPDATE rebuild_state SET status = 'refused', reason = ?, ended_ms = ? WHERE id = 1", e.message, parts.time);
      });
    }
    throw e;
  }
}

/** Keeps the staged states of the cards as they are at this moment, in place of any kept before. */
function snapshotAtPublished(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS ${STAGE}cards_at_published`);
  sql.exec(`CREATE TABLE ${STAGE}cards_at_published AS SELECT * FROM ${STAGE}cards`);
}

/** The name the states at the published count are left under after a swap, for the object to write the card state file from; dropped by `dropPublishedStates`. */
export const PUBLISHED_STATES = "rebuilt_cards_at_published";

/**
 * Puts what was computed in place of what the object has, inside the
 * caller's transaction: the states of the cards, the views, the row of the
 * proof log (with this build's version of the record rules), the used
 * challenges, and for the bucket source the records, the full files and the
 * published lines. Nothing of it is read back through JavaScript. The
 * states at the published count are left under `PUBLISHED_STATES`.
 */
function swap(sql: SqlStorage, source: string, count: number, fingerprint: string, latest: Day | null, time: number): void {
  for (const name of ["cards", ...VIEW_TABLE_NAMES]) {
    sql.exec(`DELETE FROM ${name}`);
    sql.exec(`INSERT INTO ${name} SELECT * FROM ${STAGE}${name}`);
  }
  sql.exec("UPDATE proof_log SET count = ?, fingerprint = ?, latest_valid_date = ?, rules_version = ? WHERE id = 1", count, fingerprint, latest === null ? null : formatDay(latest), RULES_VERSION);
  // Every challenge issued before is gone (ADR-0033: a holder asks for another); the used ones of the last records are refused as used until they expire.
  sql.exec("DELETE FROM challenges");
  sql.exec(`INSERT INTO challenges (challenge, issued_ms, submissions, accepted) SELECT challenge, ?, 1, 1 FROM ${STAGE}challenges`, time);
  if (source === "bucket") {
    sql.exec(`INSERT INTO records (seq, line, record_hash, fingerprint) SELECT seq, line, record_hash, fingerprint FROM ${STAGE}records`);
    sql.exec(`INSERT INTO full_files (records_before, fingerprint_after, file_sha256) SELECT records_before, fingerprint_after, file_sha256 FROM ${STAGE}full_files`);
    sql.exec(`INSERT INTO published (date, count, fingerprint, in_bucket) SELECT date, count, fingerprint, 1 FROM ${STAGE}published`);
  }
  sql.exec(`DROP TABLE IF EXISTS ${PUBLISHED_STATES}`);
  if (sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${STAGE}cards_at_published'`).one().n === 1) sql.exec(`ALTER TABLE ${STAGE}cards_at_published RENAME TO ${PUBLISHED_STATES}`);
  dropStaged(sql);
  sql.exec("UPDATE rebuild_state SET status = 'swapped', ended_ms = ? WHERE id = 1", time);
}

/** The date of the published line the states under `PUBLISHED_STATES` are those of, or null when there are none to write a card state file from. */
export function publishedStatesDate(sql: SqlStorage): Day | null {
  if (sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${PUBLISHED_STATES}'`).one().n === 0) return null;
  const date = stateRow(sql)?.published_date ?? null;
  return date === null ? null : parseDay(date);
}

/** Drops the states kept for the card state file, once it is written. */
export function dropPublishedStates(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS ${PUBLISHED_STATES}`);
}
