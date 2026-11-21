// src/target.ts of the build for a real card on this computer (`pnpm local`,
// vite.config.ts, mode "localcard"): everything the page trusts is the
// production build's (MOICA's issuer keys, the component at
// http://localhost:61161, the 5-minute wait) except the roster and where
// the CRL archive is (the local server, not the data domain). The card
// signs the test roster's scope string, `iamreal-test:public:0__________`,
// so that a card proof made while trying the page out gives the card a
// scoped ID unrelated to the one it has in the public roster
// (spec/scope.md: a test scope string produces unrelated scoped IDs). The
// server runs the test roster, whose table has test-example too.
// test/build.test.ts checks that this build holds no fake card and no test
// key.
import { IDLE_MS } from "./flow.ts";
import { type IssuerKey, MOICA_ISSUERS } from "./issuers.ts";
import type { Presentation } from "./platforms.ts";
import { TEST_EXAMPLE } from "./presentations/test-example.ts";
import { THREADS } from "./presentations/threads.ts";
import type { TestRosterMark } from "./target.ts";
import type { Roster } from "iamreal-protocol/scope.ts";

/** The test roster: never the public roster's scope string. */
export const ROSTER: Roster = "test";

/** The platforms of the test roster's table. */
export const PRESENTATIONS: readonly Presentation[] = Object.freeze([TEST_EXAMPLE, THREADS]);

export const ISSUERS: readonly IssuerKey[] = MOICA_ISSUERS;

export const COMPONENT_ORIGIN = "http://localhost:61161";

/** The local server serves the CRL archive itself: the page's own origin. */
export const DATA_ORIGIN = "";

export const IDLE_LIMIT_MS: number = IDLE_MS;

/** The pages of the local server say which roster it is themselves; this page carries no mark. */
export const TEST_ROSTER_MARK: TestRosterMark | null = null;
