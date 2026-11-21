//! The half of `device-core/` that links Barretenberg (ADR-0034), and the C
//! functions the Android and iOS apps call. The functions are declared in
//! `include/iamreal_device_core.h`; the conventions they follow are in
//! `device-core/README.md`, "C 函式的慣例".
//!
//! Nothing here does I/O: bytes in, bytes out. No function takes a PIN.
//!
//! Without the feature `testing`, the C functions are all this crate
//! gives: Poseidon2 is not one of them, and the one that computes a
//! scoped ID takes a session that passed every check (ADR-0034, "核心擋住
//! 的順序"). The feature is for this crate's tests, which need Poseidon2
//! and the tree by themselves and a session that trusts test keys.

mod alloc;
mod json;
mod server_state;

/// Declares a module that is `pub` only with the feature `testing`.
macro_rules! for_tests {
    ($($name:ident),*) => {$(
        #[cfg(feature = "testing")]
        pub mod $name;
        #[cfg(not(feature = "testing"))]
        mod $name;
    )*};
}
for_tests!(artifacts, hashes, proof, quiet, session, tree, witness);

use iamreal_device_checks::challenge::parse_challenge;
use iamreal_device_checks::date::Date;
use iamreal_device_checks::declaration_code::{Account, declaration_code};
use iamreal_device_checks::field::fe_of_u64;
use iamreal_device_checks::hash::Poseidon2;
use iamreal_device_checks::list_consequence::{Consequence, list_consequence};
use iamreal_device_checks::roster_rules::{self, Reason};
use iamreal_device_checks::scope::{Roster, scope_string};
use iamreal_device_checks::scoped_id::{parse_scoped_id, short_id};
use iamreal_device_checks::username_format::{is_any_username, is_platform_id};
use serde_json::json;

use crate::json::Json;
use crate::server_state::{read_card_state, read_platforms};

/// The version of the C functions: the number the header gives as
/// `IDC_ABI_VERSION`. It goes up when a function changes or goes away.
pub const IDC_ABI_VERSION: u32 = 1;

/// The function did what it is for.
pub const IDC_OK: i32 = 0;
/// The call itself is wrong: a null pointer, or a number that is none of
/// the listed values. A mistake in the app's code.
pub const IDC_ERR_ARGUMENT: i32 = 1;
/// The bytes passed in are not what the function reads.
pub const IDC_ERR_INPUT: i32 = 2;
/// The core failed: a panic, or Barretenberg did not answer.
pub const IDC_ERR_INTERNAL: i32 = 3;
/// The session has not passed the checks this function needs first.
pub const IDC_ERR_REFUSED: i32 = 4;

/// The production roster.
pub const IDC_ROSTER_PRODUCTION: u32 = 0;
/// A test roster.
pub const IDC_ROSTER_TEST: u32 = 1;

/// Bytes the core hands to its caller. The caller reads `len` bytes at
/// `ptr` and gives the buffer back with [`idc_buf_free`], once.
#[repr(C)]
pub struct IdcBuf {
    pub ptr: *mut u8,
    pub len: usize,
}

const EMPTY: IdcBuf = IdcBuf {
    ptr: std::ptr::null_mut(),
    len: 0,
};

/// Runs `f` and returns its code.
fn code(f: impl FnOnce() -> Result<(), i32>) -> i32 {
    match quiet::guarded(f) {
        Ok(()) => IDC_OK,
        Err(code) => code,
    }
}

/// Runs `f` and puts its bytes in `*out`. `*out` is empty unless the
/// result is `IDC_OK`.
fn output(out: *mut IdcBuf, f: impl FnOnce() -> Result<Vec<u8>, i32>) -> i32 {
    if out.is_null() {
        return IDC_ERR_ARGUMENT;
    }
    // SAFETY: `out` is not null, and the caller gives a pointer to an `idc_buf` it may write.
    unsafe { out.write(EMPTY) };
    code(|| {
        let boxed = f()?.into_boxed_slice();
        let len = boxed.len();
        let ptr = Box::into_raw(boxed).cast::<u8>();
        // SAFETY: as above.
        unsafe { out.write(IdcBuf { ptr, len }) };
        Ok(())
    })
}

