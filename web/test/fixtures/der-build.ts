// DER writing for test fixtures (certificates and CRLs made with test keys).
import { bytesOfHex, concatBytes } from "../../src/bytes.ts";

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  let header: number[];
  if (len < 0x80) header = [tag, len];
  else if (len < 0x100) header = [tag, 0x81, len];
  else if (len < 0x10000) header = [tag, 0x82, len >> 8, len & 0xff];
  else header = [tag, 0x83, len >> 16, (len >> 8) & 0xff, len & 0xff];
  return concatBytes(Uint8Array.from(header), content);
}

export const seq = (...parts: Uint8Array[]): Uint8Array => seqOf(parts);

/** A SEQUENCE of many elements (no spread: a CRL has hundreds of thousands). */
export function seqOf(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return tlv(0x30, out);
}
export const hex = (s: string): Uint8Array => bytesOfHex(s.replace(/\s+/g, ""));
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** A non-negative INTEGER in its shortest encoding. */
export function integer(x: bigint): Uint8Array {
  let h = x.toString(16);
  if (h.length % 2) h = "0" + h;
  let b = bytesOfHex(h);
  if (b[0]! & 0x80) b = concatBytes(Uint8Array.of(0), b);
  return tlv(0x02, b);
}

export const SHA256_WITH_RSA = hex("300d06092a864886f70d01010b0500");

/** YYMMDDHHMMSSZ from a Date. */
export function utcTime(d: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, ascii(s));
}

export interface TestKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  modulus: bigint;
  bits: 2048 | 4096;
  spki: Uint8Array;
}

export async function makeKey(bits: 2048 | 4096): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: bits, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const n = Uint8Array.from(atob(jwk.n!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  let modulus = 0n;
  for (const b of n) modulus = (modulus << 8n) | BigInt(b);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, modulus, bits, spki };
}

export async function signWith(key: TestKey, message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, message as BufferSource));
}

/** Certificate or CertificateList: the signed part, the algorithm, the signature. */
export async function signed(tbs: Uint8Array, key: TestKey): Promise<Uint8Array> {
  const sig = await signWith(key, tbs);
  return seq(tbs, SHA256_WITH_RSA, tlv(0x03, concatBytes(Uint8Array.of(0), sig)));
}
