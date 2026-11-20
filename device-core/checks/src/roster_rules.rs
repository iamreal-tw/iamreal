//! The roster rules (spec/roster-rules.md), the third implementation after
//! Go's `roster/` and TypeScript's `protocol/` (ADR-0030, ADR-0034).
//!
//! [`apply_record`] takes a record, the state of its card before it and the
//! three facts about the rest of the roster the checks read, and gives the
//! record's result and the state of the card after it. It keeps nothing.
//! [`apply_list`] is its second half, checks 5 and 6: what the device
//! computes for a list before the card signs it. [`MemoryRules`] keeps the
//! state of every card in memory, to compute a roster from its first
//! record.
//!
//! The rules and their numbers are built into the core and change with the
//! version of the rules ([`RULES_VERSION`], ADR-0035); the platform table
//! is not, it comes from the caller.

use std::collections::{BTreeMap, BTreeSet};

use crate::challenge::parse_challenge;
use crate::date::Date;
use crate::username_format::{UsernameFormat, is_any_username};

/// The version number of these rules (spec/roster-rules.md, "The version
/// number"). Go's `roster.RulesVersion` and TypeScript's `RULES_VERSION`
/// are the same number.
pub const RULES_VERSION: u32 = 1;

/// At most 3 valid records of a card have the same date (check 6, `daily_limit`).
pub const MAX_PER_DATE: u32 = 3;
/// A record's date is no earlier than this many days before the latest date
/// among the earlier valid records, of any card (check 4, `date_order`).
pub const DATE_ORDER_DAYS: i32 = 4;
/// A card has 5 switches on each platform, for good ("Switches and corrections").
pub const MAX_SWITCHES: u32 = 5;
/// A record's date is at most 3 days after the date of the CRL behind its
/// root ("How far dates are trusted"); no date in the roster is later than
/// today plus this.
pub const MAX_DAYS_AHEAD: i32 = 3;
/// A record's date is at most this many days before the date of the CRL
/// behind its root (spec/revocation-tree.md, "Which roots a record may use").
pub const ROOT_DAYS_BEFORE: i32 = 1;

/// What a valid record does on one platform ("Event rules").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    First,
    Refresh,
    Correction,
    Switch,
    Withdraw,
}

impl Kind {
    /// The name the specification and the vectors use.
    pub fn name(self) -> &'static str {
        match self {
            Kind::First => "first",
            Kind::Refresh => "refresh",
            Kind::Correction => "correction",
            Kind::Switch => "switch",
            Kind::Withdraw => "withdraw",
        }
    }
}

/// The reason code of an invalid record ("Per record").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    Proof,
    ChallengeReused,
    Root,
    DateOrder,
    Empty,
    /// With the first platform blocked: an explanation for people. The
    /// reason code is the whole result ("Output").
    SwitchLimit {
        platform: String,
    },
    DailyLimit,
}

impl Reason {
    /// The reason code.
    pub fn name(&self) -> &'static str {
        match self {
            Reason::Proof => "proof",
            Reason::ChallengeReused => "challenge_reused",
            Reason::Root => "root",
            Reason::DateOrder => "date_order",
            Reason::Empty => "empty",
            Reason::SwitchLimit { .. } => "switch_limit",
            Reason::DailyLimit => "daily_limit",
        }
    }
}

/// An account of a record's list: at most one per platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub platform: String,
    pub username: String,
}

/// What a valid record did on one platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformKind {
    pub platform: String,
    pub kind: Kind,
}

/// The result of one record: valid with its kinds, in ascending order of
/// platform and at least one, or invalid with its reason code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordResult {
    Valid(Vec<PlatformKind>),
    Invalid(Reason),
}

/// The state of one slot: one card on one platform ("State"). The empty
/// slot is `Slot::default()`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Slot {
    pub current: Option<String>,
    pub last_declared: Option<String>,
    /// Valid switches of the slot, 0 to 5; it never decreases.
    pub switch_count: u32,
    /// The date of the slot's last valid `first` or `switch`.
    pub correction_date: Option<Date>,
}

/// The state of one card: its own items, and its slots by platform ID.
/// A card without a valid record has no date, 0 and empty slots.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Card {
    pub last_card_proof: Option<Date>,
    /// The number of valid records of the card dated `last_card_proof`.
    pub proofs_on_last_date: u32,
    /// A platform of the table without a slot here has the empty slot.
    pub slots: BTreeMap<String, Slot>,
}

