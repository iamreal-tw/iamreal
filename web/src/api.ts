// The requests to the server (docs/api/card-proof.md). Every path is on the
// page's own origin, except the CRL archive's, which is on the data domain
// (dataOriginFetch). Each response is read strictly, and what the device then
// does with each value is in the README's table. Nothing here reports a
// failure of the device's own checks to the server (ADR-0016): there is no
// request for that.
//
// Every request has a time limit, the response's body included. A request
// that runs out of it is aborted and counts as no answer (`network`), the
// same as a failed connection: a server that holds its answer cannot hold
// the device. The limits:
//
//   API_TIMEOUT_MS   config, card-state, challenge, submission: small JSON
//                    answers. The server answers from memory, or (a
//                    submission) after verifying one proof, well under a
//                    second; 30 s leaves room for a slow network and stays
//                    far inside the 5 minutes the PIN may wait (flow.ts).
//   FILE_TIMEOUT_MS  the mirror's index and CRL, the circuits, the CRS. The
//                    largest are G2's CRL (16.9 MB) and the CRS (8 MiB),
//                    fetched together with a circuit (0.8 MB) when the card
//                    is read: about 26 MB, which 5 minutes allow down to
//                    about 0.7 Mbit/s. They are all fetched before the first
//                    signature, so nothing secret waits on them.
import type { Account } from "iamreal-protocol/declaration-code.ts";
import { type Day, parseDay } from "iamreal-protocol/date.ts";
import type { PlatformRow } from "iamreal-protocol/platforms.ts";
import { type CardState, type Kind, MAX_SWITCHES, type SlotState, possibleCard, possibleSlot } from "iamreal-protocol/record-rules.ts";
import { isAnyUsername, isPlatformId, parseUsernameFormat } from "iamreal-protocol/username-format.ts";

/** The time limit of a request with a small JSON answer (see above). */
export const API_TIMEOUT_MS = 30_000;
/** The time limit of a static file: the CRL, the circuits, the CRS (see above). */
export const FILE_TIMEOUT_MS = 5 * 60_000;

/** `fetch` restricted to the page's own origin. Tests pass a fake. `signal` aborts the request (its time limit). */
export type Fetch = (path: string, init?: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }) => Promise<Response>;

/** The page's fetch: same origin, no credentials, no cache, no redirects. */
export function sameOriginFetch(path: string, init?: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("not a same-origin path");
  return fetch(path, {
    method: init?.method ?? "GET",
    body: init?.body,
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: init?.signal,
  });
}

/**
 * The fetch of the data domain's files (the CRL archive, ADR-0027): `GET`
 * of a path on `origin`, which the page's build fixes (src/target.ts); the
 * empty origin is the page's own. No credentials, no cache, no redirects,
 * like sameOriginFetch. The page's Content-Security-Policy allows this one
 * origin besides its own (README.md).
 */
export function dataOriginFetch(origin: string, fetchFn: typeof fetch = fetch): Fetch {
  return (path, init) => {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("not a path");
    if ((init?.method ?? "GET") !== "GET" || init?.body !== undefined) throw new Error("the data domain is only read");
    return fetchFn(origin + path, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: init?.signal,
    });
  };
}

/**
 * Runs `f` with a signal that aborts after `ms`; then rejects with
 * ServerError `network` whether or not `f` heeds the signal.
 */
