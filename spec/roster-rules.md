# Roster rules

Status: **Draft**.

The roster stores events, not states (ADR-0005). The current state of every
card and account is computed from the records by the rules below. Anyone who
downloads a snapshot and applies these rules must get the same answer as the
server's API.

## Input

A snapshot: records in `seq` order ([`record.md`](record.md)).

**The snapshot as a whole.** Every line is well formed
([`record.md`](record.md)), `seq` starts at 1 and is consecutive, and every
`prev` equals the record hash of the record before it. If not, the snapshot
is broken. A broken snapshot is reported as such; the rules do not try to
compute a state from it.

**Each record** gets one of two outcomes: valid, or invalid with a reason.
An invalid record stays in the roster and is listed, but changes nothing. The
server does not accept events that would be invalid. Any invalid record a
re-verifier finds therefore shows the operator appended something it should
not have.

## Per record

For each record, in `seq` order:

1. **Verification.** The record passes [`record.md`](record.md)'s checks,
   including the proof. If not: invalid.
2. **Challenge reuse.** Its `challenge` appears in no earlier record (valid
   or not). If it does: invalid.
3. **The event rules**, applied to the state of its
   (`scope_string`, `scoped_id`).

The **date** `d` of a record is the date in its challenge. Order is always by
`seq`, never by date. Dates can step backwards by a day around midnight,
because the challenge is dated when it is issued.

## State of a card in a scope

For each (`scope_string`, `scoped_id`), starting empty:

| Item | Meaning | Initially |
|---|---|---|
| `current` | The account the slot is declared to now, or none | none |
| `last_declared` | The account of the last valid `declare`, kept after a withdrawal | none |
| `switch_dates` | Dates of the valid switches | empty |
| `last_card_proof` | The latest date among the valid records | none |

## Event rules

**`declare` of account `u` on date `d`**:

| Condition | Kind | Effect |
|---|---|---|
| `last_declared` is none | first declaration | `current = u`, `last_declared = u` |
| `last_declared = u` | refresh | `current = u` |
| otherwise | switch | Valid only if fewer than 2 dates in `switch_dates` are on or after `d − 364 days`. Then `current = u`, `last_declared = u`, add `d` to `switch_dates`. Else invalid |

**`withdraw` of account `u` on date `d`**: valid only if `current = u`. Then
`current = none`. `last_declared` is unchanged.

**Every valid record**: `last_card_proof = max(last_card_proof, d)`.

What follows from these rules:

- A switch is a declaration to a different account than the last one
  declared, whether or not there was a withdrawal in between. Withdrawing and
  then declaring another account is a switch. A → B → A is two switches.
- Withdrawing and then declaring the same account again is not a switch.
- A first declaration is not a switch.
- At most 2 switches in any 365 days, counting the day of the switch:
  dates from `d − 364` through `d`. Earlier switches dated after `d` also
  count; this only happens around midnight.
- There is no free correction of a mistyped account. Correcting it uses a
  switch.
- One card is declared to at most one account at a time. One account can be
  declared by any number of cards.

## Output

- **Per card in a scope**: `current` and `last_card_proof`.
- **Per account in a scope**: the scoped IDs whose `current` is this
  account, each with its `last_card_proof`.

There is no expiry. The rules report facts and dates. How recent a card
proof must be to count is up to whoever uses the answer, so answers always
carry the date.

## Not part of these rules

- The 10-minute lifetime of a challenge is a server rule. The roster does not
  record when a challenge was issued, so nobody else can check it.
- Which `smt_root` values are recognized (see [`record.md`](record.md)).

## Test vectors

[`vectors/roster-rules.json`](vectors/roster-rules.json): sequences of events
with the outcome of each and the final state. The events stand for records
that passed verification, so they carry only the fields the rules read.
