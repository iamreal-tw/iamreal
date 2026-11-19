// The CRL mirror: asks MOICA for each issuer key's complete CRL and keeps
// every distinct file, as the original bytes, in the data bucket under
// `crl/<SHA-256>.crl` (ADR-0027). It does not check signatures, build trees
// or write the archive index yet.
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
 * Asks every source once. A source that fails stores nothing and does not
 * stop the others; a file the bucket already has is not written again.
 */
export async function mirrorCrls(sources: readonly CrlSource[], bucket: R2Bucket): Promise<MirrorResult[]> {
  const results: MirrorResult[] = [];
  for (const source of sources) {
    try {
      results.push({ issuer: source.issuer, ...(await mirrorOne(source, bucket)) });
    } catch (e) {
      results.push({ issuer: source.issuer, result: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

async function mirrorOne(source: CrlSource, bucket: R2Bucket): Promise<{ result: "stored" | "already_stored"; sha256: string }> {
  const response = await fetch(source.url, { headers: { "User-Agent": USER_AGENT } });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`HTTP status ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const sha256 = hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const key = `crl/${sha256}.crl`;
  // The name is the SHA-256 of the bytes, so a file of this name has these bytes.
  if (await bucket.head(key)) return { result: "already_stored", sha256 };
  await bucket.put(key, bytes, { httpMetadata: { cacheControl: CACHE_IMMUTABLE } });
  return { result: "stored", sha256 };
}
