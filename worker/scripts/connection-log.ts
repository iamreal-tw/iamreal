// The operator's query of the connection log (#417, ADR-0022): run on the
// operator's computer, never by the back end, which has no way to read the
// log back. It takes the UTC days of a range, reads every entry of those
// days, and prints the ones that match, one JSON line each, oldest first:
//
//   node --experimental-strip-types scripts/connection-log.ts --from 2026-11-20 --to 2026-11-21
//     [--after <time>] [--before <time>]      within these times (ISO, UTC: 2026-11-20T08:00:00Z)
//     [--result accepted|refused|<status>|<error code>]
//     [--ip <address>]                        exactly this address
//     [--device <card proof device ID>]       this device's submissions (#431)
//     [--body]                                with the body of a refused submission
//
// What an entry holds is worker/src/connection-log.ts's: request ID, time,
// status, IP address, country, AS number, card proof device ID, and the
// record's seq or the error code and the body. The body is left out of the
// lines unless asked for: it is a whole submission.
//
// The log is read through `Store`. On the operator's computer that is the
// bucket iamreal-test-logs, through R2's S3 API, with a token that can only
// read and list the objects of that one bucket ("Object Read only"), made
// when it is needed and deleted after (README.md, "查連線紀錄"). Its keys
// are in a file of the operator's (`KEY_FILE`), never in the repository.
// The requests are signed here (AWS Signature Version 4, node:crypto): no
// package is added for two kinds of GET.
import { createHash, createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The prefix of src/connection-log.ts (CONNECTION_LOG_PREFIX), written again: that file needs the Workers runtime's types. test/connection-log-query.test.ts reads it there. */
export const CONNECTION_LOG_PREFIX = "connection/";
/** The bucket of the test site's connection log (wrangler.jsonc, CONNECTION_LOG). */
export const BUCKET = "iamreal-test-logs";
/** Where the operator keeps the token's keys: README.md, "查連線紀錄". */
export const KEY_FILE = join(homedir(), ".config", "iamreal", "connection-log.env");
/** The section of README.md that says how to make the token and the file. */
export const README_SECTION = "worker/README.md「查連線紀錄」";

/** One entry, as the back end wrote it (connection-log.ts, entryOf). */
export interface Entry {
  readonly request_id: string;
  readonly time: string;
  readonly result: number;
  readonly ip: string | null;
  readonly country: string | null;
  readonly asn: number | null;
  readonly device_id: string | null;
  readonly seq?: number;
  readonly error?: string;
  readonly body?: string;
}

/** Where the entries are read from: the keys under a prefix, in order, and the text of one. */
export interface Store {
  keys(prefix: string): Promise<string[]>;
  text(key: string): Promise<string | null>;
}

/** What to look for. Days are UTC dates (YYYY-MM-DD), as the keys are. */
export interface Query {
  readonly from: string;
  readonly to: string;
  /** Times as `Date.parse` reads an ISO time with its zone: entries at or after `after`, before `before`. */
  readonly after?: string;
  readonly before?: string;
  /** `accepted` (it became a record), `refused` (it did not), a status (201, 409, …), or an error code (challenge_used, …). */
  readonly result?: string;
  readonly ip?: string;
  readonly device?: string;
}

/** The longest range of days one query reads: the log keeps 31 days, and up to two more until R2 removes them. */
export const MAX_DAYS = 33;

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** The UTC dates from `from` to `to`, both included. Throws for a range this query does not take. */
export function daysOf(from: string, to: string): string[] {
  if (!DAY.test(from) || !DAY.test(to)) throw new Error("--from and --to are dates, YYYY-MM-DD (UTC)");
  const [start, end] = [Date.parse(`${from}T00:00:00Z`), Date.parse(`${to}T00:00:00Z`)];
  if (Number.isNaN(start) || Number.isNaN(end) || new Date(start).toISOString().slice(0, 10) !== from || new Date(end).toISOString().slice(0, 10) !== to) throw new Error("--from and --to are dates, YYYY-MM-DD (UTC)");
  if (end < start) throw new Error("--to is before --from");
  const n = (end - start) / DAY_MS + 1;
  if (n > MAX_DAYS) throw new Error(`a range of at most ${MAX_DAYS} days`);
  return Array.from({ length: n }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

/** Whether `entry` is one `q` looks for, the day aside. */
export function matches(entry: Entry, q: Query): boolean {
  const at = Date.parse(entry.time);
  if (q.after !== undefined && !(at >= Date.parse(q.after))) return false;
  if (q.before !== undefined && !(at < Date.parse(q.before))) return false;
  if (q.result !== undefined) {
    const r = q.result;
    const ok =
      r === "accepted" ? entry.seq !== undefined : r === "refused" ? entry.seq === undefined : /^\d{3}$/.test(r) ? entry.result === Number(r) : entry.error === r;
    if (!ok) return false;
  }
  if (q.ip !== undefined && entry.ip !== q.ip) return false;
  if (q.device !== undefined && entry.device_id !== q.device) return false;
  return true;
}

/** The entries of the days of `q` that match it, oldest first. An object that is not an entry stops the query: it says which. */
export async function query(store: Store, q: Query): Promise<Entry[]> {
  for (const t of [q.after, q.before]) if (t !== undefined && !TIME.test(t)) throw new Error(`${t}: a time is ISO with its zone, such as 2026-11-20T08:00:00Z`);
  const found: Entry[] = [];
  for (const day of daysOf(q.from, q.to)) {
    for (const key of await store.keys(`${CONNECTION_LOG_PREFIX}${day}/`)) {
      const text = await store.text(key);
      if (text === null) continue; // removed by the lifecycle rule since it was listed
      let entry: Entry;
      try {
        entry = JSON.parse(text) as Entry;
      } catch {
        throw new Error(`${key} is not an entry`);
      }
      if (typeof entry.time !== "string" || typeof entry.request_id !== "string") throw new Error(`${key} is not an entry`);
      if (matches(entry, q)) found.push(entry);
    }
  }
  return found.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** One printed line: the entry, without the body unless `body`. */
export const lineOf = (entry: Entry, body: boolean): string => {
  const { body: b, ...rest } = entry;
  return JSON.stringify(body && b !== undefined ? { ...rest, body: b } : rest);
};

/** The query of the command line's arguments, and whether to print bodies. Throws, saying how, for arguments it does not take. */
export function queryOf(args: readonly string[]): { query: Query; body: boolean } {
  const q: Record<string, string> = {};
  let body = false;
  const names = new Set(["from", "to", "after", "before", "result", "ip", "device"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--body") {
      body = true;
      continue;
    }
    const name = a.startsWith("--") ? a.slice(2) : "";
    const value = args[i + 1];
    if (!names.has(name) || value === undefined || value.startsWith("--")) throw new Error(`not an argument this takes: ${a} (see the top of scripts/connection-log.ts)`);
    q[name] = value;
    i++;
  }
  if (q.from === undefined || q.to === undefined) throw new Error("--from and --to are needed: the UTC dates of the range");
  return { query: q as unknown as Query, body };
}

// R2's S3 API ---------------------------------------------------------------------

/** The token's keys and the account, as the key file holds them. */
export interface Keys {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * The keys in `file`: lines of NAME=value, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID
 * and R2_SECRET_ACCESS_KEY. Throws, saying where to read how to make it,
 * when there is no such file, when another user may read it, or when a
 * name is missing; never with anything the file holds.
 */
export function keysIn(file: string = KEY_FILE): Keys {
  let text: string;
  try {
    const mode = statSync(file).mode;
    if ((mode & 0o077) !== 0) throw new Error(`${file} can be read by other users of this computer: chmod 600 it (${README_SECTION})`);
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof Error && e.message.includes("chmod 600")) throw e;
    throw new Error(`no key file at ${file}: how to make the token and this file is in ${README_SECTION}`);
  }
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values.set(m[1]!, m[2]!);
  }
  const need = (name: string): string => {
    const v = values.get(name);
    if (v === undefined || v === "") throw new Error(`${file} has no ${name} (${README_SECTION})`);
    return v;
  };
  return { accountId: need("R2_ACCOUNT_ID"), accessKeyId: need("R2_ACCESS_KEY_ID"), secretAccessKey: need("R2_SECRET_ACCESS_KEY") };
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string): Buffer => createHmac("sha256", key).update(s).digest();
/** RFC 3986 percent-encoding, as S3 wants it: every byte but the unreserved characters, and `/` too unless `path`. */
const encode = (s: string, path: boolean): string =>
  [...Buffer.from(s, "utf8")].map((b) => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) || (path && b === 0x2f) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`)).join("");

/** One request to sign: an S3 GET, its path, its query and the headers to sign, `host` and `x-amz-*` among them. */
export interface Unsigned {
  readonly method: string;
  readonly path: string;
  readonly query: readonly (readonly [string, string])[];
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

/**
 * The Authorization header of AWS Signature Version 4 for `r`
 * (https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html),
 * dated by its `x-amz-date` header. test/connection-log-query.test.ts
 * checks it against the examples of that page.
 */
export function authorization(r: Unsigned, keys: { accessKeyId: string; secretAccessKey: string }, region: string, service = "s3"): string {
  const amzDate = r.headers["x-amz-date"]!;
  const day = amzDate.slice(0, 8);
  const names = Object.keys(r.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/ +/g, " ")]));
  const canonical = [
    r.method,
    encode(r.path, true),
    [...r.query].map(([k, v]) => [encode(k, false), encode(v, false)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&"),
    names.map((h) => `${h}:${lower[h]}\n`).join(""),
    names.join(";"),
    r.payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${keys.secretAccessKey}`, day), region), service), "aws4_request");
  return `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope},SignedHeaders=${names.join(";")},Signature=${hmac(signingKey, toSign).toString("hex")}`;
}

