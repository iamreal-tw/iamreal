//! One card proof in progress, and the result "every check passed"
//! (ADR-0034, "核心擋住的順序").
//!
//! The core keeps the session; the app holds a number that names it. The
//! checks that need no signature are steps of the session, each one
//! allowed only after the steps it builds on:
//!
//! 1. the certificate is chosen and checked;
//! 2. a CRL is chosen from the mirror's index, then checked;
//! 3. the tree is built, and the certificate's serial number is not in it;
//! 4. the circuit, its verification key and the common reference string
//!    are the files written into the core.
//!
//! Only a session that passed all four computes a scoped ID or writes
//! anything meant for the server. The app cannot make such a session any
//! other way: what "passed" means is kept here, not in a value the app
//! could build.
//!
//! What is `pub` here and not `extern "C"` is for this directory's tests:
//! they open a session that trusts test keys ([`open`]) and then go
//! through the C functions like an app.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use iamreal_device_checks::certificate::{
    CardCertificate, Selection, is_card_signature, select_certificate,
};
use iamreal_device_checks::crl::CrlNumber;
use iamreal_device_checks::date::Date;
use iamreal_device_checks::issuers::{IssuerKey, IssuerName, MOICA_ISSUERS};
use iamreal_device_checks::key::Key;
use iamreal_device_checks::revocation::{
    CrlProblem, IndexChoice, IndexLine, check_crl_file, choose_from_index, crl_max_age,
};
use iamreal_device_checks::scope::{Roster, scope_string};
use iamreal_device_checks::scoped_id::{SIGNATURE_LENGTH, scoped_id, scoped_id_text};
use iamreal_device_checks::tree::{AbsenceProof, TreeResult};
use iamreal_device_checks::wipe;
use serde_json::{Value, json};

use crate::artifacts::{self, Artifacts};
use crate::hashes::{Barretenberg, Sha2};
use crate::{IDC_ERR_ARGUMENT, IDC_ERR_INPUT, IDC_ERR_INTERNAL, IDC_ERR_REFUSED};

/// What a session checks against. An app's sessions use [`Trust::built_in`]
/// and nothing else; tests put test keys here.
pub struct Trust {
    /// The issuer keys, in the order a certificate is tried under them.
    pub issuers: Vec<(IssuerName, Vec<u8>)>,
    pub artifacts: Artifacts,
}

impl Trust {
    /// MOICA's keys and the files of this version of the core.
    pub fn built_in() -> Trust {
        Trust {
            issuers: MOICA_ISSUERS
                .iter()
                .map(|key| (key.name, key.modulus.to_vec()))
                .collect(),
            artifacts: artifacts::BUILT_IN,
        }
    }

    fn issuer_keys(&self) -> Vec<IssuerKey<'_>> {
        self.issuers
            .iter()
            .map(|(name, modulus)| IssuerKey {
                name: *name,
                modulus,
            })
            .collect()
    }
}

struct Session {
    roster: Roster,
    trust: Trust,
    /// The certificates the card returned, until they are checked.
    offered: Vec<Vec<u8>>,
    /// Step 1.
    certificate: Option<CardCertificate>,
    /// Step 2: the file chosen from the index, then the keys of the CRL
    /// that passed.
    crl_choice: Option<IndexChoice>,
    crl_keys: Option<Vec<Key>>,
    /// Step 3.
    path: Option<AbsenceProof>,
    /// Step 4.
    artifacts_checked: bool,
}

/// What a session that passed every check holds.
struct Passed<'a> {
    certificate: &'a CardCertificate,
    #[allow(dead_code)] // The proof's inputs (the ticket that adds the proof).
    path: &'a AbsenceProof,
}

