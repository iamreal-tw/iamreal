//! The field hash behind the revocation tree and the nullifier: Barretenberg's
//! Poseidon2 sponge over the BN254 scalar field (state width 4, 8 full and 56
//! partial rounds). It is a built-in gate of the proving system.
//!
//! The circom circuit uses circomlib's Poseidon over another field, so the
//! revocation tree and the nullifier have different values there.

use poseidon::poseidon2::Poseidon2;

pub fn hash_2(input: [Field; 2]) -> Field {
    Poseidon2::hash(input, 2)
}

pub fn hash_3(input: [Field; 3]) -> Field {
    Poseidon2::hash(input, 3)
}

/// Hash chain over field elements: `state = hash_2(state, x)` starting from 0.
/// Same construction as `ChunkedPoseidonP256` in the circom circuit.
pub fn chunked_hash<let N: u32>(inputs: [Field; N]) -> Field {
    let mut state: Field = 0;
    for i in 0..N {
        state = hash_2([state, inputs[i]]);
    }
    state
}
