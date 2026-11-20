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
import { concatBytes, hexOf, sha256Hex } from "iamreal-protocol/bytes.ts";
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
import { IDP, indexLine, makeCrl } from "../fixtures/crls.ts";
import { type TestKey, hex, makeKey, seq, tlv } from "../fixtures/der-build.ts";

const out = new URL("../../../spec/vectors/device-checks.json", import.meta.url);

const [g2, g3, other, card, bigCard] = await Promise.all([makeKey(2048), makeKey(4096), makeKey(2048), makeKey(2048), makeKey(4096)]);
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
const fails = (problem: string, dates: { not_before?: string; not_after?: string } = {}) => ({ ok: false as const, problem, ...dates });

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
  /** The index line says this root (for example "-not_usable_signature"). */
  root?: string;
  /** Serve these bytes under the file's name instead. */
  serve?: Uint8Array | null;
}

async function mirror(crls: MirrorCrl[]): Promise<{ index: string; files: Record<string, string> }> {
  const lines: string[] = [];
  const files: Record<string, string> = {};
  for (const c of crls) {
    const der = await makeCrl({ issuer: c.signWith ?? issuerKeys[c.issuer], serials: [3n, 0x1234n, 0xfedcba9876543210n], crlNumber: c.crlNumber, thisUpdate: c.thisUpdate, extraExtensions: c.extraExtensions });
    lines.push(await indexLine({ issuer: c.issuer, crlNumber: c.crlNumber, thisUpdate: c.thisUpdate, der, root: c.root ?? ROOT }));
    const served = c.serve === undefined ? der : c.serve;
    if (served !== null) files[`${await sha256Hex(der)}.crl`] = hexOf(served);
  }
  return { index: lines.map((l) => l + "\n").join(""), files };
}
const firstSha = (files: Record<string, string>) => Object.keys(files)[0]!.slice(0, 64);

const crlCases: CrlCase[] = [];
async function crlCase(
  what: string,
  o: { issuer?: IssuerName; serverDays?: number; highest?: string | null; crls: MirrorCrl[] },
  result: (m: { files: Record<string, string> }) => CrlCase["result"],
) {
  const m = await mirror(o.crls);
  crlCases.push({ what, issuer: o.issuer ?? "G3", today: TODAY, server_max_age_days: o.serverDays ?? 3, highest: o.highest ?? null, index: m.index, files: m.files, result: result(m) });
}
const G3_100 = (daysBefore = 0, more: Partial<MirrorCrl> = {}): MirrorCrl => ({ issuer: "G3", crlNumber: 100n, thisUpdate: crlTime(daysBefore), ...more });
const used = (crlDate: string, crlNumber = "100", highestAfter = crlNumber) => (m: { files: Record<string, string> }) =>
  ({ ok: true as const, crl_number: crlNumber, crl_date: crlDate, sha256: firstSha(m.files), highest_after: highestAfter });

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
await crlCase(
  "the file's SHA-256 is not the one in its name",
  { crls: [G3_100(0, { serve: await makeCrl({ issuer: g3, serials: [5n], crlNumber: 100n, thisUpdate: crlTime(0) }) })] },
  () => ({ ok: false, problem: "crl_hash", highest_after: null }),
);
await crlCase("the file is not served", { crls: [G3_100(0, { serve: null })] }, () => ({ ok: false, problem: "crl_unavailable", highest_after: null }));
await crlCase("no line for the certificate's issuer", { crls: [{ issuer: "G2", crlNumber: 7n, thisUpdate: crlTime(0) }] }, () => ({ ok: false, problem: "crl_unavailable", highest_after: null }));
await crlCase(
  "the line with the highest CRL number is used",
  { crls: [G3_100(0), { issuer: "G3", crlNumber: 99n, thisUpdate: crlTime(1), serve: null }] },
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
await crlCase("order: rollback before stale", { highest: "101", crls: [G3_100(4)] }, () => ({ ok: false, problem: "crl_rollback", crl_number: "100", highest: "101", highest_after: "101" }));

const maxAge: MaxAgeCase[] = [
  { server_days: 0, max_age_days: 0 },
  { server_days: 3, max_age_days: 3 },
  { server_days: 6, max_age_days: 6 },
  { server_days: 7, max_age_days: 7 },
  { server_days: 8, max_age_days: 7 },
  { server_days: 365, max_age_days: 7 },
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
for (const c of maxAge) assert.equal(maxAgeResult(c), c.max_age_days, `max_age ${c.server_days}`);
for (const c of indexCases) assert.deepEqual(indexResult(c), c.result, c.what);
for (const c of crlCases) assert.deepEqual(await crlResult(c, issuers), c.result, c.what);

const file = {
  spec: "device-checks",
  status: "draft",
  note:
    "Made by web/test/generate/device-checks.ts with test keys made on the spot. The issuer keys below stand in for MOICA's G2 and G3: use them in place of spec/issuers.md for these cases only. Certificates and CRLs are DER in hex; moduli and serial numbers are 0x-prefixed hex; certificate times are the 12 digits YYMMDDHHMMSS (UTC) as the certificate writes them; dates are in Taiwan.",
  generated_by: "web/test/generate/device-checks.ts",
  issuers,
  certificate: { cases: certificateCases },
  crl: { max_age: maxAge, index: indexCases, cases: crlCases },
};
writeFileSync(out, JSON.stringify(file, null, 2) + "\n");
console.log(`wrote ${out.pathname}: ${certificateCases.length} certificate cases, ${indexCases.length} index cases, ${crlCases.length} CRL cases`);
