// The entry point of the test build (test/build.ts): the Worker of
// src/index.ts, and in front of it the one switch the tests need that the
// deployed Worker must not have, the clock. Never in the deployed build
// (test/bundle.test.ts).
import worker from "../src/index.ts";
import { setTestClock } from "./target.ts";

export { Roster } from "../src/index.ts";

export default {
  ...worker,
  /** `PUT /__test/clock` with milliseconds since the epoch sets the clock; anything else is the Worker's. */
  async fetch(request, env, ctx): Promise<Response> {
    if (new URL(request.url).pathname === "/__test/clock" && request.method === "PUT") {
      const ms = Number(await request.text());
      if (!Number.isSafeInteger(ms)) return new Response(null, { status: 400 });
      setTestClock(ms);
      return new Response(null, { status: 204 });
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
