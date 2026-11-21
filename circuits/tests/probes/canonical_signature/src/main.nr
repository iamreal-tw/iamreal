use card_proof::rsa::{canonical_signature, rsa_key};

// ONLY FOR TESTS: `canonical_signature` on its own, with no RSA verification
// after it. The library's multiplication range-checks its factors too, so in
// the card proof circuit a wrong limb encoding is rejected twice; here only
// our own two checks stand between a value and acceptance.
fn main(modulus: [u128; 18], redc: [u128; 18], signature: [u128; 18]) {
    let _ = canonical_signature(rsa_key::<18, 2048>(modulus, redc), signature);
}
