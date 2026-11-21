use card_proof::hash::{chunked_hash, hash_2, hash_3};
use card_proof::smt::{assert_not_in_tree, SMT_DEPTH};

// ONLY FOR TESTS: the circuit's field hash on its own, so its values can be
// compared with the fixed answers in spec/vectors/poseidon2.json. Returns
// hash_2, hash_3 and the hash chain over 18 elements (the nullifier of a
// signature with these limbs), and checks one non-membership proof.
fn main(
    pair: [Field; 2],
    triple: [Field; 3],
    chain: [Field; 18],
    smt_root: Field,
    smt_key: Field,
    smt_siblings: [Field; SMT_DEPTH],
    smt_old_key: Field,
    smt_old_value: Field,
    smt_is_old0: bool,
) -> pub (Field, Field, Field) {
    assert_not_in_tree(smt_root, smt_key, smt_siblings, smt_old_key, smt_old_value, smt_is_old0);
    (hash_2(pair), hash_3(triple), chunked_hash::<18>(chain))
}
