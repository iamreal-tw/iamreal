// Scope strings (spec/scope.md, ADR-0007). The device takes the scope string
// only from the table below, keyed by the platform the cardholder picked on
// the screen; never from a server response (ADR-0016).

export type Roster = "production" | "test";
export type Platform = "threads";

export interface ScopeRow {
  readonly scopeString: string;
  readonly platform: Platform;
  /** The `username` format of the scope, matched against the whole value. */
  readonly validUsername: (username: string) => boolean;
}

const threadsUsername = (u: string): boolean => /^[a-z0-9._]{1,30}$/.test(u) && u.length <= 30;

const SCOPES: Readonly<Record<Roster, readonly ScopeRow[]>> = Object.freeze({
  production: Object.freeze([
    Object.freeze({ scopeString: "iamreal:threads:0______________", platform: "threads", validUsername: threadsUsername }),
  ]),
  test: Object.freeze([
    Object.freeze({ scopeString: "iamreal-test:threads:0_________", platform: "threads", validUsername: threadsUsername }),
  ]),
} as const);

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

/**
 * What the screen does with what the cardholder typed: drop one leading `@`
 * and lowercase ASCII letters (Threads does not distinguish case). Only
 * `A`..`Z` are changed, so no other character can turn into an accepted one.
 * The result still has to pass the scope's `validUsername`.
 */
export function normalizeUsername(typed: string): string {
  const u = typed.startsWith("@") ? typed.slice(1) : typed;
  return u.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
