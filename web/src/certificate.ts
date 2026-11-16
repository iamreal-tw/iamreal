// The cardholder's certificate, checked on the device before any PIN is
// asked: the same structural walk as the circuit (zkid-noir lib/src/der.nr,
// ADR-0008 to ADR-0011), validity on today's date in Taiwan, and MOICA's
// signature (spec/issuers.md). A card that cannot pass is told so here, and
// the reason goes back to the caller only (ADR-0016).
import { equalBytes } from "./bytes.ts";
import { DerError, TAG, children, content, expectTlv, oidString, readTlv, whole } from "./der.ts";
import { type IssuerKey, importRsaKey, rsaVerify } from "./issuers.ts";
import { currentTime } from "./spec/challenge.ts";
import type { Day } from "./spec/date.ts";

/** Why no certificate on the card can make a card proof. */
export type CertificateProblem =
  /** The card returned no certificate. */
  | "no_certificate"
  /** notAfter is before today (Taiwan date): the certificate has expired. */
  | "expired"
  /** notBefore is after the last second of today. */
  | "not_yet_valid"
  /** The certificate policy or subjectDirectoryAttributes are not those of a citizen's primary card (ADR-0011). */
  | "not_citizen_primary"
  /** Any other place where the circuit's walk fails: a format the circuit does not accept. */
  | "unsupported_format"
  /** Neither issuer key signed it. */
  | "unknown_issuer"
  /** More than one certificate on the card passes every check; the device does not choose. */
  | "ambiguous_certificate";

/** The certificate a card proof uses, with what the device read from it. */
export interface CardCertificate {
  /** The whole certificate (DER). */
  der: Uint8Array;
  /** tbsCertificate, the bytes the issuer signed and the circuit walks. */
  tbs: Uint8Array;
  issuer: IssuerKey;
  /** The issuer's signature over `tbs`, big-endian, `issuer.bits / 8` bytes. */
  issuerSignature: Uint8Array;
  /** The serial number's content bytes as an unsigned integer: the tree key. */
  serial: bigint;
  /** The card's RSA modulus (exactly 2048 bits). */
  cardModulus: bigint;
  /** YYMMDDHHMMSS, UTC, as written in the certificate. */
  notBefore: bigint;
  notAfter: bigint;
  /** The subject's commonName: the name the screen shows. Never sent anywhere. */
  name: string;
}

// The byte strings der.nr pins (zkid-noir 497b610).
const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
export const MAX_TBS_LEN = 1536;
export const MAX_SIGNED_LEN = MAX_TBS_LEN - 9;
const MAX_SERIAL_LEN = 20;
const VERSION = hex("a003020102");
const SIG_ALG = hex("300d06092a864886f70d01010b0500");
const SPKI_HEAD = hex("30820122300d06092a864886f70d01010105000382010f003082010a0282010100");
const EXPONENT = hex("0203010001");
const AKI_HEAD = hex("301f0603551d23041830168014");
const SKI_HEAD = hex("301d0603551d0e04160414");
const KEY_USAGE = hex("300e0603551d0f0101ff040403020780");
const HOLDER_EXTENSIONS = hex(
  "30140603551d20040d300b300906076086766500030330330603551d09042c302a3015060760867601640201310a06086086760164030101301106076086760164023331060c04",
);

/** Where the walk stopped, and what was read before it stopped. */
interface Walk {
  /** null if the whole walk passed. */
  failure: { step: "key_usage" | "holder" | "structure"; detail: string } | null;
  notBefore?: bigint;
  notAfter?: bigint;
  serial?: bigint;
  modulus?: bigint;
  subject?: { start: number; end: number };
}

class WalkFailure extends Error {
  readonly step: "key_usage" | "holder" | "structure";
  constructor(step: "key_usage" | "holder" | "structure", detail: string) {
    super(detail);
    this.step = step;
  }
}

/**
 * Port of der.nr `check_certificate` without the validity comparison: every
 * offset is derived from the structure, every read stays under the TBS
 * length (the circuit asserts the last one is).
 */
