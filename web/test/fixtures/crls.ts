// CRLs in MOICA's layout (v2, authorityKeyIdentifier and cRLNumber, each
// entry a non-critical reasonCode), signed by a test key.
import { sha256Hex } from "iamreal-protocol/bytes.ts";
import { type TestKey, hex, integer, seq, seqOf, signed, tlv, utcTime } from "./der-build.ts";
import { name } from "./certs.ts";

export interface CrlOptions {
  issuer: TestKey;
  serials: bigint[];
  crlNumber: bigint;
  thisUpdate: Date;
  /** Extra CRL extensions (for example issuingDistributionPoint). */
  extraExtensions?: Uint8Array[];
}

const ext = (oid: string, value: Uint8Array, critical = false): Uint8Array =>
  seq(tlv(0x06, hex(oid)), ...(critical ? [hex("0101ff")] : []), tlv(0x04, value));

export const AKI = ext("551d23", seq(tlv(0x80, new Uint8Array(20).fill(0xa1))));
/** issuingDistributionPoint with onlyContainsUserCerts: a partitioned CRL. */
export const IDP = ext("551d1c", seq(hex("8101ff")));
/** deltaCRLIndicator with BaseCRLNumber 1: a delta CRL. Not critical, so that it is the reason and not its criticality. */
export const DELTA = ext("551d1b", integer(1n));
const REASON = ext("551d15", hex("0a0101"));

export async function makeCrl(o: CrlOptions): Promise<Uint8Array> {
  const next = new Date(o.thisUpdate.getTime() + 36 * 3600_000);
  const entries = o.serials.map((s) => seq(integer(s), utcTime(o.thisUpdate), seq(REASON)));
  const tbs = seq(
    integer(1n),
    hex("300d06092a864886f70d01010b0500"),
    name("Test CA"),
    utcTime(o.thisUpdate),
    utcTime(next),
    ...(entries.length ? [seqOf(entries)] : []),
    tlv(0xa0, seq(AKI, ext("551d14", integer(o.crlNumber)), ...(o.extraExtensions ?? []))),
  );
  return signed(tbs, o.issuer);
}

/** One line of the mirror's archive index (spec/revocation-tree.md). */
export async function indexLine(o: { issuer: string; crlNumber: bigint; thisUpdate: Date; der: Uint8Array; root: string }): Promise<string> {
  const iso = (d: Date) => d.toISOString().slice(0, 19) + "Z";
  const tw = new Date(o.thisUpdate.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const next = new Date(o.thisUpdate.getTime() + 36 * 3600_000);
  return (
    `{"issuer":"${o.issuer}","crl_number":"${o.crlNumber}","this_update":"${iso(o.thisUpdate)}","next_update":"${iso(next)}",` +
    `"crl_date":"${tw}","sha256":"${await sha256Hex(o.der)}","root":"${o.root}"}`
  );
}
