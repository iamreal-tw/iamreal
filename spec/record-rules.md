# Record rules

Status: **Draft**.

The proof log stores events, not states (ADR-0005). The current state of every
card and account is computed from the records by the rules below: which
account a card declares on each platform, and when the card last made a card
proof (ADR-0017). One card proof is one record, and a record states the
card's whole list of accounts ([`record.md`](record.md), "The account
list"). Anyone who
downloads a snapshot and applies these rules must get the same answer as the
server's API.

## Input

A snapshot: a log file ([`record.md`](record.md)), usually read from a
log directory ("The published proof log"). Besides the snapshot, the rules
read only fixed tables of this specification (the scopes and platforms of
[`scope.md`](scope.md), the circuits, the issuer keys) and, for check 3, the
archive of MOICA's CRLs. Nothing comes from the server.

**The file as a whole** is valid only if:

| Check | Code if it fails |
|---|---|
| Every line is well formed ([`record.md`](record.md), "Lines and files") | `line` |
| The `seq` of the n-th line is n | `seq` |

Lines are checked one at a time, in order. For each line the two checks
run in the order of the table; the first failure ends the check, and the file
is reported as broken with that line's number (counting from 1) and the
code. Bytes after the last `LF`, an empty line and a byte order mark fail the
first check on the line where they occur. The rules do not compute a state
from a broken file.

**Each record** of a valid file is valid, or invalid with one reason code.
An invalid record stays in the proof log and is listed, but changes nothing
("What an invalid record changes").
The server does not append records that would be invalid. Any invalid record
a re-verifier finds therefore shows the operator appended something it should
not have.

## Words

- A **card** is one (`scope_string`, `scoped_id`). The public proof log is one
  scope ([`scope.md`](scope.md)), so there a card is one `scoped_id`.
- A **slot** is one (card, `platform`): the card's one place on that
  platform (ADR-0017). A card has as many slots as the proof log has platforms.
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
| 4 | Its date is no earlier than 4 days before the latest date among the earlier valid records, of any card, and no earlier than its card's `last_card_proof` | `date_order` |
| 5 | The event rules below, for the state of its card | `empty` or `switch_limit` |
| 6 | Fewer than 3 earlier valid records of its card have its date | `daily_limit` |

The **date** `d` of a record is the date in its challenge. Order is always by
`seq`, never by date. Across the proof log, dates can step backwards by a day
around midnight, because the challenge is dated when it is issued. Within one
card they cannot (check 4): a card that took one challenge before midnight
and one after, and sent the later-dated one first, cannot send the earlier
one; its record is `date_order`, and the cardholder makes the card proof
again. A cardholder who takes one challenge at a time never meets this,
because the server dates each challenge with the current date.

By check 4, the earlier valid records of the card that have the date `d` are
the `proofs_on_last_date` of the card when `d` is its `last_card_proof`, and
none when `d` is later. Check 6 asks only that.

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
| `switch_count` | The number of valid switches of the slot. It never decreases | 0 |
| `correction_date` | The date of the slot's last valid `first` or `switch`. A change of account dated that same date is a correction and is not counted | none |

Within a slot, `current` and `last_declared` are a `username`; the slot's
platform makes it an account.

The card's **current list** is the `current` of its slots, for the platforms
where it is not none. After a valid record it equals that record's list.

`last_card_proof` and the daily count belong to the card: a card proof is
about the card, and every card proof signs the whole list. The switches
belong to the platform.

## Event rules

For a record with date `d`, every platform of the proof log's table
([`scope.md`](scope.md)) is looked at, whether the list has an entry for it
or not, against the state of the card's slot on that platform **before**
the record. The first row that applies gives the kind:

| Entry | Condition | Kind | Effect on the slot |
|---|---|---|---|
| `u` | `last_declared` is none | `first` | `current = u`, `last_declared = u`, `correction_date = d` |
| `u` | `last_declared = u` | `refresh` | `current = u` |
| `u` | `correction_date = d` | `correction` | `current = u`, `last_declared = u` |
| `u` | `switch_count < 5` | `switch` | `current = u`, `last_declared = u`, `switch_count` plus 1, `correction_date = d` |
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

**Every valid record**: the card's `last_card_proof = d`, which check 4
makes no earlier than it was. `proofs_on_last_date` grows by 1 if `d` was
already the `last_card_proof`, and is 1 otherwise.

A valid record always has at least one kind. `refresh` covers both an
account that stays (the entry equals `current`) and an account declared
again after a withdrawal (`current` was none, the entry equals
`last_declared`).

