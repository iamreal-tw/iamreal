//! The checks on the device and the result "every check passed", through
//! the C functions, the way an app calls them: against
//! spec/vectors/device-checks.json, circuit-inputs.json and
//! revocation-tree.json.
//!
//! The one thing not done through a C function is opening a session that
//! trusts the vectors' test keys: `idc_session_open` trusts MOICA's keys
//! only, and no certificate of MOICA's is in this repository.

mod common;

use common::{cases, hex, repo_file, text, unhex, vectors};
use iamreal_device_checks::issuers::IssuerName;
use iamreal_device_checks::scope::Roster;
use iamreal_device_core::artifacts::{self, Artifacts};
use iamreal_device_core::session::{self, Trust};
use iamreal_device_core::{
    IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_ERR_REFUSED, IDC_OK, IDC_ROSTER_TEST, IdcBuf,
    idc_buf_free, idc_session_add_certificate, idc_session_build_tree,
    idc_session_card_state_request, idc_session_check_artifacts, idc_session_check_certificates,
    idc_session_check_crl, idc_session_choose_crl, idc_session_close, idc_session_open,
};
use serde_json::{Value, json};
use sha2::Digest;

fn sha256(bytes: &[u8]) -> [u8; 32] {
    sha2::Sha256::digest(bytes).into()
}

/// Noon in Taiwan on a date `YYYY-MM-DD`, in seconds since 1970.
fn noon(date: &str) -> i64 {
    let number = |range: std::ops::Range<usize>| date[range].parse::<i64>().unwrap();
    let days =
        iamreal_device_checks::date::days_from_civil(number(0..4), number(5..7), number(8..10));
    days * 86_400 + 4 * 3_600
}

/// Reads a function's bytes and gives the buffer back; with any code but
/// `IDC_OK` there are none.
fn finish(code: i32, mut out: IdcBuf) -> Result<Vec<u8>, i32> {
    if code != IDC_OK {
        assert!(out.ptr.is_null() && out.len == 0, "no bytes with an error");
        return Err(code);
    }
    assert!(!out.ptr.is_null());
    let bytes = unsafe { std::slice::from_raw_parts(out.ptr, out.len) }.to_vec();
    unsafe { idc_buf_free(&mut out) };
    Ok(bytes)
}

fn json_of(result: Result<Vec<u8>, i32>) -> Result<Value, i32> {
    result.map(|bytes| serde_json::from_slice(&bytes).expect("JSON"))
}

fn empty() -> IdcBuf {
    IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    }
}

fn status(code: i32) -> Result<(), i32> {
    if code == IDC_OK { Ok(()) } else { Err(code) }
}

/// A session, closed when the test is done with it.
struct Session(u64);

impl Drop for Session {
    fn drop(&mut self) {
        idc_session_close(self.0);
    }
}

impl Session {
    /// A session that trusts `issuers` in place of MOICA's keys.
    fn trusting(
        roster: Roster,
        issuers: &[(IssuerName, Vec<u8>)],
        artifacts: Artifacts,
    ) -> Session {
        Session(session::open(
            roster,
            Trust {
                issuers: issuers.to_vec(),
                artifacts,
            },
        ))
    }

    fn add_certificate(&self, der: &[u8]) -> Result<(), i32> {
        status(unsafe { idc_session_add_certificate(self.0, der.as_ptr(), der.len()) })
    }

    fn check_certificates(&self, now: i64) -> Result<Value, i32> {
        let mut out = empty();
        let code = unsafe { idc_session_check_certificates(self.0, now, &mut out) };
        json_of(finish(code, out))
    }

    fn choose_crl(&self, index: &[u8]) -> Result<Value, i32> {
        let mut out = empty();
        let code = unsafe { idc_session_choose_crl(self.0, index.as_ptr(), index.len(), &mut out) };
        json_of(finish(code, out))
    }

    fn check_crl(&self, crl: &[u8], config: &[u8], highest: &[u8]) -> Result<Value, i32> {
        let mut out = empty();
        let code = unsafe {
            idc_session_check_crl(
                self.0,
                crl.as_ptr(),
                crl.len(),
                config.as_ptr(),
                config.len(),
                highest.as_ptr(),
                highest.len(),
                &mut out,
            )
        };
        json_of(finish(code, out))
    }

    fn build_tree(&self) -> Result<(), i32> {
        status(idc_session_build_tree(self.0))
    }

