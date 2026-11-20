// What the environment's settings say about its roster (wrangler.jsonc,
// "vars"). The one place the back end reads them: the Worker before it does
// anything for a request that needs the roster, and the roster's Durable
// Object when it starts.
//
// The two settings must fit each other. The name of a test roster's object
// (`ROSTER_OBJECT_NAME`) starts with `test-`; the name of the production
// roster's does not. So an environment whose `ROSTER_KIND` was changed
// without its object, or the reverse, serves nothing: a test roster's
// object never answers as the production roster, and the production
// roster's never as a test one.
//
// A note on names: in protocol/ `Roster` is a type, which roster,
// "production" or "test". In worker/ `Roster` is the Durable Object's class
// (roster.ts). So worker/ imports protocol/'s type as `RosterKind`, always.
import { type PlatformRow, platformsOf } from "iamreal-protocol/platforms.ts";
import type { Roster as RosterKind } from "iamreal-protocol/scope.ts";

export type { RosterKind };

/** What the name of a test roster's object starts with, and the name of the production roster's does not. */
export const TEST_OBJECT_PREFIX = "test-";

export interface RosterSettings {
  /** Which roster this environment serves. */
  readonly kind: RosterKind;
  /**
   * The platform table of that roster, in ascending order of platform ID
   * (protocol/src/platforms.ts). The one place the back end gets it: what
   * `config` sends to devices, what `card-state` answers for and what the
   * stored state of a card is checked against are the same table.
   */
  readonly platforms: readonly PlatformRow[];
}

/**
 * What is wrong with the two settings, or null: `ROSTER_KIND` is "test" or
 * "production", and `ROSTER_OBJECT_NAME` starts with `test-` exactly when it
 * is "test". The text names the settings, never their values.
 */
export function rosterSettingsProblem(kind: unknown, objectName: unknown): string | null {
  if (kind !== "test" && kind !== "production") return "ROSTER_KIND is neither test nor production";
  if (typeof objectName !== "string" || objectName === "") return "ROSTER_OBJECT_NAME is not set";
  const namedAsTest = objectName.startsWith(TEST_OBJECT_PREFIX);
  if (kind === "test" && !namedAsTest) return "ROSTER_KIND is test, and ROSTER_OBJECT_NAME does not start with test-";
  if (kind === "production" && namedAsTest) return "ROSTER_KIND is production, and ROSTER_OBJECT_NAME starts with test-";
  return null;
}

/**
 * The settings, and what follows from them. `ROSTER_KIND` only names the
 * roster: its scope string and its platform table are written in protocol/.
 * Throws if the settings are not right (rosterSettingsProblem).
 */
export function rosterSettingsOf(env: Env): RosterSettings {
  const kind: string = env.ROSTER_KIND;
  const problem = rosterSettingsProblem(kind, env.ROSTER_OBJECT_NAME);
  if (problem !== null || (kind !== "test" && kind !== "production")) throw new Error(problem ?? "ROSTER_KIND");
  return { kind, platforms: platformsOf(kind) };
}
