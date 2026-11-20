// The API under /api/ (docs/api/card-proof.md): challenges, card-state,
// records and config.
//
// Every answer is JSON with `Cache-Control: no-store` and an `X-Request-Id`
// of its own; none sets a cookie or a CORS header. This back end keeps no
// request log: nothing is written for a request it answers. Only when the
// back end itself fails does it write one line, with the request ID, the
// endpoint and where it failed, to the live log, which is not kept. That
// line holds nothing that came in the request and nothing of the error's
// own text, which could quote it.
//
// Every endpoint reads the environment's settings first (settings.ts): with
// a `ROSTER_KIND` that names no roster, none of them answers anything but
// `500`.
import { ISSUERS } from "#target";
import { hexOf } from "iamreal-protocol/bytes.ts";
import { formatDay } from "iamreal-protocol/date.ts";
import { EMPTY_FINGERPRINT } from "iamreal-protocol/record.ts";
import { EMPTY_SLOT } from "iamreal-protocol/roster-rules.ts";
import { lookupScope } from "iamreal-protocol/scope.ts";
import { parseScopedId } from "iamreal-protocol/scoped-id.ts";
import { readStrings } from "./json.ts";
import { recordVerifies } from "./record-proof.ts";
import { type AcceptAnswer, CRL_MAX_AGE_DAYS, OTHER_SCHEMA, type RecordRefusal, type SubmissionRefusal, rosterOf } from "./roster.ts";
import { rosterSettingsOf } from "./settings.ts";
import { type SlotJson, slotToJson } from "./slot-json.ts";
import { readSubmission } from "./submission.ts";
import type { ProofVerifier } from "./verify.ts";

/** The largest request body read, in bytes: a longer one is `malformed`. */
export const MAX_BODY_BYTES = 64 * 1024;

/** What an endpoint answers: a status and a JSON body. */
interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly allow?: string;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, code: string): Reply => ({ status, body: { error: code } });
const MALFORMED = fail(400, "malformed");

/**
 * The status of each code the roster's object refuses a challenge or a
 * record with (docs/api/card-proof.md). `503` when nothing is wrong with
 * the request and the back end cannot take it for now: `paused`, no card
 * proof at all; `crl_stale`, none of the record's issuer key, whose newest
 * CRL is too old, while the other issuer key's are taken as ever. `403`
 * for the back end's own policy, `400` otherwise.
 */
const REFUSAL_STATUS: Readonly<Record<SubmissionRefusal | RecordRefusal, number>> = {
  paused: 503,
  challenge_unknown: 400,
  challenge_used: 400,
  challenge_attempts: 400,
  crl_stale: 503,
  root: 400,
  date_order: 400,
  empty: 400,
  switch_limit: 400,
  daily_limit: 400,
  switch_restricted: 403,
};

const refuse = (code: SubmissionRefusal | RecordRefusal): Reply => fail(REFUSAL_STATUS[code], code);

/**
 * Where the back end failed, as the one line about it says (`where`):
 *
 *   settings   the settings are not right: `ROSTER_KIND` names no roster, or
 *              does not fit `ROSTER_OBJECT_NAME` (settings.ts)
 *   schema     the tables of the roster's object were made by another
 *              SCHEMA_VERSION than this build's (roster.ts)
 *   roster     anything else in the roster's object, a stored state that is
 *              broken among it
 *   verifier   the proof verifier could not run (verify.ts): no verdict on
 *              the proof, and nothing is written
 *   handler    anywhere else
 */
type Where = "settings" | "schema" | "roster" | "verifier" | "handler";

/** A failure of the back end itself. */
class Internal extends Error {
  readonly where: Where;
  constructor(where: Where, cause: unknown) {
    super(where, { cause });
    this.where = where;
  }
}

/** Reads the settings; a failure is `settings`. */
function settings(env: Env): ReturnType<typeof rosterSettingsOf> {
  try {
    return rosterSettingsOf(env);
  } catch (e) {
    throw new Internal("settings", e);
  }
}

/** Asks the roster's object; a failure is `roster`, or `schema` when the object says its tables are of another version. */
async function askRoster<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Internal(e instanceof Error && e.message === OTHER_SCHEMA ? "schema" : "roster", e);
  }
}

/**
 * The request's body as text, or null if it is longer than MAX_BODY_BYTES or
 * not UTF-8. No more than the limit and one byte is kept.
 */
async function readBody(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BODY_BYTES + 1);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    bytes.set(value, length);
    length += value.length;
  }
  try {
    // A byte order mark is not dropped, so a body that starts with one is not JSON.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } catch {
    return null;
  }
}

/** `POST /api/v1/challenges`: the roster's object issues and stores it. The body is not read. */
async function postChallenge(_request: Request, env: Env): Promise<Reply> {
  settings(env);
  const issued = await askRoster(() => rosterOf(env).issueChallenge());
  return issued.challenge === null ? refuse("paused") : ok({ challenge: issued.challenge });
}

/**
 * `POST /api/v1/records`: one card proof, the card's whole list of accounts.
 * The checks run in the order of docs/api/card-proof.md, and the first that
 * fails gives the error. Between the Worker and the roster's object:
 *
 *   1. here: the request is read and every field's format checked
 *      (`malformed`, `scope`, `platform`). A submission that ends here does
 *      not count, and the object is not asked;
 *   2. the object: the challenge (`challenge_unknown`, `challenge_used`,
 *      `challenge_attempts`); this submission is counted;
 *   3. here: the record verifies (`proof`), outside the object, so that a
 *      proof being verified does not hold up the roster;
 *   4. the object: the challenge again, the back end's rule on `smt_root`
 *      (`crl_stale`, `root`), the roster rules, the back end's policy on
 *      switches (`switch_restricted`); then the record is written.
 *
 * A verifier that could not run gives no verdict: the answer is `500`, and
 * the object is not asked to write anything.
 */
