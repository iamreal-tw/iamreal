// The connection log (ADR-0022): one object in a bucket of its own for each
// submission of a record (`POST /api/v1/records`) that the proof log's
// object counted, and for nothing else. The bucket is private and has no
// public domain; its lifecycle rule deletes every object under
// `connection/` 31 days after it was written (README.md, "連線紀錄").
// Whether that rule does its work is seen from outside: every hour the
// date of the oldest entry is published, and nothing else of the log
// (`oldestDay`).
//
// What an object holds is all there is in `entryOf`, and no more: this is
// where the back end keeps an IP address.
//
// - A submission that became a record: the request ID, the time, the status
//   answered, the IP address, the country code and AS number Cloudflare
//   gave for it, the card proof device ID if the request carried one
//   (ADR-0039), and the `seq` of the record. Not the body: it is in the
//   proof log.
// - A submission that carried a challenge the back end issued and did not
//   become a record: the same without `seq`, with the error code answered
//   and the body as it came.
//
// Nothing of this module asks the proof log's object, and the request does
// not wait for the write: an object that could not be written is one line
// in the live log, and the answer is what it would have been.

/** A submission the proof log's object counted, as far as the connection log keeps it. */
export interface CountedSubmission {
  /** The card proof device ID the request carried (ADR-0039), or null. */
  readonly deviceId: string | null;
  /** The body as it came: kept only if the submission did not become a record. */
  readonly body: string;
}

/** What the connection log keeps of a submission that became a record. */
interface AcceptedEntry {
  readonly request_id: string;
  readonly time: string;
  readonly result: number;
  readonly ip: string | null;
  readonly country: string | null;
  readonly asn: number | null;
  readonly device_id: string | null;
  readonly seq: number;
}

/** What the connection log keeps of a submission that did not. */
interface RefusedEntry {
  readonly request_id: string;
  readonly time: string;
  readonly result: number;
  readonly error: string;
  readonly ip: string | null;
  readonly country: string | null;
  readonly asn: number | null;
  readonly device_id: string | null;
  readonly body: string;
}

export type ConnectionLogEntry = AcceptedEntry | RefusedEntry;

/** How a submission ended: the status answered, and the record's `seq` or the error code. */
export type SubmissionEnd = { readonly status: number; readonly seq: number } | { readonly status: number; readonly error: string };

/**
 * The entry of one counted submission. The IP address is the one Cloudflare
 * says the request came from (`CF-Connecting-IP`); the country code and the
 * AS number are Cloudflare's too (`request.cf`). Where Cloudflare gave none
 * (a request in a local workerd), null.
 */
export function entryOf(request: Request, requestId: string, time: Date, submission: CountedSubmission, end: SubmissionEnd): ConnectionLogEntry {
  const cf = request.cf as { country?: unknown; asn?: unknown } | undefined;
  const from = {
    ip: request.headers.get("CF-Connecting-IP"),
    country: typeof cf?.country === "string" ? cf.country : null,
    asn: typeof cf?.asn === "number" ? cf.asn : null,
    device_id: submission.deviceId,
  };
  const head = { request_id: requestId, time: time.toISOString(), result: end.status };
  return "seq" in end ? { ...head, ...from, seq: end.seq } : { ...head, error: end.error, ...from, body: submission.body };
}

/**
 * Under this prefix, and under no other, the bucket's lifecycle rule
 * deletes after 31 days: the bucket may hold other things under other
 * prefixes.
 */
export const CONNECTION_LOG_PREFIX = "connection/";

/** The key of an entry: the prefix, its date (UTC, as its `time` is), then its time and request ID, so that a day's entries list in order. */
export const keyOf = (entry: ConnectionLogEntry): string => `${CONNECTION_LOG_PREFIX}${entry.time.slice(0, 10)}/${entry.time}-${entry.request_id}.json`;

/**
 * Writes one entry. It does not throw: a bucket that did not take the
 * object is one line in the live log, with the request ID and the error's
 * class, and nothing of the entry.
 */
export async function writeEntry(bucket: R2Bucket, entry: ConnectionLogEntry): Promise<void> {
  try {
    await bucket.put(keyOf(entry), JSON.stringify(entry), { httpMetadata: { contentType: "application/json" } });
  } catch (e) {
    console.error(JSON.stringify({ event: "connection_log_not_written", id: entry.request_id, error: e instanceof Error ? e.name : "unknown" }));
  }
}

/**
 * The date (UTC, `YYYY-MM-DD`) of the oldest entry the bucket holds, or
 * null if it holds none. A key begins with its entry's date and a bucket
 * lists its keys in order, so the first key under the prefix is the oldest
 * entry's: one request, whatever the log holds. Throws if the bucket cannot
 * be listed, or if that key is not an entry's: then nothing can be said.
 * With another `prefix`, the same of what the bucket holds under it, whose
 * keys begin with a date in the same way (the counts, counts.ts), or are a
 * date and `.json` (the days' totals, count-totals.ts).
 */
export async function oldestDay(bucket: R2Bucket, prefix: string = CONNECTION_LOG_PREFIX): Promise<string | null> {
  const first = (await bucket.list({ prefix, limit: 1 })).objects[0];
  if (first === undefined) return null;
  const day = /^(\d{4}-\d{2}-\d{2})(?:\/|\.json$)/.exec(first.key.slice(prefix.length))?.[1];
  if (day === undefined) throw new Error("the first key under the prefix does not begin with a date");
  return day;
}

/** Where the oldest entry's date is published, in the bucket of the public data. */
export const OLDEST_KEY = "connection-log/oldest.json";

/**
 * What is published of the connection log, and all that is: when the
 * bucket was looked at, and the date of its oldest entry. Not how many
 * entries there are, no key, nothing an entry holds. Whoever checks from
 * outside reads from it whether the bucket's lifecycle rule deletes what
 * is older than 31 days (README.md, "連線紀錄"), and whether this look
 * still happens.
 */
export const oldestFile = (checked: Date, oldest: string | null): string => `${JSON.stringify({ checked: checked.toISOString(), oldest })}\n`;

/**
 * How old the oldest entry may be before something is wrong, in days: the
 * 31 days of the lifecycle rule, the day R2 may take to remove an object
 * that has expired, and a day for the dates being whole days in UTC.
 */
export const OVERDUE_DAYS = 33;

/** Whether an entry of the day `oldest` is older, at `time`, than any entry should be (`OVERDUE_DAYS`). */
export function isOverdue(oldest: string | null, time: Date): boolean {
  if (oldest === null) return false;
  const today = Date.parse(`${time.toISOString().slice(0, 10)}T00:00:00Z`);
  return today - Date.parse(`${oldest}T00:00:00Z`) > OVERDUE_DAYS * 24 * 60 * 60 * 1000;
}
