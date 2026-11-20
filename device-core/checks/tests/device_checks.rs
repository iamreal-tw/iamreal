//! The checks on the device (spec/device-checks.md) against
//! spec/vectors/device-checks.json, the file the web page's tests read.
//! What needs Poseidon2 (the tree) is in prover/tests/.

mod common;

use common::{TestSha256, hex, list, text, unhex, vectors};
use iamreal_device_checks::certificate::{Selection, select_certificate};
use iamreal_device_checks::date::Date;
use iamreal_device_checks::issuers::{IssuerKey, IssuerName};
use serde_json::Value;

/// The two test keys of the file, standing in for G2 and G3.
fn test_issuers(v: &Value) -> Vec<(IssuerName, Vec<u8>)> {
    list(&v["issuers"], "issuers")
        .iter()
        .map(|k| {
            let name = IssuerName::parse(text(k, "issuer")).expect("G2 or G3");
            let modulus = unhex(text(k, "modulus"));
            assert_eq!(modulus.len() as u64 * 8, k["bits"].as_u64().unwrap());
            (name, modulus)
        })
        .collect()
}

fn keys(issuers: &[(IssuerName, Vec<u8>)]) -> Vec<IssuerKey<'_>> {
    issuers
        .iter()
        .map(|(name, modulus)| IssuerKey {
            name: *name,
            modulus,
        })
        .collect()
}

