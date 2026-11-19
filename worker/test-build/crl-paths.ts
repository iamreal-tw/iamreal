// The path of each issuer key's CRL on the fake MOICA: where the test build
// asks (test-build/target.ts) and where the fake MOICA answers
// (test/harness.ts).
import type { IssuerName } from "../src/issuers.ts";

export const TEST_CRL_PATHS: Readonly<Record<IssuerName, string>> = { G2: "/g2/complete.crl", G3: "/g3/complete.crl" };
