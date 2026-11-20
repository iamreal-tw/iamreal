// The times of a CRL as the archive index writes them
// (spec/revocation-tree.md, "Archive index"): seconds since the epoch, to
// and from the proleptic Gregorian calendar. Written out instead of using
// `Date`, so that every time Go's crl/ accepts gives the same text here,
// including years before 1000 and after 9999.

const DAY = 86400;
/** Taiwan is UTC+8, without daylight saving time. */
const TAIWAN = 8 * 3600;

const leap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days from 1970-01-01 to the given date. */
function daysOfCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The time as seconds since the epoch, or `undefined` if it is not a date and a time of day. */
export function secondsOfCivil(year: number, month: number, day: number, hour: number, minute: number, second: number): number | undefined {
  if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]! + (month === 2 && leap(year) ? 1 : 0)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return daysOfCivil(year, month, day) * DAY + hour * 3600 + minute * 60 + second;
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");
/** A year as Go's `time` writes it: at least four digits, after the sign if it is negative. */
const yearText = (year: number): string => (year < 0 ? `-${pad(-year, 4)}` : pad(year, 4));

function dateText(days: number): string {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${yearText(year)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
export function formatTime(seconds: number): string {
  const days = Math.floor(seconds / DAY);
  const rest = seconds - days * DAY;
  return `${dateText(days)}T${pad(Math.floor(rest / 3600), 2)}:${pad(Math.floor(rest / 60) % 60, 2)}:${pad(rest % 60, 2)}Z`;
}

/** The CRL date: the time as a date in Taiwan, `YYYY-MM-DD`. */
export function formatDate(seconds: number): string {
  return dateText(Math.floor((seconds + TAIWAN) / DAY));
}
