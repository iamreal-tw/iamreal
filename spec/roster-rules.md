# Roster rules

Status: **Draft**.

The roster stores events, not states (ADR-0005). The current state of every
card and account is computed from the records by the rules below: which
account a card declares on each platform, and when the card last made a card
proof (ADR-0017). One card proof is one record, and a record states the
card's whole list of accounts ([`record.md`](record.md), "The account
list"). Anyone who
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
  scope ([`scope.md`](scope.md)), so there a card is one `scoped_id`.
- A **slot** is one (card, `platform`): the card's one place on that
  platform (ADR-0017). A card has as many slots as the roster has platforms.
- An **account** is one (`platform`, `username`). The same `username` on two
  platforms is two accounts.
- The **list** of a record is its `accounts`: at most one account per
  platform. The **entry** of a platform is the `username` the list has for
  that platform, or none.

## Per record

For each record, in `seq` order, the checks below run in this order. The
first one that fails gives the record's reason code, and the later checks do
not run. A record that does not verify is therefore `proof` even if its
challenge was used before; its challenge still counts as used.

| # | Check | Code |
|---|---|---|
| 1 | The record verifies ([`record.md`](record.md), "Verifying a record") | `proof` |
| 2 | Its `challenge` appears in no earlier record, valid or invalid, of any card | `challenge_reused` |
| 3 | Its `smt_root` is recognized for its `issuer` and date ([`revocation-tree.md`](revocation-tree.md)) | `root` |
| 4 | Its date is no earlier than 4 days before the latest date among the earlier valid records, of any card | `date_order` |
| 5 | The event rules below, for the state of its card | `empty` or `switch_limit` |
| 6 | Fewer than 3 earlier valid records of its card have its date | `daily_limit` |

The **date** `d` of a record is the date in its challenge. Order is always by
`seq`, never by date. Dates can step backwards by a day around midnight,
because the challenge is dated when it is issued.

**A record is valid as a whole or invalid as a whole.** There is no record
that takes effect on one platform and not on another.

## State

**Of a card**, starting empty:

| Item | Meaning | Initially |
|---|---|---|
| `last_card_proof` | The latest date among the valid records of the card | none |
| `proofs_on_last_date` | The number of valid records of the card dated `last_card_proof` | 0 |

**Of a slot**, starting empty:

| Item | Meaning | Initially |
|---|---|---|
| `current` | The account the slot is declared to now, or none | none |
| `last_declared` | The last account the slot was declared to, kept after a withdrawal | none |
| `switch_dates` | A list with one entry, the date, per valid switch of the slot. Two switches on the same day are two entries. A blocked switch adds nothing | empty |

Within a slot, `current` and `last_declared` are a `username`; the slot's
platform makes it an account.

The card's **current list** is the `current` of its slots, for the platforms
where it is not none. After a valid record it equals that record's list.

`last_card_proof` and the daily count belong to the card: a card proof is
about the card, and every card proof signs the whole list. The switches
belong to the platform.

## Event rules

For a record with date `d`, every platform of the roster's table
([`scope.md`](scope.md)) is looked at, whether the list has an entry for it
or not, against the state of the card's slot on that platform **before**
the record:

| Entry | Condition | Kind | Effect on the slot |
|---|---|---|---|
| `u` | `last_declared` is none | `first` | `current = u`, `last_declared = u` |
| `u` | `last_declared = u` | `refresh` | `current = u` |
| `u` | otherwise, and fewer than 2 entries of `switch_dates` are on or after `d − 364 days` | `switch` | `current = u`, `last_declared = u`, append `d` to `switch_dates` |
| `u` | otherwise | blocked | |
| none | `current` is not none | `withdraw` | `current = none`; `last_declared` unchanged |
| none | `current` is none | no kind | none |

Then, for the record as a whole:

| Condition | Result |
|---|---|
| A platform is blocked | invalid, `switch_limit` |
| No platform has a kind: the list is empty and the card declares no account | invalid, `empty` |
| otherwise | valid; its **kinds** are the (`platform`, kind) pairs of the platforms that have a kind, in ascending order of `platform` |

The effects apply only if the record is valid, that is, only if no platform
is blocked and check 6 also passes; then they apply on every platform at
once. A record with one blocked platform changes nothing on any platform. A
record that the event rules would accept, but that is the fourth of its card
and date, is invalid with `daily_limit` and changes nothing.

