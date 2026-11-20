// The API under /api/ (docs/api/card-proof.md). So far: challenges,
// card-state and config.
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
import { hexOf } from "iamreal-protocol/bytes.ts";
import { formatDay } from "iamreal-protocol/date.ts";
import { EMPTY_SLOT } from "iamreal-protocol/roster-rules.ts";
import { lookupScope } from "iamreal-protocol/scope.ts";
import { parseScopedId } from "iamreal-protocol/scoped-id.ts";
import { readStrings } from "./json.ts";
import { OTHER_ROSTER, rosterOf } from "./roster.ts";
import { rosterSettingsOf } from "./settings.ts";
import { type SlotJson, slotToJson } from "./slot-json.ts";

/** The largest request body read, in bytes: a longer one is `malformed`. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * No card proof is accepted when the newest CRL of the issuer is more than
 * this many days old (spec/revocation-tree.md, "Who checks what"); `config`
 * announces it to devices.
 */
export const CRL_MAX_AGE_DAYS = 3;

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
 * Where the back end failed, as the one line about it says (`where`):
 *
 *   settings      `ROSTER_KIND` names no roster
 *   roster_kind   the roster's object holds another roster than `ROSTER_KIND` names
 *   roster        anything else in the roster's object, a stored state that is broken among it
 *   handler       anywhere else
 */
type Where = "settings" | "roster_kind" | "roster" | "handler";

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

/** Asks the roster's object; a failure is `roster`, or `roster_kind` when the object says it holds another roster. */
async function askRoster<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Internal(e instanceof Error && e.message === OTHER_ROSTER ? "roster_kind" : "roster", e);
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
  const challenge = await askRoster(() => rosterOf(env).issueChallenge());
  return ok({ challenge });
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

interface Endpoint {
  readonly method: string;
  readonly handle: (request: Request, env: Env) => Promise<Reply>;
}

const ENDPOINTS: ReadonlyMap<string, Endpoint> = new Map([
  ["/api/v1/challenges", { method: "POST", handle: postChallenge }],
  ["/api/v1/card-state", { method: "POST", handle: postCardState }],
  ["/api/v1/config", { method: "GET", handle: getConfig }],
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
export async function api(request: Request, env: Env): Promise<Response> {
  const id = requestId();
  const { pathname } = new URL(request.url);
  const endpoint = ENDPOINTS.get(pathname);
  let reply: Reply;
  if (endpoint === undefined) reply = fail(404, "not_found");
  else if (request.method !== endpoint.method) reply = { ...fail(405, "method_not_allowed"), allow: endpoint.method };
  else {
    try {
      reply = await endpoint.handle(request, env);
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
