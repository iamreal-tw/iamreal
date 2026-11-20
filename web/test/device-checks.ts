// The cases of spec/vectors/device-checks.json, and what web/'s code answers
// for each, in the vectors' own form. The test compares these answers with
// the file; the generator (generate/device-checks.ts) compares them with the
// results written by hand before it writes the file.
import { bytesOfHex } from "iamreal-protocol/bytes.ts";
import { formatDay, parseDay } from "iamreal-protocol/date.ts";
import { type Fetch, ServerError, requestConfig } from "../src/api.ts";
import { type CertificateProblem, selectCertificate } from "../src/certificate.ts";
import { keyAt } from "../src/crl/crl.ts";
import { RevocationError, chooseFromIndex, crlMaxAge, loadCrl } from "../src/crl/revocation.ts";
import type { IssuerKey, IssuerName } from "../src/issuers.ts";
import { memoryStore } from "../src/storage.ts";

/** A test issuer key: stands in for MOICA's key of the same name. */
export interface VectorIssuer {
  issuer: IssuerName;
  bits: 2048 | 4096;
  /** "0x…", the exponent is 65537. */
  modulus: string;
}

export const issuerKeys = (issuers: readonly VectorIssuer[]): IssuerKey[] =>
  issuers.map((i) => ({ name: i.issuer, bits: i.bits, modulus: BigInt(i.modulus) }));

const day = (s: string) => {
  const d = parseDay(s);
  if (d === null) throw new Error(`not a date: ${s}`);
  return d;
};

/** A certificate time read as the circuit reads it: 12 digits, YYMMDDHHMMSS, UTC. */
const certTime = (t: bigint): string => t.toString().padStart(12, "0");

export interface CertificateCase {
  what: string;
  /** Today in Taiwan, YYYY-MM-DD. */
  today: string;
  /** The certificates the card returned, in the order it returned them (DER, hex). */
  certificates: string[];
  result: CertificateResult;
}

export type CertificateResult =
  | {
      ok: true;
      /** Index in `certificates` of the one chosen (the first, if the same certificate is there twice). */
      chosen: number;
      issuer: IssuerName;
      serial: string;
      card_modulus: string;
      not_before: string;
      not_after: string;
      name: string;
    }
  | { ok: false; problem: CertificateProblem; not_before?: string; not_after?: string };

export async function certificateResult(c: Omit<CertificateCase, "result">, issuers: readonly VectorIssuer[]): Promise<CertificateResult> {
  const ders = c.certificates.map((h) => bytesOfHex(h));
  const sel = await selectCertificate(ders, day(c.today), issuerKeys(issuers));
  if (!sel.ok) {
    return {
      ok: false,
      problem: sel.problem,
      ...(sel.notBefore !== undefined && { not_before: certTime(sel.notBefore) }),
      ...(sel.notAfter !== undefined && { not_after: certTime(sel.notAfter) }),
    };
  }
  const chosen = ders.indexOf(sel.cert.der);
  if (chosen < 0) throw new Error("the chosen certificate is not one of the inputs");
  return {
    ok: true,
    chosen,
    issuer: sel.cert.issuer.name,
    serial: "0x" + sel.cert.serial.toString(16),
    card_modulus: "0x" + sel.cert.cardModulus.toString(16),
    not_before: certTime(sel.cert.notBefore),
    not_after: certTime(sel.cert.notAfter),
    name: sel.cert.name,
  };
}

export interface MaxAgeCase {
  /** `crl_max_age_days` of the server's config, as it is in the JSON (any value). */
  server_max_age_days: unknown;
  /** L, or null if the device does not read a config with this value. */
  max_age_days: number | null;
}

/** A config with one row the device reads, so only `crl_max_age_days` decides. */
export async function maxAgeResult(c: Omit<MaxAgeCase, "max_age_days">): Promise<number | null> {
  const body = { crl_max_age_days: c.server_max_age_days, platforms: [{ platform: "threads", display_name: "Threads", username_format: "[a-z0-9._]{1,30}" }] };
  const fetchFn: Fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    return crlMaxAge((await requestConfig(fetchFn)).crlMaxAgeDays);
  } catch (e) {
    if (e instanceof ServerError && e.code === "malformed_response") return null;
    throw e;
  }
}