/// The `len` bytes at `ptr` the caller passed in, for the length of the call.
///
/// # Safety
/// `ptr` is null, or points to `len` bytes that stay unchanged during the call.
unsafe fn input<'a>(ptr: *const u8, len: usize) -> Result<&'a [u8], i32> {
    if ptr.is_null() {
        // No bytes may be passed as (NULL, 0).
        return if len == 0 {
            Ok(&[])
        } else {
            Err(IDC_ERR_ARGUMENT)
        };
    }
    // A slice is never longer than `isize::MAX` bytes.
    if isize::try_from(len).is_err() {
        return Err(IDC_ERR_ARGUMENT);
    }
    // SAFETY: the caller's promise, and the length was checked.
    Ok(unsafe { std::slice::from_raw_parts(ptr, len) })
}

fn roster_of(roster: u32) -> Result<Roster, i32> {
    match roster {
        IDC_ROSTER_PRODUCTION => Ok(Roster::Production),
        IDC_ROSTER_TEST => Ok(Roster::Test),
        _ => Err(IDC_ERR_ARGUMENT),
    }
}

/// `IDC_ABI_VERSION` of the library that is linked.
#[unsafe(no_mangle)]
pub extern "C" fn idc_abi_version() -> u32 {
    IDC_ABI_VERSION
}

/// Gives a buffer back to the core. Its bytes are overwritten with zeros
/// before the memory is released, and `*buf` becomes empty, so a second
/// call with the same `buf` does nothing.
///
/// # Safety
/// `buf` is null, or points to an `idc_buf` a function of this library
/// filled (or an empty one), not freed through another copy.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_buf_free(buf: *mut IdcBuf) {
    if buf.is_null() {
        return;
    }
    // SAFETY: the caller's promise.
    let IdcBuf { ptr, len } = unsafe { buf.replace(EMPTY) };
    if ptr.is_null() {
        return;
    }
    // SAFETY: `ptr` and `len` are those of the boxed slice `output` leaked.
    let mut bytes = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) };
    iamreal_device_checks::wipe(&mut bytes);
}

/// Poseidon2(1, 2). The test below reads it against the second case of
/// `hash_2` in spec/vectors/poseidon2.json; it is written out here because
/// the library reads no file.
const SELF_CHECK_HASH: [u8; 32] = [
    0x03, 0x86, 0x82, 0xaa, 0x1c, 0xb5, 0xae, 0x4e, 0x0a, 0x3f, 0x13, 0xda, 0x43, 0x2a, 0x95, 0xc7,
    0x7c, 0x5c, 0x11, 0x1f, 0x6f, 0x03, 0x0f, 0xaf, 0x9c, 0xad, 0x64, 0x1c, 0xe1, 0xed, 0x73, 0x83,
];

/// Checks that the Barretenberg linked into this library answers and
/// computes the Poseidon2 of spec/scoped-id.md: `IDC_OK`, or
/// `IDC_ERR_INTERNAL`. For an app's start and for build checks; it takes
/// no input.
#[unsafe(no_mangle)]
pub extern "C" fn idc_self_check() -> i32 {
    code(|| {
        let hash = hashes::Barretenberg::new()
            .and_then(|mut bb| bb.poseidon2(&[fe_of_u64(1), fe_of_u64(2)]));
        if hash == Ok(SELF_CHECK_HASH) {
            Ok(())
        } else {
            Err(IDC_ERR_INTERNAL)
        }
    })
}

/// The scope string a card signs for `roster`: 31 bytes in `*out`.
///
/// # Safety
/// `out` is null or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_scope_string(roster: u32, out: *mut IdcBuf) -> i32 {
    output(out, || Ok(scope_string(roster_of(roster)?).to_vec()))
}

