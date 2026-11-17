# Record

Status: **Draft**. Version tag: `iamreal-record-v1`.

A record is the full public content of one event in the roster: the list
of accounts a card declares from then on, and everything needed to
re-verify it without the server. One card proof is one record. The
roster is the list of records in order (ADR-0005). Its rules are in
[`roster-rules.md`](roster-rules.md).

## Principle

**A record stores only what cannot be computed from its other fields.** A
verifier rebuilds every public input of the proof from the record's fields
and the fixed tables below. It never takes a public input from the record as
given. A stored copy of a computable value would only add something to check
for consistency, and a verifier that trusted the copy instead of recomputing
it would check nothing.

Not stored, because each is computed:

| Value | Computed from |
|---|---|
| Declaration code | `scope_string`, `accounts`, `challenge` ([`declaration-code.md`](declaration-code.md)) |
| What the record did on each platform (a first declaration, a switch, a withdrawal) | The card's earlier records ([`roster-rules.md`](roster-rules.md)) |
| `current_time` | The date in `challenge` ([`challenge.md`](challenge.md)) |
| Date of the event | The date in `challenge` |
| Issuer modulus | `issuer` (table below) |
| The record's own hash | All fields (below) |

The time the server received the event is not stored either. Nothing proves
it, and minute-level times would make it easier to link one person's records
across scopes (the public roster and the scopes of other services).

**Every record has exactly one spelling.** Each line of a roster file is a
fixed template with the field values filled in. Each value has exactly one
accepted form. Two copies of the same roster are the same bytes, and no
line can be read in two ways.

## Fields

| Field | Format |
|---|---|
| `seq` | Decimal integer from `1` to `9007199254740991` (2^53 − 1), without leading zeros |
| `prev` | 64 lowercase hex digits: the record hash of the record with `seq − 1`; for `seq` 1, 64 zeros |
| `scope_string` | One of the accepted scopes of this roster ([`scope.md`](scope.md)) |
| `scoped_id` | 52 characters, in the one accepted spelling ([`scoped-id.md`](scoped-id.md)) |
| `accounts` | The account list, below |
| `challenge` | 37 characters, in the one accepted spelling ([`challenge.md`](challenge.md)) |
| `issuer` | `G2` or `G3` |
| `smt_root` | 64 lowercase hex digits, a big-endian integer below the field modulus `p` ([`scoped-id.md`](scoped-id.md)) |
| `circuit` | 64 lowercase hex digits: SHA-256 of the verification key |
| `proof` | 19,544 characters: the standard base64 encoding (RFC 4648 section 4, `A–Z a–z 0–9 + /`, with `=` padding) of exactly 14,656 bytes. Decoding and re-encoding gives the same string, so the unused bits of the last data character are zero |

Every format is printable ASCII without `"`, `\` or any control character;
`accounts` contains `"` only where its own template puts them.

### The account list

`accounts` is the whole list of accounts the card declares once this record
is applied: zero or more accounts, at most one per platform (ADR-0017). A
platform that is not in the list is a platform the card declares no account
on. There is no field that says "declare" or "withdraw": a withdrawal is a
list without the account ([`roster-rules.md`](roster-rules.md)).

```
ACCOUNTS = "[" "]"
         | "[" ACCOUNT { "," ACCOUNT } "]"
ACCOUNT  = {"platform":"PLATFORM","username":"USERNAME"}
```

| Part | Format |
|---|---|
| `platform` | One of the platform IDs of this roster, exactly as in the platform table ([`scope.md`](scope.md)) |
| `username` | The `username` format of that account's `platform` ([`scope.md`](scope.md)) |

- **Order**: the accounts are in ascending order of `platform`, compared by
  byte values, and each `platform` is strictly greater than the one before
  it. So no platform appears twice, a set of accounts has one spelling, and
  the list has at most as many accounts as the roster has platforms.
- The empty list is `[]`. It is not left out and it is not `null`.
- Inside an account the keys are `platform`, then `username`. No
  whitespace, no escape sequence, no other key.
- Checking a `username` needs its `platform` first, because the format
  depends on it; a `username` that fits another platform's format but not
  its own makes the line malformed.

