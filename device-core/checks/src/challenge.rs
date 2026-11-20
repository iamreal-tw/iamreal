//! The challenge (spec/challenge.md): its one spelling, its date, and
//! `current_time`.

use crate::base32;
use crate::date::Date;

pub const CHALLENGE_LENGTH: usize = 37;

/// The challenge's date, or `None` if the bytes are not a challenge in its
/// one spelling. The whole value is read: no whitespace, no line feed.
pub fn parse_challenge(challenge: &[u8]) -> Option<Date> {
    if challenge.len() != CHALLENGE_LENGTH || challenge[10] != b'.' {
        return None;
    }
    // 16 random bytes: 26 characters, the padding bits of the last one zero.
    base32::decode_strict(&challenge[11..], 16)?;
    Date::parse(&challenge[..10])
}

/// `current_time` for a date: the decimal integer `YYMMDD155959`, the last
/// second of that date in Taiwan, written in UTC.
pub fn current_time(date: Date) -> u64 {
    u64::from(date.year() % 100) * 10_000_000_000
        + u64::from(date.month()) * 100_000_000
        + u64::from(date.day()) * 1_000_000
        + 155_959
}
