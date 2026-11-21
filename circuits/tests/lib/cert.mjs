// Builds synthetic TBSCertificates signed by a throwaway test CA, so tests can
// vary one DER field at a time. No real certificate is involved.
//
// Ported from wallet-unit-poc/circom/tests/common/testCert.ts of PSE zkID
// (https://github.com/iamreal-tw/zkID at the commit in circuits/zkid-commit;
// MIT License, Copyright (c) 2026 Ethereum Foundation), so that the circom
// circuit and the Noir circuits are tested against the same bytes.
import { constants, createHash, generateKeyPairSync, sign } from "node:crypto";

export function tlv(tag, content) {
  const len = content.length;
  let header;
  if (len < 0x80) header = [tag, len];
  else if (len < 0x100) header = [tag, 0x81, len];
  else header = [tag, 0x82, len >> 8, len & 0xff];
  return Buffer.concat([Buffer.from(header), content]);
}

const hex = (s) => Buffer.from(s.replace(/ /g, ""), "hex");

const OID_OU = [0x55, 0x04, 0x0b];
const OID_CN = [0x55, 0x04, 0x03];
const OID_C = [0x55, 0x04, 0x06];

function rdn(oid, stringTag, value) {
  return tlv(
    0x31,
    tlv(0x30, Buffer.concat([tlv(0x06, Buffer.from(oid)), tlv(stringTag, Buffer.from(value, "utf8"))])),
  );
}

/** Name with C=TW, one filler OU per entry of `ouLengths` (bytes), and a CN. */
export function name(commonName, ouLengths = []) {
  const parts = [rdn(OID_C, 0x13, "TW")];
  for (const length of ouLengths) parts.push(rdn(OID_OU, 0x0c, "x".repeat(length)));
  parts.push(rdn(OID_CN, 0x0c, commonName));
  return tlv(0x30, Buffer.concat(parts));
}

/** Subject Name whose content is exactly `contentLength` bytes. */
export function subjectOfLength(contentLength) {
  // C (13) + CN (11 + 9) = 33 fixed; an OU of n bytes costs 11 + n.
  const ouLengths = [];
  let left = contentLength - 33;
  while (left > 0) {
    let cost = Math.min(left, 71);
    if (left - cost > 0 && left - cost < 12) cost = left - 12;
    ouLengths.push(cost - 11);
    left -= cost;
  }
  const subject = name("Test User", ouLengths);
  const headerLength = contentLength < 128 ? 2 : contentLength < 256 ? 3 : 4;
  if (subject.length !== headerLength + contentLength) throw new Error("subject length");
  return subject;
}

/** 13 chars (`YYMMDDHHMMSSZ`) encode as UTCTime, 15 as GeneralizedTime. */
function time(value) {
  return tlv(value.length === 13 ? 0x17 : 0x18, Buffer.from(value, "ascii"));
}

const SIG_ALG_SHA256_RSA = hex("300d06092a864886f70d01010b0500");

// The first five extensions of a MOICA end-entity certificate, in MOICA's
// order: authorityKeyIdentifier (keyIdentifier only), subjectKeyIdentifier,
// keyUsage (critical), certificatePolicies, subjectDirectoryAttributes.
export const AUTHORITY_KEY_ID = Buffer.concat([hex("301f0603551d23041830168014"), Buffer.alloc(20, 0xa1)]);
export const SUBJECT_KEY_ID = Buffer.concat([hex("301d0603551d0e04160414"), Buffer.alloc(20, 0xb2)]);

/** keyUsage extension (critical) with the given BIT STRING bytes. */
export function keyUsage(bits) {
  return tlv(0x30, Buffer.concat([hex("0603551d0f0101ff"), tlv(0x04, tlv(0x03, hex(bits)))]));
}

/** `07 80`: digitalSignature only. */
export const KEY_USAGE_SIGNING = keyUsage("0780");
/** `04 30`: keyEncipherment + dataEncipherment. */
export const KEY_USAGE_ENCRYPTION = keyUsage("0430");

/** certificatePolicies with the policy 2.16.886.101.0.3.3. */
export const CERT_POLICIES = hex("30140603551d20040d300b3009060760867665000303");

/** subjectType attribute; the last value byte is 01 (citizen) or 09 (alien resident). */
function subjectType(kind) {
  return Buffer.concat([hex("3015060760867601640201310a060860867601640301"), Buffer.from([kind])]);
}

