//! The circuit's inputs and the public inputs the device expects
//! (spec/circuit-inputs.md) against spec/vectors/circuit-inputs.json, the
//! file the web page's tests read.

mod common;

use common::{TestSha256, hex, list, text, unhex, vectors};
use iamreal_device_checks::certificate::{CardCertificate, Selection, select_certificate};
use iamreal_device_checks::circuit_inputs::{CircuitInputs, MAX_TBS_LENGTH, circuit_inputs};
use iamreal_device_checks::date::Date;
use iamreal_device_checks::field::{Fe, fe_of_u64};
use iamreal_device_checks::issuers::{IssuerKey, IssuerName};
use iamreal_device_checks::tree::AbsenceProof;
use serde_json::Value;

fn fe(v: &Value) -> Fe {
    unhex(v.as_str().expect("a field element"))
        .try_into()
        .expect("32 bytes")
}

fn fes(v: &Value) -> Vec<Fe> {
    v.as_array().expect("a list").iter().map(fe).collect()
}

fn issuers(v: &Value) -> Vec<(IssuerName, Vec<u8>)> {
    list(&v["issuers"], "issuers")
        .iter()
        .map(|k| {
            (
                IssuerName::parse(text(k, "issuer")).expect("G2 or G3"),
                unhex(text(k, "modulus")),
            )
        })
        .collect()
}

fn certificate(case: &Value, issuers: &[(IssuerName, Vec<u8>)]) -> CardCertificate {
    let keys: Vec<IssuerKey<'_>> = issuers
        .iter()
        .map(|(name, modulus)| IssuerKey {
            name: *name,
            modulus,
        })
        .collect();
    let der = unhex(text(case, "certificate"));
    let today = Date::parse(b"2026-11-16").unwrap();
    match select_certificate(&[&der], today, &keys, &mut TestSha256) {
        Selection::Chosen { certificate, .. } => certificate,
        Selection::Refused { .. } => panic!("{}", text(case, "label")),
    }
}

fn path(case: &Value) -> AbsenceProof {
    let path = &case["path"];
    AbsenceProof {
        root: fe(&path["smt_root"]),
        siblings: fes(&path["smt_siblings"]),
        is_old0: path["smt_is_old0"].as_bool().unwrap(),
        old_key: fe(&path["smt_old_key"]),
        old_value: fe(&path["smt_old_value"]),
    }
}

fn inputs_of(case: &Value, issuers: &[(IssuerName, Vec<u8>)]) -> CircuitInputs {
    let certificate = certificate(case, issuers);
    let modulus = &issuers
        .iter()
        .find(|(name, _)| *name == certificate.issuer())
        .unwrap()
        .1;
    circuit_inputs(
        &certificate,
        modulus,
        &path(case),
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
    .unwrap_or_else(|| panic!("{}", text(case, "label")))
}

#[test]
fn the_inputs_of_every_case_are_the_ones_of_the_vectors() {
    let v = vectors("circuit-inputs.json");
    let issuers = issuers(&v);
    let cases = list(&v["cases"], "cases");
    assert!(cases.len() >= 4);
    for case in cases {
        let label = text(case, "label");
        let expected = &case["inputs"];
        let inputs = inputs_of(case, &issuers);
        assert_eq!(inputs.tbs.len(), MAX_TBS_LENGTH);
        assert_eq!(hex(&inputs.tbs), text(expected, "tbs"), "{label}");
        assert_eq!(
            u64::from(inputs.tbs_len),
            expected["tbs_len"].as_u64().unwrap()
        );
        assert_eq!(
            inputs.issuer_modulus,
            fes(&expected["issuer_modulus"]),
            "{label}"
        );
        assert_eq!(inputs.issuer_redc, fes(&expected["issuer_redc"]), "{label}");
        assert_eq!(
            inputs.issuer_signature,
            fes(&expected["issuer_signature"]),
            "{label}"
        );
        assert_eq!(inputs.smt_root, fe(&expected["smt_root"]), "{label}");
        assert_eq!(
            inputs.smt_siblings,
            fes(&expected["smt_siblings"]),
            "{label}"
        );
        assert_eq!(inputs.smt_old_key, fe(&expected["smt_old_key"]), "{label}");
        assert_eq!(
            inputs.smt_old_value,
            fe(&expected["smt_old_value"]),
            "{label}"
        );
        assert_eq!(
            inputs.smt_is_old0,
            expected["smt_is_old0"].as_bool().unwrap()
        );
        assert_eq!(
            inputs.current_time,
            fe(&expected["current_time"]),
            "{label}"
        );
        assert_eq!(inputs.card_redc, fes(&expected["card_redc"]), "{label}");
        assert_eq!(hex(&inputs.scope), text(expected, "scope"), "{label}");
        assert_eq!(
            inputs.scope_signature,
            fes(&expected["scope_signature"]),
            "{label}"
        );
        assert_eq!(
            hex(&inputs.declaration_code),
            text(expected, "declaration_code"),
            "{label}"
        );
        assert_eq!(
            inputs.declaration_code_signature,
            fes(&expected["declaration_code_signature"]),
            "{label}"
        );
    }
}

#[test]
fn the_expected_public_inputs_are_the_ones_of_the_vectors() {
    let v = vectors("circuit-inputs.json");
    let issuers = issuers(&v);
    for case in list(&v["cases"], "cases") {
        let expected = fes(&case["public_inputs"]);
        let inputs = inputs_of(case, &issuers);
        let limbs = inputs.issuer_modulus.len();
        assert!(limbs == 18 || limbs == 35);
        // The scoped ID needs Poseidon2 (prover/tests/); here it is given.
        let scoped_id = expected[limbs + 2];
        assert_eq!(
            inputs.expected_public_inputs(&scoped_id),
            expected,
            "{}",
            text(case, "label")
        );
        assert_eq!(
            expected[limbs + 1],
            fe_of_u64(case["current_time"].as_u64().unwrap())
        );
    }
}

#[test]
fn a_path_that_is_not_128_siblings_gives_no_inputs() {
    let v = vectors("circuit-inputs.json");
    let issuers = issuers(&v);
    let case = &list(&v["cases"], "cases")[0];
    let certificate = certificate(case, &issuers);
    let modulus = &issuers
        .iter()
        .find(|(name, _)| *name == certificate.issuer())
        .unwrap()
        .1;
    let mut short = path(case);
    short.siblings.pop();
    let inputs = circuit_inputs(
        &certificate,
        modulus,
        &short,
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
    );
    assert!(inputs.is_none());
}
