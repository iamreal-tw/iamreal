// What the screen writes differently for each platform and that the server
// does not send (design/copy/card-proof.md, "每個平台不同的東西"): how an
// account is written (Threads: `@` before the name), how a typed account is
// tidied before its format is checked, the key of the format hint in
// design/copy/card-proof.json, and the account's public page that "預覽個人
// 檔案" opens. Keyed by the platform ID.
//
// Which platforms a card proof lists, their display names and their
// `username` formats come from the server's platform table
// (docs/api/card-proof.md, `config`, read by src/api.ts), not from here; a
// platform of the table without an entry here is written without a prefix,
// with no format hint (the screen shows the code) and no preview. The scope
// string is not a platform's: there is one for the public roster
// (src/spec/scope.ts).

export interface Presentation {
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

const threads: Presentation = Object.freeze({
  prefix: "@",
  // Threads does not distinguish case.
  normalize: (typed: string): string => (typed.startsWith("@") ? typed.slice(1) : typed).replace(/[A-Z]/g, (c) => c.toLowerCase()),
  formatHint: "threads",
  profileUrl: (u: string): string => `https://www.threads.com/@${u}`,
});

/** A platform the device has nothing of its own for: the name as typed, no prefix, no hint, no preview. */
const PLAIN: Presentation = Object.freeze({ prefix: "", normalize: (typed: string): string => typed, formatHint: null, profileUrl: null });

const PRESENTATIONS: ReadonlyMap<string, Presentation> = new Map([["threads", threads]]);

/** How the screen writes and checks accounts of platform `id`. */
export function presentationOf(id: string): Presentation {
  return PRESENTATIONS.get(id) ?? PLAIN;
}

/** An account as the screen writes it: the platform's prefix and the name (`@alice`). */
export function handle(platform: string, username: string): string {
  return presentationOf(platform).prefix + username;
}

/**
 * The domain of iamreal's site, as links on the screen write it. The page
 * itself never connects to it (it is served from its own origin).
 */
export const SITE_DOMAIN = "iamreal.tw";

/** The path of a card's page on iamreal's site, after the domain: `card/` and the 10 characters of the short ID. */
export function cardPath(shortId: string): string {
  return `card/${shortId}`;
}
