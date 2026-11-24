//! Reading the answer to a submission, the `201` of `POST /api/v1/records`,
//! and comparing it with the rows the confirmation screen showed
//! (spec/records-response.md). The record is in the proof log whatever the
//! body is: what cannot be read is not known, never an error.

use iamreal_device_checks::username_format::{is_any_username, is_platform_id};

use crate::json::Json;

/// The kinds of spec/record-rules.md, as the answer and a row name them.
const KINDS: [&str; 5] = ["first", "refresh", "correction", "switch", "withdraw"];

/// What a record is on one platform: an element of the answer's `kinds`,
/// or a row the confirmation screen showed (which has no `account_cards`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformKind {
    pub platform: String,
    pub kind: String,
    pub username: String,
    /// The answer's `account_cards`; `None` when it is not a count.
    pub account_cards: Option<u64>,
}

/// The answer, as far as it was read ("Reading the answer").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub seq: u64,
    pub record_hash: String,
    /// The card's ordinal; `None` when it is not a count of at least 1.
    pub ordinal: Option<u64>,
    /// `None`: the kinds are unknown.
    pub kinds: Option<Vec<PlatformKind>>,
}

fn is_record_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// A list with one entry per platform: every element has a platform ID, a
/// kind and a username every format allows, and the platforms are in
/// strictly ascending order. `None` for anything else.
fn platform_kinds(list: &[Json]) -> Option<Vec<PlatformKind>> {
    let kinds: Vec<PlatformKind> = list
        .iter()
        .map(|element| {
            let element = element.as_object()?;
            let platform = element.get("platform")?.as_str()?;
            let kind = element.get("kind")?.as_str()?;
            let username = element.get("username")?.as_str()?;
            (is_platform_id(platform.as_bytes())
                && KINDS.contains(&kind)
                && is_any_username(username.as_bytes()))
            .then(|| PlatformKind {
                platform: platform.to_owned(),
                kind: kind.to_owned(),
                username: username.to_owned(),
                account_cards: element.get("account_cards").and_then(Json::as_count),
            })
        })
        .collect::<Option<_>>()?;
    kinds
        .windows(2)
        .all(|w| w[0].platform < w[1].platform)
        .then_some(kinds)
}

/// The body of a `201`; `None` when nothing of the answer is told.
pub fn read_answer(body: &[u8]) -> Option<Answer> {
    let json = Json::parse(body)?;
    let body = json.as_object()?;
    let seq = body.get("seq")?.as_count().filter(|seq| *seq >= 1)?;
    let record_hash = body.get("record_hash")?.as_str()?;
    if !is_record_hash(record_hash) {
        return None;
    }
    let ordinal = body
        .get("ordinal")
        .and_then(Json::as_count)
        .filter(|ordinal| *ordinal >= 1);
    let kinds = body
        .get("kinds")
        .and_then(Json::as_array)
        .filter(|list| !list.is_empty())
        .and_then(platform_kinds);
    Some(Answer {
        seq,
        record_hash: record_hash.to_owned(),
        ordinal,
        kinds,
    })
}

/// The rows the confirmation screen showed, as a C function takes them: the
/// `rows` of `idc_list_consequence`. Only `platform`, `kind` and `username`
/// are read. `None` when they are not that.
pub fn read_shown_rows(json: &[u8]) -> Option<Vec<PlatformKind>> {
    platform_kinds(Json::parse(json)?.as_array()?)
}

/// The platforms that differ ("Comparing with what the screen said"), in
/// ascending order. `shown` and `kinds` are each in ascending order of
/// platform, each platform at most once.
pub fn mismatches<'a>(shown: &'a [PlatformKind], kinds: &'a [PlatformKind]) -> Vec<&'a str> {
    let same = |a: &PlatformKind, b: &PlatformKind| a.kind == b.kind && a.username == b.username;
    let of =
        |list: &'a [PlatformKind], platform: &str| list.iter().find(|k| k.platform == platform);
    let mut platforms: Vec<&str> = shown
        .iter()
        .filter(|row| !of(kinds, &row.platform).is_some_and(|k| same(row, k)))
        .chain(kinds.iter().filter(|k| of(shown, &k.platform).is_none()))
        .map(|k| k.platform.as_str())
        .collect();
    platforms.sort_unstable();
    platforms
}
