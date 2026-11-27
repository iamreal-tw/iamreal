// src/target.ts of the build for a real card on this computer (worker/'s `pnpm local`,
// vite.config.ts, mode "localcard"): everything the page trusts is the
// production build's (MOICA's issuer keys, the component at
// http://localhost:61161, the 5-minute wait) except the proof log and where
// the CRL archive is (the local server, not the data domain). The card
// signs the test log's scope string, `iamreal-test:public:0__________`,
// so that a card proof made while trying the page out gives the card a
// scoped ID unrelated to the one it has in the public proof log
// (spec/scope.md: a test scope string produces unrelated scoped IDs). The
// server runs the test log, whose table has test-example too; this page
// knows Threads only, as the production build and the test site's do
// (#309), so the screens speak of one platform.
// test/build.test.ts checks that this build holds no fake card and no test
// key.
import { IDLE_MS } from "./flow.ts";
import { type IssuerKey, MOICA_ISSUERS } from "./issuers.ts";
import type { Presentation } from "./platforms.ts";
import { THREADS } from "./presentations/threads.ts";
import type { ProofLog } from "iamreal-protocol/scope.ts";

/** The test log: never the public proof log's scope string. */
export const PROOF_LOG: ProofLog = "test";

/** Threads only, as the production build (#309). */
export const PRESENTATIONS: readonly Presentation[] = Object.freeze([THREADS]);

export const ISSUERS: readonly IssuerKey[] = MOICA_ISSUERS;

export const COMPONENT_ORIGIN = "http://localhost:61161";

/** The local server serves the CRL archive itself: the page's own origin. */
export const DATA_ORIGIN = "";

export const IDLE_LIMIT_MS: number = IDLE_MS;

/** The links on the screen are the public site's, as before: the local server's pages are at this computer's address, which no link is written with. */
export const SITE_DOMAIN = "iamreal.tw";

/** No app domain: the apps connect to the test site, not to this computer's server (ADR-0040). The card proof starts at step 1. */
export const APP_LINK: string | null = null;
