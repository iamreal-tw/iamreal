# The answer to a submission, on the device

Status: **Draft**.

When the server accepts a card proof it answers `POST /api/v1/records` with
status `201` ([`docs/api/card-proof.md`](../docs/api/card-proof.md),
`records`): the record's `seq` and hash, and what the record is on every
platform, and the card's ordinal. The device uses it to tell the cardholder
that the proof log has the record, puts the ordinal in the text it suggests
for sharing, and compares the rest with what its own screen said before the
card signed ([`list-consequence.md`](list-consequence.md)). This document
defines how the device reads that answer and what it compares, so that
every client (the web page, the Android and iOS apps) tells the same for
the same answer.

What the screen says is in `design/copy/`, not here. Terms follow
[`GLOSSARY.md`](../GLOSSARY.md).

The device cannot check this answer: it has no copy of the proof log. A
difference found here means that the card's state the server sent before,
or this answer, was not what the proof log holds. The record itself is
checked by anyone who re-verifies the proof log
([`record.md`](record.md), "How to verify").

## Input

- **The answer**: the body of a response with status `201`, as the server
  sent it. A response with another status is not an answer in this sense:
  the record was not accepted, and nothing here applies.
- **The rows the confirmation screen showed**: the rows of
  [`list-consequence.md`](list-consequence.md), "What the list does", for
  the list the card then signed. Of each row, only `platform`, `kind` and
  `username` are read here. They are the client's own, in ascending order
  of platform, each platform once: rows that are not are a mistake of the
  program, not a result of this document.

A status `201` means the record is in the proof log, whatever the body is.
Nothing in this document turns it into a failure: there is no result that
says the card proof did not happen.

The body is what arrived. How long a client waits for it is the client's
own (its time limits are not defined here), and so is what it does when
the body of a `201` stops arriving: it reads what it has, which may be no
bytes, or it treats the submission as unanswered and asks again in its own
way. It never tells the cardholder that the record was refused.

A client may also stop at a length of its own, at least 1 MiB (2^20
bytes); a body longer than that is read as no bytes, so nothing of the
answer is told. The server's answer is far shorter: one element of `kinds`
per platform of the list.

The body is read as UTF-8 text holding one JSON value. A number is read by
its value, and a count is a number with no fraction from 0 to 2^53 − 1, as
in [`list-consequence.md`](list-consequence.md), "Input".

## Reading the answer

1. **`seq` and `record_hash`.** The body must be a JSON object whose `seq`
   is a count of at least 1 and whose `record_hash` is a string of exactly
   64 characters of `0-9a-f`. Otherwise **nothing of the answer is told**:
   `seq`, `record_hash`, `ordinal` and `kinds` are all unknown, whatever
   else the body has. The device says only that the record was made.
2. **`kinds`.** It is read if it is an array of at least one element, every
   element is an object with
   - `platform`, a platform ID ([`scope.md`](scope.md): 1 to 21 characters
     of `a-z`, `0-9`, `-`),
   - `kind`, one of the strings `first`, `refresh`, `correction`, `switch`,
     `withdraw`,
   - `username`, a string of 1 or more printable ASCII characters (U+0020
     to U+007E) without `"` and `\`,

   and the platforms are in strictly ascending order (by byte value; a
   platform twice is not). Otherwise **the kinds are unknown**, all of
   them: an element the device cannot read is not passed over, because a
   list without it would say something else. `seq`, `record_hash` and
   `ordinal` are still told.
3. **`account_cards`**, of each element of `kinds` that was read: a count,
   or else unknown for that element alone. The other elements and the rest
   of the answer are not affected: the number only says whether other cards
   declare the same account.
4. **`ordinal`**: a count of at least 1, or else unknown. The rest of the
   answer is not affected: the number is the card's ordinal
   ([`record-rules.md`](record-rules.md), "The ordinal"), which only goes
   into the text the device suggests for sharing; without it the text has
   no number.

Fields the device does not know are ignored, in the answer and in an
element of `kinds`. The `username` is not checked against the platform's
format: the answer may name a platform the device does not know.

## Comparing with what the screen said

When the kinds are unknown, nothing is compared: there are no differences
to tell.

Otherwise the **platforms that differ** are, in ascending order, every
platform for which one of these holds:

- a row the screen showed has the platform, and no element of `kinds` does;
- an element of `kinds` has the platform, and no row the screen showed
  does;
- both do, and the `kind` or the `username` is not the same. The `username`
  is compared character by character; `alice` and `Alice` differ.

`account_cards`, and the other fields of a row (`known`, `current`,
`previous`, `switches_left`), are not compared.

## The result

| Field | Value |
|---|---|
| `seq` | The answer's `seq`, or null when nothing of the answer is told |
| `record_hash` | The answer's `record_hash`, or null likewise |
| `ordinal` | The answer's `ordinal`, or null when it is not a count of at least 1, or when nothing of the answer is told |
| `kinds` | The elements read, in the answer's order, each with `platform`, `kind`, `username` and `account_cards` (a count or null); null when the kinds are unknown |
| `mismatches` | The platforms that differ; empty when the kinds are unknown |

`seq` and `record_hash` are both null or both not. When they are null,
`ordinal` and `kinds` are null too.

## Test vectors

[`vectors/records-response.json`](vectors/records-response.json): each case
has the body's text as the server sent it (`body`, a string), the rows the
confirmation screen showed (`rows`) and the `result`, with the five fields
above.

The cases are made by `web/test/generate/records-response.ts`, whose
expected results are written by hand and checked against `web/` before the
file is written.

## Outside these rules

As in [`list-consequence.md`](list-consequence.md), "Outside these rules":
the server never sends a body that is not UTF-8 or begins with a byte order
mark, an object with a key twice, a string with an unpaired surrogate, a
number beyond the range of a 64-bit float or with more digits than one
holds, or arrays and objects nested more than 128 deep. How a client reads one is not defined here and
the vectors have none: a JavaScript client's parser reads them,
`device-core/` tells nothing of such an answer. Either way the record is in
the proof log.
