# Card proof API

Status: **Draft**. The interface between the cardholder's device (`web/`,
later the apps) and the server for one card proof. The server is the
Worker (`worker/`). Terms follow
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
- **Every endpoint can answer `429` `rate_limited`**, with a `Retry-After`
  header: the number of seconds to wait, a whole minute at most. The server
  counts the requests of one network in each minute, an IPv4 address by
  itself and an IPv6 address by its /64, and counts them apart in six
  classes, so that being over one's limit does not stop the others
  (ADR-0026): `challenges`; `card-state`; `records`; the public reads
  `config`, `fingerprint` and `rebuild` together; `counts`; and the
  visitors' pages.
  A request that is answered `429` was not read: it does not count towards
  a challenge's five submissions, and nothing is kept of it. The limits
  are more than a household or an office behind one address uses; they
  are the operator's settings and not part of this document. A request
  that was answered `429` can be sent again as it was once the time has
  passed: the card does not have to be read or sign again for it. The web
  page and the two apps offer to send again after a `429` to
  `challenges`, `card-state` or `records`, and a `429` to a `config`
  without the mark (`config`, below) does not stop their card proofs.
- **Every endpoint that asks the proof log can answer `503` `busy`**, with
  a `Retry-After` header: the proof log is overloaded and turned the
  request away (ADR-0026, "Durable Object 撐不住時"). Like a `429`, the
  request can be sent again as it was once the time has passed. A
  submission turned away after it was counted is kept in the connection
  log as a refused one (error `busy`); one turned away before is not.
  `config` answers `503` `busy` too, when it carries the mark of a card
  proof's start and too many card proofs started in this minute (`config`,
  below).
- **The server keeps a connection log of one kind of request, and of no
  other** (ADR-0022): a submission of a record (`POST /api/v1/records`)
  that carried a challenge the server issued and that it counted towards
  the challenge's five (under `records`: "a submission counts once the
  challenge passed the first look"). For
  each it keeps one entry, for 31 days, after which the entry is deleted:
  - the request ID, the time, the HTTP status answered, the IP address the
    request came from, the country code and the AS number of that address,
    and the card proof device ID if the request carried one (`device_id`,
    under `records`);
  - for a submission that became a record, the record's `seq`, and not the
    body: it is in the proof log;
  - for a submission that did not, the error code answered and the body as
    it came (the scoped ID, the accounts, the challenge, the proof): what
    it takes to reproduce a failed verification.

  Nothing is written for any other request: a page, a static file,
  `config`, `challenges`, `card-state`, `fingerprint`, a count (`counts`,
  which is kept elsewhere and without an address: see there), and a
  submission that was not counted: one that is not well formed, one refused because
  card proofs are stopped, and one whose challenge does not pass the first
  look (the server did not issue it or it has expired, a record was
  already written for it, or it was counted five times). Those can be sent
  without end by anyone, so they are not kept. In particular the server
  keeps no entry that puts the scoped ID of a `card-state` request next to
  an IP address. The entry of a submission that became a record does put an
  IP address next to a `seq`, and through it next to a scoped ID and its
  accounts, for those 31 days; the privacy notice says so. The network the
  service is reached through has its own view of requests' addresses, for
  the same 31 days: a sample, not every request (ADR-0022).
- Every API response carries the header `X-Request-Id`. For a request that
  has an entry in the connection log, the entry carries the same ID. For
  any other request the server writes nothing, unless it fails itself
  (`500`): then one line with the ID, the endpoint and where it failed, and
  nothing that came in the request, to its live log, which is not kept. The
  device shows the ID next to an error from the server, so that a
  cardholder can report it.
- A request body that the endpoint reads is at most 64 KB (65,536 bytes); a
  larger one is `400` `malformed`. (`counts` has a limit and an answer of
  its own: see there.) `challenges` takes no body and does not
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
  message for the code. Of a failure of its own (a card that cannot pass, a
  challenge it refused) it tells the server one thing: a reason code of a
  fixed table, in a count (`counts`; ADR-0032). Nothing else of the failure
  leaves the device (ADR-0016).
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
- The server writes nothing for this request. A challenge is in its
  connection log only inside the body of a counted submission that did not
  become a record ("Rules for every endpoint").
