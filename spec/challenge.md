# Challenge

Status: **Draft**.

The challenge is the one-time string the server issues for one card proof. It
goes into the last line of the declaration code
([`declaration-code.md`](declaration-code.md)), which the card signs, so the
proof shows the card signed after the challenge was issued. It also carries
the date of the card proof: the date that the roster records and that the
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
| No server signature or MAC | It would not constrain the operator, who holds the key. Single use already requires the server to store the challenges it issued |
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

Who checks what. Only the last group can be checked from the public roster.

**The server, when issuing**

- `date` is the current date in Taiwan.
- Each challenge is issued once and stored.

**The server, when accepting a card proof**

- It issued this challenge, less than 10 minutes ago, and has not accepted a
  card proof for it before. It compares challenges as strings.

**The cardholder's device**

- It computes today's date in Taiwan from its clock's absolute time, as
  UTC+8. It does not use the time zone set on the device.
- If the challenge's date is not today, it does not start the card proof. It
  shows the reason to the cardholder and does not report it to the server.
- It sets `current_time` from its own date. This equals the value derived
  from the challenge, or it already stopped.

The server could otherwise choose the date, and through `current_time` ask
whether the certificate is valid at a time of its choice. Repeated over
several card proofs, this narrows down `notBefore` and `notAfter`, which
helps identify the cardholder.

**Anyone verifying a record**

- The challenge matches the format above, in its one spelling.
- `current_time` equals the value derived from the challenge's date.
- The challenge does not appear in an earlier record, of any card
  ([`roster-rules.md`](roster-rules.md)).

## Test vectors

[`vectors/challenge.json`](vectors/challenge.json): valid challenges with the
16 random bytes they encode, their date, `current_time` and its public input
bytes; invalid challenges with the reason.
