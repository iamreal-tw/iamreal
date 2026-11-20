// The entry point of the test build (test/build.ts): the Worker of
// src/index.ts, and in front of it the switches the tests need that the
// deployed Worker must not have. Never in the deployed build
// (test/bundle.test.ts).
//
// - The clock, and the environment's settings. The settings a test replaces
//   are kept here, in memory, and laid over the environment the Worker and
//   the object are given. wrangler.jsonc is not touched: the deployed
//   settings are the ones the deploy build reads.
// - Which proof verifier `records` asks. A test worker starts with the one
//   the deployed Worker has (src/in-worker.ts), and the tests about proofs
//   keep it. A proof takes a real card's keys and seconds to make, so the
//   tests about everything else (the challenge, the CRLs, the roster rules,
//   the write) switch to a stand-in that judges a proof by its first byte,
//   as the Go backend's tests do (server/harness_test.go, fakeProofs). The
//   stand-in is behind the same interface the deployed Worker names its
//   verifier by (src/index.ts, `API_PARTS`).
// - A door to the proof verifier itself, for inputs no record can carry
//   (public inputs that are not a record's), and one to what the roster's
//   object knows of the CRL archive. Both call what the deployed Worker has;
//   nothing of them is replaced here.
// - Doors to the roster's object, for what no request can do. The object of
//   the test build is the deployed one (src/roster.ts) with methods added:
//   run its alarm now and read when it is set for; give it a second piece
//   of timed work; choose the random bytes of the next challenge, so that a
//   test gets the challenge a proof was made for; change the versions its
//   tables say they were made by and computed by; write a row of the card
//   state table as it is given, for the states the rules cannot leave;
//   break its tables, or make every write to one of them fail, to see what
//   the API answers when the back end itself fails; drop the table of the
//   newest CRLs; and run the roster rules on the object's stored state for
//   an event the API would never write (an invalid record of a roster).
import { bytesOfHex } from "iamreal-protocol/bytes.ts";
import { parseChallenge } from "iamreal-protocol/challenge.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import { type CardState, type RecordResult, RULES_VERSION, type SlotState, applyRecord } from "iamreal-protocol/roster-rules.ts";
import { type ApiParts, api, isApiPath } from "../src/api.ts";
import { writeCard } from "../src/card-table.ts";
import { EngineError } from "../src/engine.ts";
import worker from "../src/index.ts";
import { proofVerifier } from "../src/in-worker.ts";
import { Roster as DeployedRoster, SCHEMA_VERSION, type TimedWork, rosterOf } from "../src/roster.ts";
import { slotOfJson } from "../src/slot-json.ts";
import type { CardToWrite, RuleEvent, TestSettings } from "./card-door.ts";
import { setTestClock } from "./target.ts";

let testSettings: TestSettings = {};

/** The environment with the settings the test replaced. */
const testEnv = (env: Env): Env => ({ ...env, ...testSettings });

/**
 * The stand-in verifier: it looks at nothing but the proof's first byte. 0
 * is accepted, 1 is rejected, and on 2 it cannot run, as the Worker's
 * verifier when Barretenberg does not start (src/engine.ts).
 */
const STAND_IN: ApiParts = {
  verifier: {
    async verify(_circuit, proof) {
      if (proof[0] === 2) throw new EngineError("the stand-in verifier does not start on this proof", true);
      return proof[0] !== 1;
    },
  },
};

let standIn = false;

/** The tables a test can make every write to fail on. */
const WRITTEN_TABLES = ["records", "cards", "roster", "challenges"] as const;
type WrittenTable = (typeof WRITTEN_TABLES)[number];

