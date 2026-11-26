// Reading MOICA's CRL on the device and deciding whether it is usable
// (spec/revocation-tree.md, "Which CRLs"). Same rules and the same reason
// codes, in the same order, as crl/crl.go; the tests run both against
// crl/testdata/.
import { equalBytes } from "iamreal-protocol/bytes.ts";
import { DerError, Elements, TAG, type Tlv, checkOid, content, expectTlv, readTime, readTlv, whole } from "../der.ts";
import { rsaVerify } from "../issuers.ts";

export type UnusableReason =
  | "not_usable_der"
  | "not_usable_algorithm"
  | "not_usable_signature"
  | "not_usable_too_many_extensions"
  | "not_usable_duplicate_extension"
  | "not_usable_critical_extension"
  | "not_usable_delta"
  | "not_usable_partitioned"
  | "not_usable_crl_number"
  | "not_usable_serial"
  | "not_usable_collision";

export class Unusable extends Error {
  readonly code: UnusableReason;
  constructor(code: UnusableReason, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

interface Extension {
  /** The OID's content bytes, checked (src/der.ts, `checkOid`): the same OID exactly when the same bytes. */
  oid: Uint8Array;
  critical: boolean;
  value: Uint8Array;
}

/** What is wrong with the extensions of one entry: the first reason that applies to it. */
interface EntryProblem {
  /** Which entry, counted from 0. */
  index: number;
  code: UnusableReason;
  detail: string;
}

/**
 * A CertificateList, as far as the checks read it. Nothing here grows with
 * what an element holds but `serials`, eight bytes an entry: the file is as
 * long as the mirror stores (32 MiB), and before its signature is checked
 * its bytes are anyone's who is on the way (README.md, "讀清冊的記憶體").
 */
export interface ParsedCrl {
  /** The whole file: `serials` points into it. */
  der: Uint8Array;
  tbs: Uint8Array;
  tbsSignatureAlgorithm: Uint8Array;
  signatureAlgorithm: Uint8Array;
  signature: Uint8Array;
  /** thisUpdate, seconds since the epoch. */
  thisUpdate: number;
  /** How many entries `revokedCertificates` has. */
  entryCount: number;
  /** Where each entry's serial number is in `der`: the offsets of its first content byte and just past its last, two numbers an entry. */
  serials: Uint32Array;
  /** The first entry whose extensions make the CRL not usable, if any; of the later entries nothing is kept. */
  entryProblem: EntryProblem | undefined;
  /** The extensions of the CRL: at most MAX_EXTENSIONS + 1 of them. */
  extensions: Extension[];
}

const SHA256_WITH_RSA_NULL = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00]);
/** cRLNumber 2.5.29.20, deltaCRLIndicator 2.5.29.27, issuingDistributionPoint 2.5.29.28: the content bytes. */
const OID_CRL_NUMBER = Uint8Array.from([0x55, 0x1d, 0x14]);
const OID_DELTA = Uint8Array.from([0x55, 0x1d, 0x1b]);
const OID_IDP = Uint8Array.from([0x55, 0x1d, 0x1c]);
const CTX0 = 0xa0;

/** The most extensions the CRL, and each entry, may have (spec/revocation-tree.md, "Which CRLs"). */
export const MAX_EXTENSIONS = 16;

/**
 * Reads `Extensions`. Every extension is read, so that one that is not DER
 * makes the file not DER, but only the first MAX_EXTENSIONS + 1 are kept:
 * enough to tell there are too many.
 */
