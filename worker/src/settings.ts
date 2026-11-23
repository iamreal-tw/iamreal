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
   * The back end's policy on late switches (docs/api/card-proof.md,
   * `switch_restricted`): when true, a record the record rules accept is
   * refused if a switch in it would be the fourth or fifth of its slot.
   * False unless the environment sets `RESTRICT_LATE_SWITCHES` to "true";
   * wrangler.jsonc does not set it, so by default there is no such policy.
   */
  readonly restrictLateSwitches: boolean;
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
  // Not one of the environment's declared settings (wrangler.jsonc): absent, or exactly "true" or "false".
  const restrict: unknown = (env as { RESTRICT_LATE_SWITCHES?: unknown }).RESTRICT_LATE_SWITCHES;
  if (restrict !== undefined && restrict !== "true" && restrict !== "false") throw new Error("RESTRICT_LATE_SWITCHES is neither true nor false");
  // A test log's pages are not served without the date beside their mark.
  const cleared: unknown = (env as { TEST_PROOF_LOG_CLEARED_ON?: unknown }).TEST_PROOF_LOG_CLEARED_ON;
  if (kind === "test" && (typeof cleared !== "string" || parseDay(cleared) === null)) throw new Error("TEST_PROOF_LOG_CLEARED_ON is not a date");
  return { kind, platforms: platformsOf(kind), minApp: MIN_APP[kind], restrictLateSwitches: restrict === "true", testProofLogClearedOn: kind === "test" ? (cleared as string) : null, siteHost: SITE_HOSTS[kind] };
}