- Errors: `429` `rate_limited`, `503` `busy` ("Rules for every endpoint");
  `503` `paused` (under `records`, below): no challenge is issued.

What the device does with it: checks the format in its one spelling; checks
that the date is today in Taiwan by the device's own clock, and stops
otherwise.

## `POST /api/v1/card-state`

The state of one card, as computed by the record rules
([`spec/record-rules.md`](../../spec/record-rules.md)): its whole list of
accounts, the date of its last card proof, and what the rules count for it.
One request answers for all platforms, because the card has one scoped ID
for all of them (ADR-0017).

- Request: `{"scope_string":"…","scoped_id":"…"}`. It carries no platform.
- Response `200`:

  ```
  {"last_card_proof":"2026-11-04","proofs_on_last_date":1,"daily_limit":3,"platforms":{"threads":{"current":"bob","last_declared":"bob","switch_count":1}},"count":137}
  ```

  - `last_card_proof` is the card's. A card with no valid record has
    `null`; this is not an error.
  - `proofs_on_last_date` is the number of valid records of the card dated
    `last_card_proof`, 0 for a card with no valid record. It is not an item
    of the record rules' state: the server counts it for its own limit
    (`daily_limit`, below), and anyone can count it from the proof log.
  - `daily_limit` is the most records of one card the server writes with
    one date: 3 on the production site and on the test site. It is the
    server's rule, not the record rules' ([`spec/record-rules.md`](../../spec/record-rules.md),
    "Not part of these rules"; ADR-0018); each site has its own, and it is
    the same for every card.
  - `platforms` has one entry for every platform this proof log accepts
    ([`spec/scope.md`](../../spec/scope.md)), keyed by the platform ID,
    whether or not the card declares an account there. The order of the
    entries means nothing.
  - Each entry is the state of the card's slot on that platform:
    - `current` and `last_declared`: the account, or `null` when the rules
      have none.
    - `switch_count`: the number of switches the slot has used, 0 to 5.

    A slot the card never used has `null`, `null` and 0.
  - **The card's list** is the `current` of every entry where it is not
    `null`. It is not sent a second time in another form.
  - The dates of the individual switches are not sent. The rules do not
    read them; they are in the proof log.
  - `count` is the number of records the answer was computed at: every
    record stored at that moment, not the count of the last line published
    in `fingerprints.jsonl`. The answer carries no proof log fingerprint.
- Errors: `400` `malformed`, also for a scope this proof log does not accept;
  `429` `rate_limited`, `503` `busy` ("Rules for every endpoint").

The server sends facts, not conclusions. The device computes the rest from
them and from today's date in Taiwan by its own clock:

| What the cardholder is told | How the device gets it |
|---|---|
| Records of today, out of `daily_limit` | `proofs_on_last_date` if `last_card_proof` is today; 0 if it is earlier. If it is later, a card proof dated today is `date_order` (a card's dates do not go back). With `daily_limit` or more, the server writes no card proof of the card today |
| Switches left on a platform, out of 5 | 5 minus that entry's `switch_count` |
| What a list would do on a platform | Its entry against the slot: `first`, `refresh`, `switch`, `withdraw`, or blocked ([`spec/record-rules.md`](../../spec/record-rules.md), "Event rules") |
| Whether the server may refuse a switch the rules allow | Only by an operating policy of the server; there is none by default (`switch_restricted`, below) |

What the device does with it: shows the card's whole list, and lets the
cardholder change it. Before the card signs, the device shows the whole list
that will be signed and what it does on every platform, including the
accounts it withdraws by leaving them out and the switches it uses up; a
list that the rules would refuse (`switch_limit`, `empty`), or that the
server would not write today (`daily_limit`), is not offered. The device cannot check the answer without the whole
proof log. A wrong answer cannot identify the cardholder. It can mislead them:
a state that hides an account would lead to a list without it, which
withdraws it; a wrong `switch_count` would hide how many switches are left. The
cardholder sees the list before signing, and the proof log would show what the
server answered wrongly.
[`spec/list-consequence.md`](../../spec/list-consequence.md) defines how the
device reads this answer and the platform table of `config`, and what it
computes for a list, with test vectors.

What the device does with what it cannot read. "A platform the device does
not know" is one that has no row it can read in the platform table of
`GET /api/v1/config`, or that the device has no definition of its own for
(`config`, below).

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
  read `last_card_proof`, `proofs_on_last_date`, `daily_limit`, `count` or the entry of a
  platform it knows**: the device treats the state as unread and does not
  go on to the declaration. Without the state it cannot build the list.
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

  The request may carry one more key, `device_id`: the card proof device ID
  (ADR-0039), 16 random bytes as 32 lowercase hexadecimal digits, which the
  page or the app made and replaces after 31 days. It is no field of the
  record and is never written to the proof log: the server keeps it only in
  the connection log's entry of this request ("Rules for every endpoint").
  A request without it is taken as ever. So is one whose `device_id` is not
  such a string, whatever its type: the value is dropped, as if the key had
  not been sent, and the entry says none. A card proof is not refused over
  a value that is kept only for the connection log.

  The request is JSON, not a line of the proof log. The order of the keys of
  the request and of an account, and whitespace between tokens, are free;
  the server writes the proof log line itself from the template. What is not
  free is the content: the order of the accounts in the list, and one
  account per platform.

- The server, in this order: reads the request (below); checks every
  field's format; checks the challenge (issued by it, less than 10 minutes
  ago, not accepted before, at most 5 submissions); verifies the record
  ([`spec/proof-verification.md`](../../spec/proof-verification.md)); checks
  that `smt_root` is the root of one of the two newest CRLs of `issuer` in
  the mirror and that the newest is at most 3 days old; applies the record
  rules; applies its own policy on switches (`switch_restricted`). If
  everything passes it appends the record and marks the challenge as
  accepted, in one transaction.