/// Reads the list a C function takes: a JSON array of
/// `{"platform":"…","username":"…"}`, the shape of a record's `accounts`
/// (spec/record.md). Each account has exactly these two keys, each once,
/// both strings, the platform a platform ID: a list has one reading. The
/// username is any string; each function says what it accepts.
fn accounts_of(json: &[u8]) -> Result<Vec<roster_rules::Account>, i32> {
    let account = |a: &Json| {
        let a = a.as_object().filter(|a| a.len() == 2)?;
        let platform = a.get("platform")?.as_str()?;
        let username = a.get("username")?.as_str()?;
        is_platform_id(platform.as_bytes()).then(|| roster_rules::Account {
            platform: platform.to_owned(),
            username: username.to_owned(),
        })
    };
    Json::parse(json)
        .as_ref()
        .and_then(Json::as_array)
        .and_then(|list| list.iter().map(account).collect())
        .ok_or(IDC_ERR_INPUT)
}

/// The platform IDs a C function takes as a JSON array of strings, each a
/// platform ID, none twice.
fn platform_ids_of(json: &[u8]) -> Result<Vec<String>, i32> {
    let ids: Vec<String> = Json::parse(json)
        .as_ref()
        .and_then(Json::as_array)
        .and_then(|ids| {
            ids.iter()
                .map(|id| id.as_str().filter(|id| is_platform_id(id.as_bytes())))
                .map(|id| id.map(str::to_owned))
                .collect()
        })
        .ok_or(IDC_ERR_INPUT)?;
    let distinct: std::collections::BTreeSet<&String> = ids.iter().collect();
    if distinct.len() == ids.len() {
        Ok(ids)
    } else {
        Err(IDC_ERR_INPUT)
    }
}

/// The list a card signs: [`accounts_of`], each username 1 or more
/// printable ASCII characters without `"` and `\` (what every format
/// allows at most, spec/scope.md).
fn signed_accounts_of(json: &[u8]) -> Result<Vec<roster_rules::Account>, i32> {
    let list = accounts_of(json)?;
    if list.iter().all(|a| is_any_username(a.username.as_bytes())) {
        Ok(list)
    } else {
        Err(IDC_ERR_INPUT)
    }
}

fn accounts(list: &[roster_rules::Account]) -> Vec<Account<'_>> {
    list.iter()
        .map(|a| Account {
            platform: &a.platform,
            username: &a.username,
        })
        .collect()
}

/// The declaration code (spec/declaration-code.md) of a list of accounts
/// and a challenge, in the scope of `roster`: 31 bytes in `*out`, the
/// second message the card signs.
///
/// `accounts_json` is a JSON array of `{"platform":"…","username":"…"}` in
/// ascending order of `platform`, each platform at most once, each
/// `username` 1 or more printable ASCII characters without `"` and `\`
/// (what every format allows at most, spec/scope.md); `challenge`
/// is the challenge as the server issued it. `IDC_ERR_INPUT` when the list
/// is not that, or the challenge is not in its one spelling.
///
/// # Safety
/// `accounts_json` and `challenge` point to as many bytes as their lengths
/// say; `out` is null or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_declaration_code(
    roster: u32,
    accounts_json: *const u8,
    accounts_json_len: usize,
    challenge: *const u8,
    challenge_len: usize,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        let roster = roster_of(roster)?;
        // SAFETY: the caller's promise.
        let (accounts_json, challenge) = unsafe {
            (
                input(accounts_json, accounts_json_len)?,
                input(challenge, challenge_len)?,
            )
        };
        let list = signed_accounts_of(accounts_json)?;
        parse_challenge(challenge).ok_or(IDC_ERR_INPUT)?;
        let code = declaration_code(
            scope_string(roster),
            &accounts(&list),
            challenge,
            &mut hashes::Sha2,
        )
        .map_err(|_| IDC_ERR_INPUT)?;
        Ok(code.to_vec())
    })
}

