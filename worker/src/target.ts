// What the Worker trusts that the test build replaces: the issuer keys,
// where MOICA publishes its CRLs, and the clock; and how long the mirror
// waits and how long it catches up, which the test build shortens. None of
// the three is a setting (ADR-0028). This file is the deployed build's: the rest of src/
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

/**
 * How long the mirror waits for one CRL, from the request to the last byte:
 * 5 minutes. MOICA's G2 CRL was about 17 MB on 2026-11-16, which takes 5
 * minutes at 0.5 Mbit/s, far slower than a data centre's connection; and
 * the sources are asked at the same time, so a run stays well inside the
 * 15 minutes a scheduled Worker may take by the clock
 * (https://developers.cloudflare.com/workers/platform/limits/, "Wall time
 * limits by invocation type"); waiting for an answer is not CPU time. The test
 * build waits a second or two instead, so that its tests of the limit do
 * not take minutes.
 */
export const CRL_TIMEOUT_MS: number = 5 * 60 * 1000;

/**
 * For how long a round of the mirror goes on starting files that an
 * earlier round left without a line of the index: 2.5 minutes, the 5
 * minutes of CPU time an invocation has less the 2.5 minutes kept back for
 * the largest CRL's tree (src/round-budget.ts). The files fetched in this
 * round always get theirs. So an archive that lost its whole index gets it
 * back over several rounds, each of which ends in time, and every line a
 * round wrote stays. The test build sets its own, so that a test can reach
 * the limit.
 */
export { CRL_CATCH_UP_MS } from "./round-budget.ts";

/** The time. */
export function now(): Date {
  return new Date();
}
