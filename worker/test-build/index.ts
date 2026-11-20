// The entry point of the test build (test/build.ts): the Worker of
// src/index.ts, and in front of it the switches the tests need that the
// deployed Worker must not have: the clock, doors to the roster's Durable
// Object, and two doors to code that has no API of its own yet, the proof
// verifier and the Poseidon2 hash. Never in the deployed build
// (test/bundle.test.ts).
//
// The doors to the verifier and the hash call the same ones the deployed
// Worker has (src/in-worker.ts); nothing of them is replaced here. They are
// temporary: once the real API verifies a submitted record's proof and the
// CRL mirror builds its tree (#67, #65), the tests go through those and
// the doors go.
//
// The doors to the roster's object do what no request can do yet or ever:
// run its alarm now, write the state of a card (until submitting a record
// does, #67), and break its tables, to see what the API answers when the
// back end itself fails. The object of the test build is the deployed one
// (src/roster.ts) with these three methods added.
import { bytesOfHex, hexOf } from "iamreal-protocol/bytes.ts";
import { parseDay } from "iamreal-protocol/date.ts";
import type { CardState, SlotState } from "iamreal-protocol/roster-rules.ts";
import { writeCard } from "../src/card-table.ts";
import worker from "../src/index.ts";
import { poseidon2Hash, proofVerifier } from "../src/in-worker.ts";
import { Roster as DeployedRoster } from "../src/roster.ts";
import { setTestClock } from "./target.ts";

export class Roster extends DeployedRoster {
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

  /** Drops the tables the API reads, so that the object's methods throw until it starts again. */
  testBreak(): void {
    this.ctx.storage.sql.exec("DROP TABLE challenges");
    this.ctx.storage.sql.exec("DROP TABLE cards");
  }
}

const testRosterOf = (env: Env): DurableObjectStub<Roster> => env.ROSTER.get(env.ROSTER.idFromName(env.ROSTER_OBJECT_NAME)) as unknown as DurableObjectStub<Roster>;

/** What `PUT /__test/roster/card` takes: a card's state in the spelling of `card-state`'s answer, and where to write it. */
interface CardDoorBody {
  scope_string: string;
  scoped_id: string;
  seq: number;
  last_card_proof: string;
  proofs_on_last_date: number;
  platforms: Record<string, { current: string | null; last_declared: string | null; switch_count: number; correction_date: string | null }>;
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

export default {
  ...worker,
  /**
   * - `PUT /__test/clock` with milliseconds since the epoch sets the clock.
   * - `POST /__test/roster/alarm` runs the alarm of the roster's object;
   *   `GET` answers `{alarm}`, the time it is set for or null.
   * - `PUT /__test/roster/card` writes the state of a card (CardDoorBody).
   * - `POST /__test/roster/break` drops the tables the API reads.
   * - `POST /__test/verify` with `{circuit, proof, publicInputs}` (hex, the
   *   inputs as a list) answers `{verified}`: the proof verifier's verdict.
   * - `POST /__test/poseidon2` with `{inputs}` (a list of hex) answers
   *   `{hash}`, or 400 with `{error}` if the hash refuses the inputs.
   *
   * Anything else is the Worker's.
   */
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/__test/clock" && request.method === "PUT") {
      const ms = Number(await request.text());
      if (!Number.isSafeInteger(ms)) return new Response(null, { status: 400 });
      setTestClock(ms);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/__test/roster/alarm" && request.method === "POST") {
      await testRosterOf(env).testRunAlarm();
      return new Response(null, { status: 204 });
    }
    if (pathname === "/__test/roster/alarm" && request.method === "GET") {
      return json({ alarm: await testRosterOf(env).testAlarmTime() });
    }
    if (pathname === "/__test/roster/card" && request.method === "PUT") {
      const body = (await request.json()) as CardDoorBody;
      const slots = new Map<string, SlotState>();
      for (const [platform, s] of Object.entries(body.platforms)) {
        slots.set(platform, { current: s.current, lastDeclared: s.last_declared, switchCount: s.switch_count, correctionDate: s.correction_date === null ? null : parseDay(s.correction_date) });
      }
      await testRosterOf(env).testWriteCard(body.scope_string, body.scoped_id, { lastCardProof: parseDay(body.last_card_proof), proofsOnLastDate: body.proofs_on_last_date, slots }, body.seq);
      return new Response(null, { status: 204 });
    }
    if (pathname === "/__test/roster/break" && request.method === "POST") {
      await testRosterOf(env).testBreak();
      return new Response(null, { status: 204 });
    }
    if (pathname === "/__test/verify" && request.method === "POST") {
      const { circuit, proof, publicInputs } = (await request.json()) as { circuit: string; proof: string; publicInputs: string[] };
      return json({ verified: await proofVerifier.verify(circuit, bytesOfHex(proof), publicInputs.map(bytesOfHex)) });
    }
    if (pathname === "/__test/poseidon2" && request.method === "POST") {
      const { inputs } = (await request.json()) as { inputs: string[] };
      try {
        return json({ hash: hexOf(poseidon2Hash(inputs.map(bytesOfHex))) });
      } catch (e) {
        return json({ error: e instanceof Error ? e.name : "Error" }, 400);
      }
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