/// What a list does on every platform, before the card signs it
/// (spec/list-consequence.md): JSON in `*out`, for the confirmation screen.
///
/// - `platforms_json`: the `platforms` of `GET /api/v1/config`, as the
///   server sent it.
/// - `card_state_json`: the answer of `POST /api/v1/card-state`, as the
///   server sent it.
/// - `known_platforms_json`: the platforms the app has its own definition
///   of (its names, how it writes an account), a JSON array of platform
///   IDs, none twice. Built into the app, never from the server.
/// - `accounts_json`: the cardholder's list for the platforms offered, in
///   the shape of a record's `accounts` (ascending order of platform, each
///   platform at most once), each `username` as typed after the app tidied
///   it. The kept accounts are not in it: the core adds them.
/// - `now`: seconds since 1970-01-01T00:00:00Z by the device's clock; the
///   date is the one in Taiwan.
///
/// The output is one of:
///
/// ```text
/// {"valid":true,"accounts":[…],"rows":[{"platform":"threads","known":true,"kind":"switch","username":"carol","current":"bob","previous":"bob","switches_left":3}],"first_record":false}
/// {"valid":false,"reason":"switch_limit","platform":"threads"}
/// {"valid":false,"reason":"username","platform":"threads"}
/// {"valid":false,"reason":"empty"}
/// ```
///
/// `accounts` is the list the card signs (pass it to
/// [`idc_declaration_code`]); a row and the reasons are those of
/// spec/list-consequence.md, "What the list does". `valid` false is not
/// offered for signing.
///
/// `IDC_ERR_INPUT` when the table or the state cannot be read, when the
/// list names a platform that is not offered or is not in the shape above
/// (`not_offered` in spec/vectors/list-consequence.json: a mistake of the
/// app, but one the core sees only in the bytes), when the known platforms
/// are not in the shape above, or when `now` is outside the years 2000 to
/// 2049 in Taiwan.
///
/// # Safety
/// The four inputs point to as many bytes as their lengths say; `out` is
/// null or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn idc_list_consequence(
    platforms_json: *const u8,
    platforms_json_len: usize,
    card_state_json: *const u8,
    card_state_json_len: usize,
    known_platforms_json: *const u8,
    known_platforms_json_len: usize,
    accounts_json: *const u8,
    accounts_json_len: usize,
    now: i64,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        // SAFETY: the caller's promise.
        let (platforms_json, card_state_json, known_platforms_json, accounts_json) = unsafe {
            (
                input(platforms_json, platforms_json_len)?,
                input(card_state_json, card_state_json_len)?,
                input(known_platforms_json, known_platforms_json_len)?,
                input(accounts_json, accounts_json_len)?,
            )
        };
        let today = Date::in_taiwan(now).ok_or(IDC_ERR_INPUT)?;
        let known = platform_ids_of(known_platforms_json)?;
        let table: Vec<_> = Json::parse(platforms_json)
            .as_ref()
            .and_then(read_platforms)
            .ok_or(IDC_ERR_INPUT)?
            .into_iter()
            .filter(|row| known.iter().any(|id| id == row.id()))
            .collect();
        let (state, offered) = Json::parse(card_state_json)
            .and_then(|state| read_card_state(&state, &table, today))
            .ok_or(IDC_ERR_INPUT)?;
        let list = accounts_of(accounts_json)?;
        let consequence =
            list_consequence(&offered, &state, &list, today).map_err(|_| IDC_ERR_INPUT)?;
        let value = match consequence {
            Consequence::Valid {
                accounts,
                rows,
                first_record,
            } => json!({
                "valid": true,
                "accounts": accounts
                    .iter()
                    .map(|a| json!({"platform": a.platform, "username": a.username}))
                    .collect::<Vec<_>>(),
                "rows": rows
                    .iter()
                    .map(|r| json!({
                        "platform": r.platform,
                        "known": r.known,
                        "kind": r.kind.name(),
                        "username": r.username,
                        "current": r.current,
                        "previous": r.previous,
                        "switches_left": r.switches_left,
                    }))
                    .collect::<Vec<_>>(),
                "first_record": first_record,
            }),
            Consequence::Username { platform } => {
                json!({"valid": false, "reason": "username", "platform": platform})
            }
            Consequence::Invalid(Reason::SwitchLimit { platform }) => {
                json!({"valid": false, "reason": "switch_limit", "platform": platform})
            }
            Consequence::Invalid(reason) => json!({"valid": false, "reason": reason.name()}),
        };
        serde_json::to_vec(&value).map_err(|_| IDC_ERR_INTERNAL)
    })
}

