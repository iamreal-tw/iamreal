# Challenge

Status: **Draft**.

The challenge is the one-time string the server issues for one card proof. It
goes into the last line of the declaration code
([`declaration-code.md`](declaration-code.md)), which the card signs, so the
proof shows the card signed after the challenge was issued. It also carries
the date of the card proof: the date that the proof log records and that the
validity check of the certificate uses (ADR-0008).

A challenge is not issued for a platform, an account or a card. What it is
used for is fixed only by the declaration code the card signs, which names
the scope and the card's whole list of accounts. One challenge is one
record, whatever the list.

## Format

```
challenge = date "." random
date      = YYYY "-" MM "-" DD
random    = 26 characters of the Crockford base32 alphabet
```

- 37 ASCII characters in total. Nothing before or after: no whitespace, no
  line feed.
- `date` is a calendar date in Taiwan (UTC+8, no daylight saving time), with
  a four-digit year from `2000` to `2049`, a two-digit month and a two-digit
  day. It must be a date that exists (`2026-02-29` is not one).
- `random` is the base32 encoding ([`README.md`](README.md)) of 16 bytes from
  a cryptographically secure random generator: 128 bits, 26 characters. The
  last character carries two padding bits, which must be zero: decoding and
  re-encoding gives the same string. So the last character is one of
  `0 4 8 C G M R W`, and one challenge has one spelling.
- Uppercase only. The alphabet excludes `I`, `L`, `O` and `U`.

As a regular expression, matched against the whole string:

```
[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9A-HJKMNP-TV-Z]{25}[048CGMRW]
```

Match the whole string, not a line: in several languages `^…$` also accepts
a trailing line feed. Then check the date separately.

Example: `2026-11-16.000G40R40M30E209185GR38E1W`.

### Why this format

| Choice | Reason |
|---|---|
| Date first, readable | Anyone reading a record sees the date without decoding anything |
| Fixed length | Easy to check; no question of where the challenge ends |
| Only digits, uppercase letters, `-` and `.` | Contains no line feed, so it can be the last line of the declaration code without ambiguity |
| 128 random bits | Cannot be guessed, and two issued challenges do not collide |
| No server signature or MAC | It would not constrain the maintainer, who holds the key. Single use already requires the server to store the challenges it issued |
| Years 2000 to 2049 | `current_time` keeps only two year digits, and the circuit reads only `UTCTime`, whose years `00` to `49` mean 2000 to 2049 (ADR-0008) |

## The date and `current_time`

The proof has a public input `current_time` (ADR-0008): the time the
certificate must be valid at, as the decimal integer `YYMMDDHHMMSS` in UTC.
It is always the last second of the challenge's date in Taiwan:

```
current_time = YY MM DD 155959
```

where `YY` is the year modulo 100 and `MM`, `DD` are taken from the
challenge. `15:59:59` UTC is `23:59:59` in Taiwan. It is an integer, not a
string: for 2000 to 2009 it has fewer than 12 digits (`2001-01-01` gives
`10101155959`). As a public input it is a 32-byte big-endian integer.

`2026-11-16.…` gives `current_time = 261116155959`, public input
`…003ccbbc5837`.

A certificate therefore passes on the last day of its validity and fails the
next day, whatever time of day the card proof is made.

## Rules

Who checks what. Only the last group can be checked from the public proof log.

**The server, when issuing**

- `date` is the current date in Taiwan.
- Each challenge is issued once and stored.

**The server, when accepting a card proof**

- It issued this challenge, less than 10 minutes ago, and has not accepted a
  card proof for it before. It compares challenges as strings.

**The cardholder's device**, before the card signs anything with the
challenge. It may ask for the challenge some minutes before
([`docs/api/card-proof.md`](../docs/api/card-proof.md),
`POST /api/v1/challenges`); it makes these checks on the challenge it has
the card sign:

- It computes today's date in Taiwan from its clock's absolute time, as
  UTC+8. It does not use the time zone set on the device.
- If the challenge is not in its one spelling, it stops with
  `challenge_malformed`. This comes first: a string that is not a challenge
  has no date to compare.
- If the challenge's date is not today, it stops with
  `challenge_not_today`, whether the date is earlier or later. The date
  in Taiwan may have changed while the challenge was on its way: one second
  after midnight, the challenge of the day before is not today's.
- When it stops, it does not start the card proof. It shows the reason to
  the cardholder and does not report it to the server.
- It sets `current_time` from its own date. This equals the value derived
  from the challenge, or it already stopped.
- If today is not the date its other checks were made on (midnight passed
  since the card was read), it makes the checks that depend on the date
  again on today before the card signs
  ([`device-checks.md`](device-checks.md): the certificate's validity and
  the CRL's age).

| Code | The challenge |
|---|---|
| `challenge_malformed` | Not a challenge in its one spelling |
| `challenge_not_today` | In its one spelling, and its date is not today in Taiwan by the device's clock |

The server could otherwise choose the date, and through `current_time` ask
whether the certificate is valid at a time of its choice. Repeated over
several card proofs, this narrows down `notBefore` and `notAfter`, which
helps identify the cardholder.

**Anyone verifying a record**

- The challenge matches the format above, in its one spelling.
- `current_time` equals the value derived from the challenge's date.
- The challenge does not appear in an earlier record, of any card
  ([`record-rules.md`](record-rules.md)).

## Test vectors

[`vectors/challenge.json`](vectors/challenge.json): valid challenges with the
16 random bytes they encode, their date, `current_time` and its public input
bytes; invalid challenges with the reason; and, in `device`, the device's
check: a challenge, the device's clock (`now`, seconds since
1970-01-01T00:00:00Z, also written as `now_utc`), today's date in Taiwan for
that clock, and the result, `ok` or the reason code. The cases sit on both
sides of midnight in Taiwan, where the date in UTC is another one.
