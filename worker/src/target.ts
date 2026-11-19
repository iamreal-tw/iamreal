// What the Worker trusts that the test build replaces: the issuer keys,
// where MOICA publishes its CRLs, and the clock. None of the three is a
// setting (ADR-0028). This file is the deployed build's: the rest of src/
// imports it as `#target` (package.json, "imports"). The test build puts
// test-build/target.ts in its place (test/build.ts); test/bundle.test.ts
// checks that the deployed build holds nothing of that one.
import { type IssuerKey, MOICA_ISSUERS } from "./issuers.ts";
import type { CrlSource } from "./mirror.ts";

export const ISSUERS: readonly IssuerKey[] = MOICA_ISSUERS;

/**
 * MOICA's complete CRLs, one per issuer key: the addresses crl/README.md
 * gives. Each CRL is signed by MOICA, so plain HTTP is enough once the
 * signature is checked (spec/revocation-tree.md).
 */
export const CRL_SOURCES: readonly CrlSource[] = Object.freeze([
  Object.freeze({ issuer: "G2", url: "http://moica.nat.gov.tw/repository/MOICA/CRL2/complete.crl" }),
  Object.freeze({ issuer: "G3", url: "http://crl-moica.moi.gov.tw/crl/MOICA-G3-complete.crl" }),
] as const);

/** The time. */
export function now(): Date {
  return new Date();
}
