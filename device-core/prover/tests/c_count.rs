//! `idc_count` and `idc_count_took`, called the way an app calls them,
//! against spec/vectors/counts.json.

mod common;

use common::vectors;
use iamreal_device_core::{
    IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_OK, IdcBuf, idc_buf_free, idc_count, idc_count_took,
};
use serde_json::Value;

fn call(f: impl FnOnce(&mut IdcBuf) -> i32) -> Result<String, i32> {
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let code = f(&mut out);
    if code != IDC_OK {
        assert!(out.ptr.is_null() && out.len == 0, "no bytes with an error");
        return Err(code);
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.ptr, out.len) }.to_vec();
    unsafe { idc_buf_free(&mut out) };
    Ok(String::from_utf8(bytes).unwrap())
}

fn count(json: &str) -> Result<String, i32> {
    call(|out| unsafe { idc_count(json.as_ptr(), json.len(), out) })
}

/// The members of a body, in its order.
fn members(body: &str) -> Vec<(String, String)> {
    // serde_json's map sorts; the order is read from the text, a member at a time.
    let mut rest = body
        .strip_prefix('{')
        .and_then(|b| b.strip_suffix('}'))
        .expect("an object");
    let mut members = Vec::new();
    while !rest.is_empty() {
        let mut stream = serde_json::Deserializer::from_str(rest).into_iter::<String>();
        let name = stream.next().unwrap().unwrap();
        let after = &rest[stream.byte_offset()..];
        let after = after.strip_prefix(':').expect("a colon");
        let mut stream = serde_json::Deserializer::from_str(after).into_iter::<String>();
        let value = stream.next().unwrap().unwrap();
        rest = &after[stream.byte_offset()..];
        rest = rest.strip_prefix(',').unwrap_or(rest);
        members.push((name, value));
    }
    members
}

/// The members of the table, in the one order a count is written in (spec/counts.md, "A count").
const ORDER: &[&str] = &[
    "client",
    "event",
    "page",
    "short_id",
    "step",
    "reason",
    "action",
    "tap",
    "took",
    "visit_id",
    "device_id",
    "attempt_id",
    "browser",
    "os",
    "browser_version",
    "os_version",
    "app_version",
    "model",
    "reader",
];

/// Values of the phone's or the browser's system: one not in its format is left out of what is sent.
const FROM_THE_SYSTEM: &[&str] = &[
    "browser_version",
    "os_version",
    "app_version",
    "model",
    "reader",
];

#[test]
fn every_case_of_the_vectors() {
    let v = vectors("counts.json");
    let cases = v["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let came = c["count"].to_string();
        let sent = count(&came);
        if c["taken"].as_bool().unwrap() {
            // Sent as it came, member for member, in the order of the table.
            let sent = members(&sent.unwrap_or_else(|e| panic!("{name}: {e}")));
            let mut expected: Vec<(String, String)> = c["count"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(n, v)| (n.clone(), v.as_str().unwrap().to_string()))
                .collect();
            expected.sort_by_key(|(n, _)| ORDER.iter().position(|o| o == n).unwrap());
            assert_eq!(sent, expected, "{name}");
            continue;
        }
        match sent {
            Err(code) => assert_eq!(code, IDC_ERR_INPUT, "{name}"),
            // A count dropped for a value of the system alone is sent without it.
            Ok(body) => {
                let sent = members(&body);
                let given = c["count"].as_object().unwrap();
                let left_out: Vec<&String> = given
                    .keys()
                    .filter(|k| !sent.iter().any(|(n, _)| n == *k))
                    .collect();
                assert!(!left_out.is_empty(), "{name}: dropped, and sent whole");
                assert!(
                    left_out
                        .iter()
                        .all(|k| FROM_THE_SYSTEM.contains(&k.as_str())),
                    "{name}: {left_out:?}"
                );
                for (n, v) in &sent {
                    assert_eq!(
                        given[n].as_str(),
                        Some(v.as_str()),
                        "{name}: {n} is sent as it came"
                    );
                }
            }
        }
    }
}

#[test]
fn an_app_with_a_model_or_a_version_not_in_its_format_sends_the_rest() {
    let d = "0123456789abcdef0123456789abcdef";
    let body = format!(
        r#"{{"model":"Alice’s iPhone","os_version":"18.1.1","app_version":"dev","attempt_id":"{d}","device_id":"{d}","step":"read","event":"step","client":"ios"}}"#
    );
    assert_eq!(
        count(&body).as_deref(),
        Ok(format!(r#"{{"client":"ios","event":"step","step":"read","device_id":"{d}","attempt_id":"{d}","os_version":"18.1.1"}}"#).as_str())
    );
}

#[test]
fn what_is_not_an_object_of_strings_is_not_a_count() {
    let d = "0123456789abcdef0123456789abcdef";
    for body in [
        "".to_string(),
        "[]".to_string(),
        "null".to_string(),
        r#"{"client":"ios""#.to_string(),
        format!(
            r#"{{"client":"ios","event":"action","action":"tap_dropped","tap":2,"device_id":"{d}","attempt_id":"{d}"}}"#
        ),
        // A key twice.
        format!(
            r#"{{"client":"ios","event":"step","step":"read","step":"done","device_id":"{d}","attempt_id":"{d}"}}"#
        ),
    ] {
        assert_eq!(count(&body), Err(IDC_ERR_INPUT), "{body}");
    }
    assert_eq!(
        unsafe { idc_count(std::ptr::null(), 1, std::ptr::null_mut()) },
        IDC_ERR_ARGUMENT
    );
}

#[test]
fn every_duration_of_the_vectors() {
    let v: Value = vectors("counts.json");
    let durations = v["durations"].as_array().unwrap();
    assert!(!durations.is_empty());
    for d in durations {
        let ms = d["ms"].as_u64().unwrap();
        assert_eq!(
            call(|out| unsafe { idc_count_took(ms, out) }).as_deref(),
            Ok(d["took"].as_str().unwrap()),
            "{ms} ms"
        );
    }
    assert_eq!(
        unsafe { idc_count_took(1, std::ptr::null_mut()) },
        IDC_ERR_ARGUMENT
    );
}
