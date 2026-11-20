//! The witness (Noir's ACVM) for the inputs of
//! spec/vectors/circuit-inputs.json: the circuits of web/circuits/ accept
//! every case, and refuse inputs that say anything else.

mod common;

use common::{TestSha256, cases, repo_file, text, unhex, vectors};
use iamreal_device_checks::certificate::{Selection, select_certificate};
use iamreal_device_checks::circuit_inputs::{CircuitInputs, circuit_inputs};
use iamreal_device_checks::date::Date;
use iamreal_device_checks::field::fe_of_u64;
use iamreal_device_checks::issuers::{IssuerKey, IssuerName};
use iamreal_device_checks::tree::AbsenceProof;
use iamreal_device_core::witness::{Circuit, WitnessError};
use serde_json::Value;

fn inputs_of(v: &Value, case: &Value) -> CircuitInputs {
    let issuers: Vec<(IssuerName, Vec<u8>)> = cases(v, "issuers")
        .iter()
        .map(|k| {
            (
                IssuerName::parse(text(k, "issuer")).unwrap(),
                unhex(text(k, "modulus")),
            )
        })
        .collect();
    let keys: Vec<IssuerKey<'_>> = issuers
        .iter()
        .map(|(name, modulus)| IssuerKey {
            name: *name,
            modulus,
        })
        .collect();
    let der = unhex(text(case, "certificate"));
    let today = Date::parse(b"2026-11-16").unwrap();
    let Selection::Chosen { certificate, .. } =
        select_certificate(&[&der], today, &keys, &mut TestSha256)
    else {
        panic!("the certificate of the case");
    };
    let path = &case["path"];
    let path = AbsenceProof {
        root: common::fe(text(path, "smt_root")),
        siblings: cases(path, "smt_siblings")
            .iter()
            .map(|x| common::fe(x.as_str().unwrap()))
            .collect(),
        is_old0: path["smt_is_old0"].as_bool().unwrap(),
        old_key: common::fe(text(path, "smt_old_key")),
        old_value: common::fe(text(path, "smt_old_value")),
    };
    let modulus = keys
        .iter()
        .find(|key| key.name == certificate.issuer())
        .unwrap()
        .modulus;
    circuit_inputs(
        &certificate,
        modulus,
        &path,
        case["current_time"].as_u64().unwrap(),
        text(case, "scope_string").as_bytes().try_into().unwrap(),
        &unhex(text(case, "scope_signature")).try_into().unwrap(),
        text(case, "declaration_code")
            .as_bytes()
            .try_into()
            .unwrap(),
        &unhex(text(case, "declaration_code_signature"))
            .try_into()
            .unwrap(),
    )
    .unwrap()
}

fn circuit_of(case: &Value) -> Circuit {
    let file = repo_file(&format!("web/circuits/{}.json", text(case, "circuit")));
    Circuit::read(&file).unwrap()
}

#[test]
fn the_circuits_accept_the_inputs_of_every_case() {
    let v = vectors("circuit-inputs.json");
    for case in cases(&v, "cases") {
        let witness = circuit_of(case).solve(&inputs_of(&v, case));
        assert!(witness.is_ok(), "{}", text(case, "label"));
    }
}

/// One change to the inputs of a case.
type Change<'a> = &'a dyn Fn(&mut CircuitInputs);

#[test]
fn inputs_that_say_anything_else_have_no_witness() {
    let v = vectors("circuit-inputs.json");
    // One case of each circuit.
    for case in [&cases(&v, "cases")[0], &cases(&v, "cases")[2]] {
        let circuit = circuit_of(case);
        let label = text(case, "label");
        let changes: [(&str, Change<'_>); 9] = [
            // The certificate expired in 2031.
            ("a later time", &|i| {
                i.current_time = fe_of_u64(310_102_155_959)
            }),
            ("an earlier time", &|i| {
                i.current_time = fe_of_u64(251_231_155_959)
            }),
            ("another declaration code", &|i| i.declaration_code[30] ^= 1),
            ("another scope", &|i| i.scope[0] ^= 1),
            ("the signatures in each other's place", &|i| {
                std::mem::swap(&mut i.scope_signature, &mut i.declaration_code_signature)
            }),
            ("another root", &|i| i.smt_root[31] ^= 1),
            ("a path that ends elsewhere", &|i| {
                i.smt_is_old0 = !i.smt_is_old0
            }),
            ("another certificate", &|i| i.tbs[100] ^= 1),
            ("another issuer key", &|i| i.issuer_modulus[0][31] ^= 2),
        ];
        for (what, change) in changes {
            let mut inputs = inputs_of(&v, case);
            change(&mut inputs);
            assert_eq!(
                circuit.solve(&inputs).err(),
                Some(WitnessError::Unsatisfied),
                "{label}: {what}"
            );
        }
    }
}

#[test]
fn inputs_of_another_circuit_and_files_that_are_no_circuit() {
    let v = vectors("circuit-inputs.json");
    let (g3, g2) = (&cases(&v, "cases")[0], &cases(&v, "cases")[2]);
    assert_ne!(g3["circuit"], g2["circuit"]);
    // 35 limbs where the circuit takes 18.
    assert_eq!(
        circuit_of(g2).solve(&inputs_of(&v, g3)).err(),
        Some(WitnessError::Circuit)
    );
    let file = repo_file(&format!("web/circuits/{}.json", text(g2, "circuit")));
    let mut json: Value = serde_json::from_slice(&file).unwrap();
    for not_a_circuit in [
        b"".to_vec(),
        b"{}".to_vec(),
        file[..file.len() - 2].to_vec(),
        repo_file("verifier/vk/card_proof_rs2048.vk"),
    ] {
        assert_eq!(
            Circuit::read(&not_a_circuit).err(),
            Some(WitnessError::Circuit)
        );
    }
    // A parameter the core has no value for.
    json["abi"]["parameters"][0]["name"] = "other".into();
    let renamed = Circuit::read(json.to_string().as_bytes()).unwrap();
    assert_eq!(
        renamed.solve(&inputs_of(&v, g2)).err(),
        Some(WitnessError::Circuit)
    );
    json["bytecode"] = "AAAA".into();
    assert_eq!(
        Circuit::read(json.to_string().as_bytes()).err(),
        Some(WitnessError::Circuit)
    );
}