A list that breaks one of these rules (a platform outside the table or in
another spelling, a repeated platform, accounts in another order, a
`username` outside its format) makes the line malformed, like any other
value outside its format. No such list is read in a second way or
repaired: it is not sorted, and a repeated platform is not resolved to its
first or its last account.

## Lines and files

A record is one line:

```
{"seq":SEQ,"prev":"PREV","scope_string":"SCOPE_STRING","scoped_id":"SCOPED_ID","accounts":ACCOUNTS,"challenge":"CHALLENGE","issuer":"ISSUER","smt_root":"SMT_ROOT","circuit":"CIRCUIT","proof":"PROOF"}
```

followed by one `LF` (`0x0A`). The upper-case placeholders are replaced by
the field values, `ACCOUNTS` by the list written from its own template
("The account list"); nothing else changes. The keys are in this order,
there is no whitespace and no escape sequence. This is valid JSON, but
parsing it as JSON is not enough to check it.

For example, with one account: `…,"accounts":[{"platform":"threads","username":"alice"}],"challenge":…`;
with none: `…,"accounts":[],"challenge":…`.

**Check a line** by parsing it in any way, checking every value against the
table, then writing the line again from the template and comparing bytes:
the line's bytes up to and including its `LF` must equal the template
followed by `LF`. If they differ, the line is malformed. This one comparison rejects
everything JSON would otherwise allow: other key orders, whitespace, escapes,
duplicate keys, keys in another case, `null`, numbers written as `1.0` or
`1e0`, and lines ending in `CR LF`. It applies inside `accounts` as well:
the list is written again from the parsed accounts, in the order they were
read, after the checks of "The account list"; a parser that drops or merges
something gives other bytes.

**A roster file** is its lines concatenated, in `seq` order. It has no byte
order mark and no empty lines, and its last byte is the `LF` of the last
line. A roster with no records is the empty file.

**A malformed line breaks the whole roster file**, not just that record
([`roster-rules.md`](roster-rules.md)). A roster file is valid or broken.
Only in a valid one can a single record be valid or invalid.

## The published roster

A record is about 20 KB, almost all of it the proof, so the roster is
published as a directory of files rather than one file.

**Roster directory.** The roster file cut every 1,000 lines:

- The file that starts with the record of `seq` `s` is named `s` written as
  16 decimal digits with leading zeros, followed by `.jsonl`:
  `0000000000000001.jsonl`, `0000000000001001.jsonl`, and so on.
- Every file holds exactly 1,000 lines, except the last, which holds 1 to
  1,000. There is no empty file. A roster with no records has no such file.
- The roster file is these files concatenated in name order. Everything in
  this document and in [`roster-rules.md`](roster-rules.md) applies to that
  concatenation.

How the roster is cut depends only on `seq`, so everyone holding the same
records has the same files, and a file that is full never changes again. A
directory that breaks one of these rules (a missing file, a file of the
wrong length, a file whose first `seq` does not match its name) is broken,
like a malformed line; a re-verifier reports it with the code `directory`.

**Heads file.** `heads.jsonl`, in the same directory, has one line per day
on which the roster was published, in the same one-spelling form as a roster
line: this template, followed by one `LF`.

```
{"date":"DATE","count":COUNT,"head":"HEAD"}
```

| Field | Format |
|---|---|
| `date` | The date in Taiwan on which the line was written, `YYYY-MM-DD` |
| `count` | The number of records at that moment: `0`, or a decimal integer without leading zeros |
| `head` | The head at that moment: the record hash of the record with `seq` = `count`; 64 zeros for `count` `0` |

Lines are in order of `date`, each date at most once, and `count` never
decreases. Anyone holding the roster can check every line. The file is short
(one line per day), so it is easy to keep and to publish in more than one
place.

A published roster directory has a heads file; a re-verifier reports a
directory without one. The roster is published at most once per Taiwan date:
publishing again on the same date with the same head changes nothing, and
with more records it is refused, so that a date's line never changes.

## Record hash and the chain

```
preimage    = "iamreal-record-v1" LF
              seq LF prev LF scope_string LF scoped_id LF accounts LF
              challenge LF issuer LF smt_root LF circuit LF proof
record_hash = SHA-256(preimage), written as 64 lowercase hex digits
```

- `LF` is the byte `0x0A`; there is no trailing `LF`. Every field is written
  exactly as in the line.
