//! `idc_list_consequence`, called the way an app calls it: every case of
//! spec/vectors/list-consequence.json, and every record of
//! spec/vectors/record-rules.json that reaches check 5; then what
//! only the C function has (the shape of its input, the clock, pointers).

mod common;

use common::{text, vectors};
use iamreal_device_checks::date::Date;
use iamreal_device_checks::record_rules::{
    Account, Card, MemoryRecord, MemoryRules, Platform, RecordResult,
};
use iamreal_device_checks::username_format::UsernameFormat;
use iamreal_device_core::{
    IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_OK, IdcBuf, idc_buf_free, idc_list_consequence,
};
use serde_json::{Value, json};

/// Seconds since 1970-01-01T00:00:00Z at noon in Taiwan on `date`.
fn noon(date: &str) -> i64 {
    let d = Date::parse(date.as_bytes()).unwrap();
    // Noon in Taiwan is 04:00 UTC.
    d.days_since_1970() * 86_400 + 4 * 3600
}

/// Both platforms of spec/scope.md: the ones the test build of an app has its own definition of.
const KNOWN: &[u8] = br#"["test-example","threads"]"#;

fn call(platforms: &[u8], card_state: &[u8], accounts: &[u8], now: i64) -> Result<Value, i32> {
    call_knowing(platforms, card_state, KNOWN, accounts, now)
}

