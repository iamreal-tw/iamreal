//! The counts against spec/vectors/counts.json, the file the TypeScript
//! tests and the server read: the table is the same code for code and client
//! for client, every case is taken or dropped as the vectors say, and every
//! duration is the code the vectors give.

use std::collections::BTreeMap;

use iamreal_device_checks::counts::{
    BROWSERS, CARD_PROOF_ACTIONS, CLIENTS, Code, DURATIONS, EVENTS, OSES, PAGES, REASONS, SOURCES,
    STEPS, TAPS, TIMED_STEPS, VISITOR_ACTIONS, device_id, read_count, to_send, took,
};
use serde_json::Value;

fn vectors() -> Value {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/counts.json");
    serde_json::from_slice(&std::fs::read(path).expect("the vectors file")).expect("JSON")
}

fn list(v: &Value) -> Vec<&str> {
    v.as_array()
        .expect("a list")
        .iter()
        .map(|c| c.as_str().expect("a code"))
        .collect()
}

fn codes(v: &Value) -> BTreeMap<&str, Vec<&str>> {
    v.as_object()
        .expect("codes")
        .iter()
        .map(|(code, clients)| (code.as_str(), list(clients)))
        .collect()
}

fn ours(table: &[Code]) -> BTreeMap<&str, Vec<&str>> {
    table
        .iter()
        .map(|(code, clients)| (*code, clients.to_vec()))
        .collect()
}

/// A case's count as members, or `None` when it is no object of strings (the reading of its JSON drops it).
fn members(count: &Value) -> Option<Vec<(&str, &str)>> {
    count
        .as_object()?
        .iter()
        .map(|(name, v)| Some((name.as_str(), v.as_str()?)))
        .collect()
}

#[test]
fn the_table_is_the_one_of_the_vectors() {
    let v = vectors();
    let t = &v["table"];
    assert_eq!(list(&t["clients"]), CLIENTS);
    assert_eq!(list(&t["events"]), EVENTS);
    assert_eq!(list(&t["pages"]), PAGES);
    assert_eq!(list(&t["taps"]), TAPS);
    assert_eq!(list(&t["durations"]), DURATIONS);
    assert_eq!(list(&t["sources"]), SOURCES);
    assert_eq!(list(&t["browsers"]), BROWSERS);
    assert_eq!(list(&t["oses"]), OSES);
    assert_eq!(codes(&t["steps"]), ours(STEPS));
    assert_eq!(codes(&t["reasons"]), ours(REASONS));
    assert_eq!(codes(&t["card_proof_actions"]), ours(CARD_PROOF_ACTIONS));
    assert_eq!(codes(&t["visitor_actions"]), ours(VISITOR_ACTIONS));
    assert_eq!(codes(&t["timed_steps"]), ours(TIMED_STEPS));
}

#[test]
fn every_case_is_taken_or_dropped_as_the_vectors_say() {
    let v = vectors();
    let cases = v["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for c in cases {
        let name = c["name"].as_str().expect("a name");
        let taken = c["taken"].as_bool().expect("taken");
        let Some(count) = members(&c["count"]) else {
            assert!(!taken, "{name}: no object of strings, and taken");
            continue;
        };
        let kept = read_count(&count);
        assert_eq!(kept.is_some(), taken, "{name}");
        let Some(kept) = kept else { continue };
        // What is kept is what came, member for member.
        let mut came: Vec<(&str, &str)> = count.clone();
        came.sort();
        let mut went: Vec<(&str, &str)> = kept.clone();
        went.sort();
        assert_eq!(went, came, "{name}");
        // In one order, whatever order it came in.
        let mut reversed = count.clone();
        reversed.reverse();
        assert_eq!(read_count(&reversed), Some(kept.clone()), "{name}");
        // A count that is taken is sent as it is.
        assert_eq!(to_send(&count), Some(kept), "{name}");
    }
}

