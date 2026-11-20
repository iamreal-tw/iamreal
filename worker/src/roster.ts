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
 * (alarm), so a challenge that is not here is unknown.
 *
 * roster: exactly one row (`id` 1). `count` is the number of records;
 * `fingerprint` their roster fingerprint; `latest_valid_date` the latest date
 * among the valid records, `YYYY-MM-DD`, or NULL without one;
 * `rules_version` the version of the roster rules the rows of `cards` were
 * computed by (spec/roster-rules.md, "The version number").
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

export class Roster extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    for (const statement of TABLES) sql.exec(statement);
    // A new roster: no record, and a state computed by the rules of this build.
    sql.exec("INSERT OR IGNORE INTO roster (id, count, fingerprint, latest_valid_date, rules_version) VALUES (1, 0, ?, NULL, ?)", EMPTY_FINGERPRINT, RULES_VERSION);
  }

  /**
   * Issues a challenge (spec/challenge.md): today's date in Taiwan at this
   * moment and 16 random bytes. It is stored with the time before it is
   * given out, so a challenge anybody holds is one this object knows.
   */
  async issueChallenge(): Promise<string> {
    const issued = now().getTime();
    const challenge = `${formatDay(taiwanDay(issued))}.${encodeBase32(crypto.getRandomValues(new Uint8Array(16)))}`;
    // A date outside 2000 to 2049 is not a challenge.
    if (parseChallenge(challenge) === null) throw new Error("the date is not one a challenge can have");
    this.ctx.storage.sql.exec("INSERT INTO challenges (challenge, issued_ms) VALUES (?, ?)", challenge, issued);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + CHALLENGE_LIFETIME_MS);
    return challenge;
  }

  /** The state of one card and the number of records it was computed at. */
  cardState(scopeString: string, scopedId: string): CardStateAnswer {
    const sql = this.ctx.storage.sql;
    const { count } = sql.exec<{ count: number }>("SELECT count FROM roster WHERE id = 1").one();
    return { card: readCard(sql, scopeString, scopedId)?.card ?? null, count };
  }

  /**
   * Deletes the challenges that have expired, and asks to be woken again when
   * the oldest one left expires; with none left, there is no alarm until the
   * next challenge is issued. So the table holds the challenges of the last
   * 10 minutes and little more.
   *
   * An object has one alarm. Whatever else comes to need one (the daily
   * publication) shares this method.
   */
  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const time = now().getTime();
    sql.exec("DELETE FROM challenges WHERE issued_ms <= ?", time - CHALLENGE_LIFETIME_MS);
    const { oldest } = sql.exec<{ oldest: number | null }>("SELECT MIN(issued_ms) AS oldest FROM challenges").one();
    if (oldest === null) return;
    // The wait is measured on the object's clock and set on the runtime's;
    // the two differ only in the test build. Never less than a second, so
    // that a clock standing still cannot make the alarm spin.
    await this.ctx.storage.setAlarm(Date.now() + Math.max(1000, oldest + CHALLENGE_LIFETIME_MS - time));
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
