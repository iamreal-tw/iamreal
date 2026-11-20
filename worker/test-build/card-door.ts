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

/**
 * What `POST /__test/roster/rule-state` answers for `{scope_string,
 * scoped_id}`: the latest valid date the roster rules read for that card
 * (src/roster.ts, `ruleState`), and every account of the scope that a
 * stored card declares now, with the number of cards that declare it as
 * the deployed query counts them (`accountCards`, the `account_cards` of a
 * `201`). Sorted by platform, then username, by byte value.
 */
export interface RuleStateAnswer {
  readonly latest_valid_date: string | null;
  readonly accounts: readonly { readonly platform: string; readonly username: string; readonly account_cards: number }[];
}

/** The settings of the environment a test may replace (`PUT /__test/settings`); wrangler.jsonc has the deployed ones. */
export interface TestSettings {
  readonly ROSTER_KIND?: string;
  readonly ROSTER_OBJECT_NAME?: string;
  /** The back end's policy on late switches (src/settings.ts): "true" turns it on. wrangler.jsonc does not set it. */
  readonly RESTRICT_LATE_SWITCHES?: string;
  /** The date the test roster was last cleared on (src/settings.ts), in place of wrangler.jsonc's. */
  readonly TEST_ROSTER_CLEARED_ON?: string;
}

/**
 * What `GET /__test/roster/views` answers: every row of the views
 * (src/views.ts), table by table, each table in the order of its primary
 * key.
 */
export type StoredViews = Readonly<Record<string, readonly Readonly<Record<string, string | number | null>>[]>>;

/**
 * What `GET /__test/roster/stored` answers: the rows the roster's object
 * keeps of its records, in the order of `seq`, and what its one row of the
 * roster says of them. No endpoint of the deployed Worker shows these yet.
 */
export interface StoredRoster {
  readonly records: readonly { readonly seq: number; readonly line: string; readonly record_hash: string; readonly fingerprint: string }[];
  readonly roster: { readonly count: number; readonly fingerprint: string };
}

/**
 * What `PUT /__test/roster/bucket-fault` takes: from now on the roster's
 * object's writes or reads of one object of the data bucket go wrong in one
 * way, or, with null, none does.
 *
 *   - "put fails": the write throws, and nothing is written;
 *   - "put sends other bytes": the bucket is sent the bytes without their
 *     last one, with whatever checksum the object gave for the whole;
 *   - "put writes other bytes": the write stores the bytes without their
 *     last one, whatever checksum the object gave, and says it went well;
 *   - "put writes another Cache-Control", "put writes another
 *     Content-Type": the write stores the bytes with another value of that
 *     header, and says it went well;
 *   - "put loses its answer": the write stores the bytes, and throws;
 *   - "put takes a while": the write stores the bytes after 600 ms, in
 *     which the object takes other requests;
 *   - "get fails": the read throws.
 */
export type BucketFault = { readonly key: string; readonly how: "put fails" | "put sends other bytes" | "put writes other bytes" | "put writes another Cache-Control" | "put writes another Content-Type" | "put loses its answer" | "put takes a while" | "get fails" } | null;

/**
 * What `GET /__test/roster/kept` answers: how many records the roster's
 * object keeps, and the first and the last `seq` among them (null without
 * one). For a roster that keeps more than `GET /__test/roster/stored` can
 * answer with: that one sends every line, some 20 KB each. Cloudflare's
 * documentation gives a limit for a call of an object's method: "The
 * maximum serialized RPC limit is 32 MiB."
 * (https://developers.cloudflare.com/workers/runtime-apis/rpc/,
 * "Limitations"). It does not say whether that is of what is sent, of what
 * is answered, or both; in the local workerd an answer of 1,500 stored
 * records (30 MB) came back and one of 1,700 was a 500.
 */
export interface KeptRecords {
  readonly count: number;
  readonly first: number | null;
  readonly last: number | null;
}