export function walkTbs(tbs: Uint8Array): Walk {
  const out: Walk = { failure: null };
  const n = tbs.length;
  const at = (i: number): number => {
    if (i >= n) throw new WalkFailure("structure", `read at ${i} past the TBS (${n} bytes)`);
    return tbs[i]!;
  };
  const expect = (offset: number, expected: Uint8Array, step: "key_usage" | "holder" | "structure", what: string): void => {
    for (let i = 0; i < expected.length; i++) {
      if (at(offset + i) !== expected[i]) throw new WalkFailure(step, `${what}: byte ${offset + i}`);
    }
  };
  const utcTime = (offset: number, what: string): bigint => {
    let v = 0n;
    for (let i = 0; i < 12; i++) {
      const b = at(offset + i);
      if (b < 48 || b > 57) throw new WalkFailure("structure", `${what}: not a digit`);
      v = v * 10n + BigInt(b - 48);
    }
    if (at(offset) >= 53) throw new WalkFailure("structure", `${what}: year 50 or later`);
    return v;
  };
  try {
    if (n > MAX_SIGNED_LEN) throw new WalkFailure("structure", `TBS of ${n} bytes, more than ${MAX_SIGNED_LEN}`);
    if (at(0) !== 0x30 || at(1) !== 0x82) throw new WalkFailure("structure", "outer header is not 30 82");
    if (at(2) * 256 + at(3) + 4 !== n) throw new WalkFailure("structure", "outer length is not the TBS length");
    expect(4, VERSION, "structure", "version is not v3");
    if (at(9) !== 0x02) throw new WalkFailure("structure", "serial is not an INTEGER");
    const serialLen = at(10);
    if (serialLen < 1 || serialLen > MAX_SERIAL_LEN) throw new WalkFailure("structure", `serial of ${serialLen} bytes`);
    let serial = 0n;
    for (let i = 0; i < serialLen; i++) serial = serial * 256n + BigInt(at(11 + i));
    out.serial = serial;
    const sigAlg = 11 + serialLen;
    expect(sigAlg, SIG_ALG, "structure", "signature algorithm is not sha256WithRSAEncryption");
    const issuer = sigAlg + 15;
    if (at(issuer) !== 0x30) throw new WalkFailure("structure", "issuer is not a SEQUENCE");
    const issuerLen = at(issuer + 1);
    if (issuerLen >= 128) throw new WalkFailure("structure", "issuer name of 128 bytes or more");
    const validity = issuer + 2 + issuerLen;
    expect(validity, hex("301e170d"), "structure", "validity is not two UTCTime");
    const notBefore = utcTime(validity + 4, "notBefore");
    expect(validity + 16, hex("5a170d"), "structure", "validity encoding");
    const notAfter = utcTime(validity + 19, "notAfter");
    if (at(validity + 31) !== 0x5a) throw new WalkFailure("structure", "notAfter does not end in Z");
    out.notBefore = notBefore;
    out.notAfter = notAfter;
    const subject = validity + 32;
    if (at(subject) !== 0x30) throw new WalkFailure("structure", "subject is not a SEQUENCE");
    const b1 = at(subject + 1);
    const b2 = at(subject + 2);
    const isLong = b1 === 0x81;
    if (!(isLong || b1 < 128)) throw new WalkFailure("structure", "subject longer than 255 bytes");
    if (isLong && b2 < 128) throw new WalkFailure("structure", "subject length not in its shortest form");
    const subjectLen = isLong ? b2 : b1;
    const spki = subject + 2 + (isLong ? 1 : 0) + subjectLen;
    out.subject = { start: subject, end: spki };
    expect(spki, SPKI_HEAD, "structure", "subject key is not RSA 2048");
    const modulusOffset = spki + 33;
    let modulus = 0n;
    for (let i = 0; i < 256; i++) modulus = modulus * 256n + BigInt(at(modulusOffset + i));
    if (at(modulusOffset) < 0x80) throw new WalkFailure("structure", "subject key shorter than 2048 bits");
    out.modulus = modulus;
    const exponent = modulusOffset + 256;
    expect(exponent, EXPONENT, "structure", "exponent is not 65537");
    expect(exponent + 5, hex("a382"), "structure", "extensions header");
    expect(exponent + 9, hex("3082"), "structure", "extensions SEQUENCE header");
    expect(exponent + 13, AKI_HEAD, "structure", "first extension is not authorityKeyIdentifier");
    expect(exponent + 46, SKI_HEAD, "structure", "second extension is not subjectKeyIdentifier");
    expect(exponent + 77, KEY_USAGE, "key_usage", "keyUsage is not critical digitalSignature only");
    expect(exponent + 93, HOLDER_EXTENSIONS, "holder", "not a citizen's primary card");
    if (exponent + 168 > n) throw new WalkFailure("structure", "the walk ends past the TBS");
  } catch (e) {
    if (!(e instanceof WalkFailure)) throw e;
    out.failure = { step: e.step, detail: e.message };
  }
  return out;
}

/** tbsCertificate, signatureAlgorithm and signatureValue of a DER certificate. */
function splitCertificate(der: Uint8Array): { tbs: Uint8Array; signature: Uint8Array } {
  const cert = expectTlv(der, 0, TAG.SEQUENCE, der.length, "Certificate");
  if (cert.end !== der.length) throw new DerError("bytes after the certificate");
  const [tbs, alg, sig, ...rest] = children(der, cert);
  if (!tbs || !alg || !sig || rest.length) throw new DerError("Certificate is not three elements");
  if (tbs.tag !== TAG.SEQUENCE || alg.tag !== TAG.SEQUENCE || sig.tag !== TAG.BIT_STRING) throw new DerError("Certificate fields");
  const bits = content(der, sig);
  if (bits[0] !== 0) throw new DerError("signature has unused bits");
  return { tbs: whole(der, tbs), signature: bits.subarray(1) };
}

