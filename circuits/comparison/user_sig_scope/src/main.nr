use comparison::{user_sig_scope, UserSigScope};

// ONLY FOR THE COMPARISON: counterpart of circom's userSigRS2048 run on the
// scope string.
fn main(
    scope: [u8; 31],
    user_modulus: [u128; 18],
    user_redc: [u128; 18],
    user_signature: [u128; 18],
    pk_blind: Field,
) -> pub UserSigScope {
    user_sig_scope(scope, user_modulus, user_redc, user_signature, pk_blind)
}