/// What a platform accepts as a `username`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Usernames {
    Format(UsernameFormat),
    /// Any `username` ([`is_any_username`]): a platform the device does not
    /// know, whose account it keeps as the server reported it.
    Any,
}

/// A row of a platform table, as far as the rules read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Platform {
    platform: String,
    usernames: Usernames,
}

impl Platform {
    /// A row of the table (spec/scope.md): the platform ID and its format.
    pub fn new(platform: &str, format: UsernameFormat) -> Platform {
        Platform {
            platform: platform.to_owned(),
            usernames: Usernames::Format(format),
        }
    }

    /// A platform the device does not know (docs/api/card-proof.md,
    /// card-state): the rules take its account as kept, checked only as any
    /// `username`.
    pub fn kept(platform: &str) -> Platform {
        Platform {
            platform: platform.to_owned(),
            usernames: Usernames::Any,
        }
    }

    pub fn id(&self) -> &str {
        &self.platform
    }

    /// Whether `username` is one this platform accepts.
    pub fn accepts(&self, username: &str) -> bool {
        match &self.usernames {
            Usernames::Format(f) => f.accepts(username.as_bytes()),
            Usernames::Any => is_any_username(username.as_bytes()),
        }
    }
}

/// What the rules are never asked about ("What an invalid record changes"):
/// not an invalid record, a list or a state that is not a roster's. No check
/// runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotARecord {
    /// The list names a platform outside the table.
    PlatformOutsideTable,
    /// The list names one platform twice.
    PlatformTwice,
    /// The list is not in ascending order of platform.
    NotInOrder,
    /// A `username` is not in the format of its platform.
    UsernameOutsideFormat,
    /// The card's state has a slot on a platform outside the table.
    SlotOutsideTable,
    /// The challenge is not in its one spelling.
    Challenge,
}

/// The result of a list and the state of the card after it: after an
/// invalid record the state given, as it was; after a valid one a new
/// state, with a slot for every platform of the table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListOutcome {
    pub result: RecordResult,
    pub card: Card,
}

/// A record and the facts about the rest of the roster that its checks read.
#[derive(Debug, Clone)]
pub struct RecordInput<'a> {
    /// The roster's platform table, in any order.
    pub platforms: &'a [Platform],
    /// The record's list, in ascending order of platform.
    pub accounts: &'a [Account],
    /// The record's date: the date in its challenge.
    pub date: Date,
    /// Check 1: whether the record verifies (spec/record.md).
    pub verifies: bool,
    /// The state of the record's card before it.
    pub card: &'a Card,
    /// The latest date among the earlier valid records of the roster, of any card.
    pub latest_valid_date: Option<Date>,
    /// Whether the record's challenge appears in an earlier record, valid or invalid.
    pub challenge_used: bool,
    /// The CRL dates of the usable CRLs of the record's issuer whose tree has its root.
    pub crl_dates: &'a [Date],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordOutcome {
    pub result: RecordResult,
    pub card: Card,
    /// The latest date among the valid records of the roster after the record.
    pub latest_valid_date: Option<Date>,
}

/// What the event rules give one slot.
enum SlotOutcome {
    /// No kind: no entry, and no account to withdraw.
    Nothing,
    /// Another account, with no switch left and no correction open.
    Blocked,
    Kind(Kind, Slot),
}

/// The event rules for one slot ("Event rules"): `entry` is the account the
/// list has for the slot's platform. The first row that applies gives the
/// kind and the slot after it.
fn apply_entry(slot: &Slot, entry: Option<&str>, date: Date) -> SlotOutcome {
    let Some(entry) = entry else {
        return match slot.current {
            None => SlotOutcome::Nothing,
            Some(_) => SlotOutcome::Kind(
                Kind::Withdraw,
                Slot {
                    current: None,
                    ..slot.clone()
                },
            ),
        };
    };
    let declared = |switch_count, correction_date| Slot {
        current: Some(entry.to_owned()),
        last_declared: Some(entry.to_owned()),
        switch_count,
        correction_date,
    };
    let applied = match slot.last_declared.as_deref() {
        None => (Kind::First, declared(slot.switch_count, Some(date))),
        Some(last) if last == entry => (
            Kind::Refresh,
            Slot {
                current: Some(entry.to_owned()),
                ..slot.clone()
            },
        ),
        Some(_) if slot.correction_date == Some(date) => (
            Kind::Correction,
            declared(slot.switch_count, slot.correction_date),
        ),
        Some(_) if slot.switch_count < MAX_SWITCHES => {
            (Kind::Switch, declared(slot.switch_count + 1, Some(date)))
        }
        Some(_) => return SlotOutcome::Blocked,
    };
    SlotOutcome::Kind(applied.0, applied.1)
}

