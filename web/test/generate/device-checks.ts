// Writes spec/vectors/device-checks.json. Run from web/:
//
//   node --experimental-strip-types test/generate/device-checks.ts
//
// The certificates and CRLs come from test/fixtures, signed by keys made on
// the spot (the private keys are not kept), so every run changes the whole
// file. The result of every case is written here by hand; if web/'s code
// gives a different one, this stops and writes nothing.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { bigintOfBytes, bytesOfBigint, concatBytes, hexOf, sha256, sha256Hex } from "iamreal-protocol/bytes.ts";
import type { CertificateProblem } from "../../src/certificate.ts";
import type { IssuerName } from "../../src/issuers.ts";
import {
  type CertificateCase,
  type CrlCase,
  type IndexCase,
  type MaxAgeCase,
  type VectorIssuer,
  certificateResult,
  crlResult,
  indexResult,
  maxAgeResult,
} from "../device-checks.ts";
import {
  AUTHORITY_KEY_ID,
  CERT_POLICIES,
  KEY_USAGE_ENCRYPTION,
  KEY_USAGE_SIGNING,
  SUBJECT_KEY_ID,
  type TbsOptions,
  buildTbs,
  cardHolderRank,
  certificate,
  name,
  subjectDirectoryAttributes,
} from "../fixtures/certs.ts";
import { DELTA, IDP, indexLine, makeCrl } from "../fixtures/crls.ts";
import { SHA256_WITH_RSA, type TestKey, hex, makeKey, seq, signWith, tlv } from "../fixtures/der-build.ts";

const out = new URL("../../../spec/vectors/device-checks.json", import.meta.url);

/** A G2 key below 1.5 × 2^2047, so that a signature plus the modulus often still fits in 256 bytes. */
async function g2Key(): Promise<TestKey> {
  for (;;) {
    const k = await makeKey(2048);
    if (k.modulus >> 2045n < 6n) return k;
  }
}
const [g2, g3, other, card, bigCard] = await Promise.all([g2Key(), makeKey(4096), makeKey(2048), makeKey(2048), makeKey(4096)]);
const issuerKeys: Record<IssuerName, TestKey> = { G2: g2, G3: g3 };
const issuers: VectorIssuer[] = [
  { issuer: "G2", bits: 2048, modulus: "0x" + g2.modulus.toString(16) },
  { issuer: "G3", bits: 4096, modulus: "0x" + g3.modulus.toString(16) },
];

// --- Certificates -----------------------------------------------------------

const TODAY = "2026-11-16";
const SERIAL = "0x1234567890abcdef1234567890abcdef";
const CARD_MODULUS = "0x" + card.modulus.toString(16);

const cert = (o: Partial<TbsOptions> = {}, issuer: TestKey = g3): Promise<Uint8Array> => certificate(buildTbs({ spki: card.spki, ...o }), issuer);
const ENCRYPTION = { leadingExtensions: [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION], serial: hex("2234567890abcdef1234567890abcdef") };
const opaqueExtension = (size: number): Uint8Array => seq(hex("06092b06010401868d1f01"), tlv(0x04, new Uint8Array(size).fill(0xdd)));
/** A certificate whose tbsCertificate is exactly `length` bytes: an extension after the holder's fills it. */
async function certWithTbsOf(length: number): Promise<Uint8Array> {
  for (let size = 0; size < 2000; size++) {
    const holderExtensions = [CERT_POLICIES, subjectDirectoryAttributes(), opaqueExtension(size)];
    if (buildTbs({ spki: card.spki, holderExtensions }).length === length) return cert({ holderExtensions });
  }
  throw new Error(`no TBS of ${length} bytes`);
}
const bmpString = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[2 * i] = s.charCodeAt(i) >> 8;
    b[2 * i + 1] = s.charCodeAt(i) & 0xff;
  }
  return b;
};
// fixtures/certs.ts writes names in UTF-8 only; this one takes the value's tag and bytes.
const rdn = (oid: string, tag: number, value: Uint8Array): Uint8Array => tlv(0x31, seq(tlv(0x06, hex(oid)), tlv(tag, value)));
const COUNTRY = rdn("550406", 0x13, Uint8Array.from("TW", (c) => c.charCodeAt(0)));

