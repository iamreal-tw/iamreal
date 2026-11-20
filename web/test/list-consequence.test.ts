// spec/vectors/list-consequence.json, the file device-core/ reads too: the
// platform table and the card's state read as src/api.ts reads them, and
// what the cardholder's list does (src/flow.ts, consequenceOfChoice).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { listConsequenceResult } from "./list-consequence.ts";
import { vectors } from "./vectors.ts";

describe("list-consequence.json: every case", () => {
  for (const c of vectors("list-consequence.json").cases) {
    test(c.name, async () => {
      const { name, result, ...input } = c;
      assert.deepEqual(await listConsequenceResult(input), result, name);
    });
  }
});
