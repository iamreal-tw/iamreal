// The device's checks before the PIN against spec/vectors/device-checks.json:
// choosing and checking the certificate, and whether the CRL from the mirror
// is used (spec/device-checks.md).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { certificateResult, crlResult, indexResult, maxAgeResult, type CertificateCase, type CrlCase, type IndexCase, type MaxAgeCase } from "./device-checks.ts";
import { vectors } from "./vectors.ts";

const v = vectors("device-checks.json");

describe("device-checks.json: certificate", () => {
  for (const c of v.certificate.cases as CertificateCase[]) {
    test(c.what, async () => assert.deepEqual(await certificateResult(c, v.issuers), c.result));
  }
});

describe("device-checks.json: crl", () => {
  test("max_age", () => {
    for (const c of v.crl.max_age as MaxAgeCase[]) assert.equal(maxAgeResult(c), c.max_age_days, `server ${c.server_days}`);
  });
  for (const c of v.crl.index as IndexCase[]) {
    test(`index: ${c.what}`, () => assert.deepEqual(indexResult(c), c.result));
  }
  for (const c of v.crl.cases as CrlCase[]) {
    test(c.what, async () => assert.deepEqual(await crlResult(c, v.issuers), c.result));
  }
});
