//! The algorithms of spec/ against spec/vectors/, the same files the Go and
//! TypeScript tests read. What needs Poseidon2 is in prover/tests/.

use iamreal_device_checks::base32;
use iamreal_device_checks::challenge::{check_challenge, current_time, parse_challenge};
use iamreal_device_checks::date::Date;
use iamreal_device_checks::declaration_code::{
    Account, PreimageError, declaration_code, declaration_preimage,
};
use iamreal_device_checks::field::{Fe, MODULUS, fe_of_u64, is_field_element, pack31};
use iamreal_device_checks::hash::Sha256;
use iamreal_device_checks::scope::{ProofLog, accepts, scope_string};
use iamreal_device_checks::scoped_id::{
    parse_scoped_id, read_short_id_in_url, scoped_id_text, short_id,
};
use iamreal_device_checks::username_format::{UsernameFormat, is_any_username, is_platform_id};
use serde_json::Value;

fn vectors(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/vectors")
        .join(name);
    serde_json::from_slice(&std::fs::read(path).expect("the vectors file")).expect("JSON")
}

fn cases<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    let list = v[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is a list"));
    assert!(!list.is_empty(), "{key} has cases");
    list
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("{key} is a string"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    assert!(s.len().is_multiple_of(2), "an even number of hex digits");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn fe(s: &str) -> Fe {
    unhex(s).try_into().expect("32 bytes")
}

fn proof_log(v: &Value) -> ProofLog {
    match text(v, "proof_log") {
        "production" => ProofLog::Production,
        "test" => ProofLog::Test,
        other => panic!("proof log {other}"),
    }
}

struct TestSha256;

impl Sha256 for TestSha256 {
    fn sha256(&mut self, data: &[u8]) -> [u8; 32] {
        use sha2::Digest;
        sha2::Sha256::digest(data).into()
    }
}

#[test]
fn challenge_json() {
    let v = vectors("challenge.json");
    for c in cases(&v, "valid") {
        let challenge = text(c, "challenge");
        let date =
            parse_challenge(challenge.as_bytes()).unwrap_or_else(|| panic!("valid {challenge}"));
        assert_eq!(date.to_string(), text(c, "date"));
        assert_eq!(current_time(date), c["current_time"].as_u64().unwrap());
        assert_eq!(
            hex(&fe_of_u64(current_time(date))),
            text(c, "current_time_public_input")
        );
        let random = unhex(text(c, "random_bytes"));
        assert_eq!(
            base32::decode_strict(&challenge.as_bytes()[11..], 16),
            Some(random.clone())
        );
        assert_eq!(base32::encode(&random), &challenge[11..]);
    }
    for c in cases(&v, "invalid") {
        let challenge = text(c, "challenge");
        assert_eq!(
            parse_challenge(challenge.as_bytes()),
            None,
            "invalid ({}) {challenge:?}",
            text(c, "reason")
        );
    }
}

#[test]
fn the_device_takes_a_challenge_dated_today_in_taiwan() {
    let v = vectors("challenge.json");
    for c in cases(&v, "device") {
        let challenge = text(c, "challenge");
        let today = Date::in_taiwan(c["now"].as_i64().unwrap()).unwrap();
        assert_eq!(today.to_string(), text(c, "today"), "{}", text(c, "note"));
        let result = match check_challenge(challenge.as_bytes(), today) {
            Ok(date) => {
                assert_eq!(date, today);
                "ok"
            }
            Err(problem) => problem.code(),
        };
        assert_eq!(result, text(c, "result"), "{}", text(c, "note"));
    }
}

#[test]
fn taiwan_date_from_the_clock() {
    // 2026-11-15T15:59:59Z and one second later.
    assert_eq!(
        Date::in_taiwan(1_794_758_399).unwrap().to_string(),
        "2026-11-15"
    );
    assert_eq!(
        Date::in_taiwan(1_794_758_400).unwrap().to_string(),
        "2026-11-16"
    );
    // The first and the last second of the years a challenge can carry.
    assert_eq!(
        Date::in_taiwan(946_656_000).unwrap().to_string(),
        "2000-01-01"
    );
    assert_eq!(Date::in_taiwan(946_655_999), None);
    assert_eq!(
        Date::in_taiwan(2_524_579_199).unwrap().to_string(),
        "2049-12-31"
    );
    assert_eq!(Date::in_taiwan(2_524_579_200), None);
    // 2028-02-29T04:00:00Z.
    assert_eq!(
        Date::in_taiwan(1_835_409_600).unwrap().to_string(),
        "2028-02-29"
    );
    assert_eq!(Date::in_taiwan(0), None);
    assert_eq!(Date::in_taiwan(i64::MAX), None);
    assert_eq!(Date::in_taiwan(i64::MIN), None);
}

#[test]
fn dates_that_exist() {
    assert!(Date::parse(b"2028-02-29").is_some());
    assert_eq!(Date::parse(b"2026-02-29"), None);
    assert_eq!(Date::parse(b"2026-11-16\n"), None);
    assert_eq!(Date::parse(b"2026-11-31"), None);
    assert_eq!(Date::parse(b"1999-12-31"), None);
    assert_eq!(Date::parse(b"2050-01-01"), None);
    assert_eq!(Date::parse(b"2026+11-16"), None);
    assert!(Date::parse(b"2026-11-15").unwrap() < Date::parse(b"2026-11-16").unwrap());
}

#[test]
fn scope_json_scopes() {
    let v = vectors("scope.json");
    for s in cases(&v, "scopes") {
        let string = text(s, "scope_string");
        let accepted = s["accepted"].as_bool().unwrap();
        assert_eq!(
            accepts(proof_log(s), string.as_bytes()),
            accepted,
            "{string}"
        );
        if accepted {
            assert_eq!(scope_string(proof_log(s)), string.as_bytes());
            assert_eq!(
                format!("0x{}", hex(&pack31(scope_string(proof_log(s))))),
                text(s, "scope_packed")
            );
        }
    }
}

/// The platform table of one proof log as the vectors give it: the rows that
/// proof log accepts, each with its `username` format as read here. The
/// device gets its table from the server (`config`); the vectors' rows
/// stand in for it.
fn platform_table(v: &Value, of: ProofLog) -> std::collections::BTreeMap<String, UsernameFormat> {
    let mut table = std::collections::BTreeMap::new();
    for p in cases(v, "platforms") {
        if proof_log(p) != of {
            continue;
        }
        let platform = text(p, "platform");
        if p["accepted"].as_bool().unwrap() {
            assert!(is_platform_id(platform.as_bytes()), "{platform}");
            assert!(!text(p, "display_name").is_empty(), "{platform}");
            let format = UsernameFormat::parse(text(p, "username_format").as_bytes())
                .unwrap_or_else(|| panic!("the format of {platform}"));
            assert!(
                table.insert(platform.to_string(), format).is_none(),
                "{platform} once"
            );
        } else {
            assert!(!text(p, "reason").is_empty(), "{platform}");
        }
    }
    table
}

#[test]
fn scope_json_platforms_of_each_proof_log() {
    let v = vectors("scope.json");
    let production = platform_table(&v, ProofLog::Production);
    let test = platform_table(&v, ProofLog::Test);
    assert_eq!(production.keys().collect::<Vec<_>>(), ["threads"]);
    assert_eq!(test.keys().collect::<Vec<_>>(), ["test-example", "threads"]);
    // A test log accepts the production rows, with the same format.
    assert_eq!(test["threads"], production["threads"]);
    // What a proof log does not accept is not in its table, whatever the reason:
    // another spelling of a listed ID, or an ID of the other proof log.
    let mut refused = 0;
    for p in cases(&v, "platforms") {
        if !p["accepted"].as_bool().unwrap() {
            let table = if proof_log(p) == ProofLog::Production {
                &production
            } else {
                &test
            };
            assert!(
                !table.contains_key(text(p, "platform")),
                "{}",
                text(p, "platform")
            );
            refused += 1;
        }
    }
    assert!(refused > 0);
}

#[test]
fn scope_json_usernames() {
    let v = vectors("scope.json");
    // Every platform of the vectors is in a test log's table.
    let table = platform_table(&v, ProofLog::Test);
    for u in cases(&v, "usernames") {
        let format = &table[text(u, "platform")];
        let username = text(u, "username");
        assert_eq!(
            format.accepts(username.as_bytes()),
            u["valid"].as_bool().unwrap(),
            "{username:?} on {}",
            text(u, "platform")
        );
    }
}

#[test]
fn the_one_form_of_a_username_format() {
    for ok in [
        "[a-z0-9._]{1,30}",
        "[a-z0-9-]{1,20}",
        "[-a]{1,1}",
        "[a-c-]{2,9}",
        "[A-Za-z0-9_]{1,15}",
    ] {
        assert!(UsernameFormat::parse(ok.as_bytes()).is_some(), "{ok}");
    }
    for bad in [
        "[a-z]+",
        "[a-z]{1,}",
        "[a-z]{0,5}",
        "[a-z]{5,1}",
        "[a-z]{01,5}",
        "[a-z]{1,5}x",
        "x[a-z]{1,5}",
        "[]{1,5}",
        "[^a]{1,5}",
        "[a-z]{1,5}\n",
        "[a\\]{1,5}",
        "[a\"]{1,5}",
        "[!-~]{1,5}",
        "[ a]{1,5}",
        "[z-a]{1,5}",
        "[a-zé]{1,5}",
        "[[a]{1,5}",
        "(a){1,5}",
        "[a-z]{1,1000000000}",
        "[a-z]{1,2,3}",
        "[abcd]{",
        "[abcd]}",
        "",
    ] {
        assert_eq!(UsernameFormat::parse(bad.as_bytes()), None, "{bad:?}");
    }
    let threads = UsernameFormat::parse(b"[a-z0-9._]{1,30}").unwrap();
    assert_eq!((threads.min(), threads.max()), (1, 30));
    // As a whole value: a trailing line feed is not accepted (spec/scope.md).
    assert!(!threads.accepts(b"alice\n"));
    assert!(threads.accepts("a".repeat(30).as_bytes()));
    assert!(!threads.accepts("a".repeat(31).as_bytes()));
    assert!(!threads.accepts(b""));
    assert!(!threads.accepts(b"Alice"));
    // A `-` last in the class stands for itself.
    let example = UsernameFormat::parse(b"[a-z0-9-]{1,20}").unwrap();
    assert!(example.accepts(b"a-b"));
    assert!(!example.accepts(b"a.b"));
}

#[test]
fn an_account_on_a_platform_the_device_does_not_know() {
    for ok in ["a", "alice-b", "A b~", &"x".repeat(200)] {
        assert!(is_any_username(ok.as_bytes()), "{ok}");
    }
    for bad in ["", "a\"b", "a\\b", "a\nb", "é", "\u{0}"] {
        assert!(!is_any_username(bad.as_bytes()), "{bad:?}");
    }
    for ok in ["threads", "test-example", "a", &"x".repeat(21), "0-9"] {
        assert!(is_platform_id(ok.as_bytes()), "{ok}");
    }
    for bad in ["", "Threads", "threads_", "a:b", &"x".repeat(22), "a b"] {
        assert!(!is_platform_id(bad.as_bytes()), "{bad:?}");
    }
}

fn accounts(c: &Value) -> Vec<Account<'_>> {
    c["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| Account {
            platform: text(a, "platform"),
            username: text(a, "username"),
        })
        .collect()
}