/// The state of a card as the screen of its accounts shows it, before the
/// cardholder changes the list (spec/list-consequence.md, "The card's state,
/// as shown"): JSON in `*out`.
///
/// `platforms_json`, `card_state_json`, `known_platforms_json` and `now`
/// are those of [`idc_list_consequence`], and are read the same way.
///
/// ```text
/// {"last_card_proof":"2026-11-04","days_since":12,"daily_limit":false,
///  "known_platforms":["threads"],
///  "rows":[{"platform":"test-example","known":false,"current":"alice-b"},
///          {"platform":"threads","known":true,"current":"alice","last_declared":"alice",
///           "switch_count":1,"switches_left":4,"correction_today":false}]}
/// ```
///
/// - `last_card_proof`: the date of the card's last valid record, or null.
/// - `days_since`: the days from that date to today; null without one.
/// - `daily_limit`: the card has 3 valid records dated today, so no list
///   can be declared today (spec/roster-rules.md, check 6).
/// - `known_platforms`: the platforms of the table the device knows, in
///   ascending order, offered or not.
/// - `rows`, in ascending order of platform: one for every platform
///   offered (`known` true: the entry's `current`, `last_declared` and
///   `switch_count`, the switches left by the rules, and whether
///   `correction_date` is today, when a change is a correction), and one
///   for every kept account (`known` false: `current`, shown as it is and
///   not changed).
///
/// `IDC_ERR_INPUT` when the table or the state cannot be read, when the
/// known platforms are not a JSON array of platform IDs, none twice, or
/// when `now` is outside the years 2000 to 2049 in Taiwan.
///
/// # Safety
/// The three inputs point to as many bytes as their lengths say; `out` is
/// null or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_card_status(
    platforms_json: *const u8,
    platforms_json_len: usize,
    card_state_json: *const u8,
    card_state_json_len: usize,
    known_platforms_json: *const u8,
    known_platforms_json_len: usize,
    now: i64,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        // SAFETY: the caller's promise.
        let (platforms_json, card_state_json, known_platforms_json) = unsafe {
            (
                input(platforms_json, platforms_json_len)?,
                input(card_state_json, card_state_json_len)?,
                input(known_platforms_json, known_platforms_json_len)?,
            )
        };
        let today = Date::in_taiwan(now).ok_or(IDC_ERR_INPUT)?;
        let known = platform_ids_of(known_platforms_json)?;
        let table: Vec<_> = Json::parse(platforms_json)
            .as_ref()
            .and_then(read_platforms)
            .ok_or(IDC_ERR_INPUT)?
            .into_iter()
            .filter(|row| known.iter().any(|id| id == row.id()))
            .collect();
        let (state, offered) = Json::parse(card_state_json)
            .and_then(|state| read_card_state(&state, &table, today))
            .ok_or(IDC_ERR_INPUT)?;
        let card = &state.card;
        let mut rows: Vec<(&str, serde_json::Value)> = offered
            .iter()
            .map(|row| {
                let slot = card.slots.get(row.id()).cloned().unwrap_or_default();
                let value = json!({
                    "platform": row.id(),
                    "known": true,
                    "current": slot.current,
                    "last_declared": slot.last_declared,
                    "switch_count": slot.switch_count,
                    "switches_left": roster_rules::MAX_SWITCHES - slot.switch_count,
                    "correction_today": slot.correction_date == Some(today),
                });
                (row.id(), value)
            })
            .chain(state.kept.iter().map(|account| {
                let value = json!({
                    "platform": account.platform,
                    "known": false,
                    "current": account.username,
                });
                (account.platform.as_str(), value)
            }))
            .collect();
        rows.sort_by(|a, b| a.0.cmp(b.0));
        let value = json!({
            "last_card_proof": card.last_card_proof.map(|date| date.to_string()),
            "days_since": card
                .last_card_proof
                .map(|date| today.days_since_1970() - date.days_since_1970()),
            "daily_limit": card.last_card_proof == Some(today)
                && card.proofs_on_last_date >= roster_rules::MAX_PER_DATE,
            "known_platforms": table.iter().map(|row| row.id()).collect::<Vec<_>>(),
            "rows": rows.into_iter().map(|(_, row)| row).collect::<Vec<_>>(),
        });
        serde_json::to_vec(&value).map_err(|_| IDC_ERR_INTERNAL)
    })
}

