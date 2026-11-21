// The roster directory in the data bucket (ADR-0027; spec/record.md, "The
// published roster"): where its files are, how one is written, and how one
// is read again. Which files there are and what is in them is the roster's
// object's (roster.ts); their names and the spelling of a record hash list
// are protocol/'s.
//
// The bucket is written through the binding only, and nothing here or
// anywhere in the Worker sends one of these files to anybody: they are
// downloaded from the data domain, which does not run the Worker.
import { hexOf, sha256Hex } from "iamreal-protocol/bytes.ts";
import { type Day, formatDay } from "iamreal-protocol/date.ts";
import { FINGERPRINT_FILE_NAME, LINES_PER_FILE, rosterFileName } from "iamreal-protocol/record.ts";

/** The roster directory's place in the data bucket (ADR-0027). */
export const ROSTER_DIRECTORY = "roster/";

/**
 * The `Cache-Control` of a full roster file and of its record hash list:
 * neither ever changes again (spec/record.md, "The published roster"). The
 * data domain caches by the header the object carries and by nothing else
 * (README.md, "寫滿的名冊檔搬到 R2").
 */
export const CACHE_FULL_FILE = "public, max-age=31536000, immutable";

/**
 * The `Cache-Control` of what the roster's object writes once a day and
 * writes again the next: the last roster file, which is not full, and its
 * record hash list; the card state file of a date; the fingerprint file
 * (ADR-0027).
 */
export const CACHE_DAILY = "public, max-age=60";

/** The fingerprint file's place in the data bucket. */
export const FINGERPRINT_FILE = ROSTER_DIRECTORY + FINGERPRINT_FILE_NAME;

/** The place in the data bucket of the card state file of a date in Taiwan (ADR-0027). */
export function cardStateFileKey(date: Day): string {
  return `${ROSTER_DIRECTORY}card-state/${formatDay(date)}.jsonl`;
}

/**
 * The `Content-Type` of the roster directory's files of lines of JSON
 * (`.jsonl`): the roster files, and whatever else of the directory is
 * written in that form. It is not a type registered with IANA, only the
 * usual name for such a file; nothing that reads the roster depends on it.
 */
export const TYPE_JSON_LINES = "application/x-ndjson";

/**
 * The `Content-Type` of a record hash list (`.txt`): text a person checks
 * a hash against, which a browser then shows as it is.
 */
export const TYPE_TEXT = "text/plain; charset=utf-8";

/** The headers an object of the roster directory is written with. */
export interface FileHeaders {
  readonly cacheControl: string;
  readonly contentType: string;
}

/**
 * How long after a full roster file could not be moved to the data bucket
 * the object tries again: one minute. Long enough that the second try is
 * never the second write of an object within a second, which R2 refuses
 * (https://developers.cloudflare.com/r2/platform/limits/), and short next
 * to the day after which the file is first needed in the bucket.
 */
export const FULL_FILE_RETRY_MS = 60 * 1000;

/** What the roster's object uses of the data bucket. */
export type FileBucket = Pick<R2Bucket, "put" | "get">;

/**
 * Writes an object and reads it back: it returns, with the SHA-256 of the
 * bytes, only once the bucket gives exactly these bytes under this key,
 * with these headers. Otherwise it throws; the message names the key and
 * nothing of the content.
 *
 * The bucket is given the SHA-256 with the bytes, to check what it
 * received by (README.md, "寫滿的名冊檔搬到 R2", says what is known of
 * that): bytes that changed on the way are then not stored at all, where
 * the reading back alone would find them only once they are under the
 * object's public name.
 *
 * Writing the same bytes again leaves the same object, so a caller that
 * does not know how far an earlier try came simply calls this again.
 *
 * With `over`, the object is written only over the one the caller read:
 * the object of that ETag, or, with null, only where there is still no
 * object. If the bucket holds anything else by then, nothing is written
 * and this throws.
 */
export async function writeAndReadBack(bucket: FileBucket, key: string, bytes: Uint8Array, headers: FileHeaders, over?: { readonly etag: string | null }): Promise<string> {
  const sha256 = await sha256Hex(bytes);
  const onlyIf = over === undefined ? undefined : over.etag === null ? new Headers({ "If-None-Match": "*" }) : { etagMatches: over.etag };
  const written = await bucket.put(key, bytes, { httpMetadata: { cacheControl: headers.cacheControl, contentType: headers.contentType }, sha256, ...(onlyIf !== undefined && { onlyIf }) });
  // A write whose condition does not hold stores nothing and gives null.
  if (written === null) throw new Error(`${key} is no longer the object that was read: it was not written over`);
  const stored = await readBack(bucket, key, headers);
  if (!(await isBytes(stored.body, bytes))) throw new Error(`${key} read back is not the bytes that were written`);
  return sha256;
}

