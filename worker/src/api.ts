// The API under /api/ (docs/api/card-proof.md): challenges, card-state,
// records, config and counts.
//
// Every answer is JSON with `Cache-Control: no-store` and an `X-Request-Id`
// of its own (the answer to a count has no body); none sets a cookie or a
// CORS header. The back end keeps a
// connection log of one kind of request and no other (ADR-0022): a
// submission of a record that the proof log's object counted, written by
// connection-log.ts with the IP address it came from, kept 31 days. For any
// other request nothing is written. When the back end itself fails it
// writes one line, with the request ID, the endpoint and where it failed,
// to the live log, which is not kept. That line holds nothing that came in
// the request and nothing of the error's own text, which could quote it.
//
// Every endpoint reads the environment's settings first (settings.ts): with
// a `PROOF_LOG_KIND` that names no proof log, none of them answers anything but
// `500`.
import { ISSUERS, now } from "#target";
import { hexOf } from "iamreal-protocol/bytes.ts";
import { formatDay } from "iamreal-protocol/date.ts";
import { EMPTY_FINGERPRINT } from "iamreal-protocol/record.ts";
import { EMPTY_SLOT } from "iamreal-protocol/record-rules.ts";
import { lookupScope } from "iamreal-protocol/scope.ts";
import { parseScopedId } from "iamreal-protocol/scoped-id.ts";
import { readCountText } from "iamreal-protocol/counts.ts";
import { type CountedSubmission, entryOf, writeEntry } from "./connection-log.ts";
import { countsOf, countsPerMinuteOf } from "./counts.ts";
import { readStrings } from "./json.ts";
import { RETRY_AFTER_SECONDS, type RateClass, isOverloaded, withinLimit, withinStarts } from "./rate-limit.ts";
import { recordVerifies } from "./record-proof.ts";
import { type AcceptAnswer, CRL_MAX_AGE_DAYS, OTHER_SCHEMA, type RecordRefusal, type SubmissionRefusal, proofLogOf } from "./proof-log.ts";
import { proofLogSettingsOf } from "./settings.ts";
import { type SlotJson, slotToJson } from "./slot-json.ts";
import { readSubmission } from "./submission.ts";
import type { ProofVerifier } from "./verify.ts";

/** The largest request body read, in bytes: a longer one is `malformed`. */
export const MAX_BODY_BYTES = 64 * 1024;

/** The largest count read, in bytes: the longest the table allows is under a third of it. */
export const MAX_COUNT_BYTES = 2048;

/** What an endpoint answers: a status and a JSON body, or with `undefined` no body. */
interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly allow?: string;
  /** `Retry-After`, in seconds: with a `429`. */
  readonly retryAfter?: number;
}

/**
 * What an endpoint leaves for `api` beside its answer, also when it throws:
 * the submission the proof log's object counted, if the request was one.
 * Only that request gets an entry of the connection log.
 */
interface Notes {
  counted?: CountedSubmission;
  /**
   * Called by `postRecord` the moment the object counted the submission.
   * From then on the request is kept alive until its entry is written,
   * also if the client goes away before the answer.
   */
  count(submission: CountedSubmission): void;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const fail = (status: number, code: string): Reply => ({ status, body: { error: code } });
const MALFORMED = fail(400, "malformed");

/**
 * The status of each code the proof log's object refuses a challenge or a
 * record with (docs/api/card-proof.md). `503` when nothing is wrong with
 * the request and the back end cannot take it for now: `paused`, no card
 * proof at all; `crl_stale`, none of the record's issuer key, whose newest
 * CRL is too old, while the other issuer key's are taken as ever. `400`
 * otherwise.
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
};

const refuse = (code: SubmissionRefusal | RecordRefusal): Reply => fail(REFUSAL_STATUS[code], code);

/**
 * Where the back end failed, as the one line about it says (`where`):
 *
 *   settings   the settings are not right: `PROOF_LOG_KIND` names no proof log, or
 *              does not fit `PROOF_LOG_OBJECT_NAME` (settings.ts)
 *   schema     the tables of the proof log's object were made by another
 *              SCHEMA_VERSION than this build's (proof-log.ts)
 *   proof log     anything else in the proof log's object, a stored state that is
 *              broken among it
 *   verifier   the proof verifier could not run (verify.ts): no verdict on
 *              the proof, and nothing is written
 *   handler    anywhere else
 */
type Where = "settings" | "schema" | "proof_log" | "verifier" | "handler";

/** A failure of the back end itself. */
class Internal extends Error {
  readonly where: Where;
  constructor(where: Where, cause: unknown) {
    super(where, { cause });
    this.where = where;
  }
}

/** Reads the settings; a failure is `settings`. */
function settings(env: Env): ReturnType<typeof proofLogSettingsOf> {
  try {
    return proofLogSettingsOf(env);
  } catch (e) {
    throw new Internal("settings", e);
  }
}

/** Asks the proof log's object; a failure is `proof_log`, or `schema` when the object says its tables are of another version. */
async function askProofLog<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new Internal(e instanceof Error && e.message === OTHER_SCHEMA ? "schema" : "proof_log", e);
  }
}

