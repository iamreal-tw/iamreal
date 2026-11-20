// Reading one file of the CRL archive: whether it is a usable CRL
// (spec/revocation-tree.md, "Which CRLs"), what its line of the archive
// index says, and the keys of its tree. The rules, the reason codes and
// their order are those of the Go crl/ (crl.go, key.go and IndexFile of
// index.go), file for file: test/crl-testdata.test.ts runs both over
// crl/testdata/.
//
// MOICA's G2 CRL has about 340,000 entries in 17 MB. Nothing here makes an
// object per entry (#26): the file is walked as bytes, and each serial
// number's key goes straight into one Uint32Array. Duplicates and keys that
// collide are found by sorting that array.
import { bytesOfHex, equalBytes, hexOf } from "iamreal-protocol/bytes.ts";
import { formatDate, formatTime, secondsOfCivil } from "./crl-time.ts";
import type { IssuerKey, IssuerName } from "./issuers.ts";

/** Why a file gives no tree, in the order the checks are made. */
export type UnusableReason =
  | "not_usable_der"
  | "not_usable_algorithm"
  | "not_usable_signature"
  | "not_usable_duplicate_extension"
  | "not_usable_critical_extension"
  | "not_usable_delta"
  | "not_usable_partitioned"
  | "not_usable_crl_number"
  | "not_usable_serial"
  | "not_usable_collision";

/** Words of 32 bits per key. */
export const KEY_WORDS = 5;

/**
 * The keys of a usable CRL, one per distinct serial number, sorted by their
 * place in the tree.
 *
 * A key is a serial number's content bytes read as an unsigned integer
 * below 2^160. It is kept as five words in the order the tree reads it:
 * word `j` of the first four holds bits `32j` to `32j + 31` of the key with
 * their order reversed, so that bit `l` of the key, counted from the least
 * significant, is bit `31 - l % 32` of word `l >> 5`; the fifth word holds
 * bits 128 to 159 as they are. Comparing keys word by word then compares
 * their paths from the root down.
 */
export interface TreeKeys {
  readonly words: Uint32Array;
  readonly count: number;
}

/** What the archive index says of one file, without its SHA-256 and its root. */
export interface CrlReading {
  /** The key under which the signature verifies, or `-`. */
  readonly issuer: IssuerName | "-";
  /** `cRLNumber` in decimal, or `-`. */
  readonly crlNumber: string;
  /** UTC, `YYYY-MM-DDTHH:MM:SSZ`, or `-`. */
  readonly thisUpdate: string;
  readonly nextUpdate: string;
  /** `thisUpdate` as a date in Taiwan, or `-`. */
  readonly crlDate: string;
  /** Number of elements of `revokedCertificates`; 0 for a file that is not DER. */
  readonly entries: number;
  /** The first reason the file is not usable, or `undefined` if it is. */
  readonly reason: UnusableReason | undefined;
  /** The keys of the tree, if the file is usable. */
  readonly keys: TreeKeys | undefined;
}

const NONE = "-" as const;

/** Thrown inside this file for anything that is not a DER CertificateList. */
class NotDer extends Error {}
const notDer = (): never => {
  throw new NotDer();
};

const TAG_BOOLEAN = 0x01;
const TAG_INTEGER = 0x02;
const TAG_BIT_STRING = 0x03;
const TAG_OCTET_STRING = 0x04;
const TAG_OID = 0x06;
const TAG_UTC_TIME = 0x17;
const TAG_GENERALIZED_TIME = 0x18;
const TAG_SEQUENCE = 0x30;
/** `[0]`, constructed: crlExtensions. */
const TAG_CONTEXT_0 = 0xa0;

/** sha256WithRSAEncryption with NULL parameters, as an AlgorithmIdentifier. */
const SHA256_WITH_RSA_NULL = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00]);
const OID_CRL_NUMBER = Uint8Array.from([0x55, 0x1d, 0x14]);
const OID_DELTA_CRL_INDICATOR = Uint8Array.from([0x55, 0x1d, 0x1b]);
const OID_ISSUING_DISTRIBUTION_POINT = Uint8Array.from([0x55, 0x1d, 0x1c]);

