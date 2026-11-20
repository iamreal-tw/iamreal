//! `idc_list_consequence`, called the way an app calls it: what a list
//! does on every platform, from the platform table and the card's state the
//! server sent, before the card signs the list (spec/roster-rules.md,
//! checks 5 and 6; docs/api/card-proof.md, card-state).

mod common;

use common::{text, vectors};
use iamreal_device_checks::date::Date;
use iamreal_device_checks::roster_rules::{
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
    // 2000-01-01 is day 10957 after 1970-01-01; noon in Taiwan is 04:00 UTC.
    (i64::from(d.day_number()) + 10_957) * 86_400 + 4 * 3600
}

fn call(platforms: &[u8], card_state: &[u8], accounts: &[u8], now: i64) -> Result<Value, i32> {
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

/// The `platforms` of `config` for one roster: the rows of spec/vectors/scope.json it accepts.
fn config_platforms(roster: &str) -> Value {
    let v = vectors("scope.json");
    let mut rows: Vec<Value> = v["platforms"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| text(p, "roster") == roster && p["accepted"].as_bool().unwrap())
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

/// A card's state as `card-state` sends it.
fn card_state(card: &Card) -> Value {
    let date = |d: Option<Date>| d.map_or(Value::Null, |d| json!(d.to_string()));
    json!({
        "last_card_proof": date(card.last_card_proof),
        "proofs_on_last_date": card.proofs_on_last_date,
        "platforms": card.slots.iter().map(|(p, s)| (p.clone(), json!({
            "current": s.current,
            "last_declared": s.last_declared,
            "switch_count": s.switch_count,
            "correction_date": date(s.correction_date),
        }))).collect::<serde_json::Map<_, _>>(),
        "count": 1,
    })
}

#[test]
fn every_case_of_the_vectors_that_reaches_the_event_rules() {
    let v = vectors("roster-rules.json");
    let mut seen = std::collections::BTreeSet::new();
    for c in v["cases"].as_array().unwrap() {
        let name = text(c, "name");
        let platforms = config_platforms(text(c, "roster"));
        let mut rules = MemoryRules::new(table(&platforms));
        for (e, want) in c["events"]
            .as_array()
            .unwrap()
            .iter()
            .zip(c["results"].as_array().unwrap())
        {
            let (scope, id) = (text(e, "scope_string"), text(e, "scoped_id"));
            // The device computes checks 5 and 6 only; checks 1 to 4 are the server's.
            let reason = want["reason"].as_str();
            if matches!(
                reason,
                None | Some("empty" | "switch_limit" | "daily_limit")
            ) {
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
    assert_eq!(
        seen.len(),
        4,
        "valid, empty, switch_limit and daily_limit: {seen:?}"
    );
}

const THREADS: &str =
    r#"[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]"#;

/// The example of docs/api/card-proof.md: bob on threads, 1 switch used, its last switch on 2026-03-02.
const BOB: &str = r#"{"last_card_proof":"2026-11-04","proofs_on_last_date":1,"platforms":{"threads":{"current":"bob","last_declared":"bob","switch_count":1,"correction_date":"2026-03-02"}},"count":137}"#;

fn threads(card_state: &str, accounts: &str, today: &str) -> Result<Value, i32> {
    call(
        THREADS.as_bytes(),
        card_state.as_bytes(),
        accounts.as_bytes(),
        noon(today),
    )
}

#[test]
fn each_row_says_what_the_list_does_and_how_many_switches_stay() {
    // Another account on a later date: a switch, the second of five.
    assert_eq!(
        threads(
            BOB,
            r#"[{"platform":"threads","username":"carol"}]"#,
            "2026-11-16"
        ),
        Ok(json!({
            "valid": true,
            "accounts": [{"platform": "threads", "username": "carol"}],
            "rows": [{"platform": "threads", "kind": "switch", "username": "carol", "previous": "bob", "switches_left": 3}],
        }))
    );
    // The same account: nothing changes.
    assert_eq!(
        threads(
            BOB,
            r#"[{"platform":"threads","username":"bob"}]"#,
            "2026-11-16"
        ),
        Ok(json!({
            "valid": true,
            "accounts": [{"platform": "threads", "username": "bob"}],
            "rows": [{"platform": "threads", "kind": "refresh", "username": "bob", "previous": null, "switches_left": 4}],
        }))
    );
    // Left out: withdrawn; the row names the account withdrawn.
    assert_eq!(
        threads(BOB, "[]", "2026-11-16"),
        Ok(json!({
            "valid": true,
            "accounts": [],
            "rows": [{"platform": "threads", "kind": "withdraw", "username": "bob", "previous": null, "switches_left": 4}],
        }))
    );
    // Another account on the date of the last switch: a correction, not counted.
    let today = BOB.replace("2026-11-04", "2026-03-02");
    assert_eq!(
        threads(
            &today,
            r#"[{"platform":"threads","username":"carol"}]"#,
            "2026-03-02"
        ),
        Ok(json!({
            "valid": true,
            "accounts": [{"platform": "threads", "username": "carol"}],
            "rows": [{"platform": "threads", "kind": "correction", "username": "carol", "previous": "bob", "switches_left": 4}],
        }))
    );
    // A card without a record.
    let new = r#"{"last_card_proof":null,"proofs_on_last_date":0,"platforms":{"threads":{"current":null,"last_declared":null,"switch_count":0,"correction_date":null}},"count":0}"#;
    assert_eq!(
        threads(
            new,
            r#"[{"platform":"threads","username":"alice"}]"#,
            "2026-11-16"
        ),
        Ok(json!({
            "valid": true,
            "accounts": [{"platform": "threads", "username": "alice"}],
            "rows": [{"platform": "threads", "kind": "first", "username": "alice", "previous": null, "switches_left": 5}],
        }))
    );
    // After a withdrawal, another account is a switch from the last one declared.
    let withdrawn = BOB.replace(r#""current":"bob""#, r#""current":null"#);
    assert_eq!(
        threads(
            &withdrawn,
            r#"[{"platform":"threads","username":"carol"}]"#,
            "2026-11-16"
        )
        .unwrap()["rows"],
        json!([{"platform": "threads", "kind": "switch", "username": "carol", "previous": "bob", "switches_left": 3}])
    );
}

#[test]
fn a_list_the_rules_refuse_is_a_result_not_an_error() {
    let used_up = BOB.replace(r#""switch_count":1"#, r#""switch_count":5"#);
    assert_eq!(
        threads(
            &used_up,
            r#"[{"platform":"threads","username":"carol"}]"#,
            "2026-11-16"
        ),
        Ok(json!({"valid": false, "reason": "switch_limit", "platform": "threads"}))
    );
    let new = r#"{"last_card_proof":null,"proofs_on_last_date":0,"platforms":{"threads":{"current":null,"last_declared":null,"switch_count":0,"correction_date":null}},"count":0}"#;
    assert_eq!(
        threads(new, "[]", "2026-11-16"),
        Ok(json!({"valid": false, "reason": "empty"}))
    );
    let three_today = BOB.replace(r#""proofs_on_last_date":1"#, r#""proofs_on_last_date":3"#);
    assert_eq!(
        threads(
            &three_today,
            r#"[{"platform":"threads","username":"bob"}]"#,
            "2026-11-04"
        ),
        Ok(json!({"valid": false, "reason": "daily_limit"}))
    );
    // The next date allows three more.
    assert_eq!(
        threads(
            &three_today,
            r#"[{"platform":"threads","username":"bob"}]"#,
            "2026-11-05"
        )
        .unwrap()["valid"],
        json!(true)
    );
}

#[test]
fn an_account_on_a_platform_the_device_does_not_know_stays_in_the_list_as_it_is() {
    // `example` is not in the table the server sent; its account stays, in its place by platform.
    let state = r#"{"last_card_proof":"2026-11-04","proofs_on_last_date":1,"platforms":{"threads":{"current":"bob","last_declared":"bob","switch_count":1,"correction_date":"2026-03-02"},"example":{"current":"Bob Example","whatever":1},"zzz":{"current":null}},"count":1}"#;
    assert_eq!(
        threads(
            state,
            r#"[{"platform":"threads","username":"carol"}]"#,
            "2026-11-16"
        ),
        Ok(json!({
            "valid": true,
            "accounts": [{"platform": "example", "username": "Bob Example"}, {"platform": "threads", "username": "carol"}],
            "rows": [
                {"platform": "example", "kind": "refresh", "username": "Bob Example", "previous": null, "switches_left": null},
                {"platform": "threads", "kind": "switch", "username": "carol", "previous": "bob", "switches_left": 3},
            ],
        }))
    );
    // The empty list does not withdraw it: the card still declares an account.
    assert_eq!(
        threads(state, "[]", "2026-11-16").unwrap()["accounts"],
        json!([{"platform": "example", "username": "Bob Example"}])
    );
    // The cardholder cannot name it: it is not offered.
    assert_eq!(
        threads(
            state,
            r#"[{"platform":"example","username":"Bob Example"},{"platform":"threads","username":"carol"}]"#,
            "2026-11-16"
        ),
        Err(IDC_ERR_INPUT)
    );
    // A row of the table the device cannot read is a platform it does not know.
    let unreadable_row = r#"[{"platform":"example","display_name":"Example","username_format":"[a-z"},{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]"#;
    assert_eq!(
        call(
            unreadable_row.as_bytes(),
            state.as_bytes(),
            b"[]",
            noon("2026-11-16")
        )
        .unwrap()["accounts"],
        json!([{"platform": "example", "username": "Bob Example"}])
    );
}

#[test]
fn a_platform_of_the_table_without_an_entry_is_not_offered() {
    let two = r#"[{"platform":"test-example","display_name":"Example (no real service)","username_format":"[a-z0-9-]{1,20}"},{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]"#;
    let only_threads = BOB;
    assert_eq!(
        call(
            two.as_bytes(),
            only_threads.as_bytes(),
            br#"[{"platform":"threads","username":"bob"}]"#,
            noon("2026-11-16")
        )
        .unwrap()["rows"],
        json!([{"platform": "threads", "kind": "refresh", "username": "bob", "previous": null, "switches_left": 4}])
    );
    assert_eq!(
        call(
            two.as_bytes(),
            only_threads.as_bytes(),
            br#"[{"platform":"test-example","username":"bob"}]"#,
            noon("2026-11-16")
        ),
        Err(IDC_ERR_INPUT)
    );
}

#[test]
fn a_list_that_is_not_one_of_the_platforms_offered_is_refused() {
    for list in [
        r#"[{"platform":"threads","username":"Bob"}]"#,
        r#"[{"platform":"threads","username":"bob"},{"platform":"threads","username":"carol"}]"#,
        r#"[{"platform":"instagram","username":"bob"}]"#,
        r#"[{"platform":"threads","username":"bob","platform":"threads"}]"#,
        r#"{"threads":"bob"}"#,
        "",
    ] {
        assert_eq!(
            threads(BOB, list, "2026-11-16"),
            Err(IDC_ERR_INPUT),
            "{list}"
        );
    }
    let two = r#"[{"platform":"test-example","display_name":"Example (no real service)","username_format":"[a-z0-9-]{1,20}"},{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]"#;
    let both = r#"{"last_card_proof":null,"proofs_on_last_date":0,"platforms":{"test-example":{"current":null,"last_declared":null,"switch_count":0,"correction_date":null},"threads":{"current":null,"last_declared":null,"switch_count":0,"correction_date":null}},"count":0}"#;
    let ordered = br#"[{"platform":"test-example","username":"bob"},{"platform":"threads","username":"bob"}]"#;
    let unordered = br#"[{"platform":"threads","username":"bob"},{"platform":"test-example","username":"bob"}]"#;
    assert!(call(two.as_bytes(), both.as_bytes(), ordered, noon("2026-11-16")).is_ok());
    assert_eq!(
        call(
            two.as_bytes(),
            both.as_bytes(),
            unordered,
            noon("2026-11-16")
        ),
        Err(IDC_ERR_INPUT)
    );
}

#[test]
fn a_card_state_the_device_cannot_read_is_refused() {
    let replace = |from: &str, to: &str| {
        assert!(BOB.contains(from), "{from}");
        BOB.replace(from, to)
    };
    for state in [
        replace(r#""last_card_proof":"2026-11-04","#, ""),
        replace(r#""proofs_on_last_date":1"#, r#""proofs_on_last_date":1.5"#),
        replace(r#""proofs_on_last_date":1"#, r#""proofs_on_last_date":"1""#),
        replace(r#""proofs_on_last_date":1"#, r#""proofs_on_last_date":0"#),
        replace(r#""proofs_on_last_date":1"#, r#""proofs_on_last_date":4"#),
        replace(r#""last_card_proof":"2026-11-04""#, r#""last_card_proof":"2026-11-20""#),
        replace(r#""last_card_proof":"2026-11-04""#, r#""last_card_proof":"2026-11-4""#),
        replace(r#""last_card_proof":"2026-11-04""#, r#""last_card_proof":null"#),
        replace(r#""switch_count":1"#, r#""switch_count":6"#),
        replace(r#""switch_count":1"#, r#""switch_count":-1"#),
        replace(r#""switch_count":1,"#, ""),
        replace(r#""current":"bob""#, r#""current":"Bob""#),
        replace(r#""current":"bob""#, r#""current":"carol""#),
        replace(r#""correction_date":"2026-03-02""#, r#""correction_date":null"#),
        replace(r#""correction_date":"2026-03-02""#, r#""correction_date":"2026-11-05""#),
        replace(r#","correction_date":"2026-03-02""#, ""),
        replace(r#""current":"bob","#, r#""current":"bob","current":"bob","#),
        replace(r#""last_card_proof":"2026-11-04""#, r#""last_card_proof":"2026-11-04","last_card_proof":"2026-11-04""#),
        replace(r#"{"current":"bob","last_declared":"bob","switch_count":1,"correction_date":"2026-03-02"}"#, "[]"),
        replace(r#""platforms":{"#, r#""platforms":{"Example":{"current":"bob"},"#),
        replace(r#""platforms":{"#, r#""platforms":{"example":{"current":"a\"b"},"#),
        replace(r#""platforms":{"#, r#""platforms":{"example":{"last_declared":null},"#),
        replace(r#""platforms":{"#, r#""platforms":{"example":"bob","#),
        r#"{"last_card_proof":null,"proofs_on_last_date":0,"platforms":{"example":{"current":"bob"}},"count":0}"#.to_owned(),
        r#"{"last_card_proof":null,"proofs_on_last_date":0,"count":0}"#.to_owned(),
        "[]".to_owned(),
        "".to_owned(),
    ] {
        assert_eq!(threads(&state, "[]", "2026-11-16"), Err(IDC_ERR_INPUT), "{state}");
    }
    // What is read is read: fields it does not know are ignored, and a count is a number with no fraction.
    for state in [
        replace(r#""count":137"#, r#""count":137,"head":"x""#),
        replace(r#""switch_count":1"#, r#""switch_count":1,"next":2"#),
        replace(r#""switch_count":1"#, r#""switch_count":1.0"#),
        // The last card proof may be up to 3 days ahead of the device's date.
        replace(
            r#""last_card_proof":"2026-11-04""#,
            r#""last_card_proof":"2026-11-19""#,
        ),
    ] {
        assert!(threads(&state, "[]", "2026-11-16").is_ok(), "{state}");
    }
}

#[test]
fn a_platform_table_the_device_cannot_read_is_refused() {
    for platforms in [
        // Not in ascending order of platform.
        r#"[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"},{"platform":"example","display_name":"Example","username_format":"[a-z]{1,9}"}]"#,
        // No row it can read.
        r#"[{"platform":"threads","display_name":"Threads","username_format":"a+"}]"#,
        r#"[{"platform":"threads","display_name":"","username_format":"[a-z0-9._]{1,30}"}]"#,
        "[]",
        r#"{"platforms":[]}"#,
    ] {
        assert_eq!(
            call(
                platforms.as_bytes(),
                BOB.as_bytes(),
                b"[]",
                noon("2026-11-16")
            ),
            Err(IDC_ERR_INPUT),
            "{platforms}"
        );
    }
    // An element that names no platform is passed over.
    let with_junk = r#"[1,{"platform":"Threads"},{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}","more":true}]"#;
    assert!(
        call(
            with_junk.as_bytes(),
            BOB.as_bytes(),
            b"[]",
            noon("2026-11-16")
        )
        .is_ok()
    );
}

#[test]
fn the_date_is_taiwan_s_whatever_the_time_zone_of_the_device() {
    let today = BOB.replace("2026-11-04", "2026-03-02");
    let carol = r#"[{"platform":"threads","username":"carol"}]"#;
    // 2026-03-02T15:59:59Z is 23:59:59 in Taiwan, still the date of the switch; a second later it is not.
    let at = |now: i64| {
        call(THREADS.as_bytes(), today.as_bytes(), carol.as_bytes(), now).unwrap()["rows"][0]["kind"].clone()
    };
    let midnight = noon("2026-03-03") - 12 * 3600;
    assert_eq!(at(midnight - 1), json!("correction"));
    assert_eq!(at(midnight), json!("switch"));
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
fn null_pointers_are_refused() {
    let null = std::ptr::null();
    let mut out = IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    };
    let (p, s, a) = (THREADS.as_bytes(), BOB.as_bytes(), b"[]");
    let now = noon("2026-11-16");
    unsafe {
        assert_eq!(
            idc_list_consequence(
                null,
                1,
                s.as_ptr(),
                s.len(),
                a.as_ptr(),
                a.len(),
                now,
                &mut out
            ),
            IDC_ERR_ARGUMENT
        );
        assert_eq!(
            idc_list_consequence(
                p.as_ptr(),
                p.len(),
                null,
                1,
                a.as_ptr(),
                a.len(),
                now,
                &mut out
            ),
            IDC_ERR_ARGUMENT
        );
        assert_eq!(
            idc_list_consequence(
                p.as_ptr(),
                p.len(),
                s.as_ptr(),
                s.len(),
                null,
                1,
                now,
                &mut out
            ),
            IDC_ERR_ARGUMENT
        );
        assert_eq!(
            idc_list_consequence(
                p.as_ptr(),
                p.len(),
                s.as_ptr(),
                s.len(),
                a.as_ptr(),
                a.len(),
                now,
                std::ptr::null_mut()
            ),
            IDC_ERR_ARGUMENT
        );
        // (NULL, 0) is no bytes: not JSON.
        assert_eq!(
            idc_list_consequence(
                p.as_ptr(),
                p.len(),
                s.as_ptr(),
                s.len(),
                null,
                0,
                now,
                &mut out
            ),
            IDC_ERR_INPUT
        );
    }
    assert!(out.ptr.is_null() && out.len == 0);
}
