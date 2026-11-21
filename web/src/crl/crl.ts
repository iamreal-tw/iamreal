// Reading MOICA's CRL on the device and deciding whether it is usable
// (spec/revocation-tree.md, "Which CRLs"). Same rules and the same reason
// codes, in the same order, as crl/crl.go; the tests run both against
// crl/testdata/.
import { equalBytes } from "iamreal-protocol/bytes.ts";
import { DerError, TAG, type Tlv, children, content, expectTlv, oidString, readTime, readTlv, whole } from "../der.ts";
import { rsaVerify } from "../issuers.ts";

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

export class Unusable extends Error {
  readonly code: UnusableReason;
  constructor(code: UnusableReason, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

interface Extension {
  oid: string;
  critical: boolean;
  value: Uint8Array;
}

interface Entry {
  /** The serial number's content bytes, as encoded. */
  serial: Uint8Array;
  extensions: Extension[];
}

export interface ParsedCrl {
  tbs: Uint8Array;
  tbsSignatureAlgorithm: Uint8Array;
  signatureAlgorithm: Uint8Array;
  signature: Uint8Array;
  /** thisUpdate, seconds since the epoch. */
  thisUpdate: number;
  entries: Entry[];
  extensions: Extension[];
}

const SHA256_WITH_RSA_NULL = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00]);
const OID_CRL_NUMBER = "2.5.29.20";
const OID_DELTA = "2.5.29.27";
const OID_IDP = "2.5.29.28";
const CTX0 = 0xa0;

function readExtensions(der: Uint8Array, seq: Tlv): Extension[] {
  if (seq.tag !== TAG.SEQUENCE) throw new DerError("Extensions is not a SEQUENCE");
  const exts = children(der, seq);
  if (exts.length === 0) throw new DerError("empty Extensions");
  return exts.map((e) => {
    if (e.tag !== TAG.SEQUENCE) throw new DerError("Extension is not a SEQUENCE");
    const parts = children(der, e);
    const oid = parts[0];
    if (!oid || oid.tag !== TAG.OID) throw new DerError("Extension without OID");
    let i = 1;
    let critical = false;
    if (parts[i]?.tag === TAG.BOOLEAN) {
      const b = content(der, parts[i]!);
      // An explicit FALSE is not DER, but is accepted, as crl/ (and crypto/x509) do.
      if (b.length !== 1 || (b[0] !== 0x00 && b[0] !== 0xff)) throw new DerError("malformed BOOLEAN");
      critical = b[0] === 0xff;
      i++;
    }
    const value = parts[i];
    if (!value || value.tag !== TAG.OCTET_STRING || i + 1 !== parts.length) throw new DerError("malformed Extension");
    return { oid: oidString(content(der, oid)), critical, value: content(der, value) };
  });
}

/** Parses a DER CertificateList strictly (crl.Parse). Throws DerError if it is not one. */
export function parseCrl(der: Uint8Array): ParsedCrl {
  const list = expectTlv(der, 0, TAG.SEQUENCE, der.length, "CertificateList");
  if (list.end !== der.length) throw new DerError("bytes after the CertificateList");
  const [tbsT, algT, sigT, ...more] = children(der, list);
  if (!tbsT || !algT || !sigT || more.length) throw new DerError("CertificateList is not three elements");
  if (tbsT.tag !== TAG.SEQUENCE || algT.tag !== TAG.SEQUENCE || sigT.tag !== TAG.BIT_STRING) throw new DerError("CertificateList fields");
  const bits = content(der, sigT);
  if (bits.length < 1 || bits[0] !== 0) throw new DerError("signatureValue has unused bits");

  const f = children(der, tbsT);
  let i = 0;
  let version = 1;
  if (f[i]?.tag === TAG.INTEGER) {
    const v = content(der, f[i]!);
    if (v.length !== 1 || v[0] !== 1) throw new DerError("version is present and not v2");
    version = 2;
    i++;
  }
  const tbsAlg = f[i++];
  if (!tbsAlg || tbsAlg.tag !== TAG.SEQUENCE) throw new DerError("signature in tbsCertList");
  const issuer = f[i++];
  if (!issuer || issuer.tag !== TAG.SEQUENCE) throw new DerError("issuer");
  const thisUpdateT = f[i++];
  if (!thisUpdateT) throw new DerError("no thisUpdate");
  const thisUpdate = readTime(der, thisUpdateT);
  if (f[i] && (f[i]!.tag === TAG.UTC_TIME || f[i]!.tag === TAG.GENERALIZED_TIME)) readTime(der, f[i++]!);
  const entries: Entry[] = [];
  if (f[i]?.tag === TAG.SEQUENCE) {
    for (const e of children(der, f[i++]!)) {
      if (e.tag !== TAG.SEQUENCE) throw new DerError("entry is not a SEQUENCE");
      const ef = children(der, e);
      const serial = ef[0];
      if (!serial || serial.tag !== TAG.INTEGER) throw new DerError("userCertificate is not an INTEGER");
      if (!ef[1]) throw new DerError("no revocationDate");
      readTime(der, ef[1]);
      let extensions: Extension[] = [];
      if (ef[2]) extensions = readExtensions(der, ef[2]);
      if (ef.length > 3) throw new DerError("unexpected data in entry");
      entries.push({ serial: content(der, serial), extensions });
    }
  }
  let extensions: Extension[] = [];
  if (f[i]?.tag === CTX0) {
    if (version !== 2) throw new DerError("crlExtensions in a v1 CRL");
    const outer = f[i++]!;
    const inner = children(der, outer);
    if (inner.length !== 1) throw new DerError("trailing data in crlExtensions");
    extensions = readExtensions(der, inner[0]!);
  }
  if (i !== f.length) throw new DerError("unexpected data in tbsCertList");
  return {
    tbs: whole(der, tbsT),
    tbsSignatureAlgorithm: whole(der, tbsAlg),
    signatureAlgorithm: whole(der, algT),
    signature: bits.subarray(1),
    thisUpdate,
    entries,
    extensions,
  };
}

function checkExtensions(exts: Extension[], where: string): void {
  for (let i = 0; i < exts.length; i++) {
    for (let j = 0; j < i; j++) {
      if (exts[i]!.oid === exts[j]!.oid) throw new Unusable("not_usable_duplicate_extension", `${where}: ${exts[i]!.oid} twice`);
    }
  }
  for (const x of exts) {
    if (x.critical) throw new Unusable("not_usable_critical_extension", `${where}: critical ${x.oid}`);
  }
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
  checkExtensions(c.extensions, "CRL");
  for (const x of c.extensions) {
    if (x.oid === OID_DELTA) throw new Unusable("not_usable_delta", "delta CRL");
    if (x.oid === OID_IDP) throw new Unusable("not_usable_partitioned", "partitioned CRL");
  }
  const numberExt = c.extensions.find((x) => x.oid === OID_CRL_NUMBER);
  if (!numberExt) throw new Unusable("not_usable_crl_number", "no cRLNumber");
  const crlNumber = readCrlNumber(numberExt.value);
  if (crlNumber === null) throw new Unusable("not_usable_crl_number", "malformed cRLNumber, or longer than 20 bytes");

  const keys = new Uint32Array(c.entries.length * KEY_WORDS);
  let count = 0;
  const seen = new Set<string>();
  const low127 = new Map<string, number>();
  const firstEntry: number[] = [];
  for (let i = 0; i < c.entries.length; i++) {
    const e = c.entries[i]!;
    checkExtensions(e.extensions, `entry ${i}`);
    const k = keyFromSerial(e.serial);
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
