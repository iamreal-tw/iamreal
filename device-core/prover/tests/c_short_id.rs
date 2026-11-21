//! `idc_short_id`, called the way an app calls it: the short ID of a scoped
//! ID (spec/scoped-id.md), against spec/vectors/scoped-id.json.

mod common;

use common::{text, vectors};
use iamreal_device_core::{
    IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_OK, IdcBuf, idc_buf_free, idc_short_id,
};

fn short_id(scoped_id: &[u8]) -> Result<String, i32> {
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let code = unsafe { idc_short_id(scoped_id.as_ptr(), scoped_id.len(), &mut out) };
    if code != IDC_OK {
        assert!(out.ptr.is_null() && out.len == 0, "no bytes with an error");
        return Err(code);
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.ptr, out.len) }.to_vec();
    unsafe { idc_buf_free(&mut out) };
    Ok(String::from_utf8(bytes).unwrap())
}

#[test]
fn the_short_id_of_every_scoped_id_of_the_vectors() {
    let v = vectors("scoped-id.json");
    let cases = v["encoding"].as_array().unwrap();
    assert!(cases.len() >= 3);
    for c in cases {
        assert_eq!(
            short_id(text(c, "scoped_id").as_bytes()).as_deref(),
            Ok(text(c, "short_id")),
            "{}",
            text(c, "label")
        );
    }
    // What is not a scoped ID in its one spelling has no short ID.
    for c in v["invalid"].as_array().unwrap() {
        if let Some(text) = c["scoped_id"].as_str() {
            assert_eq!(short_id(text.as_bytes()), Err(IDC_ERR_INPUT), "{text}");
        }
    }
    assert_eq!(short_id(b"7K2Q9FM4XD"), Err(IDC_ERR_INPUT));
    assert_eq!(
        unsafe { idc_short_id(std::ptr::null(), 0, std::ptr::null_mut()) },
        IDC_ERR_ARGUMENT
    );
}
