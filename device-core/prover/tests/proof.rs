//! The proof and the request that carries it, through the C functions,
//! the way an app calls them: against spec/vectors/circuit-inputs.json.
//! Every proof is made here, on this machine, without a phone, a card or
//! a server.
//!
//! The common reference string is not in the repository:
//! `./fetch-crs.sh` downloads it to `vendor/crs/` and checks it.
//!
//! With `IAMREAL_BB` naming a bb 6.0.0 executable, each proof is also
//! verified by `bb verify` under the key in `verifier/vk/`, and by the Go
//! verifier (`go test ./verifier -run TestDeviceCoreRequests`, which
//! needs `go`). Without it those two are not run.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine;
use common::{cases, hex, repo_file, text, unhex, vectors};
use iamreal_device_checks::issuers::IssuerName;
use iamreal_device_checks::scope::ProofLog;
use iamreal_device_core::artifacts;
use iamreal_device_core::session::{self, Trust};
use iamreal_device_core::{
    IDC_ERR_INPUT, IDC_ERR_REFUSED, IDC_OK, IdcBuf, idc_buf_free, idc_session_add_certificate,
    idc_session_build_tree, idc_session_card_state_request, idc_session_check_artifacts,
    idc_session_check_certificates, idc_session_check_challenge, idc_session_check_crl,
    idc_session_choose_crl, idc_session_close, idc_session_records_request, proof,
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

fn empty() -> IdcBuf {
    IdcBuf {
        ptr: std::ptr::null_mut(),
        len: 0,
    }
}

/// Reads a function's JSON and gives the buffer back; with any code but
/// `IDC_OK` there are no bytes.
fn finish(code: i32, mut out: IdcBuf) -> Result<Value, i32> {
    if code != IDC_OK {
        assert!(out.ptr.is_null() && out.len == 0, "no bytes with an error");
        return Err(code);
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.ptr, out.len) }.to_vec();
    unsafe { idc_buf_free(&mut out) };
    Ok(serde_json::from_slice(&bytes).expect("JSON"))
}

/// The four files an app carries.
struct Files {
    circuit: Vec<u8>,
    verification_key: Vec<u8>,
    crs_g1: Vec<u8>,
    crs_g2: Vec<u8>,
}

/// The files of this repository, and the common reference string that
/// fetch-crs.sh downloaded: the ones whose SHA-256 is written into the core.
fn files_of(circuit: &str) -> Files {
    let crs = |name: &str| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../vendor/crs")
            .join(name);
        std::fs::read(path).expect("the common reference string: run ./fetch-crs.sh first")
    };
    Files {
        circuit: repo_file(&format!("web/circuits/{circuit}.json")),
        verification_key: repo_file(&format!("verifier/vk/{circuit}.vk")),
        crs_g1: crs("bn254_g1_compressed_2p18.dat"),
        crs_g2: crs("bn254_g2.dat"),
    }
}

/// What a card proof gives the last step.
struct Declaration<'a> {
    accounts: &'a str,
    challenge: &'a str,
    scope_signature: &'a [u8],
    declaration_code_signature: &'a [u8],
}

/// A session, closed when the test is done with it.
struct Session(u64);

impl Drop for Session {
    fn drop(&mut self) {
        idc_session_close(self.0);
    }
}

impl Session {
    fn check_artifacts(&self, files: &Files) -> i32 {
        unsafe {
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
        }
    }

    fn card_state_request(&self, now: i64, scope_signature: &[u8]) -> Result<Value, i32> {
        let mut out = empty();
        let code = unsafe {
            idc_session_card_state_request(
                self.0,
                now,
                scope_signature.as_ptr(),
                scope_signature.len(),
                &mut out,
            )
        };
        finish(code, out)
    }

    fn check_challenge(&self, now: i64, challenge: &str) -> Result<Value, i32> {
        let mut out = empty();
        let code = unsafe {
            idc_session_check_challenge(self.0, now, challenge.as_ptr(), challenge.len(), &mut out)
        };
        finish(code, out)
    }