/// Reads the list against the table, account by account: its platform, its
/// place after the account before, its username. A list that fails is not
/// a record ("What an invalid record changes"). Gives the table's IDs in
/// ascending order and the list by platform.
fn read_list<'a>(
    platforms: &[Platform],
    card: &Card,
    accounts: &'a [Account],
) -> Result<(Vec<String>, BTreeMap<String, &'a str>), NotARecord> {
    let rows: BTreeMap<&str, &Platform> = platforms.iter().map(|p| (p.id(), p)).collect();
    let mut list = BTreeMap::new();
    let mut last: Option<&str> = None;
    for a in accounts {
        let row = rows
            .get(a.platform.as_str())
            .ok_or(NotARecord::PlatformOutsideTable)?;
        match last {
            Some(l) if l == a.platform => return Err(NotARecord::PlatformTwice),
            Some(l) if l > a.platform.as_str() => return Err(NotARecord::NotInOrder),
            _ => {}
        }
        if !row.accepts(&a.username) {
            return Err(NotARecord::UsernameOutsideFormat);
        }
        list.insert(a.platform.clone(), a.username.as_str());
        last = Some(&a.platform);
    }
    if card.slots.keys().any(|p| !rows.contains_key(p.as_str())) {
        return Err(NotARecord::SlotOutsideTable);
    }
    Ok((rows.keys().map(|p| (*p).to_owned()).collect(), list))
}

/// Checks 5 and 6 and the effects of a valid record, for a list
/// [`read_list`] accepted.
fn check_list(
    table: &[String],
    card: &Card,
    list: &BTreeMap<String, &str>,
    date: Date,
) -> ListOutcome {
    let invalid = |reason| ListOutcome {
        result: RecordResult::Invalid(reason),
        card: card.clone(),
    };
    // 5. The event rules, on a copy. One blocked platform blocks the record.
    let empty = Slot::default();
    let mut slots = BTreeMap::new();
    let mut kinds = Vec::new();
    for platform in table {
        let before = card.slots.get(platform).unwrap_or(&empty);
        match apply_entry(before, list.get(platform).copied(), date) {
            SlotOutcome::Blocked => {
                return invalid(Reason::SwitchLimit {
                    platform: platform.clone(),
                });
            }
            SlotOutcome::Kind(kind, after) => {
                kinds.push(PlatformKind {
                    platform: platform.clone(),
                    kind,
                });
                slots.insert(platform.clone(), after);
            }
            SlotOutcome::Nothing => {
                slots.insert(platform.clone(), before.clone());
            }
        }
    }
    if kinds.is_empty() {
        return invalid(Reason::Empty);
    }
    // 6. Fewer than 3 earlier valid records of its card have its date.
    let on_date = if card.last_card_proof == Some(date) {
        card.proofs_on_last_date
    } else {
        0
    };
    if on_date >= MAX_PER_DATE {
        return invalid(Reason::DailyLimit);
    }
    ListOutcome {
        result: RecordResult::Valid(kinds),
        card: Card {
            last_card_proof: Some(date),
            proofs_on_last_date: on_date + 1,
            slots,
        },
    }
}

/// Checks 5 and 6 and the effects of a valid record: the event rules on
/// every platform of the table, whether the list has an entry for it or
/// not, then the card's 3 records a date. The second half of
/// [`apply_record`], for a record that passed checks 1 to 4.
///
/// The device calls it by itself for what a list would do today. Of checks
/// 1 to 4 it could compute only the card's own half of check 4, and it
/// leaves that one to the server (spec/list-consequence.md).
pub fn apply_list(
    platforms: &[Platform],
    card: &Card,
    accounts: &[Account],
    date: Date,
) -> Result<ListOutcome, NotARecord> {
    let (table, list) = read_list(platforms, card, accounts)?;
    Ok(check_list(&table, card, &list, date))
}