/** cardHolderRank (2.16.886.1.100.2.2) with a PrintableString. */
export function cardHolderRank(value) {
  return tlv(0x30, Buffer.concat([hex("060760867601640202"), tlv(0x31, tlv(0x13, Buffer.from(value, "ascii")))]));
}

export function subjectDirectoryAttributes(tail = "1234", extraAttributes = [], tailFirst = false, subjectKind = 0x01) {
  const tailAttr = tlv(
    0x30,
    Buffer.concat([hex("060760867601640233"), tlv(0x31, tlv(0x0c, Buffer.from(tail, "utf8")))]),
  );
  const attrs = tailFirst ? [tailAttr, subjectType(subjectKind)] : [subjectType(subjectKind), tailAttr];
  return tlv(
    0x30,
    Buffer.concat([hex("0603551d09"), tlv(0x04, tlv(0x30, Buffer.concat([...attrs, ...extraAttributes])))]),
  );
}

export const SUBJECT_DIR_ATTRS = subjectDirectoryAttributes();

/** An extension with a private-arc OID wrapping `value` in its OCTET STRING. */
export function opaqueExtension(value) {
  return tlv(0x30, Buffer.concat([hex("06092b06010401868d1f01"), tlv(0x04, value)]));
}

export function makeKey(modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength, publicExponent: 65537 });
  const modulus = BigInt("0x" + Buffer.from(publicKey.export({ format: "jwk" }).n, "base64url").toString("hex"));
  return { privateKey, modulus, bits: modulusLength, spki: publicKey.export({ format: "der", type: "spki" }) };
}

/**
 * SubjectPublicKeyInfo in the layout of a 2048-bit RSA key (exponent 65537)
 * around the modulus `modulus`, written into 256 bytes. For a shorter key this
 * is not the DER a library would write (the INTEGER is not minimal), but it is
 * what the pinned header `02 82 01 01 00` alone would let through.
 */
export function spkiOfModulus(modulus) {
  const bytes = Buffer.from(modulus.toString(16).padStart(512, "0"), "hex");
  if (bytes.length !== 256) throw new Error("modulus longer than 256 bytes");
  return Buffer.concat([hex("30820122300d06092a864886f70d01010105000382010f003082010a0282010100"), bytes, hex("0203010001")]);
}

/** RSASSA-PKCS1-v1_5 / SHA-256 signature as an integer. */
export function signWith(key, message) {
  const signature = sign("sha256", message, { key: key.privateKey, padding: constants.RSA_PKCS1_PADDING });
  return BigInt("0x" + signature.toString("hex"));
}

export const DEFAULT_SERIAL = hex("1234567890abcdef1234567890abcdef");

/**
 * opts: version (default true), serial, issuer, notBefore, notAfter, subject,
 * spki (required), leadingExtensions (default AKI, SKI, keyUsage signing),
 * holderExtensions (default policies, SDA), extraExtensions (appended).
 */
export function buildTbs(opts) {
  const parts = [];
  if (opts.version !== false) parts.push(hex("a003020102"));
  parts.push(
    tlv(0x02, opts.serial ?? DEFAULT_SERIAL),
    SIG_ALG_SHA256_RSA,
    opts.issuer ?? name("Test CA"),
    tlv(0x30, Buffer.concat([time(opts.notBefore ?? "260101000000Z"), time(opts.notAfter ?? "310101155959Z")])),
    opts.subject ?? name("Test User"),
    opts.spki,
    tlv(
      0xa3,
      tlv(
        0x30,
        Buffer.concat([
          ...(opts.leadingExtensions ?? [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_SIGNING]),
          ...(opts.holderExtensions ?? [CERT_POLICIES, SUBJECT_DIR_ATTRS]),
          // MOICA certificates carry several hundred bytes of further
          // extensions; pad so the Extensions length takes two bytes.
          opaqueExtension(Buffer.alloc(200, 0xcc)),
          ...(opts.extraExtensions ?? []),
        ]),
      ),
    ),
  );
  return tlv(0x30, Buffer.concat(parts));
}

/** Cuts `tbs` to `length` bytes and rewrites the outer length to match. */
export function truncate(tbs, length) {
  const cut = Buffer.from(tbs.subarray(0, length));
  cut.writeUInt16BE(length - 4, 2);
  return cut;
}

/** Serial number of a TBS built by `buildTbs`, as an integer. */
export function serialOf(tbs) {
  const at = tbs[4] === 0xa0 ? 9 : 4;
  return BigInt("0x" + tbs.subarray(at + 2, at + 2 + tbs[at + 1]).toString("hex"));
}

export const sha256 = (data) => createHash("sha256").update(data).digest();
