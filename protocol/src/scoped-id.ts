// The scoped ID (spec/scoped-id.md): computed from the card's signature over
// the scope string, written as text, and its short ID.
import { bigintOfBytes, bytesOfBigint, limbs } from "./bytes.ts";
import { decodeBase32Strict, encodeBase32 } from "./base32.ts";
import { P } from "./field.ts";

/** Poseidon2 of two field elements, as Barretenberg computes it. */
export type Hash2 = (a: bigint, b: bigint) => Promise<bigint>;

/** The 18 limbs of 120 bits of a 256-byte signature, least significant first. */
export function signatureLimbs(signature: Uint8Array): bigint[] {
  if (signature.length !== 256) throw new Error("signature is not 256 bytes");
  return limbs(bigintOfBytes(signature), 120, 18);
}

/**
 * state = 0; for each limb: state = Poseidon2(state, limb). The signature
 * must already be checked to be below the card's modulus (the circuit
 * requires it; a larger one gives no proof).
 */
export async function scopedId(signature: Uint8Array, hash2: Hash2): Promise<bigint> {
  let state = 0n;
  for (const limb of signatureLimbs(signature)) state = await hash2(state, limb);
  return state;
}

/** 32 bytes little-endian, base32: 52 characters. */
export function scopedIdText(id: bigint): string {
  if (id < 0n || id >= P) throw new Error("not a field element");
  return encodeBase32(bytesOfBigint(id, 32).reverse());
}

/** The strict parse: 52 characters, one spelling, below the field modulus. */
export function parseScopedId(text: string): bigint | null {
  const le = decodeBase32Strict(text, 32);
  if (le === null) return null;
  const id = bigintOfBytes(le.slice().reverse());
  return id < P ? id : null;
}

/** The length of the short ID (spec/scoped-id.md). */
export const SHORT_ID_LENGTH = 10;

/** The first 10 characters of the scoped ID's text form: the card's page names the card by them. */
export function shortId(text: string): string {
  return text.slice(0, SHORT_ID_LENGTH);
}