    fn records_request(&self, files: &Files, d: &Declaration<'_>) -> Result<Value, i32> {
        let mut out = empty();
        let code = unsafe {
            idc_session_records_request(
                self.0,
                files.circuit.as_ptr(),
                files.circuit.len(),
                files.verification_key.as_ptr(),
                files.verification_key.len(),
                files.crs_g1.as_ptr(),
                files.crs_g1.len(),
                files.crs_g2.as_ptr(),
                files.crs_g2.len(),
                d.accounts.as_ptr(),
                d.accounts.len(),
                d.challenge.as_ptr(),
                d.challenge.len(),
                d.scope_signature.as_ptr(),
                d.scope_signature.len(),
                d.declaration_code_signature.as_ptr(),
                d.declaration_code_signature.len(),
                &mut out,
            )
        };
        finish(code, out)
    }
}

/// One case of circuit-inputs.json, with the accounts and the challenge
/// its declaration code was computed from (declaration-code.json).
struct Card {
    label: String,
    proof_log: ProofLog,
    issuers: Vec<(IssuerName, Vec<u8>)>,
    issuer: String,
    circuit: String,
    certificate: Vec<u8>,
    crl: Vec<u8>,
    now: i64,
    accounts: String,
    challenge: String,
    scope_signature: Vec<u8>,
    declaration_code_signature: Vec<u8>,
    smt_root: String,
    public_inputs: Vec<[u8; 32]>,
    files: Files,
}

fn cards() -> Vec<Card> {
    let v = vectors("circuit-inputs.json");
    let trees = vectors("revocation-tree.json");
    let codes = vectors("declaration-code.json");
    let issuers: Vec<(IssuerName, Vec<u8>)> = cases(&v, "issuers")
        .iter()
        .map(|k| {
            (
                IssuerName::parse(text(k, "issuer")).expect("G2 or G3"),
                unhex(text(k, "modulus")),
            )
        })
        .collect();
    cases(&v, "cases")
        .iter()
        .map(|case| {
            let crl = cases(&trees, "crls")
                .iter()
                .find(|c| c["name"] == case["crl"])
                .expect("the CRL of the case");
            let declared = cases(&codes, "cases")
                .iter()
                .find(|c| {
                    c["declaration_code"] == case["declaration_code"]
                        && c["scope_string"] == case["scope_string"]
                })
                .expect("the accounts and the challenge of the declaration code");
            let challenge = text(declared, "challenge");
            Card {
                label: text(case, "label").to_string(),
                proof_log: match text(case, "scope_string") {
                    "iamreal:public:0_______________" => ProofLog::Production,
                    _ => ProofLog::Test,
                },
                issuers: issuers.clone(),
                issuer: text(case, "issuer").to_string(),
                circuit: text(case, "circuit").to_string(),
                certificate: unhex(text(case, "certificate")),
                crl: unhex(text(crl, "crl")),
                // The day of the challenge.
                now: noon(&challenge[..10]),
                accounts: declared["accounts"].to_string(),
                challenge: challenge.to_string(),
                scope_signature: unhex(text(case, "scope_signature")),
                declaration_code_signature: unhex(text(case, "declaration_code_signature")),
                smt_root: text(&case["path"], "smt_root")[2..].to_string(),
                public_inputs: case["public_inputs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| common::fe(x.as_str().unwrap()))
                    .collect(),
                files: files_of(text(case, "circuit")),
            }
        })
        .collect()
}

const CONFIG: &[u8] = br#"{"crl_max_age_days":7,"platforms":[]}"#;

/// The steps before the proof.
#[derive(Clone, Copy, PartialEq)]
enum Step {
    Certificate,
    Crl,
    Tree,
    Artifacts,
}

impl Card {
    /// A session that trusts the vectors' test keys, with the files of
    /// this version of the core, after every step but `skipped`.
    fn session_without(&self, skipped: Option<Step>) -> Session {
        self.session_with(artifacts::BUILT_IN, &self.files, skipped)
    }

    /// The same, in a core that has `artifacts` written into it, given `files`.
    fn session_with(
        &self,
        artifacts: artifacts::Artifacts,
        files: &Files,
        skipped: Option<Step>,
    ) -> Session {
        let session = Session(session::open(
            self.proof_log,
            Trust {
                issuers: self.issuers.clone(),
                artifacts,
            },
        ));
        self.check(&session, files, skipped);
        session
    }

    /// Every step but `skipped`, on `session`: again, when it made them before.
    fn check(&self, session: &Session, files: &Files, skipped: Option<Step>) {
        let done = |code: i32, out: IdcBuf| {
            let result = finish(code, out);
            if let Ok(result) = &result {
                assert_eq!(result["ok"], true, "{}: {result}", self.label);
                // The CRL in these tests is dated the day of the challenge.
                if let Some(date) = result["crl_date"].as_str() {
                    assert_eq!(date, &self.challenge[..10]);
                }
            }
            result.is_ok()
        };
        if skipped != Some(Step::Certificate) {
            let der = &self.certificate;
            let code = unsafe { idc_session_add_certificate(session.0, der.as_ptr(), der.len()) };
            assert_eq!(code, IDC_OK);
            let mut out = empty();
            let code = unsafe { idc_session_check_certificates(session.0, self.now, &mut out) };
            assert!(done(code, out));
        }
        if skipped != Some(Step::Crl) {
            let index = format!(
                "{{\"issuer\":\"{}\",\"crl_number\":\"1\",\"sha256\":\"{}\",\"root\":\"{}\"}}\n",
                self.issuer,
                hex(&sha256(&self.crl)),
                "0".repeat(64),
            );
            let mut out = empty();
            let code =
                unsafe { idc_session_choose_crl(session.0, index.as_ptr(), index.len(), &mut out) };
            if done(code, out) {
                let mut out = empty();
                let code = unsafe {
                    idc_session_check_crl(
                        session.0,
                        self.crl.as_ptr(),
                        self.crl.len(),
                        CONFIG.as_ptr(),
                        CONFIG.len(),
                        std::ptr::null(),
                        0,
                        &mut out,
                    )
                };
                assert!(done(code, out));
            }
        }
        if skipped != Some(Step::Tree) {
            let _ = idc_session_build_tree(session.0);
        }
        if skipped != Some(Step::Artifacts) {
            let _ = session.check_artifacts(files);
        }
    }

    /// A session that passed every check and took the card's challenge.
    fn passed(&self) -> Session {
        let session = self.session_without(None);
        assert_eq!(
            session.check_challenge(self.now, &self.challenge),
            Ok(json!({ "ok": true })),
            "{}",
            self.label
        );
        session
    }

    fn declaration(&self) -> Declaration<'_> {
        Declaration {
            accounts: &self.accounts,
            challenge: &self.challenge,
            scope_signature: &self.scope_signature,
            declaration_code_signature: &self.declaration_code_signature,
        }
    }
}

