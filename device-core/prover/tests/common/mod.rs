//! Reading spec/vectors/, for the tests of this directory.
#![allow(dead_code)]

use serde_json::Value;

pub fn vectors(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/vectors")
        .join(name);
    serde_json::from_slice(&std::fs::read(path).expect("the vectors file")).expect("JSON")
}

pub fn cases<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    let list = v[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is a list"));
    assert!(!list.is_empty(), "{key} has cases");
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

pub fn fe(s: &str) -> [u8; 32] {
    unhex(s).try_into().expect("32 bytes")
}
