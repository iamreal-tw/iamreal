// The certificate checks before the PIN (certificate.ts). Choosing and
// checking the certificate is tested against spec/vectors/device-checks.json
// (device-checks.test.ts); this file keeps what the vectors cannot show.
import assert from "node:assert/strict";
import { test } from "node:test";
import { walkTbs } from "../src/certificate.ts";
import { buildTbs } from "./fixtures/certs.ts";
import { makeKey } from "./fixtures/der-build.ts";

test("walk: every read stays inside the TBS", async () => {
  const card = await makeKey(2048);
  const tbs = buildTbs({ spki: card.spki });
  for (const cut of [10, 100, 400, tbs.length - 300]) {
    const t = tbs.slice(0, cut);
    t[2] = (cut - 4) >> 8;
    t[3] = (cut - 4) & 0xff;
    assert.notEqual(walkTbs(t).failure, null);
  }
});
