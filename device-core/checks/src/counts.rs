//! The counts (spec/counts.md; ADR-0032, ADR-0039): the table every value
//! of a count is chosen from, the one reading that says whether a count is
//! taken, how long a timed step took as a code of the table, and when the
//! card proof device ID is replaced. The
//! server reads what it receives with the same rules (`protocol/`); the two
//! apps build what they send here, so a count the server would drop is not
//! sent.
//!
//! A count holds nothing but what is here: codes of the table, random IDs,
//! and four values checked by their format (a short ID, version numbers, a
//! card reader's name, a phone's model). No time, no account, no scoped ID,
//! nothing read from a card, a certificate or a CRL, and no text of an
//! error.

use crate::date::Date;

/// A client of the table (GLOSSARY, "client").
pub const CLIENTS: &[&str] = &["web", "android", "ios"];

const ALL: &[&str] = &["web", "android", "ios"];
const WEB: &[&str] = &["web"];
const APPS: &[&str] = &["android", "ios"];

/// What a count says happened.
pub const EVENTS: &[&str] = &["page", "step", "stop", "retry", "action", "duration"];

/// The kinds of visitors' pages.
pub const PAGES: &[&str] = &[
    "home",
    "card",
    "account",
    "proof_log",
    "faq",
    "verify",
    "check",
    "prepare",
    "privacy",
    "hang",
];

