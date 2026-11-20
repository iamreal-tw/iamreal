// One roster is one Durable Object, the roster's only writer (ADR-0023).
// It issues challenges, counts the submissions of each, writes the records,
// answers for the state of a card, and keeps the newest CRLs the CRL mirror
// tells it of.
//
// What it keeps, in its SQLite:
//
//   challenges   the challenges it issued that have not expired
//   records      the records of the roster files that are not in the data
//                bucket yet, each as its line of the roster file
//   full_files   the full roster files that were moved to the data bucket
//   cards        the roster rules' state of each card (card-table.ts)
//   cards_copy   a copy of `cards`, only while the roster is being
//                published (card-table.ts, `copyCards`)
//   roster       one row: what is true of the roster as a whole
//   newest_crls  the newest CRLs, as the CRL mirror last told them
//   published    the lines of the fingerprint file: the days the roster was
//                published on
//   first_day    one row: the date the roster is published after
//   view_*       the views: what the visitors' pages read (views.ts)
//
// The views are derived from the records: they are written with each record,
// in its transaction, and can be cleared and written again from the records
// at any time. The rules' state (`cards`) cannot: it is kept apart from
// them, and nothing that decides about a record reads a view.
//
// Whether a record is valid is never decided here: that is the roster rules'
// (protocol/, applyRecord), called with the state this object keeps. What
// this file decides is the back end's own: the challenge, which roots it
// takes today, and its policy on switches (docs/api/card-proof.md).
import { DurableObject } from "cloudflare:workers";
import { now } from "#target";
import { encodeBase32 } from "iamreal-protocol/base32.ts";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { type CardRow, cardStateFileWriter } from "iamreal-protocol/card-state-file.ts";
import { type Day, formatDay, parseDay, startOfTaiwanDay, taiwanDay } from "iamreal-protocol/date.ts";
import { EMPTY_FINGERPRINT, type FingerprintLine, LINES_PER_FILE, type RecordFields, type RosterRecord, fingerprintLine, hashList, hashListName, nextFingerprint, readRecordLine, recordHash, recordLine, rosterFileName } from "iamreal-protocol/record.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { type CardState, EMPTY_SLOT, type Kind, type PlatformKind, RULES_VERSION, applyRecord, newCard } from "iamreal-protocol/roster-rules.ts";
import { CARD_TABLE, copiedCards, copyCards, dropCardsCopy, readCard, writeCard } from "./card-table.ts";
import { type NewestCrls, newestOfEach } from "./crl-index.ts";
import { ISSUER_NAMES } from "./issuers.ts";
import type { CardsOfShortId, Counts } from "./page-data.ts";
import { CACHE_DAILY, CACHE_FULL_FILE, FINGERPRINT_FILE, FULL_FILE_RETRY_MS, type FileBucket, type FileHeaders, ROSTER_DIRECTORY, TYPE_JSON_LINES, TYPE_TEXT, cardStateFileKey, lengthAndSha256, readFullFile, writeAndReadBack, writeStreamAndReadBack } from "./roster-files.ts";
import { type RosterSettings, rosterSettingsOf } from "./settings.ts";
import { type CardsSoFar, VIEW_TABLES, accountCards, cardsOfShortId, clearViews, counts, storedLines, viewOf, viewSeq, writeView, writeViewsOf } from "./views.ts";

/**
 * A challenge can be used for less than this long after it is issued
 * (docs/api/card-proof.md): one issued exactly this long ago has expired.
 */
export const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;

/** A challenge can be submitted at most this many times (docs/api/card-proof.md): the sixth submission is `challenge_attempts`. */
export const MAX_SUBMISSIONS = 5;

/**
 * No card proof is accepted when the newest CRL of the issuer is more than
 * this many days old (spec/revocation-tree.md, "Who checks what"); `config`
 * announces it to devices.
 */
export const CRL_MAX_AGE_DAYS = 3;

/**
 * The first switch of a slot that the back end's policy on late switches
 * refuses when it is on: the fourth (settings.ts, `restrictLateSwitches`).
 * The roster rules allow five.
 */
export const RESTRICTED_FROM = 4;

/**
 * The tables. Every statement can run again on an object that has them.
 *
 * challenges: one row per challenge issued and not yet expired
 * (spec/challenge.md). `issued_ms` is when, in milliseconds since the epoch;
 * `submissions` how many times it was submitted (at most 5 count);
 * `accepted` is 1 once a record was written for it. Expired rows are deleted
 * (the timed work below), so a challenge that is not here is unknown.
 *
 * records: one row per record that is not in a roster file of the data
 * bucket yet: the records of the last roster file, which is not full, and
 * of a full one until it is moved (`#moveFile`). `seq` is the record's;
 * `line` its line of the roster file, the LF included, so that a roster
 * file is its lines in the order of `seq`, one after the other
 * (spec/record.md, "Lines and files"); `record_hash` its record hash;
 * `fingerprint` the roster fingerprint once it is added,
 * `fingerprint(seq)`. The table came after the first three, with
 * SCHEMA_VERSION unchanged.
 *
 * full_files: one row per full roster file that is in the data bucket and
 * whose records this object therefore no longer keeps (spec/record.md, "The
 * published roster"). `records_before` is the number of records before the
 * file, the number in its name; `fingerprint_after` the roster fingerprint
 * at its end, `fingerprint(records_before + 1000)`, which is the first line
 * of the next file's record hash list; `file_sha256` the SHA-256 of the
 * file's bytes as they were written and read back. The files are those of
 * `records_before` 0, 1000, 2000 and so on, without a gap, and the rows of
 * `records` begin right after the last of them. The table came after the
 * others, with SCHEMA_VERSION unchanged.
 *
 * roster: exactly one row (`id` 1), written when the object first starts.
 * `count` is the number of records; `fingerprint` their roster fingerprint;
 * `latest_valid_date` the latest date among the valid records,
 * `YYYY-MM-DD`, or NULL without one; `rules_version` the version of the
 * roster rules the rows of `cards` were computed by (spec/roster-rules.md,
 * "The version number"); `schema_version` the SCHEMA_VERSION of the build
 * that made the tables.
 *
 * published: one row per line of the fingerprint file (spec/record.md,
 * "The published roster"): a date in Taiwan on which the roster was
 * published, `YYYY-MM-DD`, with the number of records and the roster
 * fingerprint read at that moment. A row is written once and never changed
 * or deleted: the line of a date does not change. The table is the
 * fingerprint file's source; the file in the data bucket is written from
 * it, whole, and read only to see that it is the beginning of what is
 * written over it (`#fingerprintFileToWrite`). `in_bucket` is 0 from the moment the row is
 * written until the fingerprint file was written with its line and read
 * back, then 1. The table came after the others, with SCHEMA_VERSION
 * unchanged.
 *
 * first_day: exactly one row (`id` 1), written when an object first
 * starts with a build that publishes: `date` is the date in Taiwan of that
 * start. The roster is first published when the date after it begins, not
 * on the day the object, or the build, is new. SCHEMA_VERSION is unchanged.
 *
 * newest_crls: for each issuer key, its newest usable CRLs as the CRL mirror
 * last told them (src/mirror.ts): `place` 0 is the newest. `root` is the
 * root of the CRL's tree, 64 lowercase hex digits; `crl_number` its
 * cRLNumber in decimal; `crl_date` its CRL date, `YYYY-MM-DD`. The table
 * came after the others, with SCHEMA_VERSION unchanged: an object that was
 * made without it gets it, empty, when it next starts.
 */
const TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS challenges (
     challenge   TEXT    PRIMARY KEY,
     issued_ms   INTEGER NOT NULL,
     submissions INTEGER NOT NULL DEFAULT 0,
     accepted    INTEGER NOT NULL DEFAULT 0
   ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS challenges_issued ON challenges (issued_ms)",
  `CREATE TABLE IF NOT EXISTS records (
     seq         INTEGER PRIMARY KEY,
     line        TEXT    NOT NULL,
     record_hash TEXT    NOT NULL,
     fingerprint TEXT    NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS full_files (
     records_before    INTEGER PRIMARY KEY,
     fingerprint_after TEXT    NOT NULL,
     file_sha256       TEXT    NOT NULL
   )`,
  CARD_TABLE,
  `CREATE TABLE IF NOT EXISTS roster (
     id                INTEGER PRIMARY KEY CHECK (id = 1),
     count             INTEGER NOT NULL,
     fingerprint       TEXT    NOT NULL,
     latest_valid_date TEXT,
     rules_version     INTEGER NOT NULL,
     schema_version    INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS newest_crls (
     issuer     TEXT    NOT NULL,
     place      INTEGER NOT NULL,
     root       TEXT    NOT NULL,
     crl_number TEXT    NOT NULL,
     crl_date   TEXT    NOT NULL,
     PRIMARY KEY (issuer, place)
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS published (
     date        TEXT    PRIMARY KEY,
     count       INTEGER NOT NULL,
     fingerprint TEXT    NOT NULL,
     in_bucket   INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS first_day (
     id   INTEGER PRIMARY KEY CHECK (id = 1),
     date TEXT    NOT NULL
   )`,
  // The views (views.ts). They came after the others, with SCHEMA_VERSION unchanged: an object made without them
  // gets them when it next starts, and fills them from its records (the constructor).
  ...VIEW_TABLES,
];

/**
 * The version of the tables above, as this build makes and reads them.
 *
 * **Add one whenever a table that already exists changes**: a column added
 * or removed, a column that comes to mean something else, another primary
 * key. A new table, or a new index, does not change it: the statements
 * above make those on an object that lacks them.
 *
 * An object keeps the version its tables were made by (`roster`,
 * `schema_version`) and compares when it starts. If it is not this one, the
 * object reads and writes nothing more: `CREATE TABLE IF NOT EXISTS` left
 * its tables as they were, and this build would read them wrongly. There is
 * no code that carries tables from one version to the next; the way out is
 * a new object (README.md, "兩個版本號").
 *
 * It is not the version of the roster rules (`rules_version`,
 * protocol/'s RULES_VERSION), which says what the stored state of the cards
 * was computed by.
 */
export const SCHEMA_VERSION = 1;

/**
 * The message of the error every method throws when the object's tables
 * were made by another SCHEMA_VERSION. The Worker tells this failure from
 * any other by it (api.ts); it is never written anywhere.
 */
export const OTHER_SCHEMA = "the object's tables were made by another SCHEMA_VERSION";

/** What the object throws for what needs the views while they are not at the last record (`#viewsAtLastRecord`). */
export const VIEWS_BEHIND = "the object's views are not at its last record";

/** Why the object does not take a submission: the roster is paused, or the challenge is not one to submit (docs/api/card-proof.md). */
export type SubmissionRefusal = "paused" | "challenge_unknown" | "challenge_used" | "challenge_attempts";

/** Why the object does not write a record whose proof verified, in the order of docs/api/card-proof.md. */
export type RecordRefusal = "paused" | "challenge_unknown" | "challenge_used" | "crl_stale" | "root" | "date_order" | "empty" | "switch_limit" | "daily_limit" | "switch_restricted";

/** What a record that was written did on one platform (docs/api/card-proof.md, `kinds`). */
export interface AcceptedKind {
  readonly platform: string;
  readonly kind: Kind;
  /** The account: the one the list has for the platform, or for `withdraw` the one that was withdrawn. */
  readonly username: string;
  /** The number of cards whose `current` on the platform is that username, in the record's scope, once the record is applied. */
  readonly accountCards: number;
}

/** A record that was written. */
export interface Accepted {
  readonly seq: number;
  readonly recordHash: string;
  /** In ascending order of platform; at least one. */
  readonly kinds: readonly AcceptedKind[];
}

/** What `accept` answers: the record that was written, or why none was. */
export type AcceptAnswer = { readonly outcome: "written"; readonly record: Accepted } | { readonly outcome: "refused"; readonly code: RecordRefusal };

const refused = (code: RecordRefusal): AcceptAnswer => ({ outcome: "refused", code });

/** What one try of `accept` at a count gives: an answer, or that the count is no longer the one the record's `seq` was taken from. */
type AcceptTry = AcceptAnswer | { readonly outcome: "the count moved" };

/** What `card-state` is answered from. */
export interface CardStateAnswer {
  /** The state of the card as the rules left it, or null if it has no valid record. */
  readonly card: CardState | null;
  /** The number of records the state was computed at. */
  readonly count: number;
}

/**
 * Something the object does at a time of its own choosing. An object has
 * one alarm (https://developers.cloudflare.com/durable-objects/api/alarms/),
 * so every such piece of work is listed in `timedWork()`: the alarm is
 * always set for the earliest `due()` of them all, and when it rings, each
 * piece that is due runs once. A piece knows nothing of the others.
 */
export interface TimedWork {
  /** When it should next run, in milliseconds since the epoch on the object's clock; null when it has nothing to do. */
  due(): number | null;
  /** Does the work; `time` is the object's clock. Afterwards `due()` is later than `time`, or null. */
  run(time: number): void | Promise<void>;
}

/** The least the alarm waits, so that work that stays due cannot make the alarm spin. */
const MIN_ALARM_WAIT_MS = 1000;

/**
 * How many rows of the card state file are read and written at a time: a
 * row is some 350 bytes with one slot, so a batch is a few hundred
 * kilobytes, however many cards there are.
 */
const CARD_STATE_BATCH = 1000;

/** How long after the roster could not be published the object tries again: one minute, as for a full file that could not be moved. */
const PUBLICATION_RETRY_MS = 60 * 1000;

/**
 * The data bucket's fingerprint file is not the beginning of the one this
 * object would write: it has a line the object does not keep, or one that
 * is not the object's. The object then publishes nothing (`#publish`).
 */
class FingerprintFileDiffers extends Error {}

/** How long after views could not be filled the object tries again: one minute, as for a full file that could not be moved. */
const VIEWS_RETRY_MS = 60 * 1000;

/** The one line the object writes when something of its own fails: which, and the class of the error. Never the error's message, which may quote what was being handled. */
function logFailure(event: string, e: unknown): void {
  console.error(JSON.stringify({ event, error: e instanceof Error ? e.name : "unknown" }));
}

/**
 * The roster's Durable Object. (`Roster` is this class everywhere in
 * worker/; protocol/'s type of that name, which roster, is `RosterKind`
 * here: settings.ts.)
 */
