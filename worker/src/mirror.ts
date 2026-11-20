// The CRL mirror (spec/revocation-tree.md, "Who checks what"). One round:
//
// 1. Asks MOICA for each issuer key's complete CRL and keeps every distinct
//    file, as the original bytes, in the data bucket under
//    `crl/<SHA-256>.crl` (ADR-0027).
// 2. Gives every file of the archive that the index does not list its line:
//    reads it, checks the signature and, if it is a usable CRL, builds its
//    tree (src/crl.ts, src/crl-tree.ts). Usable or not, every file gets a
//    line. `crl/index.jsonl` is written again after each file.
// 3. After each time the index is written, and once at the start, tells the
//    roster's object which are the two newest usable CRLs of each issuer
//    key that the index lists.
//
// What holds throughout: the roster's object knows of a root only once the
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
// The index is one object, replaced whole, so nobody reads half of one; and
// it is replaced only if it is still the object that was read, so two
// rounds at once do not lose each other's lines (`ArchiveIndex`).
//
// The rest of the Worker knows the mirror as `CrlMirror`. This one does the
// work in the Worker; if it outgrows a Worker's limits, another takes its
// place (ADR-0023).
//
// What the first step stores is whatever a complete answer with status 200
// held, CRL or not. What it can tell at the level of HTTP is that an answer
// is not complete, or cannot be a CRL, and then it stores nothing:
//
// - any status but 200, no answer, or an answer that takes longer than the
//   limit;
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
   * Everything that went wrong, in words: a source that failed, a file
   * that got no line, an archive that could not be read, an index that
   * could not be written, a roster's object that could not be told. Empty
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
  /** For how long a round goes on starting files an earlier round left without a line, in milliseconds. */
  readonly catchUpMs: number;
  /** The issuer keys a CRL's signature is checked against, in order. */
  readonly issuers: readonly IssuerKey[];
  /** The hash the trees are built with. */
  readonly hash: Poseidon2Hash;
  /**
   * Tells the roster's object the newest usable CRLs the index lists. The
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
      const sources = await fetchAll(parts.sources, parts.bucket, parts.timeoutMs);
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
  /** The lines in the bucket: what the roster's object may be told of, while `known`. */
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
  const started = Date.now();
  /** Tells the roster's object what the index now lists; that it could not be told is said once. */
  let untold = false;
  const tell = async (index: ArchiveIndex): Promise<void> => {
    // Only what the bucket is known to hold is told (`ArchiveIndex`, `known`).
    if (!index.known) return;
    try {
      await parts.tell(newestCrls(index.lines));
    } catch (e) {
      if (!untold) errors.push(`the roster's object was not told: ${messageOf(e)}`);
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
    if (!fresh.has(sha256) && Date.now() - started >= parts.catchUpMs) break;
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

/** Reads one file of the archive and gives its line of the index. */
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
  await bucket.put(key, bytes, { httpMetadata: { cacheControl: CACHE_IMMUTABLE } });
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
