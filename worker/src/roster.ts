// One roster is one Durable Object, the roster's only writer (ADR-0023).
// So far it issues challenges, answers for the state of a card, and keeps
// the newest CRLs the CRL mirror tells it of; nothing writes a record yet,
// so every card is one without a record.
//
// What it keeps, in its SQLite:
//
//   challenges   the challenges it issued that have not expired
//   cards        the roster rules' state of each card (card-table.ts)
//   roster       one row: what is true of the roster as a whole
//   newest_crls  the newest CRLs, as the CRL mirror last told them
//
// Nothing here is derived for a page: those tables are separate, and can be
// rebuilt from the records, which the rules' state cannot be thrown away for.
import { DurableObject } from "cloudflare:workers";
import { now } from "#target";
import { encodeBase32 } from "iamreal-protocol/base32.ts";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { formatDay, taiwanDay } from "iamreal-protocol/date.ts";
import { type CardState, RULES_VERSION } from "iamreal-protocol/roster-rules.ts";
import { CARD_TABLE, readCard } from "./card-table.ts";
import { type NewestCrls, newestOfEach } from "./crl-index.ts";
import { ISSUER_NAMES } from "./issuers.ts";
import { type RosterSettings, rosterSettingsOf } from "./settings.ts";

/**
 * A challenge can be used for less than this long after it is issued
 * (docs/api/card-proof.md): one issued exactly this long ago has expired.
 */
export const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;

/**
 * The roster fingerprint of the empty roster: 64 zeros (spec/record.md,
 * "Record hash and the roster fingerprint").
 */
const EMPTY_FINGERPRINT = "0".repeat(64);

/**
 * The tables. Every statement can run again on an object that has them.
 *
 * challenges: one row per challenge issued and not yet expired
 * (spec/challenge.md). `issued_ms` is when, in milliseconds since the epoch;
 * `submissions` how many times it was submitted (at most 5 count);
 * `accepted` is 1 once a record was written for it. Expired rows are deleted
 * (the timed work below), so a challenge that is not here is unknown.
 *
 * roster: exactly one row (`id` 1), written when the object first starts.
 * `count` is the number of records; `fingerprint` their roster fingerprint;
 * `latest_valid_date` the latest date among the valid records,
 * `YYYY-MM-DD`, or NULL without one; `rules_version` the version of the
 * roster rules the rows of `cards` were computed by (spec/roster-rules.md,
 * "The version number"); `schema_version` the SCHEMA_VERSION of the build
 * that made the tables.
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
 * The roster's Durable Object. (`Roster` is this class everywhere in
 * worker/; protocol/'s type of that name, which roster, is `RosterKind`
 * here: settings.ts.)
 */
export class Roster extends DurableObject<Env> {
  readonly #settings: RosterSettings;
  /** Whether the object's tables were made by this build's SCHEMA_VERSION. */
  readonly #tablesAreThisVersion: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Before anything is read or written: with settings that do not fit each
    // other (settings.ts) the object does not start. The Worker reads the
    // same settings before it asks the object, so it does not get this far.
    this.#settings = rosterSettingsOf(env);
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
    const { schema_version } = sql.exec<{ schema_version: number }>("SELECT schema_version FROM roster WHERE id = 1").one();
    this.#tablesAreThisVersion = schema_version === SCHEMA_VERSION;
  }

  /** For a method about to read or write the tables: throws if they were made by another SCHEMA_VERSION. */
  #checkTables(): void {
    if (!this.#tablesAreThisVersion) throw new Error(OTHER_SCHEMA);
  }

  /**
   * Issues a challenge (spec/challenge.md): today's date in Taiwan at this
   * moment and 16 random bytes. It is stored with the time before it is
   * given out, so a challenge anybody holds is one this object knows.
   */
  async issueChallenge(): Promise<string> {
    this.#checkTables();
    const issued = now().getTime();
    const challenge = `${formatDay(taiwanDay(issued))}.${encodeBase32(crypto.getRandomValues(new Uint8Array(16)))}`;
    // A date outside 2000 to 2049 is not a challenge.
    if (parseChallenge(challenge) === null) throw new Error("the date is not one a challenge can have");
    this.ctx.storage.sql.exec("INSERT INTO challenges (challenge, issued_ms) VALUES (?, ?)", challenge, issued);
    await this.setAlarmForTimedWork();
    return challenge;
  }

  /** The state of one card and the number of records it was computed at. */
  cardState(scopeString: string, scopedId: string): CardStateAnswer {
    this.#checkTables();
    const { platforms } = this.#settings;
    const sql = this.ctx.storage.sql;
    const { count } = sql.exec<{ count: number }>("SELECT count FROM roster WHERE id = 1").one();
    return { card: readCard(sql, platforms, scopeString, scopedId)?.card ?? null, count };
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

  /** Every piece of timed work of the object (TimedWork). Whatever comes to need the alarm is added here. */
  protected timedWork(): readonly TimedWork[] {
    return [this.#expiredChallenges];
  }

  /**
   * Sets the alarm for the earliest piece of timed work, or removes it if
   * none has anything to do. Called whenever a `due()` may have changed.
   *
   * The wait is measured on the object's clock and set on the runtime's;
   * the two differ only in the test build.
   */
  protected async setAlarmForTimedWork(): Promise<void> {
    const dues = this.timedWork().map((work) => work.due()).filter((due) => due !== null);
    if (dues.length === 0) return this.ctx.storage.deleteAlarm();
    await this.ctx.storage.setAlarm(Date.now() + Math.max(MIN_ALARM_WAIT_MS, Math.min(...dues) - now().getTime()));
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

/**
 * The roster's object. Its name is a setting of the environment
 * (`ROSTER_OBJECT_NAME`): clearing the test roster is giving it a new name
 * (ADR-0028).
 */
export function rosterOf(env: Env): DurableObjectStub<Roster> {
  return env.ROSTER.get(env.ROSTER.idFromName(env.ROSTER_OBJECT_NAME));
}
