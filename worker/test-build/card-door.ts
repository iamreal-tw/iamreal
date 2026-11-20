// What the doors of the test build take (test-build/index.ts) and what the
// test harness sends them (test/harness.ts): one definition for both.
import type { SlotJson } from "../src/slot-json.ts";

/** What `PUT /__test/roster/card` takes: a card's state in the spelling of `card-state`'s answer, the card it is of, and the `seq` of its last valid record. */
export interface CardToWrite {
  readonly scope_string: string;
  readonly scoped_id: string;
  readonly seq: number;
  readonly last_card_proof: string;
  readonly proofs_on_last_date: number;
  readonly platforms: Readonly<Record<string, SlotJson>>;
}

/**
 * What `POST /__test/roster/rule-event` takes: one event of
 * spec/vectors/roster-rules.json, a record as the roster rules read it with
 * the two answers they take from outside the roster.
 */
export interface RuleEvent {
  readonly seq: number;
  readonly scope_string: string;
  readonly scoped_id: string;
  readonly accounts: readonly { readonly platform: string; readonly username: string }[];
  readonly challenge: string;
  /** Check 1: whether the record verifies. */
  readonly verifies: boolean;
  /** Check 3: the CRL dates of the usable CRLs of the record's issuer whose tree has its root, `YYYY-MM-DD`. */
  readonly crl_dates: readonly string[];
}

/** The settings of the environment a test may replace (`PUT /__test/settings`); wrangler.jsonc has the deployed ones. */
export interface TestSettings {
  readonly ROSTER_KIND?: string;
  readonly ROSTER_OBJECT_NAME?: string;
  /** The back end's policy on late switches (src/settings.ts): "true" turns it on. wrangler.jsonc does not set it. */
  readonly RESTRICT_LATE_SWITCHES?: string;
}

/**
 * What `GET /__test/roster/stored` answers: the rows the roster's object
 * keeps of its records, in the order of `seq`, and what its one row of the
 * roster says of them. No endpoint of the deployed Worker shows these yet.
 */
export interface StoredRoster {
  readonly records: readonly { readonly seq: number; readonly line: string; readonly record_hash: string; readonly fingerprint: string }[];
  readonly roster: { readonly count: number; readonly fingerprint: string };
}
