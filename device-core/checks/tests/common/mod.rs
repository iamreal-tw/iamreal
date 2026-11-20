//! Reading spec/vectors/ and the repository's test files, for the tests of
//! this directory.
#![allow(dead_code)]

use iamreal_device_checks::hash::Sha256;
use serde_json::Value;

pub fn repo_file(path: &str) -> Vec<u8> {
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path);
    std::fs::read(full).unwrap_or_else(|_| panic!("{path}"))
}

pub fn vectors(name: &str) -> Value {
    serde_json::from_slice(&repo_file(&format!("spec/vectors/{name}"))).expect("JSON")
}

pub fn list<'a>(v: &'a Value, what: &str) -> &'a Vec<Value> {
    let list = v.as_array().unwrap_or_else(|| panic!("{what} is a list"));
    assert!(!list.is_empty(), "{what} has cases");
    list
}

pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    assert!(s.len().is_multiple_of(2), "an even number of hex digits");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

pub struct TestSha256;

impl Sha256 for TestSha256 {
    fn sha256(&mut self, data: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        sha2::Sha256::digest(data).into()
    }
}
