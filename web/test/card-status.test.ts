// spec/vectors/card-status.json, the file device-core/ reads too: the
// card's state as the screen of its accounts shows it (src/flow.ts,
// statusOf), from the two answers of the server.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cardStatusResult } from "./card-status.ts";
import { vectors } from "./vectors.ts";

describe("card-status.json: every case", () => {
  for (const c of vectors("card-status.json").cases) {
    test(c.name, async () => {
      const { name, result, ...input } = c;
      assert.deepEqual(await cardStatusResult(input), result, name);
    });
  }
});
