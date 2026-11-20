//! Which CRL the device takes from the mirror and when it refuses it
//! (spec/device-checks.md, "The CRL"). The index is used only to find the
//! file; everything else the device checks itself.

use crate::crl::{CrlNumber, Unusable, UsableCrl, usable_crl};
use crate::date::Date;
use crate::der::days_from_civil;
use crate::hash::Sha256;
use crate::issuers::IssuerKey;

/// The bound built into the device, in days (ADR-0015).
pub const BUILT_IN_MAX_AGE_DAYS: u64 = 7;

/// `L`: the smaller of the server's `crl_max_age_days` and the built-in 7.
/// The server can make the bound stricter, never looser.
pub fn crl_max_age(server_max_age_days: u64) -> u64 {
    server_max_age_days.min(BUILT_IN_MAX_AGE_DAYS)
}

/// Four fields of one line of the archive index, as text. The other
/// fields are not read.
pub struct IndexLine<'a> {
    pub issuer: &'a str,
    pub crl_number: &'a str,
    pub sha256: &'a str,
    pub root: &'a str,
}

/// The file the device takes: the line's CRL number and the file's
/// SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexChoice {
    pub crl_number: CrlNumber,
    pub sha256: [u8; 32],
}

/// 64 lowercase hex digits as 32 bytes.
fn lowercase_hex_32(text: &str) -> Option<[u8; 32]> {
    let (pairs, []) = text.as_bytes().as_chunks::<2>() else {
        return None;
    };
    if pairs.len() != 32 {
        return None;
    }
    let value = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (byte, pair) in out.iter_mut().zip(pairs) {
        *byte = value(pair[0])? * 16 + value(pair[1])?;
    }
    Some(out)
}

/// The candidate with the highest CRL number among the lines of `issuer`.
/// `None` when there is no candidate, or when two candidates have that
/// number and different files.
pub fn choose_from_index<'a>(
    lines: impl Iterator<Item = IndexLine<'a>>,
    issuer: &str,
) -> Option<IndexChoice> {
    let mut best: Option<IndexChoice> = None;
    let mut tie = false;
    for line in lines {
        if line.issuer != issuer {
            continue;
        }
        // A line for a file that is not usable has `-` and a reason code
        // as its root. The value of a root is not read.
        if lowercase_hex_32(line.root).is_none() {
            continue;
        }
        let (Some(crl_number), Some(sha256)) = (
            CrlNumber::from_decimal(line.crl_number),
            lowercase_hex_32(line.sha256),
        ) else {
            continue;
        };
        match &best {
            Some(b) if crl_number < b.crl_number => {}
            Some(b) if crl_number == b.crl_number => tie |= sha256 != b.sha256,
            _ => {
                best = Some(IndexChoice { crl_number, sha256 });
                tie = false;
            }
        }
    }
    best.filter(|_| !tie)
}

/// Why the device does not use the file: the reason codes of the
/// specification, with the details it reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CrlProblem {
    /// The file's SHA-256 is not the one the index gave.
    Hash,
    /// Not usable under the issuer key.
    Unusable(Unusable),
    /// A lower CRL number than this device has used for the issuer.
    Rollback {
        crl_number: CrlNumber,
        highest: CrlNumber,
    },
    /// Older than `L` days.
    Stale { days: i64, max_age_days: u64 },
}

impl CrlProblem {
    pub fn code(&self) -> &'static str {
        match self {
            CrlProblem::Hash => "crl_hash",
            CrlProblem::Unusable(_) => "crl_unusable",
            CrlProblem::Rollback { .. } => "crl_rollback",
            CrlProblem::Stale { .. } => "crl_stale",
        }
    }
}

/// The number of days from 1970-01-01 to `date`.
fn day_of(date: Date) -> i64 {
    days_from_civil(
        i64::from(date.year()),
        i64::from(date.month()),
        i64::from(date.day()),
    )
}

/// Checks the file the device downloaded, in the order of the
/// specification: its SHA-256, whether it is usable under `issuer` (only
/// that key is tried), its CRL number against the highest this device
/// remembers, and its age against `max_age_days` (`L`).
///
/// When it passes, the caller remembers the higher of the CRL's number and
/// `highest`; when it fails, the remembered number does not change.
pub fn check_crl_file(
    file: &[u8],
    chosen_sha256: &[u8; 32],
    issuer: &IssuerKey<'_>,
    today: Date,
    max_age_days: u64,
    highest: Option<&CrlNumber>,
    sha256: &mut impl Sha256,
) -> Result<UsableCrl, CrlProblem> {
    if sha256.sha256(file) != *chosen_sha256 {
        return Err(CrlProblem::Hash);
    }
    let crl = usable_crl(file, issuer.modulus, sha256).map_err(CrlProblem::Unusable)?;
    if let Some(highest) = highest.filter(|highest| crl.crl_number < **highest) {
        return Err(CrlProblem::Rollback {
            crl_number: crl.crl_number,
            highest: highest.clone(),
        });
    }
    // A CRL date after today is not stale.
    let days = day_of(today) - crl.crl_day();
    if days > 0 && days.unsigned_abs() > max_age_days {
        return Err(CrlProblem::Stale { days, max_age_days });
    }
    Ok(crl)
}
