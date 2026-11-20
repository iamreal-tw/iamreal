//! Crockford base32 as spec/README.md defines it: uppercase, no padding, no
//! check symbol; bytes read as a big-endian bit string cut into 5-bit groups
//! from the most significant bit, a final short group padded with zero bits.

pub const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The value of one character of the alphabet.
pub fn value_of(c: u8) -> Option<u8> {
    ALPHABET.iter().position(|a| *a == c).map(|i| i as u8)
}

pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() * 8).div_ceil(5));
    let mut acc: u32 = 0;
    let mut bits = 0;
    for b in bytes {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((acc >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(ALPHABET[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Decodes exactly `length` bytes from `text`, in its one spelling: only
/// characters of the alphabet (uppercase), exactly as many as `length`
/// bytes need, and zero padding bits. `None` otherwise.
pub fn decode_strict(text: &[u8], length: usize) -> Option<Vec<u8>> {
    if text.len() != (length * 8).div_ceil(5) {
        return None;
    }
    let mut out = Vec::with_capacity(length);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in text {
        acc = (acc << 5) | u32::from(value_of(*c)?);
        bits += 5;
        if bits >= 8 {
            out.push(((acc >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
        acc &= (1 << bits) - 1;
    }
    // What is left are the padding bits.
    (acc == 0 && out.len() == length).then_some(out)
}
