// The issuer keys written into the Worker are MOICA's, as spec/issuers.md
// and spec/vectors/issuers.json give them (the same file Go's crl/ and
// web/ are checked against).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { type IssuerKey, MOICA_ISSUERS, checkIssuerTable } from "../src/issuers.ts";

interface IssuerVector {
  issuer: string;
  modulus_bits: number;
  exponent: number;
  modulus: string;
}

test("the Worker's issuer keys are the ones in spec/vectors/issuers.json", () => {
  const vectors = JSON.parse(readFileSync(new URL("../../spec/vectors/issuers.json", import.meta.url), "utf8")) as { issuers: IssuerVector[] };
  assert.deepEqual(
    MOICA_ISSUERS.map((k) => ({ issuer: k.name, modulus_bits: k.bits, modulus: "0x" + k.modulus })),
    vectors.issuers.map((v) => ({ issuer: v.issuer, modulus_bits: v.modulus_bits, modulus: v.modulus })),
  );
  for (const v of vectors.issuers) assert.equal(v.exponent, 65537);
  checkIssuerTable(MOICA_ISSUERS);
});

test("a table that is not one G2 key of 2048 bits and one G3 key of 4096 bits is refused", () => {
  const [g2, g3] = MOICA_ISSUERS as [IssuerKey, IssuerKey];
  const bad: IssuerKey[][] = [
    [],
    [g2],
    [g3, g2],
    [g2, g3, g3],
    [g2, { ...g3, name: "G2" }],
    [g2, { ...g3, modulus: g2.modulus }],
    [{ ...g2, modulus: "0" + g2.modulus.slice(1) }, g3],
    [{ ...g2, modulus: g2.modulus.toUpperCase() }, g3],
    [{ ...g2, bits: 4096 }, g3],
  ];
  for (const table of bad) assert.throws(() => checkIssuerTable(table), JSON.stringify(table.map((k) => [k.name, k.bits, k.modulus.length])));
});