/// A code of the table and the clients it is for.
pub type Code = (&'static str, &'static [&'static str]);

/// The steps of a card proof, in the order a card proof reaches them.
pub const STEPS: &[Code] = &[
    ("open", ALL),
    ("read", ALL),
    ("component", WEB),
    ("certificates", ALL),
    ("certificate", ALL),
    ("config", ALL),
    ("circuit", ALL),
    ("engine", ALL),
    ("crl", ALL),
    ("tree", ALL),
    ("checked", ALL),
    ("pin", ALL),
    ("scope_signed", ALL),
    ("state", ALL),
    ("chosen", ALL),
    ("confirmed", ALL),
    ("challenge", ALL),
    ("code_signed", ALL),
    ("proved", ALL),
    ("done", ALL),
];

/// Why a card proof stopped (`stop`), or why a step must be tried again (`retry`).
pub const REASONS: &[Code] = &[
    ("component_unreachable", WEB),
    ("no_reader", WEB),
    ("no_card", WEB),
    ("popup_blocked", WEB),
    ("nfc_off", APPS),
    ("no_nfc", APPS),
    ("no_tap", APPS),
    ("tap_cancelled", APPS),
    ("other_card", APPS),
    ("pin_maybe_received", APPS),
    ("channel", APPS),
    ("first_generation", APPS),
    ("pin_incorrect", ALL),
    ("card_locked", ALL),
    ("card_error", ALL),
    ("card_signature", ALL),
    ("no_certificate", ALL),
    ("cert_expired", ALL),
    ("cert_not_yet_valid", ALL),
    ("cert_not_citizen_primary", ALL),
    ("cert_unsupported_format", ALL),
    ("cert_unknown_issuer", ALL),
    ("cert_ambiguous", ALL),
    ("crl_unavailable", ALL),
    ("crl_hash", ALL),
    ("crl_unusable", ALL),
    ("crl_rollback", ALL),
    ("crl_stale", ALL),
    ("revoked", ALL),
    ("artifact", ALL),
    ("engine", ALL),
    ("proof_check", ALL),
    ("challenge_malformed", ALL),
    ("challenge_not_today", ALL),
    ("date_changed", ALL),
    ("idle", ALL),
    ("state", ALL),
    ("app_too_old", APPS),
    ("clock", APPS),
    ("username", ALL),
    ("blocked_switch_limit", ALL),
    ("blocked_empty", ALL),
    ("blocked_daily_limit", ALL),
    ("server_network", ALL),
    ("server_malformed_response", ALL),
    ("server_paused", ALL),
    ("server_busy", ALL),
    ("server_rate_limited", ALL),
    ("server_internal", ALL),
    ("server_crl_stale", ALL),
    ("server_challenge_unknown", ALL),
    ("server_challenge_used", ALL),
    ("server_challenge_attempts", ALL),
    ("server_proof", ALL),
    ("server_root", ALL),
    ("server_date_order", ALL),
    ("server_empty", ALL),
    ("server_switch_limit", ALL),
    ("server_daily_limit", ALL),
    ("server_switch_restricted", ALL),
    ("server_malformed", ALL),
    ("server_scope", ALL),
    ("server_platform", ALL),
    ("server_other", ALL),
];

/// The actions of a card proof.
pub const CARD_PROOF_ACTIONS: &[Code] = &[("tap_dropped", APPS), ("resubmit", ALL)];

/// The actions of a visitor.
pub const VISITOR_ACTIONS: &[Code] = &[
    ("start_card_proof", WEB),
    ("download_app_android", WEB),
    ("download_app_ios", WEB),
    ("copy_proof_link", WEB),
];

/// Which tap of an app's card proof a card left during.
pub const TAPS: &[&str] = &["1", "2", "3"];

/// The steps whose time is sent.
pub const TIMED_STEPS: &[Code] = &[("crl", ALL), ("tree", ALL), ("proved", ALL)];

/// How long a timed step took.
pub const DURATIONS: &[&str] = &[
    "lt_1s", "1s_3s", "3s_10s", "10s_30s", "30s_60s", "1m_3m", "gt_3m",
];

/// Where each range of [`DURATIONS`] but the last ends, in milliseconds.
const DURATION_ENDS: [u64; 6] = [1_000, 3_000, 10_000, 30_000, 60_000, 180_000];

/// Where a visitor came from.
pub const SOURCES: &[&str] = &["none", "domain"];

/// Browsers, without versions.
pub const BROWSERS: &[&str] = &["chrome", "edge", "firefox", "safari", "samsung", "other"];

/// Operating systems, without versions.
pub const OSES: &[&str] = &[
    "windows", "macos", "linux", "chromeos", "android", "ios", "other",
];

/// The members of a count, in the one order a taken count is written in.
pub const ORDER: &[&str] = &[
    "client",
    "event",
    "page",
    "short_id",
    "step",
    "reason",
    "action",
    "tap",
    "took",
    "visit_id",
    "device_id",
    "attempt_id",
    "browser",
    "os",
    "browser_version",
    "os_version",
    "app_version",
    "model",
    "reader",
];

/// The members whose value the device reads from outside the client's own
/// program (the system, the browser, the card reader's component) and is
/// checked by its format: a client leaves out one that is not in its format
/// ([`to_send`]), and does not shorten or rewrite it.
const READ_FROM_THE_DEVICE: &[&str] = &[
    "browser_version",
    "os_version",
    "app_version",
    "model",
    "reader",
];

/// After how many days a card proof device ID is replaced, counted from the date it was made on (ADR-0039).
pub const DEVICE_ID_DAYS: i64 = 31;

/// The card proof device ID on `today` (spec/counts.md, "The card proof
/// device ID"), from the value a device keeps (`stored`) and 16 random
/// bytes: the ID to use, and the value to keep from now on, or `None` to
/// keep the stored one.
pub fn device_id(stored: Option<&str>, today: Date, random: &[u8; 16]) -> (String, Option<String>) {
    if let Some((id, made)) = stored.and_then(|s| s.split_once('.')) {
        if let Some(made) = Date::parse(made.as_bytes()) {
            let age = today.days_since_1970() - made.days_since_1970();
            if is_id(id) && (0..DEVICE_ID_DAYS).contains(&age) {
                return (id.to_string(), None);
            }
        }
    }
    let id: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let store = format!("{id}.{today}");
    (id, Some(store))
}

/// The code a timed step that took `ms` milliseconds is sent as (spec/counts.md, "Durations").
pub fn took(ms: u64) -> &'static str {
    let i = DURATION_ENDS
        .iter()
        .position(|&end| ms < end)
        .unwrap_or(DURATIONS.len() - 1);
    DURATIONS[i]
}

/// A random ID: 16 bytes as 32 lowercase hex digits.
pub fn is_id(v: &str) -> bool {
    v.len() == 32
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A version number: 1 to 4 parts joined by `.`, each 1 to 5 decimal digits.
pub fn is_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() <= 4
        && parts
            .iter()
            .all(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// A card reader's name: 1 to 64 ASCII letters, digits and spaces.
pub fn is_reader(v: &str) -> bool {
    (1..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' ')
}

/// A phone's model: 1 to 32 ASCII letters, digits, spaces and `-_.,()+`.
pub fn is_model(v: &str) -> bool {
    (1..=32).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b" -_.,()+".contains(&b))
}

/// A short ID as a page writes it: 10 characters of the base32 alphabet.
fn is_short_id(v: &str) -> bool {
    v.len() == 10
        && v.bytes()
            .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !b"ILOU".contains(&b)))
}

fn has(list: &[&str], v: &str) -> bool {
    list.contains(&v)
}

fn is_for(codes: &[Code], code: &str, client: &str) -> bool {
    codes
        .iter()
        .any(|(c, clients)| *c == code && clients.contains(&client))
}

/// What a member must be, given the client.
#[derive(Clone, Copy)]
enum Rule {
    Page,
    ShortId,
    Step,
    Reason,
    Action,
    Tap,
    TimedStep,
    Took,
    Id,
    Browser,
    Os,
    Version,
    Reader,
    Model,
}

impl Rule {
    fn holds(self, v: &str, client: &str) -> bool {
        let web = client == "web";
        match self {
            Rule::Page => has(PAGES, v),
            Rule::ShortId => is_short_id(v),
            Rule::Step => is_for(STEPS, v, client),
            Rule::Reason => is_for(REASONS, v, client),
            // The action was looked at to choose the rules.
            Rule::Action => true,
            Rule::Tap => has(TAPS, v),
            Rule::TimedStep => is_for(TIMED_STEPS, v, client),
            Rule::Took => has(DURATIONS, v),
            Rule::Id => is_id(v),
            Rule::Browser => web && has(BROWSERS, v),
            Rule::Os => web && has(OSES, v),
            Rule::Version => is_version(v),
            Rule::Reader => web && is_reader(v),
            Rule::Model => !web && is_model(v),
        }
    }
}