    fn check_artifacts(&self, files: &Files) -> Result<(), i32> {
        status(unsafe {
            idc_session_check_artifacts(
                self.0,
                files.circuit.as_ptr(),
                files.circuit.len(),
                files.verification_key.as_ptr(),
                files.verification_key.len(),
                files.crs_g1.as_ptr(),
                files.crs_g1.len(),
                files.crs_g2.as_ptr(),
                files.crs_g2.len(),
            )
        })
    }

    fn card_state_request(&self, scope_signature: &[u8]) -> Result<Value, i32> {
        let mut out = empty();
        let code = unsafe {
            idc_session_card_state_request(
                self.0,
                scope_signature.as_ptr(),
                scope_signature.len(),
                &mut out,
            )
        };
        json_of(finish(code, out))
    }
}

fn issuers_of(v: &Value) -> Vec<(IssuerName, Vec<u8>)> {
    cases(v, "issuers")
        .iter()
        .map(|k| {
            (
                IssuerName::parse(text(k, "issuer")).unwrap(),
                unhex(text(k, "modulus")),
            )
        })
        .collect()
}

/// A session for the cases of device-checks.json.
fn device_checks_session(v: &Value) -> Session {
    Session::trusting(Roster::Test, &issuers_of(v), artifacts::BUILT_IN)
}

#[test]
fn choosing_and_checking_the_certificate() {
    let v = vectors("device-checks.json");
    for case in cases(&v["certificate"], "cases") {
        let what = text(case, "what");
        let session = device_checks_session(&v);
        for certificate in case["certificates"].as_array().unwrap() {
            session
                .add_certificate(&unhex(certificate.as_str().unwrap()))
                .unwrap();
        }
        let result = session
            .check_certificates(noon(text(case, "today")))
            .unwrap();
        // The app is told everything of the vectors' result but the serial
        // number and the card's key, which stay in the core
        // (checks/tests/device_checks.rs reads those).
        let mut expected = case["result"].clone();
        let object = expected.as_object_mut().unwrap();
        object.remove("serial");
        object.remove("card_modulus");
        assert_eq!(result, expected, "{what}");
    }
}

/// A session whose certificate was issued with `issuer` and checked on
/// `today`: the first two cases of the vectors are a G3 and a G2
/// certificate.
fn session_with_certificate(v: &Value, issuer: &str, today: &str) -> Session {
    let case = cases(&v["certificate"], "cases")
        .iter()
        .find(|c| {
            c["result"]["issuer"] == issuer && c["certificates"].as_array().unwrap().len() == 1
        })
        .expect("a certificate of the issuer");
    let session = device_checks_session(v);
    session
        .add_certificate(&unhex(case["certificates"][0].as_str().unwrap()))
        .unwrap();
    let result = session.check_certificates(noon(today)).unwrap();
    assert_eq!(result["ok"], true);
    session
}

#[test]
fn choosing_a_file_from_the_index() {
    let v = vectors("device-checks.json");
    for case in cases(&v["crl"], "index") {
        let session = session_with_certificate(&v, text(case, "issuer"), "2026-11-16");
        let result = session.choose_crl(text(case, "index").as_bytes()).unwrap();
        let mut expected = case["result"].clone();
        expected["ok"] = Value::from(expected.get("problem").is_none());
        assert_eq!(result, expected, "{}", text(case, "what"));
    }
}

/// One file of the vectors' mirror: its body, if the mirror answers 200.
fn served(mirror: &Value, name: &str) -> Option<Vec<u8>> {
    let answer = mirror.get(name)?;
    (answer["status"] == 200).then(|| unhex(text(answer, "body")))
}

#[test]
fn which_crl_the_device_uses_and_when_it_refuses_one() {
    let v = vectors("device-checks.json");
    for case in cases(&v["crl"], "cases") {
        let what = text(case, "what");
        let expected = &case["result"];
        // What the app does around the core: it downloads, and a download
        // that fails is crl_unavailable without asking the core.
        let unavailable = || {
            assert_eq!(expected["problem"], "crl_unavailable", "{what}");
            assert_eq!(expected["highest_after"], case["highest"], "{what}");
        };
        // The CRL is checked on the date the certificate was checked on.
        let session = session_with_certificate(&v, text(case, "issuer"), text(case, "today"));
        let Some(index) = served(&case["mirror"], "index.jsonl") else {
            unavailable();
            continue;
        };
        let choice = session.choose_crl(&index).unwrap();
        if choice["ok"] == false {
            assert_eq!(choice["problem"], "crl_unavailable", "{what}");
            unavailable();
            continue;
        }
        let name = format!("{}.crl", text(&choice, "sha256"));
        let Some(file) = served(&case["mirror"], &name) else {
            unavailable();
            continue;
        };
        let config = json!({
            "crl_max_age_days": case["server_max_age_days"],
            "platforms": [],
        });
        let highest = case["highest"].as_str().unwrap_or("");
        let result = session
            .check_crl(&file, config.to_string().as_bytes(), highest.as_bytes())
            .unwrap();
        assert_eq!(&result, expected, "{what}");
    }
}