fn call_knowing(
    platforms: &[u8],
    card_state: &[u8],
    known: &[u8],
    accounts: &[u8],
    now: i64,
) -> Result<Value, i32> {
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let code = unsafe {
        idc_list_consequence(
            platforms.as_ptr(),
            platforms.len(),
            card_state.as_ptr(),
            card_state.len(),
            known.as_ptr(),
            known.len(),
            accounts.as_ptr(),
            accounts.len(),
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

fn consequence(
    platforms: &Value,
    card_state: &Value,
    accounts: &Value,
    today: &str,
) -> Result<Value, i32> {
    call(
        platforms.to_string().as_bytes(),
        card_state.to_string().as_bytes(),
        accounts.to_string().as_bytes(),
        noon(today),
    )
}

/// The `platforms` of `config` for one proof log: the rows of spec/vectors/scope.json it accepts.
fn config_platforms(proof_log: &str) -> Value {
    let v = vectors("scope.json");
    let mut rows: Vec<Value> = v["platforms"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| text(p, "proof_log") == proof_log && p["accepted"].as_bool().unwrap())
        .map(|p| json!({"platform": p["platform"], "display_name": p["display_name"], "username_format": p["username_format"]}))
        .collect();
    rows.sort_by(|a, b| text(a, "platform").cmp(text(b, "platform")));
    rows.into()
}

fn table(platforms: &Value) -> Vec<Platform> {
    platforms
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            Platform::new(
                text(p, "platform"),
                UsernameFormat::parse(text(p, "username_format").as_bytes()).unwrap(),
            )
        })
        .collect()
}

/// A card's state as `card-state` sends it, from a server whose daily limit
/// no card reaches: the record rules alone decide.
fn card_state(card: &Card) -> Value {
    let date = |d: Option<Date>| d.map_or(Value::Null, |d| json!(d.to_string()));
    json!({
        "last_card_proof": date(card.last_card_proof),
        "proofs_on_last_date": u64::from(card.last_card_proof.is_some()),
        "daily_limit": 9_007_199_254_740_991_u64,
        "platforms": card.slots.iter().map(|(p, s)| (p.clone(), json!({
            "current": s.current,
            "last_declared": s.last_declared,
            "switch_count": s.switch_count,
        }))).collect::<serde_json::Map<_, _>>(),
        "count": 1,
    })
}

#[test]
fn every_case_of_the_vectors_that_reaches_the_event_rules() {
    let v = vectors("record-rules.json");
    let mut seen = std::collections::BTreeSet::new();
    for c in v["cases"].as_array().unwrap() {
        let name = text(c, "name");
        let platforms = config_platforms(text(c, "proof_log"));
        let mut rules = MemoryRules::new(table(&platforms));
        for (e, want) in c["events"]
            .as_array()
            .unwrap()
            .iter()
            .zip(c["results"].as_array().unwrap())
        {
            let (scope, id) = (text(e, "scope_string"), text(e, "scoped_id"));
            // The device computes check 5 only; checks 1 to 4 are the server's.
            let reason = want["reason"].as_str();
            if matches!(reason, None | Some("empty" | "switch_limit")) {
                let got = consequence(
                    &platforms,
                    &card_state(&rules.card(scope, id)),
                    &e["accounts"],
                    text(e, "date"),
                )
                .unwrap_or_else(|code| panic!("{name}, event {}: code {code}", e["seq"]));
                if want["valid"] == json!(true) {
                    let kinds: Vec<Value> = got["rows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|r| json!({"platform": r["platform"], "kind": r["kind"]}))
                        .collect();
                    assert_eq!(json!(kinds), want["kinds"], "{name}, event {}", e["seq"]);
                    assert_eq!(
                        got["accounts"], e["accounts"],
                        "{name}, event {}: the list the card signs",
                        e["seq"]
                    );
                } else {
                    assert_eq!(got["valid"], json!(false), "{name}, event {}", e["seq"]);
                    assert_eq!(got["reason"], want["reason"], "{name}, event {}", e["seq"]);
                }
                seen.insert(reason.unwrap_or("valid"));
            }
            let accounts = e["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| Account {
                    platform: text(a, "platform").into(),
                    username: text(a, "username").into(),
                })
                .collect();
            let crl_dates = e["crl_dates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| Date::parse(d.as_str().unwrap().as_bytes()).unwrap())
                .collect();
            let outcome = rules
                .apply(&MemoryRecord {
                    scope_string: scope.into(),
                    scoped_id: id.into(),
                    challenge: text(e, "challenge").into(),
                    accounts,
                    verifies: e["verifies"].as_bool().unwrap(),
                    crl_dates,
                })
                .unwrap();
            assert_eq!(
                matches!(outcome.result, RecordResult::Valid(_)),
                want["valid"] == json!(true)
            );
        }
    }
    assert_eq!(seen.len(), 3, "valid, empty and switch_limit: {seen:?}");
}

#[test]
fn every_case_of_list_consequence_json() {
    let v = vectors("list-consequence.json");
    let cases = v["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let name = text(c, "name");
        let got = call_knowing(
            c["platforms"].to_string().as_bytes(),
            c["card_state"].to_string().as_bytes(),
            c["known_platforms"].to_string().as_bytes(),
            c["accounts"].to_string().as_bytes(),
            noon(text(c, "today")),
        );
        let want = &c["result"];
        if want.get("unread").is_some() || want.get("not_offered").is_some() {
            // The device does not go on; nothing is computed.
            assert_eq!(got, Err(IDC_ERR_INPUT), "{name}");
        } else {
            assert_eq!(got.as_ref(), Ok(want), "{name}");
        }
    }
}

const THREADS: &str =
    r#"[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]"#;

/// The example of docs/api/card-proof.md: bob on threads, 1 switch used.
const BOB: &str = r#"{"last_card_proof":"2026-11-04","proofs_on_last_date":1,"daily_limit":3,"platforms":{"threads":{"current":"bob","last_declared":"bob","switch_count":1}},"count":137}"#;

fn threads(card_state: &str, accounts: &str, today: &str) -> Result<Value, i32> {
    call(
        THREADS.as_bytes(),
        card_state.as_bytes(),
        accounts.as_bytes(),
        noon(today),
    )
}

#[test]
fn the_list_is_in_the_shape_of_a_record_s_accounts() {
    let two = r#"[{"platform":"test-example","display_name":"Example (no real service)","username_format":"[a-z0-9-]{1,20}"},{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]"#;
    let both = r#"{"last_card_proof":null,"proofs_on_last_date":0,"daily_limit":3,"platforms":{"test-example":{"current":null,"last_declared":null,"switch_count":0},"threads":{"current":null,"last_declared":null,"switch_count":0}},"count":0}"#;
    let now = noon("2026-11-16");
    let ordered = br#"[{"platform":"test-example","username":"bob"},{"platform":"threads","username":"bob"}]"#;
    assert!(call(two.as_bytes(), both.as_bytes(), ordered, now).is_ok());
    for list in [
        r#"[{"platform":"threads","username":"bob"},{"platform":"test-example","username":"bob"}]"#,
        r#"[{"platform":"threads","username":"bob"},{"platform":"threads","username":"carol"}]"#,
        r#"[{"platform":"threads","username":"bob","platform":"threads"}]"#,
        r#"[{"platform":"threads","username":"bob","more":1}]"#,
        r#"{"threads":"bob"}"#,
        "",
    ] {
        assert_eq!(
            call(two.as_bytes(), both.as_bytes(), list.as_bytes(), now),
            Err(IDC_ERR_INPUT),
            "{list}"
        );
    }
}

#[test]
fn an_answer_is_read_in_one_way() {
    // A key twice in one object: the core does not pick one.
    for state in [
        BOB.replace(r#""current":"bob","#, r#""current":"bob","current":"bob","#),
        BOB.replace(r#""count":137"#, r#""count":137,"count":137"#),
    ] {
        assert_eq!(
            threads(&state, "[]", "2026-11-16"),
            Err(IDC_ERR_INPUT),
            "{state}"
        );
    }
    let table = THREADS.replace(
        r#""platform":"threads","#,
        r#""platform":"threads","platform":"threads","#,
    );
    assert_eq!(
        call(table.as_bytes(), BOB.as_bytes(), b"[]", noon("2026-11-16")),
        Err(IDC_ERR_INPUT)
    );
    // A number is read by its value (spec/list-consequence.md, "Input").
    let state = BOB
        .replace(r#""switch_count":1"#, r#""switch_count":1.0"#)
        .replace(r#""count":137"#, r#""count":1.37e2"#);
    assert_eq!(
        threads(&state, "[]", "2026-11-16"),
        threads(BOB, "[]", "2026-11-16")
    );
}

#[test]
fn the_date_is_taiwan_s_whatever_the_time_zone_of_the_device() {
    // Three records dated 2026-03-02: the server writes none more that date.
    let today = BOB
        .replace("2026-11-04", "2026-03-02")
        .replace(r#""proofs_on_last_date":1"#, r#""proofs_on_last_date":3"#);
    let carol = r#"[{"platform":"threads","username":"carol"}]"#;
    // 2026-03-02T15:59:59Z is 23:59:59 in Taiwan, still that date; a second later it is not.
    let at = |now: i64| call(THREADS.as_bytes(), today.as_bytes(), carol.as_bytes(), now).unwrap();
    let midnight = noon("2026-03-03") - 12 * 3600;
    assert_eq!(
        at(midnight - 1),
        json!({"valid": false, "reason": "daily_limit"})
    );
    assert_eq!(at(midnight)["rows"][0]["kind"], json!("switch"));
    // A clock outside the years a challenge can carry.
    assert_eq!(
        call(THREADS.as_bytes(), BOB.as_bytes(), b"[]", 0),
        Err(IDC_ERR_INPUT)
    );
    assert_eq!(
        call(THREADS.as_bytes(), BOB.as_bytes(), b"[]", i64::MAX),
        Err(IDC_ERR_INPUT)
    );
}

#[test]
fn the_known_platforms_are_a_list_of_platform_ids() {
    let now = noon("2026-11-16");
    let bob = br#"[{"platform":"threads","username":"bob"}]"#;
    for known in [
        &br#"["threads"]"#[..],
        br#"["threads","test-example"]"#,
        br#"[]"#,
    ] {
        let got = call_knowing(THREADS.as_bytes(), BOB.as_bytes(), known, bob, now);
        let offered = known.windows(9).any(|w| w == b"\"threads\"");
        assert_eq!(got.is_ok(), offered, "{}", String::from_utf8_lossy(known));
    }
    for known in [
        &br#"["threads","threads"]"#[..],
        br#"["Threads"]"#,
        br#"[1]"#,
        br#""threads""#,
        b"",
    ] {
        assert_eq!(
            call_knowing(THREADS.as_bytes(), BOB.as_bytes(), known, b"[]", now),
            Err(IDC_ERR_INPUT),
            "{}",
            String::from_utf8_lossy(known)
        );
    }
}

#[test]
fn null_pointers_are_refused() {
    let now = noon("2026-11-16");
    let inputs: [&[u8]; 4] = [THREADS.as_bytes(), BOB.as_bytes(), KNOWN, b"[]"];
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let run = |pointers: [*const u8; 4], out: *mut IdcBuf| unsafe {
        idc_list_consequence(
            pointers[0],
            inputs[0].len(),
            pointers[1],
            inputs[1].len(),
            pointers[2],
            inputs[2].len(),
            pointers[3],
            inputs[3].len(),
            now,
            out,
        )
    };
    let pointers = inputs.map(<[u8]>::as_ptr);
    assert_eq!(run(pointers, &mut out), IDC_OK);
    unsafe { idc_buf_free(&mut out) };
    for i in 0..4 {
        let mut with_null = pointers;
        with_null[i] = std::ptr::null();
        assert_eq!(run(with_null, &mut out), IDC_ERR_ARGUMENT, "input {i}");
        assert!(out.ptr.is_null() && out.len == 0);
    }
    assert_eq!(run(pointers, std::ptr::null_mut()), IDC_ERR_ARGUMENT);
    // (NULL, 0) is no bytes: not JSON.
    let mut empty = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let code = unsafe {
        idc_list_consequence(
            pointers[0],
            inputs[0].len(),
            pointers[1],
            inputs[1].len(),
            pointers[2],
            inputs[2].len(),
            std::ptr::null(),
            0,
            now,
            &mut empty,
        )
    };
    assert_eq!(code, IDC_ERR_INPUT);
    assert!(empty.ptr.is_null() && empty.len == 0);
}