**Every valid record**: the card's `last_card_proof = max(last_card_proof,
d)`, and `proofs_on_last_date` follows from it.

A valid record always has at least one kind. `refresh` covers both an
account that stays (the entry equals `current`) and an account declared
again after a withdrawal (`current` was none, the entry equals
`last_declared`).

## What follows from these rules

About one platform:

- **A withdrawal is a list without the account.** There is no withdrawing
  action, and nothing to name wrongly: whatever the card declared on a
  platform the list leaves out is withdrawn.
- A switch is an entry different from the last account declared on that
  platform, whether or not there was a withdrawal in between. Withdrawing
  and then declaring another account is a switch. A → B → A is two switches.
- Withdrawing and then declaring the same account again is a refresh, not a
  switch. So is declaring again the account a blocked switch tried to leave:
  an invalid record does not change `last_declared`.
- A first declaration is not a switch.
- At most 2 switches in any 365 days on each platform: the window counts the
  earlier switches dated from `d − 364` on, including any dated after `d`.
  Those occur only around midnight, or when dates are written into the
  future ("How far dates are trusted"). When the two latest switches are
  both in the window, the next one is possible from 365 days after the
  earlier of the two.
- There is no free correction of a mistyped account. Correcting it uses a
  switch.
- One card is declared to at most one account at a time on a platform. One
  account can be declared by any number of cards.

About the card:

- **Every card proof restates every account.** A valid record signs the
  whole list, so `last_card_proof` is the date on which the card last
  named each account it declares now. There is no account that stays in
  the state without having been in the card's last valid record.
- **One record can change every platform**: a first declaration on one, a
  switch on another, a withdrawal on a third. Each switch is counted on its
  own platform; a switch on one uses none of the switches of another.
- **A blocked platform blocks the record.** A cardholder whose switches on
  one platform are used up can still change the others, with a list that
  puts no new account on that platform: the same account as before, or
  none. Nothing forces a change on a platform, so a record is never blocked
  by a platform the cardholder leaves alone.
- **The empty list** is valid when the card declares at least one account:
  it withdraws them all, and it moves `last_card_proof` like any valid
  record. When the card declares none, including a card with no earlier
  record, it is `empty`: such a record would state nothing. A card that
  has withdrawn everything stays in the state, with its `last_card_proof`
  and no account; its slots keep `last_declared` and `switch_dates`, and
  the 365-day windows keep running. Nothing resets by withdrawing.
- **One card has at most 3 valid records per date**, whatever they change.
  One record covers every platform, so three leave room to declare, correct
  a mistyped account and withdraw on the same day; the limit keeps a single
  card from filling the roster, and does not grow with the number of
  platforms. A day is a date in Taiwan, as in every challenge. Records
  blocked by another rule do not count, and the server does not append them
  anyway.
- **The switch limit counts per platform ID.** It holds per service only as
  long as one service has one row in the platform table
  ([`scope.md`](scope.md), "Adding a platform").
- **Another card's list changes nothing for this card.** Any card can list
  any account (ADR-0003). That adds the other card under the account in the
  output; the slots, dates and counts of this card are computed from this
  card's records only.

## What an invalid record changes

An invalid record changes one thing: its challenge counts as used (check
2). It changes nothing else, for its card or anyone:

- not any slot's `current`, `last_declared` or `switch_dates`, on any
  platform, including the platforms where its list asked for nothing new;
- not the card's `last_card_proof` or `proofs_on_last_date`;
- not the latest valid date that check 4 compares with.

So a list with one change that is not allowed cannot carry another change
through, cannot make the card look recent, cannot use up a switch or a place
in the daily count, and cannot push the dates of later records.

The checks run in order, so only a record that every other check accepts
can get `daily_limit`: it verifies, its challenge is new, its root is
recognized, its date is in order, and the event rules would accept it. A
record that is `empty` or `switch_limit` is never counted towards the 3 of
its card, and never reported as `daily_limit`.

A list that cannot be read in one way is not an invalid record: a platform
outside the table, a platform twice, accounts out of order make the line
malformed and the whole file broken ([`record.md`](record.md)). The rules
only ever see lists with at most one entry per platform.

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
on every platform; the bound is the same 3 days. Both checks compare dates
across all cards.
If the bound of check 3 is ever widened, the bound of check 4 widens with it
(one day more).

## Output

Every sort is by the byte values of the strings (ASCII order), not by a
locale's collation.

- **Per scope**, scopes sorted by scope string. A scope with no listed card
  is not listed. The public roster has one scope with records, until a
  version is retired ([`scope.md`](scope.md)).
- **Per card**, sorted by `scoped_id`: `scoped_id`, `last_card_proof`, and
  its current list, in ascending order of `platform` (the order of a
  record's list). A card with no valid record is not listed. A card with
  valid records and an empty current list is listed with no account.
- **Per account**, sorted by `platform`, then by `username`: the cards whose
  `current` on that platform is this `username`, sorted by `scoped_id`, each
  with its `last_card_proof`. An account with no such card is not listed.
  The number of these cards is what the API calls `account_cards`.
- **Per record**, in `seq` order: valid with its kinds, or invalid with its
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
  computed from the records. A record that lists a platform outside the
  table is a malformed line, not an invalid record.
- A record does not say which state of the card the cardholder saw before
  signing. Two card proofs of one card made from the same earlier state are
  applied in `seq` order, and the later list replaces the earlier.

## Test vectors

[`vectors/roster-rules.json`](vectors/roster-rules.json): sequences of events
with the outcome of each and the final state. Events stand for well-formed
records and carry only the fields the rules read. Their `verifies` field
says whether the record passes check 1. Their `crl_dates` are the CRL dates
(the date `thisUpdate` falls on in Taiwan) of the usable CRLs of the
record's issuer whose tree has the record's `smt_root`: possibly several,
possibly none.

The file still holds the vectors from before ADR-0017 (one account per
record, state per scope). It is to be regenerated for this document, with
events that carry a list and, among the sequences, at least: a list of two
accounts as a card's first record; one record with a `first` on one platform
and a `switch` on the other; a withdrawal by leaving an account out, with
the other account kept; the empty list withdrawing everything, then the
same account again as a `refresh` and another as a `switch`; the empty list
as a card's first record and after everything was withdrawn (`empty`);
switches counted per platform, with a third switch on one platform blocking
a record that also changes the other, and the other platform left
unchanged; the daily limit counted per card across changes on different
platforms; the same `username` on two platforms as two accounts; two cards
listing the same account; and an invalid record of each code leaving every
slot and `last_card_proof` unchanged.
