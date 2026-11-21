use comparison::cert_chain;

// ONLY FOR THE COMPARISON: counterpart of circom's certChainRS4096.
fn main(
    tbs: [u8; 1536],
    tbs_len: u32,
    issuer_modulus: pub [u128; 35],
    issuer_redc: [u128; 35],
    issuer_signature: [u128; 35],
    smt_root: pub Field,
    smt_siblings: [Field; 128],
    smt_old_key: Field,
    smt_old_value: Field,
    smt_is_old0: bool,
    current_time: pub Field,
    pk_blind: Field,
) -> pub Field {
    cert_chain::<35, 4096>(
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
        pk_blind,
    )
}
