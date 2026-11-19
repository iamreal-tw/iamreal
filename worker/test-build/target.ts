// src/target.ts of the test build (test/build.ts): the test's issuer keys,
// the fake MOICA's address and a short wait for it, which the caller passes
// as `--define`, and a clock the test sets (test-build/index.ts). Never in
// the deployed build (test/bundle.test.ts).
import type { IssuerKey } from "../src/issuers.ts";
import type { CrlSource } from "../src/mirror.ts";
import { TEST_CRL_PATHS } from "./crl-paths.ts";

declare const __IAMREAL_TEST_ISSUERS__: IssuerKey[];
declare const __IAMREAL_TEST_MOICA__: string;
declare const __IAMREAL_TEST_CRL_TIMEOUT_MS__: number;

export const ISSUERS: readonly IssuerKey[] = __IAMREAL_TEST_ISSUERS__;

/** The fake MOICA's two CRLs (test/harness.ts). */
export const CRL_SOURCES: readonly CrlSource[] = [
  { issuer: "G2", url: __IAMREAL_TEST_MOICA__ + TEST_CRL_PATHS.G2 },
  { issuer: "G3", url: __IAMREAL_TEST_MOICA__ + TEST_CRL_PATHS.G3 },
];

/** How long the mirror waits for the fake MOICA: short, so that a test of the limit does not take minutes. */
export const CRL_TIMEOUT_MS: number = __IAMREAL_TEST_CRL_TIMEOUT_MS__;

let testClock: number | undefined;

/** The time the test set, or the real time if it set none. */
export function now(): Date {
  return new Date(testClock ?? Date.now());
}

/** From now on `now()` is this many milliseconds after the epoch. */
export function setTestClock(ms: number): void {
  testClock = ms;
}