/// The roster rules for one record ("Per record"): the six checks in order,
/// the first that fails giving the reason code. It keeps nothing.
///
/// What the caller keeps between records: the card's state, the roster's
/// latest valid date and, whatever the result, that the record's challenge
/// is used. With an error the input was not a record, and the caller keeps
/// nothing.
pub fn apply_record(input: &RecordInput<'_>) -> Result<RecordOutcome, NotARecord> {
    let RecordInput {
        platforms,
        accounts,
        date,
        verifies,
        card,
        latest_valid_date,
        challenge_used,
        crl_dates,
    } = *input;
    let (table, list) = read_list(platforms, card, accounts)?;
    let invalid = |reason| {
        Ok(RecordOutcome {
            result: RecordResult::Invalid(reason),
            card: card.clone(),
            latest_valid_date,
        })
    };
    let d = date.day_number();
    // 1. The record verifies.
    if !verifies {
        return invalid(Reason::Proof);
    }
    // 2. Its challenge appears in no earlier record.
    if challenge_used {
        return invalid(Reason::ChallengeReused);
    }
    // 3. Its root is recognized for its issuer and date.
    let fits = |crl: &Date| {
        let c = crl.day_number();
        c - ROOT_DAYS_BEFORE <= d && d <= c + MAX_DAYS_AHEAD
    };
    if !crl_dates.iter().any(fits) {
        return invalid(Reason::Root);
    }
    // 4. Its date is no earlier than 4 days before the latest valid date,
    // and no earlier than its card's last card proof.
    if latest_valid_date.is_some_and(|l| d < l.day_number() - DATE_ORDER_DAYS)
        || card.last_card_proof.is_some_and(|l| date < l)
    {
        return invalid(Reason::DateOrder);
    }
    // 5 and 6.
    let ListOutcome { result, card } = check_list(&table, card, &list, date);
    let latest_valid_date = match result {
        RecordResult::Valid(_) => latest_valid_date.max(Some(date)),
        RecordResult::Invalid(_) => latest_valid_date,
    };
    Ok(RecordOutcome {
        result,
        card,
        latest_valid_date,
    })
}

/// False if no roster can give a slot this state by the rules:
///
/// - `current`, when set, is `last_declared` (it is set only together with
///   it, and a withdrawal clears `current` only);
/// - `last_declared` and `correction_date` are set together (a `first`
///   sets both; nothing clears either);
/// - `switch_count` is 0 to 5, and 0 without `last_declared`;
/// - every item comes from a valid record of the card, so none is set
///   without `last_card_proof`, and `correction_date` is no later than it.
pub fn possible_slot(slot: &Slot, last_card_proof: Option<Date>) -> bool {
    let Slot {
        current,
        last_declared,
        switch_count,
        correction_date,
    } = slot;
    if *switch_count > MAX_SWITCHES {
        return false;
    }
    if current.is_some() && current != last_declared {
        return false;
    }
    if last_declared.is_none() != correction_date.is_none() {
        return false;
    }
    if last_declared.is_none() && *switch_count > 0 {
        return false;
    }
    if last_declared.is_some() && last_card_proof.is_none() {
        return false;
    }
    !matches!((correction_date, last_card_proof), (Some(c), Some(l)) if c > &l)
}

/// False if no roster can give a card these items: `proofs_on_last_date`
/// is 0 without `last_card_proof` and 1 to 3 with it (check 6), and no date
/// is more than [`MAX_DAYS_AHEAD`] days after `today`.
pub fn possible_card(last_card_proof: Option<Date>, proofs_on_last_date: u32, today: Date) -> bool {
    match last_card_proof {
        None => proofs_on_last_date == 0,
        Some(last) => {
            (1..=MAX_PER_DATE).contains(&proofs_on_last_date)
                && last.day_number() <= today.day_number() + MAX_DAYS_AHEAD
        }
    }
}

/// A well-formed record, with the two answers the rules take from outside
/// the roster.
#[derive(Debug, Clone)]
pub struct MemoryRecord {
    pub scope_string: String,
    pub scoped_id: String,
    /// In its one spelling (spec/challenge.md); its date is the record's date.
    pub challenge: String,
    pub accounts: Vec<Account>,
    /// Check 1: whether the record verifies.
    pub verifies: bool,
    /// Check 3: the CRL dates of the usable CRLs of the record's issuer whose tree has its root.
    pub crl_dates: Vec<Date>,
}

/// A card of the output ("Output").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputCard {
    pub scoped_id: String,
    pub last_card_proof: Date,
    /// Its current list, in ascending order of platform.
    pub accounts: Vec<Account>,
}

/// An account of the output, with the cards whose current account on the
/// platform it is: scoped ID and last card proof, by scoped ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputAccount {
    pub platform: String,
    pub username: String,
    pub cards: Vec<(String, Date)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputScope {
    pub scope_string: String,
    pub cards: Vec<OutputCard>,
    pub accounts: Vec<OutputAccount>,
}

