// A strict DER reader: definite lengths in their shortest form only, nothing
// past the end of the enclosing element. Enough for certificates and CRLs.

export class DerError extends Error {}

export interface Tlv {
  tag: number;
  /** Offset of the first byte of the element (its tag). */
  start: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** Offset just past the element. */
  end: number;
}

/** Reads the element at `pos`, which must end at or before `limit`. */
export function readTlv(der: Uint8Array, pos: number, limit: number = der.length): Tlv {
  if (pos + 2 > limit) throw new DerError(`truncated element at ${pos}`);
  const tag = der[pos]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError(`multi-byte tag at ${pos}`);
  let len = der[pos + 1]!;
  let contentStart = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new DerError(`indefinite length at ${pos}`);
    if (n > 4) throw new DerError(`length of ${n} bytes at ${pos}`);
    if (contentStart + n > limit) throw new DerError(`truncated length at ${pos}`);
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[contentStart + i]!;
    if (der[contentStart] === 0) throw new DerError(`non-minimal length at ${pos}`);
    if (len < 0x80) throw new DerError(`long form for a short length at ${pos}`);
    contentStart += n;
  }
  const end = contentStart + len;
  if (end > limit) throw new DerError(`element at ${pos} runs past its parent`);
  return { tag, start: pos, contentStart, end };
}

export function expectTlv(der: Uint8Array, pos: number, tag: number, limit: number, what: string): Tlv {
  const t = readTlv(der, pos, limit);
  if (t.tag !== tag) throw new DerError(`${what}: tag 0x${t.tag.toString(16)}, expected 0x${tag.toString(16)}`);
  return t;
}

/**
 * The elements inside a constructed element, one at a time. Nothing is kept
 * of an element once the next is asked for, so an element with any number
 * of elements inside costs no more memory than one with a few: what the CRL
 * reader walks with, since a CRL is as long as the mirror stores and its
 * bytes are anyone's who is on the way (src/crl/crl.ts).
 */
export class Elements {
  readonly #der: Uint8Array;
  #pos: number;
  readonly #end: number;
  #ahead: Tlv | undefined;

  constructor(der: Uint8Array, parent: Tlv) {
    this.#der = der;
    this.#pos = parent.contentStart;
    this.#end = parent.end;
  }

  /** The next element without taking it; `undefined` at the end. Throws DerError if what is there is not an element. */
  peek(): Tlv | undefined {
    if (this.#ahead === undefined && this.#pos < this.#end) this.#ahead = readTlv(this.#der, this.#pos, this.#end);
    return this.#ahead;
  }

  /** Takes the next element; `undefined` at the end. */
  next(): Tlv | undefined {
    const t = this.peek();
    if (t !== undefined) {
      this.#pos = t.end;
      this.#ahead = undefined;
    }
    return t;
  }
}

/**
 * The elements inside a constructed element, in order, all at once: for an
 * element known to be small (a certificate's). A CRL is walked with
 * `Elements`.
 */
export function children(der: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = parent.contentStart; p < parent.end; ) {
    const t = readTlv(der, p, parent.end);
    out.push(t);
    p = t.end;
  }
  return out;
}

export function content(der: Uint8Array, t: Tlv): Uint8Array {
  return der.subarray(t.contentStart, t.end);
}

export function whole(der: Uint8Array, t: Tlv): Uint8Array {
  return der.subarray(t.start, t.end);
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  BMP_STRING: 0x1e,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** The largest number an OID may hold, as written (spec/revocation-tree.md, "Object identifiers"). */
const MAX_OID_NUMBER = 2 ** 31 - 1;

/**
 * Checks an OID's content bytes: not empty, every number in its shortest
 * form and at most 2^31 - 1, the last one complete (spec/revocation-tree.md,
 * "Object identifiers"). Two OIDs that pass are the same OID exactly when
 * their bytes are the same, so a reader that only compares OIDs needs no
 * other form of them, however long they are.
 */
export function checkOid(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new DerError("empty OID");
  let x = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (x === 0 && c === 0x80) throw new DerError("non-minimal OID arc");
    x = x * 128 + (c & 0x7f);
    // Checked at every byte, so `x` stays far below what a number holds exactly.
    if (x > MAX_OID_NUMBER) throw new DerError("an OID number above 2^31 - 1");
    if (!(c & 0x80)) x = 0;
    else if (i === bytes.length - 1) throw new DerError("truncated OID");
  }
}

/**
 * An OID's content bytes in dotted form, checked as `checkOid` checks them.
 * For a short OID: the string is as long as the OID.
 */
export function oidString(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new DerError("empty OID");
  const parts: number[] = [];
  let x = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (x === 0 && c === 0x80) throw new DerError("non-minimal OID arc");
    x = x * 128 + (c & 0x7f);
    // Checked at every byte, so `x` stays far below what a number holds exactly.
    if (x > MAX_OID_NUMBER) throw new DerError("an OID number above 2^31 - 1");
    if (!(c & 0x80)) {
      if (parts.length === 0) {
        const first = x < 40 ? 0 : x < 80 ? 1 : 2;
        parts.push(first, x - 40 * first);
      } else parts.push(x);
      x = 0;
    } else if (i === bytes.length - 1) throw new DerError("truncated OID");
  }
  return parts.join(".");
}

/**
 * UTCTime `YYMMDDHHMMSSZ` (years 50..99 mean 19xx, 00..49 mean 20xx) or
 * GeneralizedTime `YYYYMMDDHHMMSSZ`, of a time that exists, as seconds since
 * the epoch: the spellings of RFC 5280 (spec/revocation-tree.md, "Times").
 */
export function readTime(der: Uint8Array, t: Tlv): number {
  // The length first: a UTCTime is 13 bytes and a GeneralizedTime 15, and a very long content must not be spread into arguments
  // (that throws a RangeError, which is not "this is not DER").
  if (t.end - t.contentStart !== (t.tag === TAG.UTC_TIME ? 13 : 15)) throw new DerError("not a DER time");
  const s = String.fromCharCode(...content(der, t));
  let full: string;
  if (t.tag === TAG.UTC_TIME && /^[0-9]{12}Z$/.test(s)) full = (Number(s.slice(0, 2)) >= 50 ? "19" : "20") + s;
  else if (t.tag === TAG.GENERALIZED_TIME && /^[0-9]{14}Z$/.test(s)) full = s;
  else throw new DerError("not a DER time");
  const [y, mo, d, h, mi, se] = [0, 4, 6, 8, 10, 12].map((i, k) => Number(full.slice(i, i + (k === 0 ? 4 : 2)))) as [
    number, number, number, number, number, number,
  ];
  // Date.UTC reads the years 0 to 99 as 1900 to 1999; setUTCFullYear does not.
  const back = new Date(0);
  back.setUTCFullYear(y, mo - 1, d);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) {
    throw new DerError("no such time");
  }
  return back.getTime() / 1000 + h * 3600 + mi * 60 + se;
}