/// The members a visitor's count has besides its own.
const VISITOR: &[(&str, Rule)] = &[
    ("visit_id", Rule::Id),
    ("browser", Rule::Browser),
    ("os", Rule::Os),
];

/// The members a card proof's count has besides its own, or may have.
fn card_proof(client: &str) -> Vec<(&'static str, Rule)> {
    let mut rules = vec![
        ("device_id", Rule::Id),
        ("attempt_id", Rule::Id),
        ("browser", Rule::Browser),
        ("os", Rule::Os),
        ("os_version", Rule::Version),
    ];
    if client == "web" {
        rules.extend([("browser_version", Rule::Version), ("reader", Rule::Reader)]);
    } else {
        rules.extend([("app_version", Rule::Version), ("model", Rule::Model)]);
    }
    rules
}

/// Members a count may leave out. `browser` and `os` only where the client is an app, which has none.
fn optional(member: &str, client: &str) -> bool {
    READ_FROM_THE_DEVICE.contains(&member)
        || ((member == "browser" || member == "os") && client != "web")
}

fn get<'a>(count: &[(&'a str, &'a str)], name: &str) -> Option<&'a str> {
    count.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
}

/// The rules of one count's members by what it says happened; `None` if it says nothing the table has.
fn rules_of(count: &[(&str, &str)], client: &str) -> Option<Vec<(&'static str, Rule)>> {
    let mut rules = match get(count, "event")? {
        "page" if client == "web" => {
            let mut r = vec![("page", Rule::Page)];
            if get(count, "page") == Some("card") {
                r.push(("short_id", Rule::ShortId));
            }
            r.extend_from_slice(VISITOR);
            return Some(r);
        }
        "step" => vec![("step", Rule::Step)],
        "stop" | "retry" => vec![("reason", Rule::Reason)],
        "duration" => vec![("step", Rule::TimedStep), ("took", Rule::Took)],
        "action" => {
            let action = get(count, "action")?;
            if is_for(VISITOR_ACTIONS, action, client) {
                let mut r = vec![("action", Rule::Action)];
                r.extend_from_slice(VISITOR);
                return Some(r);
            }
            if !is_for(CARD_PROOF_ACTIONS, action, client) {
                return None;
            }
            let mut r = vec![("action", Rule::Action)];
            if action == "tap_dropped" {
                r.push(("tap", Rule::Tap));
            }
            r
        }
        _ => return None,
    };
    rules.extend(card_proof(client));
    Some(rules)
}

/// Reads a count given as its members (spec/counts.md, "Taking a count"):
/// the count as it is kept, its members in the order of the table, or
/// `None` if it is dropped. It is dropped whole when anything in it is not
/// as the table has it: a member twice, a member the count may not have,
/// one it must have and has not, a code the table has not or has for
/// another client, an ID or a version or a reader's name or a model not in
/// its format.
pub fn read_count<'a>(count: &[(&'a str, &'a str)]) -> Option<Vec<(&'static str, &'a str)>> {
    for (i, (name, _)) in count.iter().enumerate() {
        if count[..i].iter().any(|(n, _)| n == name) {
            return None;
        }
    }
    let client = get(count, "client").filter(|c| has(CLIENTS, c))?;
    let rules = rules_of(count, client)?;
    let allowed =
        |name: &str| name == "client" || name == "event" || rules.iter().any(|(m, _)| *m == name);
    if !count.iter().all(|(name, _)| allowed(name)) {
        return None;
    }
    let mut kept = Vec::new();
    for &member in ORDER {
        let value = get(count, member);
        if member == "client" || member == "event" {
            kept.push((member, value?));
            continue;
        }
        let Some(&(_, rule)) = rules.iter().find(|(m, _)| *m == member) else {
            continue;
        };
        match value {
            None if optional(member, client) => {}
            None => return None,
            Some(v) if rule.holds(v, client) => kept.push((member, v)),
            Some(_) => return None,
        }
    }
    Some(kept)
}

/// The count a client sends, from what it has: a value of the phone's or
/// the browser's system (a version, a reader's name, a model) that is not
/// in its format is left out, not shortened or rewritten; the rest is read
/// by [`read_count`]. `None` when the server would drop what is left: a
/// fault of the client's program, and nothing to send.
pub fn to_send<'a>(count: &[(&'a str, &'a str)]) -> Option<Vec<(&'static str, &'a str)>> {
    // Only the format: a member the client may not send at all still drops the count.
    let kept: Vec<(&str, &str)> = count
        .iter()
        .copied()
        .filter(|&(name, v)| match name {
            "browser_version" | "os_version" | "app_version" => is_version(v),
            "reader" => is_reader(v),
            "model" => is_model(v),
            _ => true,
        })
        .collect();
    read_count(&kept)
}