/// Runs `bb verify` the way the Go verifier does (verifier/verify.go).
fn bb_verifies(bb: &str, dir: &Path, vk: &[u8], proof: &[u8], public_inputs: &[[u8; 32]]) -> bool {
    let crs = dir.join("crs");
    std::fs::create_dir_all(&crs).unwrap();
    // The one point of G1 a verifier needs: (1, 2).
    let mut point = [0u8; 64];
    (point[31], point[63]) = (1, 2);
    std::fs::write(crs.join("bn254_g1.dat"), point).unwrap();
    std::fs::write(dir.join("vk"), vk).unwrap();
    std::fs::write(dir.join("proof"), proof).unwrap();
    std::fs::write(dir.join("public_inputs"), public_inputs.concat()).unwrap();
    let output = Command::new(bb)
        .arg("verify")
        .args([Path::new("-k"), &dir.join("vk")])
        .args([Path::new("-p"), &dir.join("proof")])
        .args([Path::new("-i"), &dir.join("public_inputs")])
        .args([Path::new("-c"), &crs])
        .args(["-t", "noir-recursive"])
        .current_dir(dir)
        .output()
        .expect("IAMREAL_BB names an executable");
    output.status.success()
}

/// A directory for this test's files, under the build's own directory.
fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `IAMREAL_BB`, when it names something.
fn bb() -> Option<String> {
    std::env::var("IAMREAL_BB").ok().filter(|bb| !bb.is_empty())
}

