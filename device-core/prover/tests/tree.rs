//! The revocation tree built with Barretenberg's Poseidon2, in parts and
//! on threads, against spec/vectors/: the roots and paths are the ones
//! `iamreal-crl prove` prints (cmd/iamreal-crl/vectors_test.go reads the
//! same file).

mod common;

use common::{TestSha256, cases, fe, hex, repo_file, text, unhex, vectors};
use iamreal_device_checks::crl::usable_crl;
use iamreal_device_checks::field::Fe;
use iamreal_device_checks::key::Key;
use iamreal_device_checks::tree::{AbsenceProof, TreeResult, build_tree as build_in_one_thread};
use iamreal_device_core::hashes::Barretenberg;
use iamreal_device_core::tree::{build_tree, build_tree_in_parts};
use serde_json::Value;

/// A hex number of any length as a key.
fn key(text: &str) -> Key {
    let digits = text.strip_prefix("0x").unwrap();
    let even = if digits.len() % 2 == 1 {
        format!("0{digits}")
    } else {
        digits.to_string()
    };
    Key::from_unsigned(&unhex(&even)).expect("at most 20 bytes")
}

/// A hex number of any length as a field element.
fn field(text: &str) -> Fe {
    let digits = text.strip_prefix("0x").unwrap();
    fe(&format!("{digits:0>64}"))
}

/// Every way this directory builds a tree: on threads in 1, 2 and 4 parts,
/// the way the C functions do, and in one thread.
fn every_way(keys: &[Key], target: Key) -> Vec<TreeResult> {
    let mut results = vec![build_tree(keys, target).unwrap()];
    for split_bits in 0..=2 {
        results.push(build_tree_in_parts(keys, target, split_bits).unwrap());
        let mut hash = Barretenberg::new().unwrap();
        results.push(build_in_one_thread(keys, target, split_bits, &mut hash).unwrap());
    }
    results
}

fn absent(result: TreeResult) -> AbsenceProof {
    match result {
        TreeResult::Absent(proof) => proof,
        TreeResult::InTree { .. } => panic!("the serial is in the tree"),
    }
}

#[test]
fn small_trees_and_their_proofs_of_absence() {
    let v = vectors("poseidon2.json");
    for case in cases(&v["revocation_tree"], "cases") {
        let keys: Vec<Key> = case["serials"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| key(s.as_str().unwrap()))
            .collect();
        for a in cases(case, "absent") {
            let mut siblings: Vec<Fe> = a["siblings"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| field(s.as_str().unwrap()))
                .collect();
            siblings.resize(128, [0u8; 32]);
            let expected = AbsenceProof {
                root: field(text(case, "root")),
                siblings,
                is_old0: a["is_old0"].as_bool().unwrap(),
                old_key: field(text(a, "old_key")),
                old_value: field(text(a, "old_value")),
            };
            for result in every_way(&keys, key(text(a, "serial"))) {
                assert_eq!(absent(result), expected);
            }
        }
    }
}

fn issuer_modulus(v: &Value, issuer: &str) -> Vec<u8> {
    let key = cases(v, "issuers")
        .iter()
        .find(|k| text(k, "issuer") == issuer)
        .expect("the issuer");
    unhex(text(key, "modulus"))
}

#[test]
fn whole_crls_their_roots_and_paths() {
    let v = vectors("revocation-tree.json");
    let keys_of = |name: &str| -> (Vec<Key>, Fe) {
        let crl = cases(&v, "crls")
            .iter()
            .find(|c| text(c, "name") == name)
            .expect("the CRL");
        let der = unhex(text(crl, "crl"));
        let modulus = issuer_modulus(&v, text(crl, "issuer"));
        let usable = usable_crl(&der, &modulus, &mut TestSha256)
            .unwrap_or_else(|reason| panic!("{name}: {}", reason.code()));
        (usable.keys, field(text(crl, "root")))
    };
    for crl in cases(&v, "crls") {
        let (keys, root) = keys_of(text(crl, "name"));
        // The root does not depend on whose path is asked for.
        let any = Key::from_unsigned(&[1]).unwrap();
        for result in every_way(&keys, any) {
            let got = match result {
                TreeResult::Absent(proof) => proof.root,
                TreeResult::InTree { root } => root,
            };
            assert_eq!(got, root, "{}", text(crl, "name"));
        }
    }
    for case in cases(&v, "cases") {
        let label = text(case, "label");
        let (keys, root) = keys_of(text(case, "crl"));
        let target = key(text(case, "serial"));
        for result in every_way(&keys, target) {
            if case["in_tree"].as_bool().unwrap() {
                assert_eq!(result, TreeResult::InTree { root }, "{label}");
                continue;
            }
            let path = &case["path"];
            let expected = AbsenceProof {
                root: fe(text(path, "smt_root")),
                siblings: path["smt_siblings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| fe(s.as_str().unwrap()))
                    .collect(),
                is_old0: path["smt_is_old0"].as_bool().unwrap(),
                old_key: fe(text(path, "smt_old_key")),
                old_value: fe(text(path, "smt_old_value")),
            };
            assert_eq!(expected.siblings.len(), 128);
            assert_eq!(expected.root, root, "{label}");
            assert_eq!(absent(result), expected, "{label}");
        }
    }
}

/// The modulus of an RSA SubjectPublicKeyInfo.
fn modulus_of_spki(spki: &[u8]) -> Vec<u8> {
    use iamreal_device_checks::der::{all_children, read_tlv};
    let outer = read_tlv(spki, 0, spki.len()).unwrap();
    let parts = all_children(spki, &outer).unwrap();
    let bits = parts[1].content(spki);
    let key = read_tlv(bits, 1, bits.len()).unwrap();
    let numbers = all_children(bits, &key).unwrap();
    let modulus = numbers[0].content(bits);
    modulus[modulus.len() % 8..].to_vec()
}

#[test]
fn the_roots_of_the_crls_of_crl_testdata() {
    let expected: Value = serde_json::from_slice(&repo_file("crl/testdata/expected.json")).unwrap();
    let modulus = modulus_of_spki(&repo_file("crl/testdata/issuer-public-key.der"));
    let mut usable = 0;
    for e in expected.as_array().unwrap() {
        if e["usable"] != true {
            continue;
        }
        let name = text(e, "name");
        let der = repo_file(&format!("crl/testdata/{name}.crl"));
        let crl = usable_crl(&der, &modulus, &mut TestSha256).unwrap();
        let any = Key::from_unsigned(&[1]).unwrap();
        let root = match build_tree(&crl.keys, any).unwrap() {
            TreeResult::Absent(proof) => proof.root,
            TreeResult::InTree { root } => root,
        };
        assert_eq!(hex(&root), text(e, "root"), "{name}");
        usable += 1;
    }
    assert!(usable >= 10);
}