const MAX_SERIAL_BYTES = 20;

// The reader's cursor: what the last call of `read` (or `expect`) found.
// `lastTag` is that element's tag, and its content is
// `der[lastFrom..lastTo)`. These are module-level variables, not a returned
// object, because a CRL has hundreds of thousands of elements and reading
// one must allocate nothing (#26).
//
// So the order of calls matters: every `read` overwrites all three, and so
// does everything that reads (`expect`, `extensions`, `nonNegativeInteger`).
// Code that needs an element's bounds after reading another copies them
// into constants first (`const [serialFrom, serialTo] = [lastFrom, lastTo]`).
// `time` reads nothing: it interprets the element last read.
let lastTag = 0;
let lastFrom = 0;
let lastTo = 0;

/**
 * Reads the element that starts at `at` and ends at or before `limit`, as
 * Go's cryptobyte does: one-byte tags, definite lengths of at most four
 * bytes in their shortest form. Returns where the next element starts.
 */
function read(der: Uint8Array, at: number, limit: number): number {
  if (limit - at < 2) notDer();
  lastTag = der[at]!;
  if ((lastTag & 0x1f) === 0x1f) notDer();
  let length = der[at + 1]!;
  let content = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (n === 0 || n > 4 || limit - content < n) notDer();
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + der[content + i]!;
    if (length < 0x80 || der[content] === 0) notDer();
    content += n;
  }
  if (length > limit - content) notDer();
  lastFrom = content;
  lastTo = content + length;
  return lastTo;
}

/** `read`, and the element has this tag. */
function expect(der: Uint8Array, at: number, limit: number, wanted: number): number {
  const next = read(der, at, limit);
  if (lastTag !== wanted) notDer();
  return next;
}

const peek = (der: Uint8Array, at: number, limit: number, wanted: number): boolean => at < limit && der[at] === wanted;

const digit = (der: Uint8Array, at: number): number => {
  const d = der[at]! - 0x30;
  if (!(d >= 0 && d <= 9)) notDer();
  return d;
};
const two = (der: Uint8Array, at: number): number => digit(der, at) * 10 + digit(der, at + 1);

/**
 * The UTCTime or GeneralizedTime last read, as seconds since the epoch.
 * The spellings read are those the Go crl/ reads, which are a little more
 * than DER: UTCTime with or without seconds, and either type with `Z` or
 * with an offset `±hhmm` that is not zero. Anything else is not DER.
 * crl/testdata/times/ has a file for each, with what both give. The spec
 * does not say yet which spellings are accepted; #120 will narrow them.
 */
function time(der: Uint8Array): number {
  let at = lastFrom;
  let year: number;
  let digits: number;
  // How many digits the time has, from the first byte that is not one.
  let n = 0;
  while (at + n < lastTo && der[at + n]! >= 0x30 && der[at + n]! <= 0x39) n++;
  if (lastTag === TAG_UTC_TIME) {
    if (n !== 10 && n !== 12) notDer();
    year = two(der, at);
    // Go reads 69 to 99 as 19xx, and cryptobyte moves 2050 to 2068 back a century.
    year += year >= 50 ? 1900 : 2000;
    at += 2;
    digits = n - 2;
  } else if (lastTag === TAG_GENERALIZED_TIME) {
    if (n !== 14) notDer();
    year = two(der, at) * 100 + two(der, at + 2);
    at += 4;
    digits = 10;
  } else {
    return notDer();
  }
  const month = two(der, at);
  const day = two(der, at + 2);
  const hour = two(der, at + 4);
  const minute = two(der, at + 6);
  const second = digits === 10 ? two(der, at + 8) : 0;
  at += digits;
  let offset = 0;
  if (lastTo - at === 1 && der[at] === 0x5a) {
    // Z
  } else if (lastTo - at === 5 && (der[at] === 0x2b || der[at] === 0x2d)) {
    const hh = two(der, at + 1);
    const mm = two(der, at + 3);
    // An offset of zero is written Z; Go takes up to 24 hours.
    if (hh > 24 || mm > 59 || (hh === 0 && mm === 0)) notDer();
    offset = (hh * 60 + mm) * 60 * (der[at] === 0x2b ? 1 : -1);
  } else {
    notDer();
  }
  const seconds = secondsOfCivil(year, month, day, hour, minute, second);
  if (seconds === undefined) return notDer();
  return seconds - offset;
}

