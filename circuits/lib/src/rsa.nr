use bignum::{params::BigNumParams, RuntimeBigNum};
use noir_rsa::pkcs1v15::verify_sha256_pkcs1v15;

/// An RSA key of `BITS` bits in `K` limbs of 120 bits.
///
/// `BigNumParams::new` range-checks the limbs of `modulus` and requires its top
/// bit to be set, so the key is exactly `BITS` long. That is the behaviour of
/// noir-bignum v0.11.0 and later; earlier versions check neither. The card key
/// does not depend on it: `der.nr` requires the top bit of the modulus it
/// reads, and `modulus_limbs` builds every limb from bytes. `redc` only steers
/// unconstrained witness computation.
pub fn rsa_key<let K: u32, let BITS: u32>(
    modulus: [u128; K],
    redc: [u128; K],
) -> BigNumParams<K, BITS> {
    BigNumParams::new(false, modulus, redc)
}

/// The one accepted encoding of a signature under `key`.
///
/// The nullifier is a hash of the signature limbs, so a second accepted
/// encoding of the same signature would be a second nullifier. Two checks give
/// a signature exactly one, and both are made here rather than left to what
/// the library happens to check inside a multiplication:
///   - `from_array` range-checks every limb (120 bits; the top limb the
///     remaining `BITS - 120 * (K - 1)` bits), so an integer has one encoding;
///   - `validate_in_field` requires the integer to be below the modulus, so a
///     residue has one integer (`s`, not `s + n`). It says nothing about the
///     width of a limb.
pub fn canonical_signature<let K: u32, let BITS: u32>(
    key: BigNumParams<K, BITS>,
    signature: [u128; K],
) -> RuntimeBigNum<K, BITS> {
    let signature: RuntimeBigNum<K, BITS> = RuntimeBigNum::from_array(key, signature);
    signature.validate_in_field();
    signature
}

/// RSASSA-PKCS1-v1_5 with SHA-256 and exponent 65537, under `key`. Only the
/// canonical encoding of the signature is accepted.
pub fn verify_rsa_sha256_with<let K: u32, let BITS: u32>(
    digest: [u8; 32],
    key: BigNumParams<K, BITS>,
    signature: [u128; K],
) {
    assert(verify_sha256_pkcs1v15(digest, canonical_signature(key, signature), 65537));
}

pub fn verify_rsa_sha256<let K: u32, let BITS: u32>(
    digest: [u8; 32],
    modulus: [u128; K],
    redc: [u128; K],
    signature: [u128; K],
) {
    verify_rsa_sha256_with(digest, rsa_key::<K, BITS>(modulus, redc), signature);
}
