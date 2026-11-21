// src/target.ts of the test build (vite.config.ts, mode "test"): the test
// roster's scope string, the issuer keys, the component and the (shorter)
// wait for the second signature of the headless browser test
// (test/e2e/ui.ts), which passes them as `define`. Never in a production
// build (test/build.test.ts).
import type { IssuerKey } from "../../src/issuers.ts";
import type { Presentation } from "../../src/platforms.ts";
import { TEST_EXAMPLE } from "../../src/presentations/test-example.ts";
import { THREADS } from "../../src/presentations/threads.ts";
import type { Roster } from "iamreal-protocol/scope.ts";

/** The test roster: the card signs `iamreal-test:public:0__________`. */
export const ROSTER: Roster = "test";

/** The platforms of the test roster's table. */
export const PRESENTATIONS: readonly Presentation[] = Object.freeze([TEST_EXAMPLE, THREADS]);

declare const __IAMREAL_TEST_ISSUERS__: { name: "G2" | "G3"; modulus: string; bits: 2048 | 4096 }[];
declare const __IAMREAL_TEST_COMPONENT__: string;
declare const __IAMREAL_TEST_IDLE_MS__: number;

export const ISSUERS: readonly IssuerKey[] = __IAMREAL_TEST_ISSUERS__.map((i) => ({ name: i.name, modulus: BigInt("0x" + i.modulus), bits: i.bits }));

export const COMPONENT_ORIGIN: string = __IAMREAL_TEST_COMPONENT__;

/** The test's server serves the CRL archive itself: the page's own origin. */
export const DATA_ORIGIN = "";

export const IDLE_LIMIT_MS: number = __IAMREAL_TEST_IDLE_MS__;

/** The links the screens write, as the production build writes them: the tests compare the screens with design/copy/, whose examples are the public site's. */
export const SITE_DOMAIN = "iamreal.tw";