#[test]
fn a_config_whose_age_bound_is_not_read_stops_before_any_crl_is_used() {
    let v = vectors("device-checks.json");
    let crl_case = &cases(&v["crl"], "cases")[0];
    let index = served(&crl_case["mirror"], "index.jsonl").unwrap();
    for case in cases(&v["crl"], "max_age") {
        let config = json!({ "crl_max_age_days": case["server_max_age_days"] }).to_string();
        let read = session::server_max_age_days(config.as_bytes());
        assert_eq!(
            read.is_some(),
            !case["max_age_days"].is_null(),
            "crl_max_age_days {}",
            case["server_max_age_days"]
        );
        if read.is_some() {
            continue;
        }
        let session =
            session_with_certificate(&v, text(crl_case, "issuer"), text(crl_case, "today"));
        let choice = session.choose_crl(&index).unwrap();
        let file = served(
            &crl_case["mirror"],
            &format!("{}.crl", text(&choice, "sha256")),
        )
        .unwrap();
        let result = session.check_crl(&file, config.as_bytes(), b"99").unwrap();
        assert_eq!(
            result,
            json!({ "ok": false, "problem": "malformed_response", "highest_after": "99" })
        );
        // No CRL passed: there is no tree to build.
        assert_eq!(session.build_tree(), Err(IDC_ERR_REFUSED));
    }
    for not_a_config in ["", "[]", "3", "{}", "{\"crl_max_age_days\":3", "null"] {
        assert_eq!(session::server_max_age_days(not_a_config.as_bytes()), None);
    }
}

/// The four files an app carries, for one circuit.
#[derive(Clone)]
struct Files {
    circuit: Vec<u8>,
    verification_key: Vec<u8>,
    crs_g1: Vec<u8>,
    crs_g2: Vec<u8>,
}

/// The circuit and its key are the files of this repository. The common
/// reference string (8 MiB) is not in the repository: these tests stand
/// two short files in for it, and a session that expects their hashes.
fn files_of(circuit: &str) -> (Files, Artifacts) {
    let files = Files {
        circuit: repo_file(&format!("web/circuits/{circuit}.json")),
        verification_key: repo_file(&format!("verifier/vk/{circuit}.vk")),
        crs_g1: b"in place of the points of G1".to_vec(),
        crs_g2: b"in place of the point of G2".to_vec(),
    };
    let expected = Artifacts {
        crs_g1: sha256(&files.crs_g1),
        crs_g2: sha256(&files.crs_g2),
        ..artifacts::BUILT_IN
    };
    (files, expected)
}

#[test]
fn the_files_written_into_the_core_are_the_ones_of_this_repository() {
    let built_in = artifacts::BUILT_IN;
    for (circuit, files) in [
        ("card_proof_rs2048", built_in.rs2048),
        ("card_proof_rs4096", built_in.rs4096),
    ] {
        assert_eq!(
            sha256(&repo_file(&format!("web/circuits/{circuit}.json"))),
            files.circuit,
            "{circuit}"
        );
        assert_eq!(
            sha256(&repo_file(&format!("verifier/vk/{circuit}.vk"))),
            files.verification_key,
            "{circuit}"
        );
    }
    // The common reference string: the hashes fetch-crs.sh checks.
    let list = String::from_utf8(repo_file("device-core/crs.sha256")).unwrap();
    let expected: Vec<String> = [
        (built_in.crs_g1, "bn254_g1_compressed_2p18.dat"),
        (built_in.crs_g2, "bn254_g2.dat"),
    ]
    .iter()
    .map(|(hash, name)| format!("{}  {name}", hex(hash)))
    .collect();
    assert_eq!(list.lines().collect::<Vec<_>>(), expected);
}

