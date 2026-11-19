// The CRL mirror: asks MOICA for each issuer key's complete CRL and keeps
// every distinct file, as the original bytes, in the data bucket under
// `crl/<SHA-256>.crl` (ADR-0027). It does not check signatures, build trees
// or write the archive index yet.
//
// What it stores is whatever a complete answer with status 200 held, CRL or
// not: usable or not, every file is kept, and telling them apart is for the
// code that will write the index. What it can tell at the level of HTTP is
// that an answer is not complete, and then it stores nothing:
//
// - any status but 200, no answer, or an answer that takes longer than the
//   limit;
// - an answer the runtime reports as broken off;
// - fewer or more bytes than the answer's Content-Length;
// - no bytes at all.
//
// It cannot tell everything. Seen in the local workerd 1.20261110.1
// (test/worker.test.ts):
//
// - A connection that closes before Content-Length bytes have arrived gives
//   neither an error nor a short body: the read never ends. So this case
//   ends by the limit, and the comparison with Content-Length below is a
//   second guard that no test reaches.
// - A chunked answer (no Content-Length) whose connection closes before the
//   last chunk gives no error either: the bytes that arrived look like a
//   complete answer, and they are stored. Only the signature check, when
//   the mirror has one, refuses such a file.
import { hexOf } from "iamreal-protocol/bytes.ts";
import type { IssuerName } from "./issuers.ts";

/** Where MOICA publishes the complete CRL of one issuer key. */
export interface CrlSource {
  /** For the log only: whose key signed a CRL is read from its signature, not from here. */
  readonly issuer: IssuerName;
  readonly url: string;
}

/** What one round did with one source. */
export type MirrorResult =
  | { readonly issuer: IssuerName; readonly result: "stored" | "already_stored"; readonly sha256: string }
  | { readonly issuer: IssuerName; readonly result: "failed"; readonly error: string };

/**
 * The request names no project and no person: the User-Agent is a general
 * one (CONTRIBUTING.md, "工作時對外的請求").
 */
const USER_AGENT = "Mozilla/5.0 (compatible)";

/**
 * A CRL file's name never gets other bytes, so it may be cached for a year.
 * Every object in the data bucket says how long it may be cached: one
 * without Cache-Control is not cached at all.
 */
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Asks every source once, all at the same time, each for at most
 * `timeoutMs`. A source that fails stores nothing, and neither a failing
 * nor a slow source keeps another from being stored; a file the bucket
 * already has is not written again.
 */
export async function mirrorCrls(sources: readonly CrlSource[], bucket: R2Bucket, timeoutMs: number): Promise<MirrorResult[]> {
  return Promise.all(
    sources.map(async (source): Promise<MirrorResult> => {
      const abort = new AbortController();
      // The race ends the wait even if aborting does not end the request.
      let tooLate = (): void => {};
      const late = new Promise<never>((_, reject) => {
        tooLate = () => reject(new Error(`no complete answer in ${timeoutMs} ms`));
      });
      const timer = setTimeout(() => {
        tooLate();
        abort.abort();
      }, timeoutMs);
      try {
        return { issuer: source.issuer, ...(await Promise.race([mirrorOne(source, bucket, abort.signal), late])) };
      } catch (e) {
        return { issuer: source.issuer, result: "failed", error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

async function mirrorOne(source: CrlSource, bucket: R2Bucket, signal: AbortSignal): Promise<{ result: "stored" | "already_stored"; sha256: string }> {
  const response = await fetch(source.url, { headers: { "User-Agent": USER_AGENT }, signal });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`HTTP status ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error("an empty answer");
  // Content-Length counts the bytes as sent. If they were compressed on the
  // way (Content-Encoding), what arrives here is not that many, and the
  // header says nothing about it.
  const declared = response.headers.get("Content-Length");
  if (declared !== null && response.headers.get("Content-Encoding") === null && declared !== String(bytes.byteLength)) {
    throw new Error(`${bytes.byteLength} bytes, Content-Length ${declared}`);
  }
  const sha256 = hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const key = `crl/${sha256}.crl`;
  // The name is the SHA-256 of the bytes, so a file of this name has these bytes.
  if (await bucket.head(key)) return { result: "already_stored", sha256 };
  signal.throwIfAborted(); // nothing is written once the limit has passed
  await bucket.put(key, bytes, { httpMetadata: { cacheControl: CACHE_IMMUTABLE } });
  return { result: "stored", sha256 };
}
