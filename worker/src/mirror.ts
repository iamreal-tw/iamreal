// The CRL mirror (spec/revocation-tree.md, "Who checks what"). One round:
//
// 1. Asks MOICA for each issuer key's complete CRL and keeps every distinct
//    file, as the original bytes, in the data bucket under
//    `crl/<SHA-256>.crl` (ADR-0027).
// 2. Gives every file of the archive that the index does not list its line:
//    reads it, checks the signature and, if it is a usable CRL, builds its
//    tree (src/crl.ts, src/crl-tree.ts). Usable or not, every file gets a
//    line. `crl/index.jsonl` is written again after each file.
// 3. Says which are the two newest usable CRLs of each issuer key, for the
//    roster's object.
//
// The second step works from what the bucket holds, not from what the first
// step just fetched. So a file whose SHA-256 the index already lists is not
// read again and no tree is built for it; and a file that was stored in a
// round that ended before its line was written gets its line in the next
// round. The index is one object, replaced whole: nobody reads half of one.
//
// The rest of the Worker knows the mirror as `CrlMirror`. This one does the
// work in the Worker; if it outgrows a Worker's limits, another takes its
// place (ADR-0023).
//
// What the first step stores is whatever a complete answer with status 200
// held, CRL or not. What it can tell at the level of HTTP is that an answer
// is not complete, and then it stores nothing:
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
//   complete answer, and they are stored. Such a file is not a CRL MOICA
//   signed, and its line in the index says that it is not usable.
import { hexOf } from "iamreal-protocol/bytes.ts";
import { readCrl } from "./crl.ts";
import { type IndexLine, type NewestCrls, formatIndex, newestCrls, readIndex } from "./crl-index.ts";
import { treeRoot } from "./crl-tree.ts";
import type { IssuerKey, IssuerName } from "./issuers.ts";
import type { Poseidon2Hash } from "./poseidon2.ts";

/** Where MOICA publishes the complete CRL of one issuer key. */
export interface CrlSource {
  /** For the log only: whose key signed a CRL is read from its signature, not from here. */
  readonly issuer: IssuerName;
  readonly url: string;
}

/** What one round did with one source. */
export type SourceResult =
  | { readonly issuer: IssuerName; readonly result: "stored" | "already_stored"; readonly sha256: string }
  | { readonly issuer: IssuerName; readonly result: "failed"; readonly error: string };

/** What one round did with one file of the archive that the index did not list. */
export type FileResult =
  | {
      readonly result: "indexed";
      readonly line: IndexLine;
      /** Elements of `revokedCertificates`, keys of the tree, and Poseidon2 hashes the tree took. */
      readonly entries: number;
      readonly keys: number;
      readonly hashes: number;
      /** Milliseconds: getting the file and reading it, signature included; then building the tree. */
      readonly readMs: number;
      readonly treeMs: number;
    }
  | { readonly result: "failed"; readonly sha256: string; readonly error: string };

/** What one round of the mirror did. */
export interface MirrorRound {
  readonly sources: readonly SourceResult[];
  readonly files: readonly FileResult[];
  /**
   * The two newest usable CRLs of each issuer key in the index as it now is
   * in the bucket. `undefined` if the archive could not be read, a file got
   * no line or the index could not be written; `error` then says which.
   */
  readonly newest: NewestCrls | undefined;
  readonly error?: string;
}

/**
 * The CRL mirror, as the rest of the Worker knows it. A round does not
 * throw: what went wrong is in what it returns.
 */
export interface CrlMirror {
  round(): Promise<MirrorRound>;
}

/** What the mirror that works in the Worker is made of. */
export interface InWorkerMirror {
  readonly sources: readonly CrlSource[];
  /** The data bucket: the archive is its `crl/`. */
  readonly bucket: R2Bucket;
  /** How long to wait for one source, in milliseconds. */
  readonly timeoutMs: number;
  /** The issuer keys a CRL's signature is checked against, in order. */
  readonly issuers: readonly IssuerKey[];
  /** The hash the trees are built with. */
  readonly hash: Poseidon2Hash;
}

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

/** The index changes whenever MOICA signs a CRL: it may be cached for a minute. */
const CACHE_MINUTE = "public, max-age=60";

const INDEX_KEY = "crl/index.jsonl";
const FILE_KEY = /^crl\/([0-9a-f]{64})\.crl$/;

/**
 * For how long a round goes on starting files that an earlier round left
 * without a line: 5 minutes. The files fetched in this round always get
 * theirs. A round may use 15 minutes of CPU time
 * (https://developers.cloudflare.com/workers/platform/limits/), and the
 * tree of MOICA's G2 CRL takes about half a minute; so an archive that lost
 * its whole index gets it back over several rounds, each of which ends in
 * time, and every line a round wrote stays.
 */
const CATCH_UP_MS = 5 * 60 * 1000;

