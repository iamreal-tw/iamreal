//! The files the prover is given by the app, each checked against a
//! SHA-256 written here before it is used (ADR-0035): the compiled
//! circuit and its verification key, and the two files of Barretenberg's
//! common reference string. An app that carries other bytes stops the
//! card proof; no server chooses the circuit.

use iamreal_device_checks::hash::Sha256;
use iamreal_device_checks::hex::bytes_of_hex;
use iamreal_device_checks::issuers::IssuerName;

/// The SHA-256 of one circuit's two files.
#[derive(Debug, Clone, Copy)]
pub struct CircuitFiles {
    /// The compiled circuit, as in `web/circuits/`.
    pub circuit: [u8; 32],
    /// Its verification key, as in `verifier/vk/`.
    pub verification_key: [u8; 32],
}

/// The SHA-256 of every file the prover takes.
#[derive(Debug, Clone, Copy)]
pub struct Artifacts {
    /// `card_proof_rs2048`, for certificates issued with G2.
    pub rs2048: CircuitFiles,
    /// `card_proof_rs4096`, for certificates issued with G3.
    pub rs4096: CircuitFiles,
    /// The first 2^18 points of G1, compressed (8 MiB).
    pub crs_g1: [u8; 32],
    /// The point of G2.
    pub crs_g2: [u8; 32],
}

/// The files of this version of the core: the circuits of
/// `web/circuits/README.md`, and the common reference string of
/// `device-core/crs.sha256`.
pub const BUILT_IN: Artifacts = Artifacts {
    rs2048: CircuitFiles {
        circuit: bytes_of_hex(b"8bd668a500df0109111e91ecac6c14554d2d9875b13cf8b9edf7bc194bf73de5"),
        verification_key: bytes_of_hex(
            b"816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8",
        ),
    },
    rs4096: CircuitFiles {
        circuit: bytes_of_hex(b"9ee2aa5001acf3b7f78c09d8a7d1d68e13948073b7fcadea6fc6ab0596a6705a"),
        verification_key: bytes_of_hex(
            b"bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2",
        ),
    },
    crs_g1: bytes_of_hex(b"5107a7926d504236331b4872b7218a1ca18921b5358d894822576e1aeb684934"),
    crs_g2: bytes_of_hex(b"01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f"),
};

impl Artifacts {
    /// The files of the circuit that proves a certificate of `issuer`
    /// (spec/issuers.md).
    pub fn circuit_of(&self, issuer: IssuerName) -> &CircuitFiles {
        match issuer {
            IssuerName::G2 => &self.rs2048,
            IssuerName::G3 => &self.rs4096,
        }
    }

    /// Whether the four files are the ones written here, for the circuit
    /// of `issuer`.
    pub fn are(
        &self,
        issuer: IssuerName,
        circuit: &[u8],
        verification_key: &[u8],
        crs_g1: &[u8],
        crs_g2: &[u8],
        sha256: &mut impl Sha256,
    ) -> bool {
        let files = self.circuit_of(issuer);
        // Every file is hashed, whichever differs.
        let same = [
            sha256.sha256(circuit) == files.circuit,
            sha256.sha256(verification_key) == files.verification_key,
            sha256.sha256(crs_g1) == self.crs_g1,
            sha256.sha256(crs_g2) == self.crs_g2,
        ];
        same.iter().all(|s| *s)
    }
}
