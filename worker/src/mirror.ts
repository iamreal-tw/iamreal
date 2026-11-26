// The CRL mirror (spec/revocation-tree.md, "Who checks what"). One round:
//
// 1. Asks MOICA for each issuer key's complete CRL and keeps every distinct
//    file, as the original bytes, in the data bucket under
//    `crl/<SHA-256>.crl` (ADR-0027). It asks with a condition: MOICA signs
//    a CRL four times a day and the mirror asks every hour, so most rounds
//    the file is the one it has, and MOICA says so without sending it
//    (`lastAnswers`).
// 2. Gives every file of the archive that the index does not list its line:
//    reads it, checks the signature and, if it is a usable CRL, builds its
//    tree (src/crl.ts, src/crl-tree.ts). Usable or not, every file gets a
//    line. `crl/index.jsonl` is written again after each file.
// 3. After each time the index is written, and once at the start, tells the
//    proof log's object which are the two newest usable CRLs of each issuer
//    key that the index lists.
//
// What holds throughout: the proof log's object knows of a root only once the
// index in the bucket lists it.
//
// The second step works from what the bucket holds, not from what the first
// step just fetched. So a file whose SHA-256 the index already lists is not
// read again and no tree is built for it; and a file that was stored in a
// round that ended before its line was written gets its line in the next
// round. A file that cannot get its line is that file's trouble alone: the
// round says so, goes on with the others, and the next round tries it
// again.
//
// A round may be stopped at any moment: Cloudflare ends an invocation that
// has used its CPU time (wrangler.jsonc, "limits"). Every line written
// until then stays, and the proof log's object has heard of it; the file whose
// tree was being built is stored and gets its line in a later round. So
// that a round is not stopped, it does not start another of the files an
// earlier round left unless it still has the time the largest takes
// (src/round-budget.ts). The files it fetched itself it always does: if
// those two do not fit into one invocation, no round can do them
// (ADR-0023 says what then).
//
// The index is one object, replaced whole, so nobody reads half of one; and
// it is replaced only if it is still the object that was read, so two
// rounds at once do not lose each other's lines (`ArchiveIndex`).
//
// The rest of the Worker knows the mirror as `CrlMirror`. This one does the
// work in the Worker; if it outgrows a Worker's limits, another takes its
// place (ADR-0023).
//
// What the first step stores is whatever a complete answer with status 200
// held, CRL or not. A 304 to a request that carried a condition stores
// nothing: the file the condition was of is in the bucket. What it can tell at the level of HTTP is that an answer
// is not complete, or cannot be a CRL, and then it stores nothing:
//
// - any status but 200 (or 304, see above), no answer, or an answer that
//   takes longer than the limit;
// - an answer the runtime reports as broken off;
// - fewer or more bytes than the answer's Content-Length;
// - no bytes at all, or more than MAX_CRL_BYTES.
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
import { type IndexLine, type NewestCrls, formatIndex, lineOf, newestCrls, readIndex } from "./crl-index.ts";
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
  /**
   * `stored`: a file the bucket did not have. `already_stored`: the whole answer came, and the bucket has its bytes.
   * `not_modified`: MOICA answered 304, nothing was downloaded; `sha256` is the file the request's condition was of.
   */
  | { readonly issuer: IssuerName; readonly result: "stored" | "already_stored" | "not_modified"; readonly sha256: string }
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
      /**
       * Milliseconds: getting the file and reading it, signature included;
       * then building the tree. Too little on Cloudflare, where the clock
       * stands still while code runs (`indexFile`).
       */
      readonly readMs: number;
      readonly treeMs: number;
    }
  | { readonly result: "failed"; readonly sha256: string; readonly error: string };

/** What one round of the mirror did. */
export interface MirrorRound {
  readonly sources: readonly SourceResult[];
  readonly files: readonly FileResult[];
  /**
   * Everything that went wrong, in words: a source that failed, a file
   * that got no line, an archive that could not be read, an index that
   * could not be written, a proof log's object that could not be told. Empty
   * if the round did all it had to do.
   */
  readonly errors: readonly string[];
}

/**
 * The CRL mirror, as the rest of the Worker knows it. A round does not
 * throw: what went wrong is in what it returns, and what could be done was
 * done all the same.
 */
export interface CrlMirror {
  round(): Promise<MirrorRound>;
}

