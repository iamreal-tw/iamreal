// src/target.ts of the test build (test/build.ts): the test's issuer keys
// and the fake MOICA's address, which the caller passes as `--define`, and
// a clock the test sets (test-build/index.ts). Never in the deployed build
// (test/bundle.test.ts).
import type { IssuerKey } from "../src/issuers.ts";
import type { CrlSource } from "../src/mirror.ts";

declare const __IAMREAL_TEST_ISSUERS__: IssuerKey[];
declare const __IAMREAL_TEST_MOICA__: string;

export const ISSUERS: readonly IssuerKey[] = __IAMREAL_TEST_ISSUERS__;

/** The fake MOICA's two CRLs (test/harness.ts). */
export const CRL_SOURCES: readonly CrlSource[] = [
  { issuer: "G2", url: `${__IAMREAL_TEST_MOICA__}/g2/complete.crl` },
  { issuer: "G3", url: `${__IAMREAL_TEST_MOICA__}/g3/complete.crl` },
];

let testClock: number | undefined;

/** The time the test set, or the real time if it set none. */
export function now(): Date {
  return new Date(testClock ?? Date.now());
}

/** From now on `now()` is this many milliseconds after the epoch. */
export function setTestClock(ms: number): void {
  testClock = ms;
}