/// One case of circuit-inputs.json: a certificate, the CRL its path was
/// built from, and the card's signature over the scope string.
struct Card {
    label: String,
    roster: Roster,
    issuers: Vec<(IssuerName, Vec<u8>)>,
    certificate: Vec<u8>,
    crl: Vec<u8>,
    now: i64,
    scope_string: String,
    scope_signature: Vec<u8>,
    other_signature: Vec<u8>,
    scoped_id: [u8; 32],
    files: Files,
    artifacts: Artifacts,
}

fn cards() -> Vec<Card> {
    let v = vectors("circuit-inputs.json");
    let trees = vectors("revocation-tree.json");
    cases(&v, "cases")
        .iter()
        .map(|case| {
            let crl = cases(&trees, "crls")
                .iter()
                .find(|c| c["name"] == case["crl"])
                .expect("the CRL of the case");
            // current_time is YYMMDD155959.
            let date = case["current_time"].as_u64().unwrap() / 1_000_000;
            let today = format!(
                "20{:02}-{:02}-{:02}",
                date / 10_000,
                date / 100 % 100,
                date % 100
            );
            let limbs = match text(case, "issuer") {
                "G2" => 18,
                _ => 35,
            };
            let (files, artifacts) = files_of(text(case, "circuit"));
            Card {
                label: text(case, "label").to_string(),
                roster: match text(case, "scope_string") {
                    "iamreal:public:0_______________" => Roster::Production,
                    _ => Roster::Test,
                },
                issuers: issuers_of(&v),
                certificate: unhex(text(case, "certificate")),
                crl: unhex(text(crl, "crl")),
                now: noon(&today),
                scope_string: text(case, "scope_string").to_string(),
                scope_signature: unhex(text(case, "scope_signature")),
                other_signature: unhex(text(case, "declaration_code_signature")),
                scoped_id: common::fe(case["public_inputs"][limbs + 2].as_str().unwrap()),
                files,
                artifacts,
            }
        })
        .collect()
}

const CONFIG: &[u8] = br#"{"crl_max_age_days":7,"platforms":[]}"#;

impl Card {
    fn session(&self) -> Session {
        Session::trusting(self.roster, &self.issuers, self.artifacts)
    }

    /// Step 1.
    fn check_certificate(&self, session: &Session) {
        session.add_certificate(&self.certificate).unwrap();
        let result = session.check_certificates(self.now).unwrap();
        assert_eq!(result["ok"], true, "{}", self.label);
    }

    /// Step 2: the mirror's index names the CRL.
    fn check_crl(&self, session: &Session) {
        let issuer = session_issuer(&self.certificate, &self.issuers);
        let index = format!(
            "{{\"issuer\":\"{issuer}\",\"crl_number\":\"1\",\"sha256\":\"{}\",\"root\":\"{}\"}}\n",
            hex(&sha256(&self.crl)),
            "0".repeat(64),
        );
        let choice = session.choose_crl(index.as_bytes()).unwrap();
        assert_eq!(choice["ok"], true, "{}", self.label);
        let result = session.check_crl(&self.crl, CONFIG, b"").unwrap();
        assert_eq!(result["ok"], true, "{}: {result}", self.label);
    }

    /// A session that passed every check.
    fn passed(&self) -> Session {
        let session = self.session();
        self.check_certificate(&session);
        self.check_crl(&session);
        session.build_tree().unwrap();
        session.check_artifacts(&self.files).unwrap();
        session
    }
}

/// Which issuer's key signed the certificate, by asking a session.
fn session_issuer(certificate: &[u8], issuers: &[(IssuerName, Vec<u8>)]) -> String {
    let session = Session::trusting(Roster::Test, issuers, artifacts::BUILT_IN);
    session.add_certificate(certificate).unwrap();
    let result = session.check_certificates(noon("2026-11-16")).unwrap();
    text(&result, "issuer").to_string()
}

#[test]
fn a_session_that_passed_every_check_gives_the_card_state_request() {
    let cards = cards();
    assert!(cards.len() >= 4);
    for card in &cards {
        let session = card.passed();
        let request = session.card_state_request(&card.scope_signature).unwrap();
        let scoped_id = iamreal_device_checks::scoped_id::scoped_id_text(&card.scoped_id).unwrap();
        assert_eq!(
            request,
            json!({ "scope_string": card.scope_string, "scoped_id": scoped_id }),
            "{}",
            card.label
        );
    }
}