/**
 * The request's body as text, or null if it is longer than `most` bytes or
 * not UTF-8. No more than the limit and one byte is kept.
 */
async function readBody(request: Request, most: number = MAX_BODY_BYTES): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const bytes = new Uint8Array(most + 1);
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > most) {
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

/** `POST /api/v1/challenges`: the proof log's object issues and stores it. The body is not read. */
async function postChallenge(_request: Request, env: Env): Promise<Reply> {
  // The operator stopped taking card proofs: no challenge, and the object is not asked.
  if (settings(env).cardProofsPaused) return refuse("paused");
  const issued = await askProofLog(() => proofLogOf(env).issueChallenge());
  return issued.challenge === null ? refuse("paused") : ok({ challenge: issued.challenge });
}

/**
 * `POST /api/v1/records`: one card proof, the card's whole list of accounts.
 * The checks run in the order of docs/api/card-proof.md, and the first that
 * fails gives the error. Between the Worker and the proof log's object:
 *
 *   1. here: the request is read and every field's format checked
 *      (`malformed`, `scope`, `platform`). A submission that ends here does
 *      not count, and the object is not asked;
 *   2. the object: the challenge (`challenge_unknown`, `challenge_used`,
 *      `challenge_attempts`); this submission is counted;
 *   3. here: the record verifies (`proof`), outside the object, so that a
 *      proof being verified does not hold up the proof log;
 *   4. the object: the challenge again, the back end's rule on `smt_root`
 *      (`crl_stale`, `root`), the record rules; then the record is written.
 *
 * A verifier that could not run gives no verdict: the answer is `500`, and
 * the object is not asked to write anything.
 *
 * From step 2 on, once the object counted the submission, it is one the
 * connection log keeps (`notes.counted`), however it ends: the challenge is
 * one the back end issued, and a challenge is counted five times at most,
 * so how many entries there are is not up to whoever sends requests.
 */
async function postRecord(request: Request, env: Env, parts: ApiParts, notes: Notes): Promise<Reply> {
  const { kind, cardProofsPaused } = settings(env);
  const text = await readBody(request);
  if (text === null) return MALFORMED;
  const submission = readSubmission(kind, text);
  if (typeof submission === "string") return fail(400, submission);
  // The device ID stays here: what goes on to the object and into the record is `fields` alone.
  const { fields, deviceId } = submission;
  // The operator stopped taking card proofs: before the object, as its own `paused` is, so the submission does not count.
  if (cardProofsPaused) return refuse("paused");

  const proofLog = proofLogOf(env);
  const begun = await askProofLog(() => proofLog.beginSubmission(fields.challenge));
  if (begun !== "ok") return refuse(begun);
  notes.count({ deviceId, body: text });

  let verifies: boolean;
  try {
    verifies = await recordVerifies(fields, ISSUERS, parts.verifier);
  } catch (e) {
    throw new Internal("verifier", e);
  }
  if (!verifies) return fail(400, "proof");

  // The type is named: left to itself it is inferred from the first member of the union alone.
  const answer = await askProofLog<AcceptAnswer>(() => proofLog.accept(fields));
  if (answer.outcome === "refused") return refuse(answer.code);
  const { seq, recordHash, ordinal, kinds } = answer.record;
  return {
    status: 201,
    body: { seq, record_hash: recordHash, ordinal, kinds: kinds.map((k) => ({ platform: k.platform, kind: k.kind, username: k.username, account_cards: k.accountCards })) },
  };
}

/**
 * `POST /api/v1/card-state`: the state of one card on every platform of the
 * proof log's table, as the rules left it. Facts, not conclusions. The keys are
 * in the order of docs/api/card-proof.md.
 */
async function postCardState(request: Request, env: Env): Promise<Reply> {
  const { kind, platforms: table } = settings(env);
  const text = await readBody(request);
  if (text === null) return MALFORMED;
  const fields = readStrings(text, ["scope_string", "scoped_id"]);
  if (fields === null) return MALFORMED;
  // A scope this proof log does not accept is not in the format of scope_string.
  if (!lookupScope(kind, fields.scope_string)) return MALFORMED;
  if (parseScopedId(fields.scoped_id) === null) return MALFORMED;

  const { card, count } = await askProofLog(() => proofLogOf(env).cardState(fields.scope_string, fields.scoped_id));
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
 * `GET /api/v1/config`: whether the operator stopped taking card proofs,
 * the CRL age bound, the platform table of this proof log, in ascending
 * order of platform ID, and the minimum app version (src/min-app.ts). The Worker answers by itself, without asking the
 * proof log's object.
 */
async function getConfig(_request: Request, env: Env): Promise<Reply> {
  const { platforms, minApp, cardProofsPaused } = settings(env);
  return ok({
    paused: cardProofsPaused,
    crl_max_age_days: CRL_MAX_AGE_DAYS,
    platforms: platforms.map((p) => ({ platform: p.platform, display_name: p.displayName, username_format: p.format.text })),
    min_app: { android: { build: minApp.android.build, from: minApp.android.from }, ios: { build: minApp.ios.build, from: minApp.ios.from } },
  });
}

/**
 * `GET /api/v1/fingerprint`: the last line the proof log's object wrote to
 * the fingerprint file, its date, count and proof log fingerprint (ADR-0021); for a proof log never published, no date, no record and the
 * proof log fingerprint of the empty proof log.
 */
async function getFingerprint(_request: Request, env: Env): Promise<Reply> {
  settings(env);
  const line = await askProofLog(() => proofLogOf(env).lastPublished());
  return ok(line === null ? { date: null, count: 0, fingerprint: EMPTY_FINGERPRINT } : { date: formatDay(line.date), count: line.count, fingerprint: line.fingerprint });
}

/**
 * `GET /api/v1/rebuild`: what the proof log's object knows of the last rebuild
 * from the proof log it began (src/rebuild.ts): its name, whether it is
 * running, was put in place or was refused, how many records it has applied,
 * and why it was refused. Every field null, and no record, for an object that
 * never began one. It is how the operator follows a rebuild: the Worker has no
 * entry of the operator's own.
 */
async function getRebuild(_request: Request, env: Env): Promise<Reply> {
  settings(env);
  const rebuild = await askProofLog(() => proofLogOf(env).rebuildStatus());
  return ok(rebuild === null ? { name: null, status: null, records: 0, reason: null } : { name: rebuild.token, status: rebuild.status, records: rebuild.records, reason: rebuild.reason });
}

/**
 * `POST /api/v1/counts`: one count (spec/counts.md; ADR-0032, ADR-0039). A
 * count the table takes goes to the counts' object (counts.ts), as the
 * reader rebuilt it from the table and with nothing of the request; any
 * other is dropped whole. The answer is the same either way, and has no
 * body: a client does not look at it. The proof log's object is not asked,
 * and nothing is written to the connection log. If the counts' object
 * cannot be asked, the count is lost and the live log gets one line with
 * nothing of the count: a count never fails anything.
 */
async function postCount(request: Request, env: Env): Promise<Reply> {
  settings(env);
  const perMinute = countsPerMinuteOf(env);
  const text = await readBody(request, MAX_COUNT_BYTES);
  const count = text === null ? null : readCountText(text);
  if (count !== null) {
    try {
      await countsOf(env).add(count, perMinute);
    } catch (e) {
      console.error(JSON.stringify({ event: "count_not_kept", error: e instanceof Error ? e.name : "unknown" }));
    }
  }
  return { status: 204, body: undefined };
}

/** What the API is given besides the environment: the pieces that are behind an interface, so that each can be replaced by itself. */
export interface ApiParts {
  /** Verifies the proof of a submitted record (verify.ts). */
  readonly verifier: ProofVerifier;
}

interface Endpoint {
  readonly method: string;
  /**
   * The class its requests are counted in, by where they come from
   * (rate-limit.ts; ADR-0026). The three of a card proof each have their
   * own. `config`, `fingerprint` and `rebuild` are public reads, counted
   * together: anyone may ask them at any time, and two of them ask the
   * proof log's object every time. Counts are a class of their own
   * (ADR-0032): a page sends several for one card proof.
   */
  readonly rate: RateClass;
  readonly handle: (request: Request, env: Env, parts: ApiParts, notes: Notes) => Promise<Reply>;
}

const ENDPOINTS: ReadonlyMap<string, Endpoint> = new Map([
  ["/api/v1/challenges", { method: "POST", rate: "challenges", handle: postChallenge }],
  ["/api/v1/card-state", { method: "POST", rate: "card_state", handle: postCardState }],
  ["/api/v1/records", { method: "POST", rate: "records", handle: postRecord }],
  ["/api/v1/config", { method: "GET", rate: "public_reads", handle: getConfig }],
  ["/api/v1/fingerprint", { method: "GET", rate: "public_reads", handle: getFingerprint }],
  ["/api/v1/rebuild", { method: "GET", rate: "public_reads", handle: getRebuild }],
  ["/api/v1/counts", { method: "POST", rate: "counts", handle: postCount }],
]);

/** Whether the API answers for this path: everything under /api/. */
export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

/** A new request ID: 8 random bytes. It identifies nothing but this one answer. */
function requestId(): string {
  return hexOf(crypto.getRandomValues(new Uint8Array(8)));
}

/**
 * Answers a request under /api/. `later` takes work the answer does not
 * wait for (the request's `waitUntil`): the entry of the connection log.
 */
export async function api(request: Request, env: Env, parts: ApiParts, later: (work: Promise<unknown>) => void): Promise<Response> {
  const id = requestId();
  // The entry's write is promised to the runtime when the submission is counted, not when the answer is ready:
  // a request whose client left in between is still worked to its end, and its entry written.
  let written: () => void = () => {};
  const notes: Notes = {
    count(submission) {
      this.counted = submission;
      later(new Promise<void>((resolve) => (written = resolve)));
    },
  };
  const { pathname } = new URL(request.url);
  const endpoint = ENDPOINTS.get(pathname);
  let reply: Reply;
  if (endpoint === undefined) reply = fail(404, "not_found");
  else if (request.method !== endpoint.method) reply = { ...fail(405, "method_not_allowed"), allow: endpoint.method };
  // Before anything of the request is read and before the proof log's object is asked: a request over its
  // class's limit costs nothing more, counts towards no challenge, and leaves nothing in the connection log.
  else if (!(await withinLimit(env, endpoint.rate, request))) reply = { ...fail(429, "rate_limited"), retryAfter: RETRY_AFTER_SECONDS };
  // The site-wide limit counts the one `config` a client asks for when a card proof starts, and no other request
  // (rate-limit.ts, withinStarts; ADR-0026). Over it, the cardholder is told before a card is read.
  else if (pathname === "/api/v1/config" && new URL(request.url).searchParams.has("start") && !(await withinStarts(env))) reply = { ...fail(503, "busy"), retryAfter: RETRY_AFTER_SECONDS };
  else {
    try {
      reply = await endpoint.handle(request, env, parts, notes);
    } catch (e) {
      // The path is one of the endpoints' own, not what the client wrote; the
      // error is named by its class and the step, never by its message.
      const cause = e instanceof Internal ? e.cause : e;
      if (isOverloaded(cause)) {
        // The proof log's object is overloaded: not to be asked again at once (ADR-0026).
        console.error(JSON.stringify({ event: "proof_log_overloaded", id, endpoint: pathname }));
        reply = { ...fail(503, "busy"), retryAfter: RETRY_AFTER_SECONDS };
      } else {
        console.error(JSON.stringify({ event: "internal_error", id, endpoint: pathname, where: e instanceof Internal ? e.where : "handler", error: cause instanceof Error ? cause.name : "unknown" }));
        reply = fail(500, "internal");
      }
    }
  }
  if (notes.counted !== undefined) {
    const seq = reply.status === 201 ? (reply.body as { seq: number }).seq : undefined;
    const end = seq !== undefined ? { status: reply.status, seq } : { status: reply.status, error: (reply.body as { error: string }).error };
    // Not awaited: the answer is the same whether the entry is written or not (connection-log.ts).
    void writeEntry(env.CONNECTION_LOG, entryOf(request, id, now(), notes.counted, end)).then(written);
  }
  const headers = new Headers({
    ...(reply.body !== undefined && { "Content-Type": "application/json" }),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": id,
  });
  if (reply.allow !== undefined) headers.set("Allow", reply.allow);
  if (reply.retryAfter !== undefined) headers.set("Retry-After", String(reply.retryAfter));
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers });
}
