// The minimum app version each proof log's site sends in `config` (`min_app`;
// spec/min-app.md, ADR-0035): for the Android app and the iOS app, the lowest
// build that may still do a card proof and the date in Taiwan that bound
// starts on. An app with a lower build says from that date on that it must
// be updated, and stops before it asks for the PIN or reads the card. The
// back end never looks at app versions when it accepts a card proof.
//
// This file is the one place the numbers are written. Raising one is a pull
// request that says why; `from` is the date the change of the record rules
// or of the circuit takes effect (ADR-0035, "商店的審查和生效日"). The test
// site and the production site each have their own values, by the proof log
// they serve (PROOF_LOG_KIND, src/settings.ts).
//
// Build 1 is the lowest build there is: no app stops yet.
import type { ProofLog as ProofLogKind } from "iamreal-protocol/scope.ts";

/** One app's entry of `min_app`, as `config` sends it. */
export interface MinAppEntryJson {
  /** The store's integer version number: Android's `versionCode`, iOS's build number. 1 to 2,100,000,000. */
  readonly build: number;
  /** `YYYY-MM-DD`, a date in Taiwan. */
  readonly from: string;
}

export interface MinAppJson {
  readonly android: MinAppEntryJson;
  readonly ios: MinAppEntryJson;
}

export const MIN_APP: Readonly<Record<ProofLogKind, MinAppJson>> = {
  production: {
    android: { build: 1, from: "2026-11-20" },
    ios: { build: 1, from: "2026-11-20" },
  },
  test: {
    android: { build: 1, from: "2026-11-20" },
    ios: { build: 1, from: "2026-11-20" },
  },
};