impl Session {
    /// "Every check passed", or `None`.
    fn passed(&self) -> Option<Passed<'_>> {
        match (&self.certificate, &self.path, self.artifacts_checked) {
            (Some(certificate), Some(path), true) => Some(Passed { certificate, path }),
            _ => None,
        }
    }

    fn forget_offered(&mut self) {
        for certificate in &mut self.offered {
            wipe(certificate);
        }
        self.offered.clear();
    }

    /// Forgets the CRL and what follows from it.
    fn forget_crl(&mut self) {
        self.crl_choice = None;
        self.crl_keys = None;
        self.path = None;
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // The chosen certificate wipes itself.
        self.forget_offered();
    }
}

type Shared = Arc<Mutex<Session>>;

static SESSIONS: Mutex<Option<HashMap<u64, Shared>>> = Mutex::new(None);
/// 0 is never a session.
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Opens a session and returns the number that names it.
pub fn open(roster: Roster, trust: Trust) -> u64 {
    let session = Session {
        roster,
        trust,
        offered: Vec::new(),
        certificate: None,
        crl_choice: None,
        crl_keys: None,
        path: None,
        artifacts_checked: false,
    };
    let handle = NEXT.fetch_add(1, Ordering::Relaxed);
    SESSIONS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get_or_insert_with(HashMap::new)
        .insert(handle, Arc::new(Mutex::new(session)));
    handle
}

/// Closes a session: the certificate, the name and everything computed
/// from them are overwritten with zeros and released. If a call on the
/// session is running on another thread, that happens when it returns.
/// A number that names no session does nothing.
pub fn close(handle: u64) {
    let session = SESSIONS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_mut()
        .and_then(|sessions| sessions.remove(&handle));
    // Dropped outside the lock on the table.
    drop(session);
}

/// Runs one step on the session `handle` names. One step at a time: a
/// second call waits for the first.
fn with<T>(handle: u64, step: impl FnOnce(&mut Session) -> Result<T, i32>) -> Result<T, i32> {
    let session = SESSIONS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .and_then(|sessions| sessions.get(&handle).cloned())
        .ok_or(IDC_ERR_ARGUMENT)?;
    // A step that panicked left the session in a state nobody checked.
    let mut session = session.lock().map_err(|_| IDC_ERR_INTERNAL)?;
    step(&mut session)
}

fn today(now: i64) -> Result<Date, i32> {
    Date::in_taiwan(now).ok_or(IDC_ERR_ARGUMENT)
}

fn bytes_of(result: Value) -> Vec<u8> {
    // Writing a value built here to memory does not fail.
    serde_json::to_vec(&result).unwrap_or_default()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `YYMMDDHHMMSS` as the certificate writes it.
fn certificate_time(time: u64) -> String {
    format!("{time:012}")
}

/// Adds one certificate the card returned, in the card's order. The core
/// keeps a copy until the certificates are checked.
pub fn add_certificate(handle: u64, certificate: &[u8]) -> Result<(), i32> {
    with(handle, |session| {
        session.offered.push(certificate.to_vec());
        Ok(())
    })
}

/// Step 1: chooses and checks the certificate among those added
/// (spec/device-checks.md, "The certificate"), for the date in Taiwan of
/// `now` (seconds since 1970-01-01T00:00:00Z). The result is JSON:
///
/// - `{"ok":true,"chosen":0,"issuer":"G3","name":"…","not_before":"…","not_after":"…"}`
/// - `{"ok":false,"problem":"expired","not_after":"…"}`
///
/// The session keeps the chosen certificate and wipes the others. A second
/// call starts the session over with the certificates added since.
pub fn check_certificates(handle: u64, now: i64) -> Result<Vec<u8>, i32> {
    with(handle, |session| {
        let today = today(now)?;
        session.certificate = None;
        session.artifacts_checked = false;
        session.forget_crl();
        let selection = {
            let offered: Vec<&[u8]> = session.offered.iter().map(Vec::as_slice).collect();
            select_certificate(&offered, today, &session.trust.issuer_keys(), &mut Sha2)
        };
        session.forget_offered();
        Ok(bytes_of(match selection {
            Selection::Chosen { index, certificate } => {
                let result = json!({
                    "ok": true,
                    "chosen": index,
                    "issuer": certificate.issuer().as_str(),
                    "name": certificate.name(),
                    "not_before": certificate_time(certificate.not_before()),
                    "not_after": certificate_time(certificate.not_after()),
                });
                session.certificate = Some(certificate);
                result
            }
            Selection::Refused {
                problem,
                not_after,
                not_before,
            } => {
                let mut result = json!({ "ok": false, "problem": problem.code() });
                if let Some(time) = not_after {
                    result["not_after"] = certificate_time(time).into();
                }
                if let Some(time) = not_before {
                    result["not_before"] = certificate_time(time).into();
                }
                result
            }
        }))
    })
}

/// The lines of the archive index that are JSON objects, as the four
/// fields the choice reads. A field that is not a string is read as a
/// value no line has.
fn index_lines(text: &str) -> Vec<[String; 4]> {
    text.split('\n')
        .filter_map(|line| match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(object)) => {
                let field = |key: &str| match object.get(key) {
                    Some(Value::String(text)) => text.clone(),
                    _ => String::new(),
                };
                Some([
                    field("issuer"),
                    field("crl_number"),
                    field("sha256"),
                    field("root"),
                ])
            }
            _ => None,
        })
        .collect()
}

