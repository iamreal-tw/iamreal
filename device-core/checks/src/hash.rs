//! The two hashes of `spec/`, as the caller provides them.

use crate::field::Fe;

/// SHA-256 of `data`.
pub trait Sha256 {
    fn sha256(&mut self, data: &[u8]) -> [u8; 32];
}

/// `Poseidon2(x_1, …, x_n)` of spec/scoped-id.md, "Poseidon2", for `n` = 2
/// or 3 field elements: Barretenberg's sponge.
pub trait Poseidon2 {
    fn poseidon2(&mut self, inputs: &[Fe]) -> Result<Fe, HashFailed>;
}

/// The caller's hash did not give a result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HashFailed;
