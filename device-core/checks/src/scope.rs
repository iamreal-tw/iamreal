//! The scope string (spec/scope.md, ADR-0007, ADR-0017). The public roster
//! is one scope, shared by every public platform. The device signs the
//! scope string of its roster from the table below and never takes one
//! from a server response (ADR-0016, ADR-0035).

/// Which roster: the production one, or a test roster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Roster {
    Production,
    Test,
}

pub const SCOPE_STRING_LENGTH: usize = 31;

/// The open scope string of each roster (spec/scope.md, "Accepted scopes").
const PRODUCTION: &[u8; SCOPE_STRING_LENGTH] = b"iamreal:public:0_______________";
const TEST: &[u8; SCOPE_STRING_LENGTH] = b"iamreal-test:public:0__________";

/// The scope string a card signs for `roster`.
pub fn scope_string(roster: Roster) -> &'static [u8; SCOPE_STRING_LENGTH] {
    match roster {
        Roster::Production => PRODUCTION,
        Roster::Test => TEST,
    }
}

/// Whether `roster` accepts `scope_string`, in its exact spelling.
pub fn accepts(roster: Roster, scope_string: &[u8]) -> bool {
    self::scope_string(roster) == scope_string
}
