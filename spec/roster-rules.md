# Roster rules

Status: **Draft**.

The roster stores events, not states (ADR-0005). The current state of every
card and account is computed from the records by the rules below: which
account a card declares on each platform, and when the card last made a card
proof (ADR-0017). Anyone who
downloads a snapshot and applies these rules must get the same answer as the
server's API.

## Input

A snapshot: a roster file ([`record.md`](record.md)), usually read from a
roster directory ("The published roster"). Besides the snapshot, the rules
read only fixed tables of this specification (the scopes and platforms of
[`scope.md`](scope.md), the circuits, the issuer keys) and, for check 3, the
archive of MOICA's CRLs. Nothing comes from the server.

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
An invalid record stays in the roster and is listed, but changes nothing
("What an invalid record changes").
The server does not append records that would be invalid. Any invalid record
a re-verifier finds therefore shows the operator appended something it should
not have.

## Words

- A **card** is one (`scope_string`, `scoped_id`). The public roster is one
  scope ([`scope.md`](scope.md)), so there a card is one `scoped_id`,
  whatever the platform.
- A **slot** is one (card, `platform`): the card's one place on that
  platform (ADR-0017). A card has as many slots as the roster has platforms.
- An **account** is one (`platform`, `username`). The same `username` on two
  platforms is two accounts.

## Per record

For each record, in `seq` order, the checks below run in this order. The
first one that fails gives the record's reason code, and the later checks do
not run. A record that does not verify is therefore `proof` even if its
challenge was used before; its challenge still counts as used.

| # | Check | Code |
|---|---|---|
| 1 | The record verifies ([`record.md`](record.md), "Verifying a record") | `proof` |
| 2 | Its `challenge` appears in no earlier record, valid or invalid, of any card and any platform | `challenge_reused` |
| 3 | Its `smt_root` is recognized for its `issuer` and date ([`revocation-tree.md`](revocation-tree.md)) | `root` |
| 4 | Its date is no earlier than 4 days before the latest date among the earlier valid records, of any card and any platform | `date_order` |
| 5 | The event rules below, for the state of its slot (`scope_string`, `scoped_id`, `platform`) | `not_current` or `switch_limit` |
| 6 | Fewer than 3 earlier valid records of its slot have its date | `daily_limit` |

The **date** `d` of a record is the date in its challenge. Order is always by
`seq`, never by date. Dates can step backwards by a day around midnight,
because the challenge is dated when it is issued.

Checks 1 to 4 do not look at the platform beyond what verifying the record
needs. Checks 5 and 6 look only at the record's own slot: a record on one
platform is never accepted or refused because of what the card did on
another.

## State

**Of a card**, starting empty:

| Item | Meaning | Initially |
|---|---|---|
| `last_card_proof` | The latest date among the valid records of the card, on any platform | none |

**Of a slot**, starting empty:

| Item | Meaning | Initially |
|---|---|---|
| `current` | The account the slot is declared to now, or none | none |
| `last_declared` | The account of the last valid `declare` of the slot, kept after a withdrawal | none |
| `switch_dates` | A list with one entry, the date, per valid switch of the slot. Two switches on the same day are two entries. A blocked switch adds nothing | empty |
| `last_declare_date` | The date of the last valid `declare` of the slot (the last in `seq` order, of any kind), kept after a withdrawal | none |
| `proofs_on_last_date` | The number of valid records of the slot dated the card's `last_card_proof` | 0 |

Within a slot, `current` and `last_declared` are a `username`; the slot's
platform makes it an account.

`last_declare_date` is the last day on which the card signed this account's
name. `last_card_proof` can be later: it moves with the card's records on
every platform, none of which need name this account. No check reads
`last_declare_date`; it is reported so that whoever uses the answer can tell
"the card is still valid and in the cardholder's hands" from "the cardholder
named this account again".

`last_card_proof` belongs to the card because a card proof is about the
card: the certificate is valid and not revoked, and the cardholder has the
card and its PIN. That does not depend on the platform (ADR-0017). The
slot, the switches and the daily count belong to the platform.

`proofs_on_last_date` is counted against the card's date, not against the
date of the slot's own last record. A slot with no valid record on the day
of the card's last card proof has 0, even if it had three the day before.
Together with `last_card_proof` it answers "how many valid records does this
slot have today": that number if `last_card_proof` is today, 0 if it is
earlier.

## Event rules

The tables read and change the state of the record's slot only.

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
| otherwise | invalid, `not_current` | none |

"Otherwise" includes a slot with no earlier record, and an account the card
declares on another platform: a withdrawal names the platform it withdraws
from.

The effects in the two tables apply only if check 6 also passes. A record
that the event rules would accept, but that is the fourth of its slot and
date, is invalid with `daily_limit` and changes nothing.

**Every valid `declare`** (`first`, `refresh` or `switch`): the slot's
`last_declare_date = d`.

**Every valid record**, of any kind and on any platform: the card's
`last_card_proof = max(last_card_proof, d)`. The `proofs_on_last_date` of
each of the card's slots follows from it.

## What follows from these rules

Within one platform:

- A switch is a declaration to a different account than the last one
  declared on that platform, whether or not there was a withdrawal in
  between. Withdrawing and then declaring another account is a switch.
  A → B → A is two switches.
- Withdrawing and then declaring the same account again is a refresh, not a
  switch. So is declaring again the account a blocked switch tried to leave:
  an invalid record does not change `last_declared`.
