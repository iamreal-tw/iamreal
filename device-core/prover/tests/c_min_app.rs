//! `idc_min_app`, called the way an app calls it: whether a build of the app
//! may do a card proof, from the `min_app` of the server's `config`
//! (spec/min-app.md). Every case of spec/vectors/min-app.json, the file
//! protocol/ reads too.

mod common;

use common::{text, vectors};
use iamreal_device_core::{
    IDC_CLIENT_ANDROID, IDC_CLIENT_IOS, IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_OK, IdcBuf,
    idc_buf_free, idc_min_app,
};
use serde_json::{Value, json};

fn min_app(config: &[u8], client: u32, app_build: u32, now: i64) -> Result<Value, i32> {
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let code = unsafe {
        idc_min_app(
            config.as_ptr(),
            config.len(),
            client,
            app_build,
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

const CONFIG: &str = r#"{"min_app":{"android":{"build":12,"from":"2027-03-01"},"ios":{"build":9,"from":"2027-03-01"}}}"#;
/// 2027-03-01T00:00:00+08:00.
const ON: i64 = 1_803_830_400;

/// Every case of spec/vectors/min-app.json.
#[test]
fn every_case_of_the_vectors() {
    let v = vectors("min-app.json");
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 49);
    let mut seen = std::collections::BTreeMap::<String, usize>::new();
    for c in cases {
        let name = text(c, "name");
        let client = match text(c, "client") {
            "android" => IDC_CLIENT_ANDROID,
            "ios" => IDC_CLIENT_IOS,
            other => panic!("{name}: client {other}"),
        };
        let build = u32::try_from(c["app_build"].as_u64().unwrap()).unwrap();
        let got = min_app(
            c["config"].to_string().as_bytes(),
            client,
            build,
            c["now"].as_i64().unwrap(),
        );
        let result = text(c, "result");
        let want = if result == "ok_until" {
            json!({"verdict": "ok_until", "from": text(c, "from")})
        } else {
            json!({ "verdict": result })
        };
        assert_eq!(got, Ok(want), "{name}");
        *seen.entry(result.to_owned()).or_default() += 1;
    }
    // The file has cases of each verdict.
    for verdict in ["ok", "ok_until", "stop", "unreadable"] {
        assert!(seen.get(verdict).copied().unwrap_or(0) > 0, "{verdict}");
    }
}

/// The body is read as bytes: what is not JSON, or not an object, is
/// unreadable, never an error; a number is read by its value.
#[test]
fn a_body_that_is_not_config() {
    for body in ["", "not JSON", "[]", "null", "{}", r#"{"min_app":null}"#] {
        assert_eq!(
            min_app(body.as_bytes(), IDC_CLIENT_ANDROID, 99, ON),
            Ok(json!({"verdict": "unreadable"})),
            "{body}"
        );
    }
    // A key twice is not one reading.
    let twice = r#"{"min_app":{"android":{"build":12,"build":1,"from":"2027-03-01"}}}"#;
    assert_eq!(
        min_app(twice.as_bytes(), IDC_CLIENT_ANDROID, 99, ON),
        Ok(json!({"verdict": "unreadable"}))
    );
    for build in ["12.0", "1.2e1"] {
        let body = CONFIG.replacen("12", build, 1);
        assert_eq!(
            min_app(body.as_bytes(), IDC_CLIENT_ANDROID, 11, ON),
            Ok(json!({"verdict": "stop"})),
            "{build}"
        );
        assert_eq!(
            min_app(body.as_bytes(), IDC_CLIENT_ANDROID, 12, ON),
            Ok(json!({"verdict": "ok"})),
            "{build}"
        );
    }
}

/// What is wrong with the call, not with the bytes.
#[test]
fn a_call_that_is_wrong() {
    let config = CONFIG.as_bytes();
    assert_eq!(min_app(config, 2, 12, ON), Err(IDC_ERR_ARGUMENT));
    // The phone's clock outside the years the core takes.
    for now in [
        0,
        946_684_800 - 8 * 3600 - 1,
        2_524_608_000 - 8 * 3600,
        i64::MAX,
    ] {
        assert_eq!(
            min_app(config, IDC_CLIENT_ANDROID, 12, now),
            Err(IDC_ERR_INPUT),
            "{now}"
        );
    }
    assert_eq!(
        unsafe {
            idc_min_app(
                config.as_ptr(),
                config.len(),
                IDC_CLIENT_IOS,
                9,
                ON,
                std::ptr::null_mut(),
            )
        },
        IDC_ERR_ARGUMENT
    );
    assert_eq!(
        min_app(config, IDC_CLIENT_IOS, 9, ON),
        Ok(json!({"verdict": "ok"}))
    );
}
