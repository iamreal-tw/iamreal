//! Reading the platform table of `GET /api/v1/config` and the answer of
//! `POST /api/v1/card-state` (spec/list-consequence.md, "Reading the
//! platform table" and "Reading the card's state"). What cannot be read is
//! `None`: the device does not go on to the declaration.

use std::collections::BTreeMap;

use iamreal_device_checks::date::Date;
use iamreal_device_checks::list_consequence::ReadState;
use iamreal_device_checks::record_rules::{
    Account, Card, MAX_SWITCHES, Platform, Slot, possible_last_card_proof, possible_slot,
};
use iamreal_device_checks::username_format::{UsernameFormat, is_any_username, is_platform_id};

use crate::json::Json;

/// A display name: 1 to 100 UTF-16 code units, none below U+0020, none
/// from U+007F to U+009F, neither U+2028 nor U+2029.
fn is_display_name(s: &str) -> bool {
    (1..=100).contains(&s.encode_utf16().count())
        && s.chars().all(|c| {
            !(c < '\u{20}'
                || ('\u{7f}'..='\u{9f}').contains(&c)
                || c == '\u{2028}'
                || c == '\u{2029}')
        })
}

/// The rows of the table the device can read, in ascending order of
/// platform; `None` when the table cannot be read.
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

/// The answer of `card-state` against `table` (the rows [`read_platforms`]
/// read), on `today`: the state and the rows offered, in ascending order
/// of platform; `None` when the answer cannot be read.
pub fn read_card_state(
    json: &Json,
    table: &[Platform],
    today: Date,
) -> Option<(ReadState, Vec<Platform>)> {
    let body = json.as_object()?;
    let last_card_proof = date(body.get("last_card_proof")?)?;
    let proofs_on_last_date = body.get("proofs_on_last_date")?.as_count()?;
    let daily_limit = body.get("daily_limit")?.as_count()?;
    body.get("count")?.as_count()?;
    if !possible_last_card_proof(last_card_proof, today) {
        return None;
    }
    // A valid record of the card is counted on the date it gives the card.
    if last_card_proof.is_none() != (proofs_on_last_date == 0) {
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
            switch_count: u32::try_from(entry.get("switch_count")?.as_count()?)
                .ok()
                .filter(|n| *n <= MAX_SWITCHES)?,
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
        slots,
    };
    Some((
        ReadState {
            card,
            kept,
            proofs_on_last_date,
            daily_limit,
        },
        offered,
    ))
}
