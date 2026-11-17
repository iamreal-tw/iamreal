// src/target.ts of the test build (vite.config.ts, mode "test"): the test
// roster's scope string, the issuer keys, the component and the (shorter)
// wait for the second signature of the headless browser test
// (test/e2e/ui.ts), which passes them as `define`. Never in a production
// build (test/build.test.ts).
import type { IssuerKey } from "../../src/issuers.ts";
import type { Roster } from "../../src/spec/scope.ts";

/** The test roster: the card signs `iamreal-test:public:0__________`. */
export const ROSTER: Roster = "test";

declare const __IAMREAL_TEST_ISSUERS__: { name: "G2" | "G3"; modulus: string; bits: 2048 | 4096 }[];
declare const __IAMREAL_TEST_COMPONENT__: string;
declare const __IAMREAL_TEST_IDLE_MS__: number;

export const ISSUERS: readonly IssuerKey[] = __IAMREAL_TEST_ISSUERS__.map((i) => ({ name: i.name, modulus: BigInt("0x" + i.modulus), bits: i.bits }));

export const COMPONENT_ORIGIN: string = __IAMREAL_TEST_COMPONENT__;

export const IDLE_LIMIT_MS: number = __IAMREAL_TEST_IDLE_MS__;
