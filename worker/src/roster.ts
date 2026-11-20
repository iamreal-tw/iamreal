// One roster is one Durable Object, the roster's only writer (ADR-0023).
// It issues challenges, counts the submissions of each, writes the records,
// answers for the state of a card, and keeps the newest CRLs the CRL mirror
// tells it of.
//
// What it keeps, in its SQLite:
//
//   challenges   the challenges it issued that have not expired
//   records      the records, each as its line of the roster file
//   cards        the roster rules' state of each card (card-table.ts)
//   roster       one row: what is true of the roster as a whole
//   newest_crls  the newest CRLs, as the CRL mirror last told them
//
// Nothing here is derived for a page: those tables are separate, and can be
// rebuilt from the records, which the rules' state cannot be thrown away for.
//
// Whether a record is valid is never decided here: that is the roster rules'
// (protocol/, applyRecord), called with the state this object keeps. What
// this file decides is the back end's own: the challenge, which roots it
// takes today, and its policy on switches (docs/api/card-proof.md).
import { DurableObject } from "cloudflare:workers";
import { now } from "#target";
import { encodeBase32 } from "iamreal-protocol/base32.ts";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { type Day, formatDay, parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import { EMPTY_FINGERPRINT, type RecordFields, type RosterRecord, nextFingerprint, readRecordLine, recordHash, recordLine } from "iamreal-protocol/record.ts";
import { type CardState, EMPTY_SLOT, type Kind, type PlatformKind, RULES_VERSION, applyRecord, newCard } from "iamreal-protocol/roster-rules.ts";
import { CARD_TABLE, readCard, writeCard } from "./card-table.ts";
import { type NewestCrls, newestOfEach } from "./crl-index.ts";
import { ISSUER_NAMES } from "./issuers.ts";
import { type RosterSettings, rosterSettingsOf } from "./settings.ts";

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
 * records: one row per record of the roster. `seq` is the record's; `line`
 * its line of the roster file, the LF included, so that the roster file is
 * the lines in the order of `seq`, one after the other (spec/record.md,
 * "Lines and files"); `record_hash` its record hash; `fingerprint` the
 * roster fingerprint once it is added, `fingerprint(seq)`. The table came
 * after the first three, with SCHEMA_VERSION unchanged.
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
  `CREATE TABLE IF NOT EXISTS records (
     seq         INTEGER PRIMARY KEY,
     line        TEXT    NOT NULL,
     record_hash TEXT    NOT NULL,
     fingerprint TEXT    NOT NULL
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

/** What `accept` answers: the record that was written, or why none was. Exactly one of the two is not null. */
export interface AcceptAnswer {
  readonly accepted: Accepted | null;
  readonly refused: RecordRefusal | null;
}

const refused = (code: RecordRefusal): AcceptAnswer => ({ accepted: null, refused: code });

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

  /** The 16 random bytes of a new challenge. */
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
    for (;;) {
      const { count, fingerprint } = this.#rosterRow();
      const record: RosterRecord = { ...fields, seq: count + 1 };
      const hash = await this.hashOf(record);
      const answer = this.#acceptAt(record, hash, await nextFingerprint(fingerprint, hash));
      if (answer !== "the count moved") return answer;
    }
  }

  /**
   * The record hash of a record (protocol/, recordHash). A method of its
   * own for the test build alone: test-build/index.ts overrides it to wait
   * before the hash, so that other requests run in between, which is what
   * the check of the count in `accept` is for. Nothing else overrides or
   * calls it.
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
   */
  #acceptAt(record: RosterRecord, hash: string, fingerprint: string): AcceptAnswer | "the count moved" {
    const sql = this.ctx.storage.sql;
    if (this.#rosterRow().count !== record.seq - 1) return "the count moved";
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

    // One transaction: the record with its `seq`, the card's state, the roster's row, the challenge.
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO records (seq, line, record_hash, fingerprint) VALUES (?, ?, ?, ?)", record.seq, line, hash, fingerprint);
      this.keepRuleState(record.scopeString, record.scopedId, outcome.card, record.seq, outcome.latestValidDate);
      sql.exec("UPDATE roster SET count = ?, fingerprint = ? WHERE id = 1", record.seq, fingerprint);
      sql.exec("UPDATE challenges SET accepted = 1 WHERE challenge = ?", record.challenge);
    });

    return {
      refused: null,
      accepted: {
        seq: record.seq,
        recordHash: hash,
        kinds: kinds.map(({ platform, kind: what }) => {
          const username = (what === "withdraw" ? before.slots.get(platform)?.current : record.accounts.find((a) => a.platform === platform)?.username) ?? null;
          if (username === null) throw new Error("a kind without an account");
          return { platform, kind: what, username, accountCards: this.#accountCards(record.scopeString, platform, username) };
        }),
      },
    };
  }

  /**
   * What the roster rules read of this roster besides the record itself
   * (protocol/, applyRecord): the state of the record's card, the empty
   * state for a card without a valid record, and the latest date among the
   * valid records.
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
   * The number of cards of a scope whose `current` on a platform is this
   * username. It reads every card's row: the tables a page reads will have
   * this number by account (#68), and this then asks them.
   */
  #accountCards(scopeString: string, platform: string, username: string): number {
    return this.ctx.storage.sql.exec<{ cards: number }>("SELECT COUNT(*) AS cards FROM cards WHERE scope_string = ? AND json_extract(slots, ?) = ?", scopeString, `$."${platform}".current`, username).one().cards;
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