async function postRecord(request: Request, env: Env, parts: ApiParts): Promise<Reply> {
  const { kind } = settings(env);
  const text = await readBody(request);
  if (text === null) return MALFORMED;
  const fields = readSubmission(kind, text);
  if (typeof fields === "string") return fail(400, fields);

  const roster = rosterOf(env);
  const begun = await askRoster(() => roster.beginSubmission(fields.challenge));
  if (begun !== "ok") return refuse(begun);

  let verifies: boolean;
  try {
    verifies = await recordVerifies(fields, ISSUERS, parts.verifier);
  } catch (e) {
    throw new Internal("verifier", e);
  }
  if (!verifies) return fail(400, "proof");

  // The type is named: left to itself it is inferred from the first member of the union alone.
  const answer = await askRoster<AcceptAnswer>(() => roster.accept(fields));
  if (answer.outcome === "refused") return refuse(answer.code);
  const { seq, recordHash, kinds } = answer.record;
  return {
    status: 201,
    body: { seq, record_hash: recordHash, kinds: kinds.map((k) => ({ platform: k.platform, kind: k.kind, username: k.username, account_cards: k.accountCards })) },
  };
}

/**
 * `POST /api/v1/card-state`: the state of one card on every platform of the
 * roster's table, as the rules left it. Facts, not conclusions. The keys are
 * in the order of docs/api/card-proof.md.
 */
async function postCardState(request: Request, env: Env): Promise<Reply> {
  const { kind, platforms: table } = settings(env);
  const text = await readBody(request);
  if (text === null) return MALFORMED;
  const fields = readStrings(text, ["scope_string", "scoped_id"]);
  if (fields === null) return MALFORMED;
  // A scope this roster does not accept is not in the format of scope_string.
  if (!lookupScope(kind, fields.scope_string)) return MALFORMED;
  if (parseScopedId(fields.scoped_id) === null) return MALFORMED;

  const { card, count } = await askRoster(() => rosterOf(env).cardState(fields.scope_string, fields.scoped_id));
  const platforms: Record<string, SlotJson> = {};
  // A platform the stored state has no slot for is a slot never used.
  for (const { platform } of table) platforms[platform] = slotToJson(card?.slots.get(platform) ?? EMPTY_SLOT);
  return ok({
    last_card_proof: card === null || card.lastCardProof === null ? null : formatDay(card.lastCardProof),
    proofs_on_last_date: card?.proofsOnLastDate ?? 0,
    platforms,
    count,
  });
}

/**
 * `GET /api/v1/config`: the CRL age bound and the platform table of this
 * roster, in ascending order of platform ID. The Worker answers by itself,
 * without asking the roster's object.
 */
async function getConfig(_request: Request, env: Env): Promise<Reply> {
  const { platforms } = settings(env);
  return ok({
    crl_max_age_days: CRL_MAX_AGE_DAYS,
    platforms: platforms.map((p) => ({ platform: p.platform, display_name: p.displayName, username_format: p.format.text })),
  });
}

/**
 * `GET /api/v1/fingerprint`: the last line of the fingerprint file the
 * roster's object published, its date, count and roster fingerprint
 * (ADR-0021); for a roster never published, no date, no record and the
 * roster fingerprint of the empty roster.
 */
async function getFingerprint(_request: Request, env: Env): Promise<Reply> {
  settings(env);
  const line = await askRoster(() => rosterOf(env).lastPublished());
  return ok(line === null ? { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT } : { date: line.date, count: line.count, fingerprint: line.fingerprint });
}

/** What the API is given besides the environment: the pieces that are behind an interface, so that each can be replaced by itself. */
export interface ApiParts {
  /** Verifies the proof of a submitted record (verify.ts). */
  readonly verifier: ProofVerifier;
}

interface Endpoint {
  readonly method: string;
  readonly handle: (request: Request, env: Env, parts: ApiParts) => Promise<Reply>;
}

const ENDPOINTS: ReadonlyMap<string, Endpoint> = new Map([
  ["/api/v1/challenges", { method: "POST", handle: postChallenge }],
  ["/api/v1/card-state", { method: "POST", handle: postCardState }],
  ["/api/v1/records", { method: "POST", handle: postRecord }],
  ["/api/v1/config", { method: "GET", handle: getConfig }],
  ["/api/v1/fingerprint", { method: "GET", handle: getFingerprint }],
]);

/** Whether the API answers for this path: everything under /api/. */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

/** A new request ID: 8 random bytes. It identifies nothing but this one answer. */
function requestId(): string {
  return hexOf(crypto.getRandomValues(new Uint8Array(8)));
}

/** Answers a request under /api/. */
export async function api(request: Request, env: Env, parts: ApiParts): Promise<Response> {
  const id = requestId();
  const { pathname } = new URL(request.url);
  const endpoint = ENDPOINTS.get(pathname);
  let reply: Reply;
  if (endpoint === undefined) reply = fail(404, "not_found");
  else if (request.method !== endpoint.method) reply = { ...fail(405, "method_not_allowed"), allow: endpoint.method };
  else {
    try {
      reply = await endpoint.handle(request, env, parts);
    } catch (e) {
      // The path is one of the endpoints' own, not what the client wrote; the
      // error is named by its class and the step, never by its message.
      const cause = e instanceof Internal ? e.cause : e;
      console.error(JSON.stringify({ event: "internal_error", id, endpoint: pathname, where: e instanceof Internal ? e.where : "handler", error: cause instanceof Error ? cause.name : "unknown" }));
      reply = fail(500, "internal");
    }
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": id,
  });
  if (reply.allow !== undefined) headers.set("Allow", reply.allow);
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers });
}
