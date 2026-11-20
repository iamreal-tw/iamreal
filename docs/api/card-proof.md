# Card proof API

Status: **Draft**. The interface between the cardholder's device (`web/`,
later the apps) and the server for one card proof. There are two servers
for now: the Worker (`worker/`), which has `challenges`, `card-state`,
`records` and `config`; and the Go backend (`server/`), kept for comparison
until the Worker has the rest, which has every endpoint here but not the
code `paused`, and still sends `head` (noted where it differs). Terms follow
[`GLOSSARY.md`](../../GLOSSARY.md). The formats of the values are defined in
[`spec/`](../../spec/README.md); this document only says which request
carries which value.

This is not part of the protocol specification: nothing here changes what a
record is or how it is verified. It can change without invalidating records.

## Rules for every endpoint

- Same origin as the page. No cookies, no credentials, no CORS headers.
- Requests and responses are JSON (`application/json`, UTF-8) unless stated.
- Responses carry `Cache-Control: no-store`, except the static files.
- Every response carries `X-Content-Type-Options: nosniff`.
- **A request that carries a scoped ID is a `POST` with the scoped ID in the
  body, never in the URL.**
- **No request's IP address is logged**, by the application, the reverse
  proxy or the load balancer, for any endpoint or static file. A scoped ID
  next to an IP address would let the operator, or anyone who obtains the
  logs, look for the person behind a card. Logging it only for the other
  requests does not help: loading the page, downloading the CRL and asking
  for a challenge all happen within a minute or two before the submission,
  and the order of the records is public, so the times alone would link an
  address to a record.
- Every API response carries the header `X-Request-Id`. The server logs the
  same ID with the time, the endpoint, the status and the error code, and
  nothing that came in the request. The device shows the ID next to an error
  from the server, so that a cardholder can report it.
- A request body that the endpoint reads is at most 64 KB (65,536 bytes); a
  larger one is `400` `malformed`. `challenges` takes no body and does not
  read one: whatever is sent with it, of any length, is ignored.
- A body that is read is `400` `malformed` unless it is UTF-8 without a byte
  order mark and one JSON value with nothing but whitespace around it. No
  request nests arrays and objects more than 3 deep; one that nests more
  than 16 deep is `malformed` whatever else it holds. What each endpoint
  requires of the value is under "Reading the request" (`records`) and holds
  for `card-state` too: exactly the keys listed, each once, spelled as
  shown.
- Besides the codes listed per endpoint: `404` `not_found` for a path that
  is no endpoint; `405` `method_not_allowed` for an endpoint asked with
  another method, with the header `Allow` naming the one it takes; `500`
  `internal`.
- An error is a 4xx or 5xx status with `{"error":"CODE"}`. The device shows a
  message for the code. It does not report failures of its own (a card that
  cannot pass, a challenge it refused) to the server (ADR-0016).
- The device treats every value it receives as described under "What the
  device does with it". The server deciding a value is never enough
  (ADR-0016).

## `POST /api/v1/challenges`

Issues a challenge ([`spec/challenge.md`](../../spec/challenge.md)).

- Request: empty body. It carries no account, no platform, no scope and no
  scoped ID. A challenge is not issued for a platform or a list: the
  declaration code the card signs names them
  ([`spec/declaration-code.md`](../../spec/declaration-code.md)).
- Response `200`: `{"challenge":"2026-11-16.000G40R40M30E209185GR38E1W"}`
- The server stores the challenge with the time it was issued. It is usable
  for 10 minutes, for one accepted card proof, and for at most 5 submissions.
- The server does not log the challenge.
- Errors: `429` `rate_limited`; `503` `paused` (under `records`, below):
  no challenge is issued.

What the device does with it: checks the format in its one spelling; checks
that the date is today in Taiwan by the device's own clock, and stops
otherwise.

## `POST /api/v1/card-state`

The state of one card, as computed by the roster rules
([`spec/roster-rules.md`](../../spec/roster-rules.md)): its whole list of
accounts, the date of its last card proof, and what the rules count for it.
One request answers for all platforms, because the card has one scoped ID
for all of them (ADR-0017).