#[test]
fn declaration_code_json() {
    let v = vectors("declaration-code.json");
    for c in cases(&v, "cases") {
        let label = text(c, "label");
        let (scope, challenge) = (
            text(c, "scope_string").as_bytes(),
            text(c, "challenge").as_bytes(),
        );
        let preimage = declaration_preimage(scope, &accounts(c), challenge).expect(label);
        assert_eq!(
            String::from_utf8(preimage.clone()).unwrap(),
            text(c, "preimage"),
            "{label}"
        );
        assert_eq!(
            hex(&TestSha256.sha256(&preimage)),
            text(c, "preimage_sha256"),
            "{label}"
        );
        let code = declaration_code(scope, &accounts(c), challenge, &mut TestSha256).expect(label);
        assert_eq!(
            std::str::from_utf8(&code).unwrap(),
            text(c, "declaration_code"),
            "{label}"
        );
        assert_eq!(
            format!("0x{}", hex(&pack31(&code))),
            text(c, "declaration_code_packed"),
            "{label}"
        );
    }
}

#[test]
fn a_list_with_two_readings_is_not_computed() {
    let scope = scope_string(ProofLog::Test);
    let challenge = b"2026-11-16.000G40R40M30E209185GR38E1W";
    let account = |platform, username| Account { platform, username };
    let preimage = |list: &[Account<'_>]| declaration_preimage(scope, list, challenge);
    assert_eq!(
        preimage(&[account("threads", "a"), account("test-example", "a")]),
        Err(PreimageError::NotAscending)
    );
    assert_eq!(
        preimage(&[account("threads", "a"), account("threads", "b")]),
        Err(PreimageError::NotAscending)
    );
    assert_eq!(
        preimage(&[account("a:b", "a")]),
        Err(PreimageError::ColonInPlatform)
    );
    assert_eq!(
        preimage(&[account("threads", "a\nthreads:b")]),
        Err(PreimageError::LineFeed)
    );
    assert_eq!(
        preimage(&[account("threads\n", "a")]),
        Err(PreimageError::LineFeed)
    );
    assert_eq!(
        declaration_preimage(scope, &[], b"2026-11-16.000G40R40M30E209185GR38E1W\n"),
        Err(PreimageError::LineFeed)
    );
    assert!(preimage(&[account("test-example", "a"), account("threads", "a")]).is_ok());
}

#[test]
fn scoped_id_json() {
    let v = vectors("scoped-id.json");
    assert_eq!(fe(text(&v, "field_modulus")), MODULUS);
    for e in cases(&v, "encoding") {
        let id = fe(text(e, "field_element"));
        let written = scoped_id_text(&id).unwrap_or_else(|| panic!("{}", text(e, "label")));
        assert_eq!(written, text(e, "scoped_id"));
        let mut le = id;
        le.reverse();
        assert_eq!(hex(&le), text(e, "bytes_little_endian"));
        assert_eq!(short_id(&written), Some(text(e, "short_id")));
        assert_eq!(text(e, "short_id").len(), 10);
        assert_eq!(parse_scoped_id(written.as_bytes()), Some(id));
    }
    for e in cases(&v, "invalid") {
        let written = text(e, "scoped_id");
        assert_eq!(
            parse_scoped_id(written.as_bytes()),
            None,
            "{written:?} ({})",
            text(e, "reason")
        );
    }
    for e in cases(&v, "short_id_in_urls") {
        let typed = text(e, "typed");
        assert_eq!(
            read_short_id_in_url(typed.as_bytes()).as_deref(),
            e["reads_as"].as_str(),
            "{typed:?}"
        );
    }
}

#[test]
fn field_elements_are_below_the_modulus() {
    assert!(is_field_element(&[0u8; 32]));
    let mut below = MODULUS;
    below[31] -= 1;
    assert!(is_field_element(&below));
    assert!(!is_field_element(&MODULUS));
    assert!(!is_field_element(&[0xff; 32]));
    assert_eq!(scoped_id_text(&MODULUS), None);
}
