//! The card's two signatures in a card proof. Each check here is also run on
//! its own against `UserSigRSA256` of the circom circuit (`comparison/`).
//!
//! The card signs two 31-byte messages per card proof. Their first byte says
//! which kind a message is (ADR-0007, ADR-0013):
//!
//!   scope string       `a`..`z` or `S`      its signature yields the nullifier
//!   declaration code   `A`..`Z` except `S`  no nullifier
//!
//! So a signature over one kind cannot stand in for the other: a signature on
//! a declaration code never yields a nullifier, and a scope-string signature
//! (which never changes) never passes as proof that the card signed just now.
//! The circom circuit has no such check.
use crate::hash::chunked_hash;
use crate::rsa::verify_rsa_sha256_with;
use bignum::params::BigNumParams;
use sha256::digest;

pub global MESSAGE_LEN: u32 = 31;

/// First byte of a scope string: a lowercase ASCII letter, or `S`.
pub fn is_scope_kind(first: u8) -> bool {
    ((first >= 0x61) & (first <= 0x7a)) | (first == 0x53)
}

/// First byte of a declaration code: an uppercase ASCII letter other than `S`.
pub fn is_declaration_code_kind(first: u8) -> bool {
    (first >= 0x41) & (first <= 0x5a) & (first != 0x53)
}

/// The 31 signed bytes packed little-endian into one field element.
pub fn pack(message: [u8; MESSAGE_LEN]) -> Field {
    let mut packed: Field = 0;
    for i in 0..MESSAGE_LEN {
        packed = packed * 256 + message[MESSAGE_LEN - 1 - i] as Field;
    }
    packed
}

/// `key` signed exactly the 31 bytes `message` (RSASSA-PKCS1-v1_5, SHA-256).
pub fn signed_by(key: BigNumParams<18, 2048>, message: [u8; MESSAGE_LEN], signature: [u128; 18]) {
    verify_rsa_sha256_with(digest(message), key, signature);
}

/// Hash chain over the 18 signature limbs. The signature is deterministic, so
/// this is a function of (key, message).
pub fn nullifier(signature: [u128; 18]) -> Field {
    let mut limbs: [Field; 18] = [0; 18];
    for i in 0..18 {
        limbs[i] = signature[i] as Field;
    }
    chunked_hash::<18>(limbs)
}
