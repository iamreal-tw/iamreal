//! The `username` format of a platform and the platform ID (spec/scope.md,
//! "Platforms"). The device gets each platform's format from the server as
//! a string and reads its one form itself, one character class followed by
//! one length range, `[…]{m,n}`; it never hands a server's string to a
//! regular expression engine. A format not in that form is a row the
//! device cannot read.
//!
//! In the class, `x-y` is a range and any other character stands for
//! itself (so a `-` first or last is itself). What spec/scope.md says no
//! format allows makes the format unreadable: `"`, `\`, a control
//! character, a non-ASCII character. A class that starts with `^` or holds
//! `[` or `]` is not read either: a regular expression engine would read
//! it otherwise.

/// A format that was read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsernameFormat {
    allowed: [bool; 128],
    min: usize,
    max: usize,
}

/// A decimal number without leading zeros and with at most 9 digits.
fn decimal(s: &[u8]) -> Option<usize> {
    if s.is_empty() || s.len() > 9 || (s.len() > 1 && s[0] == b'0') {
        return None;
    }
    s.iter().try_fold(0usize, |n, c| {
        c.is_ascii_digit().then(|| n * 10 + usize::from(c - b'0'))
    })
}

impl UsernameFormat {
    /// Reads `[…]{m,n}`; `None` if `text` is not in that form, or allows a
    /// character no format may.
    pub fn parse(text: &[u8]) -> Option<UsernameFormat> {
        if text.len() < 6 || text.len() > 200 || text.iter().any(|c| !(0x21..=0x7e).contains(c)) {
            return None;
        }
        if text[0] != b'[' {
            return None;
        }
        let close = text.iter().position(|c| *c == b']')?;
        let class = &text[1..close];
        let tail = &text[close + 1..];
        if class.is_empty() || class[0] == b'^' || class.contains(&b'[') {
            return None;
        }
        if tail.len() < 2 || tail[0] != b'{' || tail[tail.len() - 1] != b'}' {
            return None;
        }
        let mut range = tail[1..tail.len() - 1].split(|c| *c == b',');
        let min = decimal(range.next()?)?;
        let max = decimal(range.next()?)?;
        if range.next().is_some() || min < 1 || max < min {
            return None;
        }

        let mut allowed = [false; 128];
        let mut i = 0;
        while i < class.len() {
            let a = class[i];
            if i + 2 < class.len() && class[i + 1] == b'-' {
                let b = class[i + 2];
                if b < a {
                    return None;
                }
                for c in a..=b {
                    allowed[usize::from(c)] = true;
                }
                i += 3;
            } else {
                allowed[usize::from(a)] = true;
                i += 1;
            }
        }
        // spec/scope.md: no format allows `"`, `\`, a control character (nor, here, a space).
        if allowed[0x22] || allowed[0x5c] || allowed[0x7f] || allowed[..=0x20].contains(&true) {
            return None;
        }
        Some(UsernameFormat { allowed, min, max })
    }

    /// Whether `username` is in the format, as a whole value.
    pub fn accepts(&self, username: &[u8]) -> bool {
        (self.min..=self.max).contains(&username.len())
            && username
                .iter()
                .all(|c| *c < 128 && self.allowed[usize::from(*c)])
    }

    /// The least number of characters.
    pub fn min(&self) -> usize {
        self.min
    }

    /// The greatest number of characters.
    pub fn max(&self) -> usize {
        self.max
    }
}

/// A platform ID: 1 to 21 characters of a-z, 0-9, `-` (spec/scope.md).
pub fn is_platform_id(s: &[u8]) -> bool {
    (1..=21).contains(&s.len())
        && s.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// What every `username` satisfies, whatever its platform's format: 1 or
/// more printable ASCII characters without `"` and `\`. The only check the
/// device can make of an account on a platform it does not know, which it
/// keeps in the list as it is (docs/api/card-proof.md, card-state).
pub fn is_any_username(s: &[u8]) -> bool {
    !s.is_empty()
        && s.iter()
            .all(|c| (0x20..=0x7e).contains(c) && *c != b'"' && *c != b'\\')
}
