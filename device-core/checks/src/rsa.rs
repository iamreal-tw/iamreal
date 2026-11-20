//! Checking an RSA signature: RSASSA-PKCS1-v1_5 (RFC 8017 section 8.2.2)
//! with SHA-256 and the exponent 65537, as spec/device-checks.md
//! ("Issuer") states it. Verification only: there is no private key here.
//!
//! The arithmetic is written out so that this half of the core has no
//! dependencies. It has no branch and no memory access that depends on the
//! signature, and what it computes from the signature is overwritten
//! before it returns: the card's own signatures are checked with it too.

/// The DigestInfo of SHA-256, with its NULL parameters.
const DIGEST_INFO: [u8; 19] = [
    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05,
    0x00, 0x04, 0x20,
];

/// `00 01`, at least eight `FF`, `00`, the DigestInfo and the hash.
const SMALLEST_BLOCK: usize = 2 + 8 + 1 + DIGEST_INFO.len() + 32;

fn wipe_words(words: &mut [u64]) {
    words.fill(0);
    // Keeps the compiler from dropping the write as dead.
    std::hint::black_box(words);
}

/// Big-endian bytes, a multiple of 8 of them, as 64-bit words, least
/// significant first.
fn words_of(bytes: &[u8]) -> Vec<u64> {
    bytes
        .rchunks_exact(8)
        .map(|chunk| u64::from_be_bytes(chunk.try_into().expect("8 bytes")))
        .collect()
}

/// `a - b` in `out`; returns the borrow.
fn subtract(a: &[u64], b: &[u64], out: &mut [u64]) -> u64 {
    let mut borrow = 0u64;
    for ((x, y), o) in a.iter().zip(b).zip(out.iter_mut()) {
        let (d, b1) = x.overflowing_sub(*y);
        let (d, b2) = d.overflowing_sub(borrow);
        *o = d;
        borrow = u64::from(b1) | u64::from(b2);
    }
    borrow
}

/// Replaces `x` by `x - n` when `extra` (the word above `x`) is set or
/// `x >= n`, without branching on the values.
fn reduce_once(x: &mut [u64], extra: u64, n: &[u64], scratch: &mut [u64]) {
    let borrow = subtract(x, n, scratch);
    // Subtract when the difference did not go below zero, or when the
    // word above made x larger than any n.
    let take = (extra | (1 - borrow)).wrapping_neg();
    for (x, d) in x.iter_mut().zip(scratch.iter()) {
        *x = (*x & !take) | (*d & take);
    }
}

/// `-n^-1 mod 2^64` for an odd `n0`.
fn negated_inverse(n0: u64) -> u64 {
    // Newton's iteration doubles the number of correct low bits each time.
    let mut x = 1u64;
    for _ in 0..6 {
        x = x.wrapping_mul(2u64.wrapping_sub(n0.wrapping_mul(x)));
    }
    x.wrapping_neg()
}

struct Montgomery<'a> {
    n: &'a [u64],
    n0_inv: u64,
    /// `2^(128·k) mod n` for `k` words: what turns a number into its
    /// Montgomery form.
    r2: Vec<u64>,
}