#[test]
fn every_duration_is_the_code_of_the_vectors() {
    let v = vectors();
    let durations = v["durations"].as_array().expect("durations");
    assert!(!durations.is_empty());
    for d in durations {
        let ms = d["ms"].as_u64().expect("milliseconds");
        assert_eq!(took(ms), d["took"].as_str().expect("a code"), "{ms} ms");
    }
    assert_eq!(took(u64::MAX), "gt_3m");
}

#[test]
fn a_member_twice_is_dropped() {
    let d = "0123456789abcdef0123456789abcdef";
    let once = [
        ("client", "ios"),
        ("event", "step"),
        ("step", "read"),
        ("device_id", d),
        ("attempt_id", d),
    ];
    assert!(read_count(&once).is_some());
    let twice = [
        ("client", "ios"),
        ("event", "step"),
        ("step", "read"),
        ("step", "read"),
        ("device_id", d),
        ("attempt_id", d),
    ];
    assert_eq!(read_count(&twice), None);
}

#[test]
fn a_value_of_the_system_not_in_its_format_is_left_out_of_what_is_sent() {
    let d = "0123456789abcdef0123456789abcdef";
    let base = [
        ("client", "android"),
        ("event", "step"),
        ("step", "read"),
        ("device_id", d),
        ("attempt_id", d),
    ];
    let with = |extra: &[(&'static str, &'static str)]| -> Vec<(&'static str, &'static str)> {
        base.iter().copied().chain(extra.iter().copied()).collect()
    };
    // In their form: sent.
    let all = with(&[
        ("os_version", "14"),
        ("app_version", "2026.11.5"),
        ("model", "moto g(60)"),
    ]);
    assert_eq!(to_send(&all).expect("sent").len(), all.len());
    // Not in their form: each left out on its own, not rewritten; the rest is sent.
    for (name, bad) in [
        ("os_version", "VanillaIceCream"),
        ("app_version", "dev"),
        ("model", "Alice’s phone"),
        ("model", "A very long model name of 33 char"),
    ] {
        let good = [
            ("os_version", "14"),
            ("app_version", "2026.11.5"),
            ("model", "SM-S918B"),
        ];
        let members: Vec<(&str, &str)> = good
            .iter()
            .map(|&(n, v)| if n == name { (n, bad) } else { (n, v) })
            .collect();
        let sent = to_send(&with(&members)).expect("sent");
        assert!(
            sent.iter().all(|(n, _)| *n != name),
            "{name} {bad} is left out"
        );
        assert_eq!(
            sent.len(),
            base.len() + 2,
            "{name} {bad}: the others are sent"
        );
    }
    // A member an app may not send at all is not left out: the count is a fault, and not sent.
    assert_eq!(to_send(&with(&[("reader", "ACS ACR122U")])), None);
    assert_eq!(to_send(&with(&[("browser", "chrome")])), None);
    // Nor is a code the table has not.
    assert_eq!(
        to_send(&[
            ("client", "android"),
            ("event", "step"),
            ("step", "reading"),
            ("device_id", d),
            ("attempt_id", d)
        ]),
        None
    );
}

#[test]
fn every_device_id_of_the_vectors() {
    let v = vectors();
    let cases = v["device_ids"].as_array().expect("device_ids");
    assert!(!cases.is_empty());
    for d in cases {
        let name = d["name"].as_str().expect("a name");
        let today =
            iamreal_device_checks::date::Date::in_taiwan(d["now"].as_i64().expect("seconds"))
                .expect("a day");
        let random: [u8; 16] = (0..16)
            .map(|i| {
                u8::from_str_radix(&d["random"].as_str().expect("hex")[2 * i..2 * i + 2], 16)
                    .unwrap()
            })
            .collect::<Vec<_>>()
            .try_into()
            .unwrap();
        let (id, store) = device_id(d["stored"].as_str(), today, &random);
        assert_eq!(id, d["device_id"].as_str().expect("an ID"), "{name}");
        assert_eq!(store.as_deref(), d["store"].as_str(), "{name}");
    }
}
