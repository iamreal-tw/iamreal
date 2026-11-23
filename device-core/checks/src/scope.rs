//! The scope string (spec/scope.md, ADR-0007, ADR-0017). The public proof log
//! is one scope, shared by every public platform. The device signs the
//! scope string of its proof log from the table below and never takes one
//! from a server response (ADR-0016, ADR-0035).

/// Which proof log: the production one, or a test log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofLog {
    Production,
    Test,
}

pub const SCOPE_STRING_LENGTH: usize = 31;

/// The open scope string of each proof log (spec/scope.md, "Accepted scopes").
const PRODUCTION: &[u8; SCOPE_STRING_LENGTH] = b"iamreal:public:0_______________";
const TEST: &[u8; SCOPE_STRING_LENGTH] = b"iamreal-test:public:0__________";

/// The scope string a card signs for `proof_log`.
pub fn scope_string(proof_log: ProofLog) -> &'static [u8; SCOPE_STRING_LENGTH] {
    match proof_log {
        ProofLog::Production => PRODUCTION,
        ProofLog::Test => TEST,
    }
}

/// Whether `proof_log` accepts `scope_string`, in its exact spelling.
pub fn accepts(proof_log: ProofLog, scope_string: &[u8]) -> bool {
    self::scope_string(proof_log) == scope_string
}