export interface IndexCase {
  what: string;
  issuer: IssuerName;
  /** The whole of index.jsonl. */
  index: string;
  result: IndexResult;
}

export type IndexResult = { crl_number: string; sha256: string } | { problem: "crl_unavailable" };

export function indexResult(c: Omit<IndexCase, "result">): IndexResult {
  const r = chooseFromIndex(c.index, c.issuer);
  if ("code" in r) {
    if (r.code !== "crl_unavailable") throw new Error(`unexpected ${r.code}`);
    return { problem: "crl_unavailable" };
  }
  return { crl_number: r.crlNumber.toString(), sha256: r.sha256 };
}

export interface CrlCase {
  what: string;
  /** The issuer of the cardholder's certificate. */
  issuer: IssuerName;
  today: string;
  /** `crl_max_age_days` of the server's config, a value the device reads (see MaxAgeCase). */
  server_max_age_days: number;
  /** The highest CRL number this device has used for the issuer, or null. */
  highest: string | null;
  /**
   * The mirror's answers, by file name (`index.jsonl`, `<sha256>.crl`): the
   * HTTP status and the body (hex). A name not here is answered with 404.
   */
  mirror: Record<string, { status: number; body: string }>;
  /**
   * The serial number of the cardholder's certificate (0x-prefixed hex), in
   * the cases that say whether it is on the CRL. Without it, the certificate
   * is not on the CRL.
   */
  serial?: string;
  result: CrlResult;
}

export type CrlResult = (
  | { ok: true; crl_number: string; crl_date: string; sha256: string }
  | { ok: false; problem: "crl_unavailable" | "crl_hash" }
  | { ok: false; problem: "crl_unusable"; reason: string }
  | { ok: false; problem: "crl_rollback"; crl_number: string; highest: string }
  | { ok: false; problem: "crl_stale"; days: number; max_age_days: number }
  /** The CRL passed, and the certificate's serial number is on it. */
  | { ok: false; problem: "revoked" }
) & {
  /** The highest CRL number the device remembers for the issuer afterwards. */
  highest_after: string | null;
};

export async function crlResult(c: Omit<CrlCase, "result">, issuers: readonly VectorIssuer[]): Promise<CrlResult> {
  const issuer = issuerKeys(issuers).find((k) => k.name === c.issuer);
  if (!issuer) throw new Error(`no issuer ${c.issuer}`);
  const fetchFn: Fetch = async (path) => {
    const m = /^\/crl\/(.+)$/.exec(path);
    const file = m ? c.mirror[m[1]!] : undefined;
    return file === undefined ? new Response(null, { status: 404 }) : new Response(bytesOfHex(file.body) as BodyInit, { status: file.status });
  };
  const store = memoryStore(c.highest === null ? {} : { [c.issuer]: BigInt(c.highest) });
  const highestAfter = () => store.get(c.issuer)?.toString() ?? null;
  try {
    const crl = await loadCrl({ fetch: fetchFn, issuer, today: day(c.today), maxAgeDays: crlMaxAge(c.server_max_age_days), store });
    // The page learns it from the tree it builds (test/crl.test.ts,
    // revocation-tree.json): a serial number is in the tree exactly when it
    // is one of the CRL's keys.
    if (c.serial !== undefined) {
      const serial = BigInt(c.serial);
      for (let n = 0; n < crl.count; n++) if (keyAt(crl.keys, n) === serial) return { ok: false, problem: "revoked", highest_after: highestAfter() };
    }
    return { ok: true, crl_number: crl.crlNumber.toString(), crl_date: formatDay(crl.crlDay), sha256: crl.sha256, highest_after: highestAfter() };
  } catch (e) {
    if (!(e instanceof RevocationError)) throw e;
    const p = e.problem;
    const h = highestAfter();
    switch (p.code) {
      case "crl_unavailable":
      case "crl_hash":
        return { ok: false, problem: p.code, highest_after: h };
      case "crl_unusable":
        return { ok: false, problem: p.code, reason: p.reason, highest_after: h };
      case "crl_rollback":
        return { ok: false, problem: p.code, crl_number: p.crlNumber.toString(), highest: p.highest.toString(), highest_after: h };
      case "crl_stale":
        return { ok: false, problem: p.code, days: p.days, max_age_days: p.maxDays, highest_after: h };
    }
  }
}
