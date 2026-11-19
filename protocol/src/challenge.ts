// The challenge (spec/challenge.md): format in its one spelling, its date,
// and `current_time`.
import { decodeBase32Strict } from "./base32.ts";
import { type Day, parseDay, ymdOf } from "./date.ts";

export const CHALLENGE_LENGTH = 37;

const PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9A-HJKMNP-TV-Z]{25}[048CGMRW]$/;

/**
 * Returns the challenge's date, or null if the string is not a challenge in
 * its one spelling. The whole string is matched: no whitespace, no line feed.
 */
export function parseChallenge(challenge: unknown): Day | null {
  if (typeof challenge !== "string" || challenge.length !== CHALLENGE_LENGTH) return null;
  if (!PATTERN.test(challenge)) return null;
  if (decodeBase32Strict(challenge.slice(11), 16) === null) return null;
  return parseDay(challenge.slice(0, 10));
}

/**
 * `current_time` for a date: the decimal integer YYMMDD155959, the last
 * second of that date in Taiwan written in UTC.
 */
export function currentTime(day: Day): bigint {
  const [y, m, d] = ymdOf(day);
  return BigInt(y % 100) * 10_000_000_000n + BigInt(m) * 100_000_000n + BigInt(d) * 1_000_000n + 155959n;
}