/// Step 2, first half: chooses the CRL file from the mirror's index
/// (spec/device-checks.md, "Choosing a file from the index"). `index` is
/// the body of `index.jsonl`. The result is JSON:
///
/// - `{"ok":true,"crl_number":"…","sha256":"…"}`: the app downloads
///   `<sha256>.crl`;
/// - `{"ok":false,"problem":"crl_unavailable"}`.
///
/// `IDC_ERR_REFUSED` before a certificate was chosen.
pub fn choose_crl(handle: u64, index: &[u8]) -> Result<Vec<u8>, i32> {
    with(handle, |session| {
        let issuer = session
            .certificate
            .as_ref()
            .ok_or(IDC_ERR_REFUSED)?
            .issuer();
        session.forget_crl();
        // Without a byte order mark at its start, if there is one.
        let index = index.strip_prefix(b"\xef\xbb\xbf").unwrap_or(index);
        let choice = std::str::from_utf8(index).ok().and_then(|text| {
            let lines = index_lines(text);
            choose_from_index(
                lines
                    .iter()
                    .map(|[issuer, crl_number, sha256, root]| IndexLine {
                        issuer,
                        crl_number,
                        sha256,
                        root,
                    }),
                issuer.as_str(),
            )
        });
        Ok(bytes_of(match choice {
            Some(choice) => {
                let result = json!({
                    "ok": true,
                    "crl_number": choice.crl_number.as_str(),
                    "sha256": hex(&choice.sha256),
                });
                session.crl_choice = Some(choice);
                result
            }
            None => json!({ "ok": false, "problem": "crl_unavailable" }),
        }))
    })
}

/// `crl_max_age_days` of the body of `GET /api/v1/config`: a JSON number
/// that is a non-negative integer no larger than 2^53 − 1, written as
/// plain digits. `None` for a body that is not a JSON object, or has any
/// other value there: such a config is not read at all.
pub fn server_max_age_days(config: &[u8]) -> Option<u64> {
    const LARGEST: u64 = (1 << 53) - 1;
    let config: Value = serde_json::from_slice(config).ok()?;
    let days = config.as_object()?.get("crl_max_age_days")?.as_u64()?;
    (days <= LARGEST).then_some(days)
}

