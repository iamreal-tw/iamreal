//! The witness: the circuit's inputs run through Noir's ACVM, the one of
//! the Noir version the circuits were compiled with (`web/circuits/`).
//!
//! The compiled circuit is a file the app carries; the session checks its
//! SHA-256 before this reads it (ADR-0035). An error here is a fixed
//! name: what the ACVM reports can hold values of the witness, so it is
//! dropped unread.

use std::io::Read;

use acvm::acir::circuit::Program;
use acvm::acir::native_types::{Witness, WitnessMap, WitnessStack};
use acvm::pwg::{ACVM, ACVMStatus};
use acvm::{AcirField, FieldElement};
use base64::Engine;
use bn254_blackbox_solver::Bn254BlackBoxSolver;
use iamreal_device_checks::circuit_inputs::CircuitInputs;
use iamreal_device_checks::field::Fe;
use iamreal_device_checks::wipe;
use serde_json::Value;

/// Why there is no witness.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WitnessError {
    /// The file is not a compiled circuit this core runs, or its
    /// parameters are not the ones of spec/circuit-inputs.md.
    Circuit,
    /// The inputs do not satisfy the circuit: no proof exists for them.
    Unsatisfied,
}

/// A compiled circuit (`web/circuits/*.json`).
pub struct Circuit {
    program: Program<FieldElement>,
    /// The parameters in the circuit's order, with how many witnesses
    /// each takes.
    parameters: Vec<(String, usize)>,
    /// The circuit as Barretenberg takes it: not compressed.
    bytecode: Vec<u8>,
}

/// How many witnesses a parameter of this type takes. The circuits'
/// parameters are fields, integers, booleans and arrays of them.
fn width(abi_type: &Value) -> Option<usize> {
    match abi_type.get("kind")?.as_str()? {
        "field" | "integer" | "boolean" => Some(1),
        "array" => {
            let length = usize::try_from(abi_type.get("length")?.as_u64()?).ok()?;
            length.checked_mul(width(abi_type.get("type")?)?)
        }
        _ => None,
    }
}

fn gunzip(compressed: &[u8]) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    flate2::read::GzDecoder::new(compressed)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

impl Circuit {
    /// Reads the file: `abi.parameters`, and `bytecode` (base64 of the
    /// compressed program).
    pub fn read(file: &[u8]) -> Result<Circuit, WitnessError> {
        Circuit::read_file(file).ok_or(WitnessError::Circuit)
    }

    fn read_file(file: &[u8]) -> Option<Circuit> {
        let file: Value = serde_json::from_slice(file).ok()?;
        let parameters = file
            .get("abi")?
            .get("parameters")?
            .as_array()?
            .iter()
            .map(|parameter| {
                Some((
                    parameter.get("name")?.as_str()?.to_string(),
                    width(parameter.get("type")?)?,
                ))
            })
            .collect::<Option<Vec<_>>>()?;
        let compressed = base64::engine::general_purpose::STANDARD
            .decode(file.get("bytecode")?.as_str()?)
            .ok()?;
        let program = Program::deserialize_program(&compressed).ok()?;
        // One function, called by nobody: the witness is one map.
        if program.functions.len() != 1 {
            return None;
        }
        Some(Circuit {
            program,
            parameters,
            bytecode: gunzip(&compressed)?,
        })
    }

    /// The circuit as Barretenberg takes it.
    pub fn bytecode(&self) -> &[u8] {
        &self.bytecode
    }

    /// The parameters' values, in the circuit's order: witness 0, 1, 2, …
    fn initial_witness(&self, inputs: &CircuitInputs) -> Option<WitnessMap<FieldElement>> {
        let mut map = WitnessMap::new();
        let mut next = 0u32;
        for (name, width) in &self.parameters {
            let values = values_of(inputs, name)?;
            if values.len() != *width {
                return None;
            }
            for value in values {
                map.insert(Witness(next), value);
                next = next.checked_add(1)?;
            }
        }
        // Every input has a parameter.
        (self.parameters.len() == PARAMETERS).then_some(map)
    }

    /// Solves the circuit for `inputs`: the witness as Barretenberg takes
    /// it (the witness stack, not compressed). It holds the certificate
    /// and both signatures: the caller overwrites it after the proof.
    pub fn solve(&self, inputs: &CircuitInputs) -> Result<Vec<u8>, WitnessError> {
        let initial = self.initial_witness(inputs).ok_or(WitnessError::Circuit)?;
        let function = &self.program.functions[0];
        let solver = Bn254BlackBoxSolver;
        let mut acvm = ACVM::new(
            &solver,
            &function.opcodes,
            initial,
            &self.program.unconstrained_functions,
            &function.assert_messages,
        );
        match acvm.solve() {
            ACVMStatus::Solved => {}
            // What the failure says is not read: it can hold witness values.
            ACVMStatus::Failure(_) => return Err(WitnessError::Unsatisfied),
            // The circuits call nothing outside themselves.
            ACVMStatus::InProgress
            | ACVMStatus::RequiresForeignCall(_)
            | ACVMStatus::RequiresAcirCall(_) => return Err(WitnessError::Circuit),
        }
        let mut compressed = WitnessStack::from(acvm.finalize())
            .serialize()
            .map_err(|_| WitnessError::Circuit)?;
        let witness = gunzip(&compressed);
        wipe(&mut compressed);
        witness.ok_or(WitnessError::Circuit)
    }
}

/// The parameters of spec/circuit-inputs.md.
const PARAMETERS: usize = 16;

fn field(value: &Fe) -> FieldElement {
    FieldElement::from_be_bytes_reduce(value)
}

fn fields(values: &[Fe]) -> Vec<FieldElement> {
    values.iter().map(field).collect()
}

fn bytes(values: &[u8]) -> Vec<FieldElement> {
    values.iter().map(|b| FieldElement::from(*b)).collect()
}

/// The values of the parameter `name` (spec/circuit-inputs.md, "Inputs").
fn values_of(inputs: &CircuitInputs, name: &str) -> Option<Vec<FieldElement>> {
    Some(match name {
        "tbs" => bytes(&inputs.tbs),
        "tbs_len" => vec![FieldElement::from(inputs.tbs_len)],
        "issuer_modulus" => fields(&inputs.issuer_modulus),
        "issuer_redc" => fields(&inputs.issuer_redc),
        "issuer_signature" => fields(&inputs.issuer_signature),
        "smt_root" => vec![field(&inputs.smt_root)],
        "smt_siblings" => fields(&inputs.smt_siblings),
        "smt_old_key" => vec![field(&inputs.smt_old_key)],
        "smt_old_value" => vec![field(&inputs.smt_old_value)],
        "smt_is_old0" => vec![FieldElement::from(inputs.smt_is_old0)],
        "current_time" => vec![field(&inputs.current_time)],
        "card_redc" => fields(&inputs.card_redc),
        "scope" => bytes(&inputs.scope),
        "scope_signature" => fields(&inputs.scope_signature),
        "declaration_code" => bytes(&inputs.declaration_code),
        "declaration_code_signature" => fields(&inputs.declaration_code_signature),
        _ => return None,
    })
}
