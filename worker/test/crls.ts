// The test's issuer keys, and CRLs signed by them: what the fake MOICA
// serves when a test needs a CRL the mirror finds usable. Nothing here
// comes from MOICA.
//
// The keys are made on the spot, once per process. The private halves stay
// in this process's memory, to sign the test's CRLs; they are written to no
// file and are in no build (ADR-0028).
import { type KeyObject, createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IssuerKey, IssuerName } from "../src/issuers.ts";
import { WORKER_DIR } from "./build.ts";

const SIZES = { G2: 2048, G3: 4096 } as const;

const modulusOf = (key: KeyObject): string => Buffer.from(key.export({ format: "jwk" }).n!, "base64url").toString("hex");

let made: Record<IssuerName, { publicKey: KeyObject; privateKey: KeyObject }> | undefined;

function keys(): NonNullable<typeof made> {
  made ??= {
    G2: generateKeyPairSync("rsa", { modulusLength: SIZES.G2, publicExponent: 65537 }),
    G3: generateKeyPairSync("rsa", { modulusLength: SIZES.G3, publicExponent: 65537 }),
  };
  return made;
}

/** The test's issuer keys, as the test build takes them. */
export function testIssuers(): IssuerKey[] {
  return (["G2", "G3"] as const).map((name) => ({ name, modulus: modulusOf(keys()[name].publicKey), bits: SIZES[name] }));
}

/** A test issuer key's public half as SubjectPublicKeyInfo in DER, the form `iamreal-crl -key-g2` reads. */
export const testIssuerSpki = (issuer: IssuerName): Uint8Array => new Uint8Array(keys()[issuer].publicKey.export({ format: "der", type: "spki" }));

/** Where crl/testdata/ is: the Go crl/'s synthetic CRLs and what each must give. */
export const CRL_TESTDATA = join(WORKER_DIR, "..", "crl", "testdata");

/**
 * The key that signed the CRLs of crl/testdata/, as an issuer key named
 * G2: it has 2048 bits. Only its public half exists.
 */
export function testdataIssuer(): IssuerKey {
  const key = createPublicKey({ key: readFileSync(join(CRL_TESTDATA, "issuer-public-key.der")), format: "der", type: "spki" });
  return { name: "G2", modulus: modulusOf(key), bits: 2048 };
}

/**
 * Where cmd/iamreal-verify/testdata/card-proofs/ is: thirteen card proofs
 * with real proofs, the CRLs they were made against, and the public halves
 * of the two throwaway keys that signed the cards' certificates and those
 * CRLs (its README.md).
 */
export const CARD_PROOF_TESTDATA = join(WORKER_DIR, "..", "cmd", "iamreal-verify", "testdata", "card-proofs");

/** The issuer keys of that directory, as the test build takes them. Only their public halves exist. */
export function cardProofIssuers(): IssuerKey[] {
  return (["G2", "G3"] as const).map((name) => {
    const key = createPublicKey({ key: readFileSync(join(CARD_PROOF_TESTDATA, `issuer-${name}.der`)), format: "der", type: "spki" });
    return { name, modulus: modulusOf(key), bits: SIZES[name] };
  });
}

/** One DER element: the tag, the length, and the parts as its content. */
export const der = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const content = Buffer.concat(parts);
  const n = content.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >>> 8, n & 0xff] : [0x83, n >>> 16, (n >>> 8) & 0xff, n & 0xff];
  return Buffer.concat([Uint8Array.from([tag, ...length]), content]);
};
const integer = (x: bigint): Uint8Array => {
  let hex = x.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (Number.parseInt(hex[0]!, 16) >= 8) hex = `00${hex}`;
  return der(0x02, Buffer.from(hex, "hex"));
};
const oid = (...bytes: number[]): Uint8Array => der(0x06, Uint8Array.from(bytes));
const utcTime = (t: Date): Uint8Array => der(0x17, Buffer.from(`${t.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
const SHA256_WITH_RSA = der(0x30, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), der(0x05));

/** `n` serial numbers of 16 bytes that look random, as MOICA's do; the same `from` gives the same ones. */
export const randomSerials = (from: number, n: number): bigint[] =>
  Array.from({ length: n }, (_, i) => BigInt(`0x${createHash("sha256").update(String(from + i)).digest("hex").slice(0, 32)}`) >> 1n);

export interface TestCrl {
  /** Whose test key signs it. */
  readonly issuer: IssuerName;
  /** `cRLNumber`. */
  readonly number: bigint;
  readonly thisUpdate: Date;
  /** The revoked serial numbers; none by default. */
  readonly serials?: readonly bigint[];
  /** Extensions of the CRL after cRLNumber, each a whole `Extension` in DER. */
  readonly moreExtensions?: readonly Uint8Array[];
}

/** A complete CRL (RFC 5280 section 5) in DER, signed by a test issuer key. */
export function makeCrl(c: TestCrl): Uint8Array {
  const name = der(0x30, der(0x31, der(0x30, oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from(`Test issuer ${c.issuer}`)))));
  const revoked = (c.serials ?? []).map((serial) => der(0x30, integer(serial), utcTime(c.thisUpdate)));
  const tbs = der(
    0x30,
    integer(1n), // v2
    SHA256_WITH_RSA,
    name,
    utcTime(c.thisUpdate),
    utcTime(new Date(c.thisUpdate.getTime() + 36 * 3600 * 1000)),
    ...(revoked.length > 0 ? [der(0x30, ...revoked)] : []),
    der(0xa0, der(0x30, der(0x30, oid(0x55, 0x1d, 0x14), der(0x04, integer(c.number))), ...(c.moreExtensions ?? []))),
  );
  const signature = sign("sha256", tbs, keys()[c.issuer].privateKey);
  return new Uint8Array(der(0x30, tbs, SHA256_WITH_RSA, der(0x03, Uint8Array.from([0]), signature)));
}
