// Everything that differs between platforms, in one definition: the name,
// how an account is written, which account names are well-formed and the
// hint the screen gives when one is not, the account's public page, the
// scope string, and whether the platform is open. The screen and the engine
// take these from here; no other file writes a platform's name, its prefix
// or its scope string.
//
// The scope strings are fixed here, keyed by the platform the cardholder
// picked on the screen; never taken from a server or the page's address
// (spec/scope.md, ADR-0007, ADR-0016). spec/scope.ts builds its table from
// this one.
//
// The format hint is a sentence, so it lives in design/copy/card-proof.json
// (group `formats`); `formatHint` is its key there.

export type Roster = "production" | "test";

/** The platforms a card proof can be made for. */
export type Platform = "threads";

export interface OpenPlatform {
  readonly key: Platform;
  readonly open: true;
  /** The platform's name, as the screen writes it. */
  readonly name: string;
  /** What the screen writes before an account name (Threads: `@`). */
  readonly prefix: string;
  /** The `username` format of the scope, matched against the whole value. */
  readonly validUsername: (username: string) => boolean;
  /**
   * What the screen does with what the cardholder typed before it checks
   * the format: drop one leading prefix, lowercase ASCII letters if the
   * platform does not distinguish case. Only `A`..`Z` are changed, so no
   * other character can turn into an accepted one.
   */
  readonly normalize: (typed: string) => string;
  /** The key of the format hint in design/copy/card-proof.json's `formats`. */
  readonly formatHint: string;
  /** The account's public page on the platform, opened by "預覽個人檔案"; null if the platform has none. */
  readonly profileUrl: ((username: string) => string) | null;
  /** The path of the account's page on iamreal's site, after the domain: `threads/@alice`. */
  readonly accountPath: (username: string) => string;
  readonly scopeStrings: Readonly<Record<Roster, string>>;
}

/** A platform listed on the screen as not open yet: no scope string, cannot be picked. */
export interface ClosedPlatform {
  readonly key: string;
  readonly open: false;
  readonly name: string;
}

const threads: OpenPlatform = Object.freeze({
  key: "threads",
  open: true,
  name: "Threads",
  prefix: "@",
  validUsername: (u: string): boolean => /^[a-z0-9._]{1,30}$/.test(u) && u.length <= 30,
  // Threads does not distinguish case.
  normalize: (typed: string): string => (typed.startsWith("@") ? typed.slice(1) : typed).replace(/[A-Z]/g, (c) => c.toLowerCase()),
  formatHint: "threads",
  profileUrl: (u: string): string => `https://www.threads.com/@${u}`,
  accountPath: (u: string): string => `threads/@${u}`,
  scopeStrings: Object.freeze({ production: "iamreal:threads:0______________", test: "iamreal-test:threads:0_________" }),
});

const x: ClosedPlatform = Object.freeze({ key: "x", open: false, name: "X" });

/** In the order the screen lists them. */
export const PLATFORMS: readonly (OpenPlatform | ClosedPlatform)[] = Object.freeze([threads, x]);

/** The open platform `key`. */
export function platformOf(key: Platform): OpenPlatform {
  const p = PLATFORMS.find((p): p is OpenPlatform => p.open && p.key === key);
  if (!p) throw new Error(`no open platform ${key}`);
  return p;
}

/** An account as the screen writes it: the platform's prefix and the name (`@alice`). */
export function handle(p: OpenPlatform, username: string): string {
  return p.prefix + username;
}

/**
 * The domain of iamreal's site, as links on the screen write it. The page
 * itself never connects to it (it is served from its own origin).
 */
export const SITE_DOMAIN = "iamreal.tw";
