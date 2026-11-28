// What the environment's settings say about its proof log (wrangler.jsonc,
// "vars"). The one place the back end reads them: the Worker before it does
// anything for a request that needs the proof log, and the proof log's Durable
// Object when it starts.
//
// The two settings must fit each other. The name of a test log's object
// (`PROOF_LOG_OBJECT_NAME`) starts with `test-`; the name of the production
// log's does not. So an environment whose `PROOF_LOG_KIND` was changed
// without its object, or the reverse, serves nothing: a test log's
// object never answers as the production log, and the production
// log's never as a test one.
//
// A note on names: in protocol/ `ProofLog` is a type, which proof log,
// "production" or "test". In worker/ `ProofLog` is the Durable Object's class
// (proof-log.ts). So worker/ imports protocol/'s type as `ProofLogKind`, always.
import { parseDay } from "iamreal-protocol/date.ts";
import { type PlatformRow, platformsOf } from "iamreal-protocol/platforms.ts";
import type { ProofLog as ProofLogKind } from "iamreal-protocol/scope.ts";
import { MIN_APP, type MinAppJson } from "./min-app.ts";

export type { ProofLogKind };

/** What the name of a test log's object starts with, and the name of the production log's does not. */
export const TEST_OBJECT_PREFIX = "test-";

export interface ProofLogSettings {
  /** Which proof log this environment serves. */
  readonly kind: ProofLogKind;
  /**
   * The platform table of that proof log, in ascending order of platform ID
   * (protocol/src/platforms.ts). The one place the back end gets it: what
   * `config` sends to devices, what `card-state` answers for and what the
   * stored state of a card is checked against are the same table.
   */
  readonly platforms: readonly PlatformRow[];
  /**
   * The minimum app version `config` sends to the apps (`min_app`), the
   * values of this proof log in src/min-app.ts.
   */
  readonly minApp: MinAppJson;
  /**
   * The most records of one card the back end writes with one date
   * (docs/api/card-proof.md, `daily_limit`; ADR-0018): DAILY_LIMITS of this
   * proof log. `card-state` sends it to devices.
   */
  readonly dailyLimit: number;
  /**
   * The maintainer stopped taking card proofs (`CARD_PROOFS_PAUSED`, ADR-0033;
   * README.md, "停止和恢復收過卡"): `challenges` and `records` answer
   * `paused` and the proof log takes no record; `config` says so, so that a
   * device says it before it reads a card. Everything else goes on: the
   * visitors' pages, `card-state`, the files, the daily publication. The
   * proof log's object is not told: the Worker refuses before it asks it.
   * wrangler.jsonc sets it to "false"; absent, as in a test, it is false.
   */
  readonly cardProofsPaused: boolean;
  /**
   * The name of the rebuild from the proof log the maintainer asks for
   * (`REBUILD_PROOF_LOG`, ADR-0033; README.md, "從證明紀錄重建"), or null when
   * none is asked for: absent or the empty string, as wrangler.jsonc has it.
   * The proof log's object makes one rebuild for each name, when it starts
   * with a name it has made none for, and only while `cardProofsPaused`
   * (src/proof-log.ts). A name is 1 to 40 of `A-Za-z0-9._-`: it is written
   * in the object's log lines and in what `GET /api/v1/rebuild` answers, so
   * it is nothing that must stay unknown.
   */
  readonly rebuildName: string | null;
  /**
   * For a test log, the date it was last cleared on, `YYYY-MM-DD`
   * (`TEST_PROOF_LOG_CLEARED_ON`; ADR-0028): every page of the site says it
   * beside the mark of a test log. Before the first clearing it is the
   * date the test site was first deployed. Null for the production log,
   * whose pages have no such mark; the setting is then not read.
   */
  readonly testProofLogClearedOn: string | null;
  /**
   * The domain this proof log's site is at (`SITE_HOSTS`): what a page writes
   * where it writes its own address.
   */
  readonly siteHost: string;
}

