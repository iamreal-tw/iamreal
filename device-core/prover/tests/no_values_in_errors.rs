//! Nothing read from a certificate, a CRL, an index or a config comes back
//! in an answer that says the card proof stops, or in an error (issue #94):
//! certificates and CRLs with a marker written into them go through the C
//! functions, and the marker is in none of those answers. The one value an
//! answer carries on purpose is the name of a certificate that passed.
//!
//! What a panic prints is in tests/quiet.rs.

mod common;

use common::{cases, hex, repo_file, text, unhex, vectors};
use iamreal_device_checks::issuers::IssuerName;
use iamreal_device_checks::scope::Roster;
use iamreal_device_core::session::{self, Trust};
use iamreal_device_core::{
    IDC_OK, IdcBuf, artifacts, idc_buf_free, idc_session_add_certificate,
    idc_session_card_state_request, idc_session_check_certificates, idc_session_check_crl,
    idc_session_choose_crl, idc_session_close,
};
use serde_json::Value;
use sha2::Digest;

/// As long as the name on the vectors' certificates, in UTF-8.
const MARKER: &[u8; 12] = b"ZZ-MARKER-ZZ";
const NAME: &str = "測試用戶";

/// What a function answered: its code and its bytes.
fn answer(code: i32, mut out: IdcBuf) -> (i32, Vec<u8>) {
    if code != IDC_OK {
        assert!(out.ptr.is_null() && out.len == 0);
        return (code, Vec::new());
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.ptr, out.len) }.to_vec();
    unsafe { idc_buf_free(&mut out) };
    (code, bytes)
}

fn empty() -> IdcBuf {
    IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    }
}

fn contains(bytes: &[u8], what: &[u8]) -> bool {
    bytes.windows(what.len()).any(|window| window == what)
}

/// The same bytes with the marker in them, four ways: in place of the
/// name, in the middle, at the end, and nothing but the marker.
fn marked(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut variants = Vec::new();
    if let Some(at) = bytes.windows(NAME.len()).position(|w| w == NAME.as_bytes()) {
        let mut renamed = bytes.to_vec();
        renamed[at..at + MARKER.len()].copy_from_slice(MARKER);
        variants.push(renamed);
    }
    if bytes.len() >= 2 * MARKER.len() {
        let mut middle = bytes.to_vec();
        let at = bytes.len() / 2;
        middle[at..at + MARKER.len()].copy_from_slice(MARKER);
        variants.push(middle);
    }
    variants.push([bytes, MARKER].concat());
    variants.push(MARKER.to_vec());
    variants
}

fn issuers_of(v: &Value) -> Vec<(IssuerName, Vec<u8>)> {
    cases(v, "issuers")
        .iter()
        .map(|k| {
            (
                IssuerName::parse(text(k, "issuer")).unwrap(),
                unhex(text(k, "modulus")),
            )
        })
        .collect()
}

fn open(v: &Value) -> u64 {
    session::open(
        Roster::Test,
        Trust {
            issuers: issuers_of(v),
            artifacts: artifacts::BUILT_IN,
        },
    )
}

const NOW: i64 = 1_794_800_000; // 2026-11-16 in Taiwan

fn check_certificates(handle: u64, certificates: &[Vec<u8>]) -> (i32, Vec<u8>) {
    for certificate in certificates {
        let code =
            unsafe { idc_session_add_certificate(handle, certificate.as_ptr(), certificate.len()) };
        assert_eq!(code, IDC_OK);
    }
    let mut out = empty();
    let code = unsafe { idc_session_check_certificates(handle, NOW, &mut out) };
    answer(code, out)
}

/// The answer may carry the marker only as the name of a certificate that
/// passed; no certificate with the marker in it passes, so: never.
fn assert_unmarked(what: &str, (code, bytes): &(i32, Vec<u8>)) {
    assert!(
        !contains(bytes, MARKER),
        "{what}: code {code}, {}",
        String::from_utf8_lossy(bytes)
    );
}

