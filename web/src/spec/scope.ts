// Scope strings (spec/scope.md, ADR-0007). The device takes the scope string
// only from the table below, keyed by the platform the cardholder picked on
// the screen; never from a server response (ADR-0016). The table is built
// from the platform definition (src/platforms.ts), the one place a scope
// string is written.
import { type OpenPlatform, PLATFORMS, type Platform, type Roster } from "../platforms.ts";

export type { Platform, Roster };

export interface ScopeRow {
  readonly scopeString: string;
  readonly platform: Platform;
  /** The `username` format of the scope, matched against the whole value. */
  readonly validUsername: (username: string) => boolean;
}

const open = PLATFORMS.filter((p): p is OpenPlatform => p.open);
const rowsOf = (roster: Roster): readonly ScopeRow[] =>
  Object.freeze(open.map((p) => Object.freeze({ scopeString: p.scopeStrings[roster], platform: p.key, validUsername: p.validUsername })));

const SCOPES: Readonly<Record<Roster, readonly ScopeRow[]>> = Object.freeze({
  production: rowsOf("production"),
  test: rowsOf("test"),
});

/** The scope row a roster lists for a platform. */
export function scopeFor(roster: Roster, platform: Platform): ScopeRow {
  const row = SCOPES[roster].find((s) => s.platform === platform);
  if (!row) throw new Error(`no scope for ${platform} in the ${roster} roster`);
  return row;
}

/** Whether `scopeString` is accepted by `roster`, in its exact spelling. */
export function lookupScope(roster: Roster, scopeString: string): ScopeRow | null {
  return SCOPES[roster].find((s) => s.scopeString === scopeString) ?? null;
}