/// The short ID of a scoped ID (spec/scoped-id.md): the first 10
/// characters of its text form, in `*out`. The screens and the address of
/// the card's page write it.
///
/// `scoped_id`: the 52 characters of a scoped ID in its one spelling, as
/// the body of [`idc_session_card_state_request`] has it. `IDC_ERR_INPUT`
/// for anything else.
///
/// # Safety
/// `scoped_id` points to `scoped_id_len` bytes; `out` is null or points to
/// an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_short_id(
    scoped_id: *const u8,
    scoped_id_len: usize,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        // SAFETY: the caller's promise.
        let text = unsafe { input(scoped_id, scoped_id_len) }?;
        parse_scoped_id(text).ok_or(IDC_ERR_INPUT)?;
        let text = std::str::from_utf8(text).map_err(|_| IDC_ERR_INPUT)?;
        Ok(short_id(text).ok_or(IDC_ERR_INPUT)?.as_bytes().to_vec())
    })
}

/// Opens a session for one card proof on `roster` and puts the number
/// that names it in `*out`: never 0. The session checks against MOICA's
/// keys and the files written into the core. Close it with
/// [`idc_session_close`], whatever happened in between.
///
/// # Safety
/// `out` is null or points to a `uint64_t` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_open(roster: u32, out: *mut u64) -> i32 {
    if out.is_null() {
        return IDC_ERR_ARGUMENT;
    }
    // SAFETY: `out` is not null, and the caller's to write.
    unsafe { out.write(0) };
    code(|| {
        let handle = session::open(roster_of(roster)?, session::Trust::built_in());
        // SAFETY: as above.
        unsafe { out.write(handle) };
        Ok(())
    })
}

/// For tests only (the feature `test-issuers`): opens a session as
/// [`idc_session_open`] does, but one that checks certificates and CRLs
/// against the issuer keys given in place of MOICA's. The files it checks
/// are still the ones written into the core.
///
/// `issuers_json` is a JSON array of `{"issuer":"G2","modulus":"<hex>"}`:
/// `issuer` is `G2` or `G3`, each at most once, at least one; `modulus` is
/// the key's RSA modulus, big-endian. `IDC_ERR_INPUT` for anything else.
///
/// The feature adds this function and nothing else: Poseidon2, the tree
/// and the session's own functions stay out of reach, as without it. The
/// library of an app that goes out is built without the feature and has no
/// such function (README.md, "檢查都通過了").
///
/// # Safety
/// `issuers_json` is null or points to `issuers_json_len` bytes that stay
/// unchanged during the call; `out` is null or points to a `uint64_t` the
/// core may write.
#[cfg(feature = "test-issuers")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_testing_session_open(
    roster: u32,
    issuers_json: *const u8,
    issuers_json_len: usize,
    out: *mut u64,
) -> i32 {
    if out.is_null() {
        return IDC_ERR_ARGUMENT;
    }
    // SAFETY: `out` is not null, and the caller's to write.
    unsafe { out.write(0) };
    code(|| {
        // Read here, so that the mark stays in every library that has this function.
        std::hint::black_box(&IDC_TESTING_MARK);
        let roster = roster_of(roster)?;
        // SAFETY: the caller's promise.
        let bytes = unsafe { input(issuers_json, issuers_json_len) }?;
        let issuers = testing_issuers(bytes).ok_or(IDC_ERR_INPUT)?;
        let handle = session::open(
            roster,
            session::Trust {
                issuers,
                artifacts: artifacts::BUILT_IN,
            },
        );
        // SAFETY: as above.
        unsafe { out.write(handle) };
        Ok(())
    })
}