/// Step 2, second half: checks the file the app downloaded
/// (spec/device-checks.md, "Checking the file"), then whether the
/// certificate's serial number is among its serial numbers.
///
/// - `file`: the body of `<sha256>.crl`, for the `sha256` the choice gave.
/// - `now`: seconds since 1970-01-01T00:00:00Z, from the device's clock.
/// - `config`: the body of `GET /api/v1/config`; only `crl_max_age_days`
///   is read here.
/// - `highest`: the highest CRL number this device remembers for the
///   issuer, in decimal; empty for none.
///
/// The result is JSON; `highest_after` is what the app remembers for the
/// issuer from now on (`null` for none):
///
/// - `{"ok":true,"crl_number":"…","crl_date":"YYYY-MM-DD","sha256":"…","highest_after":"…"}`
/// - `{"ok":false,"problem":"crl_stale","days":4,"max_age_days":3,"highest_after":…}`,
///   and likewise `crl_hash`, `crl_unusable` (with `reason`),
///   `crl_rollback` (with `crl_number` and `highest`);
/// - `{"ok":false,"problem":"revoked","highest_after":"…"}`: the CRL
///   passed, and the certificate is on it;
/// - `{"ok":false,"problem":"malformed_response","highest_after":…}`: the
///   config has no `crl_max_age_days` the device reads.
///
/// `IDC_ERR_REFUSED` before a file was chosen from the index;
/// `IDC_ERR_INPUT` when `highest` is not a number in decimal.
pub fn check_crl(
    handle: u64,
    file: &[u8],
    now: i64,
    config: &[u8],
    highest: &[u8],
) -> Result<Vec<u8>, i32> {
    with(handle, |session| {
        let today = today(now)?;
        let highest = match highest {
            [] => None,
            digits => Some(
                std::str::from_utf8(digits)
                    .ok()
                    .and_then(CrlNumber::from_decimal)
                    .ok_or(IDC_ERR_INPUT)?,
            ),
        };
        let (Some(certificate), Some(choice)) = (&session.certificate, &session.crl_choice) else {
            return Err(IDC_ERR_REFUSED);
        };
        session.crl_keys = None;
        session.path = None;
        let remembered = |number: Option<&CrlNumber>| match number {
            Some(number) => Value::from(number.as_str()),
            None => Value::Null,
        };
        let failed = |mut result: Value| {
            result["ok"] = false.into();
            result["highest_after"] = remembered(highest.as_ref());
            Ok(bytes_of(result))
        };
        let Some(server_days) = server_max_age_days(config) else {
            return failed(json!({ "problem": "malformed_response" }));
        };
        let issuers = session.trust.issuer_keys();
        // Only the key of the certificate's issuer is tried.
        let issuer = issuers
            .iter()
            .find(|key| key.name == certificate.issuer())
            .ok_or(IDC_ERR_INTERNAL)?;
        let checked = check_crl_file(
            file,
            &choice.sha256,
            issuer,
            today,
            crl_max_age(server_days),
            highest.as_ref(),
            &mut Sha2,
        );
        let crl = match checked {
            Ok(crl) => crl,
            Err(problem) => {
                let mut result = json!({ "problem": problem.code() });
                match &problem {
                    CrlProblem::Hash => {}
                    CrlProblem::Unusable(reason) => result["reason"] = reason.code().into(),
                    CrlProblem::Rollback {
                        crl_number,
                        highest,
                    } => {
                        result["crl_number"] = crl_number.as_str().into();
                        result["highest"] = highest.as_str().into();
                    }
                    CrlProblem::Stale { days, max_age_days } => {
                        result["days"] = (*days).into();
                        result["max_age_days"] = (*max_age_days).into();
                    }
                }
                return failed(result);
            }
        };
        // The CRL passed: the device remembers the higher number.
        let highest_after = match highest {
            Some(highest) if highest > crl.crl_number => highest,
            _ => crl.crl_number.clone(),
        };
        // A serial number is in the tree exactly when it is one of the keys.
        if crl.keys.contains(&certificate.serial()) {
            return Ok(bytes_of(json!({
                "ok": false,
                "problem": "revoked",
                "highest_after": highest_after.as_str(),
            })));
        }
        let result = json!({
            "ok": true,
            "crl_number": crl.crl_number.as_str(),
            "crl_date": crl.crl_date(),
            "sha256": hex(&choice.sha256),
            "highest_after": highest_after.as_str(),
        });
        session.crl_keys = Some(crl.keys);
        Ok(bytes_of(result))
    })
}

