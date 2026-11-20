// What `PUT /__test/roster/card` takes (test-build/index.ts) and what the
// test harness sends it (test/harness.ts): one definition for both.
import type { SlotJson } from "../src/slot-json.ts";

/** A card's state in the spelling of `card-state`'s answer, the card it is of, and the `seq` of its last valid record. */
export interface CardToWrite {
  readonly scope_string: string;
  readonly scoped_id: string;
  readonly seq: number;
  readonly last_card_proof: string;
  readonly proofs_on_last_date: number;
  readonly platforms: Readonly<Record<string, SlotJson>>;
}

/** The settings of the environment a test may replace (`PUT /__test/settings`); wrangler.jsonc has the deployed ones. */
export interface TestSettings {
  readonly ROSTER_KIND?: string;
  readonly ROSTER_OBJECT_NAME?: string;
}