#[test]
fn a_session_that_passed_every_check_gives_the_request_with_a_proof_that_verifies() {
    let cards = cards();
    assert!(cards.len() >= 4);
    assert!(cards.iter().any(|c| c.circuit == "card_proof_rs2048"));
    assert!(cards.iter().any(|c| c.circuit == "card_proof_rs4096"));
    let bb = bb();
    let dir = scratch("proof");
    let mut requests = Vec::new();
    for (i, card) in cards.iter().enumerate() {
        let label = &card.label;
        let session = card.passed();
        let state = session
            .card_state_request(card.now, &card.scope_signature)
            .unwrap();
        let started = std::time::Instant::now();
        let request = session
            .records_request(&card.files, &card.declaration())
            .unwrap_or_else(|code| panic!("{label}: {code}"));
        println!("{label}: {:?}", started.elapsed());

        // The fields of a record except `seq` (spec/record.md), and no other.
        let keys: Vec<&str> = request
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "accounts",
                "challenge",
                "circuit",
                "issuer",
                "proof",
                "scope_string",
                "scoped_id",
                "smt_root"
            ]
        );
        let limbs = card.public_inputs.len() - 5;
        assert_eq!(request["scope_string"], state["scope_string"], "{label}");
        // The scoped ID of the card-state request, and of the vectors.
        assert_eq!(request["scoped_id"], state["scoped_id"], "{label}");
        assert_eq!(
            text(&request, "scoped_id"),
            iamreal_device_checks::scoped_id::scoped_id_text(&card.public_inputs[limbs + 2])
                .unwrap()
        );
        assert_eq!(request["accounts"].to_string(), card.accounts, "{label}");
        assert_eq!(text(&request, "challenge"), card.challenge);
        assert_eq!(text(&request, "issuer"), card.issuer);
        assert_eq!(text(&request, "smt_root"), card.smt_root, "{label}");
        assert_eq!(
            text(&request, "circuit"),
            hex(&sha256(&card.files.verification_key))
        );
        let encoded = text(&request, "proof");
        assert_eq!(encoded.len(), 19_544);
        let made = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("standard base64");
        assert_eq!(made.len(), 14_656);

        // The proof says what the vectors say it must: Barretenberg
        // accepts it with the vectors' public inputs, and with no other.
        let vk = &card.files.verification_key;
        assert_eq!(
            proof::verify(vk, &card.public_inputs, &made),
            Ok(true),
            "{label}"
        );
        for changed in [limbs, limbs + 1, limbs + 2, limbs + 3, limbs + 4] {
            let mut other = card.public_inputs.clone();
            other[changed][31] ^= 1;
            assert_eq!(
                proof::verify(vk, &other, &made),
                Ok(false),
                "{label}: input {changed}"
            );
        }

        if let Some(bb) = &bb {
            let dir = dir.join(i.to_string());
            assert!(
                bb_verifies(bb, &dir, vk, &made, &card.public_inputs),
                "{label}: bb verify"
            );
            let mut other = card.public_inputs.clone();
            other[limbs + 2][31] ^= 1;
            assert!(
                !bb_verifies(bb, &dir, vk, &made, &other),
                "{label}: bb verify with another scoped ID"
            );
        }
        requests.push(request);
    }

    let Some(bb) = bb else {
        println!("IAMREAL_BB is not set: bb verify and the Go verifier were not run");
        return;
    };
    // The Go verifier rebuilds the public inputs from each request's
    // fields, as it does for a record, and runs bb verify.
    let issuers: serde_json::Map<String, Value> = cards[0]
        .issuers
        .iter()
        .map(|(name, modulus)| (name.as_str().to_string(), hex(modulus).into()))
        .collect();
    let file = dir.join("requests.json");
    let content = json!({ "issuers": issuers, "requests": requests });
    std::fs::write(&file, content.to_string()).unwrap();
    let go = Command::new("go")
        .args([
            "test",
            "./verifier",
            "-count=1",
            "-run",
            "^TestDeviceCoreRequests$",
            "-v",
        ])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .env("IAMREAL_BB", bb)
        .env("IAMREAL_DEVICE_REQUESTS", &file)
        .output()
        .expect("go, for the Go verifier");
    let report = String::from_utf8_lossy(&go.stdout);
    assert!(go.status.success(), "the Go verifier: {report}");
    assert!(
        report.contains(&format!("verified {} requests", cards.len())),
        "the Go verifier ran: {report}"
    );
}

#[test]
fn without_every_check_passed_no_proof_is_made() {
    let cards = cards();
    let card = &cards[0];
    for skipped in [Step::Certificate, Step::Crl, Step::Tree, Step::Artifacts] {
        let session = card.session_without(Some(skipped));
        assert_eq!(
            session.records_request(&card.files, &card.declaration()),
            Err(IDC_ERR_REFUSED)
        );
    }
    // Refused before anything else it was given is read.
    let session = card.session_without(Some(Step::Tree));
    for accounts in ["", "not a list"] {
        assert_eq!(
            session.records_request(
                &card.files,
                &Declaration {
                    accounts,
                    challenge: "",
                    ..card.declaration()
                }
            ),
            Err(IDC_ERR_REFUSED)
        );
    }
    // A session an app opens knows MOICA's keys only.
    let mut handle = 0;
    assert_eq!(
        unsafe { iamreal_device_core::idc_session_open(card.proof_log as u32, &mut handle) },
        IDC_OK
    );
    let session = Session(handle);
    assert_eq!(
        session.records_request(&card.files, &card.declaration()),
        Err(IDC_ERR_REFUSED)
    );
}