/// The roster rules with their state kept in memory: the way to compute
/// the state of every card from the first record of a roster. Everything
/// the rules decide is [`apply_record`]; this keeps what it asks its caller
/// to keep between records.
#[derive(Debug, Clone)]
pub struct MemoryRules {
    platforms: Vec<Platform>,
    /// Scope string, then scoped ID: by byte value, the order of the output.
    cards: BTreeMap<String, BTreeMap<String, Card>>,
    used: BTreeSet<String>,
    latest: Option<Date>,
    applied: usize,
}

impl MemoryRules {
    /// `platforms`: the roster's platform table (spec/scope.md).
    pub fn new(mut platforms: Vec<Platform>) -> MemoryRules {
        platforms.sort_by(|a, b| a.platform.cmp(&b.platform));
        MemoryRules {
            platforms,
            cards: BTreeMap::new(),
            used: BTreeSet::new(),
            latest: None,
            applied: 0,
        }
    }

    /// Applies `r` as the next record. A valid record changes the state of
    /// its card; an invalid one changes nothing but marks its challenge as
    /// used. With an error, `r` is not a well-formed record and nothing
    /// changes.
    pub fn apply(&mut self, r: &MemoryRecord) -> Result<RecordOutcome, NotARecord> {
        let date = parse_challenge(r.challenge.as_bytes()).ok_or(NotARecord::Challenge)?;
        let card = self.card(&r.scope_string, &r.scoped_id);
        let outcome = apply_record(&RecordInput {
            platforms: &self.platforms,
            accounts: &r.accounts,
            date,
            verifies: r.verifies,
            card: &card,
            latest_valid_date: self.latest,
            challenge_used: self.used.contains(&r.challenge),
            crl_dates: &r.crl_dates,
        })?;
        if let RecordResult::Valid(_) = outcome.result {
            self.cards
                .entry(r.scope_string.clone())
                .or_default()
                .insert(r.scoped_id.clone(), outcome.card.clone());
        }
        self.latest = outcome.latest_valid_date;
        self.used.insert(r.challenge.clone());
        self.applied += 1;
        Ok(outcome)
    }

    /// The state of a card; of a card without a valid record, the empty state.
    pub fn card(&self, scope_string: &str, scoped_id: &str) -> Card {
        self.cards
            .get(scope_string)
            .and_then(|s| s.get(scoped_id))
            .cloned()
            .unwrap_or_else(|| Card {
                slots: self
                    .platforms
                    .iter()
                    .map(|p| (p.platform.clone(), Slot::default()))
                    .collect(),
                ..Card::default()
            })
    }

    /// The number of records applied.
    pub fn count(&self) -> usize {
        self.applied
    }

    /// The latest date among the valid records applied.
    pub fn latest_valid_date(&self) -> Option<Date> {
        self.latest
    }

    /// The output for the records applied so far ("Output"): every sort by
    /// byte value; cards without a valid record, accounts without a card
    /// and scopes without a card are not listed.
    pub fn output(&self) -> Vec<OutputScope> {
        self.cards
            .iter()
            .map(|(scope_string, scope)| {
                let mut cards = Vec::new();
                let mut accounts: BTreeMap<(String, String), Vec<(String, Date)>> = BTreeMap::new();
                for (scoped_id, state) in scope {
                    // A card is stored only after a valid record.
                    let Some(last_card_proof) = state.last_card_proof else {
                        continue;
                    };
                    let mut list = Vec::new();
                    for p in &self.platforms {
                        let Some(username) =
                            state.slots.get(&p.platform).and_then(|s| s.current.clone())
                        else {
                            continue;
                        };
                        accounts
                            .entry((p.platform.clone(), username.clone()))
                            .or_default()
                            .push((scoped_id.clone(), last_card_proof));
                        list.push(Account {
                            platform: p.platform.clone(),
                            username,
                        });
                    }
                    cards.push(OutputCard {
                        scoped_id: scoped_id.clone(),
                        last_card_proof,
                        accounts: list,
                    });
                }
                OutputScope {
                    scope_string: scope_string.clone(),
                    cards,
                    accounts: accounts
                        .into_iter()
                        .map(|((platform, username), cards)| OutputAccount {
                            platform,
                            username,
                            cards,
                        })
                        .collect(),
                }
            })
            .collect()
    }
}
