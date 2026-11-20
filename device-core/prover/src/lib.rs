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
use iamreal_device_checks::declaration_code::{Account, declaration_code};
use iamreal_device_checks::field::fe_of_u64;
use iamreal_device_checks::hash::Poseidon2;
use iamreal_device_checks::scope::{Roster, scope_string};
use iamreal_device_checks::username_format::{is_any_username, is_platform_id};

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

/// One account of the list a C function takes: `{"platform":"…","username":"…"}`,
/// the shape of a record's `accounts` (spec/record.md). Exactly these two
/// keys, each once, both strings: a list has one reading.
struct AccountJson {
    platform: String,
    username: String,
}

impl<'de> serde::Deserialize<'de> for AccountJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Keys;
        impl<'de> serde::de::Visitor<'de> for Keys {
            type Value = AccountJson;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an account")
            }

            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<AccountJson, A::Error> {
                use serde::de::Error;
                let (mut platform, mut username) = (None, None);
                while let Some(key) = map.next_key::<String>()? {
                    let slot = match key.as_str() {
                        "platform" => &mut platform,
                        "username" => &mut username,
                        _ => return Err(A::Error::custom("a key that is not of an account")),
                    };
                    if slot.replace(map.next_value::<String>()?).is_some() {
                        return Err(A::Error::custom("a key twice"));
                    }
                }
                match (platform, username) {
                    (Some(platform), Some(username)) => Ok(AccountJson { platform, username }),
                    _ => Err(A::Error::custom("a key is missing")),
                }
            }
        }
        deserializer.deserialize_map(Keys)
    }
}

/// Reads the JSON array of accounts and checks each value's form.
fn accounts_of(json: &[u8]) -> Result<Vec<AccountJson>, i32> {
    let list: Vec<AccountJson> = serde_json::from_slice(json).map_err(|_| IDC_ERR_INPUT)?;
    let well_formed = |a: &AccountJson| {
        is_platform_id(a.platform.as_bytes()) && is_any_username(a.username.as_bytes())
    };
    if list.iter().all(well_formed) {
        Ok(list)
    } else {
        Err(IDC_ERR_INPUT)
    }
}

fn accounts(list: &[AccountJson]) -> Vec<Account<'_>> {
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
        let list = accounts_of(accounts_json)?;
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