// What the last call of `extensions` found, five numbers per extension:
// where the OID's content starts and ends, whether it is critical (1 or 0),
// and where the content of extnValue starts and ends. One array, emptied
// and filled again by each call, for the same reason as the cursor above;
// `extensionProblem` and `isOid` speak of the extensions of that last call.
let lastExtensions: number[] = [];

/** Reads the `Extensions` that start at `at` into `lastExtensions`, replacing what was there; returns where the next element starts. */
function extensions(der: Uint8Array, at: number, limit: number): number {
  const next = expect(der, at, limit, TAG_SEQUENCE);
  const end = lastTo;
  let p = lastFrom;
  if (p === end) notDer(); // SIZE (1..MAX)
  lastExtensions.length = 0;
  while (p < end) {
    p = expect(der, p, end, TAG_SEQUENCE);
    const extensionEnd = lastTo;
    let q = expect(der, lastFrom, extensionEnd, TAG_OID);
    const [oidFrom, oidTo] = [lastFrom, lastTo];
    checkOid(der, oidFrom, oidTo);
    let critical = 0;
    // An explicit FALSE is not DER, but is accepted, as crl/ does.
    if (peek(der, q, extensionEnd, TAG_BOOLEAN)) {
      q = read(der, q, extensionEnd);
      if (lastTo - lastFrom !== 1 || (der[lastFrom] !== 0x00 && der[lastFrom] !== 0xff)) notDer();
      critical = der[lastFrom] === 0xff ? 1 : 0;
    }
    q = expect(der, q, extensionEnd, TAG_OCTET_STRING);
    if (q !== extensionEnd) notDer();
    lastExtensions.push(oidFrom, oidTo, critical, lastFrom, lastTo);
  }
  return next;
}

