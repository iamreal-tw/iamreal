//! A strict DER reader (spec/device-checks.md, "DER"): one-byte tags,
//! definite lengths in their shortest form, nothing running past the end
//! of the element that contains it. Enough for certificates and CRLs.

/// The bytes are not DER as this reader accepts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotDer;

pub const INTEGER: u8 = 0x02;
pub const BIT_STRING: u8 = 0x03;
pub const OCTET_STRING: u8 = 0x04;
pub const BOOLEAN: u8 = 0x01;
pub const OID: u8 = 0x06;
pub const UTC_TIME: u8 = 0x17;
pub const GENERALIZED_TIME: u8 = 0x18;
pub const BMP_STRING: u8 = 0x1e;
pub const SEQUENCE: u8 = 0x30;

/// One element: its tag and where it lies in the bytes it was read from.
#[derive(Debug, Clone, Copy)]
pub struct Tlv {
    pub tag: u8,
    /// Offset of the element's first byte (its tag).
    pub start: usize,
    /// Offset of the first content byte.
    pub content_start: usize,
    /// Offset just past the element.
    pub end: usize,
}

impl Tlv {
    pub fn content<'a>(&self, der: &'a [u8]) -> &'a [u8] {
        &der[self.content_start..self.end]
    }

    /// The whole element: tag, length and content.
    pub fn whole<'a>(&self, der: &'a [u8]) -> &'a [u8] {
        &der[self.start..self.end]
    }
}

/// Reads the element at `pos`, which must end at or before `limit`
/// (`limit` is at most `der.len()`).
pub fn read_tlv(der: &[u8], pos: usize, limit: usize) -> Result<Tlv, NotDer> {
    let limit = limit.min(der.len());
    if limit < 2 || pos > limit - 2 {
        return Err(NotDer);
    }
    let tag = der[pos];
    if tag & 0x1f == 0x1f {
        return Err(NotDer);
    }
    let first = der[pos + 1];
    let mut content_start = pos + 2;
    let mut length = usize::from(first);
    if first & 0x80 != 0 {
        let n = usize::from(first & 0x7f);
        // No indefinite length, at most 4 length bytes, no leading zero,
        // and the long form only for 128 or more.
        if n == 0 || n > 4 || n > limit - content_start || der[content_start] == 0 {
            return Err(NotDer);
        }
        length = 0;
        for b in &der[content_start..content_start + n] {
            length = length.checked_mul(256).ok_or(NotDer)? + usize::from(*b);
        }
        if length < 0x80 {
            return Err(NotDer);
        }
        content_start += n;
    }
    if length > limit - content_start {
        return Err(NotDer);
    }
    Ok(Tlv {
        tag,
        start: pos,
        content_start,
        end: content_start + length,
    })
}

/// The elements inside a constructed element, in order.
pub struct Children<'a> {
    der: &'a [u8],
    pos: usize,
    end: usize,
}

pub fn children<'a>(der: &'a [u8], parent: &Tlv) -> Children<'a> {
    Children {
        der,
        pos: parent.content_start,
        end: parent.end,
    }
}

impl Iterator for Children<'_> {
    type Item = Result<Tlv, NotDer>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.end {
            return None;
        }
        let item = read_tlv(self.der, self.pos, self.end);
        match &item {
            Ok(t) => self.pos = t.end,
            // Nothing can be read after an element that is not DER.
            Err(NotDer) => self.pos = self.end,
        }
        Some(item)
    }
}

/// All the elements inside a constructed element.
pub fn all_children(der: &[u8], parent: &Tlv) -> Result<Vec<Tlv>, NotDer> {
    children(der, parent).collect()
}

/// Whether an OID's content bytes are well formed: not empty, every arc
/// in its shortest form, the last arc complete. Two well-formed OIDs are
/// the same OID exactly when their bytes are the same.
pub fn is_oid(bytes: &[u8]) -> bool {
    let Some(last) = bytes.last() else {
        return false;
    };
    let mut at_start_of_arc = true;
    for b in bytes {
        if at_start_of_arc && *b == 0x80 {
            return false;
        }
        at_start_of_arc = b & 0x80 == 0;
    }
    last & 0x80 == 0
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap(year) => 29,
        _ => 28,
    }
}

/// The number of days from 1970-01-01 to a date of the Gregorian calendar.
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    // Years start in March, so that the leap day is the last day of one.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let year_of_era = y.rem_euclid(400);
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date, as (year, month, day), of a number of days from 1970-01-01.
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A UTCTime `YYMMDDHHMMSSZ` (years 50 to 99 are 19xx) or a
/// GeneralizedTime `YYYYMMDDHHMMSSZ`, as seconds since 1970-01-01T00:00:00Z.
/// Only these two spellings, of a time that exists; a GeneralizedTime
/// before the year 100 is not read, as on the web page.
pub fn read_time(der: &[u8], t: &Tlv) -> Result<i64, NotDer> {
    let s = t.content(der);
    let year_digits = match (t.tag, s.len()) {
        (UTC_TIME, 13) => 2,
        (GENERALIZED_TIME, 15) => 4,
        _ => return Err(NotDer),
    };
    let (digits, zone) = s.split_at(s.len() - 1);
    if zone != b"Z" || !digits.iter().all(u8::is_ascii_digit) {
        return Err(NotDer);
    }
    let number = |range: std::ops::Range<usize>| -> i64 {
        digits[range]
            .iter()
            .fold(0, |n, c| n * 10 + i64::from(c - b'0'))
    };
    let mut year = number(0..year_digits);
    if year_digits == 2 {
        year += if year >= 50 { 1900 } else { 2000 };
    }
    let field = |i: usize| number(year_digits + 2 * i..year_digits + 2 * i + 2);
    let (month, day, hour, minute, second) = (field(0), field(1), field(2), field(3), field(4));
    let exists = year >= 100
        && (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
        && hour <= 23
        && minute <= 59
        && second <= 59;
    if !exists {
        return Err(NotDer);
    }
    Ok(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_and_dates_agree() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2000, 1, 1), 10_957);
        assert_eq!(days_from_civil(2026, 11, 16), 20_773);
        for days in [-800_000, -1, 0, 59, 60, 10_957, 11_016, 20_773, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }
}
