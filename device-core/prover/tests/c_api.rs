//! The C functions, called the way an app calls them: pointers and
//! lengths in, an `idc_buf` out, a code back. Against spec/vectors/.

mod common;

use common::{cases, text, vectors};
use iamreal_device_core::{
    IDC_ABI_VERSION, IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_OK, IDC_ROSTER_PRODUCTION,
    IDC_ROSTER_TEST, IdcBuf, idc_abi_version, idc_buf_free, idc_declaration_code, idc_scope_string,
    idc_self_check,
};

const CHALLENGE: &[u8] = b"2026-11-16.000G40R40M30E209185GR38E1W";

fn empty() -> IdcBuf {
    IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    }
}

/// Copies the bytes out of `buf` and gives it back to the core.
fn take(mut buf: IdcBuf) -> Vec<u8> {
    assert!(!buf.ptr.is_null());
    let bytes = unsafe { std::slice::from_raw_parts(buf.ptr, buf.len) }.to_vec();
    unsafe { idc_buf_free(&mut buf) };
    assert!(buf.ptr.is_null() && buf.len == 0, "a freed buffer is empty");
    // A second call with the same buffer does nothing.
    unsafe { idc_buf_free(&mut buf) };
    bytes
}

fn scope_string(roster: u32) -> Result<Vec<u8>, i32> {
    let mut out = empty();
    match unsafe { idc_scope_string(roster, &mut out) } {
        IDC_OK => Ok(take(out)),
        code => {
            assert!(out.ptr.is_null() && out.len == 0, "no bytes with an error");
            Err(code)
        }
    }
}

fn declaration_code(roster: u32, accounts_json: &[u8], challenge: &[u8]) -> Result<Vec<u8>, i32> {
    let mut out = empty();
    let code = unsafe {
        idc_declaration_code(
            roster,
            accounts_json.as_ptr(),
            accounts_json.len(),
            challenge.as_ptr(),
            challenge.len(),
            &mut out,
        )
    };
    match code {
        IDC_OK => Ok(take(out)),
        code => {
            assert!(out.ptr.is_null() && out.len == 0, "no bytes with an error");
            Err(code)
        }
    }
}

fn roster_number(v: &serde_json::Value) -> u32 {
    match text(v, "roster") {
        "production" => IDC_ROSTER_PRODUCTION,
        "test" => IDC_ROSTER_TEST,
        other => panic!("roster {other}"),
    }
}

#[test]
fn the_version_of_the_c_functions() {
    assert_eq!(idc_abi_version(), IDC_ABI_VERSION);
}

#[test]
fn the_linked_barretenberg_passes_the_self_check() {
    assert_eq!(idc_self_check(), IDC_OK);
}

#[test]
fn the_scope_string_of_each_roster() {
    let v = vectors("scope.json");
    let mut seen = 0;
    for s in cases(&v, "scopes") {
        if s["accepted"].as_bool().unwrap() {
            assert_eq!(
                scope_string(roster_number(s)).unwrap(),
                text(s, "scope_string").as_bytes()
            );
            seen += 1;
        }
    }
    assert_eq!(seen, 2, "one accepted scope string for each roster");
    assert_eq!(scope_string(2), Err(IDC_ERR_ARGUMENT));
    assert_eq!(scope_string(u32::MAX), Err(IDC_ERR_ARGUMENT));
    assert_eq!(
        unsafe { idc_scope_string(IDC_ROSTER_TEST, std::ptr::null_mut()) },
        IDC_ERR_ARGUMENT
    );
}

#[test]
fn the_declaration_code_of_every_case() {
    let v = vectors("declaration-code.json");
    let scopes = [
        (
            IDC_ROSTER_PRODUCTION,
            scope_string(IDC_ROSTER_PRODUCTION).unwrap(),
        ),
        (IDC_ROSTER_TEST, scope_string(IDC_ROSTER_TEST).unwrap()),
    ];
    let mut rosters_seen = std::collections::BTreeSet::new();
    for c in cases(&v, "cases") {
        let label = text(c, "label");
        // The function takes a roster, not a scope string: the cases are in the two open scopes.
        let (roster, _) = scopes
            .iter()
            .find(|(_, s)| s == text(c, "scope_string").as_bytes())
            .unwrap_or_else(|| panic!("{label}: an open scope"));
        rosters_seen.insert(*roster);
        let accounts_json = serde_json::to_vec(&c["accounts"]).unwrap();
        let code = declaration_code(*roster, &accounts_json, text(c, "challenge").as_bytes())
            .unwrap_or_else(|e| panic!("{label}: {e}"));
        assert_eq!(
            std::str::from_utf8(&code).unwrap(),
            text(c, "declaration_code"),
            "{label}"
        );
    }
    assert_eq!(rosters_seen.len(), 2, "cases in both rosters");
}