#[test]
fn the_files_are_checked_again_when_the_proof_is_made() {
    let cards = cards();
    let card = &cards[0];
    let good = &card.files;
    let other_circuit = files_of("card_proof_rs2048");
    assert_ne!(card.circuit, "card_proof_rs2048");
    let changed = |change: &dyn Fn(&mut Files)| {
        let mut files = files_of(&card.circuit);
        change(&mut files);
        files
    };
    let wrong = [
        changed(&|f| f.circuit = other_circuit.circuit.clone()),
        changed(&|f| f.circuit.push(b'\n')),
        changed(&|f| f.verification_key[0] ^= 1),
        changed(&|f| f.verification_key = other_circuit.verification_key.clone()),
        changed(&|f| f.crs_g1[100] ^= 1),
        changed(&|f| f.crs_g1.truncate(1 << 20)),
        changed(&|f| f.crs_g2[0] ^= 1),
        changed(&|f| f.crs_g2.clear()),
    ];
    for files in &wrong {
        let session = card.passed();
        assert_eq!(
            session.records_request(files, &card.declaration()),
            Err(IDC_ERR_INPUT)
        );
        // The session no longer counts the files as checked.
        assert_eq!(
            session.card_state_request(card.now, &card.scope_signature),
            Err(IDC_ERR_REFUSED)
        );
        assert_eq!(session.check_artifacts(good), IDC_OK);
        assert!(
            session
                .card_state_request(card.now, &card.scope_signature)
                .is_ok()
        );
    }
}

#[test]
fn what_the_card_did_not_sign_gives_no_proof() {
    let cards = cards();
    let card = &cards[0];
    let another = cards
        .iter()
        .find(|c| c.certificate != card.certificate)
        .expect("a second card");
    let session = card.passed();
    let good = card.declaration();
    let refused = |d: Declaration<'_>, what: &str| {
        assert_eq!(
            session.records_request(&card.files, &d),
            Err(IDC_ERR_INPUT),
            "{what}"
        );
    };
    let mut flipped = card.declaration_code_signature.clone();
    flipped[255] ^= 1;
    let mut flipped_scope = card.scope_signature.clone();
    flipped_scope[0] ^= 1;
    refused(
        Declaration {
            declaration_code_signature: &flipped,
            ..card.declaration()
        },
        "a signature with one bit changed",
    );
    refused(
        Declaration {
            scope_signature: &flipped_scope,
            ..card.declaration()
        },
        "a scope signature with one bit changed",
    );
    refused(
        Declaration {
            scope_signature: good.declaration_code_signature,
            declaration_code_signature: good.scope_signature,
            ..card.declaration()
        },
        "the two signatures in each other's place",
    );
    refused(
        Declaration {
            declaration_code_signature: good.scope_signature,
            ..card.declaration()
        },
        "the scope signature twice",
    );
    refused(
        Declaration {
            scope_signature: &another.scope_signature,
            declaration_code_signature: &another.declaration_code_signature,
            ..card.declaration()
        },
        "another card's signatures",
    );
    refused(
        Declaration {
            scope_signature: &card.scope_signature[1..],
            ..card.declaration()
        },
        "a short signature",
    );
    refused(
        Declaration {
            declaration_code_signature: &[],
            ..card.declaration()
        },
        "no signature",
    );
    // The card signed the declaration code of one list and one challenge.
    assert_eq!(
        card.accounts,
        r#"[{"platform":"threads","username":"alice"}]"#
    );
    for accounts in [
        "[]",
        r#"[{"platform":"threads","username":"bob"}]"#,
        r#"[{"platform":"test-example","username":"alice"}]"#,
        r#"[{"platform":"test-example","username":"a-b"},{"platform":"threads","username":"alice"}]"#,
    ] {
        refused(
            Declaration {
                accounts,
                ..card.declaration()
            },
            accounts,
        );
    }
    // What is not a list or a challenge at all.
    for accounts in [
        "",
        "{}",
        r#"[{"platform":"threads","username":"alice"},{"platform":"test-example","username":"a-b"}]"#,
        r#"[{"platform":"threads","username":"alice"},{"platform":"threads","username":"alice"}]"#,
        r#"[{"platform":"threads","username":"alice","extra":1}]"#,
    ] {
        refused(
            Declaration {
                accounts,
                ..card.declaration()
            },
            accounts,
        );
    }
    // The card signed the declaration code of one challenge: another one
    // of the same date, which the session took, gives no proof either.
    let another = "2026-11-16.000G40R40M30E209185GR38E20";
    assert_eq!(
        session.check_challenge(card.now, another),
        Ok(json!({ "ok": true }))
    );
    refused(
        Declaration {
            challenge: another,
            ..card.declaration()
        },
        "another challenge",
    );
    // What is not a challenge at all was never taken.
    for challenge in ["", "2026-11-16", "2026-11-16.000g40r40m30e209185gr38e1w"] {
        assert_eq!(
            session.records_request(
                &card.files,
                &Declaration {
                    challenge,
                    ..card.declaration()
                }
            ),
            Err(IDC_ERR_REFUSED),
            "{challenge}"
        );
    }
    // None of that undid the checks: with the card's challenge taken
    // again, the session proves.
    assert_eq!(
        session.check_challenge(card.now, &card.challenge),
        Ok(json!({ "ok": true }))
    );
    assert!(session.records_request(&card.files, &good).is_ok());
}

