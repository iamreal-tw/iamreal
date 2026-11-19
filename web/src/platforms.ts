// What the screen writes for each platform, fixed on the device
// (design/copy/card-proof.md, "每個平台不同的東西"): the platform's name,
// how an account is written (Threads: `@` before the name), how a typed
// account is tidied before its format is checked, the key of the format
// hint in design/copy/card-proof.json, and the account's public page that
// "預覽個人檔案" opens. Keyed by the platform ID. Each platform's definition
// is its own module (src/presentations/); the build's target
// (src/target.ts) says which ones the page has, so that a test platform is
// in no production build.
//
// A platform can be edited on the screen only if the server's platform
// table has a row for it the device can read (its `username` format comes
// from there, docs/api/card-proof.md) and the device has its own definition
// here. A platform of the server's table without one is a platform the
// device does not know: an account on it is kept as it is, shown by its ID,
// and cannot be changed (src/flow.ts). The server's display name is not
// shown. The scope string is not a platform's: there is one for the public
// roster (protocol/src/scope.ts).
import { PRESENTATIONS } from "./target.ts";

export interface Presentation {
  /** The platform ID this definition is for. */
  readonly platform: string;
  /** The platform's name, as the screen writes it. */
  readonly name: string;
  /** What the screen writes before an account name (Threads: `@`). */
  readonly prefix: string;
  /**
   * What the screen does with what the cardholder typed before the format is
   * checked: drop one leading prefix, lowercase ASCII letters if the
   * platform does not distinguish case. Only `A`..`Z` are changed, so no
   * other character can turn into an accepted one.
   */
  readonly normalize: (typed: string) => string;
  /** The key of the format hint in design/copy/card-proof.json's `formats`; null if it has none. */
  readonly formatHint: string | null;
  /** The account's public page on the platform, opened by "預覽個人檔案"; null if the platform has none. */
  readonly profileUrl: ((username: string) => string) | null;
}

const BY_ID: ReadonlyMap<string, Presentation> = new Map(PRESENTATIONS.map((p) => [p.platform, p]));

/** The device's own definition of platform `id`; null for a platform the device does not know. */
export function presentationOf(id: string): Presentation | null {
  return BY_ID.get(id) ?? null;
}

/** The IDs of the platforms the device has its own definition of. */
export const KNOWN_PLATFORMS: ReadonlySet<string> = new Set(BY_ID.keys());

/** An account as the screen writes it: the platform's prefix and the name (`@alice`); as it is for a platform the device does not know. */
export function handle(platform: string, username: string): string {
  return (presentationOf(platform)?.prefix ?? "") + username;
}

/**
 * The domain of iamreal's site, as links on the screen write it. The page
 * itself never connects to it (it is served from its own origin).
 */
export const SITE_DOMAIN = "iamreal.tw";

/** The path of a card's page (its proof page) on iamreal's site, after the domain: `p/` and the 10 characters of the short ID. */
export function cardPath(shortId: string): string {
  return `p/${shortId}`;
}
