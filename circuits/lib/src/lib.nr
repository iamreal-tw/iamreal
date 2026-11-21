//! The circuit of the one proof made per card proof (ADR-0013). The proof
//! states that the key of a valid citizen's primary-card certificate signed
//! this scope string and this declaration code, without revealing the
//! certificate, the key or the signatures.
//!
//! This file only joins the parts. Each part is a function of its own module,
//! and each is compared case by case against the circom circuit
//! (`comparison/`, ADR-0012). This joining layer has no circom counterpart.
pub mod der;
pub mod hash;
pub mod rsa;
pub mod smt;
pub mod certificate;
pub mod signature;

use certificate::valid_certificate;
use der::{MAX_TBS_LEN, modulus_limbs};
use rsa::rsa_key;
use signature::{is_declaration_code_kind, is_scope_kind, MESSAGE_LEN, nullifier, pack, signed_by};
use smt::SMT_DEPTH;

/// Public outputs of a card proof, in this order.
pub struct CardProof {
    /// Hash of the card's signature over the scope string: the scoped_id.
    pub nullifier: Field,
    /// The 31 bytes of the scope string, packed little-endian.
    pub scope_packed: Field,
    /// The 31 bytes of the declaration code, packed little-endian.
    pub declaration_code_packed: Field,
}

/// Public inputs: `issuer_modulus`, `smt_root`, `current_time`, then the
/// return value. Everything else is private.
///
/// The card's key is read from the certificate and used directly for both
/// signature checks; it never leaves the circuit.
///
/// The server's challenge is not an input. It is bound through the declaration
/// code, which the verifier recomputes from the challenge: a code computed
/// from another challenge carries no signature by this card.
pub fn card_proof<let K: u32, let BITS: u32>(
    tbs: [u8; MAX_TBS_LEN],
    tbs_len: u32,
    issuer_modulus: [u128; K],
    issuer_redc: [u128; K],
    issuer_signature: [u128; K],
    smt_root: Field,
    smt_siblings: [Field; SMT_DEPTH],
    smt_old_key: Field,
    smt_old_value: Field,
    smt_is_old0: bool,
    current_time: Field,
    card_redc: [u128; 18],
    scope: [u8; MESSAGE_LEN],
    scope_signature: [u128; 18],
    declaration_code: [u8; MESSAGE_LEN],
    declaration_code_signature: [u128; 18],
) -> CardProof {
    let cert = valid_certificate::<K, BITS>(
        tbs,
        tbs_len,
        issuer_modulus,
        issuer_redc,
        issuer_signature,
        smt_root,
        smt_siblings,
        smt_old_key,
        smt_old_value,
        smt_is_old0,
        current_time,
    );
    let card_key = rsa_key(modulus_limbs(cert.modulus), card_redc);

    assert(is_scope_kind(scope[0]), "not a scope string");
    signed_by(card_key, scope, scope_signature);

    assert(is_declaration_code_kind(declaration_code[0]), "not a declaration code");
    signed_by(card_key, declaration_code, declaration_code_signature);

    CardProof {
        nullifier: nullifier(scope_signature),
        scope_packed: pack(scope),
        declaration_code_packed: pack(declaration_code),
    }
}
