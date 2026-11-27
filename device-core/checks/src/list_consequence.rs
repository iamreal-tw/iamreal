//! What a list does on every platform, before the card signs it
//! (spec/list-consequence.md, "What the list does"): the list the card
//! signs and one row per platform, for the confirmation screen. The proof log
//! rules decide it ([`apply_list`], check 5), against the state of the card
//! the server reported, on today's date in Taiwan; then the server's limit
//! of records a card a date.

use crate::date::Date;
use crate::record_rules::{
    Account, Card, Kind, MAX_SWITCHES, NotARecord, Platform, PlatformKind, Reason, RecordResult,
    Slot, apply_list,
};

/// The state of a card as the device read it (spec/list-consequence.md,
/// "Reading the card's state").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadState {
    /// `last_card_proof`, and a slot for every platform offered.
    pub card: Card,
    /// The kept accounts, on platforms the device does not know, in
    /// ascending order of platform.
    pub kept: Vec<Account>,
    /// The server's count of the card's valid records dated
    /// `last_card_proof`, 0 without one, and the most records of one card it
    /// writes with one date (docs/api/card-proof.md, `card-state`).
    pub proofs_on_last_date: u64,
    pub daily_limit: u64,
}

impl ReadState {
    /// True if the server writes no more records of the card on `today`
    /// (spec/list-consequence.md, "The card's state, as shown"): its records
    /// dated today are `daily_limit` or more. A card's dates do not go back,
    /// so those are `proofs_on_last_date` when `last_card_proof` is today,
    /// and none otherwise.
    pub fn daily_limit_reached(&self, today: Date) -> bool {
        let today_count = if self.card.last_card_proof == Some(today) {
            self.proofs_on_last_date
        } else {
            0
        };
        today_count >= self.daily_limit
    }
}

/// One row: what the list does on one platform (spec/list-consequence.md,
/// the table of a row).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub platform: String,
    /// False for a platform whose account is kept.
    pub known: bool,
    pub kind: Kind,
    /// The account the list has there; for a `withdraw`, the one withdrawn.
    pub username: String,
    /// The slot's `current` before the record.
    pub current: Option<String>,
    /// For a `switch`, the account replaced.
    pub previous: Option<String>,
    /// For a `switch`, the switches left after it.
    pub switches_left: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Consequence {
    /// The list the card signs, in ascending order of platform, a row for
    /// every platform that has a kind, in the same order, and whether this
    /// would be the card's first record.
    Valid {
        accounts: Vec<Account>,
        rows: Vec<Row>,
        first_record: bool,
    },
    /// The rules refuse the list: it is not offered for signing.
    Invalid(Reason),
    /// The rules accept the list, but the server writes no more records of
    /// the card today: it is not offered for signing either.
    DailyLimit,
    /// A `username` of the list is not in the format of this platform, the
    /// first in ascending order.
    Username { platform: String },
}

/// The list names a platform that is not offered (step 1), or is not in
/// ascending order of platform, or names one twice: a mistake of the
/// program, not of the cardholder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotOffered;

/// What `list` does. `offered` are the rows of the table with a slot in
/// `state.card`, in ascending order of platform.
pub fn list_consequence(
    offered: &[Platform],
    state: &ReadState,
    list: &[Account],
    today: Date,
) -> Result<Consequence, NotOffered> {
    let ascending = list.windows(2).all(|w| w[0].platform < w[1].platform);
    let row_of = |a: &Account| offered.iter().find(|p| p.id() == a.platform);
    // 1. Every platform of the list is offered.
    if !ascending || list.iter().any(|a| row_of(a).is_none()) {
        return Err(NotOffered);
    }
    // 2. Every username is in its platform's format.
    if let Some(a) = list
        .iter()
        .find(|a| row_of(a).is_some_and(|p| !p.accepts(&a.username)))
    {
        return Ok(Consequence::Username {
            platform: a.platform.clone(),
        });
    }

    // 3. The list the card signs, and the slots the rules go through: one
    // for each kept account, which is the account declared there.
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

    // 4 and 5. Check 5, then the server's limit.
    let outcome =
        apply_list(&table, &card, &accounts, today).map_err(|_: NotARecord| NotOffered)?;
    let kinds = match outcome.result {
        RecordResult::Valid(kinds) => kinds,
        RecordResult::Invalid(reason) => return Ok(Consequence::Invalid(reason)),
    };
    if state.daily_limit_reached(today) {
        return Ok(Consequence::DailyLimit);
    }
    // 6. The rows.
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
                Kind::Switch => before.current.clone().or(before.last_declared.clone()),
                _ => None,
            };
            Row {
                known: !state.kept.iter().any(|k| k.platform == platform),
                username: username.expect("a row has an account"),
                current: before.current.clone(),
                previous,
                switches_left: (kind == Kind::Switch).then(|| MAX_SWITCHES - after.switch_count),
                platform,
                kind,
            }
        })
        .collect();
    Ok(Consequence::Valid {
        accounts,
        rows,
        first_record: state.card.last_card_proof.is_none(),
    })
}
