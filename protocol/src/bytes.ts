// Small byte and integer helpers shared by every other module. No I/O.

export function hexOf(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function bytesOfHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Unsigned big-endian bytes as an integer. */
export function bigintOfBytes(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt("0x" + hexOf(bytes));
}

/** `x` as exactly `length` big-endian bytes. Throws if it does not fit. */
export function bytesOfBigint(x: bigint, length: number): Uint8Array {
  if (x < 0n) throw new Error("negative");
  const hex = x.toString(16).padStart(length * 2, "0");
  if (hex.length > length * 2) throw new Error(`integer does not fit in ${length} bytes`);
  return bytesOfHex(hex);
}

export function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7e || c < 0x20) throw new Error("not printable ASCII");
    out[i] = c;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SHA-256 with WebCrypto (browser and Node). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return hexOf(await sha256(data));
}

/** `count` limbs of `bits` bits, least significant first. */
export function limbs(value: bigint, bits: number, count: number): bigint[] {
  const mask = (1n << BigInt(bits)) - 1n;
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) out.push((value >> BigInt(bits * i)) & mask);
  if (value >> BigInt(bits * count) !== 0n) throw new Error("value does not fit in the limbs");
  return out;
}

/** Overwrites a byte array with zeros. Used to drop signatures and certificates. */
export function wipe(bytes: Uint8Array | undefined | null): void {
  bytes?.fill(0);
}