export class Roster extends DurableObject<Env> {
  /**
   * The settings the object started with. This and the other `protected`
   * members below (`challengeRandom`, `hashOf`, `ruleState`,
   * `keepRuleState`, `timedWork`, `setAlarmForTimedWork`, `bucket`, `viewsFilling`) are `protected`
   * and not private for one reader: the object of the test build
   * (README.md, "三樣不是設定值的東西"), the only class that extends this
   * one. Nothing else overrides or calls them from outside this file.
   */
  protected readonly settings: RosterSettings;
  /** Whether the object's tables were made by this build's SCHEMA_VERSION. */
  readonly #tablesAreThisVersion: boolean;
  /**
   * Whether the stored state of the cards was computed by another version
   * of the roster rules than this build's (spec/roster-rules.md, "The
   * version number"). The object then issues no challenge and takes no
   * submission, so that no record is written from a state the rules of this
   * build did not leave; everything else goes on.
   */
  readonly #paused: boolean;
  /**
   * Whether the views the pages read (views.ts) reflect every record, as
   * the object found or made them when it started. When they do not, a page
   * would show a roster that is not this one (no card at all, or a card as
   * not found), and a record could not be written with its change to them:
   * the pages' reads and a submission then throw `VIEWS_BEHIND`, which the
   * Worker answers as its own failure. Challenges, card states and the CRL
   * archive do not read the views and go on. It is decided when the object
   * starts, and becomes true once more only when views that were behind
   * are filled (`#fillViews`), at the start or at a later try; the next
   * start decides again.
   */
  #viewsAtLastRecord: boolean;
  /**
   * The last filling of views that were behind: the one begun when the
   * object started, or a later try of it. It ends when they are filled or
   * could not be, and never fails. Already ended for an object that found
   * its views at the last record. `protected` so that the test build can
   * wait for it; nothing else reads it from outside this file.
   */
  protected viewsFilling: Promise<void>;
  /** When views that could not be filled are tried again, on the object's clock; null when no try is owed. Kept in memory. */
  #fillAgainAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Before anything is read or written: with settings that do not fit each
    // other (settings.ts) the object does not start. The Worker reads the
    // same settings before it asks the object, so it does not get this far.
    this.settings = rosterSettingsOf(env);
    const sql = ctx.storage.sql;
    for (const statement of TABLES) sql.exec(statement);
    // A new roster: no record, a state computed by the rules of this build,
    // tables made by this build. On an object that has the row this changes
    // nothing: neither version is ever brought up to the build's here.
    sql.exec(
      "INSERT OR IGNORE INTO roster (id, count, fingerprint, latest_valid_date, rules_version, schema_version) VALUES (1, 0, ?, NULL, ?, ?)",
      EMPTY_FINGERPRINT,
      RULES_VERSION,
      SCHEMA_VERSION,
    );
    const { schema_version, rules_version } = sql.exec<{ schema_version: number; rules_version: number }>("SELECT schema_version, rules_version FROM roster WHERE id = 1").one();
    this.#tablesAreThisVersion = schema_version === SCHEMA_VERSION;
    this.#paused = rules_version !== RULES_VERSION;
    // Views that are not at the last record are written again from the records: an object that has records
    // from before it had the views, or whose views were cleared. Not while the roster is paused: the stored
    // records were then taken by other rules than the ones this build would compute their kinds by.
    this.#viewsAtLastRecord = this.#tablesAreThisVersion && viewSeq(sql) === this.#rosterRow().count;
    this.viewsFilling = this.#tablesAreThisVersion && !this.#viewsAtLastRecord && !this.#paused ? this.#fillViews() : Promise.resolve();
    ctx.waitUntil(this.viewsFilling);
    if (this.#tablesAreThisVersion) {
      // The roster is published from the date after this one on (`#dailyPublication`); on an object that has the row this changes nothing.
      sql.exec("INSERT OR IGNORE INTO first_day (id, date) VALUES (1, ?)", formatDay(taiwanDay(now().getTime())));
      // An object that starts has its alarm set, once the constructor has returned (`timedWork` is a subclass's to
      // override): the daily publication is due at a time of day, whether or not anything is asked of the object.
      ctx.waitUntil(Promise.resolve().then(() => this.#setAlarmWithoutFailing()));
    }
  }

  /**
   * Clears the views and writes them again from every record of the
   * roster, in the order of `seq`: the full roster files in the data
   * bucket, each checked against the SHA-256 it was written with, then the
   * records this object keeps.
   *
   * - An object that keeps all its records does this in one transaction and
   *   without waiting for anything: it is done before the constructor
   *   returns, and a failure leaves the views as they were.
   * - With roster files in the bucket it reads them one at a time and
   *   writes each in a transaction of its own, so the views are behind
   *   while it runs and stay behind if it breaks off: until it ends well,
   *   what needs the views throws `VIEWS_BEHIND`. The object answers
   *   meanwhile. It is not held back with `blockConcurrencyWhile`: an
   *   object is reset when that takes more than 30 seconds (README.md,
   *   "頁面用的衍生表", has the sentence of Cloudflare's documentation),
   *   and this takes longer the more files the roster has.
   *
   * It can fail: the bucket does not answer, or does not have a file as it
   * was written; a line this build does not read, a record its rules do
   * not take. The object runs all the same, with views it does not use;
   * one line says so, and it is tried again a minute later (`#viewsBehind`)
   * and at the next start: a bucket that did not answer may answer then.
   * What is wrong with the records or the build fails again each time,
   * with its line. It never throws.
   */
  async #fillViews(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const { kind, platforms } = this.settings;
    const cards: CardsSoFar = new Map();
    try {
      const files = sql.exec<{ records_before: number; file_sha256: string }>("SELECT records_before, file_sha256 FROM full_files ORDER BY records_before").toArray();
      if (files.length === 0) {
        this.ctx.storage.transactionSync(() => {
          clearViews(sql);
          writeViewsOf(sql, kind, platforms, cards, storedLines(sql));
        });
      } else {
        this.ctx.storage.transactionSync(() => clearViews(sql));
        // The bucket is asked for once the constructor has returned: `bucket` is a subclass's to override, and
        // an object of a subclass is not whole before that.
        await Promise.resolve();
        for (const [i, file] of files.entries()) {
          if (file.records_before !== i * LINES_PER_FILE) throw new Error("the full files are not one after the other");
          const lines = await readFullFile(this.bucket(), file.records_before, file.file_sha256);
          this.ctx.storage.transactionSync(() => writeViewsOf(sql, kind, platforms, cards, lines.map((line, n) => ({ seq: file.records_before + n + 1, line }))));
        }
        // Nothing waits from here on: the records this object keeps are the ones after the last file read.
        this.ctx.storage.transactionSync(() => writeViewsOf(sql, kind, platforms, cards, storedLines(sql)));
      }
      if (viewSeq(sql) !== this.#rosterRow().count) throw new Error("the views are not at the last record after they were filled");
      this.#viewsAtLastRecord = true;
      this.#fillAgainAt = null;
    } catch (e) {
      logFailure("views_not_filled", e);
      this.#fillAgainAt = now().getTime() + VIEWS_RETRY_MS;
      // The alarm for the next try. A filling that failed before it waited for anything is still inside the
      // constructor, and the alarm is set once that has returned, for the same reason as above (`timedWork`).
      await Promise.resolve();
      await this.#setAlarmWithoutFailing();
    }
  }

  /**
   * Filling views that could not be filled, again: due a minute after a
   * filling failed, and not at all otherwise. No move of full files goes on
   * meanwhile: both are pieces of the alarm's work, which runs one piece
   * after the other.
   */
  #viewsBehind: TimedWork = {
    due: () => this.#fillAgainAt,
    run: async () => {
      this.#fillAgainAt = null;
      this.viewsFilling = this.#fillViews();
      await this.viewsFilling;
    },
  };