/// Marks a library built with the feature `test-issuers`: the build of an
/// app that goes out fails when its executable holds these bytes
/// (ios/check-app.sh).
#[cfg(feature = "test-issuers")]
#[used]
static IDC_TESTING_MARK: [u8; 39] = *b"iamreal-device-core:testing-issuer-keys";

/// The issuer keys of [`idc_testing_session_open`].
#[cfg(feature = "test-issuers")]
fn testing_issuers(
    bytes: &[u8],
) -> Option<Vec<(iamreal_device_checks::issuers::IssuerName, Vec<u8>)>> {
    use iamreal_device_checks::issuers::IssuerName;
    let json = Json::parse(bytes)?;
    let list = json.as_array()?;
    let mut issuers: Vec<(IssuerName, Vec<u8>)> = Vec::new();
    for entry in list {
        let object = entry.as_object()?;
        if object.len() != 2 {
            return None;
        }
        let name = IssuerName::parse(object.get("issuer")?.as_str()?)?;
        let hex = object.get("modulus")?.as_str()?.as_bytes();
        if hex.is_empty() || hex.len() % 2 != 0 || issuers.iter().any(|(n, _)| *n == name) {
            return None;
        }
        let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        let modulus = hex
            .chunks(2)
            .map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?))
            .collect::<Option<Vec<u8>>>()?;
        issuers.push((name, modulus));
    }
    if issuers.is_empty() {
        return None;
    }
    Some(issuers)
}

/// Closes a session: the certificate, the name on it and everything the
/// core computed from them are overwritten with zeros and released. A
/// number that names no session (0, or one already closed) does nothing.
#[unsafe(no_mangle)]
pub extern "C" fn idc_session_close(session: u64) {
    let _ = code(|| {
        session::close(session);
        Ok(())
    });
}

/// See [`session::add_certificate`].
///
/// # Safety
/// `certificate` points to `certificate_len` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_add_certificate(
    session: u64,
    certificate: *const u8,
    certificate_len: usize,
) -> i32 {
    code(|| {
        // SAFETY: the caller's promise.
        let certificate = unsafe { input(certificate, certificate_len)? };
        session::add_certificate(session, certificate)
    })
}

/// See [`session::check_certificates`].
///
/// # Safety
/// `out` is null or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_check_certificates(
    session: u64,
    now: i64,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || session::check_certificates(session, now))
}

/// See [`session::choose_crl`].
///
/// # Safety
/// `index` points to `index_len` bytes; `out` is null or points to an
/// `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_choose_crl(
    session: u64,
    index: *const u8,
    index_len: usize,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        // SAFETY: the caller's promise.
        let index = unsafe { input(index, index_len)? };
        session::choose_crl(session, index)
    })
}

/// See [`session::check_crl`].
///
/// # Safety
/// `crl`, `config` and `highest` point to as many bytes as their lengths
/// say; `out` is null or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_check_crl(
    session: u64,
    crl: *const u8,
    crl_len: usize,
    config: *const u8,
    config_len: usize,
    highest: *const u8,
    highest_len: usize,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        // SAFETY: the caller's promise.
        let (crl, config, highest) = unsafe {
            (
                input(crl, crl_len)?,
                input(config, config_len)?,
                input(highest, highest_len)?,
            )
        };
        session::check_crl(session, crl, config, highest)
    })
}