### Switches and corrections

**A card has 5 switches on each platform, for good.** `switch_count` only
grows. Nothing gives a switch back: not time, not a withdrawal, not
declaring the earlier account again. A sixth switch is blocked, and stays
blocked.

**A correction is a change of account on the day the account was put
there.** If the slot's last `first` or `switch` has the record's own date,
changing the account again is a `correction`: it is not counted and it is
never blocked. This is for a mistyped account noticed the same day.

Exactly what a correction depends on:

- **Only a `first` or a `switch` opens the day.** A `refresh`, a
  `withdraw` and a `correction` do not set `correction_date`. Withdrawing
  an account and declaring it again today therefore does not make the next
  change free.
- **The dates must be equal**, not merely close: `correction_date = d`,
  both taken from challenges. A change on the next date is a switch, also
  one minute after midnight. Around midnight a record can carry the earlier
  date (its challenge was issued before midnight); then it is compared with
  that earlier date, like everything else in these rules.
- **The switch that opened the day stays counted.** A → B is a switch; B → A
  on the same date is a correction. The count is 1, although the slot is
  back where it was. Nothing uncounts a switch: if going back did, a card
  could lend its slot to another account every day and take it back before
  midnight for nothing.
- **A correction has no count of its own**, but check 6 allows a card 3
  valid records per date, so a `first` or a `switch` is followed by at most
  2 corrections.
- A correction after a `switch` that used the fifth switch is still a
  correction.

What a card can hold over its lifetime on one platform is therefore at most
6 accounts from one date to the next: the first, and one per switch.
Corrections add accounts that were replaced on the date they were put
there.

## What follows from these rules

About one platform:

- **A withdrawal is a list without the account.** There is no withdrawing
  action, and nothing to name wrongly: whatever the card declared on a
  platform the list leaves out is withdrawn.
- A switch is an entry different from the last account declared on that
  platform, on a later date than the slot's last `first` or `switch`,
  whether or not there was a withdrawal in between. Withdrawing and then
  declaring another account is a switch. A → B → A on three different dates
  is two switches.
- Withdrawing and then declaring the same account again is a refresh, not a
  switch. So is declaring again the account a blocked switch tried to leave:
  an invalid record does not change `last_declared`.
- A first declaration is not a switch.
- At most 5 switches, ever, on each platform ("Switches and corrections").
- One card is declared to at most one account at a time on a platform. One
  account can be declared by any number of cards.

About the card:

- **Every card proof restates every account.** A valid record signs the
  whole list, so `last_card_proof` is the date on which the card last
  named each account it declares now. There is no account that stays in
  the state without having been in the card's last valid record.
- **One record can change every platform**: a first declaration on one, a
  switch on another, a withdrawal on a third. Each switch is counted on its
  own platform; a switch on one uses none of the switches of another, and a
  `first` or `switch` on one opens no correction on another.
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
  and no account; its slots keep `last_declared`, `switch_count` and
  `correction_date`. Nothing resets by withdrawing.
- **One card has at most 3 valid records per date**, whatever they change.
  One record covers every platform, so three leave room to declare, correct
  a mistyped account and withdraw on the same day; the limit keeps a single
  card from filling the proof log, and does not grow with the number of
  platforms. A day is a date in Taiwan, as in every challenge. Records
  blocked by another rule do not count, and the server does not append them
  anyway.
- **The dates of a card's valid records never go back.** Taken in `seq`
  order, each is the same as the one before or later (check 4). So
  `last_card_proof` is the date of the card's last valid record, and the
  only date whose count can still grow is that one.
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

- not any slot's `current`, `last_declared`, `switch_count` or
  `correction_date`, on any platform, including the platforms where its
  list asked for nothing new;
- not the card's `last_card_proof` or `proofs_on_last_date`;
- not the latest valid date of the proof log that check 4 compares with.

So a list with one change that is not allowed cannot carry another change
through, cannot make the card look recent, cannot use up a switch or a place
in the daily count, cannot open a correction, and cannot push the dates of
later records.

The checks run in order, so only a record that every other check accepts
can get `daily_limit`: it verifies, its challenge is new, its root is
recognized, its date is in order, and the event rules would accept it. A
record that is `empty` or `switch_limit` is never counted towards the 3 of
its card, and never reported as `daily_limit`.