/** An OBJECT IDENTIFIER as Go's cryptobyte reads one: not empty, each part in its shortest form and below 2^31. */
function checkOid(der: Uint8Array, start: number, end: number): void {
  if (start === end) notDer();
  for (let p = start; p < end; ) {
    let value = 0;
    for (let i = 0; ; i++) {
      if (p === end || i === 5 || value >= 1 << 24) notDer();
      const b = der[p++]!;
      if (i === 0 && b === 0x80) notDer();
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }
}

const isOid = (der: Uint8Array, i: number, oid: Uint8Array): boolean => equalBytes(der.subarray(lastExtensions[i]!, lastExtensions[i + 1]!), oid);

/**
 * Of the extensions last read: one that appears twice comes before one
 * that is critical. A file may hold a great many extensions, so those that
 * appear twice are found with a set, not by comparing every pair.
 */
function extensionProblem(der: Uint8Array): UnusableReason | undefined {
  const count = lastExtensions.length / 5;
  if (count > 1) {
    const seen = new Set<string>();
    for (let i = 0; i < lastExtensions.length; i += 5) {
      const oid = hexOf(der.subarray(lastExtensions[i]!, lastExtensions[i + 1]!));
      if (seen.has(oid)) return "not_usable_duplicate_extension";
      seen.add(oid);
    }
  }
  for (let i = 0; i < lastExtensions.length; i += 5) if (lastExtensions[i + 2] === 1) return "not_usable_critical_extension";
  return undefined;
}

/**
 * The content of an extnValue as a non-negative INTEGER in DER, in decimal;
 * `undefined` if it is not one. There is no limit to its length, as in
 * crl/: the bytes become a BigInt through their hexadecimal digits, which
 * takes time in proportion to their number (adding them one by one would
 * take the square of it).
 */
function nonNegativeInteger(der: Uint8Array, start: number, end: number): string | undefined {
  try {
    if (expect(der, start, end, TAG_INTEGER) !== end) return undefined;
  } catch {
    return undefined;
  }
  const length = lastTo - lastFrom;
  if (length === 0) return undefined;
  if (length > 1 && ((der[lastFrom] === 0x00 && (der[lastFrom + 1]! & 0x80) === 0) || (der[lastFrom] === 0xff && (der[lastFrom + 1]! & 0x80) !== 0))) return undefined;
  if (der[lastFrom]! & 0x80) return undefined;
  // In pieces, so that no single string of digits is built a character at a time.
  const pieces: string[] = [];
  for (let p = lastFrom; p < lastTo; p += 4096) pieces.push(hexOf(der.subarray(p, Math.min(p + 4096, lastTo))));
  return BigInt(`0x${pieces.join("")}`).toString();
}

/** The bits of a word in the opposite order. */
export function reversed(x: number): number {
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
  x = ((x >>> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
  return ((x >>> 16) | (x << 16)) >>> 0;
}

/**
 * Writes the key of the serial number whose content bytes are
 * `der[from..to)` as key `n` of `words`. Returns false if it gives no key:
 * empty, negative, not in its shortest form, or more than 20 bytes.
 */
function writeKey(der: Uint8Array, from: number, to: number, words: Uint32Array, n: number): boolean {
  const length = to - from;
  if (length === 0 || length > MAX_SERIAL_BYTES || der[from]! & 0x80) return false;
  if (length > 1 && der[from] === 0 && (der[from + 1]! & 0x80) === 0) return false;
  const base = n * KEY_WORDS;
  for (let w = 0; w < KEY_WORDS; w++) {
    // Bits 32w to 32w + 31: the four bytes that end 4w bytes before the end.
    let word = 0;
    for (let b = 0; b < 4; b++) {
      const p = to - 1 - (w * 4 + b);
      if (p >= from) word |= der[p]! << (b * 8);
    }
    words[base + w] = w < 4 ? reversed(word >>> 0) : word >>> 0;
  }
  return true;
}

/**
 * Sorts the first `count` keys of `words` by their place in the tree and
 * leaves out a key that is there twice. Returns `undefined` if two
 * different keys share their lowest 127 bits.
 */
function sortKeys(words: Uint32Array, count: number): TreeKeys | undefined {
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => {
    const x = a * KEY_WORDS;
    const y = b * KEY_WORDS;
    for (let w = 0; w < KEY_WORDS; w++) {
      const d = words[x + w]! - words[y + w]!;
      if (d !== 0) return d;
    }
    return 0;
  });
  const sorted = new Uint32Array(count * KEY_WORDS);
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const x = order[i]! * KEY_WORDS;
    if (kept > 0) {
      const y = (kept - 1) * KEY_WORDS;
      // The lowest 127 bits are the first three words and all but the last bit of the fourth.
      const samePath = words[x] === sorted[y] && words[x + 1] === sorted[y + 1] && words[x + 2] === sorted[y + 2] && words[x + 3]! >>> 1 === sorted[y + 3]! >>> 1;
      if (samePath) {
        if (words[x + 3] === sorted[y + 3] && words[x + 4] === sorted[y + 4]) continue; // the same serial number again: one key
        return undefined;
      }
    }
    sorted.set(words.subarray(x, x + KEY_WORDS), kept * KEY_WORDS);
    kept++;
  }
  return { words: sorted.subarray(0, kept * KEY_WORDS), count: kept };
}

/** Whether `signature` is an RSASSA-PKCS1-v1_5 signature with SHA-256 of `message` under each key, asked in order until one says yes. */
async function signer(issuers: readonly IssuerKey[], signature: Uint8Array, message: Uint8Array): Promise<IssuerName | undefined> {
  for (const issuer of issuers) {
    // As in Go, a signature that is not as long as the modulus verifies under no key.
    if (signature.length !== issuer.bits / 8) continue;
    const key = await importKey(issuer);
    if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, message as BufferSource)) return issuer.name;
  }
  return undefined;
}