#[test]
fn a_declaration_code_is_not_computed_from_what_is_not_a_list_or_a_challenge() {
    let one = br#"[{"platform":"threads","username":"alice"}]"#;
    assert!(declaration_code(IDC_ROSTER_TEST, one, CHALLENGE).is_ok());
    for (why, accounts) in [
        ("not JSON", &b"threads:alice"[..]),
        ("no bytes", b""),
        ("not a list", br#"{"platform":"threads","username":"alice"}"#),
        ("an account without a username", br#"[{"platform":"threads"}]"#),
        ("a third key", br#"[{"platform":"threads","username":"alice","note":"x"}]"#),
        ("a key twice", br#"[{"platform":"x","platform":"threads","username":"alice"}]"#),
        ("a username twice", br#"[{"platform":"threads","username":"alice","username":"alice"}]"#),
        ("an account that is a list", br#"[["threads","alice"]]"#),
        ("a username that is not a string", br#"[{"platform":"threads","username":1}]"#),
        ("out of order", br#"[{"platform":"threads","username":"a"},{"platform":"test-example","username":"a"}]"#),
        ("a platform twice", br#"[{"platform":"threads","username":"a"},{"platform":"threads","username":"b"}]"#),
        ("a platform ID with a colon", br#"[{"platform":"a:b","username":"a"}]"#),
        ("an uppercase platform ID", br#"[{"platform":"Threads","username":"a"}]"#),
        ("a line feed in the username", br#"[{"platform":"threads","username":"a\nthreads:b"}]"#),
        ("an empty username", br#"[{"platform":"threads","username":""}]"#),
        ("a username outside ASCII", "[{\"platform\":\"threads\",\"username\":\"é\"}]".as_bytes()),
        ("something after the list", br#"[] []"#),
    ] {
        assert_eq!(declaration_code(IDC_ROSTER_TEST, accounts, CHALLENGE), Err(IDC_ERR_INPUT), "{why}");
    }
    for c in cases(&vectors("challenge.json"), "invalid") {
        let challenge = text(c, "challenge");
        assert_eq!(
            declaration_code(IDC_ROSTER_TEST, one, challenge.as_bytes()),
            Err(IDC_ERR_INPUT),
            "{challenge:?}"
        );
    }
    assert_eq!(declaration_code(7, one, CHALLENGE), Err(IDC_ERR_ARGUMENT));
}

#[test]
fn null_pointers_are_refused() {
    let one = br#"[{"platform":"threads","username":"alice"}]"#;
    let mut out = empty();
    let null = std::ptr::null();
    unsafe {
        assert_eq!(
            idc_declaration_code(
                IDC_ROSTER_TEST,
                null,
                5,
                CHALLENGE.as_ptr(),
                CHALLENGE.len(),
                &mut out
            ),
            IDC_ERR_ARGUMENT
        );
        assert_eq!(
            idc_declaration_code(IDC_ROSTER_TEST, one.as_ptr(), one.len(), null, 37, &mut out),
            IDC_ERR_ARGUMENT
        );
        assert_eq!(
            idc_declaration_code(
                IDC_ROSTER_TEST,
                one.as_ptr(),
                one.len(),
                CHALLENGE.as_ptr(),
                CHALLENGE.len(),
                std::ptr::null_mut()
            ),
            IDC_ERR_ARGUMENT
        );
        // A length no buffer has is refused before anything is read.
        assert_eq!(
            idc_declaration_code(
                IDC_ROSTER_TEST,
                one.as_ptr(),
                usize::MAX,
                CHALLENGE.as_ptr(),
                CHALLENGE.len(),
                &mut out
            ),
            IDC_ERR_ARGUMENT
        );
        // No bytes may be passed as (NULL, 0): here the empty input is not JSON.
        assert_eq!(
            idc_declaration_code(
                IDC_ROSTER_TEST,
                null,
                0,
                CHALLENGE.as_ptr(),
                CHALLENGE.len(),
                &mut out
            ),
            IDC_ERR_INPUT
        );
        assert!(out.ptr.is_null() && out.len == 0);
        idc_buf_free(std::ptr::null_mut());
        idc_buf_free(&mut out);
    }
}

#[test]
fn an_error_leaves_the_output_empty_whatever_it_held() {
    // An `idc_buf` the caller did not initialise holds anything.
    let mut out = IdcBuf {
        ptr: std::ptr::dangling_mut(),
        len: 99,
    };
    assert_eq!(unsafe { idc_scope_string(9, &mut out) }, IDC_ERR_ARGUMENT);
    assert!(out.ptr.is_null() && out.len == 0);
}