A list that cannot be read in one way is not an invalid record: a platform
outside the table, a platform twice, accounts out of order, a `username`
outside the format of its platform make the line malformed and the whole
file broken ([`record.md`](record.md), "The account list"). The rules only
ever see lists with at most one entry per platform, each `username` in the
format of its platform. An implementation of the rules that is handed a
list with any of these four stops with an error before check 1; it does not
give the record a reason code.

## How far dates are trusted

The rules take each record's date from its challenge, and the card's
signature covers the challenge. Neither the server nor anyone else can change
a date after the card signed. But the server chooses the date when it issues
the challenge, and a modified device would sign a challenge with any date on
which the certificate is valid. One record dated years ahead would keep the
card looking recent until then, and a change dated back to the day of an
old switch would pass as a correction. Checks 3 and 4 bound this.

- **Into the future: at most 3 days** (check 3). A record's date is at most
  3 days after the date of the CRL behind its root, and MOICA has not signed
  future CRLs.
- **Into the past: at most 4 days** (check 4), relative to the records
  already in the proof log. The 4 days cover a record dated the full 3 days
  ahead, plus one day around midnight, so an honest record is never caught by
  a record dated ahead of it. Check 3 alone would not stop dates in the past:
  old CRLs stay recognized so that old records keep verifying.
- **Not before the card's own `last_card_proof`** (check 4). A card proof
  that was signed but never appended can be sent later, by whoever holds
  it. Once the card has a valid record of a later date, a record of an
  earlier date is invalid, whoever sends it. The records in the proof log are
  public, with their proofs, so anyone can also send a copy of one; a copy
  is caught by check 2, whatever its date.

The card's own bound does not replace the 4 days. A card that has made no
card proof for a long time has its `last_card_proof` on the date of its
last record, which can be the date of its last switch; a change dated back
to that date would pass the card's own bound and count as a correction.
Only the bound relative to the whole proof log stops it. It also bounds the
date of a card's first record, which has no `last_card_proof` to compare
with.

A card whose record is dated ahead cannot make a card proof with an earlier
date until that date comes. Dating a record ahead takes the operator and a
modified device together, and it holds back only that card, by at most 3
days (check 3).

Within the bounds, an operator working with a modified device can make a
card's `last_card_proof` look up to 3 days more recent than it is.
`last_card_proof` belongs to the card, so this covers the card's accounts
on every platform; the bound is the same 3 days. Checks 3 and 4 compare
dates across all cards; only the card's own bound is per card.

The same pair can make corrections on days that are not the day of the
switch, by issuing challenges with the switch's date for a few days around
it. It gains little: a date still holds at most 3 valid records of the card
(check 6), so a `first` or `switch` is still followed by at most 2
corrections, and the switch count is not a matter of dates at all. A
cardholder alone cannot do this: the server dates every challenge with the
current date.

If the bound of check 3 is ever widened, the 4 days of check 4 widen with
it (one day more).

## Output

Every sort is by the byte values of the strings (ASCII order), not by a
locale's collation.

- **Per scope**, scopes sorted by scope string. A scope with no listed card
  is not listed. A proof log has one scope with records, until a version is
  retired ([`scope.md`](scope.md)); only then does it hold records of two
  scope strings, and a card of the old one and a card of the new one are two
  cards.
