use card_proof::{card_proof, CardProof};

// The card proof circuit for certificates issued under a 2048-bit issuer key
// (MOICA G2). Public inputs, in order: issuer_modulus, smt_root, current_time,
// then the return value (spec/proof-verification.md, "Public inputs").
fn main(
    tbs: [u8; 1536],
    tbs_len: u32,
    issuer_modulus: pub [u128; 18],
    issuer_redc: [u128; 18],
    issuer_signature: [u128; 18],
    smt_root: pub Field,
    smt_siblings: [Field; 128],
    smt_old_key: Field,
    smt_old_value: Field,
    smt_is_old0: bool,
    current_time: pub Field,
    card_redc: [u128; 18],
    scope: [u8; 31],
    scope_signature: [u128; 18],
    declaration_code: [u8; 31],
    declaration_code_signature: [u128; 18],
) -> pub CardProof {
    card_proof::<18, 2048>(
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
        card_redc,
        scope,
        scope_signature,
        declaration_code,
        declaration_code_signature,
    )
}