- Request: `{"scope_string":"…","scoped_id":"…"}`. It carries no platform.
- Response `200`:

  ```
  {"last_card_proof":"2026-11-04","proofs_on_last_date":1,"platforms":{"threads":{"current":"bob","last_declared":"bob","switch_count":1,"correction_date":"2026-03-02"}},"count":137}
  ```

  - `last_card_proof` and `proofs_on_last_date` are the card's. A card with
    no valid record has `null` and 0; this is not an error.
  - `platforms` has one entry for every platform this roster accepts
    ([`spec/scope.md`](../../spec/scope.md)), keyed by the platform ID,
    whether or not the card declares an account there. The order of the
    entries means nothing.
  - Each entry is the state of the card's slot on that platform:
    - `current` and `last_declared`: the account, or `null` when the rules
      have none.
    - `switch_count`: the number of switches the slot has used, 0 to 5.
    - `correction_date`: the date of the slot's last `first` or `switch`,
      that is, the day the slot last got an account that was new to it, or
      `null`. It is not the date of a later `refresh`, `correction` or
      `withdraw`.

    A slot the card never used has `null`, `null`, 0 and `null`.
  - **The card's list** is the `current` of every entry where it is not
    `null`. It is not sent a second time in another form.
  - The dates of the individual switches are not sent. The rules do not
    read them; they are in the roster.
  - `count` is the number of records the answer was computed at: every
    record stored at that moment, not the count of the last line published
    in `fingerprints.jsonl`. The answer carries no roster fingerprint; the
    Go backend (`server/`), kept only for comparison, still sends one as
    `head`.
- Errors: `400` `malformed`, also for a scope this roster does not accept.

The server sends facts, not conclusions. The device computes the rest from
them and from today's date in Taiwan by its own clock:

| What the cardholder is told | How the device gets it |
|---|---|
| Records of today, out of 3 | `proofs_on_last_date` if `last_card_proof` is today; 0 if it is earlier. If it is later, a card proof dated today is `date_order` (a card's dates do not go back) |
| Switches left on a platform, out of 5 | 5 minus that entry's `switch_count` |
| Whether changing the account on a platform today uses a switch | No if that entry's `correction_date` is today (a correction); yes otherwise |
| What a list would do on a platform | Its entry against the slot: `first`, `refresh`, `correction`, `switch`, `withdraw`, or blocked ([`spec/roster-rules.md`](../../spec/roster-rules.md), "Event rules") |
| Whether the server may refuse a switch the rules allow | Only by an operating policy of the server; there is none by default (`switch_restricted`, below) |

What the device does with it: shows the card's whole list, and lets the
cardholder change it. Before the card signs, the device shows the whole list
that will be signed and what it does on every platform, including the
accounts it withdraws by leaving them out and the switches it uses up; a
list that the rules would refuse (`switch_limit`, `empty`, `daily_limit`)
is not offered. The device cannot check the answer without the whole
roster. A wrong answer cannot identify the cardholder. It can mislead them:
a state that hides an account would lead to a list without it, which
withdraws it; a wrong `correction_date` would present a switch as free. The
cardholder sees the list before signing, and the roster would show what the
server answered wrongly.
[`spec/list-consequence.md`](../../spec/list-consequence.md) defines how the
device reads this answer and the platform table of `config`, and what it
computes for a list, with test vectors.

What the device does with what it cannot read. "A platform the device does
not know" is one that has no row it can read in the platform table of
`GET /api/v1/config`.

- **`current` is not `null` on a platform the device does not know**: the
  device keeps that account in the list exactly as it is, in its place in
  the order of the list (ascending by platform ID, compared by byte
  values), and shows it as a row that cannot be changed or removed. A list
  without it would withdraw an account the cardholder did not choose to
  withdraw. The device cannot check the `username` against a format; it
  checks only what every platform ID and every `username` satisfy: the
  platform ID is 1 to 21 characters of `a-z`, `0-9`, `-`, and the
  `username` is 1 or more printable ASCII characters without `"` and `\`.
  If either fails, the device treats the state as unread (below).
- **An entry for a platform the device does not know, with `current`
  `null`**: the device ignores it and does not offer the platform.
- **A platform of the table has no entry**: the device does not offer it.
- **No response, a response without `platforms`, or one in which it cannot
  read `last_card_proof`, `proofs_on_last_date`, `count` or the entry of a
  platform it knows**: the device treats the state as unread and does not go on to
  the declaration. Without the state it cannot build the list.
- **A field it does not know, in the response or inside an entry it can
  otherwise read**: the device ignores the field.

## `POST /api/v1/records`

Submits one card proof: the card's whole list of accounts.

- Request: the fields of a record except `seq`
  ([`spec/record.md`](../../spec/record.md)):

  ```
  {"scope_string":"…","scoped_id":"…","accounts":[{"platform":"threads","username":"alice"}],"challenge":"…","issuer":"G3","smt_root":"…","circuit":"…","proof":"…"}
  ```

  `accounts` is required and is the whole list: the same accounts in the
  same order as in the record, ascending by `platform`, each platform at
  most once, `[]` for none. The server does not sort it, does not merge it
  with the card's current list and does not fill in anything. The list is
  what the card signed; any other list fails verification.

  The request is JSON, not a line of the roster. The order of the keys of
  the request and of an account, and whitespace between tokens, are free;
  the server writes the roster line itself from the template. What is not
  free is the content: the order of the accounts in the list, and one
  account per platform.

- The server, in this order: reads the request (below); checks every
  field's format; checks the challenge (issued by it, less than 10 minutes
  ago, not accepted before, at most 5 submissions); verifies the record
  ([`spec/proof-verification.md`](../../spec/proof-verification.md)); checks
  that `smt_root` is the root of one of the two newest CRLs of `issuer` in
  the mirror and that the newest is at most 3 days old; applies the roster
  rules; applies its own policy on switches (`switch_restricted`). If
  everything passes it appends the record and marks the challenge as
  accepted, in one transaction.
- Response `201`:

  ```
  {"seq":138,"record_hash":"…","kinds":[{"platform":"threads","kind":"first","username":"alice","account_cards":1}]}
  ```

  `kinds` has one entry for every platform on which the record has a kind
  ([`spec/roster-rules.md`](../../spec/roster-rules.md)), in ascending order
  of `platform`; there is at least one. `kind` is `first`, `refresh`,
  `correction`, `switch` or `withdraw`. `username` is the account: the one
  the list has for that platform, or for `withdraw` the one that was
  withdrawn. `account_cards` is the number of cards whose `current` on that
  platform is that `username`, in the record's scope, once the record is
  applied (after a withdrawal, the cards that still declare it). The same
  `username` on another platform is another account and is not counted.

  The link the device suggests is the page of the card, by its short ID
  ([`spec/scoped-id.md`](../../spec/scoped-id.md)); it does not depend on
  this response. The device uses `kinds` to tell the cardholder what was
  recorded, and `account_cards` only to say whether other cards declare the
  same account. A wrong number cannot identify the cardholder. A device
  that cannot read `kinds` or `account_cards`, or gets a `kind` it does not
  know, treats them as unknown and says only that the list was recorded:
  the record is in the roster by then.
- Errors:

  | Status | Code | Meaning |
  |---|---|---|
  | `400` | `malformed` | The request cannot be read, or a field is not in its format |
  | `400` | `scope` | The scope is not accepted by this roster |
  | `400` | `platform` | An account of the list is on a platform this roster does not accept |
  | `503` | `paused` | The server accepts no card proof for now. Nothing is wrong with the request, which was not looked at beyond its format |
  | `400` | `challenge_unknown` | Not issued by this server, or expired |
  | `400` | `challenge_used` | A card proof was already accepted for it |
  | `400` | `challenge_attempts` | Submitted more than 5 times |
  | `400` | `proof` | The record does not verify |
  | `400` | `root` | `smt_root` is not one of the two newest roots of the issuer |
  | `400` | `date_order` | The roster rule of that name (check 4): the challenge's date is more than 4 days before the latest date among the valid records of the roster, or before the card's `last_card_proof`. The second happens to a card that took two challenges around midnight and submitted the later-dated one first; the earlier one cannot be submitted, and the card proof is made again with a new challenge. The whole list is refused; nothing is recorded for any platform |
  | `400` | `empty`, `switch_limit`, `daily_limit` | The roster rule of that name. The whole list is refused; nothing is recorded for any platform |
  | `403` | `switch_restricted` | The roster rules accept the record, but the server's operating policy does not accept a switch in it. The whole list is refused |
  | `503` | `crl_stale` | The newest CRL of the record's issuer key is more than 3 days old, or the server has none; no card proof of that issuer key is accepted |
  | `429` | `rate_limited` | |

  A submission that fails leaves the challenge usable, up to the 5
  submissions. The challenge is looked at twice (below), and a submission
  counts once the challenge passed the first look, wherever it fails after
  that: a proof that does not verify, `crl_stale`, a root that is not
  accepted, a list the roster rules refuse, `switch_restricted`, a
  `challenge_used` or `challenge_unknown` of the second look, and a `500`
  when the server's verifier could not run or the record could not be
  written. One that is `paused`, or `challenge_unknown` or `challenge_used`
  at the first look, does not count. Neither does one the server fails on
  (`500`) before it has counted it: it could not read its settings or what
  it stores, or the write that counts the submission itself failed.

  **Reading the request**, and which of `malformed`, `scope` and `platform`
  it gets:

  1. The body is one JSON object with exactly the keys of the example, each
     once, spelled as shown. Every value except `accounts` is a string;
     `accounts` is present. Otherwise `malformed`: not JSON, a missing key
     (also `accounts`), an extra key, a key twice, a key in another case, a
     value of another type. This comes first because without it there is
     no scope to look at.
  2. `scope_string` is not a scope of this roster: `scope`.
  3. `accounts` is a list, every element of it is an object with exactly
     the two keys `platform` and `username`, each once, both strings, and
     at least one `platform` is not a platform ID of this roster:
     `platform`.
  4. Anything else that is not in its format: `malformed`. For the list:
     `accounts` is not a list; an element is not an object of exactly those
     two string keys (an extra key, a key twice, a key in another case,
     `null`), whatever the other elements are; a platform twice; accounts
     not in ascending order; a `username` that is not in the format of its
     platform.

  A submission that ends at one of these four steps does not count towards
  the 5.

  When several of the later codes apply, the first in this order: `paused`,
  `challenge_unknown`, `challenge_used`, `challenge_attempts`, `proof`,
  `crl_stale`, `root`, the roster rules in their own order, then
  `switch_restricted`. A proof made for one list and submitted with another
  is `proof`: the declaration code does not match.

  The challenge is looked at twice: before the proof is verified, and again
  at the moment the record is written. A challenge that passed the first
  time can be `challenge_used` the second time, when it was submitted twice
  at once and the other submission was written first; or
  `challenge_unknown`, when its 10 minutes ran out in between: the second
  look is by the server's clock at the moment of the write, so a challenge
  submitted in its last moments can expire while the proof is being
  verified. Nothing is written then, and the submission has counted. Of two
  submissions of one challenge at the same moment, at most one is written.

  **`paused`**: the server accepts no card proof for now, and issues no
  challenge. There is one cause so far: the state of the cards the server
  stores was computed by another version of the roster rules than the one
  it runs ([`spec/roster-rules.md`](../../spec/roster-rules.md), "The
  version number"), and writing a record from that state could accept one
  the rules refuse. `card-state` and `config` answer as ever. The device
  treats it as a code it does not know (below); the sentence for the
  cardholder is not written yet.

  A server that cannot run its proof verifier answers `500` `internal`. That
  is not a verdict on the proof: the record is not written.

  `switch_limit` does not say which platform is blocked. The device knows
  from the state it showed; if it is surprised by the code, the state has
  changed, and it asks for it again.

  **`switch_restricted`** is a rule of the server, not of the roster
  ([`spec/roster-rules.md`](../../spec/roster-rules.md), "Not part of these
  rules"). The roster rules give a card 5 switches on each platform. The
  server may, by its operating policy, refuse a switch that is within the
  rules' limit. By default it has no such policy. It never refuses on this
  ground a record without a `switch` (a `first`, `refresh`, `correction` or
  `withdraw` on every platform). Nobody can check from the roster why a
  record was not appended; anybody can check that a record that was
  appended is within the 5. A device that gets this code shows it as it is:
  the server did not accept the switch, and the card proof is not recorded.

  A device that gets a code it does not know shows it as an error of the
  server, with the request ID, and treats the card proof as not recorded.

  "More than 3 days old" compares dates in Taiwan: the server's date is
  later than the CRL date plus 3 days. The two newest CRLs are the two
  usable ones with the highest `crl_number`.

## `GET /api/v1/config`

- Response `200`:

  ```
  {"crl_max_age_days":3,"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]}
  ```

  - `platforms` is the platform table of this roster
    ([`spec/scope.md`](../../spec/scope.md)), one element per row, in
    ascending order of `platform`: the platform ID, the display name, and
    the `username` format exactly as written in the table.

The device asks for it at every card proof, before it shows the list.

What the device does with `crl_max_age_days`: uses the smaller of this
number and its built-in 7
([`spec/revocation-tree.md`](../../spec/revocation-tree.md)).

What the device does with `platforms`: offers the platforms of this table
that it has a definition of its own for (their names, how an account is
written), shows its own names for them, not the `display_name` of this
table, and checks a `username` the cardholder types against the format of
its platform given here, as a whole value, before the declaration code is
computed. A platform of this table that the device has no definition of its
own for is a platform the device does not know (`card-state`, above). A
`username_format` is one character class followed by one length range,
`[…]{m,n}` ([`spec/scope.md`](../../spec/scope.md)); the device reads that
form itself, and a row whose format is not in it is a row it cannot read.

**The table is a convenience for the device.** Which platforms a roster
accepts, and in which format, is decided by the table of the specification,
which every re-verifier has; a row the server adds on its own leads to
records that make the roster file broken. The device does not take from
this response, or from any other, which scope string the card signs
(ADR-0016). A wrong table cannot identify the cardholder, and it does not
name the platforms the cardholder sees: the device shows its own names
(ADR-0019). It can lose them a card proof, with a platform or a format the
roster does not accept; the cardholder sees the platform ID and the account
in the list before signing.

What the device does with what it cannot read:

- **No response, or no `platforms` it can read**: the device does not go on
  to the declaration. It has nothing to offer and nothing to check an
  account against.
- **A row it cannot read** (a key missing, a format not in the form
  above): the platform of that row is one the device does not know
  (`card-state`, above).
- **A field it does not know**: the device ignores it.

## `GET /api/v1/head`

- Response `200`: `{"count":138,"head":"…"}`: the number of records stored
  now and their roster fingerprint
  ([`spec/record.md`](../../spec/record.md)), not the last line published
  in `fingerprints.jsonl`. ADR-0021 has the API show only the last
  fingerprint published and its count; the new backend makes that change,
  and changes the name `head`.

## Public files

The CRL archive and the published roster are not served by the server.
They are files on their own domain, `https://data.iamreal.tw/`, downloaded
without going through the server's code (ADR-0027). The test site's are on
`https://test-data.iamreal.tw/`, in the same layout (ADR-0028).

| URL | Content |
|---|---|
| `https://data.iamreal.tw/crl/index.jsonl` | The archive index ([`spec/revocation-tree.md`](../../spec/revocation-tree.md), "Archive index") |
| `https://data.iamreal.tw/crl/<SHA-256>.crl` | One CRL of the archive, the original bytes; `<SHA-256>` is the file's SHA-256 as 64 lowercase hex digits |
| `https://data.iamreal.tw/roster/` | The roster directory, its record hash lists (`hashes/`) and `fingerprints.jsonl` ([`spec/record.md`](../../spec/record.md), "The published roster") |

Only `GET` from the card proof page's origin is allowed across origins
(CORS), and the page's `Content-Security-Policy` lets it connect to this
one domain besides its own (`web/README.md`).

What the device does with the CRL: takes from the index the usable line of
its issuer with the highest `crl_number`, downloads that file, and checks
everything itself: the file's SHA-256, MOICA's signature, that the CRL is
usable, its number against the highest it remembers, its date against the
bound. It uses nothing else from the index; it builds the tree itself.
