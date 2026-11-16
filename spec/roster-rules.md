# Roster rules

Status: **Draft**.

The roster stores events, not states (ADR-0005). The current state of every
card and account is computed from the records by the rules below. Anyone who
downloads a snapshot and applies these rules must get the same answer as the
server's API.

## Input

A snapshot: a roster file ([`record.md`](record.md)), usually read from a
roster directory ("The published roster").

**The file as a whole** is valid only if:

| Check | Code if it fails |
|---|---|
| Every line is well formed ([`record.md`](record.md), "Lines and files") | `line` |
| The `seq` of the n-th line is n | `seq` |
| Every `prev` equals the record hash of the line before it | `prev` |

Lines are checked one at a time, in order. For each line the three checks
run in the order of the table; the first failure ends the check, and the file
is reported as broken with that line's number (counting from 1) and the
code. Bytes after the last `LF`, an empty line and a byte order mark fail the
first check on the line where they occur. The rules do not compute a state
from a broken file.

**Each record** of a valid file is valid, or invalid with one reason code.
An invalid record stays in the roster and is listed, but changes nothing.
The server does not append records that would be invalid. Any invalid record
a re-verifier finds therefore shows the operator appended something it should
not have.

## Per record

For each record, in `seq` order, the checks below run in this order. The
first one that fails gives the record's reason code, and the later checks do
not run. A record that does not verify is therefore `proof` even if its
challenge was used before; its challenge still counts as used.

| # | Check | Code |
|---|---|---|
| 1 | The record verifies ([`record.md`](record.md), "Verifying a record") | `proof` |
| 2 | Its `challenge` appears in no earlier record, valid or invalid, of any card and any scope | `challenge_reused` |
| 3 | Its `smt_root` is recognized for its `issuer` and date ([`revocation-tree.md`](revocation-tree.md)) | `root` |
| 4 | Its date is no earlier than 4 days before the latest date among the earlier valid records, of any card and any scope | `date_order` |
| 5 | The event rules below, for the state of its (`scope_string`, `scoped_id`) | `not_current` or `switch_limit` |
| 6 | Fewer than 3 earlier valid records of its (`scope_string`, `scoped_id`) have its date | `daily_limit` |

The **date** `d` of a record is the date in its challenge. Order is always by
`seq`, never by date. Dates can step backwards by a day around midnight,
because the challenge is dated when it is issued.

## State of a card in a scope

For each (`scope_string`, `scoped_id`), starting empty:

| Item | Meaning | Initially |
|---|---|---|
| `current` | The account the slot is declared to now, or none | none |
| `last_declared` | The account of the last valid `declare`, kept after a withdrawal | none |
| `switch_dates` | A list with one entry, the date, per valid switch. Two switches on the same day are two entries. A blocked switch adds nothing | empty |
| `last_card_proof` | The latest date among the valid records | none |
| `proofs_on_last_date` | The number of valid records dated `last_card_proof` | 0 |

## Event rules

**`declare` of account `u` on date `d`**:

| Condition | Kind | Effect |
|---|---|---|
| `last_declared` is none | `first` | `current = u`, `last_declared = u` |
| `last_declared = u` | `refresh` | `current = u` |
| otherwise, and fewer than 2 entries of `switch_dates` are on or after `d − 364 days` | `switch` | `current = u`, `last_declared = u`, append `d` to `switch_dates` |
| otherwise | invalid, `switch_limit` | none |

**`withdraw` of account `u` on date `d`**:

| Condition | Kind | Effect |
|---|---|---|
| `current = u` | `withdraw` | `current = none`; `last_declared` unchanged |
| otherwise, including a card with no earlier record | invalid, `not_current` | none |

The effects in the two tables apply only if check 6 also passes. A record
that the event rules would accept, but that is the fourth of its card, scope
and date, is invalid with `daily_limit` and changes nothing.

**Every valid record**: `last_card_proof = max(last_card_proof, d)`, and
`proofs_on_last_date` follows from it.

What follows from these rules:

- A switch is a declaration to a different account than the last one
  declared, whether or not there was a withdrawal in between. Withdrawing and
  then declaring another account is a switch. A → B → A is two switches.
- Withdrawing and then declaring the same account again is a refresh, not a
  switch. So is declaring again the account a blocked switch tried to leave:
  an invalid record does not change `last_declared`.
- A first declaration is not a switch.
- At most 2 switches in any 365 days: the window counts the earlier switches
  dated from `d − 364` on, including any dated after `d`. Those occur only
  around midnight, or when dates are written into the future (next section).
- There is no free correction of a mistyped account. Correcting it uses a
  switch.
- One card is declared to at most one account at a time in a scope. One
  account can be declared by any number of cards.
- One card has at most 3 valid records per date in a scope, whatever their
  kinds. Three leaves room to declare, correct a mistyped account and
  withdraw on the same day; the limit keeps a single card from filling the
  roster. A day is a date in Taiwan, as in every challenge. Records blocked
  by another rule do not count, and the server does not append them anyway.

## How far dates are trusted

The rules take each record's date from its challenge, and the card's
signature covers the challenge. Neither the server nor anyone else can change
a date after the card signed. But the server chooses the date when it issues
the challenge, and a modified device would sign a challenge with any date on
which the certificate is valid. Records dated a year apart could then give
one card more switches than the rules allow, and one record dated years ahead
would keep the card looking recent until then. Two checks bound this.

- **Into the future: at most 3 days** (check 3). A record's date is at most
  3 days after the date of the CRL behind its root, and MOICA has not signed
  future CRLs.
- **Into the past: at most 4 days** (check 4), relative to the records
  already in the roster. The 4 days cover a record dated the full 3 days
  ahead, plus one day around midnight, so an honest record is never caught by
  a record dated ahead of it. Check 3 alone would not stop dates in the past:
  old CRLs stay recognized so that old records keep verifying.

Both bounds are far below the 365-day window, so dating cannot buy extra
switches. Within the bounds, an operator working with a modified device can
make a card's `last_card_proof` look up to 3 days more recent than it is.
If the bound of check 3 is ever widened, the bound of check 4 widens with it
(one day more).

## Output

Every sort is by the byte values of the strings (ASCII order), not by a
locale's collation.

- **Per scope**, scopes sorted by scope string. A scope with no listed card
  is not listed.
- **Per card**, sorted by `scoped_id`: `scoped_id`, `current` (or none) and
  `last_card_proof`. A card with no valid record is not listed.
- **Per account**, sorted by `username`: the cards whose `current` is this
  account, sorted by `scoped_id`, each with its `last_card_proof`. An account
  with no such card is not listed.
- **Per record**, in `seq` order: valid with its kind, or invalid with its
  reason code.

There is no expiry. The rules report facts and dates. How recent a card
proof must be to count is up to whoever uses the answer, so answers always
carry the date.

## Not part of these rules

- The 10-minute lifetime of a challenge is a server rule. The roster does not
  record when a challenge was issued, so nobody else can check it.
- A card proof the server rejects under these rules is not appended, so it
  changes nothing, including `last_card_proof`.

## Test vectors

[`vectors/roster-rules.json`](vectors/roster-rules.json): sequences of events
with the outcome of each and the final state. Events stand for well-formed
records and carry only the fields the rules read. Their `verifies` field
says whether the record passes check 1. Their `crl_dates` are the CRL dates
(the date `thisUpdate` falls on in Taiwan) of the usable CRLs of the
record's issuer whose tree has the record's `smt_root`: possibly several,
possibly none.
