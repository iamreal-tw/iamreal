//! The half of `device-core/` that never touches Barretenberg (ADR-0034):
//! the algorithms of `spec/`, and later the checks made on the device.
//!
//! Nothing here does I/O, and nothing here hashes by itself: SHA-256 and
//! Poseidon2 come from the caller ([`hash`]), as in `protocol/`. The crate
//! has no dependencies and no `unsafe`, so it can also be built for wasm.
//!
//! Errors are fixed names. They never carry a value read from a card, a
//! certificate, a CRL or an account. An answer that stops the card proof
//! carries its reason code and the details the specification says are
//! reported with it (a certificate's dates, CRL numbers, a number of
//! days), and nothing else.

pub mod base32;
pub mod certificate;
pub mod challenge;
pub mod circuit_inputs;
pub mod counts;
pub mod crl;
pub mod date;
pub mod declaration_code;
pub mod der;
pub mod field;
pub mod hash;
pub mod hex;
pub mod issuers;
pub mod key;
pub mod list_consequence;
pub mod record_rules;
pub mod revocation;
pub mod rsa;
pub mod scope;
pub mod scoped_id;
pub mod tree;
pub mod username_format;

/// Overwrites `bytes` with zeros: for signatures, certificates and what is
/// computed from them, once they are no longer needed. As far as safe Rust
/// goes: the compiler is asked, not forced, to keep the write.
pub fn wipe(bytes: &mut [u8]) {
    bytes.fill(0);
    // Keeps the compiler from dropping the write as dead.
    std::hint::black_box(bytes);
}