/**
 * The domain of each proof log's site (ADR-0028). It follows from which proof log
 * it is and is not a setting of its own: a page never takes it from the
 * request's `Host`, which is whatever the visitor's client sent.
 */
export const SITE_HOSTS: Readonly<Record<ProofLogKind, string>> = { production: "iamreal.tw", test: "test.iamreal.tw" };

/**
 * The most records of one card each proof log's back end writes with one
 * date (`daily_limit`, docs/api/card-proof.md). It is the back end's rule,
 * not the record rules' (ADR-0018): it protects the service, and a record
 * already in the proof log is judged by the record rules alone. This is the
 * one place the numbers are written; the test site has its own
 * (README.md, "設定檔").
 */
export const DAILY_LIMITS: Readonly<Record<ProofLogKind, number>> = { production: 3, test: 3 };

/**
 * What is wrong with the two settings, or null: `PROOF_LOG_KIND` is "test" or
 * "production", and `PROOF_LOG_OBJECT_NAME` starts with `test-` exactly when it
 * is "test". The text names the settings, never their values.
 */
export function proofLogSettingsProblem(kind: unknown, objectName: unknown): string | null {
  if (kind !== "test" && kind !== "production") return "PROOF_LOG_KIND is neither test nor production";
  if (typeof objectName !== "string" || objectName === "") return "PROOF_LOG_OBJECT_NAME is not set";
  const namedAsTest = objectName.startsWith(TEST_OBJECT_PREFIX);
  if (kind === "test" && !namedAsTest) return "PROOF_LOG_KIND is test, and PROOF_LOG_OBJECT_NAME does not start with test-";
  if (kind === "production" && namedAsTest) return "PROOF_LOG_KIND is production, and PROOF_LOG_OBJECT_NAME starts with test-";
  return null;
}

/**
 * The settings, and what follows from them. `PROOF_LOG_KIND` only names the
 * proof log: its scope string and its platform table are written in protocol/.
 * Throws if the settings are not right (proofLogSettingsProblem).
 */
export function proofLogSettingsOf(env: Env): ProofLogSettings {
  const kind: string = env.PROOF_LOG_KIND;
  const problem = proofLogSettingsProblem(kind, env.PROOF_LOG_OBJECT_NAME);
  if (problem !== null || (kind !== "test" && kind !== "production")) throw new Error(problem ?? "PROOF_LOG_KIND");
  // Declared in wrangler.jsonc; a value that is neither is a mistake made on the dashboard: nothing answers rather than guess.
  const paused: unknown = (env as { CARD_PROOFS_PAUSED?: unknown }).CARD_PROOFS_PAUSED;
  if (paused !== undefined && paused !== "true" && paused !== "false") throw new Error("CARD_PROOFS_PAUSED is neither true nor false");
  // A test log's pages are not served without the date beside their mark.
  const cleared: unknown = (env as { TEST_PROOF_LOG_CLEARED_ON?: unknown }).TEST_PROOF_LOG_CLEARED_ON;
  if (kind === "test" && (typeof cleared !== "string" || parseDay(cleared) === null)) throw new Error("TEST_PROOF_LOG_CLEARED_ON is not a date");
  // Declared in wrangler.jsonc as the empty string; any other value that is not a name is a mistake made on the dashboard.
  const rebuild: unknown = (env as { REBUILD_PROOF_LOG?: unknown }).REBUILD_PROOF_LOG;
  if (rebuild !== undefined && (typeof rebuild !== "string" || !/^[A-Za-z0-9._-]{0,40}$/.test(rebuild))) throw new Error("REBUILD_PROOF_LOG is not a name");
  return { rebuildName: rebuild === undefined || rebuild === "" ? null : rebuild, kind, platforms: platformsOf(kind), minApp: MIN_APP[kind], dailyLimit: DAILY_LIMITS[kind], cardProofsPaused: paused === "true", testProofLogClearedOn: kind === "test" ? (cleared as string) : null, siteHost: SITE_HOSTS[kind] };
}