/** What the mirror that works in the Worker is given to work with. */
export interface MirrorParts {
  readonly sources: readonly CrlSource[];
  /** The data bucket: the archive is its `crl/`. */
  readonly bucket: R2Bucket;
  /** How long to wait for one source, in milliseconds. */
  readonly timeoutMs: number;
  /**
   * For how long a round goes on starting files an earlier round left
   * without a line, in milliseconds: what the round may use, less what the
   * largest file takes (src/round-budget.ts).
   */
  readonly catchUpMs: number;
  /** The issuer keys a CRL's signature is checked against, in order. */
  readonly issuers: readonly IssuerKey[];
  /** The hash the trees are built with. */
  readonly hash: Poseidon2Hash;
  /**
   * Tells the proof log's object the newest usable CRLs the index lists. The
   * mirror calls it only with what the index in the bucket holds at that
   * moment.
   */
  readonly tell: (newest: NewestCrls) => Promise<void>;
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

/**
 * What a stored file's custom metadata says of the answer it came in: the
 * address it was asked of, and the answer's `ETag` and `Last-Modified` as
 * MOICA sent them. They are kept with the bytes they describe, so they are
 * gone when the file is.
 */
const META_SOURCE = "source";
const META_ETAG = "etag";
const META_LAST_MODIFIED = "last-modified";

/** A header value the mirror keeps and sends back: printable ASCII, not long. Anything else is as if MOICA sent none. */
const KEPT_HEADER = /^[\x20-\x7e]{1,256}$/;

const INDEX_KEY = "crl/index.jsonl";
const FILE_KEY = /^crl\/([0-9a-f]{64})\.crl$/;

/**
 * The largest answer the mirror stores: 32 MiB. MOICA's larger CRL, G2's,
 * was 16.9 MB on 2026-11-19 (README.md, "第一次部署量到的"). An answer is
 * held in memory whole, both sources at the same time, and a Worker has 128
 * MB for everything (https://developers.cloudflare.com/workers/platform/limits/);
 * anyone on the way to MOICA's plain-HTTP addresses can send any number of
 * bytes.
 */
export const MAX_CRL_BYTES = 32 * 1024 * 1024;

/** How often writing the index is tried again when another writer got there first. */
const INDEX_ATTEMPTS = 5;

/** Lets whatever else waits in this isolate run. */
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The mirror that does all its work in the Worker. */
export function crlMirrorInWorker(parts: MirrorParts): CrlMirror {
  return {
    async round() {
      const sources = await fetchAll(parts.sources, parts.bucket, parts.timeoutMs, await lastAnswers(parts.bucket));
      const files: FileResult[] = [];
      const errors = sources.flatMap((s) => (s.result === "failed" ? [`${s.issuer} failed: ${s.error}`] : []));
      try {
        await indexArchive(parts, sources, files, errors);
      } catch (e) {
        errors.push(messageOf(e));
      }
      return { sources, files, errors };
    },
  };
}

/**
 * `crl/index.jsonl` as this round last saw it in the bucket. `change`
 * writes it conditionally: only if the object is still the one that was
 * read. If another writer replaced it meanwhile, the index is read again
 * and the change is made to that one, so neither writer's lines are lost.
 */
class ArchiveIndex {
  readonly #bucket: R2Bucket;
  /** The lines in the bucket: what the proof log's object may be told of, while `known`. */
  lines: readonly IndexLine[] = [];
  /**
   * Whether `lines` are what the bucket holds. They are not once a write
   * failed in a way that does not say whether it was done, and the index
   * could not be read again either: then nobody is told anything until it
   * is read.
   */
  known = false;
  /** The object's bytes as text and its ETag; `undefined` if there is no index. */
  #text: string | undefined;
  #etag: string | undefined;

  private constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  static async read(bucket: R2Bucket): Promise<ArchiveIndex> {
    const index = new ArchiveIndex(bucket);
    await index.#read();
    return index;
  }

  async #read(): Promise<void> {
    const object = await this.#bucket.get(INDEX_KEY);
    this.#text = object === null ? undefined : await object.text();
    this.#etag = object?.etag;
    // Only the lines written as the spec writes them count (src/crl-index.ts, `readIndex`).
    this.lines = readIndex(this.#text ?? "");
    this.known = true;
  }

