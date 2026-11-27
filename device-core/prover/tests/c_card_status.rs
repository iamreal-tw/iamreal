//! `idc_card_status`, called the way an app calls it: what the screen of
//! the card's accounts shows, from the two answers of the server
//! (spec/list-consequence.md, "The card's state, as shown"). Every case of
//! spec/vectors/card-status.json, the file web/ reads too.

mod common;

use common::{text, vectors};
use iamreal_device_checks::date::Date;
use iamreal_device_core::{
    IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_OK, IdcBuf, idc_buf_free, idc_card_status,
};
use serde_json::{Value, json};

/// Seconds since 1970-01-01T00:00:00Z at noon in Taiwan on `date`.
fn noon(date: &str) -> i64 {
    let d = Date::parse(date.as_bytes()).unwrap();
    d.days_since_1970() * 86_400 + 4 * 3600
}

fn status(platforms: &Value, card_state: &Value, known: &Value, now: i64) -> Result<Value, i32> {
    let (platforms, card_state, known) = (
        platforms.to_string(),
        card_state.to_string(),
        known.to_string(),
    );
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let code = unsafe {
        idc_card_status(
            platforms.as_ptr(),
            platforms.len(),
            card_state.as_ptr(),
            card_state.len(),
            known.as_ptr(),
            known.len(),
            now,
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

fn threads() -> Value {
    json!([{"platform": "threads", "display_name": "Threads", "username_format": "[a-z0-9._]{1,30}"}])
}

/// Every case of spec/vectors/card-status.json.
#[test]
fn every_case_of_the_vectors() {
    let v = vectors("card-status.json");
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 22);
    let (mut read, mut unread) = (0, 0);
    for c in cases {
        let name = text(c, "name");
        let got = status(
            &c["platforms"],
            &c["card_state"],
            &c["known_platforms"],
            noon(text(c, "today")),
        );
        if c["result"].get("unread").is_some() {
            assert_eq!(got, Err(IDC_ERR_INPUT), "{name}");
            unread += 1;
        } else {
            assert_eq!(got.as_ref(), Ok(&c["result"]), "{name}");
            read += 1;
        }
    }
    assert!(read >= 19 && unread >= 3, "{read} read, {unread} unread");
}

/// The answers are read as for the consequence of a list: every answer
/// spec/vectors/list-consequence.json says cannot be read is refused, and
/// every other one is read.
#[test]
fn the_answers_are_read_as_for_a_list() {
    let v = vectors("list-consequence.json");
    let (mut read, mut unread) = (0, 0);
    for c in v["cases"].as_array().unwrap() {
        let name = text(c, "name");
        let got = status(
            &c["platforms"],
            &c["card_state"],
            &c["known_platforms"],
            noon(text(c, "today")),
        );
        if c["result"].get("unread").is_some() {
            assert_eq!(got, Err(IDC_ERR_INPUT), "{name}");
            unread += 1;
        } else {
            assert!(got.is_ok(), "{name}");
            read += 1;
        }
    }
    assert!(read >= 40 && unread >= 70, "{read} read, {unread} unread");
}

#[test]
fn what_the_function_refuses() {
    let state = json!({"last_card_proof": null, "proofs_on_last_date": 0, "daily_limit": 3, "platforms": {}, "count": 0});
    // Known platforms that are not a list of platform IDs, none twice.
    for known in [
        json!("threads"),
        json!(["threads", "threads"]),
        json!(["Threads"]),
    ] {
        assert_eq!(
            status(&threads(), &state, &known, noon("2026-11-16")),
            Err(IDC_ERR_INPUT)
        );
    }
    // A clock outside the years 2000 to 2049.
    assert_eq!(
        status(&threads(), &state, &json!(["threads"]), 0),
        Err(IDC_ERR_INPUT)
    );
    // No buffer to fill.
    let code = unsafe {
        idc_card_status(
            b"[]".as_ptr(),
            2,
            b"{}".as_ptr(),
            2,
            b"[]".as_ptr(),
            2,
            0,
            std::ptr::null_mut(),
        )
    };
    assert_eq!(code, IDC_ERR_ARGUMENT);
}