#[test]
fn certificates_with_a_marker_in_them() {
    let v = vectors("device-checks.json");
    let mut stopped = 0;
    for case in cases(&v["certificate"], "cases") {
        let what = text(case, "what");
        let certificates: Vec<Vec<u8>> = case["certificates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| unhex(c.as_str().unwrap()))
            .collect();
        for (i, certificate) in certificates.iter().enumerate() {
            for variant in marked(certificate) {
                let mut with_marker = certificates.clone();
                with_marker[i] = variant;
                let handle = open(&v);
                let answer = check_certificates(handle, &with_marker);
                assert_unmarked(what, &answer);
                let result: Value = serde_json::from_slice(&answer.1).unwrap();
                stopped += usize::from(result["ok"] == false);
                // Nor does a session that did not pass say anything of it.
                let mut out = empty();
                let code = unsafe {
                    idc_session_card_state_request(handle, MARKER.as_ptr(), MARKER.len(), &mut out)
                };
                assert_unmarked(what, &self::answer(code, out));
                idc_session_close(handle);
            }
        }
    }
    assert!(stopped > 100, "the marked certificates stop the card proof");
}

/// A session whose certificate is the vectors' first of `issuer`.
fn session_with_certificate(v: &Value, issuer: &str) -> u64 {
    let case = cases(&v["certificate"], "cases")
        .iter()
        .find(|c| {
            c["result"]["issuer"] == issuer && c["certificates"].as_array().unwrap().len() == 1
        })
        .unwrap();
    let handle = open(v);
    let (_, bytes) =
        check_certificates(handle, &[unhex(case["certificates"][0].as_str().unwrap())]);
    let result: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(result["ok"], true);
    handle
}

fn choose_crl(handle: u64, index: &[u8]) -> (i32, Vec<u8>) {
    let mut out = empty();
    let code = unsafe { idc_session_choose_crl(handle, index.as_ptr(), index.len(), &mut out) };
    answer(code, out)
}

fn check_crl(handle: u64, crl: &[u8], config: &[u8], highest: &[u8]) -> (i32, Vec<u8>) {
    let mut out = empty();
    let code = unsafe {
        idc_session_check_crl(
            handle,
            crl.as_ptr(),
            crl.len(),
            NOW,
            config.as_ptr(),
            config.len(),
            highest.as_ptr(),
            highest.len(),
            &mut out,
        )
    };
    answer(code, out)
}

/// An index that names `file` as the newest CRL of `issuer`.
fn index_naming(issuer: &str, file: &[u8]) -> String {
    format!(
        "{{\"issuer\":\"{issuer}\",\"crl_number\":\"1\",\"sha256\":\"{}\",\"root\":\"{}\"}}\n",
        hex(&sha2::Sha256::digest(file)),
        "0".repeat(64)
    )
}

#[test]
fn crls_with_a_marker_in_them() {
    let v = vectors("device-checks.json");
    let mut files: Vec<Vec<u8>> = Vec::new();
    for case in cases(&v["crl"], "cases") {
        for (name, answer) in case["mirror"].as_object().unwrap() {
            if name.ends_with(".crl") && answer["status"] == 200 {
                files.push(unhex(text(answer, "body")));
            }
        }
    }
    let testdata = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../crl/testdata");
    for file in std::fs::read_dir(testdata).unwrap() {
        let name = file.unwrap().file_name().into_string().unwrap();
        if name.ends_with(".crl") {
            files.push(repo_file(&format!("crl/testdata/{name}")));
        }
    }
    files.sort();
    files.dedup();
    assert!(files.len() > 40);

    let config = br#"{"crl_max_age_days":3}"#;
    let mut stopped = 0;
    for issuer in ["G2", "G3"] {
        let handle = session_with_certificate(&v, issuer);
        for file in &files {
            for variant in marked(file) {
                let chosen = choose_crl(handle, index_naming(issuer, &variant).as_bytes());
                assert_unmarked("the choice", &chosen);
                let answer = check_crl(handle, &variant, config, b"");
                assert_unmarked("the CRL", &answer);
                let result: Value = serde_json::from_slice(&answer.1).unwrap();
                stopped += usize::from(result["ok"] == false);
            }
        }
        idc_session_close(handle);
    }
    assert!(stopped > 300, "the marked CRLs are refused");
}

#[test]
fn an_index_a_config_and_a_remembered_number_with_a_marker_in_them() {
    let v = vectors("device-checks.json");
    let marker = std::str::from_utf8(MARKER).unwrap();
    let handle = session_with_certificate(&v, "G3");
    let crl_case = &cases(&v["crl"], "cases")[0];
    let good_index = unhex(text(&crl_case["mirror"]["index.jsonl"], "body"));
    let good_index = String::from_utf8(good_index).unwrap();

    let line = |issuer: &str, number: &str, sha256: &str, root: &str| {
        format!(
            "{{\"issuer\":\"{issuer}\",\"crl_number\":\"{number}\",\"sha256\":\"{sha256}\",\"root\":\"{root}\",\"{marker}\":\"{marker}\"}}\n"
        )
    };
    let hash = "a".repeat(64);
    let indexes = [
        marker.to_string(),
        line(marker, "1", &hash, &hash),
        line("G3", marker, &hash, &hash),
        line("G3", "1", marker, &hash),
        line("G3", "1", &hash, marker),
        line("G3", "1", &hash, &format!("-{marker}")),
        format!("{marker}\n{good_index}{marker}"),
        format!("{good_index}\u{feff}{marker}\u{0}\n"),
    ];
    for index in &indexes {
        assert_unmarked("the index", &choose_crl(handle, index.as_bytes()));
        let mut not_utf8 = index.clone().into_bytes();
        not_utf8.push(0xff);
        assert_unmarked("an index that is not UTF-8", &choose_crl(handle, &not_utf8));
    }

    let (_, chosen) = choose_crl(handle, good_index.as_bytes());
    let chosen: Value = serde_json::from_slice(&chosen).unwrap();
    let file = unhex(text(
        &crl_case["mirror"][format!("{}.crl", text(&chosen, "sha256"))],
        "body",
    ));
    let configs = [
        marker.to_string(),
        format!("{{\"crl_max_age_days\":\"{marker}\"}}"),
        format!("{{\"{marker}\":3}}"),
        format!("{{\"crl_max_age_days\":3,\"{marker}\":\"{marker}\"}}"),
        format!("{{\"crl_max_age_days\":3}}{marker}"),
    ];
    for config in &configs {
        for highest in ["", "5", marker, "5ZZ-MARKER-ZZ"] {
            let answer = check_crl(handle, &file, config.as_bytes(), highest.as_bytes());
            assert_unmarked("the config and the remembered number", &answer);
        }
    }
    idc_session_close(handle);
}
