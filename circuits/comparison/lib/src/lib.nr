//! ONLY FOR THE COMPARISON against the circom circuit (ADR-0012). Not part of
//! the card proof circuit.
//!
//! The circom circuit splits a card proof into three proofs, `CertChainRSA256`
//! once and `UserSigRSA256` twice, linked by a commitment to the card's key.
//! The functions here give the parts of the card proof circuit the same shape,
//! so each part can be fed the same bytes as its circom counterpart. The key
//! commitment and `pk_blind` exist only here: the test cases that compare the
//! extracted key (a decoy modulus elsewhere in the certificate; the three
//! parts carry one key) compare it through the commitment, as circom does.
//!
//! circom's `UserSigRSA256` also has a public input `challenge`, referenced
//! only by a dummy square that restricts no value. The card proof circuit has
//! no such input (the challenge is bound through the declaration code), so
//! the signature parts here have none either: they keep exactly the checks of
//! the card proof circuit. Whatever challenge circom is given, it accepts or
//! rejects the same.
use card_proof::certificate::valid_certificate;
use card_proof::der::{MAX_TBS_LEN, modulus_limbs};
use card_proof::hash::chunked_hash;
use card_proof::rsa::rsa_key;
use card_proof::signature::{
    is_declaration_code_kind, is_scope_kind, MESSAGE_LEN, nullifier, pack, signed_by,
};
use card_proof::smt::SMT_DEPTH;

mod tests;

/// Commitment to a 2048-bit RSA modulus, blinded by `pk_blind`. The limbs must
/// be canonical (120 bits each, 8 for the top one) so one key has one encoding.
pub fn pk_commit(modulus: [u128; 18], pk_blind: Field) -> Field {
    let mut inputs: [Field; 19] = [0; 19];
    for i in 0..18 {
        inputs[i] = modulus[i] as Field;
    }
    inputs[18] = pk_blind;
    chunked_hash::<19>(inputs)
}

/// Counterpart of `CertChainRSA256`: the certificate part of the card proof
/// circuit, returning a blinded commitment to the certificate's public key.
///
/// Public: `issuer_modulus`, `smt_root`, `current_time`, and the return value.
pub fn cert_chain<let K: u32, let BITS: u32>(
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
    pk_blind: Field,
) -> Field {
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
    pk_commit(modulus_limbs(cert.modulus), pk_blind)
}

/// Outputs of `user_sig_scope`.
pub struct UserSigScope {
    pub pk_commit: Field,
    pub nullifier: Field,
    pub scope_packed: Field,
}

/// Counterpart of `UserSigRSA256` run on the scope string: the scope-string
/// part of the card proof circuit, with the card's key as a private input and
/// a commitment to it as an output.
pub fn user_sig_scope(
    scope: [u8; MESSAGE_LEN],
    user_modulus: [u128; 18],
    user_redc: [u128; 18],
    user_signature: [u128; 18],
    pk_blind: Field,
) -> UserSigScope {
    assert(is_scope_kind(scope[0]), "not a scope string");
    signed_by(rsa_key(user_modulus, user_redc), scope, user_signature);

    UserSigScope {
        pk_commit: pk_commit(user_modulus, pk_blind),
        nullifier: nullifier(user_signature),
        scope_packed: pack(scope),
    }
}

/// Outputs of `user_sig_code`.
pub struct UserSigCode {
    pub pk_commit: Field,
    pub declaration_code_packed: Field,
}

/// Counterpart of `UserSigRSA256` run on the declaration code: the
/// declaration-code part of the card proof circuit. No nullifier.
pub fn user_sig_code(
    declaration_code: [u8; MESSAGE_LEN],
    user_modulus: [u128; 18],
    user_redc: [u128; 18],
    user_signature: [u128; 18],
    pk_blind: Field,
) -> UserSigCode {
    assert(is_declaration_code_kind(declaration_code[0]), "not a declaration code");
    signed_by(
        rsa_key(user_modulus, user_redc),
        declaration_code,
        user_signature,
    );

    UserSigCode {
        pk_commit: pk_commit(user_modulus, pk_blind),
        declaration_code_packed: pack(declaration_code),
    }
}