const imported = new Map<string, Promise<CryptoKey>>();

function importKey(issuer: IssuerKey): Promise<CryptoKey> {
  let key = imported.get(issuer.modulus);
  if (key === undefined) {
    let binary = "";
    for (const b of bytesOfHex(issuer.modulus)) binary += String.fromCharCode(b);
    const n = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    key = crypto.subtle.importKey("jwk", { kty: "RSA", n, e: "AQAB" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    imported.set(issuer.modulus, key);
  }
  return key;
}

/**
 * Reads one file of the archive under the issuer keys, tried in order.
 * Never throws for what the file holds: a file that is not a CRL at all is
 * a reading with the reason `not_usable_der`.
 */
export async function readCrl(der: Uint8Array, issuers: readonly IssuerKey[]): Promise<CrlReading> {
  let parsed: Parsed;
  try {
    parsed = parse(der);
  } catch (e) {
    if (!(e instanceof NotDer)) throw e;
    return { issuer: NONE, crlNumber: NONE, thisUpdate: NONE, nextUpdate: NONE, crlDate: NONE, entries: 0, reason: "not_usable_der", keys: undefined };
  }
  const issuer = await signer(issuers, parsed.signature, parsed.tbs);
  const reading = {
    issuer: issuer ?? NONE,
    crlNumber: parsed.crlNumber ?? NONE,
    thisUpdate: formatTime(parsed.thisUpdate),
    nextUpdate: parsed.nextUpdate === undefined ? NONE : formatTime(parsed.nextUpdate),
    crlDate: formatDate(parsed.thisUpdate),
    entries: parsed.entries,
  };
  let reason: UnusableReason | undefined;
  let keys: TreeKeys | undefined;
  if (!parsed.algorithmsOk) reason = "not_usable_algorithm";
  else if (issuer === undefined) reason = "not_usable_signature";
  else if (parsed.problem !== undefined) reason = parsed.problem;
  else {
    keys = sortKeys(parsed.keys, parsed.entries);
    if (keys === undefined) reason = "not_usable_collision";
  }
  return { ...reading, reason, keys };
}

interface Parsed {
  /** tbsCertList with its header: what the signature covers. */
  readonly tbs: Uint8Array;
  readonly signature: Uint8Array;
  /** Both AlgorithmIdentifiers are sha256WithRSAEncryption with NULL parameters. */
  readonly algorithmsOk: boolean;
  readonly thisUpdate: number;
  readonly nextUpdate: number | undefined;
  /** `undefined` if there is none or it is not a non-negative INTEGER. */
  readonly crlNumber: string | undefined;
  readonly entries: number;
  /**
   * The first reason after the signature's, in the order of the checks: the
   * CRL's extensions, then entry by entry. Collisions are not looked for here.
   */
  readonly problem: UnusableReason | undefined;
  /** One key per entry, in the file's order; complete only if `problem` is `undefined`. */
  readonly keys: Uint32Array;
}

/** Reads a DER CertificateList (RFC 5280 section 5) strictly; throws NotDer for anything else. */
function parse(der: Uint8Array): Parsed {
  if (expect(der, 0, der.length, TAG_SEQUENCE) !== der.length) notDer();
  const listEnd = lastTo;
  const tbsStart = lastFrom;
  let p = expect(der, tbsStart, listEnd, TAG_SEQUENCE);
  const [tbsFrom, tbsEnd] = [lastFrom, lastTo];
  const outerAlgorithmStart = p;
  p = expect(der, p, listEnd, TAG_SEQUENCE);
  const outerAlgorithmEnd = p;
  p = expect(der, p, listEnd, TAG_BIT_STRING);
  // A signature is whole bytes: no unused bits.
  if (lastTo === lastFrom || der[lastFrom] !== 0 || p !== listEnd) notDer();
  const signature = der.subarray(lastFrom + 1, lastTo);

  p = tbsFrom;
  let version = 1;
  if (peek(der, p, tbsEnd, TAG_INTEGER)) {
    p = read(der, p, tbsEnd);
    if (lastTo - lastFrom !== 1 || der[lastFrom] !== 1) notDer();
    version = 2;
  }
  const innerAlgorithmStart = p;
  p = expect(der, p, tbsEnd, TAG_SEQUENCE);
  const innerAlgorithmEnd = p;
  p = expect(der, p, tbsEnd, TAG_SEQUENCE); // issuer
  p = read(der, p, tbsEnd);
  const thisUpdate = time(der);
  let nextUpdate: number | undefined;
  if (peek(der, p, tbsEnd, TAG_UTC_TIME) || peek(der, p, tbsEnd, TAG_GENERALIZED_TIME)) {
    p = read(der, p, tbsEnd);
    nextUpdate = time(der);
  }

  let entries = 0;
  let keys = new Uint32Array(0);
  let entryProblem: UnusableReason | undefined;
  if (peek(der, p, tbsEnd, TAG_SEQUENCE)) {
    p = read(der, p, tbsEnd);
    const [listFrom, revokedEnd] = [lastFrom, lastTo];
    // Counted first, so that the keys get one array of the right size.
    for (let q = listFrom; q < revokedEnd; q = read(der, q, revokedEnd)) entries++;
    keys = new Uint32Array(entries * KEY_WORDS);
    let n = 0;
    for (let q = listFrom; q < revokedEnd; n++) {
      q = expect(der, q, revokedEnd, TAG_SEQUENCE);
      const entryEnd = lastTo;
      let r = expect(der, lastFrom, entryEnd, TAG_INTEGER);
      const [serialFrom, serialTo] = [lastFrom, lastTo];
      r = read(der, r, entryEnd);
      time(der); // revocationDate
      lastExtensions.length = 0;
      if (peek(der, r, entryEnd, TAG_SEQUENCE)) r = extensions(der, r, entryEnd);
      if (r !== entryEnd) notDer();
      // The first entry with a problem decides; within it, its extensions come before its serial number.
      if (entryProblem === undefined) {
        entryProblem = extensionProblem(der);
        if (!writeKey(der, serialFrom, serialTo, keys, n)) entryProblem ??= "not_usable_serial";
      }
    }
  }

  let problem: UnusableReason | undefined;
  let crlNumber: string | undefined;
  lastExtensions = [];
  if (peek(der, p, tbsEnd, TAG_CONTEXT_0)) {
    if (version !== 2) notDer();
    p = read(der, p, tbsEnd);
    const outerEnd = lastTo;
    if (extensions(der, lastFrom, outerEnd) !== outerEnd) notDer();
    problem = extensionProblem(der);
    for (let i = 0; i < lastExtensions.length; i += 5) {
      // Whichever of the two comes first in the file, as in crl/.
      if (problem === undefined && isOid(der, i, OID_DELTA_CRL_INDICATOR)) problem = "not_usable_delta";
      if (problem === undefined && isOid(der, i, OID_ISSUING_DISTRIBUTION_POINT)) problem = "not_usable_partitioned";
    }
    for (let i = 0; i < lastExtensions.length; i += 5) {
      if (!isOid(der, i, OID_CRL_NUMBER)) continue;
      crlNumber = nonNegativeInteger(der, lastExtensions[i + 3]!, lastExtensions[i + 4]!);
      break;
    }
  }
  if (p !== tbsEnd) notDer();
  if (crlNumber === undefined) problem ??= "not_usable_crl_number";
  problem ??= entryProblem;

  return {
    tbs: der.subarray(tbsStart, tbsEnd),
    signature,
    algorithmsOk: equalBytes(der.subarray(innerAlgorithmStart, innerAlgorithmEnd), SHA256_WITH_RSA_NULL) && equalBytes(der.subarray(outerAlgorithmStart, outerAlgorithmEnd), SHA256_WITH_RSA_NULL),
    thisUpdate,
    nextUpdate,
    crlNumber,
    entries,
    problem,
    keys,
  };
}