- A first declaration is not a switch.
- At most 2 switches in any 365 days: the window counts the earlier switches
  dated from `d − 364` on, including any dated after `d`. Those occur only
  around midnight, or when dates are written into the future ("How far
  dates are trusted").
- There is no free correction of a mistyped account. Correcting it uses a
  switch.
- One card is declared to at most one account at a time. One account can be
  declared by any number of cards.
- One card has at most 3 valid records per date, whatever their kinds. Three
  leaves room to declare, correct a mistyped account and withdraw on the
  same day. A day is a date in Taiwan, as in every challenge. Records
  blocked by another rule do not count, and the server does not append them
  anyway.

Across platforms:

- **The slots are independent.** A record on one platform does not change
  the `current`, `last_declared`, `switch_dates` or daily count of another.
  The first declaration on each platform is a `first`. Switching the account
  on one platform uses none of the switches of another, and three records on
  one platform today leave three for each of the others.
- **The date is shared.** Every valid record on any platform moves the
  card's `last_card_proof`, and every account the card declares is listed
  with that one date. A card proof on one platform makes the card's accounts
  on every platform as recent.
- **The shared date does not say the account was named again.** A card can
  keep an account looking recent for years through records on other
  platforms, without signing that account's name once. Meanwhile the name
  may have passed to someone else on the platform. `last_declare_date` is
  the date that is about the account; the output carries both.
- **A withdrawal is a card proof like any other.** A valid withdrawal on one
  platform moves `last_card_proof`, and so the date shown for the accounts
  the card still declares on the other platforms. The card signed, with a
  valid certificate, on that day; which action it signed for makes no
  difference to that.
- **A card that has withdrawn on every platform stays in the state.** It is
  listed with its `last_card_proof` and no account. Each slot keeps its
  `last_declared` and `switch_dates`: declaring the same account again is a
  refresh, another account is a switch, and the 365-day windows keep
  running. Nothing resets by withdrawing, on one platform or on all.
- **A card declares at most one account per platform**, so at most as many
  accounts as the roster has platforms, and has at most 3 valid records per
  platform and date. The daily limit keeps a single card from filling the
  roster; the bound per card and day grows with the number of platforms.
- **The two limits count per platform ID.** They hold per service only as
  long as one service has one row in the platform table
  ([`scope.md`](scope.md), "Adding a platform").

## What an invalid record changes

An invalid record changes one thing: its challenge counts as used (check
2). It changes nothing else, for its slot, its card or anyone:

- not the slot's `current`, `last_declared`, `switch_dates`,
  `last_declare_date` or daily count;
- not the card's `last_card_proof`, so not the date of the card's accounts
  on other platforms either;
- not the latest valid date that check 4 compares with.

So a record that fails on one platform cannot make a card look recent on
another, cannot use up a switch or a place in the daily count, and cannot
push the dates of later records.

The checks run in order, so only a record that every other check accepts
can get `daily_limit`: it verifies, its challenge is new, its root is
recognized, its date is in order, and the event rules would accept it. A
record that is `not_current` or `switch_limit` is never counted towards the
3 of its slot, and never reported as `daily_limit`.

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
`last_card_proof` belongs to the card, so this covers the card's accounts
on every platform; the bound is the same 3 days, whichever platform the
record is on. Both checks compare dates across all cards and platforms.
If the bound of check 3 is ever widened, the bound of check 4 widens with it
(one day more).

## Output

Every sort is by the byte values of the strings (ASCII order), not by a
locale's collation.

- **Per scope**, scopes sorted by scope string. A scope with no listed card
  is not listed. The public roster has one scope with records, until a
  version is retired ([`scope.md`](scope.md)).
- **Per card**, sorted by `scoped_id`: `scoped_id`, `last_card_proof`, and
  the accounts it declares now: for each platform on which its `current` is
  not none, sorted by `platform`, the `platform`, `current` and
  `last_declare_date`. A card with no valid record is not listed. A card
  with valid records and no `current` on any platform is listed with no
  account.
- **Per account**, sorted by `platform`, then by `username`: the cards whose
  `current` on that platform is this `username`, sorted by `scoped_id`, each
  with its `last_card_proof` and the `last_declare_date` of that slot. An
  account with no such card is not listed.
- **Per record**, in `seq` order: valid with its kind, or invalid with its
  reason code.

The accounts listed under one card are the accounts that card declares. It
does not follow that they belong to one person: any cardholder can declare
any account (ADR-0003, ADR-0017).

There is no expiry. The rules report facts and dates. How recent a card
proof must be to count is up to whoever uses the answer, so answers always
carry the date.

## Not part of these rules

- The 10-minute lifetime of a challenge is a server rule. The roster does not
  record when a challenge was issued, so nobody else can check it.
- A card proof the server rejects under these rules is not appended, so it
  changes nothing, including `last_card_proof`.
- Which platforms exist is a table of [`scope.md`](scope.md), not something
  computed from the records. A record for a platform outside the table is a
  malformed line, not an invalid record.

## Test vectors

[`vectors/roster-rules.json`](vectors/roster-rules.json): sequences of events
with the outcome of each and the final state. Events stand for well-formed
records and carry only the fields the rules read. Their `verifies` field
says whether the record passes check 1. Their `crl_dates` are the CRL dates
(the date `thisUpdate` falls on in Taiwan) of the usable CRLs of the
record's issuer whose tree has the record's `smt_root`: possibly several,
possibly none.

The file still holds the vectors from before ADR-0017 (state per scope). It
is to be regenerated for this document, with events that carry `platform`
and, among the sequences, at least: a record on one platform moving the
date of an account on another; switches counted per platform; the daily
limit counted per platform; a withdrawal naming an account the card
declares on another platform (`not_current`); a withdrawal moving
`last_card_proof`; a card withdrawn on every platform; the same `username`
on two platforms as two accounts; `last_declare_date` staying behind while
`last_card_proof` moves; and an invalid record of each code leaving
`last_card_proof` and the other platform's slot unchanged.