- Response `201`:

  ```
  {"seq":138,"record_hash":"…","ordinal":42,"kinds":[{"platform":"threads","kind":"first","username":"alice","account_cards":1}]}
  ```

  `ordinal` is the card's ordinal once the record is applied: the place of
  its first valid record among the first valid records of every card of the
  proof log ([`spec/record-rules.md`](../../spec/record-rules.md), "The
  ordinal"). It is the same for every record of the card: this record gives
  it only when it is the card's first. Anyone computes it again from the
  proof log.

  `kinds` has one entry for every platform on which the record has a kind
  ([`spec/record-rules.md`](../../spec/record-rules.md)), in ascending order
  of `platform`; there is at least one. `kind` is `first`, `refresh`,
  `switch` or `withdraw`. `username` is the account: the one
  the list has for that platform, or for `withdraw` the one that was
  withdrawn. `account_cards` is the number of cards whose `current` on that
  platform is that `username`, in the record's scope, once the record is
  applied (after a withdrawal, the cards that still declare it). The same
  `username` on another platform is another account and is not counted.

  The link the device suggests is the page of the card, by its short ID
  ([`spec/scoped-id.md`](../../spec/scoped-id.md)); it does not depend on
  this response. The device uses `kinds` to tell the cardholder what was
  recorded, `account_cards` only to say whether other cards declare the
  same account, and `ordinal` only in the text it suggests for sharing the
  link. A wrong number cannot identify the cardholder. A device
  that cannot read `kinds` or `account_cards`, or gets a `kind` it does not
  know, treats them as unknown and says only that the list was recorded:
  the record is in the proof log by then. A device that cannot read
  `ordinal` suggests the text without a number.
  [`spec/records-response.md`](../../spec/records-response.md) defines how
  the device reads this response and how it compares `kinds` with what its
  confirmation screen said, so that every client tells the same.
- Errors:

  | Status | Code | Meaning |
  |---|---|---|
  | `400` | `malformed` | The request cannot be read, or a field is not in its format |
  | `400` | `scope` | The scope is not accepted by this proof log |
  | `400` | `platform` | An account of the list is on a platform this proof log does not accept |
  | `503` | `paused` | The server accepts no card proof for now. Nothing is wrong with the request, which was not looked at beyond its format |
  | `400` | `challenge_unknown` | Not issued by this server, or expired |
  | `400` | `challenge_used` | A card proof was already accepted for it |
  | `400` | `challenge_attempts` | Submitted more than 5 times |
  | `400` | `proof` | The record does not verify |
  | `400` | `root` | `smt_root` is not one of the two newest roots of the issuer |
  | `400` | `date_order` | The record rule of that name (check 4): the challenge's date is more than 4 days before the latest date among the valid records of the proof log, or before the card's `last_card_proof`. The second happens to a card that took two challenges around midnight and submitted the later-dated one first; the earlier one cannot be submitted, and the card proof is made again with a new challenge. The whole list is refused; nothing is recorded for any platform |
  | `400` | `empty`, `switch_limit` | The record rule of that name. The whole list is refused; nothing is recorded for any platform |
  | `400` | `daily_limit` | The record rules accept the record, but the server has written `daily_limit` records of the card with the challenge's date (`card-state`). It is the server's rule, not the record rules'. The whole list is refused; the card proof can be made the next day |
  | `403` | `switch_restricted` | The record rules accept the record, but the server's operating policy does not accept a switch in it. The whole list is refused |
  | `503` | `crl_stale` | The newest CRL of the record's issuer key is more than 3 days old, or the server has none; no card proof of that issuer key is accepted |
  | `429` | `rate_limited` | The network sent too many submissions in this minute ("Rules for every endpoint"). The submission was not read and does not count |
  | `503` | `busy` | The proof log is overloaded ("Rules for every endpoint"). The same submission can be sent again |

  A submission that fails leaves the challenge usable, up to the 5
  submissions. The challenge is looked at twice (below), and a submission
  counts once the challenge passed the first look, wherever it fails after
  that: a proof that does not verify, `crl_stale`, a root that is not
  accepted, a list the record rules refuse, `switch_restricted`, a
  `challenge_used` or `challenge_unknown` of the second look, and a `500`
  when the server's verifier could not run or the record could not be
  written. One that is `paused`, or `challenge_unknown` or `challenge_used`
  at the first look, does not count. Neither does one the server fails on
  (`500`) before it has counted it: it could not read its settings or what
  it stores, or the write that counts the submission itself failed. The
  submissions that count are the ones the connection log has an entry for,
  short of a failure of the server between counting one and writing its
  entry
  ("Rules for every endpoint"): so a challenge has five entries at most,
  the one of its record among them. That includes a submission the second
  look refuses with `challenge_used` or `challenge_unknown`: it was counted
  by then, and its entry has its body.

  **Reading the request**, and which of `malformed`, `scope` and `platform`
  it gets:

  1. The body is one JSON object with exactly the keys of the example, or
     those and `device_id`, each once, spelled as shown. Every value except
     `accounts` and `device_id` is a string; `accounts` is present;
     `device_id` may hold anything (above). Otherwise `malformed`:
     not JSON, a missing key (also `accounts`), an extra key, a key twice,
     a key in another case, a value of another type. This comes first
     because without it there is no scope to look at.
  2. `scope_string` is not a scope of this proof log: `scope`.
  3. `accounts` is a list, every element of it is an object with exactly
     the two keys `platform` and `username`, each once, both strings, and
     at least one `platform` is not a platform ID of this proof log:
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
  `crl_stale`, `root`, the record rules in their own order, then
  `daily_limit`, then `switch_restricted`. A proof made for one list and submitted with another
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
  challenge. Two causes:

  - The operator stopped taking card proofs (ADR-0033; `CARD_PROOFS_PAUSED`,
    `worker/README.md`, "停止和恢復收過卡"). `config` says so (`paused`).
    The Worker refuses before it asks the proof log's object; the daily
    publication goes on.
  - The state of the cards the server stores was computed by another
    version of the record rules than the one it runs
    ([`spec/record-rules.md`](../../spec/record-rules.md), "The version
    number"), and writing a record from that state could accept one the
    rules refuse. `config` does not say this one.

  `card-state`, `config`, `fingerprint` and the visitors' pages answer as
  ever. What the device does: when `config` says `paused` it says so before
  a card is read, and stops reading one if `config` says it on the way;
  when `challenges` or `records` answer `paused`, it stops with its own
  sentence for the cardholder (`design/copy/card-proof.md`: the card proof
  is not recorded, come back later) and the request ID. Sending the same
  record again is not offered: it would be `paused` again until the
  operator resumes, so the device offers only going back to the beginning.

  A server that cannot run its proof verifier answers `500` `internal`. That
  is not a verdict on the proof: the record is not written.

  `switch_limit` does not say which platform is blocked. The device knows
  from the state it showed; if it is surprised by the code, the state has
  changed, and it asks for it again.

  **`switch_restricted`** is a rule of the server, not of the proof log
  ([`spec/record-rules.md`](../../spec/record-rules.md), "Not part of these
  rules"). The record rules give a card 5 switches on each platform. The
  server may, by its operating policy, refuse a switch that is within the
  rules' limit. By default it has no such policy. It never refuses on this
  ground a record without a `switch` (a `first`, `refresh` or
  `withdraw` on every platform). Nobody can check from the proof log why a
  record was not appended; anybody can check that a record that was
  appended is within the 5. A device that gets this code shows it as it is:
  the server did not accept the switch, and the card proof is not recorded.

  A device that gets a code it does not know shows it as an error of the
  server, with the request ID, and treats the card proof as not recorded.

  "More than 3 days old" compares dates in Taiwan: the server's date is
  later than the CRL date plus 3 days. The two newest CRLs are the two
  usable ones with the highest `crl_number`.

## `GET /api/v1/config`

- **The mark of a start: `GET /api/v1/config?start`.** A client asks for
  `config` with `start` (the parameter's value is not read) once a card
  proof, when the cardholder presses the button that begins it, before a
  card is read. Only that request is counted against the site-wide limit:
  how many card proofs may start in a minute, all networks together
  (ADR-0026, "全站的總量上限"). Over it, `config` answers `503` `busy`
  with `Retry-After`, and the client tells the cardholder that too many
  people are using it now, before a card is read. Every other time a
  client asks for `config` (when a page opens, while a card is read) it
  does so without the mark, and only the per-network limit applies; a
  `429` or a `503` then does not stop a card proof, which goes on with
  the `config` it already has.
- Response `200`:

  ```
  {"paused":false,"crl_max_age_days":3,"platforms":[{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}],"min_app":{"android":{"build":12,"from":"2027-03-01"},"ios":{"build":9,"from":"2027-03-01"}}}
  ```

  - `paused` is `true` while the operator has stopped taking card proofs
    (ADR-0033; `CARD_PROOFS_PAUSED`, `worker/README.md`): `challenges` and
    `records` then answer `paused`. It says nothing of the other cause of
    `paused` (the record rules' version, under `records`), which only those
    two find. A server that does not send it (the Go backend) has not
    stopped; a device reads its absence as `false`.
  - `platforms` is the platform table of this proof log
    ([`spec/scope.md`](../../spec/scope.md)), one element per row, in
    ascending order of `platform`: the platform ID, the display name, and
    the `username` format exactly as written in the table.
  - `min_app` is the minimum app version
    ([`spec/min-app.md`](../../spec/min-app.md), ADR-0035): for the Android
    app and the iOS app, the lowest build that may still do a card proof
    (`build`) and the date in Taiwan that bound starts on (`from`). The
    production site and the test site each have their own values. The Go
    backend does not send it.

The device asks for it at every card proof, before it shows the list.

What an app does with `min_app`: reads its own entry (`android` or `ios`) and
compares its own build with it, as [`spec/min-app.md`](../../spec/min-app.md)
says. Before `from`, a lower build goes on and says from which date it can
no longer do a card proof; from `from` on, it stops before it asks for the
PIN or reads the card. A `min_app` it cannot read stops it the same way.
The web page does not read it: the page comes from the server at every card
proof, so it has no version to be too old. The server does not look at app
versions when it accepts a card proof.

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

**The table is a convenience for the device.** Which platforms a proof log
accepts, and in which format, is decided by the table of the specification,
which every re-verifier has; a row the server adds on its own leads to
records that make the log file broken. The device does not take from
this response, or from any other, which scope string the card signs
(ADR-0016). A wrong table cannot identify the cardholder, and it does not
name the platforms the cardholder sees: the device shows its own names
(ADR-0019). It can lose them a card proof, with a platform or a format the
proof log does not accept; the cardholder sees the platform ID and the account
in the list before signing.

- Errors: `429` `rate_limited` ("Rules for every endpoint"); `503` `busy`,
  only with the mark of a start (above).

What the device does with what it cannot read:

- **No response, or no `platforms` it can read**: the device does not go on
  to the declaration. It has nothing to offer and nothing to check an
  account against.
- **An app, with no `min_app` it can read**: it does not go on
  ([`spec/min-app.md`](../../spec/min-app.md)). Only its own entry is
  read; the rest of `min_app` is ignored.
- **A row it cannot read** (a key missing, a format not in the form
  above): the platform of that row is one the device does not know
  (`card-state`, above).
- **A field it does not know**: the device ignores it.

## `GET /api/v1/fingerprint`

- Response `200`: `{"date":"2026-11-20","count":138,"fingerprint":"…"}`:
  the last line of the fingerprint file the server published
  ([`spec/record.md`](../../spec/record.md), "The published proof log"), with
  the fields of that line: the date in Taiwan on which it was written, the
  number of records at that moment, and their proof log fingerprint
  (ADR-0021). It is the last line the server wrote to that file and read
  back, as the server keeps it; the file is not read to answer. A line the
  server has decided on and not yet written to the file is not answered.
- A proof log that was never published:
  `{"date":null,"count":0,"fingerprint":"0000…0000"}`, no date, no record,
  and the proof log fingerprint of the empty proof log (64 zeros).
- It says nothing of the records written since that line: `count` here can
  be less than the `count` of `card-state`.
- It is answered while the proof log is paused.
- Errors: `429` `rate_limited`, `503` `busy` ("Rules for every endpoint").

## `GET /api/v1/rebuild`

For the operator, and for anyone who wants to see it: how far the last
rebuild from the proof log is (ADR-0033; `worker/README.md`, "從證明紀錄重建").
No device reads it.

- Response `200`: `{"name":"2026-11-27-1","status":"running","records":3000,"reason":null}`
  - `name`: the name the operator gave the rebuild (`REBUILD_PROOF_LOG`), 1 to
    40 of `A-Za-z0-9._-`.
  - `status`: `running`; `swapped`, when what was computed was put in place
    of what the server had; `refused`, when it ended without changing
    anything.
  - `records`: the number of records applied so far, from the first; for a
    rebuild that ended, how far it came.
  - `reason`: for `refused`, why, in a sentence of English that names a
    record's `seq` or a file where it can; otherwise `null`.
- A server that never began a rebuild:
  `{"name":null,"status":null,"records":0,"reason":null}`.
- It says what the last rebuild begun was, not whether one is asked for: a
  name the operator set while card proofs were not stopped begins nothing,
  and the answer stays what it was.
- While a rebuild is `running`, `challenges` and `records` answer `paused`.
- Errors: `429` `rate_limited`, `503` `busy` ("Rules for every endpoint").

## `POST /api/v1/counts`

One count: a visitor opened a page, or a card proof reached a step or
stopped (ADR-0032, ADR-0039). The table every value is chosen from, the
members of a count and which counts are taken are in
[`spec/counts.md`](../../spec/counts.md).

- Request: one count, a JSON object whose values are all strings, at most
  2,048 bytes:
  `{"client":"web","event":"stop","reason":"no_reader","device_id":"0123456789abcdef0123456789abcdef","attempt_id":"fedcba9876543210fedcba9876543210","browser":"chrome","os":"windows"}`
- Response `204`, with no body, whether the count was taken or dropped. A
  client does not read the answer and does not wait for it: a count that
  could not be sent is not sent again, and a card proof goes on without it.
- A count that is not as `spec/counts.md` has it is dropped whole: a value
  that is not in the table, a member too many or too few, an ID or a version
  or a card reader's name not in its format, a body that is not JSON or is
  longer than the limit. A dropped count leaves nothing on the server.
- What the server keeps of a count that is taken is the count, rebuilt
  member by member from the table, and the minute it was received in (UTC).
  Not the IP address, which is used for the limit below and for nothing
  else; no header of the request; not the request ID. A count is not in the
  connection log, and nothing of a count is written to the live log: when
  the server itself fails to keep one, the line it writes there says that
  it failed and nothing of the count.
- The counts of one minute are written as one file, in a place that is not
  public, where they are deleted after 31 days. A minute holds a set number
  of counts at most (the operator's setting); more than that in one minute
  are not kept, and the file only says how many there were.
- The part of the server that takes counts does not ask the part that
  writes the proof log, so counts never wait on a card proof, nor a card
  proof on them.
- Counts can be sent by anyone, with any values the table has. They are for
  the operator to see where card proofs stop, and decide nothing about any
  record (ADR-0005).
- Errors, each with the JSON body of any error: `429` `rate_limited`
  ("Rules for every endpoint"), and the count is then not read; `405` for
  another method; `500` `internal` when the server's settings are not
  right, as for every endpoint.

## Public files

The CRL archive and the published proof log are not served by the server.
They are files on their own domain, `https://data.iamreal.tw/`, downloaded
without going through the server's code (ADR-0027). The test site's are on
`https://test-data.iamreal.tw/`, in the same layout (ADR-0028).

| URL | Content |
|---|---|
| `https://data.iamreal.tw/crl/index.jsonl` | The archive index ([`spec/revocation-tree.md`](../../spec/revocation-tree.md), "Archive index") |
| `https://data.iamreal.tw/crl/<SHA-256>.crl` | One CRL of the archive, the original bytes; `<SHA-256>` is the file's SHA-256 as 64 lowercase hex digits |
| `https://data.iamreal.tw/connection-log/oldest.json` | `{"checked":"2026-11-26T12:00:07.123Z","oldest":"2026-10-27"}`: when the server last looked at its connection log (UTC), every hour, and the date (UTC) of the oldest entry it then held, `null` if it held none. Nothing else of the connection log is published. An `oldest` more than 33 days before today means the entries are not being deleted after the 31 days of "Rules for every endpoint" (31 days, up to a day for the deletion to happen, and the dates being UTC); a `checked` more than two hours old means the server no longer looks. No device reads this file |
| `https://data.iamreal.tw/count-events/oldest.json` | The same of the counts the server keeps (`counts`): `{"checked":"2026-11-26T12:00:07.123Z","oldest":"2026-10-27"}`, when the server last looked (UTC), every hour, and the date (UTC) of the oldest minute of counts it then held, `null` if it held none. Nothing else of the counts is published. Read in the same way: an `oldest` more than 33 days before today means the counts are not being deleted after their 31 days. No device reads this file |
| `https://data.iamreal.tw/proof-log/` | The log directory, its record hash lists (`hashes/`) and `fingerprints.jsonl` ([`spec/record.md`](../../spec/record.md), "The published proof log"), and the card state files of the last days (`card-state/`, [`spec/record-rules.md`](../../spec/record-rules.md), "The card state file") |

Only `GET` from the card proof page's origin is allowed across origins
(CORS), and the page's `Content-Security-Policy` lets it connect to this
one domain besides its own (`web/README.md`).

What the device does with the CRL: takes from the index the usable line of
its issuer with the highest `crl_number`, downloads that file, and checks
everything itself: the file's SHA-256, MOICA's signature, that the CRL is
usable, its number against the highest it remembers, its date against the
bound. It uses nothing else from the index; it builds the tree itself.
