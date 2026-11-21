// The reference: what ADR-0002, 0007..0013 say a card proof must check,
// written out in plain JS from the ADRs and the circuits' documented layout,
// independent of both circuits' code. The fuzzer compares each circuit's
// verdict with this and with the other circuit.
import { bytesToBig, rsaVerify } from "./common.mjs";

export const MAX_TBS_LEN = 1536;
export const MAX_SIGNED_LEN = 1527; // circom: SHA-256-padded TBS must fit 1536 bytes

const h = (s) => Buffer.from(s.replace(/ /g, ""), "hex");
export const VERSION = h("a003020102");
export const SIG_ALG = h("300d06092a864886f70d01010b0500");
export const SPKI_HEAD = h("30820122 300d06092a864886f70d0101010500 0382010f00 3082010a 0282010100");
export const EXPONENT = h("0203010001");
export const AKI_HEAD = h("301f0603551d23041830168014");
export const SKI_HEAD = h("301d0603551d0e04160414");
export const KEY_USAGE = h("300e0603551d0f0101ff0404030207 80");
export const CERT_POLICIES = h("30140603551d20040d300b3009060760867665000303");
export const SDA_HEAD = h("30330603551d09042c302a3015060760867601640201310a06086086760164030101" + "3011060760867601640233" + "31060c04");

if (SPKI_HEAD.length !== 33 || SDA_HEAD.length !== 49 || CERT_POLICIES.length + SDA_HEAD.length !== 71) {
  throw new Error("reference constants");
}

/**
 * Structural walk over `tbs` (exactly the signed bytes). Returns
 * { ok, reason, serial, modulus, at } where `at` maps field names to offsets
 * (for targeted mutation) and `reads` lists every byte position examined.
 */
export function walk(tbs, now) {
  const len = tbs.length;
  const at = {};
  const reads = [];
  const fail = (reason) => ({ ok: false, reason, at, reads });
  const byte = (i) => {
    reads.push(i);
    return i < len ? tbs[i] : undefined;
  };
  const eq = (off, expected, what) => {
    for (let i = 0; i < expected.length; i++) if (byte(off + i) !== expected[i]) return what;
    return null;
  };
  if (len > MAX_SIGNED_LEN) return fail("tbs longer than 1527 bytes");
  if (byte(0) !== 0x30 || byte(1) !== 0x82) return fail("outer header");
  if (len < 4 || tbs[2] * 256 + tbs[3] + 4 !== len) return fail("outer length != signed length");
  at.version = 4;
  let e = eq(4, VERSION, "version");
  if (e) return fail(e);
  at.serial = 9;
  if (byte(9) !== 0x02) return fail("serial tag");
  const sl = byte(10);
  if (sl === undefined || sl < 1 || sl > 20) return fail("serial length");
  for (let i = 0; i < sl; i++) byte(11 + i);
  if (11 + sl > len) return fail("serial past end");
  const serial = bytesToBig(tbs.subarray(11, 11 + sl));
  let p = 11 + sl;
  at.sigAlg = p;
  if ((e = eq(p, SIG_ALG, "signature algorithm"))) return fail(e);
  p += 15;
  at.issuer = p;
  if (byte(p) !== 0x30) return fail("issuer tag");
  const il = byte(p + 1);
  if (il === undefined || il >= 128) return fail("issuer length form");
  p += 2 + il;
  at.validity = p;
  if ((e = eq(p, h("301e170d"), "validity header"))) return fail(e);
  const digits = (off) => {
    let v = 0n;
    for (let i = 0; i < 12; i++) {
      const b = byte(off + i);
      if (b === undefined || b < 0x30 || b > 0x39) return null;
      v = v * 10n + BigInt(b - 0x30);
    }
    if (tbs[off] >= 0x35) return null; // UTCTime YY >= 50 means 19YY
    return v;
  };
  const nb = digits(p + 4);
  if (nb === null) return fail("notBefore digits");
  if ((e = eq(p + 16, h("5a170d"), "notAfter header"))) return fail(e);
  const na = digits(p + 19);
  if (na === null) return fail("notAfter digits");
  if (byte(p + 31) !== 0x5a) return fail("notAfter Z");
  if (now < 0n || now >= 1n << 40n) return fail("current_time over 40 bits");
  if (nb > now) return fail("not yet valid");
  if (now > na) return fail("expired");
  p += 32;
  at.subject = p;
  if (byte(p) !== 0x30) return fail("subject tag");
  const b1 = byte(p + 1);
  const b2 = byte(p + 2);
  if (b1 === undefined) return fail("subject header past end");
  let sublen, hdr;
  if (b1 === 0x81) {
    if (b2 === undefined || b2 < 128) return fail("subject 81 form with length < 128");
    sublen = b2;
    hdr = 3;
  } else if (b1 < 128) {
    sublen = b1;
    hdr = 2;
  } else return fail("subject length form");
  p += hdr + sublen;
  at.spki = p;
  if ((e = eq(p, SPKI_HEAD, "SPKI header"))) return fail(e);
  const mo = p + 33;
  at.modulus = mo;
  for (let i = 0; i < 256; i++) byte(mo + i);
  const modulus = Buffer.from(tbs.subarray(mo, mo + 256));
  const x = mo + 256;
  at.exponent = x;
  if ((e = eq(x, EXPONENT, "exponent"))) return fail(e);
  at.extensions = x + 5;
  if (byte(x + 5) !== 0xa3 || byte(x + 6) !== 0x82) return fail("extensions [3] header");
  if (byte(x + 9) !== 0x30 || byte(x + 10) !== 0x82) return fail("extensions SEQUENCE header");
  at.aki = x + 13;
  if ((e = eq(x + 13, AKI_HEAD, "authorityKeyIdentifier"))) return fail(e);
  at.ski = x + 46;
  if ((e = eq(x + 46, SKI_HEAD, "subjectKeyIdentifier"))) return fail(e);
  at.keyUsage = x + 77;
  if ((e = eq(x + 77, KEY_USAGE, "keyUsage"))) return fail(e);
  at.policies = x + 93;
  if ((e = eq(x + 93, Buffer.concat([CERT_POLICIES, SDA_HEAD]), "policies / subjectDirectoryAttributes"))) return fail(e);
  at.end = x + 168;
  if (x + 168 > len) return fail("walk ends past the signed bytes");
  // ADR-0009: exactly 2048 bits. Both certificate parts check it since the
  // fixes after the review (Noir der.nr, circom certChain.circom). It is the
  // last check here so that `at` and `reads` are what they were before: the
  // generator picks positions from them, and a seed must keep giving the same
  // cases.
  if (modulus[0] < 0x80) return fail("card key shorter than 2048 bits");
  return { ok: true, reason: "ok", serial, modulus, at, reads };
}

export const isScopeKind = (b) => (b >= 0x61 && b <= 0x7a) || b === 0x53;
export const isCodeKind = (b) => b >= 0x41 && b <= 0x5a && b !== 0x53;

/** A modulus as the card proof circuit needs it: exactly 2048 bits. */
export const is2048 = (n) => n.toString(2).length === 2048;

export { rsaVerify };