impl<'a> Montgomery<'a> {
    /// `n` is odd and its highest bit is set.
    fn new(n: &'a [u64]) -> Montgomery<'a> {
        let k = n.len();
        let mut x = vec![0u64; k];
        let mut scratch = vec![0u64; k];
        x[0] = 1;
        // Doubling 128·k times, reducing each time, gives 2^(128·k) mod n.
        for _ in 0..128 * k {
            let mut carry = 0u64;
            for word in x.iter_mut() {
                let next = *word >> 63;
                *word = (*word << 1) | carry;
                carry = next;
            }
            reduce_once(&mut x, carry, n, &mut scratch);
        }
        Montgomery {
            n,
            n0_inv: negated_inverse(n[0]),
            r2: x,
        }
    }

    /// `a · b / 2^(64·k) mod n`, in `out`. `t` is scratch of `k + 2` words.
    fn multiply(&self, a: &[u64], b: &[u64], out: &mut [u64], t: &mut [u64]) {
        let k = self.n.len();
        t.fill(0);
        for bi in b {
            let mut carry = 0u128;
            for j in 0..k {
                let sum = u128::from(t[j]) + u128::from(a[j]) * u128::from(*bi) + carry;
                t[j] = sum as u64;
                carry = sum >> 64;
            }
            let sum = u128::from(t[k]) + carry;
            t[k] = sum as u64;
            t[k + 1] = (sum >> 64) as u64;

            let m = t[0].wrapping_mul(self.n0_inv);
            let mut carry = (u128::from(t[0]) + u128::from(m) * u128::from(self.n[0])) >> 64;
            for j in 1..k {
                let sum = u128::from(t[j]) + u128::from(m) * u128::from(self.n[j]) + carry;
                t[j - 1] = sum as u64;
                carry = sum >> 64;
            }
            let sum = u128::from(t[k]) + carry;
            t[k - 1] = sum as u64;
            t[k] = t[k + 1] + ((sum >> 64) as u64);
        }
        let extra = t[k];
        out.copy_from_slice(&t[..k]);
        reduce_once(out, extra, self.n, &mut t[..k]);
    }
}

/// `s^65537 mod n` as big-endian bytes, for `s < n`.
fn power_65537(s: &[u64], n: &[u64]) -> Vec<u8> {
    let k = n.len();
    let field = Montgomery::new(n);
    let mut t = vec![0u64; k + 2];
    let mut base = vec![0u64; k];
    let mut x = vec![0u64; k];
    let mut next = vec![0u64; k];
    field.multiply(s, &field.r2, &mut base, &mut t);
    x.copy_from_slice(&base);
    // 65537 = 2^16 + 1.
    for _ in 0..16 {
        field.multiply(&x, &x, &mut next, &mut t);
        std::mem::swap(&mut x, &mut next);
    }
    field.multiply(&x, &base, &mut next, &mut t);
    // Out of the Montgomery form: multiply by 1.
    let mut one = vec![0u64; k];
    one[0] = 1;
    field.multiply(&next, &one, &mut x, &mut t);
    let bytes = x.iter().rev().flat_map(|w| w.to_be_bytes()).collect();
    for words in [&mut t, &mut base, &mut x, &mut next] {
        wipe_words(words);
    }
    bytes
}

/// Whether `signature` is the signature of the message whose SHA-256 is
/// `digest`, under the key with `modulus` (big-endian) and the exponent
/// 65537. It is only if:
///
/// - its length is the modulus's length, with no byte added or removed;
/// - read as a big-endian integer, it is below the modulus;
/// - the decoded block is exactly `00 01`, `FF` bytes, `00`, the
///   DigestInfo of SHA-256 with its NULL parameters, and `digest`.
///
/// A modulus this function does not take (even, its highest bit not set,
/// a length that is not a multiple of 8 bytes, or too short for the
/// block) verifies nothing.
pub fn verify_pkcs1_sha256(modulus: &[u8], signature: &[u8], digest: &[u8; 32]) -> bool {
    let k = modulus.len();
    if k < SMALLEST_BLOCK || !k.is_multiple_of(8) || signature.len() != k {
        return false;
    }
    if modulus[0] & 0x80 == 0 || modulus[k - 1] & 1 == 0 {
        return false;
    }
    let n = words_of(modulus);
    let mut s = words_of(signature);
    let mut scratch = vec![0u64; n.len()];
    // s < n exactly when s - n borrows.
    let below = subtract(&s, &n, &mut scratch) == 1;
    wipe_words(&mut scratch);
    if !below {
        wipe_words(&mut s);
        return false;
    }
    let mut block = power_65537(&s, &n);
    wipe_words(&mut s);

    let padding_end = k - 1 - DIGEST_INFO.len() - 32;
    let mut differs = block[0] | (block[1] ^ 0x01) | block[padding_end];
    for b in &block[2..padding_end] {
        differs |= b ^ 0xff;
    }
    for (b, expected) in block[padding_end + 1..]
        .iter()
        .zip(DIGEST_INFO.iter().chain(digest))
    {
        differs |= b ^ expected;
    }
    crate::wipe(&mut block);
    differs == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_inverse_of_the_lowest_word() {
        for n0 in [1u64, 3, 0xffff_ffff_ffff_ffff, 0x1234_5678_9abc_def1] {
            assert_eq!(n0.wrapping_mul(negated_inverse(n0)), u64::MAX, "{n0}");
        }
    }

    /// A power modulo 2^128 − 1 (odd, its highest bit set, two words),
    /// against the same power computed with 128-bit arithmetic: modulo
    /// 2^128 − 1 the high half of a product folds onto the low half.
    #[test]
    fn a_power_modulo_two_words() {
        let n = u128::MAX;
        let s: u128 = 0x0123_4567_89ab_cdef_0fed_cba9_8765_4321;
        fn multiply(a: u128, b: u128) -> u128 {
            let low = u128::from(u64::MAX);
            let (a0, a1) = (a & low, a >> 64);
            let (b0, b1) = (b & low, b >> 64);
            let add = |x: u128, y: u128| -> u128 {
                let (sum, carry) = x.overflowing_add(y);
                let sum = sum + u128::from(carry);
                if sum == u128::MAX { 0 } else { sum }
            };
            // 2^64 times x, modulo 2^128 − 1: the two halves change places.
            let shifted = |x: u128| -> u128 { x.rotate_left(64) };
            // a·b = a1·b1·2^128 + (a1·b0 + a0·b1)·2^64 + a0·b0, and 2^128 = 1.
            let sum = add(a1 * b1, a0 * b0);
            let sum = add(sum, shifted(a1 * b0));
            add(sum, shifted(a0 * b1))
        }
        let mut expected = s;
        for _ in 0..16 {
            expected = multiply(expected, expected);
        }
        expected = multiply(expected, s);
        let words = |x: u128| [x as u64, (x >> 64) as u64];
        assert_eq!(power_65537(&words(s), &words(n)), expected.to_be_bytes());
    }
    /// A 512-bit key made for this test, and signatures made with its
    /// private exponent (Python, `pow(block, d, n)`) over blocks of 64
    /// bytes: the one of RFC 8017 section 9.2 for `DIGEST`, and blocks
    /// that differ from it in one place. Only the first verifies.
    #[test]
    fn only_the_exact_block_verifies() {
        use crate::hex::bytes_of_hex;
        const MODULUS: [u8; 64] = bytes_of_hex(
            b"bdd5dbe4df853d1a305d993cee7abf5e94a481752754217d3e60865e52a39f7f\
              2123de1a80c5466d1d248ee9938e4d558f7e26024e9a1c4770b19239781ce821",
        );
        const DIGEST: [u8; 32] =
            bytes_of_hex(b"8ba42ff5a6eb23d11fda18aec8630f5845e7d3176f5a01fd7865cc1fa8448e55");
        const GOOD: [u8; 64] = bytes_of_hex(
            b"a2bc4fd320b82aac34241318320fd2d9b8dc48db0f3f4ea0c19fa83e3e647316\
              78b9438ef7feabbb4ba2ba45c424f2208e21bb734cbcc7c89761c614f9abeea0",
        );
        const NOT_THE_BLOCK: [(&str, [u8; 64]); 7] = [
            (
                "block type 2",
                bytes_of_hex(
                    b"8e3c62ef37bbf347ba0bf7a994c9d65545a2d16988c91989bc15b455aa8fec50\
                      77849647a293ced811527406d646cc2fd9b7ab160046df29903711c45d21f849",
                ),
            ),
            (
                "one padding byte that is not FF",
                bytes_of_hex(
                    b"aedfaf6eceeec79e2f4d7f69aa74fa294f67bbdb550d79d78cd01dd5e39ddea5\
                      0a0ccbc99d15d6dac51c98ba04be973b07934f946752c9f68e990b6381163795",
                ),
            ),
            (
                "a padding of zeros",
                bytes_of_hex(
                    b"6b3a55402cbe04c89897e9329ae60511790a8b3cbbcebb2f7d87206be324cb7e\
                      91a8c9d815eda28f53ce8524281eabe8d022822081394955cddafca7809a2309",
                ),
            ),
            (
                "01 where the 00 after the padding is",
                bytes_of_hex(
                    b"8165130db23379c59f4dca11a2d1f2d40744fa4b3e24846b4098802923daa7c1\
                      97f380826aff7f3c574e872296637c537bdf2bc354abeff2c7bd35f4ab0f44bc",
                ),
            ),
            (
                "a DigestInfo without the NULL parameters",
                bytes_of_hex(
                    b"9179504acc0ff3f47cf591a900c0929e57bd9464ab22580e2184f2818e3e5a05\
                      bc8a1cac5054e81627e3eef2ee982fa2eab1578d65870f037a1cc9fa02131e97",
                ),
            ),
            (
                "another digest",
                bytes_of_hex(
                    b"1fa0e8d9bbb5273355fdc27866bdfacf72af798a238cb44f92dfa53a3f267a81\
                      29b6ed1ed8dcca5161dd736f6d7022d4f8b8d66fd3ced577f3cd13012d094670",
                ),
            ),
            (
                "a byte after the digest",
                bytes_of_hex(
                    b"9463ccfb68fab98f4d9557304e6ed89d146107ffe470671599800937cbef86c8\
                      972d9af0258bde8eb399063563a0adc7014098d40e6cb8a4fede1a654f12f65e",
                ),
            ),
        ];
        assert!(verify_pkcs1_sha256(&MODULUS, &GOOD, &DIGEST));
        for (what, signature) in NOT_THE_BLOCK {
            assert!(
                !verify_pkcs1_sha256(&MODULUS, &signature, &DIGEST),
                "{what}"
            );
        }
        // The same number written with a byte more or a byte less.
        let longer = [&[0u8][..], &GOOD].concat();
        assert!(!verify_pkcs1_sha256(&MODULUS, &longer, &DIGEST));
        assert!(!verify_pkcs1_sha256(&MODULUS, &GOOD[1..], &DIGEST));
        // A modulus this function does not take.
        let mut even = MODULUS;
        even[63] &= 0xfe;
        assert!(!verify_pkcs1_sha256(&even, &GOOD, &DIGEST));
        assert!(!verify_pkcs1_sha256(&MODULUS[..56], &GOOD[..56], &DIGEST));
        assert!(!verify_pkcs1_sha256(&[], &[], &DIGEST));
    }
}
