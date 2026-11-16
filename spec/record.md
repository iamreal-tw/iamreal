# Record

Status: **Draft**. Version tag: `iamreal-record-v1`.

A record is the full public content of one event in the roster: what
happened, and everything needed to re-verify it without the server. The
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
| Declaration code | `action`, `scope_string`, `username`, `challenge` ([`declaration-code.md`](declaration-code.md)) |
| `current_time` | The date in `challenge` ([`challenge.md`](challenge.md)) |
| Date of the event | The date in `challenge` |
| Issuer modulus | `issuer` (table below) |
| The record's own hash | All fields (below) |

The time the server received the event is not stored either. Nothing proves
it, and minute-level times would make it easier to link one person's records
across scopes.

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
| `action` | `declare` or `withdraw` |
| `username` | The `username` format of the record's scope ([`scope.md`](scope.md)) |
| `challenge` | 37 characters, in the one accepted spelling ([`challenge.md`](challenge.md)) |
| `issuer` | `G2` or `G3` |
| `smt_root` | 64 lowercase hex digits, a big-endian integer below the field modulus `p` ([`scoped-id.md`](scoped-id.md)) |
| `circuit` | 64 lowercase hex digits: SHA-256 of the verification key |
| `proof` | 19,544 characters: the standard base64 encoding (RFC 4648 section 4, `A–Z a–z 0–9 + /`, with `=` padding) of exactly 14,656 bytes. Decoding and re-encoding gives the same string, so the unused bits of the last data character are zero |

Every format is printable ASCII without `"`, `\` or any control character.

## Lines and files

A record is one line:

```
{"seq":SEQ,"prev":"PREV","scope_string":"SCOPE_STRING","scoped_id":"SCOPED_ID","action":"ACTION","username":"USERNAME","challenge":"CHALLENGE","issuer":"ISSUER","smt_root":"SMT_ROOT","circuit":"CIRCUIT","proof":"PROOF"}
```

followed by one `LF` (`0x0A`). The upper-case placeholders are replaced by
the field values; nothing else changes. The keys are in this order, there is
no whitespace and no escape sequence. This is valid JSON, but parsing it as
JSON is not enough to check it.

**Check a line** by parsing it in any way, checking every value against the
table, then writing the line again from the template and comparing bytes:
the line's bytes up to and including its `LF` must equal the template
followed by `LF`. If they differ, the line is malformed. This one comparison rejects
everything JSON would otherwise allow: other key orders, whitespace, escapes,
duplicate keys, keys in another case, `null`, numbers written as `1.0` or
`1e0`, and lines ending in `CR LF`.

**A roster file** is its lines concatenated, in `seq` order. It has no byte
order mark and no empty lines, and its last byte is the `LF` of the last
line. A roster with no records is the empty file.

**A malformed line breaks the whole roster file**, not just that record
([`roster-rules.md`](roster-rules.md)). A roster file is valid or broken.
Only in a valid one can a single record be valid or invalid.

## Record hash and the chain

```
preimage    = "iamreal-record-v1" LF
              seq LF prev LF scope_string LF scoped_id LF action LF
              username LF challenge LF issuer LF smt_root LF circuit LF
              proof
record_hash = SHA-256(preimage), written as 64 lowercase hex digits
```

- `LF` is the byte `0x0A`; there is no trailing `LF`. Every field is written
  exactly as in the line.
- No field contains `LF`, so the preimage splits back into the fields in only
  one way.

Each record's `prev` is the hash of the record before it, compared as a
string. The records therefore form a chain. The hash of the last record is
the **head**. It commits to the whole roster up to that point. The head of
the empty roster is 64 zeros.

What the chain does: once someone has kept a head, the operator cannot drop
or reorder an earlier record, or show a different history to someone else,
without the kept head failing to match. What it does not do: if nobody kept
an old head, the operator can recompute the whole chain. The head therefore
has to be published regularly somewhere outside the operator's control (open
item). Forging or altering an event is already prevented by the proof; the
chain is about omission, order and equivocation.

## Verifying a record

The line is already well formed. A verifier, the server or anyone
re-verifying, then:

1. Checks that `circuit` is one of the accepted circuits and goes with
   `issuer` (table below).
2. Rebuilds the public inputs, in the circuit's order:
   - `issuer_modulus`: the modulus for `issuer`, in 120-bit limbs, least
     significant first;
   - `smt_root`: from the record (whether the root is recognized is a
     separate roster rule, [`roster-rules.md`](roster-rules.md));
   - `current_time`: from the challenge's date;
   - `nullifier`: the field element decoded from `scoped_id`;
   - `scope_packed`: `scope_string` packed as in [`scope.md`](scope.md);
   - `declaration_code_packed`: the declaration code recomputed from the
     record, packed the same way.
3. Verifies `proof` with these public inputs under the verification key whose
   SHA-256 is `circuit`.

The checks on the proof bytes and on running `bb verify` are listed in the
public inputs document of the circuits (to be moved into `spec/`).

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

- **The issuer moduli.** The G2 and G3 moduli, with the source of each
  issuer certificate, will be listed here. Test issuer keys never appear in
  this table.
- **Which `smt_root` values are recognized**: one tree or one per issuer,
  how old a root may be, how historical roots are archived for re-verifying
  old records. The same rule bounds how far into the future a challenge's
  date can be ([`roster-rules.md`](roster-rules.md)).
- **Hiding an account name on request.** When an account owner asks, later
  snapshots hide the account name in that owner's records. The hidden record
  keeps `seq`, `prev` and its original record hash, so the chain stays
  intact. To be decided: which other fields go (with `challenge` and `proof`
  still present, the name could be found by trying candidates against the
  proof), how the roster rules still count switches for that scoped ID, and
  where the public notice of each hiding is kept. This changes the line
  format, so it is a new version of this document.
- **Where and how often the head is published.**

## Test vectors

[`vectors/record.json`](vectors/record.json):

- two chained records with their lines, preimage hashes, record hashes and
  the head;
- well-formed lines and malformed lines, each with the reason;
- roster files that are valid or broken, with the reason and the head.

The proofs are placeholder bytes, not real proofs: the vectors test the
formats and the chain, not proof verification. To keep the file small, lines
write the proof as a token such as `@PROOF@`, to be replaced by the string
given under `tokens` before testing.
