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

## File format

JSON Lines: one record per line, a JSON object, records in `seq` order.
Every field is a JSON string, except `seq`, which is a JSON number. The JSON
spelling of a line (key order, whitespace) carries no meaning: the record
hash is computed from the field values, not from the line.

## Fields

| Field | Format | Meaning |
|---|---|---|
| `seq` | Integer, `1` for the first record, then consecutive | Position in the roster; the order the rules apply in |
| `prev` | 64 lowercase hex digits | Record hash of the record with `seq − 1`; for `seq` 1, 64 zeros |
| `scope_string` | The 31-byte scope string (ADR-0007) | The scope of the event |
| `scoped_id` | 52 characters ([`scoped-id.md`](scoped-id.md)) | The card, within the scope |
| `action` | `declare` or `withdraw` | The event |
| `username` | Lowercase, without `@`; characters per platform (open item) | The account |
| `challenge` | 37 characters ([`challenge.md`](challenge.md)) | The challenge the card proof answered |
| `issuer` | `G2` or `G3` | Which MOICA issuer key signed the certificate |
| `smt_root` | 64 lowercase hex digits, big-endian | Root of the revocation tree the proof was made against |
| `circuit` | 64 lowercase hex digits | SHA-256 of the verification key |
| `proof` | Standard base64 with padding, of exactly 14,656 bytes | The proof |

## Record hash and the chain

```
preimage    = "iamreal-record-v1" LF
              seq LF prev LF scope_string LF scoped_id LF action LF
              username LF challenge LF issuer LF smt_root LF circuit LF
              proof
record_hash = SHA-256(preimage), written as 64 lowercase hex digits
```

- `LF` is the byte `0x0A`; no trailing `LF`. `seq` is written in decimal
  without leading zeros; every other field is written exactly as stored.
- No field may contain `LF`. The formats above already exclude it.
- The hash is defined over the field values, not over the JSON line, because
  JSON allows many spellings of the same object.

Each record's `prev` is the hash of the record before it, so the records form
a chain. The hash of the last record, the **head**, commits to the whole
roster up to that point.

What the chain does: once someone has kept a head, the operator cannot drop
or reorder an earlier record, or show a different history to someone else,
without the kept head failing to match. What it does not do: if nobody kept
an old head, the operator can recompute the whole chain. The head therefore
has to be published regularly somewhere outside the operator's control (open
item). Forging or altering an event is already prevented by the proof; the
chain is about omission, order and equivocation.

## Verifying a record

A verifier, the server or anyone re-verifying, does all of the following.
The checks on the proof bytes and on `bb verify` itself are listed in full in
the public inputs document of the circuits (to be moved into `spec/`). The
ones that depend on record fields are:

1. Every field has the format in the table. `scoped_id` and `challenge` are
   parsed strictly, as their documents say.
2. `circuit` is one of the accepted circuits, and goes with `issuer` (table
   below).
3. Rebuild the public inputs, in the circuit's order:
   - `issuer_modulus`: the modulus for `issuer`, in 120-bit limbs, least
     significant first;
   - `smt_root`: from the record, and recognized under the revocation rules
     (open item);
   - `current_time`: from the challenge's date;
   - `nullifier`: the field element decoded from `scoped_id`;
   - `scope_packed`: `scope_string` packed little-endian into one field
     element (`b[0] + b[1]·256 + … + b[30]·256^30`);
   - `declaration_code_packed`: the declaration code recomputed from the
     record, packed the same way.
4. Verify `proof` with these public inputs under the verification key whose
   SHA-256 is `circuit`.

The server additionally checks the challenge (issued by it, unexpired,
unused) and the roster rules before appending. A record that fails any check
is not accepted. A record that appears in the roster and fails anyway is
invalid; see [`roster-rules.md`](roster-rules.md).

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
  old records. Waiting on measurements of building the tree on the device.
- **Characters allowed in `username` for each platform**, with a source for
  the platform's rules.
- **Hiding an account name on request.** When an account owner asks, later
  snapshots hide the account name in that owner's records. The hidden record
  keeps `seq`, `prev` and its original record hash, so the chain stays
  intact. To be decided: which other fields go (with `challenge` and `proof`
  still present, the name could be found by trying candidates against the
  proof), how the roster rules still count switches for that scoped ID, and
  where the public notice of each hiding is kept.
- **Where and how often the head is published.**

## Test vectors

[`vectors/record.json`](vectors/record.json): two chained records with their
preimage hashes, record hashes and the head. The proofs are placeholder
bytes, not real proofs: the vectors test the formats and the chain, not
proof verification.
