# Card proof API

Status: **Draft**. The interface between the cardholder's device (`web/`,
later the apps) and the server (`server/`) for one card proof. Terms follow
[`GLOSSARY.md`](../../GLOSSARY.md). The formats of the values are defined in
[`spec/`](../../spec/README.md); this document only says which request
carries which value.

This is not part of the protocol specification: nothing here changes what a
record is or how it is verified. It can change without invalidating records.

## Rules for every endpoint

- Same origin as the page. No cookies, no credentials, no CORS headers.
- Requests and responses are JSON (`application/json`, UTF-8) unless stated.
- Responses carry `Cache-Control: no-store`, except the static files.
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
- A request body is at most 64 KB; a larger one is `400` `malformed`.
- Besides the codes listed per endpoint: `404` `not_found`, `405`
  `method_not_allowed`, `500` `internal`.
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
- Errors: `429` `rate_limited`.

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
  {"last_card_proof":"2026-11-04","proofs_on_last_date":1,"platforms":{"threads":{"current":"bob","last_declared":"bob","switch_dates":["2026-03-02"]}},"count":137,"head":"…"}
  ```

  - `last_card_proof` and `proofs_on_last_date` are the card's. A card with
    no valid record has `null` and 0; this is not an error.
  - `platforms` has one entry for every platform this roster accepts
    ([`spec/scope.md`](../../spec/scope.md)), keyed by the platform ID,
    whether or not the card declares an account there. The order of the
    entries means nothing.
  - Each entry is the state of the card's slot on that platform. `current`
    and `last_declared` are `null` when the rules have none; a slot the card
    never used has both `null` and an empty `switch_dates`.
  - **The card's list** is the `current` of every entry where it is not
    `null`. It is not sent a second time in another form.
  - `count` and `head` are the number of records and the head the answer
    was computed at.
- Errors: `400` `malformed`, also for a scope this roster does not accept.

The server sends facts, not conclusions. The device computes the rest from
them and from today's date in Taiwan by its own clock:

| What the cardholder is told | How the device gets it |
|---|---|
| Records of today, out of 3 | `proofs_on_last_date` if `last_card_proof` is today; 0 if it is earlier |
| Switches left on a platform | 2 minus the number of that entry's `switch_dates` on or after today − 364 days |
| When a platform can be switched again, if none is left | 365 days after the second latest of that entry's `switch_dates` |
| What a list would do on a platform | Its entry against `current` and `last_declared`: `first`, `refresh`, `switch`, `withdraw`, or blocked ([`spec/roster-rules.md`](../../spec/roster-rules.md), "Event rules") |

What the device does with it: shows the card's whole list, and lets the
cardholder change it. Before the card signs, the device shows the whole list
that will be signed and what it does on every platform, including the
accounts it withdraws by leaving them out; a list that the rules would
refuse (`switch_limit`, `empty`, `daily_limit`) is not offered. The device
cannot check the answer without the whole roster. A wrong answer cannot
identify the cardholder. It can mislead them: a state that hides an account
would lead to a list without it, which withdraws it. The cardholder sees the
list before signing, and the roster would show what the server answered
wrongly.

What the device does with what it cannot read:

- **`current` is not `null` on a platform the device does not know** (the
  server's table is newer): the device does not go on to the declaration.
  A list without that account would withdraw it, and the device cannot
  check or show an account of a platform it does not know. It tells the
  cardholder that the card declares an account this version cannot handle.
- **An entry for a platform the device does not know, with `current`
  `null`**: the device ignores it.
- **A platform the device knows has no entry**: this roster does not accept
  that platform. The device does not offer it.
- **A response without `platforms`, or in which it cannot read
  `last_card_proof`, `proofs_on_last_date` or the entry of a platform it
  knows**: the device treats the state as unknown and does not go on to the
  declaration. Without the state it cannot build the list.
- **A field it does not know, in the response or inside an entry it can
  otherwise read**: the device ignores the field.

## `POST /api/v1/records`

Submits one card proof: the card's whole list of accounts.

- Request: the fields of a record except `seq` and `prev`
  ([`spec/record.md`](../../spec/record.md)):

  ```
  {"scope_string":"…","scoped_id":"…","accounts":[{"platform":"threads","username":"alice"}],"challenge":"…","issuer":"G3","smt_root":"…","circuit":"…","proof":"…"}
  ```

  `accounts` is required and is the whole list, in the form of the record:
  ascending by `platform`, each platform at most once, `[]` for none. The
  server does not sort it, does not merge it with the card's current list
  and does not fill in anything. The list is what the card signed; any other
  list fails verification.

- The server, in this order: checks every field's format; checks the
  challenge (issued by it, less than 10 minutes ago, not accepted before, at
  most 5 submissions); verifies the record
  ([`spec/proof-verification.md`](../../spec/proof-verification.md)); checks
  that `smt_root` is the root of one of the two newest CRLs of `issuer` in
  the mirror and that the newest is at most 3 days old; applies the roster
  rules. If everything passes it appends the record and marks the challenge
  as accepted, in one transaction.
- Response `201`:

  ```
  {"seq":138,"record_hash":"…","kinds":[{"platform":"threads","kind":"first","username":"alice","account_cards":1}]}
  ```

  `kinds` has one entry for every platform on which the record has a kind
  ([`spec/roster-rules.md`](../../spec/roster-rules.md)), in ascending order
  of `platform`; there is at least one. `kind` is `first`, `refresh`,
  `switch` or `withdraw`. `username` is the account: the one the list has
  for that platform, or for `withdraw` the one that was withdrawn.
  `account_cards` is the number of cards whose `current` on that platform is
  that `username`, in the record's scope, once the record is applied (after
  a withdrawal, the cards that still declare it). The same `username` on
  another platform is another account and is not counted.

  The link the device suggests is the page of the card, by its short ID
  ([`spec/scoped-id.md`](../../spec/scoped-id.md)); it does not depend on
  this response. The device uses `kinds` to tell the cardholder what was
  recorded, and `account_cards` only to say whether other cards declare the
  same account. A wrong number cannot identify the cardholder. A device
  that cannot read `kinds` or `account_cards` treats them as unknown and
  says only that the list was recorded: the record is in the roster by
  then.
- Errors:

  | Status | Code | Meaning |
  |---|---|---|
  | `400` | `malformed` | A field is not in its format |
  | `400` | `scope` | The scope is not accepted by this roster |
  | `400` | `platform` | An account of the list is on a platform this roster does not accept |
  | `400` | `challenge_unknown` | Not issued by this server, or expired |
  | `400` | `challenge_used` | A card proof was already accepted for it |
  | `400` | `challenge_attempts` | Submitted more than 5 times |
  | `400` | `proof` | The record does not verify |
  | `400` | `root` | `smt_root` is not one of the two newest roots of the issuer |
  | `400` | `date_order`, `empty`, `switch_limit`, `daily_limit` | The roster rule of that name. The whole list is refused; nothing is recorded for any platform |
  | `503` | `crl_stale` | The newest CRL of the issuer is more than 3 days old; no card proof is accepted |
  | `429` | `rate_limited` | |

  A submission that fails leaves the challenge usable, up to the 5
  submissions.

  When several apply, the first in this order: `scope`, `platform`,
  `malformed`, `challenge_unknown`, `challenge_used`, `challenge_attempts`,
  `proof`, `crl_stale`, `root`, then the roster rules in their own order. A
  submission that is `scope`, `platform` or `malformed` does not count
  towards the 5. `platform` is for a list whose every entry has the keys
  `platform` and `username` as strings, one of the `platform` values not
  being a platform ID of this roster. Everything else wrong with the list is
  `malformed`: `accounts` missing or not a list, a platform twice, accounts
  not in ascending order, a `username` that is not in the format of its
  platform. A proof made for one list and submitted with another is
  `proof`: the declaration code does not match.

  `switch_limit` does not say which platform is blocked. The device knows
  from the state it showed; if it is surprised by the code, the state has
  changed, and it asks for it again.

  A device that gets a code it does not know shows it as an error of the
  server, with the request ID, and treats the card proof as not recorded.

  "More than 3 days old" compares dates in Taiwan: the server's date is
  later than the CRL date plus 3 days. The two newest CRLs are the two
  usable ones with the highest `crl_number`.

## `GET /api/v1/config`

- Response `200`: `{"crl_max_age_days":3}`

What the device does with it: uses the smaller of this number and its
built-in 7 ([`spec/revocation-tree.md`](../../spec/revocation-tree.md)).

## `GET /api/v1/head`

- Response `200`: `{"count":138,"head":"…"}`

## Static files

| Path | Content |
|---|---|
| `/crl/index.jsonl` | The archive index ([`spec/revocation-tree.md`](../../spec/revocation-tree.md), "Archive index") |
| `/crl/SHA256.crl` | One CRL of the archive, the original bytes; `SHA256` is the file's SHA-256 as 64 lowercase hex digits |
| `/roster/` | The roster directory and `heads.jsonl` ([`spec/record.md`](../../spec/record.md), "The published roster") |

What the device does with the CRL: takes from the index the usable line of
its issuer with the highest `crl_number`, downloads that file, and checks
everything itself: the file's SHA-256, MOICA's signature, that the CRL is
usable, its number against the highest it remembers, its date against the
bound. It uses nothing else from the index; it builds the tree itself.
