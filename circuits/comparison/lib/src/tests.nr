// Counterparts of wallet-unit-poc/circom/tests/circuits/pk_commit.test.ts.
// Everything else is tested from tests/*.mjs, against the same bytes as the
// circom circuit.
use crate::pk_commit;
use card_proof::hash::chunked_hash;

fn key(first_limb: u128) -> [u128; 18] {
    let mut limbs: [u128; 18] = [0; 18];
    for i in 0..18 {
        limbs[i] = (i + 1) as u128;
    }
    limbs[0] = first_limb;
    limbs
}

#[test]
fn chain_differs_when_inputs_change() {
    assert(chunked_hash::<2>([1, 2]) != chunked_hash::<2>([1, 3]));
}

#[test]
fn chain_is_order_sensitive() {
    assert(chunked_hash::<2>([1, 2]) != chunked_hash::<2>([2, 1]));
}

#[test]
fn commit_is_the_same_for_the_same_key_and_blind() {
    assert(pk_commit(key(1), 0xdeadbeef) == pk_commit(key(1), 0xdeadbeef));
}

#[test]
fn commit_differs_for_another_blind() {
    assert(pk_commit(key(1), 0xdeadbeef) != pk_commit(key(1), 0xcafebabe));
}

#[test]
fn commit_differs_for_another_key() {
    assert(pk_commit(key(1), 0xdeadbeef) != pk_commit(key(99), 0xdeadbeef));
}
