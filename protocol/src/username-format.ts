// The `username` format of a platform and the platform ID (spec/scope.md,
// "Platforms"). The device gets each platform's format from the server as a
// string (docs/api/card-proof.md, `config`) and reads its one form itself,
// one character class followed by one length range, `[…]{m,n}`; it never
// hands a server's string to a regular expression engine. A format not in
// that form is a row the device cannot read.
//
// The reading is the one of server/api_test.go (parseUsernameFormat): in the
// class, `x-y` is a range and any other character stands for itself (so a
// `-` first or last is itself). On top of it, what spec/scope.md says no
// format allows makes the format unreadable here: `"`, `\`, a control
// character, a non-ASCII character. A class that starts with `^` or holds
// `[` or `]` is not read either: a regular expression engine would read it
// otherwise, and the server's own check is not this reader.
import { byBytes } from "./bytes.ts";

export interface UsernameFormat {
  /** The format as the server wrote it. */
  readonly text: string;
  readonly min: number;
  readonly max: number;
  /** Whether `username` is in the format, as a whole value. */
  readonly accepts: (username: string) => boolean;
}

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** A decimal number without leading zeros and with at most 9 digits; null otherwise. */
function decimal(s: string): number | null {
  if (s.length === 0 || s.length > 9) return null;
  for (let i = 0; i < s.length; i++) if (!isDigit(s.charCodeAt(i))) return null;
  if (s.length > 1 && s[0] === "0") return null;
  return Number(s);
}

/** Reads `[…]{m,n}`; null if `text` is not in that form, or allows a character no format may. */
export function parseUsernameFormat(text: unknown): UsernameFormat | null {
  if (typeof text !== "string" || text.length < 6 || text.length > 200) return null;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return null;
  }
  if (text[0] !== "[") return null;
  const close = text.indexOf("]", 1);
  if (close < 2) return null;
  const cls = text.slice(1, close);
  const tail = text.slice(close + 1);
  if (cls[0] === "^" || cls.includes("[")) return null;
  if (tail[0] !== "{" || tail[tail.length - 1] !== "}") return null;
  const range = tail.slice(1, -1).split(",");
  if (range.length !== 2) return null;
  const min = decimal(range[0]!);
  const max = decimal(range[1]!);
  if (min === null || max === null || min < 1 || max < min) return null;

  const allowed = new Array<boolean>(128).fill(false);
  for (let i = 0; i < cls.length; i++) {
    const a = cls.charCodeAt(i);
    if (i + 2 < cls.length && cls[i + 1] === "-") {
      const b = cls.charCodeAt(i + 2);
      if (b < a) return null;
      for (let c = a; c <= b; c++) allowed[c] = true;
      i += 2;
      continue;
    }
    allowed[a] = true;
  }
  // spec/scope.md: no format allows `"`, `\`, a control character (nor, here, a space).
  if (allowed[0x22] || allowed[0x5c]) return null;
  for (let c = 0; c <= 0x20; c++) if (allowed[c]) return null;
  if (allowed[0x7f]) return null;

  const accepts = (u: string): boolean => {
    if (typeof u !== "string" || u.length < min || u.length > max) return false;
    for (let i = 0; i < u.length; i++) {
      const c = u.charCodeAt(i);
      if (c >= 128 || !allowed[c]) return false;
    }
    return true;
  };
  return Object.freeze({ text, min, max, accepts });
}

/** A platform ID: 1 to 21 characters of a-z, 0-9, `-` (spec/scope.md). */
export function isPlatformId(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 1 || s.length > 21) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 0x61 && c <= 0x7a) || isDigit(c) || c === 0x2d)) return false;
  }
  return true;
}

/**
 * What every `username` satisfies, whatever its platform's format: 1 or more
 * printable ASCII characters without `"` and `\`. The only check the device
 * can make of an account on a platform it does not know, which it keeps in
 * the list as it is (docs/api/card-proof.md, card-state).
 */
export function isAnyUsername(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 1) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || c === 0x22 || c === 0x5c) return false;
  }
  return true;
}

/** Compares platform IDs by their byte values (ASCII order), as every list is ordered. */
export function byPlatform(a: { platform: string }, b: { platform: string }): number {
  return byBytes(a.platform, b.platform);
}
