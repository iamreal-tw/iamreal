# Counts

Status: **Draft**.

A count is one event a client reports to the server: a visitor opened a
page, a card proof reached a step or stopped (ADR-0032, ADR-0039). This
document defines the table every value of a count is chosen from, and which
counts the server takes. The three clients (the web page, the Android app,
the iOS app) and the server use this one table; a thing that means the same
on two clients has one code.

What a count is used for, how long it is kept and who sees it are in
ADR-0032 and ADR-0039. The request is in
[`docs/api/card-proof.md`](../docs/api/card-proof.md), `POST /api/v1/counts`.

The codes below are a first version, set when the counts were built.
Changing a code needs no ADR. Changing the kinds of things counted, the IDs
a count carries or how long anything is kept does (ADR-0032, ADR-0039).

## A count

A count is a JSON object whose values are all strings. Its members:

| Member | Value | Which counts have it |
|---|---|---|
| `client` | A code of "Clients" | Every count |
| `event` | A code of "Events" | Every count |
| `page` | A code of "Pages" | `page` |
| `short_id` | A short ID ([`scoped-id.md`](scoped-id.md)) in its one spelling: 10 characters of the base32 alphabet, uppercase | `page`, when `page` is `card`; no other count |
| `step` | A code of "Steps", or for `duration` of "Timed steps" | `step`, `duration` |
| `reason` | A code of "Reasons" | `stop`, `retry` |
| `action` | A code of "Actions of a card proof" or "Actions of a visitor" | `action` |
| `tap` | `1`, `2` or `3`: which tap of an app's card proof (reading the certificate, signing the scope string, signing the declaration code) | `action`, when `action` is `tap_dropped`; no other count |
| `took` | A code of "Durations" | `duration` |
| `visit_id` | A visit ID | A visitor's count |
| `device_id` | A card proof device ID | A card proof's count |
| `attempt_id` | An attempt ID | A card proof's count |
| `browser` | A code of "Browsers" | Every count of the client `web`; no count of an app |
| `os` | A code of "Operating systems" | Every count of the client `web`; no count of an app |
| `browser_version` | A version number | May be in a card proof's count of the client `web` |
| `os_version` | A version number | May be in a card proof's count |
| `app_version` | A version number | May be in a card proof's count of an app |
| `reader` | A card reader's name | May be in a card proof's count of the client `web` |

- **A visitor's count** is a `page`, or an `action` whose code is of
  "Actions of a visitor". Its client is `web`.
- **A card proof's count** is a `step`, a `stop`, a `retry`, a `duration`,
  or an `action` whose code is of "Actions of a card proof".
- **An ID** (`visit_id`, `device_id`, `attempt_id`) is 16 random bytes
  written as 32 lowercase hexadecimal digits. The device makes it from its
  random source and from nothing else. When each is made and thrown away is
  in ADR-0039: a visit ID lives in one tab; a card proof device ID is
  replaced 31 days after it was made; an attempt ID is kept in memory and
  dropped when the card proof stops or is done. A card proof's count never
  carries a visit ID, and a visitor's count never a card proof device ID or
  an attempt ID.
