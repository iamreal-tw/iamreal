//! Calendar dates as the specification compares them. Taiwan is UTC+8
//! without daylight saving time.

/// A date that exists, with a year from 2000 to 2049: the years a
/// challenge and `current_time` can carry (spec/challenge.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Date {
    year: u16,
    month: u8,
    day: u8,
}

const TAIWAN_OFFSET_SECONDS: i64 = 8 * 3600;
const SECONDS_PER_DAY: i64 = 86_400;

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// The number of days of a month of the Gregorian calendar.
pub fn days_in_month(year: i64, month: i64) -> i64 {
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

impl Date {
    /// The date, or `None` if it does not exist or its year is outside
    /// 2000 to 2049.
    pub fn new(year: u16, month: u8, day: u8) -> Option<Date> {
        let exists = (2000..=2049).contains(&year)
            && (1..=12).contains(&month)
            && day >= 1
            && i64::from(day) <= days_in_month(i64::from(year), i64::from(month));
        exists.then_some(Date { year, month, day })
    }

    /// Reads `YYYY-MM-DD`, the whole value: nothing before or after.
    pub fn parse(text: &[u8]) -> Option<Date> {
        if text.len() != 10 || text[4] != b'-' || text[7] != b'-' {
            return None;
        }
        let number = |digits: &[u8]| -> Option<u16> {
            digits.iter().try_fold(0u16, |n, c| {
                c.is_ascii_digit().then(|| n * 10 + u16::from(c - b'0'))
            })
        };
        let year = number(&text[0..4])?;
        let month = number(&text[5..7])?;
        let day = number(&text[8..10])?;
        Date::new(year, u8::try_from(month).ok()?, u8::try_from(day).ok()?)
    }

    /// Today's date in Taiwan for an absolute time, in seconds since
    /// 1970-01-01T00:00:00Z. The time zone set on the device is not used.
    /// `None` when the year is outside 2000 to 2049.
    pub fn in_taiwan(epoch_seconds: i64) -> Option<Date> {
        let days = epoch_seconds
            .checked_add(TAIWAN_OFFSET_SECONDS)?
            .div_euclid(SECONDS_PER_DAY);
        // 2000-01-01 is day 10957; 2050-01-01 is day 29220.
        if !(10_957..29_220).contains(&days) {
            return None;
        }
        let mut left = (days - 10_957) as u32;
        let mut year = 2000u16;
        loop {
            let length = if year.is_multiple_of(4) { 366 } else { 365 };
            if left < length {
                break;
            }
            left -= length;
            year += 1;
        }
        let mut month = 1u8;
        loop {
            let length = days_in_month(i64::from(year), i64::from(month)) as u32;
            if left < length {
                break;
            }
            left -= length;
            month += 1;
        }
        Date::new(year, month, left as u8 + 1)
    }

    /// The number of days from 1970-01-01 to this date.
    pub fn days_since_1970(&self) -> i64 {
        days_from_civil(
            i64::from(self.year),
            i64::from(self.month),
            i64::from(self.day),
        )
    }

    pub fn year(&self) -> u16 {
        self.year
    }

    pub fn month(&self) -> u8 {
        self.month
    }

    pub fn day(&self) -> u8 {
        self.day
    }
}

/// `YYYY-MM-DD`.
impl std::fmt::Display for Date {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
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
