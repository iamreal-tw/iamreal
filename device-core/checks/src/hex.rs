//! Byte strings written as hex in the source.

/// The bytes written as `2 × N` hex digits, at compile time.
pub const fn bytes_of_hex<const N: usize>(digits: &[u8]) -> [u8; N] {
    const fn value(digit: u8) -> u8 {
        match digit {
            b'0'..=b'9' => digit - b'0',
            b'a'..=b'f' => digit - b'a' + 10,
            _ => panic!("not a hex digit"),
        }
    }
    assert!(digits.len() == 2 * N);
    let mut out = [0u8; N];
    let mut i = 0;
    while i < N {
        out[i] = value(digits[2 * i]) * 16 + value(digits[2 * i + 1]);
        i += 1;
    }
    out
}