const passes = (o: { chosen?: number; issuer?: IssuerName; serial?: string; modulus?: string; notBefore?: string; notAfter?: string; name?: string } = {}) => ({
  ok: true as const,
  chosen: o.chosen ?? 0,
  issuer: o.issuer ?? ("G3" as const),
  serial: o.serial ?? SERIAL,
  card_modulus: o.modulus ?? CARD_MODULUS,
  not_before: o.notBefore ?? "260101000000",
  not_after: o.notAfter ?? "310101155959",
  name: o.name ?? "測試用戶",
});
const fails = (problem: CertificateProblem, dates: { not_before?: string; not_after?: string } = {}) => ({ ok: false as const, problem, ...dates });

// Certificates written byte by byte: the walk's rows, the outer DER, the signature.
const TBS = buildTbs({ spki: card.spki });
function offsetOf(b: Uint8Array, pattern: Uint8Array): number {
  for (let i = 0; i + pattern.length <= b.length; i++) if (pattern.every((x, j) => b[i + j] === x)) return i;
  throw new Error("pattern not found");
}
const K = offsetOf(TBS, hex("30820122300d06092a864886f70d01010105000382010f003082010a0282010100")); // row 9
const E = K + 289; // row 10
/** The usual tbs with `bytes` written at `offset`, signed by G3. */
const patched = (offset: number, bytes: number[]): Promise<Uint8Array> => {
  const t = TBS.slice();
  t.set(bytes, offset);
  return certificate(t, g3);
};
/** The usual tbs cut to `n` bytes (its outer length follows), signed by G3. */
const cutTo = (n: number): Promise<Uint8Array> => {
  const t = TBS.slice(0, n);
  t[2] = (n - 4) >> 8;
  t[3] = (n - 4) & 0xff;
  return certificate(t, g3);
};
const bitString = (unused: number, sig: Uint8Array): Uint8Array => tlv(0x03, concatBytes(Uint8Array.of(unused), sig));
const tbsSig = await signWith(g3, TBS);
/** RSASSA-PKCS1-v1_5 written out: 00 01 FF… 00 and the DigestInfo, raised to d. */
async function rawSign(key: TestKey, digestInfo: Uint8Array): Promise<Uint8Array> {
  const jwk = await crypto.subtle.exportKey("jwk", key.privateKey);
  const d = bigintOfBytes(Uint8Array.from(atob(jwk.d!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  const k = key.bits / 8;
  const em = concatBytes(Uint8Array.of(0, 1), new Uint8Array(k - 3 - digestInfo.length).fill(0xff), Uint8Array.of(0), digestInfo);
  let base = bigintOfBytes(em) % key.modulus;
  let r = 1n;
  for (let e = d; e > 0n; e >>= 1n, base = (base * base) % key.modulus) if (e & 1n) r = (r * base) % key.modulus;
  return bytesOfBigint(r, k);
}
const g2Digest = await sha256(TBS);
const withNull = concatBytes(hex("3031300d060960864801650304020105000420"), g2Digest);
assert.deepEqual(await rawSign(g2, withNull), await signWith(g2, TBS), "the written-out signature is the one WebCrypto makes");
const noNull = await rawSign(g2, concatBytes(hex("302f300b0609608648016503040201"), hex("0420"), g2Digest));
/** A G2 certificate whose signature is written as itself plus the modulus, still 256 bytes. */
async function signaturePlusModulus(): Promise<Uint8Array> {
  for (let i = 0; i < 200; i++) {
    const t = buildTbs({ spki: card.spki, serial: Uint8Array.of(0x10, i) });
    const big = bigintOfBytes(await signWith(g2, t)) + g2.modulus;
    if (big >> 2048n === 0n) return seq(t, SHA256_WITH_RSA, bitString(0, bytesOfBigint(big, 256)));
  }
  throw new Error("no signature with room above the modulus");
}

const signing = await cert();
const encryption = await cert(ENCRYPTION);
const certificateCases: CertificateCase[] = [];
const certCase = (what: string, ders: Uint8Array[], result: CertificateCase["result"], today = TODAY) =>
  certificateCases.push({ what, today, certificates: ders.map(hexOf), result });

certCase("a citizen's primary-card signing certificate, issued with G3", [signing], passes());
certCase("issued with G2", [await cert({}, g2)], passes({ issuer: "G2" }));
certCase("the signing certificate after the encryption certificate", [encryption, signing], passes({ chosen: 1 }));
certCase("the signing certificate before the encryption certificate", [signing, encryption], passes());
certCase("only an encryption certificate", [encryption], fails("unsupported_format"));
certCase("no certificate", [], fails("no_certificate"));
certCase("two different signing certificates", [signing, await cert({ serial: Uint8Array.of(7) })], fails("ambiguous_certificate"));
certCase("the same signing certificate twice", [signing, signing.slice()], passes());
certCase("expired yesterday in Taiwan: notAfter is the last second of 2026-11-15 there", [await cert({ notAfter: "261115155959Z" })], fails("expired", { not_after: "261115155959" }));
certCase("valid through the last second of today in Taiwan", [await cert({ notAfter: "261116155959Z" })], passes({ notAfter: "261116155959" }));
certCase("valid from the last second of today in Taiwan", [await cert({ notBefore: "261116155959Z" })], passes({ notBefore: "261116155959" }));
certCase("valid from the first second of tomorrow in Taiwan", [await cert({ notBefore: "261116160000Z" })], fails("not_yet_valid", { not_before: "261116160000" }));
certCase("expired on another day: the date is the device's", [await cert({ notAfter: "270630155959Z" })], fails("expired", { not_after: "270630155959" }), "2027-07-01");
certCase("an expired signing certificate beside a valid encryption certificate", [encryption, await cert({ notAfter: "261115155959Z" })], fails("expired", { not_after: "261115155959" }));
certCase("an expired encryption certificate alone: its dates are not checked", [await cert({ ...ENCRYPTION, notAfter: "261115155959Z" })], fails("unsupported_format"));
certCase("an expired certificate beside a valid one", [await cert({ notAfter: "261115155959Z", serial: Uint8Array.of(7) }), signing], passes({ chosen: 1 }));
certCase(
  "expired and a foreign resident's: the date comes first",
  [await cert({ notAfter: "261115155959Z", holderExtensions: [CERT_POLICIES, subjectDirectoryAttributes({ subjectKind: 0x09 })] })],
  fails("expired", { not_after: "261115155959" }),
);
certCase("a foreign resident's certificate", [await cert({ holderExtensions: [CERT_POLICIES, subjectDirectoryAttributes({ subjectKind: 0x09 })] })], fails("not_citizen_primary"));
certCase("cardHolderRank mobile", [await cert({ holderExtensions: [CERT_POLICIES, subjectDirectoryAttributes({ extra: [cardHolderRank("mobile")] })] })], fails("not_citizen_primary"));
certCase("cardHolderRank secondary", [await cert({ holderExtensions: [CERT_POLICIES, subjectDirectoryAttributes({ extra: [cardHolderRank("secondary")] })] })], fails("not_citizen_primary"));
certCase("a card key of 4096 bits", [await certificate(buildTbs({ spki: bigCard.spki }), g3)], fails("unsupported_format"));
certCase("an issuer name of 128 bytes", [await cert({ issuer: name("Test CA", [100]) })], fails("unsupported_format"));
certCase("a subject of 128 to 255 bytes", [await cert({ subject: name("長名字", [60, 60]) })], passes({ name: "長名字" }));
certCase("a subject of 256 bytes or more", [await cert({ subject: name("長名字", [120, 120]) })], fails("unsupported_format"));
certCase("the commonName as a BMPString", [await cert({ subject: seq(COUNTRY, rdn("550403", 0x1e, bmpString("測試用戶"))) })], passes());
certCase("no commonName: the name is empty", [await cert({ subject: seq(COUNTRY) })], passes({ name: "" }));
certCase("signed by a key that is neither issuer key", [await cert({}, other)], fails("unknown_issuer"));
certCase("an unknown issuer beside an encryption certificate", [encryption, await cert({}, other)], fails("unknown_issuer"));
certCase(
  "a format the walk does not accept beside an unknown issuer: the unknown issuer is reported",
  [await cert({ issuer: name("Test CA", [100]) }), await cert({ serial: Uint8Array.of(7) }, other)],
  fails("unknown_issuer"),
);
certCase("keyUsage not in third place", [await cert({ leadingExtensions: [AUTHORITY_KEY_ID, KEY_USAGE_SIGNING, SUBJECT_KEY_ID] })], fails("unsupported_format"));
certCase("bytes after the certificate", [concatBytes(signing, Uint8Array.of(0))], fails("unsupported_format"));
certCase("not DER", [Uint8Array.of(0x30, 0x03, 0x02, 0x01)], fails("unsupported_format"));
certCase("a serial number of 20 bytes", [await cert({ serial: new Uint8Array(20).fill(0x7f) })], passes({ serial: "0x" + "7f".repeat(20) }));
certCase("a serial number of 21 bytes, the first 00", [await cert({ serial: concatBytes(Uint8Array.of(0), new Uint8Array(20).fill(0xff)) })], fails("unsupported_format"));
certCase("a serial number with a leading 00 is read unsigned", [await cert({ serial: hex("00ff01") })], passes({ serial: "0xff01" }));
certCase("notAfter in 2050 or later (UTCTime 50)", [await cert({ notAfter: "500101000000Z" })], fails("unsupported_format"));
certCase("notAfter as GeneralizedTime", [await cert({ notAfter: "20491231155959Z" })], fails("unsupported_format"));
certCase("a tbsCertificate of 1527 bytes", [await certWithTbsOf(1527)], passes());
certCase("a tbsCertificate of 1528 bytes", [await certWithTbsOf(1528)], fails("unsupported_format"));
certCase("version 2 (row 3)", [await patched(8, [0x01])], fails("unsupported_format"));
certCase("signature algorithm sha1WithRSAEncryption in the tbs (row 5)", [await patched(11 + 16 + 12, [0x05])], fails("unsupported_format"));
certCase("a date with a byte that is not a digit (row 7)", [await cert({ notBefore: "26010100000AZ" })], fails("unsupported_format"));
certCase(
  "a subject of fewer than 128 bytes with a long-form length, 81 xx (row 8)",
  [await cert({ subject: (() => { const n = name("測試用戶"); return concatBytes(Uint8Array.of(0x30, 0x81, n[1]!), n.subarray(2)); })() })],
  fails("unsupported_format"),
);
certCase("a card modulus whose first byte is 7f: fewer than 2048 bits (row 9)", [await patched(K + 33, [0x7f])], fails("unsupported_format"));
certCase("exponent 65539 (row 10)", [await patched(E + 4, [0x03])], fails("unsupported_format"));
certCase(
  "a tbs of fewer than 256 bytes: its header is not 30 82 (row 2)",
  [await certificate(seq(hex("a003020102"), tlv(0x02, Uint8Array.of(1)), hex("300d06092a864886f70d01010b0500")), g3)],
  fails("unsupported_format"),
);
certCase("a serial number of 0 bytes (row 4)", [await cert({ serial: new Uint8Array(0) })], fails("unsupported_format"));
certCase("notAfter without its final Z (row 7)", [await cert({ notAfter: "3101011559590" })], fails("unsupported_format"));
certCase("extensions tagged a4, not a3 (row 11)", [await patched(E + 5, [0xa4])], fails("unsupported_format"));
certCase("extensions not a SEQUENCE, 31 82 (row 11)", [await patched(E + 9, [0x31])], fails("unsupported_format"));
certCase("authorityKeyIdentifier of 21 bytes (row 12)", [await patched(E + 25, [0x15])], fails("unsupported_format"));
certCase("the tbs ends 168 bytes after the exponent (row 16)", [await cutTo(E + 168)], passes());
certCase("the tbs ends 167 bytes after the exponent (row 16)", [await cutTo(E + 167)], fails("unsupported_format"));
certCase("the signatureAlgorithm outside the tbs is not read", [seq(TBS, hex("300d06092a864886f70d0101050500"), bitString(0, tbsSig))], passes());
certCase("the signature's BIT STRING has 1 unused bit", [seq(TBS, SHA256_WITH_RSA, bitString(1, tbsSig))], fails("unsupported_format"));
certCase("a G2 signature of 257 bytes, the first 00", [seq(TBS, SHA256_WITH_RSA, bitString(0, concatBytes(Uint8Array.of(0), await signWith(g2, TBS))))], fails("unknown_issuer"));
certCase("a G2 signature written as itself plus the modulus", [await signaturePlusModulus()], fails("unknown_issuer"));
certCase("a G2 signature whose DigestInfo has no NULL parameters", [seq(TBS, SHA256_WITH_RSA, bitString(0, noNull))], fails("unknown_issuer"));
certCase("DER: a multi-byte tag", [seq(TBS, hex("3f1f0d300b06092a864886f70d01010b"), bitString(0, tbsSig))], fails("unsupported_format"));
certCase("DER: an indefinite length", [concatBytes(hex("3080"), TBS, SHA256_WITH_RSA, bitString(0, tbsSig), hex("0000"))], fails("unsupported_format"));
certCase("DER: a long-form length below 128, 81 0d", [seq(TBS, hex("30810d06092a864886f70d01010b0500"), bitString(0, tbsSig))], fails("unsupported_format"));
certCase(
  "DER: a length with a leading zero byte",
  [(() => { const body = concatBytes(TBS, SHA256_WITH_RSA, bitString(0, tbsSig)); return concatBytes(Uint8Array.of(0x30, 0x83, 0, body.length >> 8, body.length & 0xff), body); })()],
  fails("unsupported_format"),
);

// --- CRLs -------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** thisUpdate 16:30 UTC the day before: 00:30 in Taiwan on the CRL date. */
const crlTime = (daysBeforeToday: number) => new Date(Date.UTC(2026, 10, 15, 16, 30) - daysBeforeToday * DAY_MS);
const ROOT = "00".repeat(31) + "01"; // the device never reads it

interface MirrorCrl {
  /** The issuer the index line names. */
  issuer: IssuerName;
  crlNumber: bigint;
  thisUpdate: Date;
  signWith?: TestKey;
  extraExtensions?: Uint8Array[];
  /** Serial numbers on the CRL besides the three every CRL here has. */
  alsoRevoked?: bigint[];
  /** The index line says this root (for example "-not_usable_signature"). */
  root?: string;
  /** Serve these bytes under the file's name instead. */
  serve?: Uint8Array;
  /** Answer the file's name with this status and no body; 404 leaves it out of the mirror. */
  status?: number;
}

interface MirrorOptions {
  /** The index's bytes from its text (default: UTF-8). */
  indexBytes?: (text: string) => Uint8Array;
  /** Answer index.jsonl with this status and no body; 404 leaves it out of the mirror. */
  indexStatus?: number;
}

type Mirror = CrlCase["mirror"];

/** The mirror's answers, and the SHA-256 of each CRL in the order given. */
async function mirror(crls: MirrorCrl[], o: MirrorOptions): Promise<{ mirror: Mirror; shas: string[] }> {
  const lines: string[] = [];
  const files: Mirror = {};
  const shas: string[] = [];
  for (const c of crls) {
    const der = await makeCrl({ issuer: c.signWith ?? issuerKeys[c.issuer], serials: [3n, 0x1234n, 0xfedcba9876543210n, ...(c.alsoRevoked ?? [])], crlNumber: c.crlNumber, thisUpdate: c.thisUpdate, extraExtensions: c.extraExtensions });
    lines.push(await indexLine({ issuer: c.issuer, crlNumber: c.crlNumber, thisUpdate: c.thisUpdate, der, root: c.root ?? ROOT }));
    const sha = await sha256Hex(der);
    shas.push(sha);
    if (c.status === undefined) files[`${sha}.crl`] = { status: 200, body: hexOf(c.serve ?? der) };
    else if (c.status !== 404) files[`${sha}.crl`] = { status: c.status, body: "" };
  }
  const text = lines.map((l) => l + "\n").join("");
  const index = o.indexStatus !== undefined ? { status: o.indexStatus, body: "" } : { status: 200, body: hexOf((o.indexBytes ?? ((t) => new TextEncoder().encode(t)))(text)) };
  const answers: Mirror = o.indexStatus === 404 ? {} : { "index.jsonl": index };
  return { mirror: { ...answers, ...files }, shas };
}

const crlCases: CrlCase[] = [];
async function crlCase(
  what: string,
  o: { issuer?: IssuerName; serverDays?: number; highest?: string | null; serial?: string; crls: MirrorCrl[] } & MirrorOptions,
  result: (m: { shas: string[] }) => CrlCase["result"],
) {
  const m = await mirror(o.crls, o);
  crlCases.push({ what, issuer: o.issuer ?? "G3", today: TODAY, server_max_age_days: o.serverDays ?? 3, highest: o.highest ?? null, mirror: m.mirror, ...(o.serial !== undefined && { serial: o.serial }), result: result(m) });
}
const G3_100 = (daysBefore = 0, more: Partial<MirrorCrl> = {}): MirrorCrl => ({ issuer: "G3", crlNumber: 100n, thisUpdate: crlTime(daysBefore), ...more });
/** The first CRL of the case is used. */
const used = (crlDate: string, crlNumber = "100", highestAfter = crlNumber) => (m: { shas: string[] }) =>
  ({ ok: true as const, crl_number: crlNumber, crl_date: crlDate, sha256: m.shas[0]!, highest_after: highestAfter });
const unavailableCrl = () => ({ ok: false as const, problem: "crl_unavailable" as const, highest_after: null });

await crlCase("today's CRL, no CRL number remembered", { crls: [G3_100()] }, used("2026-11-16"));
await crlCase("a lower CRL number remembered", { highest: "99", crls: [G3_100()] }, used("2026-11-16"));
await crlCase("the same CRL number remembered", { highest: "100", crls: [G3_100()] }, used("2026-11-16"));
await crlCase("a higher CRL number remembered", { highest: "101", crls: [G3_100()] }, () => ({ ok: false, problem: "crl_rollback", crl_number: "100", highest: "101", highest_after: "101" }));
await crlCase("3 days old, the server says 3", { crls: [G3_100(3)] }, used("2026-11-13", "100"));
await crlCase("4 days old, the server says 3", { crls: [G3_100(4)] }, () => ({ ok: false, problem: "crl_stale", days: 4, max_age_days: 3, highest_after: null }));
await crlCase("7 days old, the server says 365: the built-in 7", { serverDays: 365, crls: [G3_100(7)] }, used("2026-11-09"));
await crlCase("8 days old, the server says 365", { serverDays: 365, crls: [G3_100(8)] }, () => ({ ok: false, problem: "crl_stale", days: 8, max_age_days: 7, highest_after: null }));
await crlCase("the server says 0: today's CRL", { serverDays: 0, crls: [G3_100()] }, used("2026-11-16"));
await crlCase("the server says 0: yesterday's CRL", { serverDays: 0, crls: [G3_100(1)] }, () => ({ ok: false, problem: "crl_stale", days: 1, max_age_days: 0, highest_after: null }));
await crlCase("a CRL date after today", { crls: [G3_100(-1)] }, used("2026-11-17"));
await crlCase(
  "thisUpdate 15:59:59 UTC is 23:59:59 of the same date in Taiwan",
  { serverDays: 0, crls: [G3_100(0, { thisUpdate: new Date(Date.UTC(2026, 10, 15, 15, 59, 59)) })] },
  () => ({ ok: false, problem: "crl_stale", days: 1, max_age_days: 0, highest_after: null }),
);
await crlCase("thisUpdate 16:00:00 UTC is 00:00:00 of the next date in Taiwan", { serverDays: 0, crls: [G3_100(0, { thisUpdate: new Date(Date.UTC(2026, 10, 15, 16, 0, 0)) })] }, used("2026-11-16"));
await crlCase("a G2 certificate and a G2 CRL", { issuer: "G2", crls: [{ issuer: "G2", crlNumber: 7n, thisUpdate: crlTime(0) }] }, used("2026-11-16", "7"));
await crlCase("a CRL signed by a key that is neither issuer key", { crls: [G3_100(0, { signWith: other })] }, () => ({ ok: false, problem: "crl_unusable", reason: "not_usable_signature", highest_after: null }));
await crlCase(
  "signed by the G2 key, for a G3 certificate (the index says G3)",
  { crls: [G3_100(0, { signWith: g2 })] },
  () => ({ ok: false, problem: "crl_unusable", reason: "not_usable_signature", highest_after: null }),
);
await crlCase("a partitioned CRL", { crls: [G3_100(0, { extraExtensions: [IDP] })] }, () => ({ ok: false, problem: "crl_unusable", reason: "not_usable_partitioned", highest_after: null }));
await crlCase("a delta CRL", { crls: [G3_100(0, { extraExtensions: [DELTA] })] }, () => ({ ok: false, problem: "crl_unusable", reason: "not_usable_delta", highest_after: null }));
// Both extensions: the one that comes first in the CRL decides (spec/revocation-tree.md, rows 6 and 7).
await crlCase(
  "issuingDistributionPoint before deltaCRLIndicator: partitioned",
  { crls: [G3_100(0, { extraExtensions: [IDP, DELTA] })] },
  () => ({ ok: false, problem: "crl_unusable", reason: "not_usable_partitioned", highest_after: null }),
);
await crlCase(
  "deltaCRLIndicator before issuingDistributionPoint: delta",
  { crls: [G3_100(0, { extraExtensions: [DELTA, IDP] })] },
  () => ({ ok: false, problem: "crl_unusable", reason: "not_usable_delta", highest_after: null }),
);
// The certificate's own serial number (the one of the certificate cases above) on the CRL.
await crlCase("the certificate is on the CRL", { serial: SERIAL, crls: [G3_100(0, { alsoRevoked: [BigInt(SERIAL)] })] }, () => ({ ok: false, problem: "revoked", highest_after: "100" }));
await crlCase("the certificate is not on the CRL: another serial number is", { serial: SERIAL, crls: [G3_100(0, { alsoRevoked: [BigInt(SERIAL) + 1n] })] }, used("2026-11-16"));
await crlCase(
  "order: stale before revoked",
  { serial: SERIAL, crls: [G3_100(4, { alsoRevoked: [BigInt(SERIAL)] })] },
  () => ({ ok: false, problem: "crl_stale", days: 4, max_age_days: 3, highest_after: null }),
);
await crlCase(
  "the file's SHA-256 is not the one in its name",
  { crls: [G3_100(0, { serve: await makeCrl({ issuer: g3, serials: [5n], crlNumber: 100n, thisUpdate: crlTime(0) }) })] },
  () => ({ ok: false, problem: "crl_hash", highest_after: null }),
);
await crlCase("the file is not served", { crls: [G3_100(0, { status: 404 })] }, () => ({ ok: false, problem: "crl_unavailable", highest_after: null }));
await crlCase("no line for the certificate's issuer", { crls: [{ issuer: "G2", crlNumber: 7n, thisUpdate: crlTime(0) }] }, () => ({ ok: false, problem: "crl_unavailable", highest_after: null }));
await crlCase(
  "the line with the highest CRL number is used",
  { crls: [G3_100(0), { issuer: "G3", crlNumber: 99n, thisUpdate: crlTime(1), status: 404 }] },
  used("2026-11-16"),
);
await crlCase(
  "a line the index marks not usable is skipped, even with a higher number",
  { crls: [G3_100(0), { issuer: "G3", crlNumber: 101n, thisUpdate: crlTime(0), signWith: other, root: "-not_usable_signature" }] },
  used("2026-11-16"),
);
await crlCase(
  "the index's root is not read: a usable line with a wrong root",
  { crls: [G3_100(0, { root: "ab".repeat(32) })] },
  used("2026-11-16"),
);
await crlCase(
  "order: not usable before rollback",
  { highest: "101", crls: [G3_100(0, { signWith: other })] },
  () => ({ ok: false, problem: "crl_unusable", reason: "not_usable_signature", highest_after: "101" }),
);
await crlCase("the index is not served (404)", { indexStatus: 404, crls: [G3_100()] }, unavailableCrl);
await crlCase("the index is answered with 500", { indexStatus: 500, crls: [G3_100()] }, unavailableCrl);
await crlCase("the file is answered with 500", { crls: [G3_100(0, { status: 500 })] }, unavailableCrl);
await crlCase("the index is not UTF-8", { indexBytes: (t) => concatBytes(new TextEncoder().encode(t), Uint8Array.of(0xff, 0x0a)), crls: [G3_100()] }, unavailableCrl);
await crlCase("the index starts with a byte order mark", { indexBytes: (t) => concatBytes(hex("efbbbf"), new TextEncoder().encode(t)), crls: [G3_100()] }, used("2026-11-16"));
await crlCase("order: rollback before stale", { highest: "101", crls: [G3_100(4)] }, () => ({ ok: false, problem: "crl_rollback", crl_number: "100", highest: "101", highest_after: "101" }));

const maxAge: MaxAgeCase[] = [
  { server_max_age_days: -1, max_age_days: null },
  { server_max_age_days: 1.5, max_age_days: null },
  { server_max_age_days: "3", max_age_days: null },
  { server_max_age_days: null, max_age_days: null },
  { server_max_age_days: 9007199254740992, max_age_days: null },
  { server_max_age_days: 9007199254740991, max_age_days: 7 },
  { server_max_age_days: 0, max_age_days: 0 },
  { server_max_age_days: 3, max_age_days: 3 },
  { server_max_age_days: 6, max_age_days: 6 },
  { server_max_age_days: 7, max_age_days: 7 },
  { server_max_age_days: 8, max_age_days: 7 },
  { server_max_age_days: 365, max_age_days: 7 },
];

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const C = "cc".repeat(32);
const line = (issuer: string, n: string, sha: string, root = "11".repeat(32)) =>
  `{"issuer":"${issuer}","crl_number":"${n}","this_update":"2026-11-15T16:30:00Z","next_update":"2026-11-17T04:30:00Z","crl_date":"2026-11-16","sha256":"${sha}","root":"${root}"}\n`;
const indexCases: IndexCase[] = [];
const indexCase = (what: string, issuer: IssuerName, lines: string[], result: IndexCase["result"]) => indexCases.push({ what, issuer, index: lines.join(""), result });
const unavailable = { problem: "crl_unavailable" as const };

indexCase("the highest CRL number of the issuer, compared as numbers", "G3", [line("G3", "9", A), line("G3", "10", B), line("G2", "11", C)], { crl_number: "10", sha256: B });
indexCase("another issuer's lines are not used", "G2", [line("G3", "10", B), line("G2", "9", A)], { crl_number: "9", sha256: A });
indexCase("a line marked not usable is skipped", "G3", [line("G3", "10", A), line("G3", "11", B, "-not_usable_signature")], { crl_number: "10", sha256: A });
indexCase("lines that are not JSON objects, and empty lines, are skipped", "G3", ["garbage\n", "\n", "[]\n", "null\n", line("G3", "10", A)], { crl_number: "10", sha256: A });
indexCase("an index without a final line feed", "G3", [line("G3", "10", A).trimEnd()], { crl_number: "10", sha256: A });
indexCase("a crl_number with a leading zero is skipped", "G3", [line("G3", "10", A), line("G3", "011", B)], { crl_number: "10", sha256: A });
indexCase("a crl_number of - is skipped", "G3", [line("G3", "10", A), line("G3", "-", B)], { crl_number: "10", sha256: A });
indexCase("a sha256 in uppercase is skipped", "G3", [line("G3", "10", A), line("G3", "11", B.toUpperCase())], { crl_number: "10", sha256: A });
indexCase("a root in uppercase is skipped", "G3", [line("G3", "10", A), line("G3", "11", B, "AB".repeat(32))], { crl_number: "10", sha256: A });
indexCase("two different files with the highest number: none", "G3", [line("G3", "10", A), line("G3", "10", B)], unavailable);
indexCase("the same file twice with the highest number", "G3", [line("G3", "10", A), line("G3", "10", A)], { crl_number: "10", sha256: A });
indexCase("two files share a lower number", "G3", [line("G3", "9", A), line("G3", "9", B), line("G3", "10", C)], { crl_number: "10", sha256: C });
indexCase("an empty index", "G3", [], unavailable);
indexCase("only lines marked not usable", "G3", [line("G3", "10", A, "-not_usable_der")], unavailable);
indexCase("CRL number 0", "G3", [line("G3", "0", A)], { crl_number: "0", sha256: A });
indexCase("a CRL number above 2^64", "G3", [line("G3", "18446744073709551616", A), line("G3", "18446744073709551615", B)], { crl_number: "18446744073709551616", sha256: A });

// --- Check against web/ and write --------------------------------------------

const whats = [...certificateCases, ...crlCases, ...indexCases].map((c) => c.what);
assert.equal(new Set(whats).size, whats.length, "every case has its own description");
for (const c of certificateCases) assert.deepEqual(await certificateResult(c, issuers), c.result, c.what);
for (const c of maxAge) assert.equal(await maxAgeResult(c), c.max_age_days, `max_age ${JSON.stringify(c.server_max_age_days)}`);
for (const c of indexCases) assert.deepEqual(indexResult(c), c.result, c.what);
for (const c of crlCases) assert.deepEqual(await crlResult(c, issuers), c.result, c.what);

const file = {
  spec: "device-checks",
  status: "draft",
  note:
    "Made by web/test/generate/device-checks.ts with test keys made on the spot. The issuer keys below stand in for MOICA's G2 and G3: use them in place of spec/issuers.md for these cases only. Bytes (certificates, CRLs, the mirror's answers) are lowercase hex; moduli and serial numbers are 0x-prefixed lowercase hex without leading zeros (00 ff 01 is 0xff01); certificate times are the 12 digits YYMMDDHHMMSS (UTC) as the certificate writes them; dates are in Taiwan.",
  generated_by: "web/test/generate/device-checks.ts",
  issuers,
  certificate: { cases: certificateCases },
  crl: { max_age: maxAge, index: indexCases, cases: crlCases },
};
writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
console.log(`wrote ${out.pathname}: ${certificateCases.length} certificate cases, ${indexCases.length} index cases, ${crlCases.length} CRL cases`);
