use crate::der::{Certificate, check_certificate, MAX_TBS_LEN};
use crate::rsa::verify_rsa_sha256;
use crate::smt::{assert_not_in_tree, SMT_DEPTH};
use sha256::sha256_var;

/// The certificate part of a card proof: `tbs` is a TBSCertificate signed by
/// the key `issuer_modulus`; it is a citizen's primary-card signing
/// certificate, valid at `current_time`; its serial number is not in the
/// revocation tree `smt_root`. Returns the serial number and the subject
/// public key.
///
/// These are the checks of `CertChainRSA256` in the circom circuit, without
/// its key commitment.
///
/// `K` limbs of 120 bits hold the `BITS`-bit issuer key (18 / 2048, 35 / 4096).
pub fn valid_certificate<let K: u32, let BITS: u32>(
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
) -> Certificate {
    let cert = check_certificate(tbs, tbs_len, current_time);

    let digest = sha256_var(tbs, tbs_len);
    verify_rsa_sha256::<K, BITS>(digest, issuer_modulus, issuer_redc, issuer_signature);

    assert_not_in_tree(
        smt_root,
        cert.serial,
        smt_siblings,
        smt_old_key,
        smt_old_value,
        smt_is_old0,
    );

    cert
}