#[test]
fn without_every_check_passed_no_scoped_id_is_computed() {
    for card in &cards() {
        let refused = |session: &Session, what: &str| {
            assert_eq!(
                session.card_state_request(&card.scope_signature),
                Err(IDC_ERR_REFUSED),
                "{}: {what}",
                card.label
            );
        };

        let session = card.session();
        refused(&session, "a session that checked nothing");
        card.check_certificate(&session);
        refused(&session, "only the certificate");
        card.check_crl(&session);
        refused(&session, "no tree");
        session.build_tree().unwrap();
        refused(&session, "the files not checked");
        session.check_artifacts(&card.files).unwrap();
        assert!(session.card_state_request(&card.scope_signature).is_ok());

        // The files checked, the CRL not.
        let session = card.session();
        card.check_certificate(&session);
        session.check_artifacts(&card.files).unwrap();
        refused(&session, "no CRL");
        card.check_crl(&session);
        refused(&session, "the CRL passed, the tree is not built");

        // Checking the certificates again starts over: the CRL, the tree
        // and the files are all to be checked again.
        let session = card.passed();
        card.check_certificate(&session);
        refused(&session, "the certificate checked again");
        card.check_crl(&session);
        session.build_tree().unwrap();
        refused(&session, "the certificate checked again, the files not");
        session.check_artifacts(&card.files).unwrap();
        assert!(session.card_state_request(&card.scope_signature).is_ok());

        // Choosing a CRL again forgets the tree, whatever the choice.
        let session = card.passed();
        assert_eq!(
            session.choose_crl(b"").unwrap(),
            json!({ "ok": false, "problem": "crl_unavailable" })
        );
        refused(&session, "no CRL chosen from a second index");
        let session = card.passed();
        card.check_crl(&session);
        refused(&session, "the CRL checked again");

        // A card that fails its checks.
        let session = card.passed();
        let result = session.check_certificates(card.now).unwrap();
        assert_eq!(result, json!({ "ok": false, "problem": "no_certificate" }));
        refused(&session, "no certificate");
    }
}

#[test]
fn files_that_are_not_the_ones_written_into_the_core_are_refused() {
    for card in &cards() {
        type Change = fn(&mut Files);
        let changes: [(&str, Change); 5] = [
            ("the circuit", |f| f.circuit[100] ^= 1),
            ("the verification key", |f| f.verification_key[0] ^= 1),
            ("the points of G1", |f| f.crs_g1.push(0)),
            ("the point of G2", |f| f.crs_g2.clear()),
            ("the other circuit's files", |f| {
                let other = if f.circuit.len() < 700_000 {
                    "card_proof_rs4096"
                } else {
                    "card_proof_rs2048"
                };
                f.circuit = repo_file(&format!("web/circuits/{other}.json"));
                f.verification_key = repo_file(&format!("verifier/vk/{other}.vk"));
            }),
        ];
        for (what, change) in changes {
            let session = card.session();
            card.check_certificate(&session);
            card.check_crl(&session);
            session.build_tree().unwrap();
            let mut files = card.files.clone();
            change(&mut files);
            assert_eq!(
                session.check_artifacts(&files),
                Err(IDC_ERR_INPUT),
                "{what}"
            );
            assert_eq!(
                session.card_state_request(&card.scope_signature),
                Err(IDC_ERR_REFUSED),
                "{what}"
            );
            // Files that failed after files that passed: refused again.
            session.check_artifacts(&card.files).unwrap();
            assert_eq!(
                session.check_artifacts(&files),
                Err(IDC_ERR_INPUT),
                "{what}"
            );
            assert_eq!(
                session.card_state_request(&card.scope_signature),
                Err(IDC_ERR_REFUSED),
                "{what}"
            );
        }
    }
}

#[test]
fn the_core_as_an_app_gets_it_expects_the_real_common_reference_string() {
    // With the hashes written into the core, the stand-in files fail.
    let card = &cards()[0];
    let session = Session::trusting(card.roster, &card.issuers, artifacts::BUILT_IN);
    card.check_certificate(&session);
    assert_eq!(session.check_artifacts(&card.files), Err(IDC_ERR_INPUT));
}

