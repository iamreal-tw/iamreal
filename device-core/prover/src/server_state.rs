//! Reading the platform table of `GET /api/v1/config` and the answer of
//! `POST /api/v1/card-state` the way docs/api/card-proof.md says the device
//! reads them ("What the device does with what it cannot read"), with the
//! same rules as `web/src/api.ts` (`requestConfig`, `requestCardState`).
//! What cannot be read is `None`: the device does not go on to the
//! declaration.

use std::collections::BTreeMap;

use iamreal_device_checks::date::Date;
use iamreal_device_checks::list_consequence::ReadState;
use iamreal_device_checks::roster_rules::{
    Account, Card, MAX_SWITCHES, Platform, Slot, possible_card, possible_slot,
};
use iamreal_device_checks::username_format::{UsernameFormat, is_any_username, is_platform_id};

use crate::json::Json;

/// A display name: 1 to 100 UTF-16 code units (as `web/` counts them),
/// without a control character or a line or paragraph separator.
fn is_display_name(s: &str) -> bool {
    (1..=100).contains(&s.encode_utf16().count())
        && s.chars().all(|c| {
            !(c < '\u{20}'
                || ('\u{7f}'..='\u{9f}').contains(&c)
                || c == '\u{2028}'
                || c == '\u{2029}')
        })
}

/// The `platforms` of `config`: the rows the device can read, in ascending
/// order of platform. An element that names no platform ID is passed over;
/// one that names a platform but whose format or display name cannot be
/// read is a platform the device does not know. The platform IDs named
/// must be in strictly ascending order, and at least one row read.
pub fn read_platforms(json: &Json) -> Option<Vec<Platform>> {
    let mut named: Vec<&str> = Vec::new();
    let mut rows = Vec::new();
    for r in json.as_array()? {
        let Some(row) = r.as_object() else { continue };
        let Some(platform) = row.get("platform").and_then(Json::as_str) else {
            continue;
        };
        if !is_platform_id(platform.as_bytes()) {
            continue;
        }
        named.push(platform);
        let format = row
            .get("username_format")
            .and_then(Json::as_str)
            .and_then(|f| UsernameFormat::parse(f.as_bytes()));
        let display_name = row.get("display_name").and_then(Json::as_str);
        if let (Some(format), Some(true)) = (format, display_name.map(is_display_name)) {
            rows.push(Platform::new(platform, format));
        }
    }
    let ascending = named.windows(2).all(|w| w[0] < w[1]);
    (ascending && !rows.is_empty()).then_some(rows)
}

fn date(v: &Json) -> Option<Option<Date>> {
    match v {
        Json::Null => Some(None),
        Json::String(s) => Date::parse(s.as_bytes()).map(Some),
        _ => None,
    }
}

/// The answer of `card-state` against `table` (the rows of `config` read
/// by [`read_platforms`]), on `today` in Taiwan:
///
/// - `last_card_proof` (a date or null), `proofs_on_last_date` (a count)
///   and `platforms` (an object) must be read;
/// - the entry of every platform of the table that has one must be read:
///   `current` and `last_declared` null or in the platform's format,
///   `switch_count` from 0 to 5, `correction_date` a date or null. A
///   platform of the table without an entry is not offered;
/// - an entry of a platform the device does not know must be an object
///   with `current`: null, it is passed over; set, the account is kept as
///   it is if the platform ID and the `username` pass the checks every
///   platform does, and the card has a last card proof;
/// - a state the rules cannot produce is not read either.
///
/// Fields it does not know are passed over, `count` among them: the
/// device does not use it here.
///
/// Gives the state and the rows offered, in ascending order of platform.
pub fn read_card_state(
    json: &Json,
    table: &[Platform],
    today: Date,
) -> Option<(ReadState, Vec<Platform>)> {
    let body = json.as_object()?;
    let last_card_proof = date(body.get("last_card_proof")?)?;
    let proofs_on_last_date = body.get("proofs_on_last_date")?.as_count(u32::MAX)?;
    if !possible_card(last_card_proof, proofs_on_last_date, today) {
        return None;
    }
    let entries = body.get("platforms")?.as_object()?;

    let mut slots = BTreeMap::new();
    let mut offered = Vec::new();
    for row in table {
        let Some(entry) = entries.get(row.id()) else {
            continue;
        };
        let entry = entry.as_object()?;
        let user = |key: &str| -> Option<Option<String>> {
            match entry.get(key)? {
                Json::Null => Some(None),
                Json::String(u) if row.accepts(u) => Some(Some(u.clone())),
                _ => None,
            }
        };
        let slot = Slot {
            current: user("current")?,
            last_declared: user("last_declared")?,
            switch_count: entry.get("switch_count")?.as_count(MAX_SWITCHES)?,
            correction_date: date(entry.get("correction_date")?)?,
        };
        if !possible_slot(&slot, last_card_proof) {
            return None;
        }
        slots.insert(row.id().to_owned(), slot);
        offered.push(row.clone());
    }

    let mut kept = Vec::new();
    for (platform, entry) in entries {
        if table.iter().any(|row| row.id() == platform) {
            continue;
        }
        match entry.as_object()?.get("current")? {
            Json::Null => {}
            Json::String(username)
                if is_platform_id(platform.as_bytes())
                    && is_any_username(username.as_bytes())
                    // An account means a valid record of the card.
                    && last_card_proof.is_some() =>
            {
                kept.push(Account {
                    platform: platform.clone(),
                    username: username.clone(),
                });
            }
            _ => return None,
        }
    }
    offered.sort_by(|a, b| a.id().cmp(b.id()));
    let card = Card {
        last_card_proof,
        proofs_on_last_date,
        slots,
    };
    Some((ReadState { card, kept }, offered))
}