#[test]
fn choosing_and_checking_the_certificate() {
    let v = vectors("device-checks.json");
    let issuers = test_issuers(&v);
    for case in list(&v["certificate"]["cases"], "certificate.cases") {
        let what = text(case, "what");
        let ders: Vec<Vec<u8>> = case["certificates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| unhex(c.as_str().unwrap()))
            .collect();
        let ders: Vec<&[u8]> = ders.iter().map(Vec::as_slice).collect();
        let today = Date::parse(text(case, "today").as_bytes()).unwrap();
        let expected = &case["result"];
        match select_certificate(&ders, today, &keys(&issuers), &mut TestSha256) {
            Selection::Chosen { index, certificate } => {
                assert_eq!(expected["ok"], true, "{what}");
                assert_eq!(index as u64, expected["chosen"].as_u64().unwrap(), "{what}");
                assert_eq!(certificate.issuer().as_str(), text(expected, "issuer"));
                let serial = hex(&certificate.serial().to_fe());
                assert_eq!(
                    serial.trim_start_matches('0'),
                    text(expected, "serial").trim_start_matches("0x"),
                    "{what}"
                );
                assert_eq!(
                    format!("0x{}", hex(certificate.card_modulus())),
                    text(expected, "card_modulus"),
                    "{what}"
                );
                assert_eq!(
                    format!("{:012}", certificate.not_before()),
                    text(expected, "not_before")
                );
                assert_eq!(
                    format!("{:012}", certificate.not_after()),
                    text(expected, "not_after")
                );
                assert_eq!(certificate.name(), text(expected, "name"), "{what}");
                assert_eq!(certificate.der(), ders[index], "{what}");
            }
            Selection::Refused {
                problem,
                not_after,
                not_before,
            } => {
                assert_eq!(expected["ok"], false, "{what}");
                assert_eq!(problem.code(), text(expected, "problem"), "{what}");
                let date = |d: Option<u64>| match d {
                    Some(d) => Value::from(format!("{d:012}")),
                    None => Value::Null,
                };
                assert_eq!(date(not_after), expected["not_after"], "{what}");
                assert_eq!(date(not_before), expected["not_before"], "{what}");
            }
        }
    }
}

#[test]
fn the_issuer_keys_written_into_the_core() {
    use iamreal_device_checks::issuers::MOICA_ISSUERS;
    let v = vectors("issuers.json");
    let expected = list(&v["issuers"], "issuers");
    assert_eq!(MOICA_ISSUERS.len(), expected.len());
    // The same keys, in the order of the table: G2, then G3.
    for (key, e) in MOICA_ISSUERS.iter().zip(expected) {
        assert_eq!(key.name.as_str(), text(e, "issuer"));
        assert_eq!(format!("0x{}", hex(key.modulus)), text(e, "modulus"));
        assert_eq!(
            key.modulus.len() as u64 * 8,
            e["modulus_bits"].as_u64().unwrap()
        );
        assert_eq!(e["exponent"], 65537);
    }
}

/// The modulus of an RSA SubjectPublicKeyInfo (crl/testdata/issuer-public-key.der).
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
fn which_crls_are_usable() {
    use iamreal_device_checks::crl::usable_crl;
    let expected: Value =
        serde_json::from_slice(&common::repo_file("crl/testdata/expected.json")).unwrap();
    let modulus = modulus_of_spki(&common::repo_file("crl/testdata/issuer-public-key.der"));
    let mut files: Vec<String> = std::fs::read_dir(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crl/testdata"),
    )
    .unwrap()
    .map(|f| f.unwrap().file_name().into_string().unwrap())
    .filter_map(|f| f.strip_suffix(".crl").map(str::to_string))
    .collect();
    files.sort();
    let mut names: Vec<&str> = list(&expected, "expected")
        .iter()
        .map(|e| text(e, "name"))
        .collect();
    names.sort();
    assert_eq!(files, names, "every file has an expectation");

    for e in list(&expected, "expected") {
        let name = text(e, "name");
        let der = common::repo_file(&format!("crl/testdata/{name}.crl"));
        match usable_crl(&der, &modulus, &mut TestSha256) {
            Ok(crl) => {
                assert_eq!(e["usable"], true, "{name}");
                assert_eq!(crl.crl_number.as_str(), text(e, "crl_number"), "{name}");
                assert_eq!(crl.crl_date(), text(e, "crl_date"), "{name}");
                assert!(crl.keys.len() as u64 <= e["entries"].as_u64().unwrap());
            }
            Err(reason) => {
                assert_eq!(e["usable"], false, "{name}");
                assert_eq!(reason.code(), text(e, "reason"), "{name}");
            }
        }
    }
}

#[test]
fn the_age_bound_is_the_smaller_of_the_servers_and_7() {
    use iamreal_device_checks::revocation::crl_max_age;
    let v = vectors("device-checks.json");
    let mut read = 0;
    for case in list(&v["crl"]["max_age"], "crl.max_age") {
        // The values no client reads are the JSON reader's to refuse
        // (prover/tests/); here, the ones that are read.
        let (Some(server), Some(expected)) = (
            case["server_max_age_days"].as_u64(),
            case["max_age_days"].as_u64(),
        ) else {
            continue;
        };
        assert_eq!(crl_max_age(server), expected);
        read += 1;
    }
    assert!(read >= 5);
}

#[test]
fn crl_numbers_are_compared_as_integers_of_any_size() {
    use iamreal_device_checks::crl::CrlNumber;
    let n = |s: &str| CrlNumber::from_decimal(s).unwrap_or_else(|| panic!("{s}"));
    assert!(n("9") < n("10"));
    assert!(n("18446744073709551616") > n("18446744073709551615"));
    assert_eq!(n("0"), n("0"));
    for not_a_number in ["", "-", "01", "00", "1 ", "+1", "1e3", "１"] {
        assert_eq!(
            CrlNumber::from_decimal(not_a_number),
            None,
            "{not_a_number:?}"
        );
    }
    assert_eq!(CrlNumber::from_magnitude(&[]).as_str(), "0");
    assert_eq!(CrlNumber::from_magnitude(&[0, 0x12, 0x34]).as_str(), "4660");
    assert_eq!(
        CrlNumber::from_magnitude(&[1, 0, 0, 0, 0, 0, 0, 0, 0]).as_str(),
        "18446744073709551616"
    );
}
