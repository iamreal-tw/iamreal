// Calendar dates as day numbers (days since 1970-01-01), the way the
// specification compares them: CRL dates, challenge dates, roster dates.
// Taiwan is UTC+8 without daylight saving time.

export type Day = number;

const MS_PER_DAY = 86_400_000;
const TAIWAN_OFFSET_MS = 8 * 3_600_000;

/**
 * Today's date in Taiwan for an absolute time (milliseconds since the epoch,
 * as `Date.now()` gives). The device's time zone setting is not used.
 */
export function taiwanDay(epochMs: number): Day {
  return Math.floor((epochMs + TAIWAN_OFFSET_MS) / MS_PER_DAY);
}

export function dayOf(year: number, month: number, day: number): Day {
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

export function ymdOf(d: Day): [number, number, number] {
  const t = new Date(d * MS_PER_DAY);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

export function formatDay(d: Day): string {
  const [y, m, dd] = ymdOf(d);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Parses `YYYY-MM-DD` with a year from 2000 to 2049, a date that exists.
 * Returns null for anything else.
 */
export function parseDay(s: string): Day | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) || s.length !== 10) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 2000 || y > 2049 || m < 1 || m > 12 || d < 1) return null;
  const day = dayOf(y, m, d);
  const [yy, mm, dd] = ymdOf(day);
  return yy === y && mm === m && dd === d ? day : null;
}

/** The date in Taiwan of a UTC instant given in seconds since the epoch. */
export function taiwanDayOfSeconds(seconds: number): Day {
  return taiwanDay(seconds * 1000);
}
