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

/** The device's answer to a challenge the server issued (spec/challenge.md, "The cardholder's device"). */
export type ChallengeCheck =
  | { ok: true; day: Day }
  | { ok: false; problem: "challenge_malformed" }
  | { ok: false; problem: "challenge_not_today"; challengeDay: Day; today: Day };

/**
 * The device's check of a challenge the server issued: in its one spelling,
 * and dated `today`, the date in Taiwan by the device's clock. A challenge
 * that is not in its one spelling is `challenge_malformed`, whatever date it
 * starts with.
 */
export function checkChallenge(challenge: unknown, today: Day): ChallengeCheck {
  const day = parseChallenge(challenge);
  if (day === null) return { ok: false, problem: "challenge_malformed" };
  if (day !== today) return { ok: false, problem: "challenge_not_today", challengeDay: day, today };
  return { ok: true, day };
}

/**
 * `current_time` for a date:the decimal integer YYMMDD155959, the last
 * second of that date in Taiwan written in UTC.
 */
export function currentTime(day: Day): bigint {
  const [y, m, d] = ymdOf(day);
  return BigInt(y % 100) * 10_000_000_000n + BigInt(m) * 100_000_000n + BigInt(d) * 1_000_000n + 155959n;
}
