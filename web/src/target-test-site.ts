// src/target.ts of the test site's build (`pnpm build:test-site`,
// vite.config.ts, mode "testsite"): what a deploy of test.iamreal.tw serves
// at /proof (ADR-0028). Everything the page trusts is the production
// build's (MOICA's issuer keys, the component at http://localhost:61161,
// the 5-minute wait) except the roster and its data domain: the card signs
// the test roster's scope string, `iamreal-test:public:0__________`, so a
// real card tried out on the test site gets a scoped ID unrelated to the
// one it has in the public roster (spec/scope.md), and the CRL archive
// comes from https://test-data.iamreal.tw, where the test site's back end
// writes it (ADR-0027). The same trade as the build for a real card on this
// computer (target-local.ts), but for the data domain and the mark of a
// test roster, which this build's pages carry at the top.
// test/build.test.ts checks that this build holds no fake card and no test
// key, and names no address but the component's and that data domain.
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

/** The test roster's data domain (ADR-0027, ADR-0028). The test site's Content-Security-Policy allows it in `connect-src` (README.md). */
export const DATA_ORIGIN = "https://test-data.iamreal.tw";

export const IDLE_LIMIT_MS: number = IDLE_MS;

declare const __IAMREAL_TEST_ROSTER_MARK__: TestRosterMark;

/**
 * The mark of a test roster: the sentence of design/copy/test-site.md and
 * the date the roster was last cleared on, both put in by the build
 * (vite.config.ts, which does not build this mode without the date). In
 * Node, where nothing is built, there is none.
 */
export const TEST_ROSTER_MARK: TestRosterMark | null = typeof __IAMREAL_TEST_ROSTER_MARK__ === "undefined" ? null : __IAMREAL_TEST_ROSTER_MARK__;