function readExtensions(der: Uint8Array, seq: Tlv): Extension[] {
  if (seq.tag !== TAG.SEQUENCE) throw new DerError("Extensions is not a SEQUENCE");
  if (seq.contentStart === seq.end) throw new DerError("empty Extensions");
  const out: Extension[] = [];
  const all = new Elements(der, seq);
  for (let e = all.next(); e !== undefined; e = all.next()) {
    if (e.tag !== TAG.SEQUENCE) throw new DerError("Extension is not a SEQUENCE");
    const parts = new Elements(der, e);
    const oid = parts.next();
    if (!oid || oid.tag !== TAG.OID) throw new DerError("Extension without OID");
    checkOid(content(der, oid));
    let critical = false;
    if (parts.peek()?.tag === TAG.BOOLEAN) {
      const b = content(der, parts.next()!);
      // An explicit FALSE is not DER, but is accepted, as crl/ (and crypto/x509) do.
      if (b.length !== 1 || (b[0] !== 0x00 && b[0] !== 0xff)) throw new DerError("malformed BOOLEAN");
      critical = b[0] === 0xff;
    }
    const value = parts.next();
    // Nothing after the value: found at the element after it, without walking the rest.
    if (!value || value.tag !== TAG.OCTET_STRING || value.end !== e.end) throw new DerError("malformed Extension");
    if (out.length <= MAX_EXTENSIONS) out.push({ oid: content(der, oid), critical, value: content(der, value) });
  }
  return out;
}

/** Parses a DER CertificateList strictly (crl.Parse). Throws DerError if it is not one. */
export function parseCrl(der: Uint8Array): ParsedCrl {
  const list = expectTlv(der, 0, TAG.SEQUENCE, der.length, "CertificateList");
  if (list.end !== der.length) throw new DerError("bytes after the CertificateList");
  const three = new Elements(der, list);
  const tbsT = three.next();
  const algT = three.next();
  const sigT = three.next();
  if (!tbsT || !algT || !sigT || sigT.end !== list.end) throw new DerError("CertificateList is not three elements");
  if (tbsT.tag !== TAG.SEQUENCE || algT.tag !== TAG.SEQUENCE || sigT.tag !== TAG.BIT_STRING) throw new DerError("CertificateList fields");
  const bits = content(der, sigT);
  if (bits.length < 1 || bits[0] !== 0) throw new DerError("signatureValue has unused bits");

  const f = new Elements(der, tbsT);
  let version = 1;
  if (f.peek()?.tag === TAG.INTEGER) {
    const v = content(der, f.next()!);
    if (v.length !== 1 || v[0] !== 1) throw new DerError("version is present and not v2");
    version = 2;
  }
  const tbsAlg = f.next();
  if (!tbsAlg || tbsAlg.tag !== TAG.SEQUENCE) throw new DerError("signature in tbsCertList");
  const issuer = f.next();
  if (!issuer || issuer.tag !== TAG.SEQUENCE) throw new DerError("issuer");
  const thisUpdateT = f.next();
  if (!thisUpdateT) throw new DerError("no thisUpdate");
  const thisUpdate = readTime(der, thisUpdateT);
  const afterThis = f.peek();
  if (afterThis && (afterThis.tag === TAG.UTC_TIME || afterThis.tag === TAG.GENERALIZED_TIME)) readTime(der, f.next()!);

  // Two numbers an entry, in an array that doubles when it is full.
  let serials = new Uint32Array(2 * 1024);
  let entryCount = 0;
  let entryProblem: EntryProblem | undefined;
  if (f.peek()?.tag === TAG.SEQUENCE) {
    const entries = new Elements(der, f.next()!);
    for (let e = entries.next(); e !== undefined; e = entries.next()) {
      if (e.tag !== TAG.SEQUENCE) throw new DerError("entry is not a SEQUENCE");
      const ef = new Elements(der, e);
      const serial = ef.next();
      if (!serial || serial.tag !== TAG.INTEGER) throw new DerError("userCertificate is not an INTEGER");
      const revocationDate = ef.next();
      if (!revocationDate) throw new DerError("no revocationDate");
      readTime(der, revocationDate);
      const extensionsT = ef.next();
      if (extensionsT) {
        // Nothing after the extensions: found here, without walking the rest.
        if (extensionsT.end !== e.end) throw new DerError("unexpected data in entry");
        const problem = extensionProblem(readExtensions(der, extensionsT));
        if (problem && !entryProblem) entryProblem = { index: entryCount, code: problem.code, detail: `entry ${entryCount}: ${problem.detail}` };
      }
      if (2 * entryCount === serials.length) {
        const longer = new Uint32Array(2 * serials.length);
        longer.set(serials);
        serials = longer;
      }
      serials[2 * entryCount] = serial.contentStart;
      serials[2 * entryCount + 1] = serial.end;
      entryCount++;
    }
  }
  let extensions: Extension[] = [];
  if (f.peek()?.tag === CTX0) {
    if (version !== 2) throw new DerError("crlExtensions in a v1 CRL");
    const outer = f.next()!;
    const inner = new Elements(der, outer).next();
    if (!inner || inner.end !== outer.end) throw new DerError("trailing data in crlExtensions");
    extensions = readExtensions(der, inner);
  }
  if (f.peek() !== undefined) throw new DerError("unexpected data in tbsCertList");
  return {
    der,
    tbs: whole(der, tbsT),
    tbsSignatureAlgorithm: whole(der, tbsAlg),
    signatureAlgorithm: whole(der, algT),
    signature: bits.subarray(1),
    thisUpdate,
    entryCount,
    serials,
    entryProblem,
    extensions,
  };
}