unsafe extern "C" {
    /// `bb::set_parallel_for_concurrency(size_t)` of the Barretenberg
    /// linked into the test, to start from a number that is not the
    /// cores'.
    #[link_name = "_ZN2bb28set_parallel_for_concurrencyEm"]
    fn bb_set_parallel_for_concurrency(count: usize);
}

#[test]
fn the_core_sets_barretenbergs_threads_to_the_number_of_cores() {
    let cores = std::thread::available_parallelism().unwrap().get();
    let cards = cards();
    let card = cards
        .iter()
        .find(|c| c.circuit == "card_proof_rs2048")
        .unwrap();
    // The setting belongs to the thread: a thread that proves for the
    // first time, and one on which Barretenberg was told another number.
    for before in [None, Some(cores + 3)] {
        // A session makes one proof for the challenge it took.
        let session = card.passed();
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    if let Some(count) = before {
                        unsafe { bb_set_parallel_for_concurrency(count) };
                        assert_eq!(proof::barretenberg_threads(), count);
                    }
                    session
                        .records_request(&card.files, &card.declaration())
                        .unwrap();
                    assert_eq!(proof::barretenberg_threads(), cores);
                })
                .join()
                .unwrap();
        });
    }
}

const CHILD: &str = "IDC_TEST_PROOF_PRINTS";

/// The test runs itself again as another process, to read what that
/// process wrote while it made a proof.
#[test]
fn making_a_proof_prints_nothing() {
    let cards = cards();
    let card = cards
        .iter()
        .find(|c| c.circuit == "card_proof_rs2048")
        .unwrap();
    if std::env::var_os(CHILD).is_some() {
        let session = card.passed();
        session
            .records_request(&card.files, &card.declaration())
            .unwrap();
        return;
    }
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "making_a_proof_prints_nothing",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD, "1")
        .output()
        .unwrap();
    assert!(output.status.success());
    // The test harness writes to stdout; nothing writes to stderr.
    let printed = String::from_utf8_lossy(&output.stderr);
    assert_eq!(printed, "", "what the process wrote to stderr");
    let report = String::from_utf8_lossy(&output.stdout);
    assert!(report.contains("1 passed"), "the proof was made: {report}");
    assert!(!report.contains("mem:"), "{report}");
}

/// The challenge of `card` with another date.
fn challenge_on(card: &Card, date: &str) -> String {
    format!("{date}{}", &card.challenge[10..])
}

