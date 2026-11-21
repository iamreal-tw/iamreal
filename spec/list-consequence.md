# What a list does, on the device

Status: **Draft**.

Before the card signs a list of accounts, the device shows the cardholder
the whole list that will be signed and what it does on every platform
([`docs/api/card-proof.md`](../docs/api/card-proof.md), `card-state`, "What
the device does with it"). The device computes it itself, by the roster
rules ([`roster-rules.md`](roster-rules.md)), from two answers of the
server and today's date. This document defines how the device reads those
answers and what it computes, so that every client (the web page, the
Android and iOS apps) shows the same rows for the same answers, list and
date.

What the screen says for each row is in `design/copy/`, not here. Terms
follow [`GLOSSARY.md`](../GLOSSARY.md).

## Input

- **The platform table**: the `platforms` of `GET /api/v1/config`, as the
  server sent it.
- **The card's state**: the answer of `POST /api/v1/card-state`, as the
  server sent it.
- **The platforms the device has its own definition of**: the platform IDs
  for which the client has its own name and way of writing an account
  ([`docs/api/card-proof.md`](../docs/api/card-proof.md), `config`). They
  are built into the client, never taken from the server.
- **Today**: the date in Taiwan (UTC+8) by the device's clock.
- **The cardholder's list**: one account for some of the platforms offered
  (below), at most one per platform, in ascending order of platform. A
  `username` here is any string, as the cardholder typed it after the
  client tidied it. The accounts on platforms the device does not know are
  not in it.

Every answer is one JSON value. A number is read by its value: `1` and
`1.0` are the same count. A count is a number with no fraction from 0 to
2^53 − 1.

## Reading the platform table

The table is read element by element:

1. An element that is not an object, or whose `platform` is not a platform
   ID ([`scope.md`](scope.md): 1 to 21 characters of `a-z`, `0-9`, `-`), is
   passed over.
2. Otherwise the element **names** its platform. It is a **row** the device
   can read if its `username_format` is a format in its one form
   ([`scope.md`](scope.md), "Platforms") and its `display_name` is a
   display name: a string of 1 to 100 UTF-16 code units, with no character
   below U+0020, none from U+007F to U+009F, and neither U+2028 nor U+2029.
3. The device **knows** a platform that is in a row and that it has its
   own definition of. Every other platform is one it **does not know**: a
   platform named but not in a row, a row it has no definition of, a
   platform the table does not name.

The table **cannot be read** if it is not an array, if the platforms named
are not in strictly ascending order (by byte value; a platform named twice
is not), or if no row can be read. Fields the device does not know are
ignored.

## Reading the card's state

The answer **cannot be read** unless all of the following hold:

- It is an object with `last_card_proof` (a date `YYYY-MM-DD` that exists,
  from 2000 to 2049, or null), `proofs_on_last_date` (a count), `platforms`
  (an object) and `count` (a count).
- The card's items are possible ([`roster-rules.md`](roster-rules.md),
  "State"): `proofs_on_last_date` is 0 when `last_card_proof` is null, and
  1 to 3 otherwise; and `last_card_proof` is at most 3 days after today
  (the bound of check 3).