#[test]
fn a_signature_that_is_not_the_cards_over_the_scope_string_is_refused() {
    for card in &cards() {
        let session = card.passed();
        let mut one_bit = card.scope_signature.clone();
        one_bit[255] ^= 1;
        let mut longer = card.scope_signature.clone();
        longer.insert(0, 0);
        for (what, signature) in [
            (
                "the signature over the declaration code",
                &card.other_signature,
            ),
            ("one bit changed", &one_bit),
            ("a byte added", &longer),
            ("a byte removed", &card.scope_signature[1..].to_vec()),
            ("no bytes", &Vec::new()),
        ] {
            assert_eq!(
                session.card_state_request(signature),
                Err(IDC_ERR_INPUT),
                "{}: {what}",
                card.label
            );
        }
        // The session still answers for the right one.
        assert!(session.card_state_request(&card.scope_signature).is_ok());
    }
    // The same signature under the other roster's scope string.
    let card = &cards()[0];
    let other = Card {
        roster: match card.roster {
            Roster::Test => Roster::Production,
            Roster::Production => Roster::Test,
        },
        ..cards().remove(0)
    };
    let session = other.passed();
    assert_eq!(
        session.card_state_request(&card.scope_signature),
        Err(IDC_ERR_INPUT)
    );
}

#[test]
fn each_step_waits_for_the_steps_before_it() {
    let card = &cards()[0];
    let session = card.session();
    assert_eq!(session.choose_crl(b""), Err(IDC_ERR_REFUSED));
    assert_eq!(
        session.check_crl(&card.crl, CONFIG, b""),
        Err(IDC_ERR_REFUSED)
    );
    assert_eq!(session.build_tree(), Err(IDC_ERR_REFUSED));
    assert_eq!(session.check_artifacts(&card.files), Err(IDC_ERR_REFUSED));

    card.check_certificate(&session);
    assert_eq!(
        session.check_crl(&card.crl, CONFIG, b""),
        Err(IDC_ERR_REFUSED)
    );
    assert_eq!(session.build_tree(), Err(IDC_ERR_REFUSED));

    // A file that is not the one chosen from the index.
    card.check_crl(&session);
    let mut other_file = card.crl.clone();
    other_file.push(0);
    let result = session.check_crl(&other_file, CONFIG, b"").unwrap();
    assert_eq!(
        result,
        json!({ "ok": false, "problem": "crl_hash", "highest_after": null })
    );
    assert_eq!(session.build_tree(), Err(IDC_ERR_REFUSED));

    card.check_crl(&session);
    session.build_tree().unwrap();
    // The tree of a CRL is built once.
    assert_eq!(session.build_tree(), Err(IDC_ERR_REFUSED));
}

#[test]
fn the_crl_is_checked_on_the_date_the_certificate_was_checked_on() {
    let card = &cards()[0];
    let session = card.session();
    card.check_certificate(&session);
    card.check_crl(&session);
    // The same card and the same CRL, 30 days later by the device's clock.
    session.add_certificate(&card.certificate).unwrap();
    let later = session.check_certificates(card.now + 30 * 86_400).unwrap();
    assert_eq!(later["ok"], true);
    let index = format!(
        "{{\"issuer\":\"{}\",\"crl_number\":\"1\",\"sha256\":\"{}\",\"root\":\"{}\"}}\n",
        text(&later, "issuer"),
        hex(&sha256(&card.crl)),
        "0".repeat(64),
    );
    assert_eq!(session.choose_crl(index.as_bytes()).unwrap()["ok"], true);
    let result = session.check_crl(&card.crl, CONFIG, b"").unwrap();
    assert_eq!(result["problem"], "crl_stale", "{result}");
    assert_eq!(result["max_age_days"], 7);
}