/** Lets whatever else waits in this isolate run. */
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The mirror that does all its work in the Worker. */
export function crlMirrorInWorker(o: InWorkerMirror): CrlMirror {
  return {
    async round() {
      const sources = await fetchAll(o.sources, o.bucket, o.timeoutMs);
      const files: FileResult[] = [];
      try {
        return { sources, files, newest: await indexArchive(o, sources, files) };
      } catch (e) {
        return { sources, files, newest: undefined, error: messageOf(e) };
      }
    },
  };
}

/**
 * The second and third steps of a round. Adds to `files` as it goes. Throws
 * if the archive cannot be read, a file got no line or the index cannot be
 * written.
 */
async function indexArchive(o: InWorkerMirror, sources: readonly SourceResult[], files: FileResult[]): Promise<NewestCrls> {
  const started = Date.now();
  const stored = new Set<string>();
  for (let cursor: string | undefined; ; ) {
    const page = await o.bucket.list({ prefix: "crl/", ...(cursor !== undefined && { cursor }) });
    for (const object of page.objects) {
      const name = FILE_KEY.exec(object.key);
      if (name) stored.add(name[1]!);
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }

  const object = await o.bucket.get(INDEX_KEY);
  const before = object === null ? undefined : await object.text();
  // A line stays only if it reads as the spec writes it and its file is there.
  const lines = readIndex(before ?? "").filter((l) => stored.has(l.sha256));
  const write = async (): Promise<void> => {
    await o.bucket.put(INDEX_KEY, formatIndex(lines), { httpMetadata: { cacheControl: CACHE_MINUTE } });
  };
  if (formatIndex(lines) !== before) await write();

  // This round's files first, then the others in the order of their names.
  const listed = new Set(lines.map((l) => l.sha256));
  const fresh = new Set(sources.flatMap((s) => (s.result === "failed" ? [] : [s.sha256])).filter((sha256) => stored.has(sha256) && !listed.has(sha256)));
  const older = [...stored].filter((sha256) => !listed.has(sha256) && !fresh.has(sha256)).sort();
  for (const sha256 of [...fresh, ...older]) {
    if (!fresh.has(sha256) && Date.now() - started > CATCH_UP_MS) break;
    try {
      const result = await indexFile(o, sha256);
      lines.push(result.line);
      await write();
      files.push(result);
    } catch (e) {
      files.push({ result: "failed", sha256, error: messageOf(e) });
    }
  }
  if (files.some((f) => f.result === "failed")) throw new Error("a file of the archive got no line");
  return newestCrls(lines);
}

/** Reads one file of the archive and gives its line of the index. */
async function indexFile(o: InWorkerMirror, sha256: string): Promise<FileResult & { result: "indexed" }> {
  const started = Date.now();
  const object = await o.bucket.get(`crl/${sha256}.crl`);
  if (object === null) throw new Error("the file is not in the bucket");
  // In a function of its own, so that the file's bytes are out of reach while the tree is built: only the keys stay.
  const reading = await (async () => {
    const bytes = new Uint8Array(await object.arrayBuffer());
    // The line's SHA-256 is of the bytes, as it is for anyone who rebuilds the index from the files.
    if (hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !== sha256) throw new Error("the file's bytes do not have the SHA-256 of its name");
    return readCrl(bytes, o.issuers);
  })();
  const read = Date.now();
  let root = `-${reading.reason}`;
  let hashes = 0;
  if (reading.keys !== undefined) {
    const tree = await treeRoot(reading.keys, o.hash, pause);
    root = hexOf(tree.root);
    hashes = tree.hashes;
  }
  const line: IndexLine = { issuer: reading.issuer, crlNumber: reading.crlNumber, thisUpdate: reading.thisUpdate, nextUpdate: reading.nextUpdate, crlDate: reading.crlDate, sha256, root };
  return { result: "indexed", line, entries: reading.entries, keys: reading.keys?.count ?? 0, hashes, readMs: read - started, treeMs: Date.now() - read };
}

/**
 * Asks every source once, all at the same time, each for at most
 * `timeoutMs`. A source that fails stores nothing, and neither a failing
 * nor a slow source keeps another from being stored; a file the bucket
 * already has is not written again.
 */
async function fetchAll(sources: readonly CrlSource[], bucket: R2Bucket, timeoutMs: number): Promise<SourceResult[]> {
  return Promise.all(
    sources.map(async (source): Promise<SourceResult> => {
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
        return { issuer: source.issuer, ...(await Promise.race([fetchOne(source, bucket, abort.signal), late])) };
      } catch (e) {
        return { issuer: source.issuer, result: "failed", error: messageOf(e) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

async function fetchOne(source: CrlSource, bucket: R2Bucket, signal: AbortSignal): Promise<{ result: "stored" | "already_stored"; sha256: string }> {
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
