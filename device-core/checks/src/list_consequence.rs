//! What a list does on every platform, before the card signs it: the
//! confirmation screen shows it row by row (docs/api/card-proof.md,
//! card-state, "What the device does with it"). The roster rules decide it
//! ([`apply_list`], checks 5 and 6), against the state of the card the
//! server reported, on today's date in Taiwan by the device's clock.
//!
//! `web/` computes the same in `web/src/flow.ts` (`consequenceOf`).

use crate::date::Date;
use crate::roster_rules::{
    Account, Card, Kind, MAX_SWITCHES, NotARecord, Platform, PlatformKind, Reason, RecordResult,
    Slot, apply_list,
};

/// The state of a card as the device read it from the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadState {
    /// `last_card_proof`, `proofs_on_last_date`, and a slot for every
    /// platform offered: a row of the table the device read, with an entry
    /// in the state.
    pub card: Card,
    /// The accounts of the card on platforms the device does not know, in
    /// ascending order of platform: kept in the list as they are, since a
    /// list without one would withdraw it.
    pub kept: Vec<Account>,
}

/// One row of the confirmation: what the list does on one platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub platform: String,
    pub kind: Kind,
    /// The account the row is about: the one declared, or for a
    /// `withdraw` the one withdrawn.
    pub username: String,
    /// For a `switch` or a `correction`, the account it replaces: the
    /// current one, or after a withdrawal the last one declared.
    pub previous: Option<String>,
    /// The switches left on the platform after the record; `None` on a
    /// platform the device does not know.
    pub switches_left: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Consequence {
    /// The list the card signs (the cardholder's, with the kept accounts),
    /// in ascending order of platform, and a row for every platform that
    /// has a kind, in the same order.
    Valid {
        accounts: Vec<Account>,
        rows: Vec<Row>,
    },
    /// The rules refuse the list (`empty`, `switch_limit`, `daily_limit`):
    /// it is not offered for signing.
    Invalid(Reason),
}

/// What `list` does, the cardholder's list for the platforms offered: in
/// ascending order of platform, each at most once, each a platform of
/// `offered` in its format. `offered` are the rows of the table that have
/// a slot in `state.card`. Anything else is an error, not a result.
pub fn list_consequence(
    offered: &[Platform],
    state: &ReadState,
    list: &[Account],
    today: Date,
) -> Result<Consequence, NotARecord> {
    for pair in list.windows(2) {
        if pair[0].platform == pair[1].platform {
            return Err(NotARecord::PlatformTwice);
        }
        if pair[0].platform > pair[1].platform {
            return Err(NotARecord::NotInOrder);
        }
    }
    if list
        .iter()
        .any(|a| !offered.iter().any(|p| p.id() == a.platform))
    {
        return Err(NotARecord::PlatformOutsideTable);
    }

    // The table the rules go through: the platforms offered, and for each
    // one the device does not know a row that takes its account as kept.
    // There the account is the one declared, whatever else its slot holds.
    let mut table = offered.to_vec();
    let mut card = state.card.clone();
    let mut accounts = list.to_vec();
    for k in &state.kept {
        table.push(Platform::kept(&k.platform));
        card.slots.insert(
            k.platform.clone(),
            Slot {
                current: Some(k.username.clone()),
                last_declared: Some(k.username.clone()),
                ..Slot::default()
            },
        );
        accounts.push(k.clone());
    }
    accounts.sort_by(|a, b| a.platform.cmp(&b.platform));

    let outcome = apply_list(&table, &card, &accounts, today)?;
    let kinds = match outcome.result {
        RecordResult::Valid(kinds) => kinds,
        RecordResult::Invalid(reason) => return Ok(Consequence::Invalid(reason)),
    };
    let rows = kinds
        .into_iter()
        .map(|PlatformKind { platform, kind }| {
            let before = &card.slots[&platform];
            let after = &outcome.card.slots[&platform];
            let username = match kind {
                Kind::Withdraw => before.current.clone(),
                _ => after.current.clone(),
            };
            let previous = match kind {
                Kind::Switch | Kind::Correction => {
                    before.current.clone().or(before.last_declared.clone())
                }
                _ => None,
            };
            let known = !state.kept.iter().any(|k| k.platform == platform);
            Row {
                username: username.expect("a row has an account"),
                previous,
                switches_left: known.then(|| MAX_SWITCHES - after.switch_count),
                platform,
                kind,
            }
        })
        .collect();
    Ok(Consequence::Valid { accounts, rows })
}
