// A small world of test keys for the flow: two throwaway issuer keys standing
// in for G2 (2048) and G3 (4096), one card with a signing and an encryption
// certificate, CRLs signed by the issuer, and the mirror's index. Runs in
// Node (tests) and writes what the headless browser test needs.
import { sha256Hex } from "../../src/bytes.ts";
import type { IssuerKey, IssuerName } from "../../src/issuers.ts";
import { AUTHORITY_KEY_ID, KEY_USAGE_ENCRYPTION, SUBJECT_KEY_ID, buildTbs, certificate, name } from "./certs.ts";
import { indexLine, makeCrl } from "./crls.ts";
import { type TestKey, hex, makeKey } from "./der-build.ts";

export interface World {
  issuerKeys: Record<IssuerName, TestKey>;
  issuers: IssuerKey[];
  /** The issuer of the card's certificates. */
  issuer: IssuerName;
  card: TestKey;
  signingCert: Uint8Array;
  encryptionCert: Uint8Array;
  serial: bigint;
}

export const SERIAL_HEX = "1234567890abcdef1234567890abcdef";

let cached: Promise<Record<IssuerName, TestKey>> | null = null;
/** The issuer keys take a moment (RSA 4096); tests share them. */
export const testIssuerKeys = (): Promise<Record<IssuerName, TestKey>> =>
  (cached ??= Promise.all([makeKey(2048), makeKey(4096)]).then(([g2, g3]) => ({ G2: g2, G3: g3 })));

export async function makeWorld(opts: { issuer?: IssuerName; notBefore?: string; notAfter?: string; name?: string } = {}): Promise<World> {
  const issuerKeys = await testIssuerKeys();
  const issuer = opts.issuer ?? "G3";
  const card = await makeKey(2048);
  const tbs = (serial: string, leadingExtensions?: Uint8Array[]) =>
    buildTbs({ spki: card.spki, serial: hex(serial), notBefore: opts.notBefore, notAfter: opts.notAfter, subject: name(opts.name ?? "測試用戶"), leadingExtensions });
  const signingCert = await certificate(tbs(SERIAL_HEX), issuerKeys[issuer]);
  const encryptionCert = await certificate(
    tbs("2234567890abcdef1234567890abcdef", [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION]),
    issuerKeys[issuer],
  );
  return {
    issuerKeys,
    issuers: [
      { name: "G2", modulus: issuerKeys.G2.modulus, bits: 2048 },
      { name: "G3", modulus: issuerKeys.G3.modulus, bits: 4096 },
    ],
    issuer,
    card,
    signingCert,
    encryptionCert,
    serial: BigInt("0x" + SERIAL_HEX),
  };
}

export interface MirrorFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * The mirror's static files for one CRL: `/crl/index.jsonl` and the file. The
 * index's `root` is a placeholder: the device never reads it (and the test
 * checks that a wrong one changes nothing).
 */
export async function mirror(
  w: World,
  crls: { serials: bigint[]; crlNumber: bigint; thisUpdate: Date; extraExtensions?: Uint8Array[]; signWith?: TestKey; indexSha?: string }[],
): Promise<MirrorFile[]> {
  const files: MirrorFile[] = [];
  const lines: string[] = [];
  for (const c of crls) {
    const der = await makeCrl({ issuer: c.signWith ?? w.issuerKeys[w.issuer], serials: c.serials, crlNumber: c.crlNumber, thisUpdate: c.thisUpdate, extraExtensions: c.extraExtensions });
    const sha = await sha256Hex(der);
    files.push({ path: `/crl/${sha}.crl`, bytes: der });
    const line = await indexLine({ issuer: w.issuer, crlNumber: c.crlNumber, thisUpdate: c.thisUpdate, der, root: "00".repeat(31) + "01" });
    lines.push(c.indexSha ? line.replace(sha, c.indexSha) : line);
  }
  files.push({ path: "/crl/index.jsonl", bytes: new TextEncoder().encode(lines.join("\n") + "\n") });
  return files;
}

/** Serials that look like MOICA's: 16 random bytes. */
export function randomSerials(n: number, seed = 1n): bigint[] {
  let s = seed;
  const next = () => (s = (s * 6364136223846793005n + 1442695040888963407n) % (1n << 64n));
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) out.push(((next() << 64n) | next()) >> 1n);
  return out;
}
