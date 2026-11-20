//! The two hashes the other half takes from its caller
//! (`iamreal_device_checks::hash`), as this half provides them: SHA-256
//! from the `sha2` crate, Poseidon2 from Barretenberg.

use barretenberg_rs::{BarretenbergApi, backends::FfiBackend};
use iamreal_device_checks::field::{Fe, is_field_element};
use iamreal_device_checks::hash::{HashFailed, Poseidon2, Sha256};

/// SHA-256.
pub struct Sha2;

impl Sha256 for Sha2 {
    fn sha256(&mut self, data: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        sha2::Sha256::digest(data).into()
    }
}

/// Barretenberg, linked into this library. One value is used by one thread
/// at a time; a second thread makes its own.
pub struct Barretenberg {
    api: BarretenbergApi<FfiBackend>,
}

impl Barretenberg {
    pub fn new() -> Result<Barretenberg, HashFailed> {
        let backend = FfiBackend::new().map_err(|_| HashFailed)?;
        Ok(Barretenberg {
            api: BarretenbergApi::new(backend),
        })
    }
}

impl Poseidon2 for Barretenberg {
    fn poseidon2(&mut self, inputs: &[Fe]) -> Result<Fe, HashFailed> {
        // spec/scoped-id.md defines it for 2 or 3 field elements; Barretenberg
        // would take other lengths and reduce larger integers.
        if !(inputs.len() == 2 || inputs.len() == 3) || !inputs.iter().all(is_field_element) {
            return Err(HashFailed);
        }
        let response = self
            .api
            .poseidon2_hash(inputs.iter().map(|x| x.to_vec()).collect())
            .map_err(|_| HashFailed)?;
        response.hash.as_slice().try_into().map_err(|_| HashFailed)
    }
}
