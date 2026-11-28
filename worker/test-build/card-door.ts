// What the doors of the test build take (test-build/index.ts) and what the
// test harness sends them (test/harness.ts): one definition for both.
import type { SlotJson } from "../src/slot-json.ts";

/** What `PUT /__test/proof-log/card` takes: a card's state in the spelling of `card-state`'s answer, the card it is of, and the `seq` of its last valid record. */
export interface CardToWrite {
  readonly scope_string: string;
  readonly scoped_id: string;
  readonly seq: number;
  readonly last_card_proof: string;
  readonly proofs_on_last_date: number;
  readonly platforms: Readonly<Record<string, SlotJson>>;
}

/**
 * What `POST /__test/proof-log/rule-event` takes: one event of
 * spec/vectors/record-rules.json, a record as the record rules read it with
 * the two answers they take from outside the proof log.
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
 * What `POST /__test/proof-log/rule-state` answers for `{scope_string,
 * scoped_id}`: the latest valid date the record rules read for that card
 * (src/proof-log.ts, `ruleState`), and every account of the scope that a
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
  readonly PROOF_LOG_KIND?: string;
  readonly PROOF_LOG_OBJECT_NAME?: string;
  /** The maintainer stopped taking card proofs (src/settings.ts): "true" stops it. wrangler.jsonc sets "false". */
  readonly CARD_PROOFS_PAUSED?: string;
  /** The name of a rebuild from the proof log the maintainer asks for (src/settings.ts). wrangler.jsonc sets "". */
  readonly REBUILD_PROOF_LOG?: string;
  /** The date the test log was last cleared on (src/settings.ts), in place of wrangler.jsonc's. */
  readonly TEST_PROOF_LOG_CLEARED_ON?: string;
  /** How many counts a minute's file holds (src/counts.ts). wrangler.jsonc sets "600". */
  readonly COUNT_EVENTS_PER_MINUTE?: string;
  /** How many card proofs may start in a minute, the whole site together (src/rate-limit.ts, `withinStarts`). wrangler.jsonc sets "60". */
  readonly CARD_PROOF_STARTS_PER_MINUTE?: string;
  /** The app domain and the apps it opens (src/app-domain.ts), in place of wrangler.jsonc's; null for none. */
  readonly APP_DOMAIN?: unknown;
}

/**
 * What `GET /__test/proof-log/views` answers: every row of the views
 * (src/views.ts), table by table, each table in the order of its primary
 * key.
 */
export type StoredViews = Readonly<Record<string, readonly Readonly<Record<string, string | number | null>>[]>>;

/**
 * What `GET /__test/proof-log/stored` answers: the rows the proof log's object
 * keeps of its records, in the order of `seq`, and what its one row of the
 * proof log says of them. No endpoint of the deployed Worker shows these yet.
 */
export interface StoredProofLog {
  readonly records: readonly { readonly seq: number; readonly line: string; readonly record_hash: string; readonly fingerprint: string }[];
  readonly proofLog: { readonly count: number; readonly fingerprint: string };
}

/**
 * What `PUT /__test/proof-log/bucket-fault` takes: from now on the proof log's
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
 *   - "put breaks off": the write takes the first part of what it is
 *     sent, then throws, and nothing is written: a write that broke off
 *     in the middle of a stream;
 *   - "get fails": the read throws.
 */
export type BucketFault = { readonly key: string; readonly how: "put fails" | "put sends other bytes" | "put writes other bytes" | "put writes another Cache-Control" | "put writes another Content-Type" | "put loses its answer" | "put takes a while" | "put breaks off" | "get fails" } | null;

/**
 * What `GET /__test/proof-log/kept` answers: how many records the proof log's
 * object keeps, and the first and the last `seq` among them (null without
 * one). For a proof log that keeps more than `GET /__test/proof-log/stored` can
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

/**
 * What `POST /__test/proof-log/page-plans` takes: what each read of the
 * pages is asked for. `before` is a `seq` as the proof log page's `?after=`
 * gives it: the list is of the records before it.
 */
export interface PagePlanQuestion {
  readonly platform: string;
  readonly short_id: string;
  readonly username: string;
  readonly before: number;
}

/** A statement one of the reads ran: the read, the statement, and the plan SQLite made for it, one line for each row of `EXPLAIN QUERY PLAN` (its `detail`). */
export interface PagePlan {
  readonly read: string;
  readonly statement: string;
  readonly plan: readonly string[];
}

/** What it answers: every statement the reads ran, in the order they ran them. */
export type PagePlans = readonly PagePlan[];