/** The empty payload's SHA-256: every request here is a GET. */
const EMPTY = sha256("");

/** The bucket through R2's S3 API (https://<account>.r2.cloudflarestorage.com, region auto): ListObjectsV2 and GetObject. */
export function r2Store(keys: Keys, bucket: string = BUCKET, fetchFn: typeof fetch = fetch): Store {
  const host = `${keys.accountId}.r2.cloudflarestorage.com`;
  const get = async (path: string, query: readonly (readonly [string, string])[]): Promise<Response> => {
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers = { host, "x-amz-content-sha256": EMPTY, "x-amz-date": amzDate };
    const auth = authorization({ method: "GET", path, query, headers, payloadHash: EMPTY }, keys, "auto");
    const search = query.map(([k, v]) => `${encode(k, false)}=${encode(v, false)}`).join("&");
    return fetchFn(`https://${host}${encode(path, true)}${search ? `?${search}` : ""}`, { headers: { "x-amz-content-sha256": EMPTY, "x-amz-date": amzDate, Authorization: auth } });
  };
  return {
    async keys(prefix) {
      const keys: string[] = [];
      for (let token: string | undefined; ; ) {
        const res = await get(`/${bucket}`, [["list-type", "2"], ["prefix", prefix], ...(token !== undefined ? [["continuation-token", token] as const] : [])]);
        const xml = await res.text();
        // Not the answer's body: the operator reads why in the dashboard, not in the terminal's history.
        if (res.status !== 200) throw new Error(`listing ${prefix} in ${bucket}: HTTP ${res.status} (is the token's bucket ${bucket}, and is it still there? ${README_SECTION})`);
        keys.push(...[...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => unescapeXml(m[1]!)));
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return keys;
        token = unescapeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "");
        if (token === "") throw new Error(`listing ${prefix} in ${bucket}: truncated with no continuation token`);
      }
    },
    async text(key) {
      const res = await get(`/${bucket}/${key}`, []);
      if (res.status === 404) return null;
      if (res.status !== 200) throw new Error(`reading ${key}: HTTP ${res.status}`);
      return res.text();
    },
  };
}

const unescapeXml = (s: string): string => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]!);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { query: q, body } = queryOf(process.argv.slice(2));
    const found = await query(r2Store(keysIn()), q);
    for (const e of found) console.log(lineOf(e, body));
    console.error(`${found.length} entries`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "the query failed");
    process.exit(1);
  }
}
