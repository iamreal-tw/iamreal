// spec/vectors/records-response.json, the file device-core/ reads too: the
// answer to a submission as the device reads it (src/api.ts, submitRecord)
// and where it differs from what the confirmation screen said (src/flow.ts,
// mismatchesOf).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recordsResponseResult } from "./records-response.ts";
import { vectors } from "./vectors.ts";

describe("records-response.json: every case", () => {
  for (const c of vectors("records-response.json").cases) {
    test(c.name, async () => {
      const { name, result, ...input } = c;
      assert.deepEqual(await recordsResponseResult(input), result, name);
    });
  }
});