/// Step 3: builds the revocation tree from the CRL that passed and the
/// path of the certificate's serial number, in 4 parts on 4 threads
/// (spec/revocation-tree.md). It returns when the tree is built; the
/// session keeps the path and lets go of the CRL's serial numbers.
///
/// `IDC_ERR_REFUSED` before a CRL passed, and when the tree of this CRL
/// was already built.
pub fn build_tree(handle: u64) -> Result<(), i32> {
    with(handle, |session| {
        let serial = session
            .certificate
            .as_ref()
            .ok_or(IDC_ERR_REFUSED)?
            .serial();
        session.path = None;
        let keys = session.crl_keys.take().ok_or(IDC_ERR_REFUSED)?;
        match crate::tree::build_tree(&keys, serial) {
            Ok(TreeResult::Absent(path)) => {
                session.path = Some(path);
                Ok(())
            }
            // The check of the CRL already stopped a serial number that
            // is in the tree.
            Ok(TreeResult::InTree { .. }) | Err(_) => Err(IDC_ERR_INTERNAL),
        }
    })
}

/// Step 4: checks the files the app carries against the SHA-256 written
/// into the core (ADR-0035): the compiled circuit of the certificate's
/// issuer, its verification key, and the two files of the common
/// reference string. The core keeps none of them.
///
/// `IDC_ERR_INPUT` when any of them is not the file written into the
/// core; `IDC_ERR_REFUSED` before a certificate was chosen.
pub fn check_artifacts(
    handle: u64,
    circuit: &[u8],
    verification_key: &[u8],
    crs_g1: &[u8],
    crs_g2: &[u8],
) -> Result<(), i32> {
    with(handle, |session| {
        let issuer = session
            .certificate
            .as_ref()
            .ok_or(IDC_ERR_REFUSED)?
            .issuer();
        session.artifacts_checked = session.trust.artifacts.are(
            issuer,
            circuit,
            verification_key,
            crs_g1,
            crs_g2,
            &mut Sha2,
        );
        if session.artifacts_checked {
            Ok(())
        } else {
            Err(IDC_ERR_INPUT)
        }
    })
}

/// The body of `POST /api/v1/card-state` (docs/api/card-proof.md):
/// `{"scope_string":"…","scoped_id":"…"}`, with the scoped ID computed
/// from the card's signature over the scope string of the session's
/// roster. The first thing a card proof sends that names the card.
///
/// `IDC_ERR_REFUSED` unless the session passed every check;
/// `IDC_ERR_INPUT` when `scope_signature` is not the signature of the
/// session's certificate over that scope string.
pub fn card_state_request(handle: u64, scope_signature: &[u8]) -> Result<Vec<u8>, i32> {
    with(handle, |session| {
        let passed = session.passed().ok_or(IDC_ERR_REFUSED)?;
        let scope = scope_string(session.roster);
        if !is_card_signature(passed.certificate, scope, scope_signature, &mut Sha2) {
            return Err(IDC_ERR_INPUT);
        }
        // A signature that verifies is 256 bytes.
        let mut signature: [u8; SIGNATURE_LENGTH] =
            scope_signature.try_into().map_err(|_| IDC_ERR_INPUT)?;
        let id = Barretenberg::new().and_then(|mut hash| scoped_id(&signature, &mut hash));
        wipe(&mut signature);
        let id = id.map_err(|_| IDC_ERR_INTERNAL)?;
        let text = scoped_id_text(&id).ok_or(IDC_ERR_INTERNAL)?;
        // The scope string is ASCII.
        let scope = std::str::from_utf8(scope).map_err(|_| IDC_ERR_INTERNAL)?;
        Ok(bytes_of(
            json!({ "scope_string": scope, "scoped_id": text }),
        ))
    })
}
