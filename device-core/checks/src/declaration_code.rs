//! The declaration code (spec/declaration-code.md): the 31 bytes the card
//! signs the second time. It states the card's whole list of accounts, at
//! most one on each platform, in ascending order of the platform ID.

use crate::base32;
use crate::hash::Sha256;

pub const DECLARATION_CODE_LENGTH: usize = 31;

const VERSION_TAG: &[u8] = b"iamreal-declaration-v1";

/// One account of a record's list (spec/record.md, "The account list").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Account<'a> {
    pub platform: &'a str,
    pub username: &'a str,
}

/// Why a preimage is not built: two different inputs would give one text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreimageError {
    /// A scope string, platform ID, username or challenge contains a line feed.
    LineFeed,
    /// A platform ID contains `:`.
    ColonInPlatform,
    /// The list is not in ascending order of platform, or names one twice.
    NotAscending,
}

/// The text hashed: the tag, the scope string, one line per account, the
/// challenge, separated by LF, without a trailing LF.
pub fn declaration_preimage(
    scope_string: &[u8],
    accounts: &[Account<'_>],
    challenge: &[u8],
) -> Result<Vec<u8>, PreimageError> {
    let has_lf = |part: &[u8]| part.contains(&b'\n');
    if has_lf(scope_string) || has_lf(challenge) {
        return Err(PreimageError::LineFeed);
    }
    for (i, a) in accounts.iter().enumerate() {
        if has_lf(a.platform.as_bytes()) || has_lf(a.username.as_bytes()) {
            return Err(PreimageError::LineFeed);
        }
        if a.platform.contains(':') {
            return Err(PreimageError::ColonInPlatform);
        }
        // Strings compare by their bytes, as every list of the specification is
        // ordered. A platform ID is ASCII (spec/scope.md), where bytes and
        // UTF-16 code units, which protocol/ compares, give the same order.
        if i > 0 && accounts[i - 1].platform >= a.platform {
            return Err(PreimageError::NotAscending);
        }
    }
    let mut text = Vec::new();
    text.extend_from_slice(VERSION_TAG);
    text.push(b'\n');
    text.extend_from_slice(scope_string);
    text.push(b'\n');
    for a in accounts {
        text.extend_from_slice(a.platform.as_bytes());
        text.push(b':');
        text.extend_from_slice(a.username.as_bytes());
        text.push(b'\n');
    }
    text.extend_from_slice(challenge);
    Ok(text)
}

/// `D` followed by the first 30 base32 characters of SHA-256(preimage).
pub fn declaration_code(
    scope_string: &[u8],
    accounts: &[Account<'_>],
    challenge: &[u8],
    hash: &mut impl Sha256,
) -> Result<[u8; DECLARATION_CODE_LENGTH], PreimageError> {
    let digest = hash.sha256(&declaration_preimage(scope_string, accounts, challenge)?);
    let mut code = [b'D'; DECLARATION_CODE_LENGTH];
    code[1..].copy_from_slice(&base32::encode(&digest).as_bytes()[..30]);
    Ok(code)
}
