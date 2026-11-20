// One roster is one Durable Object, the roster's only writer (ADR-0023).
// So far it issues challenges and answers for the state of a card; nothing
// writes a record yet, so every card is one without a record.
//
// What it keeps, in its SQLite:
//
//   challenges   the challenges it issued that have not expired
//   cards        the roster rules' state of each card (card-table.ts)
//   roster       one row: what is true of the roster as a whole
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
 * `kind` is which roster the object holds, "test" or "production", as the
 * environment's setting said then; it never changes. `count` is the number
 * of records; `fingerprint` their roster fingerprint; `latest_valid_date`
 * the latest date among the valid records, `YYYY-MM-DD`, or NULL without
 * one; `rules_version` the version of the roster rules the rows of `cards`
 * were computed by (spec/roster-rules.md, "The version number").
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
     kind              TEXT    NOT NULL,
     count             INTEGER NOT NULL,
     fingerprint       TEXT    NOT NULL,
     latest_valid_date TEXT,
     rules_version     INTEGER NOT NULL
   )`,
];

/** What `card-state` is answered from. */
export interface CardStateAnswer {
  /** The state of the card as the rules left it, or null if it has no valid record. */
  readonly card: CardState | null;
  /** The number of records the state was computed at. */
  readonly count: number;
}

/**
 * The message of the error every method throws when the object holds
 * another roster than the environment's setting names. The Worker tells
 * this failure from any other by it (api.ts); it is never written anywhere.
 */
export const OTHER_ROSTER = "the object holds another roster than ROSTER_KIND names";

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
  /** The environment's roster, if it is the one this object holds; null if the object holds another. */
  readonly #settings: RosterSettings | null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const settings = rosterSettingsOf(env);
    const sql = ctx.storage.sql;
    for (const statement of TABLES) sql.exec(statement);
    // A new roster: of the kind the setting names, no record, and a state computed by the rules of this build.
    sql.exec(
      "INSERT OR IGNORE INTO roster (id, kind, count, fingerprint, latest_valid_date, rules_version) VALUES (1, ?, 0, ?, NULL, ?)",
      settings.kind,
      EMPTY_FINGERPRINT,
      RULES_VERSION,
    );
    const { kind } = sql.exec<{ kind: string }>("SELECT kind FROM roster WHERE id = 1").one();
    this.#settings = kind === settings.kind ? settings : null;
  }

  /**
   * The settings, for a method about to read or write the roster. Throws if
   * the object holds another roster than the setting names: a test roster's
   * object answering as the production roster, or the reverse, would mix
   * the two, so it does nothing at all until the setting is put right.
   */
  #roster(): RosterSettings {
    if (this.#settings === null) throw new Error(OTHER_ROSTER);
    return this.#settings;
  }

  /**
   * Issues a challenge (spec/challenge.md): today's date in Taiwan at this
   * moment and 16 random bytes. It is stored with the time before it is
   * given out, so a challenge anybody holds is one this object knows.
   */
  async issueChallenge(): Promise<string> {
    this.#roster();
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
    const { platforms } = this.#roster();
    const sql = this.ctx.storage.sql;
    const { count } = sql.exec<{ count: number }>("SELECT count FROM roster WHERE id = 1").one();
    return { card: readCard(sql, platforms, scopeString, scopedId)?.card ?? null, count };
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
    // An object that holds another roster than the setting names does nothing.
    if (this.#settings === null) return;
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
