// Certificates in the layout of a MOICA citizen's primary-card certificate,
// issued by a throwaway test key. Ported from circuits/tests/lib/cert.mjs at
// the repository's root (itself from PSE's testCert.ts), so the bytes the
// circuit sees have the same structure as in the circuit's own tests. No
// real certificate is involved.
import { concatBytes } from "iamreal-protocol/bytes.ts";
import { type TestKey, ascii, hex, seq, signed, tlv, utf8 } from "./der-build.ts";

function rdn(oid: number[], stringTag: number, value: string): Uint8Array {
  return tlv(0x31, seq(tlv(0x06, Uint8Array.from(oid)), tlv(stringTag, utf8(value))));
}

/** Name with C=TW, one filler OU per entry of `ouLengths`, and a CN. */
export function name(commonName: string, ouLengths: number[] = []): Uint8Array {
  const parts = [rdn([0x55, 0x04, 0x06], 0x13, "TW")];
  for (const len of ouLengths) parts.push(rdn([0x55, 0x04, 0x0b], 0x0c, "x".repeat(len)));
  parts.push(rdn([0x55, 0x04, 0x03], 0x0c, commonName));
  return seq(...parts);
}

const time = (v: string): Uint8Array => tlv(v.length === 13 ? 0x17 : 0x18, ascii(v));

export const AUTHORITY_KEY_ID = concatBytes(hex("301f0603551d23041830168014"), new Uint8Array(20).fill(0xa1));
export const SUBJECT_KEY_ID = concatBytes(hex("301d0603551d0e04160414"), new Uint8Array(20).fill(0xb2));
export const keyUsage = (bits: string): Uint8Array => seq(hex("0603551d0f0101ff"), tlv(0x04, tlv(0x03, hex(bits))));
export const KEY_USAGE_SIGNING = keyUsage("0780");
export const KEY_USAGE_ENCRYPTION = keyUsage("0430");
export const CERT_POLICIES = hex("30140603551d20040d300b3009060760867665000303");

function subjectType(kind: number): Uint8Array {
  return concatBytes(hex("3015060760867601640201310a060860867601640301"), Uint8Array.of(kind));
}

export function cardHolderRank(value: string): Uint8Array {
  return seq(hex("060760867601640202"), tlv(0x31, tlv(0x13, ascii(value))));
}

export function subjectDirectoryAttributes(opts: { tail?: string; extra?: Uint8Array[]; subjectKind?: number } = {}): Uint8Array {
  const tailAttr = seq(hex("060760867601640233"), tlv(0x31, tlv(0x0c, utf8(opts.tail ?? "1234"))));
  return seq(hex("0603551d09"), tlv(0x04, seq(subjectType(opts.subjectKind ?? 0x01), tailAttr, ...(opts.extra ?? []))));
}

const opaqueExtension = (value: Uint8Array): Uint8Array => seq(hex("06092b06010401868d1f01"), tlv(0x04, value));

export const DEFAULT_SERIAL = hex("1234567890abcdef1234567890abcdef");

export interface TbsOptions {
  spki: Uint8Array;
  serial?: Uint8Array;
  issuer?: Uint8Array;
  notBefore?: string;
  notAfter?: string;
  subject?: Uint8Array;
  leadingExtensions?: Uint8Array[];
  holderExtensions?: Uint8Array[];
}

export function buildTbs(o: TbsOptions): Uint8Array {
  return seq(
    hex("a003020102"),
    tlv(0x02, o.serial ?? DEFAULT_SERIAL),
    hex("300d06092a864886f70d01010b0500"),
    o.issuer ?? name("Test CA"),
    seq(time(o.notBefore ?? "260101000000Z"), time(o.notAfter ?? "310101155959Z")),
    o.subject ?? name("測試用戶"),
    o.spki,
    tlv(
      0xa3,
      seq(
        ...(o.leadingExtensions ?? [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_SIGNING]),
        ...(o.holderExtensions ?? [CERT_POLICIES, subjectDirectoryAttributes()]),
        // MOICA certificates carry several hundred more bytes of extensions.
        opaqueExtension(new Uint8Array(200).fill(0xcc)),
      ),
    ),
  );
}

/** A whole certificate: `tbs` signed by `issuer`. */
export function certificate(tbs: Uint8Array, issuer: TestKey): Promise<Uint8Array> {
  return signed(tbs, issuer);
}
