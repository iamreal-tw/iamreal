//! The roster rules (spec/roster-rules.md) against
//! spec/vectors/roster-rules.json, the file the Go and TypeScript tests
//! read: every case, record by record, through the state kept in memory.

use iamreal_device_checks::date::Date;
use iamreal_device_checks::roster_rules::{
    Account, Card, MemoryRecord, MemoryRules, Platform, RULES_VERSION, RecordResult, possible_card,
    possible_slot,
};
use iamreal_device_checks::username_format::UsernameFormat;
use serde_json::{Value, json};

fn repo_file(path: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path);
    std::fs::read(path).expect("a file of the repository")
}

fn vectors(name: &str) -> Value {
    serde_json::from_slice(&repo_file(&format!("spec/vectors/{name}"))).expect("JSON")
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
}

fn date(s: &str) -> Date {
    Date::parse(s.as_bytes()).unwrap_or_else(|| panic!("the date {s}"))
}

fn date_text(d: Option<Date>) -> Value {
    d.map_or(Value::Null, |d| json!(d.to_string()))
}

/// The platform table of `roster` (spec/scope.md): the rows of
/// spec/vectors/scope.json it accepts. The device gets its table from the
/// server; a recomputation of the roster takes the table of its roster.
fn table(roster: &str) -> Vec<Platform> {
    let v = vectors("scope.json");
    v["platforms"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| text(p, "roster") == roster && p["accepted"].as_bool().unwrap())
        .map(|p| {
            Platform::new(
                text(p, "platform"),
                UsernameFormat::parse(text(p, "username_format").as_bytes()).unwrap(),
            )
        })
        .collect()
}

fn accounts(v: &Value) -> Vec<Account> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|a| Account {
            platform: text(a, "platform").to_owned(),
            username: text(a, "username").to_owned(),
        })
        .collect()
}

/// A result in the vectors' spelling, without `seq`.
fn result_out(r: &RecordResult) -> Value {
    match r {
        RecordResult::Valid(kinds) => json!({
            "valid": true,
            "kinds": kinds.iter().map(|k| json!({"platform": k.platform, "kind": k.kind.name()})).collect::<Vec<_>>(),
        }),
        RecordResult::Invalid(reason) => json!({"valid": false, "reason": reason.name()}),
    }
}

/// A card's slots in the vectors' spelling.
fn slots_out(card: &Card) -> Value {
    card.slots
        .iter()
        .map(|(p, s)| {
            (
                p.clone(),
                json!({
                    "current": s.current,
                    "last_declared": s.last_declared,
                    "switch_count": s.switch_count,
                    "correction_date": date_text(s.correction_date),
                }),
            )
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

/// The state in memory in the vectors' spelling of `state`.
fn state_out(rules: &MemoryRules) -> Value {
    rules
        .output()
        .iter()
        .map(|scope| {
            json!({
                "scope_string": scope.scope_string,
                "cards": scope.cards.iter().map(|c| {
                    let card = rules.card(&scope.scope_string, &c.scoped_id);
                    json!({
                        "scoped_id": c.scoped_id,
                        "last_card_proof": c.last_card_proof.to_string(),
                        "accounts": c.accounts.iter().map(|a| json!({"platform": a.platform, "username": a.username})).collect::<Vec<_>>(),
                        "proofs_on_last_date": card.proofs_on_last_date,
                        "slots": slots_out(&card),
                    })
                }).collect::<Vec<_>>(),
                "accounts": scope.accounts.iter().map(|a| json!({
                    "platform": a.platform,
                    "username": a.username,
                    "cards": a.cards.iter().map(|(id, d)| json!({"scoped_id": id, "last_card_proof": d.to_string()})).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            })
        })
        .collect::<Vec<_>>()
        .into()
}

#[test]
fn the_version_is_the_one_the_specification_states_and_the_vectors_carry() {
    let spec = String::from_utf8(repo_file("spec/roster-rules.md")).unwrap();
    let stated: Vec<&str> = spec
        .lines()
        .filter_map(|l| {
            l.strip_prefix("**These rules are version ")?
                .strip_suffix(".**")
        })
        .collect();
    assert_eq!(
        stated.len(),
        1,
        "spec/roster-rules.md states the version in one sentence"
    );
    assert_eq!(stated[0], RULES_VERSION.to_string());
    assert_eq!(
        vectors("roster-rules.json")["rules_version"],
        json!(RULES_VERSION)
    );
}

#[test]
fn every_case_record_by_record() {
    let v = vectors("roster-rules.json");
    let cases = v["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let name = text(c, "name");
        let mut rules = MemoryRules::new(table(text(c, "roster")));
        let events = c["events"].as_array().unwrap();
        let results = c["results"].as_array().unwrap();
        assert_eq!(events.len(), results.len(), "{name}");
        for (i, (e, want)) in events.iter().zip(results).enumerate() {
            assert_eq!(want["seq"], json!(i + 1), "{name}");
            let (scope, id) = (text(e, "scope_string"), text(e, "scoped_id"));
            let before = rules.card(scope, id);
            let latest_before = rules.latest_valid_date();
            let outcome = rules
                .apply(&MemoryRecord {
                    scope_string: scope.to_owned(),
                    scoped_id: id.to_owned(),
                    challenge: text(e, "challenge").to_owned(),
                    accounts: accounts(&e["accounts"]),
                    verifies: e["verifies"].as_bool().unwrap(),
                    crl_dates: e["crl_dates"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|d| date(d.as_str().unwrap()))
                        .collect(),
                })
                .unwrap_or_else(|_| panic!("{name}, event {}: a record", i + 1));
            let mut want = want.clone();
            want.as_object_mut().unwrap().remove("seq");
            assert_eq!(result_out(&outcome.result), want, "{name}, event {}", i + 1);
            assert_eq!(rules.count(), i + 1);
            let after = rules.card(scope, id);
            if want["valid"] == json!(true) {
                // "Every valid record": the card's date is the record's.
                assert_eq!(after.last_card_proof, Some(date(text(e, "date"))), "{name}");
            } else {
                // "What an invalid record changes": nothing of its card, not the roster's latest valid date.
                assert_eq!(after, before, "{name}, event {}", i + 1);
                assert_eq!(rules.latest_valid_date(), latest_before, "{name}");
            }
            // Every state the rules produce is one the device reads.
            let today = after
                .last_card_proof
                .map_or(date(text(e, "date")), |d| d.max(date(text(e, "date"))));
            assert!(
                possible_card(after.last_card_proof, after.proofs_on_last_date, today),
                "{name}, event {}",
                i + 1
            );
            for slot in after.slots.values() {
                assert!(
                    possible_slot(slot, after.last_card_proof),
                    "{name}, event {}",
                    i + 1
                );
            }
        }
        assert_eq!(state_out(&rules), c["state"], "{name}");
    }
}
