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

- Request: empty body. It carries no account, no scope and no scoped ID.
- Response `200`: `{"challenge":"2026-11-16.000G40R40M30E209185GR38E1W"}`
- The server stores the challenge with the time it was issued. It is usable
  for 10 minutes, for one accepted card proof, and for at most 5 submissions.
- The server does not log the challenge.
- Errors: `429` `rate_limited`.

What the device does with it: checks the format in its one spelling; checks
that the date is today in Taiwan by the device's own clock, and stops
otherwise.

## `POST /api/v1/card-state`

The state of one card in one scope, as computed by the roster rules
([`spec/roster-rules.md`](../../spec/roster-rules.md)).

- Request: `{"scope_string":"…","scoped_id":"…"}`
- Response `200`:

  ```
  {"current":"bob","last_declared":"bob","last_card_proof":"2026-11-04","proofs_on_last_date":1,"switch_dates":["2026-03-02"],"count":137,"head":"…"}
  ```

  `current`, `last_declared` and `last_card_proof` are `null` when the rules
  have none. A card with no valid record gets all three `null`, a
  `proofs_on_last_date` of 0 and an empty `switch_dates`; this is not an error. `count` and `head` are the number of
  records and the head the answer was computed at.
- Errors: `400` `malformed`, also for a scope this roster does not accept.

What the device does with it: shows it. The device computes what a
declaration would be (`first`, `refresh`, `switch`, or blocked by
`switch_limit`), whether the card has reached the 3 records of today
(`daily_limit`), and how many switches remain from these facts and today's
date; the server does not send a conclusion. The device cannot check the
answer without the whole roster. A wrong answer cannot identify the
cardholder; it can mislead them about the consequence of the next step, and
the roster would show it.

## `POST /api/v1/records`

Submits one card proof.

- Request: the fields of a record except `seq` and `prev`
  ([`spec/record.md`](../../spec/record.md)):

  ```
  {"scope_string":"…","scoped_id":"…","action":"declare","username":"alice","challenge":"…","issuer":"G3","smt_root":"…","circuit":"…","proof":"…"}
  ```

- The server, in this order: checks every field's format; checks the
  challenge (issued by it, less than 10 minutes ago, not accepted before, at
  most 5 submissions); verifies the record
  ([`spec/proof-verification.md`](../../spec/proof-verification.md)); checks
  that `smt_root` is the root of one of the two newest CRLs of `issuer` in
  the mirror and that the newest is at most 3 days old; applies the roster
  rules. If everything passes it appends the record and marks the challenge
  as accepted, in one transaction.
- Response `201`: `{"seq":138,"record_hash":"…","kind":"first"}` where `kind`
  is `first`, `refresh`, `switch` or `withdraw`.
- Errors:

  | Status | Code | Meaning |
  |---|---|---|
  | `400` | `malformed` | A field is not in its format |
  | `400` | `scope` | The scope is not accepted by this roster |
  | `400` | `challenge_unknown` | Not issued by this server, or expired |
  | `400` | `challenge_used` | A card proof was already accepted for it |
  | `400` | `challenge_attempts` | Submitted more than 5 times |
  | `400` | `proof` | The record does not verify |
  | `400` | `root` | `smt_root` is not one of the two newest roots of the issuer |
  | `400` | `date_order`, `not_current`, `switch_limit`, `daily_limit` | The roster rule of that name |
  | `503` | `crl_stale` | The newest CRL of the issuer is more than 3 days old; no card proof is accepted |
  | `429` | `rate_limited` | |

  A submission that fails leaves the challenge usable, up to the 5
  submissions.

  When several apply, the first in this order: `scope`, `malformed`,
  `challenge_unknown`, `challenge_used`, `challenge_attempts`, `proof`,
  `crl_stale`, `root`, then the roster rules in their own order. A submission
  that is `scope` or `malformed` does not count towards the 5. "More than 3
  days old" compares dates in Taiwan: the server's date is later than the CRL
  date plus 3 days. The two newest CRLs are the two usable ones with the
  highest `crl_number`.

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
