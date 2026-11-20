//! The BN254 scalar field and the 32-byte form of a public input
//! (spec/scoped-id.md, spec/proof-verification.md).

/// A field element as a public input is written: 32 bytes, big-endian.
pub type Fe = [u8; 32];

/// The field modulus `p`.
pub const MODULUS: Fe = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

/// Whether the 32 big-endian bytes are an integer below `p`.
pub fn is_field_element(x: &Fe) -> bool {
    // Arrays of bytes compare as big-endian integers of the same length.
    *x < MODULUS
}

/// A small integer as a field element.
pub fn fe_of_u64(x: u64) -> Fe {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&x.to_be_bytes());
    out
}

/// Packs 31 bytes as `b[0] + b[1]·256 + … + b[30]·256^30` (spec/scope.md,
/// "Packing"). 31 bytes are always below `p`.
pub fn pack31(bytes: &[u8; 31]) -> Fe {
    let mut out = [0u8; 32];
    for (i, b) in bytes.iter().enumerate() {
        out[31 - i] = *b;
    }
    out
}