export class Roster extends DeployedRoster {
  /** The second piece of timed work: when it is next due, how long after each run it is due again, and when it ran. */
  #extraDue: number | null = null;
  #extraEvery = 0;
  readonly #extraRuns: number[] = [];
  /** The random bytes of the next challenge, if the test chose them. */
  #nextRandom: Uint8Array | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, testEnv(env));
  }

  protected override timedWork(): readonly TimedWork[] {
    const extra: TimedWork = {
      due: () => this.#extraDue,
      run: (time) => {
        this.#extraRuns.push(time);
        this.#extraDue = this.#extraDue! + this.#extraEvery;
      },
    };
    return [...super.timedWork(), extra];
  }

  protected override challengeRandom(): Uint8Array {
    const chosen = this.#nextRandom;
    this.#nextRandom = null;
    return chosen ?? super.challengeRandom();
  }

  /** The next challenge has these 16 bytes in place of random ones. */
  testSetNextRandom(random: Uint8Array): void {
    this.#nextRandom = random;
  }

  /** Gives the object a second piece of timed work, due at `due` and then every `every` milliseconds. */
  async testSetExtraWork(due: number, every: number): Promise<void> {
    this.#extraDue = due;
    this.#extraEvery = every;
    await this.setAlarmForTimedWork();
  }

  /** The times, on the object's clock, at which the second piece of timed work ran. */
  testExtraWorkRuns(): number[] {
    return [...this.#extraRuns];
  }

  /** Runs the alarm now, whatever time it is set for. */
  async testRunAlarm(): Promise<void> {
    await this.alarm();
  }

  /** The time the alarm is set for, in milliseconds since the epoch on the runtime's clock, or null. */
  testAlarmTime(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  /** Writes a row of the card state table as it is given (src/card-table.ts): how a test stores a state the rules cannot have left. */
  testWriteCard(scopeString: string, scopedId: string, card: CardState, seq: number): void {
    writeCard(this.ctx.storage.sql, scopeString, scopedId, card, seq);
  }

  /** Makes the stored version of the tables another one than the build's, or the build's. Takes effect when the object starts again. */
  testSetStoredSchemaVersion(to: "another" | "the build's"): void {
    this.ctx.storage.sql.exec("UPDATE roster SET schema_version = ? WHERE id = 1", to === "another" ? SCHEMA_VERSION + 1 : SCHEMA_VERSION);
  }

  /** Makes the version of the roster rules the stored state says it was computed by another one than the build's, or the build's. Takes effect when the object starts again. */
  testSetStoredRulesVersion(to: "another" | "the build's"): void {
    this.ctx.storage.sql.exec("UPDATE roster SET rules_version = ? WHERE id = 1", to === "another" ? RULES_VERSION + 1 : RULES_VERSION);
  }

  /** Drops the table of the newest CRLs: the object is then as one made by a build that did not have it yet. */
  testDropNewestCrls(): void {
    this.ctx.storage.sql.exec("DROP TABLE newest_crls");
  }

  /** Drops the tables the API reads, so that the object's methods throw until it starts again. */
  testBreak(): void {
    this.ctx.storage.sql.exec("DROP TABLE challenges");
    this.ctx.storage.sql.exec("DROP TABLE cards");
  }

  /**
   * From now on every write to `table` fails, or, with null, none does: a
   * trigger in the object's own SQLite, so that the write fails where the
   * storage would fail it, in the middle of whatever was being written.
   */
  testFailWritesTo(table: WrittenTable | null): void {
    const sql = this.ctx.storage.sql;
    for (const t of WRITTEN_TABLES) for (const on of ["INSERT", "UPDATE"]) sql.exec(`DROP TRIGGER IF EXISTS test_fail_${t}_${on}`);
    if (table === null) return;
    if (!WRITTEN_TABLES.includes(table)) throw new Error("not a table the object writes");
    for (const on of ["INSERT", "UPDATE"]) sql.exec(`CREATE TRIGGER test_fail_${table}_${on} BEFORE ${on} ON ${table} BEGIN SELECT RAISE(ABORT, 'the test makes this write fail'); END`);
  }

  /**
   * Runs the roster rules for one event of spec/vectors/roster-rules.json on
   * the state the object stores, and keeps what a valid one leaves: the
   * same reading and the same writing of the state as for a submitted
   * record (src/roster.ts, `ruleState`, `keepRuleState`). The answers the
   * rules take from outside the roster come with the event. Which
   * challenges were used is kept in a table of the test's own, since the
   * back end never writes an invalid record and so keeps no challenge of
   * one.
   */
  testApplyRuleEvent(e: RuleEvent): RecordResult {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS test_used_challenges (challenge TEXT PRIMARY KEY) WITHOUT ROWID");
    const date = parseChallenge(e.challenge);
    if (date === null) throw new Error("the event's challenge is not a challenge");
    const challengeUsed = sql.exec("SELECT 1 FROM test_used_challenges WHERE challenge = ?", e.challenge).toArray().length > 0;
    const { card, latestValidDate } = this.ruleState(e.scope_string, e.scoped_id);
    const outcome = applyRecord({
      platforms: this.settings.platforms,
      record: { accounts: e.accounts, date, verifies: e.verifies },
      card,
      latestValidDate,
      challengeUsed,
      crlDates: e.crl_dates.map((d) => parseDay(d)!),
    });
    this.ctx.storage.transactionSync(() => {
      if (outcome.result.valid) this.keepRuleState(e.scope_string, e.scoped_id, outcome.card, e.seq, outcome.latestValidDate);
      sql.exec("INSERT OR IGNORE INTO test_used_challenges (challenge) VALUES (?)", e.challenge);
    });
    return outcome.result;
  }
}

/** The roster's object (src/roster.ts, rosterOf), as the class of the test build. */
const testRosterOf = (env: Env): DurableObjectStub<Roster> => rosterOf(env) as unknown as DurableObjectStub<Roster>;

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const done = (): Response => new Response(null, { status: 204 });

export default {
  ...worker,
  /**
   * - `PUT /__test/clock` with milliseconds since the epoch sets the clock.
   * - `PUT /__test/settings` with a TestSettings replaces settings of the
   *   environment from now on. An object that is running keeps the ones it
   *   started with until it starts again.
   * - `PUT /__test/verifier` with `real` or `stand-in` chooses the proof
   *   verifier `records` asks from now on.
   * - `POST /__test/roster/alarm` runs the alarm of the roster's object;
   *   `GET` answers `{alarm}`, the time it is set for or null.
   * - `PUT /__test/roster/extra-work` with `{due, every}` gives the object a
   *   second piece of timed work; `GET` answers `{runs}`, when it ran.
   * - `PUT /__test/roster/next-random` with 16 bytes in hex: the next
   *   challenge the object issues has them in place of random bytes.
   * - `PUT /__test/roster/card` writes a row of the card state table
   *   (CardToWrite).
   * - `PUT /__test/roster/schema-version` and
   *   `PUT /__test/roster/rules-version` with `{to}`, "another" or "the
   *   build's", change the version the object's tables say they were made
   *   by, and the version of the rules its state says it was computed by.
   * - `POST /__test/roster/break` drops the tables the API reads.
   * - `PUT /__test/roster/fail-writes` with `{table}`, a table's name or
   *   null: every write to that table fails from now on, or none does.
   * - `POST /__test/roster/drop-newest-crls` drops the table of the newest
   *   CRLs, as on an object made before the build had it.
   * - `POST /__test/roster/rule-event` with a RuleEvent runs the roster
   *   rules for it on the object's stored state and answers the result.
   * - `POST /__test/verify` with `{circuit, proof, publicInputs}` (hex, the
   *   inputs as a list) answers `{verified}`: the proof verifier's verdict.
   * - `GET /__test/newest-crls` answers what the roster's object knows of
   *   the CRL archive (src/roster.ts, `newestCrls`).
   *
   * Anything else is the Worker's.
   */
  async fetch(request, deployedEnv, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;
    if (route === "PUT /__test/clock") {
      const ms = Number(await request.text());
      if (!Number.isSafeInteger(ms)) return new Response(null, { status: 400 });
      setTestClock(ms);
      return done();
    }
    if (route === "PUT /__test/settings") {
      testSettings = (await request.json()) as TestSettings;
      return done();
    }
    if (route === "PUT /__test/verifier") {
      const which = await request.text();
      if (which !== "real" && which !== "stand-in") return new Response(null, { status: 400 });
      standIn = which === "stand-in";
      return done();
    }
    const env = testEnv(deployedEnv);
    if (route === "POST /__test/roster/alarm") {
      await testRosterOf(env).testRunAlarm();
      return done();
    }
    if (route === "GET /__test/roster/alarm") return json({ alarm: await testRosterOf(env).testAlarmTime() });
    if (route === "PUT /__test/roster/extra-work") {
      const { due, every } = (await request.json()) as { due: number; every: number };
      await testRosterOf(env).testSetExtraWork(due, every);
      return done();
    }
    if (route === "GET /__test/roster/extra-work") return json({ runs: await testRosterOf(env).testExtraWorkRuns() });
    if (route === "PUT /__test/roster/next-random") {
      const random = bytesOfHex(await request.text());
      if (random.length !== 16) return new Response(null, { status: 400 });
      await testRosterOf(env).testSetNextRandom(random);
      return done();
    }
    if (route === "PUT /__test/roster/card") {
      const body = (await request.json()) as CardToWrite;
      const slots = new Map<string, SlotState>();
      for (const [platform, s] of Object.entries(body.platforms)) {
        const slot = slotOfJson(s);
        if (slot === null) return new Response(null, { status: 400 });
        slots.set(platform, slot);
      }
      await testRosterOf(env).testWriteCard(body.scope_string, body.scoped_id, { lastCardProof: parseDay(body.last_card_proof), proofsOnLastDate: body.proofs_on_last_date, slots }, body.seq);
      return done();
    }
    if (route === "PUT /__test/roster/schema-version") {
      const { to } = (await request.json()) as { to: "another" | "the build's" };
      await testRosterOf(env).testSetStoredSchemaVersion(to);
      return done();
    }
    if (route === "PUT /__test/roster/rules-version") {
      const { to } = (await request.json()) as { to: "another" | "the build's" };
      await testRosterOf(env).testSetStoredRulesVersion(to);
      return done();
    }
    if (route === "POST /__test/roster/break") {
      await testRosterOf(env).testBreak();
      return done();
    }
    if (route === "PUT /__test/roster/fail-writes") {
      const { table } = (await request.json()) as { table: WrittenTable | null };
      await testRosterOf(env).testFailWritesTo(table);
      return done();
    }
    if (route === "POST /__test/roster/drop-newest-crls") {
      await testRosterOf(env).testDropNewestCrls();
      return done();
    }
    if (route === "POST /__test/roster/rule-event") return json(await testRosterOf(env).testApplyRuleEvent((await request.json()) as RuleEvent));
    if (route === "POST /__test/verify") {
      const { circuit, proof, publicInputs } = (await request.json()) as { circuit: string; proof: string; publicInputs: string[] };
      return json({ verified: await proofVerifier.verify(circuit, bytesOfHex(proof), publicInputs.map(bytesOfHex)) });
    }
    if (route === "GET /__test/newest-crls") return json(await rosterOf(env).newestCrls());
    if (standIn && isApiPath(pathname)) return api(request, env, STAND_IN);
    return worker.fetch(request, env, ctx);
  },
  /** The schedule, with the settings the test replaced. */
  async scheduled(controller, deployedEnv): Promise<void> {
    return worker.scheduled(controller, testEnv(deployedEnv));
  },
} satisfies ExportedHandler<Env>;
