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

/** The elements inside a constructed element, in order. */
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

/** An OID's content bytes in dotted form. */
export function oidString(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new DerError("empty OID");
  const parts: number[] = [];
  let x = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (x === 0 && c === 0x80) throw new DerError("non-minimal OID arc");
    x = x * 128 + (c & 0x7f);
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
 * UTCTime `YYMMDDHHMMSSZ` (years 50..99 mean 19xx) or GeneralizedTime
 * `YYYYMMDDHHMMSSZ`, as seconds since the epoch.
 */
export function readTime(der: Uint8Array, t: Tlv): number {
  const s = String.fromCharCode(...content(der, t));
  let full: string;
  if (t.tag === TAG.UTC_TIME && /^[0-9]{12}Z$/.test(s)) full = (Number(s.slice(0, 2)) >= 50 ? "19" : "20") + s;
  else if (t.tag === TAG.GENERALIZED_TIME && /^[0-9]{14}Z$/.test(s)) full = s;
  else throw new DerError("not a DER time");
  const [y, mo, d, h, mi, se] = [0, 4, 6, 8, 10, 12].map((i, k) => Number(full.slice(i, i + (k === 0 ? 4 : 2)))) as [
    number, number, number, number, number, number,
  ];
  const ms = Date.UTC(y, mo - 1, d, h, mi, se);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) {
    throw new DerError("no such time");
  }
  return ms / 1000;
}