  /** For a method about to read the views, or to write a record with them: throws if they are not at the last record. */
  #checkViews(): void {
    this.#checkTables();
    if (!this.#viewsAtLastRecord) throw new Error(VIEWS_BEHIND);
  }

  /** For a method about to read or write the tables: throws if they were made by another SCHEMA_VERSION. */
  #checkTables(): void {
    if (!this.#tablesAreThisVersion) throw new Error(OTHER_SCHEMA);
  }

  /**
   * Issues a challenge (spec/challenge.md): today's date in Taiwan at this
   * moment and 16 random bytes. It is stored with the time before it is
   * given out, so a challenge anybody holds is one this object knows. None
   * is issued while the roster is paused: the challenge is then null.
   */
  async issueChallenge(): Promise<{ challenge: string | null }> {
    this.#checkTables();
    if (this.#paused) return { challenge: null };
    const issued = now().getTime();
    const challenge = `${formatDay(taiwanDay(issued))}.${encodeBase32(this.challengeRandom())}`;
    // A date outside 2000 to 2049 is not a challenge.
    if (parseChallenge(challenge) === null) throw new Error("the date is not one a challenge can have");
    this.ctx.storage.sql.exec("INSERT INTO challenges (challenge, issued_ms) VALUES (?, ?)", challenge, issued);
    await this.setAlarmForTimedWork();
    return { challenge };
  }

  /** The 16 random bytes of a new challenge. `protected` so that the test build can choose them, by overriding this; nothing else does. */
  protected challengeRandom(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(16));
  }

  /**
   * Counts one submission of a challenge, before its proof is verified, and
   * says whether the submission goes on. In the order of
   * docs/api/card-proof.md: a challenge this object did not issue, or issued
   * 10 minutes ago or more, is `challenge_unknown`; one a record was written
   * for is `challenge_used`, and is not counted; the sixth submission and
   * every later one is `challenge_attempts`.
   */
  beginSubmission(challenge: string): "ok" | SubmissionRefusal {
    this.#checkTables();
    if (this.#paused) return "paused";
    // Before the submission is counted: a record could not be written, and the challenge stays as it was.
    this.#checkViews();
    const row = this.#challenge(challenge);
    if (row === null) return "challenge_unknown";
    if (row.accepted) return "challenge_used";
    this.ctx.storage.sql.exec("UPDATE challenges SET submissions = submissions + 1 WHERE challenge = ?", challenge);
    return row.submissions + 1 > MAX_SUBMISSIONS ? "challenge_attempts" : "ok";
  }

  /** The row of a challenge that has not expired at this moment, or null: not issued here, expired, or already deleted. */
  #challenge(challenge: string): { submissions: number; accepted: boolean } | null {
    const row = this.ctx.storage.sql.exec<{ issued_ms: number; submissions: number; accepted: number }>("SELECT issued_ms, submissions, accepted FROM challenges WHERE challenge = ?", challenge).toArray()[0];
    if (row === undefined || now().getTime() - row.issued_ms >= CHALLENGE_LIFETIME_MS) return null;
    return { submissions: row.submissions, accepted: row.accepted !== 0 };
  }

  /**
   * Writes a record whose proof the Worker verified, if it is one to write.
   * `fields` are the record's fields except `seq`, each in its format. In
   * the order of docs/api/card-proof.md: the challenge again (a record may
   * have been written for it, or it may have expired, while the proof was
   * being verified); the back end's rule on `smt_root`; the roster rules;
   * the back end's policy on switches.
   *
   * The record's `seq` is the count of records plus one, and its hash needs
   * the `seq`. Hashing gives way to other requests, so the hash is computed
   * for the count as it is, and everything else, from the checks to the
   * write, then runs without giving way, and only if the count is still
   * that one; otherwise it starts over. So no two records get the same
   * `seq`, and each is checked against the state the one before it left.
   */
  async accept(fields: RecordFields): Promise<AcceptAnswer> {
    this.#checkTables();
    if (this.#paused) return refused("paused");
    this.#checkViews();
    for (;;) {
      const { count, fingerprint } = this.#rosterRow();
      const record: RosterRecord = { ...fields, seq: count + 1 };
      const hash = await this.hashOf(record);
      const answer = this.#acceptAt(record, hash, await nextFingerprint(fingerprint, hash));
      if (answer.outcome === "the count moved") continue;
      // The record that fills a roster file: the file is due for the data bucket (`#fullFiles`). The record is
      // written whatever becomes of that, so its answer waits for the alarm to be set and for nothing more.
      if (answer.outcome === "written" && answer.record.seq % LINES_PER_FILE === 0) await this.#setAlarmWithoutFailing();
      return answer;
    }
  }

  /**
   * Sets the alarm without ever failing what asked for it: a record that
   * is in the roster by then, a filling of the views that has ended. An
   * alarm that could not be set is set by whatever next sets it (the next
   * challenge).
   */
  async #setAlarmWithoutFailing(): Promise<void> {
    try {
      await this.setAlarmForTimedWork();
    } catch (e) {
      logFailure("alarm_not_set", e);
    }
  }

  /**
   * The record hash of a record (protocol/, recordHash). A method of its
   * own for the test build alone, whose object overrides it to wait before
   * the hash, so that other requests run in between, which is what the
   * check of the count in `accept` is for. Nothing else overrides or calls
   * it.
   */
  protected hashOf(record: RosterRecord): Promise<string> {
    return recordHash(record);
  }

