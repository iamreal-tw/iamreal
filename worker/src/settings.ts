// What the environment's settings say about its roster (wrangler.jsonc,
// "vars"). The Worker and the roster's Durable Object both read them here.
//
// A note on names: in protocol/ `Roster` is a type, which roster,
// "production" or "test". In worker/ `Roster` is the Durable Object's class
// (roster.ts). So worker/ imports protocol/'s type as `RosterKind`, always.
import { type PlatformRow, platformsOf } from "iamreal-protocol/platforms.ts";
import type { Roster as RosterKind } from "iamreal-protocol/scope.ts";

export type { RosterKind };

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
 * The setting `ROSTER_KIND`, "test" or "production", and what follows from
 * it. The setting only names the roster: its scope string and its platform
 * table are written in protocol/. Throws for any other value.
 */
export function rosterSettingsOf(env: Env): RosterSettings {
  const kind: string = env.ROSTER_KIND;
  if (kind !== "test" && kind !== "production") throw new Error("ROSTER_KIND is neither test nor production");
  return { kind, platforms: platformsOf(kind) };
}
