// What the page trusts that a test build replaces: the issuer keys and the
// address of MOICA's component. This file is the production build's; the
// headless browser test builds the page with test/e2e/target.ts in its
// place (vite.config.ts, mode "test"), and test/build.test.ts checks that a
// production build holds MOICA's keys, this address and nothing of the
// test's.
import { type IssuerKey, MOICA_ISSUERS } from "./issuers.ts";

export const ISSUERS: readonly IssuerKey[] = MOICA_ISSUERS;

/**
 * MOICA's component (HiPKI) on the cardholder's computer. A constant: never
 * taken from a server's response or the page's address.
 */
export const COMPONENT_ORIGIN = "http://localhost:61161";