- **Per card**, sorted by `scoped_id`: `scoped_id`, `last_card_proof`, its
  `ordinal` (below), and its current list, in ascending order of `platform`
  (the order of a record's list). A card with no valid record is not
  listed. A card with valid records and an empty current list is listed
  with no account.
- **Per account**, sorted by `platform`, then by `username`: the cards whose
  `current` on that platform is this `username`, sorted by `scoped_id`, each
  with its `last_card_proof`. An account with no such card is not listed.
  The number of these cards is what the API calls `account_cards`.
- **Per record**, in `seq` order: valid with its kinds, or invalid with its
  reason code. The reason code is the whole result of an invalid record. A
  tool may add an explanation for people (for `switch_limit`, which
  platform was blocked); the explanation is not part of the output.

The accounts listed under one card are the accounts that card declares. It
does not follow that they belong to one person: any cardholder can declare
any account (ADR-0003, ADR-0017).

There is no expiry. The rules report facts and dates. How recent a card
proof must be to count is up to whoever uses the answer, so answers always
carry the date.

### The ordinal

**The `ordinal` of a card** is the place of its first valid record among
the first valid records of every card of the proof log, in `seq` order,
counting from 1. The card that has the first valid record of the proof log
is 1; the next card to have a valid record is 2; and so on. The cards of
every scope string of the proof log are counted together.

- **Only valid records count.** A card whose first records are invalid gets
  its ordinal from its first valid record. A card with no valid record has
  no ordinal and takes none from the others.
- **Nothing after the card's first valid record changes it**: not another
  account, a withdrawal, declaring an account again, or later card proofs.
  A card that has withdrawn everything keeps its ordinal.
- **Another card is another ordinal**: another physical card, and also the
  same physical card under a new scope string ([`scope.md`](scope.md)),
  since a card is one (`scope_string`, `scoped_id`).
- The ordinals of a proof log are 1 to the number of listed cards, each
  once. Each proof log counts its own cards: the ordinals of the test proof
  log say nothing about those of the production proof log.
- It counts cards, not people. Nothing says two cards are not held by one
  person over the years.

A card keeps its ordinal for good: the records before its first valid
record keep their results ("Changing these rules"). Only voiding records
("When proofs can no longer be trusted") could change it.

The ordinal is computed from the results of the records alone. It is not an
item of the state ("State"): no check reads it, and the card state file
does not carry it ("The card state file"). The device does not compute it:
Rust's `device-core/` (ADR-0034), which judges a list before the card signs,
gives the rest of this output and not the ordinal. It only reads the one the
server answers a submission with, for the text it suggests for sharing
([`records-response.md`](records-response.md)). Go's `prooflog/` and
TypeScript's `protocol/` give it, and the server keeps it with the tables
its pages read (`worker/`), whose ordinals its tests compare with Go's.

## Not part of these rules

- The 10-minute lifetime of a challenge is a server rule. The proof log does not
  record when a challenge was issued, so nobody else can check it.
- A card proof the server rejects under these rules is not appended, so it
  changes nothing, including `last_card_proof`.
- **The server may decline to append a record these rules would accept.**
  That is a rule of the server, not of the proof log: a record that is in
  the proof log is judged by these rules only.
  Such a rule of the server is not covered by "Changing these rules": when
  it changes, no record already written changes.
- Which platforms exist is a table of [`scope.md`](scope.md), not something
  computed from the records. A record that lists a platform outside the
  table is a malformed line, not an invalid record.
- A record does not say which state of the card the cardholder saw before
  signing. Two card proofs of one card made from the same earlier state are
  applied in `seq` order, and the later list replaces the earlier.

## The card state file

The server does not compute the state of a card from the first record each
time: it keeps the state of every card, and judges the next record of a
card against the state it kept. A kept state that is wrong would accept
records that cannot be taken out of the proof log. So once a day the server
publishes the states it keeps, as a **card state file**, and a re-verifier
compares them with the states it computes itself from the proof log
(ADR-0025). The file is there to be checked. Nobody takes the state of a
card from it: the state of a card is what these rules give from the
records.

A card state file belongs to one date: the date in Taiwan on which it was
written. How a file is named after its date, where it is published and how
long it is kept are not part of this specification (ADR-0027).

**The file of a date holds the state of every card after the first `count`
records**, `count` being the one in the fingerprint file's line of the same
date ([`record.md`](record.md), "The published proof log"). The count is not
written in the file, and every line of the file is a card. The server reads
the count and the states it keeps at one moment, and writes the file and
then the fingerprint line from them.

**Which cards.** Every card that has a valid record among those records has
one row, and no other card has one, as in the output ("Output"). A card
that has withdrawn everything has a row. A proof log without a valid record
gives the empty file.

A row holds the items of the state, not the card's `ordinal` ("The
ordinal"): the file shows the state the server judges records by, and the
ordinal judges no record. A re-verifier computes the ordinal from the
records.

### A row

A row is one line, in the same one-spelling form as a proof log line
([`record.md`](record.md), "Lines and files"): this template, followed by
one `LF` (`0x0A`).

```
{"scope_string":"SCOPE_STRING","scoped_id":"SCOPED_ID","last_seq":LAST_SEQ,"last_card_proof":"LAST_CARD_PROOF","proofs_on_last_date":PROOFS_ON_LAST_DATE,"slots":SLOTS}
```

| Field | Format |
|---|---|
| `scope_string` | One of the accepted scopes of this proof log ([`scope.md`](scope.md)) |
| `scoped_id` | 52 characters, in the one accepted spelling ([`scoped-id.md`](scoped-id.md)) |
| `last_seq` | The `seq` of the card's last valid record: a decimal integer from `1` to `9007199254740991` (2^53 − 1), without leading zeros |
| `last_card_proof` | The item of that name ("State"): a date, `YYYY-MM-DD`, as in a challenge ([`challenge.md`](challenge.md)): a year from `2000` to `2049`, a date that exists. Never `null`: a card with a row has a valid record |
| `proofs_on_last_date` | The item of that name: `0`, or a decimal integer without leading zeros, at most `9007199254740991` |
| `slots` | The slots of the card, below |

The names are those of "State", and one more: `last_seq`. An invalid record
changes no state, so it is never the `last_seq` of its card.

```
SLOTS = "{" "}"
      | "{" SLOT { "," SLOT } "}"
SLOT  = "PLATFORM":{"current":CURRENT,"last_declared":LAST_DECLARED,"switch_count":SWITCH_COUNT,"correction_date":CORRECTION_DATE}
```

| Part | Format |
|---|---|
| `PLATFORM` | One of the platform IDs of this proof log, exactly as in the platform table ([`scope.md`](scope.md)) |
| `current`, `last_declared` | `null` for none; otherwise the `username` in double quotes, in the `username` format of the slot's platform ([`scope.md`](scope.md)) |
| `switch_count` | `0`, or a decimal integer without leading zeros, at most `9007199254740991` |
| `correction_date` | `null` for none; otherwise the date in double quotes, `YYYY-MM-DD` as above |

- **Only the slots that are not in the initial state are listed.** A slot
  is in the initial state when all four of its items have their initial
  value ("State"): `current`, `last_declared` and `correction_date` none,
  `switch_count` 0. Such a slot is never listed, and every other slot of
  the card is. A platform that is not in `slots` therefore is a slot in
  the initial state, and the row of a card does not change when a platform
  is added to the table ([`scope.md`](scope.md), "Adding a platform").
  In these rules a slot in the initial state and no slot are the same
  thing: a card has a slot on every platform, and its slots on the
  platforms where no valid record of the card has had a kind are in the
  initial state.
- **Order**: the slots are in ascending order of `PLATFORM`, compared by
  byte values, each strictly greater than the one before it. So no platform
  appears twice.
- None is `null`, without quotes. A string is never `null`'s spelling of
  none: no `username` format allows the empty string, and `"null"` is a
  `username` like any other where its platform's format allows it.
- Inside a slot the keys are `current`, `last_declared`, `switch_count`,
  `correction_date`, in this order, all four. No whitespace, no escape
  sequence, no other key.

The template needs no escape sequence: a scope string, a scoped ID, a date
and a platform ID are printable ASCII without `"` or `\`, and none of the
`username` formats allows `"`, `\`, a control character or a non-ASCII
character ([`scope.md`](scope.md), "The `username` format"). A platform
whose format allowed one of them could not be added without changing this
template and the record's.

**Check a row** like a proof log line: parse it in any way, check every value
against the tables, then write the row again from the template, with its
slots in ascending order of `PLATFORM` and without any slot in the initial
state, and compare bytes. The row's bytes up to and including its `LF` must
equal what was written. If they differ, the row is malformed. This one
comparison rejects everything JSON would otherwise allow (other key orders,
whitespace, escapes, duplicate keys, a platform twice, numbers written as
`1.0` or `1e0`, lines ending in `CR LF`), slots in another order, and a
slot in the initial state that is listed.

**The format checks each value by itself**, not whether the row is a state
these rules can leave. Under these rules a listed slot always has a
`last_declared` and a `correction_date`, and only `current` can be none; a
card with a row has at least one slot listed; `proofs_on_last_date` is 1 to
3 and `switch_count` at most 5. A row that says otherwise (a
`correction_date` of `null` beside a `last_declared`, a `switch_count` of
6) is well formed. It is equal to no state a re-verifier computes, so the
comparison below reports its card. The file exists to show a wrong kept
state, and a format that refused to write one would hide it.

### The file

A card state file is its rows concatenated, in order of `scope_string`,
then of `scoped_id`, both compared by byte values (the order of "Output").
`scoped_id` is compared as the text it is written as, not as the number it
encodes. It has no byte order mark and no empty lines, and its last byte is
the `LF` of the last row. A file without rows is the empty file. Every byte
of a valid file is ASCII.

The file is valid only if:

| Check | Code if it fails |
|---|---|
| Every line is a well-formed row | `line` |
| The card of every row after the first is after the card of the row before it, in the order above | `order` |

Lines are checked one at a time, in order. For each line the two checks run
in the order of the table; the first failure ends the check, and the file
is reported as broken with that line's number (counting from 1) and the
code. Bytes after the last `LF`, an empty line, a byte order mark and bytes
that are not UTF-8 fail the first check on the line where they occur; a
line is the bytes up to and including the next `LF`, before any decoding.
The file is checked as bytes: decoding it as text first can drop a byte
order mark or replace bytes, and a broken file then reads as valid. The
same card in two rows fails the second check on the later row, whether or
not the two rows say the same. A broken file is not compared.

The same states therefore have one file: the same cards with the same
items give the same bytes.

The file carries no version number of these rules. The server computes
states with one version: when the states it keeps were computed by another
number than the code running, it accepts no card proof until they are
rebuilt ("The version number").

### Comparing

A re-verifier compares a valid card state file with its own computation.
It needs:

- `count`: the count in the fingerprint file's line of the file's date,
  as that line is written. Whether the line's fingerprint is right is a
  check of the fingerprint file ([`record.md`](record.md)), reported by
  itself. The file is not compared when there is not exactly one such
  line, counting only lines written to the fingerprint file's template
  (a line that is not is a problem of the fingerprint file). With none, there is nothing to say which records the file covers;
  that is not a difference, because the file is written before its line
  (ADR-0027). With two or more, the fingerprint file is broken, and that
  is what the re-verifier reports.
- N: the number of records, from the first, the re-verifier has applied
  these rules to. N can be less than `count` (the re-verifier is behind the
  file), equal to it, or more (the proof log has grown since).
- Its own state of every card that has a valid record among those N
  records, and for each the `seq` of its last valid record: the card's own
  `last_seq`, which is at most N.

Every card that has a row, or a valid record among the N records, or both,
gets one outcome, by the first line that applies:

| # | Condition | Outcome |
|---|---|---|
| 1 | The card has a row, and the row's `last_seq` is greater than `count` | `different` |
| 2 | The card has a row, and the row's `last_seq` is greater than N | `skipped` |
| 3 | The re-verifier has the card, and its own `last_seq` is greater than `count` | `skipped` |
| 4 | The card has a row, and the re-verifier has no valid record of it | `different` |
| 5 | The re-verifier has the card, and the file has no row for it | `different` |
| 6 | The row and the re-verifier's state are equal | `same` |
| 7 | otherwise | `different` |

The row and the state are equal when `last_seq`, `last_card_proof`,
`proofs_on_last_date` and, on every platform of the table, the four items
of the slot are equal; a platform the row does not list, or the
re-verifier's state has no slot for, is a slot in the initial state.

**Any `different` fails the comparison**, and the re-verifier names the
card (ADR-0025). **`skipped` is not a failure**: the card is compared with
a later N or in a later file.

Why each line is there:

1. **No row is beyond `count`.** The file holds the states after the first
   `count` records, so the last valid record of a card in it is one of
   those. A row that names a later record is not such a state, whatever N
   is and whether or not that record is a valid record of the card. Without
   this line, a server that kept something else than a `seq` as `last_seq`
   (a time, a number larger than the proof log) would have every row skipped
   by line 2 on every day, and the comparison would pass having compared
   nothing.
2. **The re-verifier is behind the file.** The row's state comes from a
   record between N and `count` that the re-verifier has not reached. It
   is compared once N is at least the row's `last_seq`. This line applies
   only when N is less than `count`.
3. **The card changed after the file.** Its own last valid record is after
   `count`, so the re-verifier's state of it is not the state the file was
   to hold; the file of a later date has it. Nothing is said about the row,
   present or not. This line applies only when N is greater than `count`.
4. **The server keeps a state no record gave.** The row's `last_seq` is at
   most N, and among those N records the proof log has no valid record of the
   card.
5. **A card whose last valid record is at or before `count` has a row.**
6. and 7. Both sides are now the card's state after the first `count`
   records: the row by what the file is, the re-verifier's because the
   card has no valid record after its own `last_seq`, which is at most
   `count`. Every item must be equal, `last_seq` included. A row that
   names an earlier record than the card's last valid one is `different`:
   the file missed a record it was to cover. That is so once N is at least
   `count`. With a smaller N the re-verifier's state is the card's after
   the first N records only, and `same` is not yet the last word: a valid
   record of the card between N and `count` that the row missed shows as
   `different` when N has reached it.

The outcome of a card is one of the seven lines for every combination of
a row or none, the row's `last_seq` against `count` and N, a state of the
re-verifier's or none, and its own `last_seq` against `count`.

**When N equals `count`, no card is skipped**: line 2 needs a row beyond N
that is not beyond `count`, and line 3 an own `last_seq` beyond `count`,
which is beyond N. Every card is then `same` or `different`, and whatever
the server kept wrongly for the first `count` records shows as
`different`: a card left out (line 5), a card no record gave (line 1 or
4), a valid record missed or a `last_seq` too small (line 7), a `last_seq`
too large (line 1 or, up to `count`, line 7), any other item (line 7). A
re-verifier that has verified the published proof log up to the last line of
the fingerprint file, and compares the file of that line's date, has N
equal to `count`. With another N, the cards of lines 2 and 3 wait.

## Changing these rules

These rules may change after launch. A change keeps two things of every
record already written (ADR-0031):

- its result: valid or invalid, its kinds, its reason code;
- its line: still well formed.

**By default a change applies to every record**, including the ones already
written. It may do so only if, under the new rules, every record already
written gets the same result as under the old ones; the old version can
then be dropped. If any record gets a different result, the new rules take
effect from an **effective date** `D` instead: a record dated `D` or later
is judged by the new version, a record dated before `D` by the old one. The
date is the record's date, the date in its challenge, as everywhere in
these rules.

- **Once an effective date is used, every version stays.** Computing the
  state from the first record, or rebuilding the state of every card from
  the records, picks the version for each record by its date. Every
  implementation of these rules (ADR-0030, ADR-0034) keeps every version
  for good.
- **A card never goes back from a new version to an old one.** The dates of
  a card's valid records only stay the same or move forward, by the
  condition of check 4 on the card's own `last_card_proof` (ADR-0024). A
  record of the card dated earlier can still be written; it is invalid,
  with `date_order`. Records of different cards dated before and after `D`
  can interleave in `seq` order; the result is still fixed.
- **`D` is at least 3 days after the deploy to the production site**, and is
  announced on the site when the change is merged. There is no other
  period of notice. If the deploy cannot be made in time, another change
  moves `D` later, before `D` arrives.
- **Whether the results are the same is a comparison, not a judgement.**
  Before a change is merged, the latest production log is computed under
  the old and the new version and compared record by record
  ([`CONTRIBUTING.md`](../CONTRIBUTING.md)). If every result is the same,
  the change applies to every record; otherwise it has an effective date.
  After the deploy, the re-verification from the first record that a new
  version number of these rules starts (ADR-0025) is the last check. If a
  record written between that proof log and the deploy gets a different
  result, the operator stops accepting card proofs, goes back to the code
  of the old version, and makes the change again with an effective date.

These rules do not have a table of versions yet (which version applies from
which date). It is added the first time an effective date is needed, and
adding it changes the result of no record. A version is numbered by the
version number of these rules ("The version number").

The tables of [`scope.md`](scope.md) that these rules read only widen and
grow, so that every record already written stays well formed ("Changing
the tables").

### The version number

These rules have a version number, a positive integer.

**These rules are version 2.**

Each implementation of these rules has the number as a constant
(`RulesVersion` in Go's `prooflog/`, `RULES_VERSION` in TypeScript's
`protocol/` and in Rust's `device-core/`), and the test vectors carry it
(`rules_version`). The tests of every implementation check their constant
against the sentence above and against the vectors.

What the number is for: a state of a card that is stored, not recomputed,
was computed by one version of these rules. The server stores with its card
states the number they were computed by; when that is not the number of the
code running, it stops accepting card proofs until the states are rebuilt
from the records. A new number also starts a re-verification of the proof log
from its first record (ADR-0025).

**The number goes up by one with every change to these rules**: a change
that can give any record another result (valid or invalid, its kinds, its
reason code), or that changes which items the state of a card has or what
an item means. That is every change to "Per record", "State" and "Event
rules", and to the numbers in them: the 3 records a date, the 5 switches,
the 4 days of check 4, the bounds of check 3
([`revocation-tree.md`](revocation-tree.md)). Whether the change applies to
every record or from an effective date makes no difference to the number.
The specification, the vectors and every implementation change in the same
pull request (ADR-0030, ADR-0034).

This is on purpose also for a change that leaves every stored state as it
was, such as another number for a limit: the number goes up, and the server
stops accepting card proofs until its states are rebuilt. Nobody then has
to judge whether a change makes the stored states wrong, where a wrong
judgement means records accepted on a wrong state that cannot be taken out
of the proof log; and only a new number starts the re-verification from the
first record (ADR-0025, ADR-0031).

**It also goes up when an implementation is corrected**: when one of them
gave a record a result, or a card a state, that these rules do not give,
and states computed by it may be stored. The text of these rules does not
change then; the number does, because the stored states cannot be trusted
(ADR-0025). For now only the server stores states, so this is the case of
an error in the server. Correcting an error in Go's `prooflog/` does not
change the number: nothing stored was computed by it, and the new version
of the re-verification command starts the re-verification from the first
record (ADR-0025).

The number stays when nothing a record or a stored state could show has
changed:

- the wording of this document, and test vectors added for behaviour that
  did not change;
- a platform added to the table of [`scope.md`](scope.md), or a `username`
  format widened: the slot of a new platform starts empty, and a stored
  state that has no slot for it reads as the empty slot;
- the rules of the server that are not these rules ("Not part of these
  rules");
- an item of the output computed from the results of the records alone,
  such as the `ordinal` ("The ordinal"): it gives no record another result,
  and it is not an item of the state;
- an implementation rewritten without changing any result or any state.
  The pull request says why the stored states are not affected
  ([`CONTRIBUTING.md`](../CONTRIBUTING.md)).

### When proofs can no longer be trusted

This is the one exception. If a circuit lacks a constraint, if Barretenberg
accepts a proof it should not, or if a MOICA issuer key leaks, someone can
make valid proofs in bulk. Forged records then re-verify like real ones,
and the promise above cannot keep them valid for good. The records of one
circuit, or all the records, may then be voided:

- **The condition can be computed from public data only.** For now it is
  either "the records of this circuit" (every record carries its own
  `circuit`) or "all the records". Never a range of dates, because nobody
  knows from which day the flaw was used. Never single records the operator
  judges to be forged, because a re-verifier cannot check that judgement.
- The operator first stops accepting card proofs (ADR-0025). Whether to
  void records in bulk and keep the scoped IDs, or to start over with a new
  scope string ([`scope.md`](scope.md), "Starting over"), depends on the
  flaw, and is decided in an ADR of its own.
- The mechanism for voiding is added when it is needed. This exception and
  its limits are written in these rules from their first version.

## Test vectors

[`vectors/record-rules.json`](vectors/record-rules.json): cases, each a
sequence of events with the outcome of each and the final state.

- `rules_version` is the version number of these rules the cases were
  written for ("The version number").
- `proof_log` says which proof log the case is: `production` or `test`. It
  decides the platform table the event rules go through
  ([`scope.md`](scope.md)).
- Events stand for well-formed records and carry only the fields the rules
  read. `date` repeats the date of `challenge`. `verifies` says whether the
  record passes check 1. `crl_dates` are the CRL dates (the date
  `thisUpdate` falls on in Taiwan) of the usable CRLs of the record's issuer
  whose tree has the record's `smt_root`: possibly several, possibly none.
- A valid outcome has `kinds`: the (`platform`, `kind`) pairs, in ascending
  order of `platform`. An invalid one has the reason code.
- The final `state` is the output ("Output"), with two additions per card
  that are items of the state, not of the output: `proofs_on_last_date`,
  and `slots`, one per platform of the table with the items of the slot.
  They are there so that a case can show that an invalid record left every
  slot as it was.
- `ordinals`: every card of the output with its `ordinal` ("The ordinal"),
  in ascending order of ordinal. They are beside `state`, not in its cards,
  so that `device-core/`, which does not give the ordinal, compares `state`
  alone.
- Every case has one scope string. Cases with two scope strings in one
  proof log belong to retiring a scope and will be added with it.

[`vectors/card-state-file.json`](vectors/card-state-file.json), for "The
card state file":

- `rules_version` is the version number of these rules the files below
  that come from `record-rules.json` were computed by ("The version
  number"). When the number goes up, those files are computed again.
- `files`: card state files, valid or broken, each with the `proof_log` it is
  read with. A valid one has its bytes (`content`) and its rows as states
  (`cards`, in the order of the file; `slots` has exactly the slots the row
  lists), so that both writing and reading can be tested. A broken one has
  the first line that fails and the code. A file whose bytes are not UTF-8
  has them as hex digits (`content_hex`) in place of `content`.
- Some valid files are the final state of a case of
  `record-rules.json`, named by `record_rules_case`: the case's cards
  without `accounts` and without the slots in the initial state, each with
  the `seq` of its last valid result as `last_seq`.
- One valid file has rows that are well formed but are not states these
  rules leave (`rules_leave` false).
- `comparisons`: a file, its `count`, the number of records the re-verifier
  has applied the rules to (`verified`), its own cards (`computed`), and
  the outcome of every card ("Comparing").
- Every file has one scope string, like the cases above: a proof log accepts
  one until a scope is retired. Files with rows of two scope strings will
  be added with it.