- The fields are in the order of the line, all ten of them. `accounts` is
  written as in the line: the list from `[` to `]`, on one line.
- No field contains `LF`, so the preimage splits back into the fields in only
  one way.

Each record's `prev` is the hash of the record before it, compared as a
string. The records therefore form a chain. The hash of the last record is
the **head**. It commits to the whole roster up to that point. The head of
the empty roster is 64 zeros.

What the chain does: once someone has kept a head, the operator cannot drop
or reorder an earlier record, or show a different history to someone else,
without the kept head failing to match. What it does not do: if nobody kept
an old head, the operator can recompute the whole chain. Forging or altering
an event is already prevented by the proof; the chain is about omission,
order and equivocation.

**Where heads are published.** The heads file (above) is published with
the roster directory, and API responses and the re-verifying command show
the current head and the number of records. This relies on people keeping
copies: the operator can still show different rosters to different people,
and only someone holding an older head would notice. Publishing the heads
file somewhere the operator cannot rewrite (a public git repository that
people clone, or a transaction on a public blockchain) makes that harder; it
is not decided yet, and does not change the record format or the heads file.

## Verifying a record

The line is already well formed. A verifier, the server or anyone
re-verifying, then:

1. Checks that `circuit` is one of the accepted circuits and goes with
   `issuer` (table below).
2. Rebuilds the public inputs, in the circuit's order:
   - `issuer_modulus`: the modulus for `issuer` ([`issuers.md`](issuers.md)),
     in 120-bit limbs, least significant first;
   - `smt_root`: from the record (whether the root is recognized is a
     separate roster rule, [`roster-rules.md`](roster-rules.md));
   - `current_time`: from the challenge's date;
   - `nullifier`: the field element decoded from `scoped_id`;
   - `scope_packed`: `scope_string` packed as in [`scope.md`](scope.md);
   - `declaration_code_packed`: the declaration code recomputed from the
     record's `scope_string`, `accounts` and `challenge`
     ([`declaration-code.md`](declaration-code.md)), packed the same way.
3. Verifies `proof` with these public inputs under the verification key whose
   SHA-256 is `circuit`.

The accounts are not public inputs of their own. A proof is tied to its
list only by step 2: a verifier that computes the declaration code from
anything but the record's `accounts`, all of them and in their order, has
not checked what the card declared. With the right computation, a proof
made for one list fails step 3 in a record with another: an account added,
left out, moved to another platform or spelled differently.

The checks on the proof bytes and on running `bb verify` are in
[`proof-verification.md`](proof-verification.md).

The server also checks the challenge before appending: it issued it, it has
not expired, it is unused. It also applies the roster rules. A record that
fails any check is not appended. A record in the roster that fails one of the
three steps above is invalid, with reason `proof`
([`roster-rules.md`](roster-rules.md)).

## Accepted circuits

| `issuer` | Issuer key | Circuit | Verification key SHA-256 |
|---|---|---|---|
| `G2` | MOICA G2, RSA 2048 | `card_proof_rs2048` | `816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8` |
| `G3` | MOICA G3, RSA 4096 | `card_proof_rs4096` | `bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2` |

Draft values. When a circuit changes, a row is added; old rows stay, so old
records keep verifying.

## Open items

- **Where the heads file is published** besides the roster directory.
- **Test vectors for the roster directory and the heads file.**

## Test vectors

[`vectors/record.json`](vectors/record.json):

- `chains`: two chains of three records, one of the production roster and
  one of a test roster (only a test roster has a list of two accounts),
  each record with its line, the list as written in the line
  (`accounts_text`), its preimage hash and record hash, and each chain with
  its head;
- well-formed lines and malformed lines, each with the reason, among them
  the lines that are malformed because of `accounts`;
- roster files that are valid or broken, with the reason and the head.

Every chain, line and file has a `roster`, `production` or `test`: whose
accepted scopes and platform table it is read with
([`scope.md`](scope.md)). The same line can be well formed for one roster
and malformed for the other.

The proofs are placeholder bytes, not real proofs: the vectors test the
formats and the chain, not proof verification. To keep the file small, lines
write the proof as a token such as `@PROOF@`, to be replaced by the string
given under `tokens` before testing.
