// src/target.ts of the test site's build (`pnpm build:test-site`,
// vite.config.ts, mode "testsite"): what a deploy of test.iamreal.tw serves
// at /proof (ADR-0028). Everything the page trusts is the production
// build's (MOICA's issuer keys, the component at http://localhost:61161,
// the 5-minute wait) except the proof log, its data domain and its site: the
// card signs the test log's scope string,
// `iamreal-test:public:0__________`, so a real card tried out on the test
// site gets a scoped ID unrelated to the one it has in the public proof log
// (spec/scope.md); the CRL archive comes from https://test-data.iamreal.tw,
// where the test site's back end writes it (ADR-0027); and the link the
// last screen gives is the card's page on the test site,
// test.iamreal.tw/p/<short ID>, where the test log's cards are shown.
// The same trade as the build for a real card on this computer
// (target-local.ts), but for the data domain and the site.
//
// Only this build's pages carry the mark of a test log: vite.config.ts
// adds src/ui/test-proof-log.ts to them in this mode and in no other.
// test/build.test.ts checks that this build holds no fake card and no test
// key, and names no address but the component's and that data domain.
import { IDLE_MS } from "./flow.ts";
import { type IssuerKey, MOICA_ISSUERS } from "./issuers.ts";
import type { Presentation } from "./platforms.ts";
import { TEST_EXAMPLE } from "./presentations/test-example.ts";
import { THREADS } from "./presentations/threads.ts";
import type { ProofLog } from "iamreal-protocol/scope.ts";

/** The test log: never the public proof log's scope string. vite.config.ts does not build this mode with another value. */
export const PROOF_LOG: ProofLog = "test";

/** The platforms of the test log's table. */
export const PRESENTATIONS: readonly Presentation[] = Object.freeze([TEST_EXAMPLE, THREADS]);

export const ISSUERS: readonly IssuerKey[] = MOICA_ISSUERS;

export const COMPONENT_ORIGIN = "http://localhost:61161";

/** The test log's data domain (ADR-0027, ADR-0028). The test site's Content-Security-Policy allows it in `connect-src` (README.md). */
export const DATA_ORIGIN = "https://test-data.iamreal.tw";

export const IDLE_LIMIT_MS: number = IDLE_MS;

/** The test site (ADR-0028): its pages of cards are at test.iamreal.tw/p/<short ID> (design/copy/test-site.md). */
export const SITE_DOMAIN = "test.iamreal.tw";
