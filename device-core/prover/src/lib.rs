//! The half of `device-core/` that links Barretenberg (ADR-0034), and the C
//! functions the Android and iOS apps call. The functions are declared in
//! `include/iamreal_device_core.h`; the conventions they follow are in
//! `device-core/README.md`, "C 函式的慣例".
//!
//! Nothing here does I/O: bytes in, bytes out. No function takes a PIN.
//!
//! What is `pub` in Rust and not `extern "C"` ([`hashes`]) is for this
//! crate's tests. The apps reach only the C functions: Poseidon2 is not
//! one of them, so an app cannot compute a scoped ID by itself (ADR-0034,
//! "核心擋住的順序").

pub mod hashes;
mod json;
mod server_state;

use std::panic::{AssertUnwindSafe, catch_unwind};

use iamreal_device_checks::challenge::parse_challenge;
use iamreal_device_checks::date::Date;
use iamreal_device_checks::declaration_code::{Account, declaration_code};
use iamreal_device_checks::field::fe_of_u64;
use iamreal_device_checks::hash::Poseidon2;
use iamreal_device_checks::list_consequence::{Consequence, list_consequence};
use iamreal_device_checks::roster_rules::{self, Reason};
use iamreal_device_checks::scope::{Roster, scope_string};
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

/// Runs `f` and puts its bytes in `*out`. `*out` is empty unless the
/// result is `IDC_OK`. A panic stops here: it never crosses into C.
fn output(out: *mut IdcBuf, f: impl FnOnce() -> Result<Vec<u8>, i32>) -> i32 {
    if out.is_null() {
        return IDC_ERR_ARGUMENT;
    }
    // SAFETY: `out` is not null, and the caller gives a pointer to an `idc_buf` it may write.
    unsafe { out.write(EMPTY) };
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(bytes)) => {
            let boxed = bytes.into_boxed_slice();
            let len = boxed.len();
            let ptr = Box::into_raw(boxed).cast::<u8>();
            // SAFETY: as above.
            unsafe { out.write(IdcBuf { ptr, len }) };
            IDC_OK
        }
        Ok(Err(code)) => code,
        Err(payload) => {
            // Dropping what a panic carried could panic again.
            std::mem::forget(payload);
            IDC_ERR_INTERNAL
        }
    }
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
    let check = || hashes::Barretenberg::new()?.poseidon2(&[fe_of_u64(1), fe_of_u64(2)]);
    match catch_unwind(check) {
        Ok(Ok(hash)) if hash == SELF_CHECK_HASH => IDC_OK,
        Ok(_) => IDC_ERR_INTERNAL,
        Err(payload) => {
            // As in `output`.
            std::mem::forget(payload);
            IDC_ERR_INTERNAL
        }
    }
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
/// both strings, the platform a platform ID and the username one any
/// platform could have: a list has one reading.
fn accounts_of(json: &[u8]) -> Result<Vec<roster_rules::Account>, i32> {
    let account = |a: &Json| {
        let a = a.as_object().filter(|a| a.len() == 2)?;
        let platform = a.get("platform")?.as_str()?;
        let username = a.get("username")?.as_str()?;
        (is_platform_id(platform.as_bytes()) && is_any_username(username.as_bytes())).then(|| {
            roster_rules::Account {
                platform: platform.to_owned(),
                username: username.to_owned(),
            }
        })
    };
    Json::parse(json)
        .as_ref()
        .and_then(Json::as_array)
        .and_then(|list| list.iter().map(account).collect())
        .ok_or(IDC_ERR_INPUT)
}

/// The declaration code (spec/declaration-code.md) of a list of accounts
/// and a challenge, in the scope of `roster`: 31 bytes in `*out`, the
/// second message the card signs.
///
/// `accounts_json` is a JSON array of `{"platform":"…","username":"…"}` in
/// ascending order of `platform`, each platform at most once; `challenge`
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
        let list = accounts_of(accounts_json)?;
        let accounts: Vec<Account<'_>> = list
            .iter()
            .map(|a| Account {
                platform: &a.platform,
                username: &a.username,
            })
            .collect();
        parse_challenge(challenge).ok_or(IDC_ERR_INPUT)?;
        let code = declaration_code(
            scope_string(roster),
            &accounts,
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
/// - `accounts_json`: the cardholder's list for the platforms offered, in
///   the shape of a record's `accounts` (ascending order of platform, each
///   platform at most once). The kept accounts are not in it: the core adds
///   them.
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
/// list names a platform that is not offered or is not in the shape above,
/// or when `now` is outside the years 2000 to 2049 in Taiwan.
///
/// # Safety
/// The three inputs point to as many bytes as their lengths say; `out` is
/// null or points to an `idc_buf` the core may write.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn idc_list_consequence(
    platforms_json: *const u8,
    platforms_json_len: usize,
    card_state_json: *const u8,
    card_state_json_len: usize,
    accounts_json: *const u8,
    accounts_json_len: usize,
    now: i64,
    out: *mut IdcBuf,
) -> i32 {
    output(out, || {
        // SAFETY: the caller's promise.
        let (platforms_json, card_state_json, accounts_json) = unsafe {
            (
                input(platforms_json, platforms_json_len)?,
                input(card_state_json, card_state_json_len)?,
                input(accounts_json, accounts_json_len)?,
            )
        };
        let today = Date::in_taiwan(now).ok_or(IDC_ERR_INPUT)?;
        let table = Json::parse(platforms_json)
            .as_ref()
            .and_then(read_platforms)
            .ok_or(IDC_ERR_INPUT)?;
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