- **A version number** is 1 to 4 parts joined by `.`, each part 1 to 5
  decimal digits: `131.0.6778.86`, `18.1`. Nothing else of a version (a
  build's name, a letter) is sent.
- **A card reader's name** is the one field the card reader's component
  reports as the reader's name, 1 to 64 characters, each an ASCII letter, a
  digit or a space. A client leaves out a name that is anything else; it
  does not shorten or rewrite it.

A count has no time (the server uses the time it received it, and keeps
that to the minute), no account, no scoped ID, nothing read from a card, a
certificate or a CRL, and no text of any error: a failure is one code of
"Reasons", chosen by the client's own program.

## Taking a count

The server takes a count, or drops it whole. It is dropped when any of
these is not so:

1. It is a JSON object, and every value is a string.
2. `client` and `event` are codes of their tables.
3. It is a count the table has: a `page` only from `web`; a `step`,
   `reason`, `action` or timed step that the table has for this client.
4. It has every member its kind of count has (the table above), each in its
   form, and no other member. The members a count "may" have can be left
   out; when present they are in their form.

A dropped count leaves nothing: the server does not keep it, count it or
log it. A count that was read is answered the same whether it was taken or
dropped.

A count that is taken is kept with its members in the order of the table
above, whatever order they came in.

## The table

### Clients

| Code | Meaning |
|---|---|
| `web` | The web page |
| `android` | The Android app |
| `ios` | The iOS app |

### Events

| Code | Meaning |
|---|---|
| `page` | A visitor opened a page |
| `step` | A card proof reached a step |
| `stop` | A card proof stopped, and is over |
| `retry` | A step did not pass and can be tried again; the card proof goes on |
| `action` | A named action |
| `duration` | How long a timed step took |

### Pages

The kinds of visitors' pages. A count of the page `card` carries the short
ID of the proof page; a count of `account` does not carry the account.
Opening the card proof page is not a `page`: it is the step `open` of a
card proof, sent with the card proof's own IDs.

| Code | Meaning |
|---|---|
| `home` | `/` |
| `card` | `/p/<short ID>`: a proof page |
| `account` | `/threads/<account>` |
| `proof_log` | `/proof-log` |
| `faq` | `/faq` |
| `verify` | `/verify` |
| `check` | `/check` |
| `prepare` | `/prepare` |
| `privacy` | `/privacy` |
| `hang` | `/hang` and everything under it |

### Steps

In the order a card proof reaches them; `config` to `tree` run together and
come in any order. A client sends each step once in a card proof, when it
is reached.

| Code | Clients | Meaning |
|---|---|---|
| `open` | web, android, ios | The card proof page was opened, or the app showed the first screen of a card proof |
| `read` | web, android, ios | The cardholder asked for the card to be read |
| `component` | web | The card reader's component answered |
| `certificates` | web, android, ios | The card returned its certificates |
| `certificate` | web, android, ios | One certificate passed the device's checks |
| `config` | web, android, ios | The server answered its `config` |
| `circuit` | web, android, ios | The circuit file matched its SHA-256 |
| `engine` | web, android, ios | The proof engine is ready |
| `crl` | web, android, ios | The CRL was fetched and checked |
| `tree` | web, android, ios | The tree was built, and the serial number is not in it |
| `checked` | web, android, ios | Every check that needs no signature passed |
| `pin` | web, android, ios | The cardholder entered the PIN |
| `scope_signed` | web, android, ios | The card signed the scope string, and the signature verified |
| `state` | web, android, ios | The server answered the card's state |
| `chosen` | web, android, ios | The cardholder chose a list, and the device showed what it would do |
| `confirmed` | web, android, ios | The cardholder confirmed the list |
| `challenge` | web, android, ios | The challenge was fetched and checked |
| `code_signed` | web, android, ios | The card signed the declaration code, and the signature verified |
| `proved` | web, android, ios | The proof was made and passed the device's own check |
| `done` | web, android, ios | The server took the record |

### Reasons

Why a card proof stopped (`stop`) or a step must be tried again (`retry`).
The client maps each of its own failures to one of these; what a card, a
reader, a browser or the server said in words is never sent.

| Code | Clients | Meaning |
|---|---|---|
| `component_unreachable` | web | The card reader's component cannot be reached |
| `no_reader` | web | The component found no card reader |
| `no_card` | web | No card in the reader |
| `popup_blocked` | web | The browser blocked the component's window |
| `nfc_off` | android, ios | NFC is turned off |
| `no_nfc` | android, ios | The phone has no NFC |
| `no_tap` | android, ios | No card was sensed in the time the phone waits |
| `tap_cancelled` | android, ios | The cardholder closed the tap |
| `other_card` | android, ios | The card of the second or third tap is not the card of the first |
| `pin_maybe_received` | android, ios | The tap broke off while the PIN was being sent: the card may have counted it |
| `channel` | android, ios | The secure channel to the card could not be made |
| `first_generation` | android, ios | A card the app cannot read |
| `pin_incorrect` | web, android, ios | The card refused the PIN |
| `card_locked` | web, android, ios | The card is locked |
| `card_error` | web, android, ios | Anything else the card, the reader or the component reported |
| `card_signature` | web, android, ios | A signature the card returned does not verify under its certificate's key |
| `no_certificate` | web, android, ios | The card returned no certificate |
| `cert_expired` | web, android, ios | The certificate has expired |
| `cert_not_yet_valid` | web, android, ios | The certificate is not valid yet |
| `cert_not_citizen_primary` | web, android, ios | Not a citizen's primary certificate |
| `cert_unsupported_format` | web, android, ios | A certificate in a format the circuit does not take |
| `cert_unknown_issuer` | web, android, ios | Neither issuer key signed the certificate |
| `cert_ambiguous` | web, android, ios | More than one certificate on the card passes every check |
| `crl_unavailable` | web, android, ios | No usable CRL could be fetched |
| `crl_hash` | web, android, ios | A CRL file's SHA-256 is not the one its name says |
| `crl_unusable` | web, android, ios | A CRL file that is not a usable CRL under the issuer key |
| `crl_rollback` | web, android, ios | A CRL older than one the device has used |
| `crl_stale` | web, android, ios | The newest CRL is too old |
| `revoked` | web, android, ios | The certificate is on the CRL |
| `artifact` | web, android, ios | A circuit or parameter file could not be fetched, or does not match its SHA-256 |
| `engine` | web, android, ios | The proof engine could not start or prove |
| `proof_check` | web, android, ios | The proof did not pass the device's own check |
| `challenge_malformed` | web, android, ios | The challenge is not in its one spelling |
| `challenge_not_today` | web, android, ios | The challenge is not dated today by the device's clock |
| `date_changed` | web, android, ios | The date changed after the list was confirmed, and the list would now do something else |
| `idle` | web, android, ios | The PIN waited longer than 5 minutes for the second signature |
| `state` | web, android, ios | A step was called out of order: a fault of the program |
| `app_too_old` | android, ios | The app is older than the minimum version |
| `username` | web, android, ios | An account typed is not in its platform's format |
| `blocked_switch_limit` | web, android, ios | The list switches a slot whose switches are used up |
| `blocked_empty` | web, android, ios | The list is empty, and the card declares no account |
| `blocked_daily_limit` | web, android, ios | The card has 3 valid records today |
| `server_network` | web, android, ios | No answer from the server |
| `server_malformed_response` | web, android, ios | An answer the device cannot read |
| `server_paused` | web, android, ios | The server answered `paused` |
| `server_rate_limited` | web, android, ios | The server answered `rate_limited` |
| `server_busy` | web, android, ios | The server answered `busy`: too many card proofs started in this minute (`config` with the mark of a start), or the proof log is overloaded (ADR-0026) |
| `server_internal` | web, android, ios | The server answered `internal` |
| `server_crl_stale` | web, android, ios | The server answered `crl_stale` |
| `server_challenge_unknown` | web, android, ios | The server answered `challenge_unknown` |
| `server_challenge_used` | web, android, ios | The server answered `challenge_used` |
| `server_challenge_attempts` | web, android, ios | The server answered `challenge_attempts` |
| `server_proof` | web, android, ios | The server answered `proof` |
| `server_root` | web, android, ios | The server answered `root` |
| `server_date_order` | web, android, ios | The server answered `date_order` |
| `server_empty` | web, android, ios | The server answered `empty` |
| `server_switch_limit` | web, android, ios | The server answered `switch_limit` |
| `server_daily_limit` | web, android, ios | The server answered `daily_limit` |
| `server_switch_restricted` | web, android, ios | The server answered `switch_restricted` |
| `server_malformed` | web, android, ios | The server answered `malformed` |
| `server_scope` | web, android, ios | The server answered `scope` |
| `server_platform` | web, android, ios | The server answered `platform` |
| `server_other` | web, android, ios | Any other code, or an HTTP status without one |

### Actions of a card proof

A tap that broke off is an action and not a reason: the cardholder taps
again, and the card proof goes on.

| Code | Clients | Meaning |
|---|---|---|
| `tap_dropped` | android, ios | The card left the phone during a tap; the count says which tap (`tap`) |
| `resubmit` | web, android, ios | The cardholder sent the same record again after a submission that did not get through |

### Actions of a visitor

| Code | Clients | Meaning |
|---|---|---|
| `start_card_proof` | web | Pressed the button that starts a card proof |
| `download_app_android` | web | Pressed the link to the Android app |
| `download_app_ios` | web | Pressed the link to the iOS app |
| `copy_proof_link` | web | Copied a proof page's link |

### Timed steps

| Code | Clients | Meaning |
|---|---|---|
| `crl` | web, android, ios | Fetching and checking the CRL |
| `tree` | web, android, ios | Building the tree |
| `proved` | web, android, ios | Making the proof |

### Durations

| Code | Meaning |
|---|---|
| `lt_1s` | under 1 second |
| `1s_3s` | 1 second to under 3 |
| `3s_10s` | 3 seconds to under 10 |
| `10s_30s` | 10 seconds to under 30 |
| `30s_60s` | 30 seconds to under 60 |
| `1m_3m` | 1 minute to under 3 |
| `gt_3m` | 3 minutes or more |

A client measures a timed step on its own clock, from when the step begins
to when it is done, and sends the one duration the time falls in: each
holds its start and not its end, so 999 ms is `lt_1s` and 1000 ms is
`1s_3s` (`durations_of` in the vectors). The time itself is not sent. A
step that did not get done sends no duration, and a time below 0 (a clock
that went back) none either.

### Sources

Where a visitor came from. Until a measurement shows what the built-in
browsers of apps send (ADR-0032), sources are only told apart as below, and
no count carries a source yet: the member that will carry the `Referer`'s
domain is added with the visitors' pages.

| Code | Meaning |
|---|---|
| `none` | No `Referer` |
| `domain` | A `Referer`: its domain |

### Browsers

Without a version. A client that cannot tell sends `other`.

| Code | Meaning |
|---|---|
| `chrome` | |
| `edge` | |
| `firefox` | |
| `safari` | |
| `samsung` | |
| `other` | |

### Operating systems

| Code | Meaning |
|---|---|
| `windows` | |
| `macos` | |
| `linux` | |
| `chromeos` | |
| `android` | |
| `ios` | |
| `other` | |

## Test vectors

[`vectors/counts.json`](vectors/counts.json): `table` is every code above
with the clients it is for; `cases` are parsed counts, each taken or
dropped.
