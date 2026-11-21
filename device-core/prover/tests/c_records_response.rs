//! `idc_records_response`, called the way an app calls it: the answer to a
//! submission as the done screen tells it, and where it differs from what
//! the confirmation screen said (spec/records-response.md). Every case of
//! spec/vectors/records-response.json, the file web/ reads too.

mod common;

use common::{text, vectors};
use iamreal_device_core::{
    IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_OK, IdcBuf, idc_buf_free, idc_records_response,
};
use serde_json::{Value, json};

fn response(body: &[u8], rows: &[u8]) -> Result<Value, i32> {
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let code = unsafe {
        idc_records_response(
            body.as_ptr(),
            body.len(),
            rows.as_ptr(),
            rows.len(),
            &mut out,
        )
    };
    if code != IDC_OK {
        assert!(out.ptr.is_null() && out.len == 0, "no bytes with an error");
        return Err(code);
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.ptr, out.len) }.to_vec();
    unsafe { idc_buf_free(&mut out) };
    Ok(serde_json::from_slice(&bytes).expect("the output is JSON"))
}

const HASH: &str = "3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f3f";

fn first() -> String {
    json!({"seq": 138, "record_hash": HASH, "kinds": [{"platform": "threads", "kind": "first", "username": "alice", "account_cards": 1}]}).to_string()
}

fn nothing() -> Value {
    json!({"seq": null, "record_hash": null, "kinds": null, "mismatches": []})
}

/// Every case of spec/vectors/records-response.json.
#[test]
fn every_case_of_the_vectors() {
    let v = vectors("records-response.json");
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 75);
    let (mut nothing_told, mut kinds_unknown, mut differ) = (0, 0, 0);
    for c in cases {
        let name = text(c, "name");
        let got = response(text(c, "body").as_bytes(), c["rows"].to_string().as_bytes());
        assert_eq!(got.as_ref(), Ok(&c["result"]), "{name}");
        let result = &c["result"];
        if result["seq"].is_null() {
            nothing_told += 1;
        } else if result["kinds"].is_null() {
            kinds_unknown += 1;
        } else if !result["mismatches"].as_array().unwrap().is_empty() {
            differ += 1;
        }
    }
    assert!(
        nothing_told >= 20 && kinds_unknown >= 20 && differ >= 8,
        "{nothing_told} with nothing told, {kinds_unknown} with the kinds unknown, {differ} that differ"
    );
}

/// What the vectors cannot hold: bodies that are not text, and the answers
/// device-core/ does not read at all (spec/records-response.md, "Outside
/// these rules"). The record is in the roster: none is an error.
#[test]
fn a_body_the_core_cannot_read_is_an_answer_with_nothing_told() {
    let rows = br#"[{"platform":"threads","kind":"first","username":"alice"}]"#;
    let twice = format!(r#"{{"seq":138,"seq":138,"record_hash":"{HASH}"}}"#);
    let deep = format!(
        r#"{{"seq":138,"record_hash":"{HASH}","x":{}{}}}"#,
        "[".repeat(200),
        "]".repeat(200)
    );
    let bodies: [&[u8]; 5] = [
        b"",
        b"\xff\xfe",
        b"{\"seq\":138,\"record_hash\":\"\xff\"}",
        twice.as_bytes(),
        deep.as_bytes(),
    ];
    for body in bodies {
        assert_eq!(response(body, rows), Ok(nothing()));
    }
    // No body at all: a 201 without one.
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let code =
        unsafe { idc_records_response(std::ptr::null(), 0, rows.as_ptr(), rows.len(), &mut out) };
    assert_eq!(code, IDC_OK);
    let bytes = unsafe { std::slice::from_raw_parts(out.ptr, out.len) }.to_vec();
    unsafe { idc_buf_free(&mut out) };
    assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), nothing());
}

/// The rows are the app's own, from idc_list_consequence: what is not in
/// their shape is a mistake of the app, whatever the answer is.
#[test]
fn rows_that_are_not_the_confirmation_screens() {
    for rows in [
        json!({"rows": []}),
        json!("threads"),
        json!(["threads"]),
        json!([{"kind": "first", "username": "alice"}]),
        json!([{"platform": "Threads", "kind": "first", "username": "alice"}]),
        json!([{"platform": "threads", "kind": "declare", "username": "alice"}]),
        json!([{"platform": "threads", "kind": "first"}]),
        json!([{"platform": "threads", "kind": "first", "username": ""}]),
        json!([{"platform": "threads", "kind": "first", "username": "al\"ice"}]),
        // Not in ascending order, and a platform twice.
        json!([{"platform": "threads", "kind": "first", "username": "alice"}, {"platform": "test-example", "kind": "first", "username": "a-b"}]),
        json!([{"platform": "threads", "kind": "first", "username": "alice"}, {"platform": "threads", "kind": "first", "username": "alice"}]),
    ] {
        let rows = rows.to_string();
        // With an answer that is read, and with one of which nothing is told.
        assert_eq!(
            response(first().as_bytes(), rows.as_bytes()),
            Err(IDC_ERR_INPUT),
            "{rows}"
        );
        assert_eq!(response(b"", rows.as_bytes()), Err(IDC_ERR_INPUT), "{rows}");
    }
    assert_eq!(
        response(first().as_bytes(), b"not json"),
        Err(IDC_ERR_INPUT)
    );
    // A list that withdrew nothing and declared nothing has no rows, and the
    // rules refuse it; the function does not: every kind of the answer differs.
    assert_eq!(
        response(first().as_bytes(), b"[]").unwrap()["mismatches"],
        json!(["threads"])
    );
}

#[test]
fn what_the_function_refuses() {
    let body = first();
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    // No rows.
    let code =
        unsafe { idc_records_response(body.as_ptr(), body.len(), std::ptr::null(), 0, &mut out) };
    assert_eq!(code, IDC_ERR_INPUT);
    // A body of some length at no address.
    let code = unsafe { idc_records_response(std::ptr::null(), 4, b"[]".as_ptr(), 2, &mut out) };
    assert_eq!(code, IDC_ERR_ARGUMENT);
    // No buffer to fill.
    let code = unsafe {
        idc_records_response(
            body.as_ptr(),
            body.len(),
            b"[]".as_ptr(),
            2,
            std::ptr::null_mut(),
        )
    };
    assert_eq!(code, IDC_ERR_ARGUMENT);
}