  /**
   * Makes the index in the bucket what `change` gives for its lines.
   * `change` may be called more than once, each time with the lines the
   * bucket then holds. Nothing is written if the bytes would be the same.
   */
  async change(change: (lines: readonly IndexLine[]) => readonly IndexLine[]): Promise<void> {
    for (let attempt = 0; attempt < INDEX_ATTEMPTS; attempt++) {
      const lines = change(this.lines);
      const text = formatIndex(lines);
      if (text === this.#text) return;
      // Written only over the object that was read, or only if there is still none.
      const onlyIf = this.#etag === undefined ? new Headers({ "If-None-Match": "*" }) : { etagMatches: this.#etag };
      let written: R2Object | null;
      try {
        written = await this.#bucket.put(INDEX_KEY, text, { httpMetadata: { cacheControl: CACHE_MINUTE }, onlyIf });
      } catch (e) {
        // A write that throws may have been done all the same. What the
        // bucket holds now is read again before anybody is told of it.
        this.known = false;
        await this.#read();
        throw e;
      }
      if (written !== null) {
        this.lines = readIndex(text);
        this.#text = text;
        this.#etag = written.etag;
        return;
      }
      await this.#read();
    }
    throw new Error(`the index was replaced by another writer ${INDEX_ATTEMPTS} times in a row`);
  }
}

/**
 * The second and third steps of a round. Adds to `files` and `errors` as it
 * goes. Throws only if the archive cannot be read at all.
 */
async function indexArchive(parts: MirrorParts, sources: readonly SourceResult[], files: FileResult[], errors: string[]): Promise<void> {
  // Read after the first step's requests, so it is the time now (see `elapsedMs` below).
  const started = Date.now();
  /**
   * How long the round has been on the archive, by the clock. On
   * Cloudflare the clock stands still while code runs: `Date.now()` "only
   * advance[s] or increment[s] after I/O occurs"
   * (https://developers.cloudflare.com/workers/runtime-apis/performance/),
   * it "returns the time of the last I/O"
   * (https://developers.cloudflare.com/workers/reference/security-model/;
   * both read on 2026-11-20). In the local workerd it advances regardless,
   * so no test here can see the difference. A tree is seconds of
   * computing with no I/O, so the clock is read only after a request to
   * the bucket made for this purpose, the cheapest there is. It does not
   * rely on what else the loop did just before: a file that failed after
   * its tree was built leaves no I/O behind it. If that request fails,
   * the clock is read all the same, and may show too little.
   */
  const elapsedMs = async (): Promise<number> => {
    try {
      await parts.bucket.head(INDEX_KEY);
    } catch {
      // The index's own trouble is found where the index is read and written.
    }
    return Date.now() - started;
  };
  /** Tells the proof log's object what the index now lists; that it could not be told is said once. */
  let untold = false;
  const tell = async (index: ArchiveIndex): Promise<void> => {
    // Only what the bucket is known to hold is told (`ArchiveIndex`, `known`).
    if (!index.known) return;
    try {
      await parts.tell(newestCrls(index.lines));
    } catch (e) {
      if (!untold) errors.push(`the proof log's object was not told: ${messageOf(e)}`);
      untold = true;
    }
  };

  // The index first, then the files: a line's file is stored before the
  // line is written, so every line read here has its file in the listing,
  // unless the file is gone.
  const index = await ArchiveIndex.read(parts.bucket);
  /** Each file's SHA-256 and when it was stored. */
  const stored = new Map<string, number>();
  for (let cursor: string | undefined; ; ) {
    const page = await parts.bucket.list({ prefix: "crl/", ...(cursor !== undefined && { cursor }) });
    for (const object of page.objects) {
      const name = FILE_KEY.exec(object.key);
      if (name) stored.set(name[1]!, object.uploaded.getTime());
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }

  try {
    // A line whose file is not there goes; and the index is written anew if it was not as the spec writes it.
    const gone = new Set(index.lines.filter((l) => !stored.has(l.sha256)).map((l) => l.sha256));
    await index.change((lines) => lines.filter((l) => !gone.has(l.sha256)));
  } catch (e) {
    errors.push(`the index was not written: ${messageOf(e)}`);
  }
  await tell(index);

  // This round's files first, then the others, the one stored last first:
  // the newest CRLs are the ones a card proof needs.
  const listed = new Set(index.lines.map((l) => l.sha256));
  const fresh = new Set(sources.flatMap((s) => (s.result === "failed" ? [] : [s.sha256])).filter((sha256) => stored.has(sha256) && !listed.has(sha256)));
  const older = [...stored.keys()].filter((sha256) => !listed.has(sha256) && !fresh.has(sha256)).sort((a, b) => stored.get(b)! - stored.get(a)! || (a < b ? -1 : 1));
  for (const sha256 of [...fresh, ...older]) {
    // This round's files are always done. Another of the older ones is
    // started only while the round has time left for the largest
    // (`catchUpMs`). The time is the clock's, since the round began on the
    // archive: a Worker cannot read its CPU time, and from here on it never
    // uses more CPU time than the clock shows, as long as the clock is
    // read right after I/O (`elapsedMs`).
    if (!fresh.has(sha256) && (await elapsedMs()) >= parts.catchUpMs) break;
    try {
      const result = await indexFile(parts, sha256);
      await index.change((lines) => (lines.some((l) => l.sha256 === sha256) ? lines : [...lines, result.line]));
      files.push(result);
      await tell(index);
    } catch (e) {
      // This file's trouble alone: the next round tries it again.
      files.push({ result: "failed", sha256, error: messageOf(e) });
      errors.push(`${sha256} got no line: ${messageOf(e)}`);
    }
  }
}

/**
 * Reads one file of the archive and gives its line of the index.
 *
 * `readMs` and `treeMs` are right in the local workerd only. On Cloudflare
 * the clock does not advance while code runs (`indexArchive`, `elapsedMs`),
 * and both are read after computing, with no I/O in between: there they
 * may show far too little, down to 0. What a round used on Cloudflare is
 * the CPU time the dashboard shows for the invocation.
 */
async function indexFile(parts: MirrorParts, sha256: string): Promise<FileResult & { result: "indexed" }> {
  const started = Date.now();
  const object = await parts.bucket.get(`crl/${sha256}.crl`);
  if (object === null) throw new Error("the file is not in the bucket");
  // In a function of its own, so that the file's bytes are out of reach while the tree is built: only the keys stay.
  const reading = await (async () => {
    const bytes = new Uint8Array(await object.arrayBuffer());
    // The line's SHA-256 is of the bytes, as it is for anyone who rebuilds the index from the files.
    if (hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) !== sha256) throw new Error("the file's bytes do not have the SHA-256 of its name");
    return readCrl(bytes, parts.issuers);
  })();
  const read = Date.now();
  const tree = reading.keys === undefined ? undefined : await treeRoot(reading.keys, parts.hash, pause);
  return {
    result: "indexed",
    line: lineOf(sha256, reading, tree?.root),
    entries: reading.entries,
    keys: reading.keys?.count ?? 0,
    hashes: tree?.hashes ?? 0,
    readMs: read - started,
    treeMs: Date.now() - read,
  };
}

/** The file a source's last new answer was stored as, and what MOICA said of that answer. */
interface LastAnswer {
  readonly sha256: string;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
}

/**
 * For each address, the file stored last of those that came from it with
 * an `ETag` or a `Last-Modified`: what the next request to that address is
 * conditional on. A file of the archive without them (stored before the
 * mirror kept them, or from an answer that had none) is no one's last
 * answer, and its address is asked without a condition.
 *
 * If the archive cannot be listed, every address is asked without a
 * condition: the round then downloads what it may already have, as every
 * round did before.
 */
async function lastAnswers(bucket: R2Bucket): Promise<ReadonlyMap<string, LastAnswer>> {
  const last = new Map<string, LastAnswer & { readonly uploaded: number }>();
  try {
    for (let cursor: string | undefined; ; ) {
      const page = await bucket.list({ prefix: "crl/", include: ["customMetadata"], ...(cursor !== undefined && { cursor }) });
      for (const object of page.objects) {
        const name = FILE_KEY.exec(object.key);
        const source = object.customMetadata?.[META_SOURCE];
        if (!name || source === undefined) continue;
        const kept = (value: string | undefined): string | undefined => (value !== undefined && KEPT_HEADER.test(value) ? value : undefined);
        const etag = kept(object.customMetadata?.[META_ETAG]);
        const lastModified = kept(object.customMetadata?.[META_LAST_MODIFIED]);
        if (etag === undefined && lastModified === undefined) continue;
        const uploaded = object.uploaded.getTime();
        if ((last.get(source)?.uploaded ?? -Infinity) < uploaded) last.set(source, { sha256: name[1]!, etag, lastModified, uploaded });
      }
      if (!page.truncated) break;
      cursor = page.cursor;
    }
  } catch {
    return new Map();
  }
  return last;
}

/**
 * Asks every source once, all at the same time, each for at most
 * `timeoutMs`. A source that fails stores nothing, and neither a failing
 * nor a slow source keeps another from being stored; a file the bucket
 * already has is not written again.
 */
async function fetchAll(sources: readonly CrlSource[], bucket: R2Bucket, timeoutMs: number, last: ReadonlyMap<string, LastAnswer>): Promise<SourceResult[]> {
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
        return { issuer: source.issuer, ...(await Promise.race([fetchOne(source, bucket, abort.signal, last.get(source.url)), late])) };
      } catch (e) {
        return { issuer: source.issuer, result: "failed", error: messageOf(e) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}

/**
 * One request to one source. With `last`, the request is conditional on
 * that answer (RFC 9110, 13.1): `If-None-Match` with its `ETag`, or, if it
 * had none, `If-Modified-Since` with its `Last-Modified`. One of the two,
 * not both: a server that is given `If-None-Match` does not look at the
 * other, and one condition is what MOICA was seen to answer 304 to
 * (README.md, "內政部對條件式請求怎麼回").
 */
async function fetchOne(source: CrlSource, bucket: R2Bucket, signal: AbortSignal, last: LastAnswer | undefined): Promise<{ result: "stored" | "already_stored" | "not_modified"; sha256: string }> {
  const condition: Record<string, string> = last === undefined ? {} : last.etag !== undefined ? { "If-None-Match": last.etag } : { "If-Modified-Since": last.lastModified! };
  const response = await fetch(source.url, { headers: { "User-Agent": USER_AGENT, ...condition }, signal });
  if (response.status === 304 && last !== undefined) {
    await response.body?.cancel();
    // The file the condition was of was in the bucket when the round began; it is said to be there only if it still is.
    if (!(await bucket.head(`crl/${last.sha256}.crl`))) throw new Error(`HTTP status 304, and the file it is about, ${last.sha256}, is not in the bucket`);
    return { result: "not_modified", sha256: last.sha256 };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`HTTP status ${response.status}`);
  }
  // Content-Length counts the bytes as sent. If they were compressed on the
  // way (Content-Encoding), what arrives here is not that many, and the
  // header says nothing about it.
  const declared = response.headers.get("Content-Encoding") === null ? response.headers.get("Content-Length") : null;
  if (declared !== null && Number(declared) > MAX_CRL_BYTES) {
    await response.body?.cancel();
    throw new Error(`Content-Length ${declared}, more than ${MAX_CRL_BYTES} bytes`);
  }
  const bytes = declared !== null ? await response.arrayBuffer() : await bodyUpTo(response, MAX_CRL_BYTES);
  if (bytes.byteLength === 0) throw new Error("an empty answer");
  if (declared !== null && declared !== String(bytes.byteLength)) throw new Error(`${bytes.byteLength} bytes, Content-Length ${declared}`);
  const sha256 = hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  const key = `crl/${sha256}.crl`;
  // The name is the SHA-256 of the bytes, so a file of this name has these bytes.
  if (await bucket.head(key)) return { result: "already_stored", sha256 };
  signal.throwIfAborted(); // nothing is written once the limit has passed
  // What MOICA said of this answer is kept only if the answer said how long it is and was that long: an answer that
  // may have been broken off (see the top of this file) must not be the one a later request is conditional on.
  const kept = (name: string): string | undefined => {
    const value = declared === null ? null : response.headers.get(name);
    return value !== null && KEPT_HEADER.test(value) ? value : undefined;
  };
  const etag = kept("ETag");
  const lastModified = kept("Last-Modified");
  const customMetadata = etag === undefined && lastModified === undefined ? undefined : { [META_SOURCE]: source.url, ...(etag !== undefined && { [META_ETAG]: etag }), ...(lastModified !== undefined && { [META_LAST_MODIFIED]: lastModified }) };
  await bucket.put(key, bytes, { httpMetadata: { cacheControl: CACHE_IMMUTABLE }, ...(customMetadata !== undefined && { customMetadata }) });
  return { result: "stored", sha256 };
}

/**
 * The body of an answer that does not say how long it is, read piece by
 * piece and given up as soon as it is longer than `limit` bytes.
 */
async function bodyUpTo(response: Response, limit: number): Promise<ArrayBuffer> {
  if (response.body === null) return new ArrayBuffer(0);
  const pieces: Uint8Array[] = [];
  let length = 0;
  for await (const piece of response.body as ReadableStream<Uint8Array>) {
    length += piece.byteLength;
    if (length > limit) throw new Error(`more than ${limit} bytes`); // leaving the loop cancels the body
    pieces.push(piece);
  }
  const whole = new Uint8Array(length);
  let at = 0;
  for (const piece of pieces) {
    whole.set(piece, at);
    at += piece.byteLength;
  }
  return whole.buffer;
}