const OID_CN = "2.5.4.3";

/** The subject's commonName, decoded; "" if there is none. */
function commonName(tbs: Uint8Array, subject: { start: number; end: number }): string {
  try {
    const name = readTlv(tbs, subject.start, subject.end);
    for (const rdn of children(tbs, name)) {
      for (const atv of children(tbs, rdn)) {
        const [oid, value] = children(tbs, atv);
        if (!oid || !value || oid.tag !== TAG.OID || oidString(content(tbs, oid)) !== OID_CN) continue;
        const v = content(tbs, value);
        if (value.tag === TAG.BMP_STRING) {
          let s = "";
          for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i]! << 8) | v[i + 1]!);
          return s;
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(v);
      }
    }
  } catch {
    // A name the device cannot read is shown as empty; the circuit does not read it.
  }
  return "";
}

type CheckResult = { ok: true; cert: CardCertificate } | { ok: false; problem: CertificateProblem; signing: boolean };

/** Checks one certificate against today's date and the issuer keys. */
export async function checkCertificate(der: Uint8Array, today: Day, issuers: readonly IssuerKey[]): Promise<CheckResult> {
  let parts: { tbs: Uint8Array; signature: Uint8Array };
  try {
    parts = splitCertificate(der);
  } catch {
    return { ok: false, problem: "unsupported_format", signing: false };
  }
  const walk = walkTbs(parts.tbs);
  const signing = walk.failure?.step !== "key_usage";
  // Dates come first when they could be read: an expired card is the one
  // problem the cardholder can act on (by renewing it).
  if (walk.notBefore !== undefined && walk.notAfter !== undefined && signing) {
    const now = currentTime(today);
    if (now > walk.notAfter) return { ok: false, problem: "expired", signing };
    if (now < walk.notBefore) return { ok: false, problem: "not_yet_valid", signing };
  }
  if (walk.failure) {
    return { ok: false, problem: walk.failure.step === "holder" ? "not_citizen_primary" : "unsupported_format", signing };
  }
  let issuer: IssuerKey | null = null;
  for (const key of issuers) {
    const k = await importRsaKey(key.modulus, key.bits);
    if (await rsaVerify(k, key.bits, parts.signature, parts.tbs)) {
      issuer = key;
      break;
    }
  }
  if (!issuer) return { ok: false, problem: "unknown_issuer", signing };
  return {
    ok: true,
    cert: {
      der,
      tbs: parts.tbs,
      issuer,
      issuerSignature: parts.signature,
      serial: walk.serial!,
      cardModulus: walk.modulus!,
      notBefore: walk.notBefore!,
      notAfter: walk.notAfter!,
      name: commonName(parts.tbs, walk.subject!),
    },
  };
}

export type Selection = { ok: true; cert: CardCertificate } | { ok: false; problem: CertificateProblem; notAfter?: bigint };

/**
 * From the certificates a card returns, the one a card proof uses: the only
 * one that passes every check. Encryption certificates fail at keyUsage and
 * are skipped. If none passes, the problem of the signing certificate (the
 * one that got past keyUsage) is reported.
 */
export async function selectCertificate(ders: readonly Uint8Array[], today: Day, issuers: readonly IssuerKey[]): Promise<Selection> {
  if (ders.length === 0) return { ok: false, problem: "no_certificate" };
  const results = await Promise.all(ders.map((d) => checkCertificate(d, today, issuers)));
  const passing = results.filter((r) => r.ok);
  if (passing.length === 1) return passing[0]!;
  if (passing.length > 1) {
    // Two copies of the same certificate are one.
    const first = passing[0]!.cert;
    if (passing.every((r) => equalBytes(r.cert.der, first.der))) return passing[0]!;
    return { ok: false, problem: "ambiguous_certificate" };
  }
  const failed = results.filter((r): r is Extract<CheckResult, { ok: false }> => !r.ok);
  const signing = failed.find((r) => r.signing && r.problem !== "unsupported_format") ?? failed.find((r) => r.signing);
  if (!signing) return { ok: false, problem: "unsupported_format" };
  if (signing.problem === "expired") {
    const idx = results.indexOf(signing);
    const w = walkTbs(splitCertificate(ders[idx]!).tbs);
    return { ok: false, problem: "expired", notAfter: w.notAfter };
  }
  return { ok: false, problem: signing.problem };
}

/** The card's public key, to check its signatures before using them. */
export function cardKey(cert: CardCertificate): Promise<CryptoKey> {
  return importRsaKey(cert.cardModulus, 2048);
}
