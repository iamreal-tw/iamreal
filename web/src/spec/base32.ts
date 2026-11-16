// Crockford base32 as spec/README.md defines it: uppercase, no padding, no
// check symbol; bytes read as a big-endian bit string cut into 5-bit groups
// from the most significant bit, a final short group padded with zero bits.

export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Decodes exactly `length` bytes from `text`, in its one spelling: only
 * characters of the alphabet (uppercase), exactly as many as `length` bytes
 * need, and zero padding bits. Equivalently, re-encoding gives `text` back.
 * Returns null otherwise.
 */
export function decodeBase32Strict(text: string, length: number): Uint8Array | null {
  if (text.length !== Math.ceil((length * 8) / 5)) return null;
  const out = new Uint8Array(length);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[o++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) return null; // padding bits are not zero
  return encodeBase32(out) === text ? out : null;
}
