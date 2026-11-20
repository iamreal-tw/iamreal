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

fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        // Every fourth year from 2000 to 2049 is a leap year, 2000 included.
        _ if year.is_multiple_of(4) => 29,
        _ => 28,
    }
}

impl Date {
    /// The date, or `None` if it does not exist or its year is outside
    /// 2000 to 2049.
    pub fn new(year: u16, month: u8, day: u8) -> Option<Date> {
        let exists = (2000..=2049).contains(&year)
            && (1..=12).contains(&month)
            && day >= 1
            && day <= days_in_month(year, month);
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
            let length = u32::from(days_in_month(year, month));
            if left < length {
                break;
            }
            left -= length;
            month += 1;
        }
        Date::new(year, month, left as u8 + 1)
    }

    /// The number of days from 2000-01-01 to this date: dates are
    /// compared and counted apart by it (spec/roster-rules.md counts days).
    pub fn day_number(&self) -> i32 {
        let years = (2000..self.year)
            .map(|y| if y.is_multiple_of(4) { 366 } else { 365 })
            .sum::<i32>();
        let months = (1..self.month)
            .map(|m| i32::from(days_in_month(self.year, m)))
            .sum::<i32>();
        years + months + i32::from(self.day) - 1
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
