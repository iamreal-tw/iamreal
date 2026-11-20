//! Poseidon2 as Barretenberg computes it, and the scoped ID computed with
//! it, against spec/vectors/poseidon2.json.

mod common;

use common::{cases, fe, hex, text, unhex, vectors};
use iamreal_device_checks::field::{Fe, MODULUS};
use iamreal_device_checks::hash::{HashFailed, Poseidon2};
use iamreal_device_checks::scoped_id::{scoped_id, signature_limbs};
use iamreal_device_core::hashes::Barretenberg;

fn inputs(case: &serde_json::Value) -> Vec<Fe> {
    case["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| fe(x.as_str().unwrap()))
        .collect()
}

#[test]
fn poseidon2_of_two_and_three_elements() {
    let v = vectors("poseidon2.json");
    let mut bb = Barretenberg::new().unwrap();
    for (key, n) in [("hash_2", 2), ("hash_3", 3)] {
        for case in cases(&v, key) {
            let inputs = inputs(case);
            assert_eq!(inputs.len(), n);
            assert_eq!(
                format!("0x{}", hex(&bb.poseidon2(&inputs).unwrap())),
                text(case, "hash"),
                "{key}"
            );
        }
    }
}

#[test]
fn poseidon2_takes_only_what_the_specification_defines() {
    let mut bb = Barretenberg::new().unwrap();
    let one = fe("0x0000000000000000000000000000000000000000000000000000000000000001");
    assert_eq!(bb.poseidon2(&[one]), Err(HashFailed));
    assert_eq!(bb.poseidon2(&[one; 4]), Err(HashFailed));
    assert_eq!(bb.poseidon2(&[]), Err(HashFailed));
    // An integer that is not below the modulus is not reduced.
    assert_eq!(bb.poseidon2(&[one, MODULUS]), Err(HashFailed));
    assert_eq!(bb.poseidon2(&[[0xff; 32], one]), Err(HashFailed));
}

#[test]
fn the_scoped_id_of_a_signature() {
    let v = vectors("poseidon2.json");
    let mut bb = Barretenberg::new().unwrap();
    for case in cases(&v["scoped_id"], "cases") {
        let signature: [u8; 256] = unhex(text(case, "signature"))
            .try_into()
            .expect("256 bytes");
        let limbs: Vec<String> = signature_limbs(&signature)
            .iter()
            .map(|l| format!("0x{}", hex(l)))
            .collect();
        let expected: Vec<&str> = case["limbs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap())
            .collect();
        assert_eq!(limbs, expected);
        assert_eq!(
            format!("0x{}", hex(&scoped_id(&signature, &mut bb).unwrap())),
            text(case, "scoped_id")
        );
    }
}

#[test]
fn a_hash_that_fails_gives_no_scoped_id() {
    struct Failing(u32);
    impl Poseidon2 for Failing {
        fn poseidon2(&mut self, _: &[Fe]) -> Result<Fe, HashFailed> {
            self.0 += 1;
            if self.0 == 3 {
                Err(HashFailed)
            } else {
                Ok([0u8; 32])
            }
        }
    }
    assert_eq!(scoped_id(&[1u8; 256], &mut Failing(0)), Err(HashFailed));
}