- **Every platform the device knows that has an entry in `platforms`**:
  the entry is an object with `current` and `last_declared` (null, or a
  `username` in the row's format), `switch_count` (a count from 0 to 5) and
  `correction_date` (a date or null), and the slot is possible: `current`,
  when not null, equals `last_declared`; `last_declared` and
  `correction_date` are both null or both not; `switch_count` is 0 when
  `last_declared` is null; nothing is set when `last_card_proof` is null;
  and `correction_date` is not after `last_card_proof`.
- **Every other entry of `platforms`** (a platform the device does not
  know) is an object with `current`. When `current` is null, the entry is
  passed over. Otherwise the entry's key is a platform ID, `current` is 1 or
  more printable ASCII characters without `"` and `\`, and
  `last_card_proof` is not null; the account is **kept**.

Fields the device does not know are ignored, in the answer and in an entry
it reads.

The platforms **offered** are the platforms the device knows that have an
entry in `platforms`, in ascending order. A platform the device knows
without an entry is not offered.

## What the list does

1. Every platform of the cardholder's list must be offered. A list that
   names another platform, a platform the table does not have or one whose
   account is kept among them, is not a list for this state: it is a
   mistake of the program, and nothing is computed.
2. Every `username` of the list must be in its platform's format.
   Otherwise the result is `username`, naming the first such platform in
   ascending order.
3. **The list the card signs** is the cardholder's list with every kept
   account added, in ascending order of platform.
4. The roster rules' checks 5 and 6 ([`roster-rules.md`](roster-rules.md),
   "Event rules", and check 6) are applied to that list on today's date,
   against a card whose `last_card_proof` and `proofs_on_last_date` are the
   answer's, with one slot for each platform offered (the answer's entry)
   and one for each kept account (`current` and `last_declared` that
   account, `switch_count` 0, `correction_date` null). Checks 1 to 4 are
   the server's; the device does not compute them.
5. If the rules refuse the list, the result is the reason code: `empty`,
   `switch_limit` with the first platform blocked, or `daily_limit`. The
   list is not offered for signing.
6. Otherwise the result is the list the card signs, one **row** for every
   (`platform`, kind) of the record, in the same order, and whether this
   would be the card's first record (`last_card_proof` is null).

A row has:

| Field | Value |
|---|---|
| `platform` | The platform |
| `known` | False for a platform whose account is kept, true otherwise |
| `kind` | `first`, `refresh`, `correction`, `switch` or `withdraw` |
| `username` | The account the list has there; for `withdraw`, the account withdrawn |
| `current` | The slot's `current` before the record |
| `previous` | For `switch` and `correction`: the account replaced, `current` or, after a withdrawal, `last_declared`. Otherwise null |
| `switches_left` | For `switch`: 5 minus the slot's `switch_count` after it. Otherwise null |

A kept account is always a `refresh` with `known` false: the list keeps
it as it is.

## The card's state, as shown

Before the cardholder changes the list, the screen shows the card's state.
What it shows is computed from the same two answers, read as above, and
today's date; every client shows the same for the same answers and date.

| Field | Value |
|---|---|
| `last_card_proof` | The answer's `last_card_proof`: a date, or null |
| `days_since` | The days from `last_card_proof` to today; null without one. Negative when the date is after today (at most 3 days, by the reading above); what the screen says then is the client's, not defined here |
| `daily_limit` | True when `last_card_proof` is today and `proofs_on_last_date` is 3: the rules' check 6 refuses every list today |
| `known_platforms` | The platforms the device knows, in ascending order, offered or not |
| `rows` | One row for every platform offered and one for every kept account, in ascending order of platform |

A row of a platform offered has `platform`, `known` true, and of the
platform's entry `current`, `last_declared` and `switch_count`; then
`switches_left`, 5 minus `switch_count` (the switches the rules still
allow), and `correction_today`, true when `correction_date` is today:
declaring another account there today is then a `correction`, which uses
no switch.

A row of a kept account has `platform`, `known` false and `current`, the
account as the server sent it. The screen shows it and does not offer to
change it.

## Test vectors

[`vectors/list-consequence.json`](vectors/list-consequence.json): each case
has the two answers as the server sent them (`platforms`, `card_state`),
`today`, the cardholder's list (`accounts`) and the `result`:

- `{"unread": "platforms"}` or `{"unread": "card_state"}`: an answer that
  cannot be read;
- `{"not_offered": true}`: step 1 fails;
- `{"valid": false, "reason": …}`, with `platform` for `username` and
  `switch_limit`;
- `{"valid": true, "accounts": …, "rows": …, "first_record": …}`.

Each case also has `known_platforms`, the platforms the device has its
own definition of.

[`vectors/card-status.json`](vectors/card-status.json): each case has the
two answers, `known_platforms` and `today`, and the `result`: the fields of
"The card's state, as shown", or `{"unread": …}` as above. It is made by
`web/test/generate/card-status.ts` in the same way.

## Outside these rules

The server never sends a JSON answer with a key twice in one object, a
string with an unpaired surrogate (`"\ud800"`), a number beyond the range
of a 64-bit float or with more digits than one holds, or arrays and
objects nested more than 128 deep. How a
client reads one is not defined here, and the vectors have none: a
JavaScript client's parser reads them, `device-core/` refuses the whole
answer. The cases are made by
`web/test/generate/list-consequence.ts`, whose expected results are written
by hand and checked against `web/` before the file is written.
