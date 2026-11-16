// The BN254 scalar field and the 32-byte form of a public input
// (spec/scoped-id.md, spec/proof-verification.md).
import { bytesOfBigint } from "../bytes.ts";

export const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/** A public input as bb reads it: 32 bytes, big-endian. */
export function fieldBytes(x: bigint): Uint8Array {
  if (x < 0n || x >= P) throw new Error("not a field element");
  return bytesOfBigint(x, 32);
}

/** Packs 31 bytes as b[0] + b[1]·256 + … + b[30]·256^30 (spec/scope.md). */
export function pack31(bytes: Uint8Array): bigint {
  if (bytes.length !== 31) throw new Error("not 31 bytes");
  let x = 0n;
  for (let i = 30; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
  return x;
}
