// The requests to the server (docs/api/card-proof.md). Every path is on the
// page's own origin. Each response is read strictly, and what the device then
// does with each value is in the README's table. Nothing here reports a
// failure of the device's own checks to the server (ADR-0016): there is no
// request for that.
import type { Action } from "./spec/declaration-code.ts";
import { type Day, parseDay } from "./spec/date.ts";
import type { CardState } from "./spec/roster-rules.ts";

/** `fetch` restricted to the page's own origin. Tests pass a fake. */
export type Fetch = (path: string, init?: { method: "GET" | "POST"; body?: string }) => Promise<Response>;

/** The page's fetch: same origin, no credentials, no cache, no redirects. */
export function sameOriginFetch(path: string, init?: { method: "GET" | "POST"; body?: string }): Promise<Response> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("not a same-origin path");
  return fetch(path, {
    method: init?.method ?? "GET",
    body: init?.body,
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
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

/** The server's request ID (server/: 16 hex digits); anything else is not shown. */
function requestIdOf(res: Response): string | null {
  const id = res.headers.get("X-Request-Id");
  return id !== null && /^[0-9a-f]{1,64}$/.test(id) ? id : null;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

async function request(fetchFn: Fetch, path: string, init: { method: "GET" | "POST"; body?: string }, okStatus: number): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(path, init);
  } catch {
    throw new ServerError("network", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status !== okStatus) {
    const code = isObject(body) && typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : "http_" + res.status;
    throw new ServerError(code, res.status, requestIdOf(res));
  }
  if (!isObject(body)) throw new ServerError("malformed_response", res.status, requestIdOf(res));
  return body;
}

/** `POST /api/v1/challenges`: an empty request. The caller checks the challenge (spec/challenge.md). */
export async function requestChallenge(fetchFn: Fetch): Promise<unknown> {
  const body = await request(fetchFn, "/api/v1/challenges", { method: "POST" }, 200);
  return body.challenge;
}

export interface CardStateResponse extends CardState {
  count: number;
  head: string;
}

/**
 * `POST /api/v1/card-state`. The scoped ID goes in the body, never in the
 * URL. The answer is read strictly; the device shows it and computes the
 * consequence itself, but cannot check it (README, known limits).
 */
export async function requestCardState(
  fetchFn: Fetch,
  scopeString: string,
  scopedId: string,
  validUsername: (u: string) => boolean,
): Promise<CardStateResponse> {
  const b = await request(fetchFn, "/api/v1/card-state", { method: "POST", body: JSON.stringify({ scope_string: scopeString, scoped_id: scopedId }) }, 200);
  const user = (x: unknown): string | null => {
    if (x === null) return null;
    if (typeof x === "string" && validUsername(x)) return x;
    throw new ServerError("malformed_response", 200);
  };
  const day = (x: unknown): Day | null => {
    if (x === null) return null;
    const d = typeof x === "string" ? parseDay(x) : null;
    if (d === null) throw new ServerError("malformed_response", 200);
    return d;
  };
  if (!Array.isArray(b.switch_dates) || !Number.isSafeInteger(b.count) || (b.count as number) < 0) throw new ServerError("malformed_response", 200);
  if (typeof b.head !== "string" || !/^[0-9a-f]{64}$/.test(b.head)) throw new ServerError("malformed_response", 200);
  const switchDates = b.switch_dates.map((x) => {
    const d = day(x);
    if (d === null) throw new ServerError("malformed_response", 200);
    return d;
  });
  return {
    current: user(b.current),
    lastDeclared: user(b.last_declared),
    lastCardProof: day(b.last_card_proof),
    switchDates,
    count: b.count as number,
    head: b.head,
  };
}

/** The fields of a record except `seq` and `prev` (spec/record.md). */
export interface Submission {
  scope_string: string;
  scoped_id: string;
  action: Action;
  username: string;
  challenge: string;
  issuer: "G2" | "G3";
  smt_root: string;
  circuit: string;
  proof: string;
}

export interface Accepted {
  seq: number;
  recordHash: string;
  kind: "first" | "refresh" | "switch" | "withdraw";
}

/** `POST /api/v1/records`. */
export async function submitRecord(fetchFn: Fetch, s: Submission): Promise<Accepted> {
  // Keys in the order of spec/record.md.
  const body = JSON.stringify({
    scope_string: s.scope_string,
    scoped_id: s.scoped_id,
    action: s.action,
    username: s.username,
    challenge: s.challenge,
    issuer: s.issuer,
    smt_root: s.smt_root,
    circuit: s.circuit,
    proof: s.proof,
  });
  const b = await request(fetchFn, "/api/v1/records", { method: "POST", body }, 201);
  if (!Number.isSafeInteger(b.seq) || (b.seq as number) < 1) throw new ServerError("malformed_response", 201);
  if (typeof b.record_hash !== "string" || !/^[0-9a-f]{64}$/.test(b.record_hash)) throw new ServerError("malformed_response", 201);
  if (b.kind !== "first" && b.kind !== "refresh" && b.kind !== "switch" && b.kind !== "withdraw") throw new ServerError("malformed_response", 201);
  return { seq: b.seq as number, recordHash: b.record_hash, kind: b.kind };
}

/**
 * `GET /api/v1/config`: the CRL age bound the server announces. The caller
 * takes the smaller of it and the built-in 7 (crl/revocation.ts).
 */
export async function requestCrlMaxAge(fetchFn: Fetch): Promise<number> {
  const b = await request(fetchFn, "/api/v1/config", { method: "GET" }, 200);
  const n = b.crl_max_age_days;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new ServerError("malformed_response", 200);
  return n;
}

/** A static file of the mirror, as bytes. */
export async function getBytes(fetchFn: Fetch, path: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(path, { method: "GET" });
  } catch {
    throw new ServerError("network", 0);
  }
  if (res.status !== 200) throw new ServerError("http_" + res.status, res.status);
  return new Uint8Array(await res.arrayBuffer());
}
