// MOICA's issuer keys (spec/issuers.md), written into the page. The device
// checks its own certificate and the CRL against these keys and no others;
// no value from a server can add a key.
//
// Tests build the flow with throwaway keys instead (test/), the way
// verifier/'s tests inject theirs; the production entry point (index.ts)
// passes MOICA_ISSUERS and nothing else.
import { bytesOfBigint } from "iamreal-protocol/bytes.ts";

export type IssuerName = "G2" | "G3";
export type CircuitName = "card_proof_rs2048" | "card_proof_rs4096";

export interface IssuerKey {
  readonly name: IssuerName;
  /** The RSA modulus; the exponent is 65537. */
  readonly modulus: bigint;
  readonly bits: 2048 | 4096;
}

/** Which circuit proves a certificate of an issuer key of this size (spec/issuers.md). */
export const CIRCUIT_OF_BITS: Readonly<Record<2048 | 4096, { circuit: CircuitName; limbs: number }>> = Object.freeze({
  2048: Object.freeze({ circuit: "card_proof_rs2048", limbs: 18 }),
  4096: Object.freeze({ circuit: "card_proof_rs4096", limbs: 35 }),
} as const);

const G2_MODULUS = BigInt(
  "0x" +
    "9fd8089c05559d63d5ab34bc5df685fb5d2f44ba37ba5640238b00631ace7050" +
    "933509d0f9b6736ffea2a96820e1fbc0c5b21b3197e16d0d357a286395e75e64" +
    "402f37ae8fffcee2481c22a6558449e1352eb284424a2de2273617f60a5d4f7f" +
    "bb6564f1e93aa50ce8c4d30d83904009362a0160b5dd53e818f88f344af12e98" +
    "63e55268a4c81ba22094113875518cbf4d50195081d630aa402e2f9ea9384725" +
    "cfa8275423bb40bbd79cdd9d12371d0624b85a05f6f6223922c981551ea89e77" +
    "f04df3e22b93519fa37288717d2146b787b78703d5aa7ff1867f9c608f206e9c" +
    "6a39f00c2f2bfff9110a85bf15c25dae20b38a7f6f5a12026d08a1cbc681291d",
);

const G3_MODULUS = BigInt(
  "0x" +
    "ae5ae964e29305a7dec0863d7f57aa664086045a7fbe0deccf420acae2e5f78e" +
    "9c0634893c7efadcd029b71e44272cd2b893c4324dfb527138ea36fc45b19737" +
    "2a60bada7430bbb798b25322784f32075254ce077a62fc1d9fb7b16429874c3a" +
    "8322f4b03eabadb16efafc367d1e13fde62c99039c2ec4eae6a3873bd90c998a" +
    "e4a6e32ccf9b94813ff1bf2af6a5fec7906d627e2f1b8745281327f424d69b81" +
    "464ab09093a15030834a798444866bd8b459789cd731e5e4b102968b79195283" +
    "9d23aae00024f6049069e57eb91260e1241df2b75ac943613e8ddbe78e8d468a" +
    "fa6565cf4587620ed34a752173a5264fa23d59f5793f5fd65ac06dffa53ca004" +
    "5a9f1ebe466760b0737f4bd5e302ad7332b2ff352e825d50d4649f9825642368" +
    "267e8c52135fe3cf048c2ec5483d8c897fb0600e384eaaaf61093d0cb68ca1d2" +
    "bb5f808b9beff43901e1ab38e8d9183c624a96f8466441d0f9d1d2f594f336b9" +
    "402a2f952ab5db34adfbe207e9dbf92bcfbac26e638830bfc5ab83d1ad43c14a" +
    "ef52e3d8bdd1acb8566b13da632becd0b752f2b82fc42d8ef46dd91da2954e16" +
    "ac5dcbbf7e6a60f1bda0f146875668051375ae31370162b52d4b6e813c688a9c" +
    "8ea2daa3819dd58f8caf6f8efc400f705643dbc10956653a7341d35bfff03a3f" +
    "f0af783895710202601d1810d967212d675c326f8e39157f5e1c6731c525d8ef",
);

export const MOICA_ISSUERS: readonly IssuerKey[] = Object.freeze([
  Object.freeze({ name: "G2", modulus: G2_MODULUS, bits: 2048 }),
  Object.freeze({ name: "G3", modulus: G3_MODULUS, bits: 4096 }),
] as const);

/** Checks the shape of an issuer table: names G2 and G3 at most once, sizes as declared. */
export function checkIssuerTable(issuers: readonly IssuerKey[]): void {
  const names = new Set<string>();
  for (const k of issuers) {
    if (names.has(k.name)) throw new Error(`issuer ${k.name} twice`);
    names.add(k.name);
    if (k.modulus.toString(2).length !== k.bits) throw new Error(`issuer ${k.name} is not ${k.bits} bits`);
  }
}

const base64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** An RSA public key with exponent 65537 for WebCrypto's RSASSA-PKCS1-v1_5 with SHA-256. */
export async function importRsaKey(modulus: bigint, bits: number): Promise<CryptoKey> {
  const jwk: JsonWebKey = { kty: "RSA", n: base64url(bytesOfBigint(modulus, bits / 8)), e: "AQAB", alg: "RS256", ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

/** RSASSA-PKCS1-v1_5 / SHA-256 signature check. A signature of the wrong length fails. */
export async function rsaVerify(key: CryptoKey, bits: number, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  if (signature.length !== bits / 8) return false;
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, message as BufferSource);
}