/** The number of bytes and the SHA-256 of what `chunks` gives, read as it comes and not kept. */
export async function lengthAndSha256(chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<{ length: number; sha256: string }> {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  let length = 0;
  for await (const chunk of chunks) {
    await writer.write(chunk);
    length += chunk.length;
  }
  await writer.close();
  return { length, sha256: hexOf(new Uint8Array(await digest.digest)) };
}

/** What `writeStreamAndReadBack` writes: a stream of bytes, with their number and their SHA-256, both known before it is read. */
export interface StreamToWrite {
  readonly stream: ReadableStream<Uint8Array>;
  readonly length: number;
  readonly sha256: string;
}

/**
 * Writes an object from a stream and reads it back, holding neither in
 * memory: `writeAndReadBack` for an object too large to hold. It returns
 * only once the bucket gives, under this key and with these headers, an
 * object of `body.length` bytes whose SHA-256 is `body.sha256`. Otherwise
 * it throws; the message names the key and nothing of the content.
 *
 * The bucket is given the SHA-256 with the stream, as `writeAndReadBack`
 * gives it with the bytes: if what it received is not those bytes, nothing
 * is stored. A stream that gives other than `body.length` bytes, or fails,
 * stores nothing either (`FixedLengthStream`). The object is read back
 * through a SHA-256 in place of a comparison of bytes, which would need
 * the bytes that were written.
 *
 * Writing the same bytes again leaves the same object, so a caller that
 * does not know how far an earlier try came simply calls this again.
 */
export async function writeStreamAndReadBack(bucket: FileBucket, key: string, body: StreamToWrite, headers: FileHeaders): Promise<void> {
  // The bucket takes a stream only of a known length.
  const sized = body.stream.pipeThrough(new FixedLengthStream(body.length));
  try {
    await bucket.put(key, sized, { httpMetadata: { cacheControl: headers.cacheControl, contentType: headers.contentType }, sha256: body.sha256 });
  } catch (e) {
    // A write that failed without reading the stream to its end: the rest is not read.
    await sized.cancel().catch(() => undefined);
    throw e;
  }
  const stored = await readBack(bucket, key, headers);
  const read = await lengthAndSha256(stored.body);
  if (read.length !== body.length || read.sha256 !== body.sha256) throw new Error(`${key} read back is not the bytes that were written`);
}

/** The object just written under `key`, once it is there with these headers; otherwise this throws, its body unread. */
async function readBack(bucket: FileBucket, key: string, headers: FileHeaders): Promise<R2ObjectBody> {
  const stored = await bucket.get(key);
  if (stored === null) throw new Error(`${key} is not in the bucket after it was written`);
  if (stored.httpMetadata?.cacheControl !== headers.cacheControl || stored.httpMetadata.contentType !== headers.contentType) {
    await stored.body.cancel();
    throw new Error(`${key} does not carry the headers it was written with`);
  }
  return stored;
}

/** Whether a stream gives exactly `bytes`. It is compared as it comes, so that the object is not held in memory a second time. */
async function isBytes(stream: ReadableStream<Uint8Array>, bytes: Uint8Array): Promise<boolean> {
  let at = 0;
  let same = true;
  // The stream is read to its end, also after the first difference.
  for await (const chunk of stream) {
    if (!same) continue;
    if (at + chunk.length > bytes.length) same = false;
    else for (let i = 0; i < chunk.length; i++) if (chunk[i] !== bytes[at + i]) { same = false; break; }
    at += chunk.length;
  }
  return same && at === bytes.length;
}

/**
 * The lines of a full roster file as the bucket has it, each with its LF:
 * the file that follows the first `before` records, whose bytes have this
 * SHA-256. Throws if the file is not there, is not those bytes, or is not
 * 1,000 lines.
 */
export async function readFullFile(bucket: FileBucket, before: number, sha256: string): Promise<string[]> {
  const key = ROSTER_DIRECTORY + rosterFileName(before);
  const stored = await bucket.get(key);
  if (stored === null) throw new Error(`${key} is not in the bucket`);
  const bytes = new Uint8Array(await stored.arrayBuffer());
  if ((await sha256Hex(bytes)) !== sha256) throw new Error(`${key} is not the bytes that were written`);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const lines: string[] = [];
  for (let at = 0; at < text.length; ) {
    const lf = text.indexOf("\n", at);
    if (lf < 0) throw new Error(`${key} does not end with LF`);
    lines.push(text.slice(at, lf + 1));
    at = lf + 1;
  }
  if (lines.length !== LINES_PER_FILE) throw new Error(`${key} is not ${LINES_PER_FILE} lines`);
  return lines;
}
