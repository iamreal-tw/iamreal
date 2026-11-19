// The tables written into the page, against spec/ and spec/vectors/ (the
// same files the Go tests read): the issuer keys, and the way each platform
// is written. The specification's algorithms themselves are tested in
// protocol/.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { limbs, sha256Hex } from "iamreal-protocol/bytes.ts";
import { parseUsernameFormat } from "iamreal-protocol/username-format.ts";
import { TAG, children, content, expectTlv } from "../src/der.ts";
import { CIRCUIT_OF_BITS, MOICA_ISSUERS, checkIssuerTable } from "../src/issuers.ts";
import { presentationOf } from "../src/platforms.ts";
import { TEST_EXAMPLE } from "../src/presentations/test-example.ts";
import { repoFile, vectors } from "./vectors.ts";

/** The `username` format of a platform of the production roster, read from spec/scope.md ("## Platforms"). */
function productionFormat(platform: string): string {
  const md = new TextDecoder().decode(repoFile("spec/scope.md"));
  const section = md.slice(md.indexOf("## Platforms"), md.indexOf("### Adding a platform"));
  const table = section.slice(section.indexOf("**Production roster**"), section.indexOf("**Test rosters only**"));
  const row = table
    .split("\n")
    .map((l) => l.split("|").map((c) => c.trim()))
    .find((c) => c[1] === "`" + platform + "`");
  if (!row) throw new Error(`spec/scope.md: no ${platform} in the production roster's table`);
  return row[3]!.replace(/`/g, "");
}

describe("each platform's presentation", () => {
  test("Threads' normalize lowercases ASCII only", () => {
    const normalize = presentationOf("threads")!.normalize;
    const format = parseUsernameFormat(productionFormat("threads"))!;
    assert.equal(normalize("@Alice"), "alice");
    assert.equal(normalize("Kelvin"), "Kelvin"); // KELVIN SIGN stays, and fails the format
    assert.equal(format.accepts(normalize("Kelvin")), false);
    // test-example (test builds only): the name as typed, no prefix.
    assert.equal(TEST_EXAMPLE.normalize("@A-b"), "@A-b");
    assert.equal(TEST_EXAMPLE.prefix, "");
  });
});

describe("issuers.json and the certificates in crl/", () => {
  const v = vectors("issuers.json");
  test("the table's shape", () => checkIssuerTable(MOICA_ISSUERS));
  for (const i of v.issuers) {
    test(`${i.issuer}`, async () => {
      const key = MOICA_ISSUERS.find((k) => k.name === i.issuer)!;
      assert.equal(key.modulus, BigInt(i.modulus));
      assert.equal(key.bits, i.modulus_bits);
      const k = CIRCUIT_OF_BITS[key.bits].limbs;
      assert.equal(k, i.limbs);
      assert.deepEqual(limbs(key.modulus, 120, k).map((x) => "0x" + x.toString(16)), i.issuer_modulus_limbs.map((x: string) => "0x" + BigInt(x).toString(16)));
      // The certificate file in crl/ is the one the table names, and holds this modulus.
      const der = repoFile(`crl/${i.issuer === "G2" ? "MOICA2.cer" : "MOICA-G3.cer"}`);
      assert.equal(await sha256Hex(der), i.certificate_sha256);
      const cert = expectTlv(der, 0, TAG.SEQUENCE, der.length, "cert");
      const tbs = children(der, cert)[0]!;
      // version, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo
      const spki = children(der, tbs)[6]!;
      const bits = children(der, spki)[1]!;
      const rsa = expectTlv(der, bits.contentStart + 1, TAG.SEQUENCE, bits.end, "RSAPublicKey");
      const n = children(der, rsa)[0]!;
      let modulus = 0n;
      for (const b of content(der, n)) modulus = (modulus << 8n) | BigInt(b);
      assert.equal(modulus, key.modulus);
    });
  }
});