#[test]
fn the_proof_is_made_for_the_challenge_taken_on_the_sessions_date_only() {
    let cards = cards();
    let card = &cards[0];
    let session = card.passed();
    let on = |date: &str| {
        let challenge = challenge_on(card, date);
        session.records_request(
            &card.files,
            &Declaration {
                challenge: &challenge,
                ..card.declaration()
            },
        )
    };
    assert_eq!(&card.challenge[..10], "2026-11-16");
    for other in ["2026-11-15", "2026-11-17", "2026-11-24", "2025-12-31"] {
        assert_eq!(on(other), Err(IDC_ERR_REFUSED), "{other}");
    }
    // After midnight a challenge of the new date is taken, and the session
    // holds for that date: the challenge gets as far as the signatures,
    // which are over another challenge here.
    assert_eq!(
        session.check_challenge(noon("2026-11-17"), &challenge_on(card, "2026-11-17")),
        Ok(json!({ "ok": true }))
    );
    assert_eq!(on("2026-11-17"), Err(IDC_ERR_INPUT));
    assert_eq!(on("2026-11-16"), Err(IDC_ERR_REFUSED));
    // Back on the day of the challenge the card signed.
    assert_eq!(
        session.check_challenge(card.now, &card.challenge),
        Ok(json!({ "ok": true }))
    );
    assert!(on("2026-11-16").is_ok());
}

/// spec/device-checks.md, "One proof for the card's signatures".
#[test]
fn the_cards_signatures_get_one_proof() {
    let cards = cards();
    let card = &cards[0];
    let session = card.passed();
    assert!(
        session
            .records_request(&card.files, &card.declaration())
            .is_ok()
    );
    // Not a second one, as it is.
    assert_eq!(
        session.records_request(&card.files, &card.declaration()),
        Err(IDC_ERR_REFUSED)
    );
    // Nor once the challenge is offered again: it is not taken.
    assert_eq!(
        session.check_challenge(card.now, &card.challenge),
        Err(IDC_ERR_REFUSED)
    );
    assert_eq!(
        session.records_request(&card.files, &card.declaration()),
        Err(IDC_ERR_REFUSED)
    );
    // Nor with the checks made again from the start, which is how the
    // tree's root and the path would be other ones: the same handle goes
    // through every step again and passes, as a card state request
    // shows, and still does not take the challenge.
    card.check(&session, &card.files, None);
    assert!(
        session
            .card_state_request(card.now, &card.scope_signature)
            .is_ok()
    );
    assert_eq!(
        session.check_challenge(card.now, &card.challenge),
        Err(IDC_ERR_REFUSED)
    );
    assert_eq!(
        session.records_request(&card.files, &card.declaration()),
        Err(IDC_ERR_REFUSED)
    );
    // Another challenge is taken, also by this session: its declaration
    // code is another one, which the card has to sign.
    let another = "2026-11-16.000G40R40M30E209185GR38E20";
    assert_eq!(
        session.check_challenge(card.now, another),
        Ok(json!({ "ok": true }))
    );
    assert_eq!(
        session.records_request(
            &card.files,
            &Declaration {
                challenge: another,
                ..card.declaration()
            }
        ),
        Err(IDC_ERR_INPUT)
    );
    // That signature was not the card's: nothing was computed, and the
    // challenge is not spent (what_the_card_did_not_sign_gives_no_proof).
    assert_eq!(
        session.check_challenge(card.now, another),
        Ok(json!({ "ok": true }))
    );
}

#[test]
fn after_a_proof_that_failed_there_is_no_second_one() {
    let cards = cards();
    let card = &cards[0];
    // A core with the two circuits the wrong way round: the checks pass,
    // the signatures are the card's, and the circuit has no proof for
    // them.
    let other = if card.circuit == "card_proof_rs2048" {
        "card_proof_rs4096"
    } else {
        "card_proof_rs2048"
    };
    let files = files_of(other);
    let swapped = artifacts::Artifacts {
        rs2048: artifacts::BUILT_IN.rs4096,
        rs4096: artifacts::BUILT_IN.rs2048,
        ..artifacts::BUILT_IN
    };
    let session = card.session_with(swapped, &files, None);
    assert_eq!(
        session.check_challenge(card.now, &card.challenge),
        Ok(json!({ "ok": true }))
    );
    let failed = session.records_request(&files, &card.declaration());
    assert!(
        matches!(failed, Err(code) if code != IDC_ERR_REFUSED),
        "{failed:?}"
    );
    // The same signatures again, the challenge again: refused, before
    // anything is computed.
    assert_eq!(
        session.records_request(&files, &card.declaration()),
        Err(IDC_ERR_REFUSED)
    );
    assert_eq!(
        session.check_challenge(card.now, &card.challenge),
        Err(IDC_ERR_REFUSED)
    );
    assert_eq!(
        session.records_request(&files, &card.declaration()),
        Err(IDC_ERR_REFUSED)
    );
}
