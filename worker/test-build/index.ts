// The entry point of the test build (test/build.ts): the Worker of
// src/index.ts, and in front of it the switches the tests need that the
// deployed Worker must not have: the clock, and two doors to what has no
// API of its own yet, the proof verifier and what the roster's object
// knows of the CRL archive. Never in the deployed build
// (test/bundle.test.ts).
//
// The doors call the same verifier and the same object the deployed Worker
// has (src/in-worker.ts, src/roster.ts); nothing of them is replaced here.
// They are temporary: once the real API verifies a submitted record's
// proof and checks its root against the newest CRLs (#67), the tests go
// through that and the doors go.
import { bytesOfHex } from "iamreal-protocol/bytes.ts";
import worker from "../src/index.ts";
import { proofVerifier } from "../src/in-worker.ts";
import { rosterOf } from "../src/roster.ts";
import { setTestClock } from "./target.ts";

export { Roster } from "../src/index.ts";

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

export default {
  ...worker,
  /**
   * - `PUT /__test/clock` with milliseconds since the epoch sets the clock.
   * - `POST /__test/verify` with `{circuit, proof, publicInputs}` (hex, the
   *   inputs as a list) answers `{verified}`: the proof verifier's verdict.
   * - `GET /__test/newest-crls` answers what the roster's object knows of
   *   the CRL archive (src/roster.ts, `newestCrls`).
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
    if (pathname === "/__test/verify" && request.method === "POST") {
      const { circuit, proof, publicInputs } = (await request.json()) as { circuit: string; proof: string; publicInputs: string[] };
      return json({ verified: await proofVerifier.verify(circuit, bytesOfHex(proof), publicInputs.map(bytesOfHex)) });
    }
    if (pathname === "/__test/newest-crls" && request.method === "GET") {
      return json(await rosterOf(env).newestCrls());
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
