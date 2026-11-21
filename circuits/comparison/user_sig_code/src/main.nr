use comparison::{user_sig_code, UserSigCode};

// ONLY FOR THE COMPARISON: counterpart of circom's userSigRS2048 run on the
// declaration code.
fn main(
    declaration_code: [u8; 31],
    user_modulus: [u128; 18],
    user_redc: [u128; 18],
    user_signature: [u128; 18],
    pk_blind: Field,
) -> pub UserSigCode {
    user_sig_code(
        declaration_code,
        user_modulus,
        user_redc,
        user_signature,
        pk_blind,
    )
}