async function withTimeout<T>(ms: number, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ServerError("network", 0));
    }, ms);
  });
  try {
    return await Promise.race([f(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error the server answered with (`{"error":"CODE"}`), or a response the device cannot read. */
export class ServerError extends Error {
  /** The server's code, `malformed_response` or `network`. */
  readonly code: string;
  readonly status: number;
  /** The response's X-Request-Id, for the cardholder to report; null without a response or a readable one. */
  readonly requestId: string | null;
  constructor(code: string, status: number, requestId: string | null = null) {
    super(`server: ${code} (${status})`);
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/** The server's request ID (worker/src/api.ts: 16 hex digits); anything else is not shown. */
function requestIdOf(res: Response): string | null {
  const id = res.headers.get("X-Request-Id");
  return id !== null && /^[0-9a-f]{1,64}$/.test(id) ? id : null;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The X-Request-Id of each answer read, so that an answer the device cannot read is reported with it. */
const ids = new WeakMap<object, string | null>();

/** `malformed_response` for the answer `body`, with its request ID. */
function unreadable(body: Record<string, unknown>, status: number): ServerError {
  return new ServerError("malformed_response", status, ids.get(body) ?? null);
}

async function request(fetchFn: Fetch, path: string, init: { method: "GET" | "POST"; body?: string }, okStatus: number): Promise<Record<string, unknown>> {
  const { res, body } = await withTimeout(API_TIMEOUT_MS, async (signal) => {
    let res: Response;
    try {
      res = await fetchFn(path, { ...init, signal });
    } catch {
      throw new ServerError("network", 0);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    // A body cut off by the time limit is no answer, not a malformed one.
    if (signal.aborted) throw new ServerError("network", 0);
    return { res, body };
  });
  if (res.status !== okStatus) {
    const code = isObject(body) && typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : "http_" + res.status;
    throw new ServerError(code, res.status, requestIdOf(res));
  }
  if (!isObject(body)) throw new ServerError("malformed_response", res.status, requestIdOf(res));
  ids.set(body, requestIdOf(res));
  return body;
}

/** `POST /api/v1/challenges`: an empty request. The caller checks the challenge (spec/challenge.md). */
export async function requestChallenge(fetchFn: Fetch): Promise<unknown> {
  const body = await request(fetchFn, "/api/v1/challenges", { method: "POST" }, 200);
  return body.challenge;
}

/**
 * A row of the platform table the device can read (docs/api/card-proof.md,
 * `config`): the row type of protocol/, which the record rules take. The
 * display name is as the server sends it; the screen shows the ID beside it
 * before the card signs.
 */
export type { PlatformRow };

export interface Config {
  /** `paused`: the operator stopped taking card proofs (ADR-0033). Absent from an older server's answer: false. */
  paused: boolean;
  /** `crl_max_age_days`; the caller takes the smaller of it and the built-in 7 (crl/revocation.ts). */
  crlMaxAgeDays: number;
  /** The rows the device can read, in ascending order of platform. A platform of no row here is one the device does not know. */
  platforms: readonly PlatformRow[];
}

/** A display name: a string of 1 to 100 characters, none of them a control or line-breaking character. */
function isDisplayName(x: unknown): x is string {
  if (typeof x !== "string" || x.length < 1 || x.length > 100) return false;
  for (let i = 0; i < x.length; i++) {
    const c = x.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return false;
  }
  return true;
}

/**
 * `GET /api/v1/config`: the CRL age bound the server announces, and its copy
 * of the platform table. The table is a convenience for the device
 * (docs/api/card-proof.md): which scope string the card signs is never taken
 * from it (protocol/src/scope.ts).
 *
 *   - `paused` is true or false, or absent (false), or the answer is not read.
 *   - `crl_max_age_days` is a non-negative integer, or the answer is not read.
 *   - `platforms` is a list. Every element that names a platform ID (a
 *     string of 1 to 21 `a-z0-9-`) must do so in strictly ascending order,
 *     or the table is not read: two rows for one ID would be two answers.
 *   - A row is read if it is an object whose `platform` is a platform ID,
 *     `display_name` a string without control characters, and
 *     `username_format` a format in the one form `[…]{m,n}`
 *     (protocol/src/username-format.ts). Another row is a platform the
 *     device does not know. Fields the device does not know are ignored.
 *   - No row it can read: the table is not read (`malformed_response`); the
 *     device has nothing to offer and nothing to check an account against.
 */
export async function requestConfig(fetchFn: Fetch, o: { start?: boolean } = {}): Promise<Config> {
  // `?start`: the one request of a card proof's start, which the server counts against its site-wide limit (ADR-0026).
  const b = await request(fetchFn, o.start === true ? "/api/v1/config?start" : "/api/v1/config", { method: "GET" }, 200);
  const paused = b.paused ?? false;
  if (typeof paused !== "boolean") throw unreadable(b, 200);
  const n = b.crl_max_age_days;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw unreadable(b, 200);
  if (!Array.isArray(b.platforms)) throw unreadable(b, 200);
  const named: string[] = [];
  const rows: PlatformRow[] = [];
  for (const r of b.platforms as unknown[]) {
    if (!isObject(r) || !isPlatformId(r.platform)) continue;
    named.push(r.platform);
    const format = parseUsernameFormat(r.username_format);
    if (format === null || !isDisplayName(r.display_name)) continue;
    rows.push(Object.freeze({ platform: r.platform, displayName: r.display_name, format }));
  }
  for (let i = 1; i < named.length; i++) if (!(named[i - 1]! < named[i]!)) throw unreadable(b, 200);
  if (rows.length === 0) throw unreadable(b, 200);
  return { paused, crlMaxAgeDays: n, platforms: Object.freeze(rows) };
}

export interface CardStateResponse extends CardState {
  /**
   * The accounts of the card on platforms the device does not know (no row
   * of `config` it can read), as the server sent them, in ascending order of
   * platform. The device keeps them in the list as they are: a list without
   * one would withdraw it.
   */
  kept: Account[];
  count: number;
}

/**
 * `POST /api/v1/card-state`. The scoped ID goes in the body, never in the
 * URL. The answer is read strictly (docs/api/card-proof.md, "What the
 * device does with what it cannot read"); the device shows it and computes
 * what a list would do itself, but cannot check it (README, known limits).
 *
 *   - `last_card_proof` (a date or null), `proofs_on_last_date` (an
 *     integer), `platforms` (an object) and `count` must be read.
 *   - The entry of every platform of `table` that has one must be read:
 *     `current` and `last_declared` null or in the platform's format,
 *     `switch_count` an integer from 0 to 5, `correction_date` a date or
 *     null. A platform of the table without an entry is not offered (it is
 *     not in `slots`).
 *   - An entry of a platform the device does not know: with `current` null,
 *     ignored; with `current` set, kept as it is if the platform ID and the
 *     account pass the checks every platform satisfies
 *     (protocol/src/username-format.ts), otherwise the answer is not read.
 *     An entry that is not an object, or has no `current`, is not read.
 *   - A state the record rules cannot produce (possibleSlot, possibleCard,
 *     with `today`, the device's Taiwan date) is not read either.
 *
 * Fields the device does not know are ignored.
 */
export async function requestCardState(fetchFn: Fetch, scopeString: string, scopedId: string, table: readonly PlatformRow[], today: Day): Promise<CardStateResponse> {
  const b = await request(fetchFn, "/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: scopeString, scoped_id: scopedId }) }, 200);
  const bad = (): never => {
    throw unreadable(b, 200);
  };
  const day = (x: unknown): Day | null => {
    if (x === null) return null;
    const d = typeof x === "string" ? parseDay(x) : null;
    return d === null ? bad() : d;
  };
  if (!Number.isSafeInteger(b.count) || (b.count as number) < 0) bad();
  if (!("last_card_proof" in b)) bad();
  const lastCardProof = day(b.last_card_proof);
  // A count: an integer; possibleCard then bounds it.
  if (typeof b.proofs_on_last_date !== "number" || !Number.isSafeInteger(b.proofs_on_last_date)) bad();
  const proofsOnLastDate = b.proofs_on_last_date as number;
  if (!possibleCard({ lastCardProof, proofsOnLastDate }, today)) bad();
  if (!isObject(b.platforms)) bad();
  const entries = b.platforms as Record<string, unknown>;

  const known = new Set(table.map((r) => r.platform));
  const slots = new Map<string, SlotState>();
  for (const row of table) {
    if (!Object.prototype.hasOwnProperty.call(entries, row.platform)) continue;
    const e = entries[row.platform];
    if (!isObject(e)) bad();
    const entry = e as Record<string, unknown>;
    const user = (x: unknown): string | null => (x === null ? null : typeof x === "string" && row.format.accepts(x) ? x : bad());
    if (!("current" in entry) || !("last_declared" in entry) || !("correction_date" in entry)) bad();
    const switchCount = entry.switch_count;
    if (typeof switchCount !== "number" || !Number.isSafeInteger(switchCount) || switchCount < 0 || switchCount > MAX_SWITCHES) bad();
    const slot: SlotState = { current: user(entry.current), lastDeclared: user(entry.last_declared), switchCount: switchCount as number, correctionDate: day(entry.correction_date) };
    if (!possibleSlot(slot, lastCardProof)) bad();
    slots.set(row.platform, slot);
  }
  const kept: Account[] = [];
  for (const id of Object.keys(entries).sort()) {
    if (known.has(id)) continue;
    const e = entries[id];
    if (!isObject(e) || !("current" in e)) bad();
    const current = (e as Record<string, unknown>).current;
    if (current === null) continue;
    if (!isPlatformId(id) || !isAnyUsername(current)) bad();
    // An account means a valid record of the card.
    if (lastCardProof === null) bad();
    kept.push(Object.freeze({ platform: id, username: current as string }));
  }
  return { lastCardProof, proofsOnLastDate, slots, kept, count: b.count as number };
}

/** The fields of a record except `seq` (spec/record.md). */
export interface Submission {
  scope_string: string;
  scoped_id: string;
  /** The whole list, in ascending order of platform, each platform at most once. */
  accounts: Account[];
  challenge: string;
  issuer: "G2" | "G3";
  smt_root: string;
  circuit: string;
  proof: string;
}

/** One element of the answer's `kinds`: what the server says the record is on one platform. */
export interface AcceptedKind {
  platform: string;
  kind: Kind;
  /** The account: the list's for that platform, or for `withdraw` the one withdrawn. */
  username: string;
  /**
   * `account_cards`: the cards whose `current` on that platform is this
   * account once the record is applied. Only says whether other cards
   * declare it too; the device cannot check it, and a wrong number cannot
   * identify the cardholder. null if the element has none, or not a count:
   * the record is in the proof log already, so this field alone does not stop
   * the card proof.
   */
  accountCards: number | null;
}

/**
 * The answer to a submission with status 201: the record is in the proof log.
 * An answer whose body the device cannot read (no `seq` or `record_hash` in
 * their form) is still a 201: `seq`, `recordHash`, `ordinal` and `kinds` are then null,
 * and the screen says only that the record was made
 * (docs/api/card-proof.md: "says only that the list was recorded").
 */
export interface Accepted {
  seq: number | null;
  recordHash: string | null;
  /**
   * `ordinal`: the card's ordinal (spec/record-rules.md, "The ordinal"), only
   * for the text suggested for sharing. null if it is not a count of at
   * least 1: that text then has no number (spec/records-response.md).
   */
  ordinal: number | null;
  /**
   * `kinds`, in ascending order of platform; null if the device cannot read
   * it (not a non-empty list of readable elements in that order, or a kind it
   * does not know). The record is in the proof log by then: the device then says
   * only that the list was recorded (docs/api/card-proof.md).
   */
  kinds: AcceptedKind[] | null;
}

/** An answer of which nothing is told: a 201 all the same (Accepted). */
export const NOTHING_TOLD: Readonly<Accepted> = Object.freeze({ seq: null, recordHash: null, ordinal: null, kinds: null });

const KINDS: readonly string[] = ["first", "refresh", "correction", "switch", "withdraw"];

function readKinds(x: unknown): AcceptedKind[] | null {
  if (!Array.isArray(x) || x.length === 0) return null;
  const out: AcceptedKind[] = [];
  for (const e of x as unknown[]) {
    if (!isObject(e) || !isPlatformId(e.platform) || typeof e.kind !== "string" || !KINDS.includes(e.kind) || !isAnyUsername(e.username)) return null;
    if (out.length > 0 && !(out[out.length - 1]!.platform < e.platform)) return null;
    const n = e.account_cards;
    out.push({ platform: e.platform, kind: e.kind as Kind, username: e.username, accountCards: Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : null });
  }
  return out;
}

/** `POST /api/v1/records`. */
export async function submitRecord(fetchFn: Fetch, s: Submission): Promise<Accepted> {
  // Keys in the order of spec/record.md; an account's keys platform, then username.
  const body = JSON.stringify({
    scope_string: s.scope_string,
    scoped_id: s.scoped_id,
    accounts: s.accounts.map((a) => ({ platform: a.platform, username: a.username })),
    challenge: s.challenge,
    issuer: s.issuer,
    smt_root: s.smt_root,
    circuit: s.circuit,
    proof: s.proof,
  });
  let b: Record<string, unknown>;
  try {
    b = await request(fetchFn, "/api/v1/records", { method: "POST", body }, 201);
  } catch (e) {
    // A 201 is a record in the proof log, whatever its body: not a failure (Accepted).
    if (e instanceof ServerError && e.status === 201) return { ...NOTHING_TOLD };
    throw e;
  }
  const seq = Number.isSafeInteger(b.seq) && (b.seq as number) >= 1 ? (b.seq as number) : null;
  const recordHash = typeof b.record_hash === "string" && /^[0-9a-f]{64}$/.test(b.record_hash) ? b.record_hash : null;
  // An answer of which seq or record_hash cannot be read is one the device cannot read: nothing of it is told.
  if (seq === null || recordHash === null) return { ...NOTHING_TOLD };
  const ordinal = Number.isSafeInteger(b.ordinal) && (b.ordinal as number) >= 1 ? (b.ordinal as number) : null;
  // kinds and account_cards are only told to the cardholder (Accepted.kinds).
  return { seq, recordHash, ordinal, kinds: readKinds(b.kinds) };
}

/** A static file of the mirror, as bytes. */
export async function getBytes(fetchFn: Fetch, path: string): Promise<Uint8Array> {
  return withTimeout(FILE_TIMEOUT_MS, async (signal) => {
    let res: Response;
    try {
      res = await fetchFn(path, { method: "GET", signal });
    } catch {
      throw new ServerError("network", 0);
    }
    if (res.status !== 200) throw new ServerError("http_" + res.status, res.status);
    try {
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new ServerError("network", 0);
    }
  });
}
