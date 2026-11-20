// The entry point of the test build (test/build.ts): the Worker of
// src/index.ts, and in front of it the switches the tests need that the
// deployed Worker must not have: the clock, the environment's settings,
// doors to the roster's Durable Object, and two doors to what has no API of
// its own yet, the proof verifier and what the roster's object knows of
// the CRL archive. Never in the deployed build (test/bundle.test.ts).
//
// Those two doors call the same verifier and the same method the deployed
// Worker has (src/in-worker.ts, src/roster.ts); nothing of them is replaced
// here. They are temporary: once the real API verifies a submitted record's
// proof and checks its root against the newest CRLs (#67), the tests go
// through that and the doors go.
//
// The doors to the roster's object do what no request can do yet or ever.
// The object of the test build is the deployed one (src/roster.ts) with
// eight methods added: run its alarm now; read when the alarm is set for;
// write the state of a card (until submitting a record does, #67); break
// its tables, to see what the API answers when the back end itself fails;
// give it a second piece of timed work, and read when that one ran, to see
// that two pieces share the one alarm without disturbing each other; and
// change the version its tables say they were made by; and drop the table
// of the newest CRLs, to see an object made before that table get it.
//
// The settings a test replaces (`ROSTER_KIND`, `ROSTER_OBJECT_NAME`) are
// kept here, in memory, and laid over the environment the Worker and the
// object are given. wrangler.jsonc is not touched: the deployed settings
// are the ones the deploy build reads.
import { bytesOfHex } from "iamreal-protocol/bytes.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import type { CardState, SlotState } from "iamreal-protocol/roster-rules.ts";
import { writeCard } from "../src/card-table.ts";
import worker from "../src/index.ts";
import { proofVerifier } from "../src/in-worker.ts";
import { Roster as DeployedRoster, SCHEMA_VERSION, type TimedWork, rosterOf } from "../src/roster.ts";
import { slotOfJson } from "../src/slot-json.ts";
import type { CardToWrite, TestSettings } from "./card-door.ts";
import { setTestClock } from "./target.ts";

let testSettings: TestSettings = {};

/** The environment with the settings the test replaced. */
const testEnv = (env: Env): Env => ({ ...env, ...testSettings });

export class Roster extends DeployedRoster {
  /** The second piece of timed work: when it is next due, how long after each run it is due again, and when it ran. */
  #extraDue: number | null = null;
  #extraEvery = 0;
  readonly #extraRuns: number[] = [];

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

  /** Writes the state of a card as a valid record with this `seq` would leave it (src/card-table.ts). */
  testWriteCard(scopeString: string, scopedId: string, card: CardState, seq: number): void {
    writeCard(this.ctx.storage.sql, scopeString, scopedId, card, seq);
  }

  /** Makes the stored version of the tables another one than the build's, or the build's. Takes effect when the object starts again. */
  testSetStoredSchemaVersion(to: "another" | "the build's"): void {
    this.ctx.storage.sql.exec("UPDATE roster SET schema_version = ? WHERE id = 1", to === "another" ? SCHEMA_VERSION + 1 : SCHEMA_VERSION);
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
   * - `POST /__test/roster/alarm` runs the alarm of the roster's object;
   *   `GET` answers `{alarm}`, the time it is set for or null.
   * - `PUT /__test/roster/extra-work` with `{due, every}` gives the object a
   *   second piece of timed work; `GET` answers `{runs}`, when it ran.
   * - `PUT /__test/roster/card` writes the state of a card (CardToWrite).
   * - `PUT /__test/roster/schema-version` with `{to}`, "another" or "the
   *   build's", changes the version the object's tables say they were made by.
   * - `POST /__test/roster/break` drops the tables the API reads.
   * - `POST /__test/roster/drop-newest-crls` drops the table of the newest
   *   CRLs, as on an object made before the build had it.
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
    if (route === "POST /__test/roster/break") {
      await testRosterOf(env).testBreak();
      return done();
    }
    if (route === "POST /__test/roster/drop-newest-crls") {
      await testRosterOf(env).testDropNewestCrls();
      return done();
    }
    if (route === "POST /__test/verify") {
      const { circuit, proof, publicInputs } = (await request.json()) as { circuit: string; proof: string; publicInputs: string[] };
      return json({ verified: await proofVerifier.verify(circuit, bytesOfHex(proof), publicInputs.map(bytesOfHex)) });
    }
    if (route === "GET /__test/newest-crls") return json(await rosterOf(env).newestCrls());
    return worker.fetch(request, env, ctx);
  },
  /** The schedule, with the settings the test replaced. */
  async scheduled(controller, deployedEnv): Promise<void> {
    return worker.scheduled(controller, testEnv(deployedEnv));
  },
} satisfies ExportedHandler<Env>;