const hex = (bytes: Uint8Array): string => Array.from(bytes.subarray(0, 32), (b) => b.toString(16).padStart(2, "0")).join("") + (bytes.length > 32 ? "…" : "");

/** Of at most MAX_EXTENSIONS + 1 extensions: too many, then one twice, then a critical one; or nothing. */
function extensionProblem(exts: Extension[]): { code: UnusableReason; detail: string } | undefined {
  if (exts.length > MAX_EXTENSIONS) return { code: "not_usable_too_many_extensions", detail: `more than ${MAX_EXTENSIONS} extensions` };
  for (let i = 0; i < exts.length; i++) {
    for (let j = 0; j < i; j++) {
      if (equalBytes(exts[i]!.oid, exts[j]!.oid)) return { code: "not_usable_duplicate_extension", detail: `the extension ${hex(exts[i]!.oid)} twice` };
    }
  }
  for (const x of exts) {
    if (x.critical) return { code: "not_usable_critical_extension", detail: `critical extension ${hex(x.oid)}` };
  }
  return undefined;
}

/** The most content bytes a cRLNumber may have, a leading 00 included (RFC 5280 section 5.2.3). */
export const MAX_CRL_NUMBER_BYTES = 20;

/**
 * A cRLNumber: a non-negative DER INTEGER (minimal encoding) of at most
 * MAX_CRL_NUMBER_BYTES content bytes, as a bigint, or null.
 */
function readCrlNumber(value: Uint8Array): bigint | null {
  try {
    const t = readTlv(value, 0);
    if (t.tag !== TAG.INTEGER || t.end !== value.length) return null;
    const c = content(value, t);
    if (c.length === 0 || c.length > MAX_CRL_NUMBER_BYTES) return null;
    if (c.length > 1 && ((c[0] === 0 && !(c[1]! & 0x80)) || (c[0] === 0xff && c[1]! & 0x80))) return null;
    if (c[0]! & 0x80) return null; // negative
    let x = 0n;
    for (const b of c) x = (x << 8n) | BigInt(b);
    return x;
  } catch {
    return null;
  }
}

/** Number of 32-bit words per tree key: 160 bits, little-endian words. */
export const KEY_WORDS = 5;
export const MAX_SERIAL_BYTES = 20;

/** The key of a serial number (its content bytes read unsigned), or why it gives none. */
export function keyFromSerial(c: Uint8Array): Uint32Array | string {
  if (c.length === 0) return "empty serial number";
  if (c.length > MAX_SERIAL_BYTES) return `serial number of ${c.length} bytes`;
  if (c[0]! & 0x80) return "negative serial number";
  if (c.length > 1 && c[0] === 0 && !(c[1]! & 0x80)) return "serial number not minimally encoded";
  const words = new Uint32Array(KEY_WORDS);
  for (let i = c.length - 1, bit = 0; i >= 0; i--, bit += 8) words[bit >>> 5]! |= c[i]! << (bit & 31);
  return words;
}

export interface UsableCrl {
  crlNumber: bigint;
  /** thisUpdate, seconds since the epoch. */
  thisUpdate: number;
  /** The keys, KEY_WORDS words each, one per distinct serial number, in order of first appearance. */
  keys: Uint32Array;
  count: number;
}

/**
 * crl.Check: whether the CRL is usable under `issuerKey` (WebCrypto key of
 * `bits` bits), and its keys. Throws Unusable with the first reason code.
 */
