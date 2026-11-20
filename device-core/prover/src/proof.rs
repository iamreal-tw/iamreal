//! The proof: Barretenberg's UltraHonk, with the one set of settings a
//! record is verified under (spec/proof-verification.md): zero knowledge,
//! Poseidon2 transcript. No caller and no server chooses them.

use std::sync::{Mutex, PoisonError};

use barretenberg_rs::generated_types::{CircuitInput, ProofSystemSettings};
use barretenberg_rs::{BarretenbergApi, backends::FfiBackend};
use iamreal_device_checks::field::Fe;

/// The length of a proof (spec/record.md).
pub const PROOF_LENGTH: usize = 14_656;
/// The points of G1 in the file the app carries: 2^18, 32 bytes each.
const CRS_POINTS: u32 = 1 << 18;

/// Barretenberg made no proof.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProofFailed;

/// A proof and the public inputs it carries, in the circuit's order.
pub struct Proof {
    pub proof: Vec<u8>,
    pub public_inputs: Vec<Fe>,
}

fn settings() -> ProofSystemSettings {
    ProofSystemSettings {
        ipa_accumulation: false,
        oracle_hash_type: "poseidon2".to_string(),
        disable_zk: false,
        optimized_solidity_verifier: false,
    }
}

// Two things of Barretenberg 6.0.0 that its msgpack interface (`bbapi`)
// does not reach. The names are the ones in the static library that
// fetch-barretenberg.sh checks; a library without them does not link.
unsafe extern "C" {
    /// `bb::set_parallel_for_concurrency(size_t)`: how many threads the
    /// calling thread's work is split over (common/thread.cpp).
    #[link_name = "_ZN2bb28set_parallel_for_concurrencyEm"]
    fn bb_set_parallel_for_concurrency(count: usize);
    /// `bb::get_num_cpus()`: that number.
    #[cfg(feature = "testing")]
    #[link_name = "_ZN2bb12get_num_cpusEv"]
    fn bb_get_num_cpus() -> usize;
    /// `LogLevel bb_log_level` (common/log.hpp): an `int`, 0 is silent.
    static mut bb_log_level: i32;
}

/// The number of threads the core has Barretenberg prove with: the cores
/// this process may use.
pub fn threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get())
}

/// The number of threads Barretenberg splits this thread's work over.
/// For this directory's tests.
#[cfg(feature = "testing")]
pub fn barretenberg_threads() -> usize {
    // SAFETY: reads a thread-local of Barretenberg.
    unsafe { bb_get_num_cpus() }
}

/// Before a proof, on the thread that makes it:
///
/// - Barretenberg proves on as many threads as there are cores. The core
///   sets the number itself and does not leave it to Barretenberg (issue
///   #88). The setting is the calling thread's, so it is set every time,
///   and no environment variable is written.
/// - Barretenberg logs nothing. It would write a line for each step to
///   stderr, which on a phone is the system log.
fn configure() {
    // SAFETY: the first sets a thread-local of Barretenberg. The second
    // writes an `int` that Barretenberg reads before it logs; the caller
    // holds `PROVER`, and no code of the core writes it elsewhere.
    unsafe {
        bb_set_parallel_for_concurrency(threads());
        bb_log_level = 0;
    }
}

/// Barretenberg keeps the common reference string for the whole process.
/// One proof at a time: a second caller waits. The value says whether
/// the reference string was handed over.
static PROVER: Mutex<bool> = Mutex::new(false);

/// Proves `witness` for the circuit `bytecode` with the verification key
/// `verification_key`. `crs_g1` and `crs_g2` are the common reference
/// string; the caller has checked the SHA-256 of all four files. They are
/// handed to Barretenberg the first time, and it keeps them.
pub fn prove(
    bytecode: &[u8],
    verification_key: &[u8],
    witness: &[u8],
    crs_g1: &[u8],
    crs_g2: &[u8],
) -> Result<Proof, ProofFailed> {
    let mut initialized = PROVER.lock().unwrap_or_else(PoisonError::into_inner);
    configure();
    let backend = FfiBackend::new().map_err(|_| ProofFailed)?;
    let mut api = BarretenbergApi::new(backend);
    if !*initialized {
        api.srs_init_srs(crs_g1, CRS_POINTS, crs_g2)
            .map_err(|_| ProofFailed)?;
        *initialized = true;
    }
    let response = api
        .circuit_prove(
            CircuitInput {
                name: String::new(),
                bytecode: bytecode.to_vec(),
                verification_key: verification_key.to_vec(),
            },
            witness,
            settings(),
        )
        .map_err(|_| ProofFailed)?;
    let proof: Vec<u8> = response.proof.concat();
    let public_inputs = response
        .public_inputs
        .iter()
        .map(|x| Fe::try_from(x.as_slice()).map_err(|_| ProofFailed))
        .collect::<Result<Vec<Fe>, ProofFailed>>()?;
    if proof.len() != PROOF_LENGTH {
        return Err(ProofFailed);
    }
    Ok(Proof {
        proof,
        public_inputs,
    })
}

/// Whether Barretenberg accepts `proof` with `public_inputs` under
/// `verification_key`, with the same settings. For this directory's tests.
#[cfg(feature = "testing")]
pub fn verify(
    verification_key: &[u8],
    public_inputs: &[Fe],
    proof: &[u8],
) -> Result<bool, ProofFailed> {
    let backend = FfiBackend::new().map_err(|_| ProofFailed)?;
    let mut api = BarretenbergApi::new(backend);
    let response = api
        .circuit_verify(
            verification_key,
            public_inputs.iter().map(|x| x.to_vec()).collect(),
            proof.chunks(32).map(<[u8]>::to_vec).collect(),
            settings(),
        )
        .map_err(|_| ProofFailed)?;
    Ok(response.verified)
}