/// See [`session::build_tree`].
#[unsafe(no_mangle)]
pub extern "C" fn idc_session_build_tree(session: u64) -> i32 {
    code(|| session::build_tree(session))
}

/// See [`session::check_artifacts`].
///
/// # Safety
/// Each pointer points to as many bytes as its length says.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_check_artifacts(
    session: u64,
    circuit: *const u8,
    circuit_len: usize,
    verification_key: *const u8,
    verification_key_len: usize,
    crs_g1: *const u8,
    crs_g1_len: usize,
    crs_g2: *const u8,
    crs_g2_len: usize,
) -> i32 {
    code(|| {
        // SAFETY: the caller's promise.
        let (circuit, verification_key, crs_g1, crs_g2) = unsafe {
            (
                input(circuit, circuit_len)?,
                input(verification_key, verification_key_len)?,
                input(crs_g1, crs_g1_len)?,
                input(crs_g2, crs_g2_len)?,
            )
        };
        session::check_artifacts(session, circuit, verification_key, crs_g1, crs_g2)
    })
}

/// See [`session::check_date`].
///
/// # Safety
/// `out` is null or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_check_date(session: u64, now: i64, out: *mut IdcBuf) -> i32 {
    output(out, || session::check_date(session, now))
}

/// See [`session::card_state_request`].
///
/// # Safety
/// `scope_signature` points to `scope_signature_len` bytes; `out` is null
/// or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_card_state_request(
    session: u64,
    now: i64,
    scope_signature: *const u8,
    scope_signature_len: usize,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        // SAFETY: the caller's promise.
        let scope_signature = unsafe { input(scope_signature, scope_signature_len)? };
        session::card_state_request(session, now, scope_signature)
    })
}

/// See [`session::records_request`]. It makes the proof: seconds, on as
/// many threads as the device has cores. Call it from a background thread.
///
/// # Safety
/// Each pointer points to as many bytes as its length says; `out` is null
/// or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn idc_session_records_request(
    session: u64,
    circuit: *const u8,
    circuit_len: usize,
    verification_key: *const u8,
    verification_key_len: usize,
    crs_g1: *const u8,
    crs_g1_len: usize,
    crs_g2: *const u8,
    crs_g2_len: usize,
    accounts_json: *const u8,
    accounts_json_len: usize,
    challenge: *const u8,
    challenge_len: usize,
    scope_signature: *const u8,
    scope_signature_len: usize,
    declaration_code_signature: *const u8,
    declaration_code_signature_len: usize,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        // SAFETY: the caller's promise.
        let (files, accounts_json, challenge, scope_signature, declaration_code_signature) = unsafe {
            (
                session::Files {
                    circuit: input(circuit, circuit_len)?,
                    verification_key: input(verification_key, verification_key_len)?,
                    crs_g1: input(crs_g1, crs_g1_len)?,
                    crs_g2: input(crs_g2, crs_g2_len)?,
                },
                input(accounts_json, accounts_json_len)?,
                input(challenge, challenge_len)?,
                input(scope_signature, scope_signature_len)?,
                input(declaration_code_signature, declaration_code_signature_len)?,
            )
        };
        // A session that passed nothing refuses, whatever the list is.
        session::require_passed(session)?;
        let list = signed_accounts_of(accounts_json)?;
        session::records_request(
            session,
            &files,
            &accounts(&list),
            challenge,
            scope_signature,
            declaration_code_signature,
        )
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_hash_of_the_self_check_is_the_one_of_the_vectors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../spec/vectors/poseidon2.json");
        let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let case = &v["hash_2"][1];
        let one_two: Vec<&str> = case["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap())
            .collect();
        assert_eq!(one_two, [format!("0x{:064x}", 1), format!("0x{:064x}", 2)]);
        let written: String = super::SELF_CHECK_HASH
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(format!("0x{written}"), case["hash"].as_str().unwrap());
    }
}