export async function checkCrl(c: ParsedCrl, issuerKey: CryptoKey, bits: number): Promise<UsableCrl> {
  if (!equalBytes(c.tbsSignatureAlgorithm, SHA256_WITH_RSA_NULL) || !equalBytes(c.signatureAlgorithm, SHA256_WITH_RSA_NULL)) {
    throw new Unusable("not_usable_algorithm", "signature algorithm is not sha256WithRSAEncryption with NULL parameters");
  }
  if (!(await rsaVerify(issuerKey, bits, c.signature, c.tbs))) {
    throw new Unusable("not_usable_signature", "the signature does not verify under the issuer key");
  }
  const problem = extensionProblem(c.extensions);
  if (problem) throw new Unusable(problem.code, `CRL: ${problem.detail}`);
  for (const x of c.extensions) {
    if (equalBytes(x.oid, OID_DELTA)) throw new Unusable("not_usable_delta", "delta CRL");
    if (equalBytes(x.oid, OID_IDP)) throw new Unusable("not_usable_partitioned", "partitioned CRL");
  }
  const numberExt = c.extensions.find((x) => equalBytes(x.oid, OID_CRL_NUMBER));
  if (!numberExt) throw new Unusable("not_usable_crl_number", "no cRLNumber");
  const crlNumber = readCrlNumber(numberExt.value);
  if (crlNumber === null) throw new Unusable("not_usable_crl_number", "malformed cRLNumber, or longer than 20 bytes");

  // From here on the bytes are MOICA's: the signature verified. What follows may cost what a CRL MOICA signs costs.
  const keys = new Uint32Array(c.entryCount * KEY_WORDS);
  let count = 0;
  const seen = new Set<string>();
  const low127 = new Map<string, number>();
  const firstEntry: number[] = [];
  for (let i = 0; i < c.entryCount; i++) {
    // Entries in order: the first with a problem decides, its extensions before its serial number.
    if (c.entryProblem?.index === i) throw new Unusable(c.entryProblem.code, c.entryProblem.detail);
    const k = keyFromSerial(c.der.subarray(c.serials[2 * i]!, c.serials[2 * i + 1]!));
    if (typeof k === "string") throw new Unusable("not_usable_serial", `entry ${i}: ${k}`);
    const full = Array.from(k).join(",");
    if (seen.has(full)) continue; // the same serial number again: one key
    seen.add(full);
    keys.set(k, count * KEY_WORDS);
    firstEntry.push(i);
    count++;
  }
  for (let n = 0; n < count; n++) {
    const w = keys.subarray(n * KEY_WORDS, n * KEY_WORDS + 4);
    const id = `${w[0]},${w[1]},${w[2]},${w[3]! & 0x7fffffff}`;
    const other = low127.get(id);
    if (other !== undefined) {
      throw new Unusable("not_usable_collision", `entries ${firstEntry[other]} and ${firstEntry[n]} share their lowest 127 bits`);
    }
    low127.set(id, n);
  }
  return { crlNumber, thisUpdate: c.thisUpdate, keys: keys.slice(0, count * KEY_WORDS), count };
}

/** Parse and check in one step; a file that is not DER is `not_usable_der`. */
export async function usableCrl(der: Uint8Array, issuerKey: CryptoKey, bits: number): Promise<UsableCrl> {
  let parsed: ParsedCrl;
  try {
    parsed = parseCrl(der);
  } catch (e) {
    if (e instanceof DerError) throw new Unusable("not_usable_der", e.message);
    throw e;
  }
  return checkCrl(parsed, issuerKey, bits);
}

/** Key `n` as a bigint. */
export function keyAt(keys: Uint32Array, n: number): bigint {
  let x = 0n;
  for (let w = KEY_WORDS - 1; w >= 0; w--) x = (x << 32n) | BigInt(keys[n * KEY_WORDS + w]!);
  return x;
}

/** A bigint below 2^160 as KEY_WORDS words. */
export function wordsOfKey(k: bigint): Uint32Array {
  if (k < 0n || k >> 160n !== 0n) throw new Error("key is not below 2^160");
  const out = new Uint32Array(KEY_WORDS);
  for (let w = 0; w < KEY_WORDS; w++) out[w] = Number((k >> BigInt(32 * w)) & 0xffffffffn);
  return out;
}