  #rosterRow(): { count: number; fingerprint: string } {
    return this.ctx.storage.sql.exec<{ count: number; fingerprint: string }>("SELECT count, fingerprint FROM roster WHERE id = 1").one();
  }

  /**
   * The checks and the write of `accept`, for a record whose `seq`, hash and
   * roster fingerprint were computed at a count of `record.seq − 1`. Nothing
   * here waits, so no other request runs in between.
   *
   * Everything that can fail once the rules accepted the record is inside
   * the transaction, the answer included: a record is never written
   * without its answer, and nothing after the transaction can fail.
   */
  #acceptAt(record: RosterRecord, hash: string, fingerprint: string): AcceptTry {
    const sql = this.ctx.storage.sql;
    if (this.#rosterRow().count !== record.seq - 1) return { outcome: "the count moved" };
    const { kind, platforms } = this.settings;
    const date = parseChallenge(record.challenge);
    if (date === null || (record.issuer !== "G2" && record.issuer !== "G3")) throw new Error("the record's fields are not in their formats");

    // The challenge, at this moment.
    const challenge = this.#challenge(record.challenge);
    if (challenge === null) return refused("challenge_unknown");
    if (challenge.accepted) return refused("challenge_used");

    // The back end's rule on the root: one of the two newest CRLs of the issuer, the newest at most 3 days old.
    const newest = this.newestCrls()[record.issuer].map((crl) => ({ root: crl.root, date: crlDay(crl.crlDate) }));
    if (newest.length === 0 || taiwanDay(now().getTime()) > newest[0]!.date + CRL_MAX_AGE_DAYS) return refused("crl_stale");
    const crlDates = newest.filter((crl) => crl.root === record.smtRoot).map((crl) => crl.date);
    if (crlDates.length === 0) return refused("root");

    // The roster rules, on the state this object keeps.
    const { card: before, latestValidDate } = this.ruleState(record.scopeString, record.scopedId);
    const outcome = applyRecord({ platforms, record: { accounts: record.accounts, date, verifies: true }, card: before, latestValidDate, challengeUsed: challenge.accepted, crlDates });
    if (!outcome.result.valid) {
      const { reason } = outcome.result;
      // The Worker verified the proof, and the challenge was looked at above.
      if (reason === "proof" || reason === "challenge_reused") throw new Error("the roster rules refused what was already checked");
      return refused(reason);
    }
    const { kinds } = outcome.result;

    // The back end's policy, if it is on: never a record without a switch.
    if (this.settings.restrictLateSwitches && usesRestrictedSwitch(before, kinds)) return refused("switch_restricted");

    // The line as anyone reading the roster file will check it (spec/record.md, "Check a line").
    const line = recordLine(record);
    if (readRecordLine(kind, line) === null) throw new Error("the record's line is not a well-formed line of the roster");

    // The account of each kind: the one the list has for the platform, or for `withdraw` the one the slot had.
    const accounts = kinds.map(({ platform, kind: what }) => {
      const username = (what === "withdraw" ? before.slots.get(platform)?.current : record.accounts.find((a) => a.platform === platform)?.username) ?? null;
      if (username === null) throw new Error("a kind without an account");
      return { platform, kind: what, username };
    });

    // What the record changes in the views, from the states the rules read and left.
    const view = viewOf(record, date, kinds, before, outcome.card);

    // One transaction: the record with its `seq`, the card's state, the roster's row, the views, the challenge. The
    // answer counts the cards of each account in the views the record leaves, so it is made in the transaction too:
    // if anything fails, nothing of the record is written.
    const written = this.ctx.storage.transactionSync((): Accepted => {
      sql.exec("INSERT INTO records (seq, line, record_hash, fingerprint) VALUES (?, ?, ?, ?)", record.seq, line, hash, fingerprint);
      this.keepRuleState(record.scopeString, record.scopedId, outcome.card, record.seq, outcome.latestValidDate);
      sql.exec("UPDATE roster SET count = ?, fingerprint = ? WHERE id = 1", record.seq, fingerprint);
      writeView(sql, view);
      sql.exec("UPDATE challenges SET accepted = 1 WHERE challenge = ?", record.challenge);
      return { seq: record.seq, recordHash: hash, kinds: accounts.map((a) => ({ ...a, accountCards: this.accountCards(record.scopeString, a.platform, a.username) })) };
    });
    return { outcome: "written", record: written };
  }

  /**
   * What the roster rules read of this roster besides the record itself
   * (protocol/, applyRecord): the state of the record's card, the empty
   * state for a card without a valid record, and the latest date among the
   * valid records.
   *
   * `protected`, like `keepRuleState`, so that the test build runs the
   * roster rules on the stored state through the same reading and writing
   * (its `testApplyRuleEvent` calls both). Neither is overridden.
   */
  protected ruleState(scopeString: string, scopedId: string): { card: CardState; latestValidDate: Day | null } {
    const { platforms } = this.settings;
    const { latest_valid_date } = this.ctx.storage.sql.exec<{ latest_valid_date: string | null }>("SELECT latest_valid_date FROM roster WHERE id = 1").one();
    const latestValidDate = latest_valid_date === null ? null : parseDay(latest_valid_date);
    if (latest_valid_date !== null && latestValidDate === null) throw new Error("roster: latest_valid_date is not a date");
    return { card: readCard(this.ctx.storage.sql, platforms, scopeString, scopedId)?.card ?? newCard(platforms), latestValidDate };
  }

  /** Keeps what the roster rules left after a valid record, `seq` being that record's: the state of its card and the latest valid date. */
  protected keepRuleState(scopeString: string, scopedId: string, card: CardState, seq: number, latestValidDate: Day | null): void {
    writeCard(this.ctx.storage.sql, scopeString, scopedId, card, seq);
    this.ctx.storage.sql.exec("UPDATE roster SET latest_valid_date = ? WHERE id = 1", latestValidDate === null ? null : formatDay(latestValidDate));
  }

  /**
   * The home page's two numbers for a platform, in the roster's open scope,
   * on today's date in Taiwan (page-data.ts, `PageData`).
   */
  pageCounts(platform: string): Counts {
    this.#checkViews();
    return counts(this.ctx.storage.sql, scopeOf(this.settings.kind), platform, taiwanDay(now().getTime()));
  }

  /** The cards of a short ID in the roster's open scope, and today's date in Taiwan (page-data.ts, `PageData`). */
  pageCards(shortId: string): CardsOfShortId {
    this.#checkViews();
    return { today: taiwanDay(now().getTime()), cards: cardsOfShortId(this.ctx.storage.sql, scopeOf(this.settings.kind), shortId) };
  }

  /**
   * The number of cards of a scope that give their place on a platform to
   * this username now, counted in the views (views.ts, `accountCards`): one
   * index, and no card's stored state is read.
   *
   * `protected`, like `ruleState`, so that the test build counts the cards
   * of each account with this same query when it compares the stored state
   * with Go's roster/ (its `testRuleState`). It is not overridden.
   */
  protected accountCards(scopeString: string, platform: string, username: string): number {
    return accountCards(this.ctx.storage.sql, scopeString, platform, username);
  }

  /** The state of one card and the number of records it was computed at. */
  cardState(scopeString: string, scopedId: string): CardStateAnswer {
    this.#checkTables();
    const { platforms } = this.settings;
    return { card: readCard(this.ctx.storage.sql, platforms, scopeString, scopedId)?.card ?? null, count: this.#rosterRow().count };
  }

  /**
   * Replaces what the object knows of the CRL archive: for each issuer key,
   * its newest usable CRLs, the newest first. Called by the CRL mirror, each
   * time with all of what the index in the data bucket lists at that moment
   * (src/crl-index.ts, `newestCrls`, which is where "newest" and how many
   * are decided).
   */
  setNewestCrls(newest: NewestCrls): void {
    this.#checkTables();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM newest_crls");
      for (const issuer of ISSUER_NAMES) {
        for (const [place, crl] of newest[issuer].entries()) {
          this.ctx.storage.sql.exec("INSERT INTO newest_crls (issuer, place, root, crl_number, crl_date) VALUES (?, ?, ?, ?, ?)", issuer, place, crl.root, crl.crlNumber, crl.crlDate);
        }
      }
    });
  }

  /**
   * For each issuer key, its two newest usable CRLs as the mirror last told
   * them, the newest first: fewer than two, or none, if the archive has no
   * more. A record's `smt_root` is accepted only if it is the root of one
   * of them, and none is if the first one's date is too old
   * (spec/revocation-tree.md, "Who checks what").
   */
  newestCrls(): NewestCrls {
    this.#checkTables();
    return newestOfEach((issuer) =>
      this.ctx.storage.sql
        .exec<{ root: string; crl_number: string; crl_date: string }>("SELECT root, crl_number, crl_date FROM newest_crls WHERE issuer = ? ORDER BY place", issuer)
        .toArray()
        .map((row) => ({ root: row.root, crlNumber: row.crl_number, crlDate: row.crl_date })),
    );
  }

  /**
   * Deleting the challenges that have expired: due when the oldest one left
   * expires, and not at all when there is none. So the table holds the
   * challenges of the last 10 minutes and little more.
   */
  #expiredChallenges: TimedWork = {
    due: () => {
      const { oldest } = this.ctx.storage.sql.exec<{ oldest: number | null }>("SELECT MIN(issued_ms) AS oldest FROM challenges").one();
      return oldest === null ? null : oldest + CHALLENGE_LIFETIME_MS;
    },
    run: (time) => {
      this.ctx.storage.sql.exec("DELETE FROM challenges WHERE issued_ms <= ?", time - CHALLENGE_LIFETIME_MS);
    },
  };

  /**
   * The data bucket, for the files of the roster directory. `protected` so
   * that the test build can make a write or a read of it go wrong, by
   * overriding this; nothing else does.
   */
  protected bucket(): FileBucket {
    return this.env.DATA;
  }

  /**
   * The number of records before the first roster file that is full and
   * still in this object, or null if the object keeps no full file: its
   * rows of `records` begin at that file, and the roster has all 1,000
   * records of it.
   */
  #firstFullFile(): number | null {
    const { first } = this.ctx.storage.sql.exec<{ first: number | null }>("SELECT MIN(seq) AS first FROM records").one();
    return first !== null && this.#rosterRow().count >= first - 1 + LINES_PER_FILE ? first - 1 : null;
  }

  /** When a full file that could not be moved is tried again, on the object's clock. Kept in memory: an object that starts again tries at once. */
  #moveAgainAt = 0;
  /** The move of the full files that is going on, if one is. */
  #moving: Promise<void> | null = null;

  /**
   * Moving the roster files that are full to the data bucket: due as soon
   * as the object keeps a full file, and after a failure a minute later.
   * A failure is this piece's own: one line says so, and the alarm goes on
   * to the other pieces.
   */
  #fullFiles: TimedWork = {
    due: () => (this.#firstFullFile() === null ? null : this.#moveAgainAt),
    run: async (time) => {
      try {
        await this.#moveFullFiles();
      } catch (e) {
        this.#moveAgainAt = time + FULL_FILE_RETRY_MS;
        logFailure("full_file_not_moved", e);
      }
    },
  };

  /**
   * Moves every full roster file this object still keeps to the data
   * bucket, the earliest first. One move at a time: whoever asks while one
   * is going on waits for that one.
   */
  #moveFullFiles(): Promise<void> {
    this.#moving ??= (async () => {
      // Not while the views are being filled from the files and the records as they are now.
      await this.viewsFilling;
      for (let before = this.#firstFullFile(); before !== null; before = this.#firstFullFile()) await this.#moveFile(before);
    })().finally(() => {
      this.#moving = null;
    });
    return this.#moving;
  }

  /**
   * Moves one full roster file, the one that follows the first `before`
   * records: writes the file and its record hash list to the data bucket,
   * each read back and compared byte for byte, and only then deletes the
   * file's 1,000 records here (ADR-0027).
   *
   * - The roster file is written before its list: at no moment does the
   *   bucket hold a list without a roster file (spec/record.md, "Record
   *   hash lists").
   * - Both are computed from the stored records alone, so a move that
   *   broke off anywhere is simply made again, and writes the same bytes.
   * - The records are deleted in the transaction that notes the file in
   *   `full_files`: the object keeps a record or knows its file, never
   *   neither.
   *
   * A record can be written while this waits for the bucket; it belongs to
   * a later file, and nothing here reads it.
   */
  async #moveFile(before: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const last = before + LINES_PER_FILE;
    if (before % LINES_PER_FILE !== 0) throw new Error("the stored records do not begin at a roster file");
    const { sha256, fingerprintAfter } = await this.#writeRosterFile(before, last, CACHE_FULL_FILE);
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO full_files (records_before, fingerprint_after, file_sha256) VALUES (?, ?, ?)", before, fingerprintAfter, sha256);
      sql.exec("DELETE FROM records WHERE seq > ? AND seq <= ?", before, last);
    });
  }

  /**
   * Writes the roster file of the stored records after the first `before`
   * up to `last`, both counts of records, and then its record hash list,
   * each with `cacheControl`, each read back and compared byte for byte.
   * Returns the SHA-256 of the file and the roster fingerprint at its end.
   * Throws unless the object keeps every one of those records and knows
   * the fingerprint at the end of the file before. The file is up to some
   * 20 MB: its lines are written into one buffer, without a second copy as
   * text, which is let go when this returns.
   */
  async #writeRosterFile(before: number, last: number, cacheControl: string): Promise<{ sha256: string; fingerprintAfter: string }> {
    const sql = this.ctx.storage.sql;
    // The first line of the list: the roster fingerprint at the end of the file before, which is no longer in `records`.
    const fingerprintBefore = before === 0 ? EMPTY_FINGERPRINT : sql.exec<{ fingerprint_after: string }>("SELECT fingerprint_after FROM full_files WHERE records_before = ?", before - LINES_PER_FILE).toArray()[0]?.fingerprint_after;
    if (fingerprintBefore === undefined) throw new Error("the file before the roster file is not among the full files");
    const { lines, length } = sql.exec<{ lines: number; length: number | null }>("SELECT COUNT(*) AS lines, SUM(LENGTH(CAST(line AS BLOB))) AS length FROM records WHERE seq > ? AND seq <= ?", before, last).one();
    if (lines !== last - before) throw new Error("the stored records are not the records of the roster file");
    const file = new Uint8Array(length ?? 0);
    const encoder = new TextEncoder();
    const hashes: string[] = [];
    let at = 0;
    let fingerprintAfter = "";
    for (const row of sql.exec<{ line: string; record_hash: string; fingerprint: string }>("SELECT line, record_hash, fingerprint FROM records WHERE seq > ? AND seq <= ? ORDER BY seq", before, last)) {
      const { read, written } = encoder.encodeInto(row.line, file.subarray(at));
      if (read !== row.line.length) throw new Error("the stored lines are longer than they were counted");
      at += written;
      hashes.push(row.record_hash);
      fingerprintAfter = row.fingerprint;
    }
    if (at !== file.length) throw new Error("the stored lines are shorter than they were counted");
    const bucket = this.bucket();
    const sha256 = await writeAndReadBack(bucket, ROSTER_DIRECTORY + rosterFileName(before), file, { cacheControl, contentType: TYPE_JSON_LINES });
    await writeAndReadBack(bucket, ROSTER_DIRECTORY + hashListName(before), encoder.encode(hashList(fingerprintBefore, hashes)), { cacheControl, contentType: TYPE_TEXT });
    return { sha256, fingerprintAfter };
  }

  /**
   * The last line this object wrote to the data bucket's fingerprint file
   * and read back, or null if it never published the roster: what
   * `GET /api/v1/fingerprint` answers from. It is what the object keeps of
   * its own writing; the bucket is not asked.
   */
  lastPublished(): FingerprintLine | null {
    this.#checkTables();
    const row = this.ctx.storage.sql.exec<{ date: string; count: number; fingerprint: string }>("SELECT date, count, fingerprint FROM published WHERE in_bucket = 1 ORDER BY date DESC LIMIT 1").toArray()[0];
    return row === undefined ? null : this.#lineOf(row);
  }

  /** A row of `published` as a line of the fingerprint file. */
  #lineOf(row: { date: string; count: number; fingerprint: string }): FingerprintLine {
    const date = parseDay(row.date);
    if (date === null) throw new Error("published: a date is not a date");
    return { date, count: row.count, fingerprint: row.fingerprint };
  }

  /** When a publication that failed is tried again, on the object's clock. Kept in memory: an object that starts again tries at once. */
  #publishAgainAt = 0;

  /**
   * Publishing the roster, once for each date in Taiwan (ADR-0027): due
   * when the date after the last published one begins (after the date the
   * object first ran, for a roster never published), and at once while a
   * line it wrote is not in the bucket's fingerprint file yet; after a
   * failure, a minute later. A date on which the alarm never rang gets no
   * line afterwards: a line is dated the day it is written
   * (spec/record.md).
   *
   * Not while the roster is paused: the states of the cards were then
   * computed by other rules than this build's, and the card state file
   * would be published as this build's. Full files are moved all the same
   * (`#fullFiles`).
   *
   * A failure is this piece's own: one line says so, and the alarm goes on
   * to the other pieces.
   *
   * Nothing here keeps two publications, or a publication and a move of a
   * full file, from running at once: an object has one alarm, whose
   * handler does not run twice at once (README.md, "每天換日公布名冊",
   * has the sentence of Cloudflare's documentation), and the handler runs
   * the pieces of `timedWork()` one after the other. Both write the roster file of the
   * same name at different times, so this is what the order of their
   * writes rests on.
   */
  #dailyPublication: TimedWork = {
    due: () => {
      if (this.#paused) return null;
      const sql = this.ctx.storage.sql;
      const { last, behind } = sql.exec<{ last: string | null; behind: number }>("SELECT MAX(date) AS last, COALESCE(SUM(in_bucket = 0), 0) AS behind FROM published").one();
      if (behind > 0) return this.#publishAgainAt;
      const after = parseDay(last ?? sql.exec<{ date: string }>("SELECT date FROM first_day WHERE id = 1").one().date);
      if (after === null) throw new Error("published: a date is not a date");
      return Math.max(startOfTaiwanDay(after + 1), this.#publishAgainAt);
    },
    run: async (time) => {
      try {
        await this.#publish();
      } catch (e) {
        this.#publishAgainAt = time + PUBLICATION_RETRY_MS;
        logFailure(e instanceof FingerprintFileDiffers ? "fingerprint_file_differs" : "roster_not_published", e);
      }
    },
  };

  /**
   * Publishes the roster as it is at one moment of today's date in Taiwan
   * (ADR-0027; spec/record.md, "What is published when"), in this order:
   *
   *   0. every full roster file is moved to the bucket (`#moveFullFiles`);
   *   1. the last roster file, which is not full, and its record hash
   *      list, over those of the day before;
   *   2. the card state file of the date;
   *   3. the line of the date: the row of `published`, then the
   *      fingerprint file with it.
   *
   * - **One moment.** The count and the roster fingerprint are read, and
   *   the card state table copied, without waiting for anything in
   *   between (`#publicationMoment`). Everything is written from that
   *   moment: the last file from the records up to the count, which never
   *   change, and the card state file from the copy, so that it is the
   *   states after exactly the line's `count` records (spec/roster-rules.md,
   *   "The card state file"). Records written while the bucket is written
   *   wait for the next date. The copy is dropped when the publication
   *   ends, whether the row was written or it broke off.
   * - **The line comes last**, and not at all if anything before it
   *   failed: every record a line covers can be downloaded when the line
   *   is there. A publication that broke off before the row was written is
   *   made again from a new moment, all of it; the count may have grown.
   * - **The row decides.** Once the row of a date is written, nothing of
   *   that date is published again, and its line never changes
   *   (spec/record.md: "publishing again on the same date … with more
   *   records it is refused"). If the fingerprint file could not be
   *   written after it, only the file is written again, from the table.
   * - **The fingerprint file is written from the table**, whole, and only
   *   over a file that is the beginning of it (`#fingerprintFileToWrite`): no line
   *   that is in the bucket's file is ever taken out of it or changed. A
   *   file that has anything else stops the publication before it writes
   *   anything, of this date and of every later one, until somebody has
   *   looked: the bucket may hold the roster directory of another object.
   * - The last roster file has the name a full one gets once it is full,
   *   so it is written here only, in the alarm's work, where no move of a
   *   full file runs meanwhile (`#moveFile`).
   */
  async #publish(): Promise<void> {
    const sql = this.ctx.storage.sql;
    await this.#fingerprintFileToWrite();
    await this.#moveFullFiles();
    try {
      const moment = this.#publicationMoment();
      if (moment !== null) {
        await this.#writeLastFile(moment.count);
        await this.#writeCardStateFile(moment.date);
        // A line is dated the day it is written: not this one, if the date changed while the bucket was written.
        if (taiwanDay(now().getTime()) !== moment.date) throw new Error("the date changed while the roster was being published");
        sql.exec("INSERT INTO published (date, count, fingerprint, in_bucket) VALUES (?, ?, ?, 0)", formatDay(moment.date), moment.count, moment.fingerprint);
      }
    } finally {
      // Whether the line was written or the publication broke off: the next one makes a copy of its own.
      dropCardsCopy(sql);
    }
    await this.#writeFingerprintFile();
  }

  /**
   * The moment the roster is published as, for today's date in Taiwan, or
   * null if today's line is written already: the count and the roster
   * fingerprint, and a copy of the card state table (`copyCards`),
   * all without waiting for anything in between. What the publication
   * writes afterwards is read from these alone: the records up to the
   * count, which never change, and the copy.
   */
  #publicationMoment(): { date: Day; count: number; fingerprint: string } | null {
    const sql = this.ctx.storage.sql;
    const date = taiwanDay(now().getTime());
    const { last } = sql.exec<{ last: string | null }>("SELECT MAX(date) AS last FROM published").one();
    if (last !== null && last >= formatDay(date)) {
      if (last === formatDay(date)) return null;
      throw new Error("the roster is already published for a later date than today");
    }
    const { count, fingerprint } = this.#rosterRow();
    copyCards(sql);
    return { date, count, fingerprint };
  }

  /**
   * Writes the last roster file of the first `count` records, which is not
   * full, and its record hash list, over those of the day before; nothing
   * if `count` ends a full file. The file is at most 999 lines and is
   * built whole in one buffer, which is let go before the card state file
   * is written. Records after `count` may be written meanwhile and are not
   * in it.
   */
  async #writeLastFile(count: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const before = count - (count % LINES_PER_FILE);
    // Every full file is in the bucket by now (`#moveFullFiles`): the object keeps no record before the last file.
    const { earlier } = sql.exec<{ earlier: number }>("SELECT COUNT(*) AS earlier FROM records WHERE seq <= ?", before).one();
    if (earlier !== 0) throw new Error("the stored records are not those of the last roster file");
    if (count > before) await this.#writeRosterFile(before, count, CACHE_DAILY);
  }

  /**
   * Writes the card state file of `date` from the copy of the card
   * state table, one batch of rows at a time, holding no more than one
   * batch however many cards there are. The copy is read twice: once
   * for the length and the SHA-256 of the file, which are given to the
   * bucket with it, then as the stream that is written. Every row is
   * checked as it is written (protocol/, `cardStateFileWriter`), so a row
   * not in its format, or out of order, stops the publication in the first
   * reading, before anything of the file is written.
   */
  async #writeCardStateFile(date: Day): Promise<void> {
    const { length, sha256 } = await lengthAndSha256(this.#cardStateChunks());
    const chunks = this.#cardStateChunks();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    });
    await writeStreamAndReadBack(this.bucket(), cardStateFileKey(date), { stream, length, sha256 }, { cacheControl: CACHE_DAILY, contentType: TYPE_JSON_LINES });
  }

  /**
   * The card state file of the copy of the card state table, as one
   * chunk of bytes for each batch of `CARD_STATE_BATCH` rows. Each batch is
   * read when the chunk before it has been taken, and only after a timer
   * has run out: the object takes the requests that came meanwhile, so a
   * submission waits for one batch, not for the whole file. Without the
   * timer the first reading, which waits only for the hash of each chunk,
   * would not let any request in until it had read every card.
   */
  async *#cardStateChunks(): AsyncGenerator<Uint8Array> {
    const sql = this.ctx.storage.sql;
    const write = cardStateFileWriter(this.settings.kind);
    const encoder = new TextEncoder();
    for (let after: CardRow | null = null; ; ) {
      const rows = copiedCards(sql, after, CARD_STATE_BATCH);
      if (rows.length === 0) return;
      let text = "";
      for (const row of rows) text += write(row);
      yield encoder.encode(text);
      after = rows.at(-1)!;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /**
   * The fingerprint file as this object would write it now: every row of
   * `published` as its line, in order of date; and whether a row is not in
   * the bucket's file yet.
   *
   * Throws `FingerprintFileDiffers` unless the bucket's fingerprint file is
   * the beginning of it: no file, an empty one, one that lacks lines at its
   * end or ends inside a line are all beginnings, and are written over with
   * the whole. A file with a line the object does not keep, or with a line
   * that is not the object's, is not: the object never takes a line out of
   * the published file, and never changes one. The ETag of the file that
   * was compared comes with the answer (null when there was none), so that
   * the write can be made over that file and no other.
   */
  async #fingerprintFileToWrite(): Promise<{ file: Uint8Array; lastDate: string | null; behind: boolean; etag: string | null }> {
    const rows = this.ctx.storage.sql.exec<{ date: string; count: number; fingerprint: string; in_bucket: number }>("SELECT date, count, fingerprint, in_bucket FROM published ORDER BY date").toArray();
    const file = new TextEncoder().encode(rows.map((row) => fingerprintLine(this.#lineOf(row))).join(""));
    const stored = await this.bucket().get(FINGERPRINT_FILE);
    if (stored !== null) {
      const there = new Uint8Array(await stored.arrayBuffer());
      if (there.length > file.length || there.some((byte, i) => byte !== file[i])) throw new FingerprintFileDiffers("the bucket's fingerprint file is not the beginning of the object's");
    }
    return { file, lastDate: rows.at(-1)?.date ?? null, behind: rows.some((row) => row.in_bucket === 0), etag: stored?.etag ?? null };
  }

  /**
   * Writes the fingerprint file from the rows of `published`, if a row is
   * not in the bucket's file yet: every line, in one object that replaces
   * the one there (which is the beginning of it, or this throws), read back
   * before the rows are marked as in the bucket.
   */
  async #writeFingerprintFile(): Promise<void> {
    const { file, lastDate, behind, etag } = await this.#fingerprintFileToWrite();
    if (!behind) return;
    // Only over the file that was just compared: one that changed since is not written over, and is compared at the next try.
    await writeAndReadBack(this.bucket(), FINGERPRINT_FILE, file, { cacheControl: CACHE_DAILY, contentType: TYPE_JSON_LINES }, { etag });
    // The rows that were written: one written meanwhile is not among them.
    this.ctx.storage.sql.exec("UPDATE published SET in_bucket = 1 WHERE date <= ?", lastDate);
  }

  /** Every piece of timed work of the object (TimedWork). Whatever comes to need the alarm is added here. */
  protected timedWork(): readonly TimedWork[] {
    return [this.#expiredChallenges, this.#viewsBehind, this.#fullFiles, this.#dailyPublication];
  }

  /**
   * Sets the alarm for the earliest piece of timed work, or removes it if
   * none has anything to do. Called whenever a `due()` may have changed.
   *
   * An alarm that is already set for that time or sooner is left as it is.
   * Setting it again would move it at least `MIN_ALARM_WAIT_MS` ahead of
   * now each time, and this is called for every challenge issued: with
   * work that is due and challenges coming more often than that, the alarm
   * would never ring. An alarm left sooner than the work needs rings with
   * nothing due, and is then set for the right time. The alarm that rang is
   * no longer set while its handler runs, so when the handler ends, having
   * called this last, an alarm is set that is no later than the work needs:
   * the one this call sets, or a sooner one set while the handler ran.
   *
   * The wait is measured on the object's clock and set on the runtime's;
   * the two differ only in the test build.
   */
  protected async setAlarmForTimedWork(): Promise<void> {
    const dues = this.timedWork().map((work) => work.due()).filter((due) => due !== null);
    if (dues.length === 0) return this.ctx.storage.deleteAlarm();
    const wanted = Date.now() + Math.max(MIN_ALARM_WAIT_MS, Math.min(...dues) - now().getTime());
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > wanted) await this.ctx.storage.setAlarm(wanted);
  }

  /** The alarm: each piece of timed work that is due runs once, and the alarm is set again. */
  override async alarm(): Promise<void> {
    // With tables of another version the object does nothing, and asks for no further alarm.
    if (!this.#tablesAreThisVersion) return;
    const time = now().getTime();
    for (const work of this.timedWork()) {
      const due = work.due();
      if (due !== null && due <= time) await work.run(time);
    }
    await this.setAlarmForTimedWork();
  }
}

/** A CRL date as the mirror told it, as a day. */
function crlDay(crlDate: string): Day {
  const day = parseDay(crlDate);
  if (day === null) throw new Error("newest_crls: crl_date is not a date");
  return day;
}

/**
 * Whether a record with these kinds, applied to a card whose state before
 * it is `card`, has a switch that becomes the fourth or a later switch of
 * its slot: what the policy on late switches refuses.
 */
function usesRestrictedSwitch(card: CardState, kinds: readonly PlatformKind[]): boolean {
  return kinds.some((k) => k.kind === "switch" && (card.slots.get(k.platform) ?? EMPTY_SLOT).switchCount + 1 >= RESTRICTED_FROM);
}

/**
 * The roster's object. Its name is a setting of the environment
 * (`ROSTER_OBJECT_NAME`): clearing the test roster is giving it a new name
 * (ADR-0028).
 */
export function rosterOf(env: Env): DurableObjectStub<Roster> {
  return env.ROSTER.get(env.ROSTER.idFromName(env.ROSTER_OBJECT_NAME));
}
