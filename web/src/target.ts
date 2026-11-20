// What the page trusts that another build replaces: the roster whose scope
// string the card signs, the platforms the page has its own definition of,
// the issuer keys, the address of MOICA's component, the data domain the
// CRL archive is downloaded from, and how long the PIN waits for the second
// signature. This file is the production build's
// (vite.config.ts, mode "production"). The headless browser test builds the
// page with test/e2e/target.ts in its place (mode "test"); the build for a
// real card on this computer (`pnpm local`) with src/target-local.ts (mode
// "localcard"). test/build.test.ts checks that a production build holds MOICA's
// keys, this address, the public roster's scope string, the data domain and
// nothing of the test's, and what the local build holds.
import { IDLE_MS } from "./flow.ts";
import { type IssuerKey, MOICA_ISSUERS } from "./issuers.ts";
import type { Presentation } from "./platforms.ts";
import { THREADS } from "./presentations/threads.ts";
import type { Roster } from "iamreal-protocol/scope.ts";

/**
 * The roster the card proof is for: the card signs its scope string, the
 * public roster's `iamreal:public:0_______________` (spec/scope.md). A
 * constant: never taken from a server's response or the page's address.
 */
export const ROSTER: Roster = "production";

/** The platforms of the production roster's table the page writes itself (src/platforms.ts). */
export const PRESENTATIONS: readonly Presentation[] = Object.freeze([THREADS]);

export const ISSUERS: readonly IssuerKey[] = MOICA_ISSUERS;

/**
 * MOICA's component (HiPKI) on the cardholder's computer. A constant: never
 * taken from a server's response or the page's address.
 */
export const COMPONENT_ORIGIN = "http://localhost:61161";

/**
 * The data domain, where the page downloads the CRL archive from (ADR-0027).
 * A constant: never taken from a server's response or the page's address.
 * The page's Content-Security-Policy allows it in `connect-src` (README.md).
 */
export const DATA_ORIGIN = "https://data.iamreal.tw";

/** How long the PIN, the certificate and the first signature wait for the second signature (5 minutes). */
export const IDLE_LIMIT_MS: number = IDLE_MS;