#[test]
fn what_is_not_a_session_and_what_is_not_an_argument() {
    let card = &cards()[0];
    let closed = {
        let session = card.passed();
        session.0
    };
    for handle in [0, closed, u64::MAX] {
        let session = Session(handle);
        assert_eq!(
            session.add_certificate(&card.certificate),
            Err(IDC_ERR_ARGUMENT)
        );
        assert_eq!(session.check_certificates(card.now), Err(IDC_ERR_ARGUMENT));
        assert_eq!(session.choose_crl(b""), Err(IDC_ERR_ARGUMENT));
        assert_eq!(
            session.check_crl(&card.crl, CONFIG, b""),
            Err(IDC_ERR_ARGUMENT)
        );
        assert_eq!(session.build_tree(), Err(IDC_ERR_ARGUMENT));
        assert_eq!(session.check_artifacts(&card.files), Err(IDC_ERR_ARGUMENT));
        assert_eq!(
            session.card_state_request(&card.scope_signature),
            Err(IDC_ERR_ARGUMENT)
        );
        // Closing what is not a session does nothing.
        idc_session_close(handle);
    }

    let session = card.session();
    card.check_certificate(&session);
    card.check_crl(&session);
    // A clock outside 2000 to 2049.
    for now in [
        0,
        946_684_800 - 8 * 3_600 - 1,
        2_524_608_000,
        i64::MAX,
        i64::MIN,
    ] {
        assert_eq!(
            session.check_certificates(now),
            Err(IDC_ERR_ARGUMENT),
            "{now}"
        );
    }
    // The certificates added do not stay in the core after such a call.
    session.add_certificate(&card.certificate).unwrap();
    assert_eq!(session.check_certificates(0), Err(IDC_ERR_ARGUMENT));
    assert_eq!(
        session.check_certificates(card.now).unwrap(),
        json!({ "ok": false, "problem": "no_certificate" })
    );
    // A remembered CRL number that is not a number.
    card.check_certificate(&session);
    card.check_crl(&session);
    for highest in ["-", "01", "1.0", " 1", "\u{ff11}"] {
        assert_eq!(
            session.check_crl(&card.crl, CONFIG, highest.as_bytes()),
            Err(IDC_ERR_INPUT),
            "{highest:?}"
        );
    }
    // Null pointers.
    let mut out = empty();
    unsafe {
        assert_eq!(
            idc_session_open(IDC_ROSTER_TEST, std::ptr::null_mut()),
            IDC_ERR_ARGUMENT
        );
        let mut handle = 7u64;
        assert_eq!(idc_session_open(2, &mut handle), IDC_ERR_ARGUMENT);
        assert_eq!(handle, 0, "no session with an error");
        assert_eq!(
            idc_session_add_certificate(session.0, std::ptr::null(), 1),
            IDC_ERR_ARGUMENT
        );
        assert_eq!(
            idc_session_check_certificates(session.0, card.now, std::ptr::null_mut()),
            IDC_ERR_ARGUMENT
        );
        assert_eq!(
            idc_session_choose_crl(session.0, std::ptr::null(), 1, &mut out),
            IDC_ERR_ARGUMENT
        );
        assert_eq!(
            idc_session_card_state_request(session.0, std::ptr::null(), 256, &mut out),
            IDC_ERR_ARGUMENT
        );
    }
}

#[test]
fn a_session_an_app_opens_trusts_only_the_keys_of_moica() {
    let mut handle = 0u64;
    assert_eq!(
        unsafe { idc_session_open(IDC_ROSTER_TEST, &mut handle) },
        IDC_OK
    );
    assert_ne!(handle, 0);
    let session = Session(handle);
    // A certificate that passes every check but its issuer.
    let card = &cards()[0];
    session.add_certificate(&card.certificate).unwrap();
    assert_eq!(
        session.check_certificates(card.now).unwrap(),
        json!({ "ok": false, "problem": "unknown_issuer" })
    );
    assert_eq!(
        session.card_state_request(&card.scope_signature),
        Err(IDC_ERR_REFUSED)
    );
}

#[test]
fn a_serial_number_on_the_crl_is_one_of_its_keys() {
    // No certificate of the vectors is on a CRL of its own issuer, so the
    // `revoked` answer cannot be asked for through a session here. What it
    // rests on: the serial number the vectors call revoked is among the
    // keys of that CRL, and the card's own is not.
    use iamreal_device_checks::crl::usable_crl;
    use iamreal_device_checks::key::Key;
    let v = vectors("revocation-tree.json");
    let issuers = issuers_of(&v);
    for case in cases(&v, "cases") {
        let crl = cases(&v, "crls")
            .iter()
            .find(|c| c["name"] == case["crl"])
            .unwrap();
        let modulus = &issuers
            .iter()
            .find(|(name, _)| name.as_str() == text(crl, "issuer"))
            .unwrap()
            .1;
        let usable = usable_crl(&unhex(text(crl, "crl")), modulus, &mut common::TestSha256)
            .unwrap_or_else(|reason| panic!("{}", reason.code()));
        let serial = Key::from_unsigned(&unhex(text(case, "serial"))).unwrap();
        assert_eq!(
            usable.keys.contains(&serial),
            case["in_tree"].as_bool().unwrap(),
            "{}",
            text(case, "label")
        );
    }
}
