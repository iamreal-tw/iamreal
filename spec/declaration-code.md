# Declaration code

Status: **Draft**. Version tag: `iamreal-declaration-v1`.

The declaration code is the 31-byte string a card signs to state "these are
the accounts this card declares, now": the card's whole list, one account at
most on each platform (ADR-0017). It is the second of the two messages the
card signs in a card proof.

A card proof does not add or remove one account. It states the whole list,
and whatever is not in the list is not declared any more
([`record-rules.md`](record-rules.md)).

## Computation

```
preimage = "iamreal-declaration-v1" LF
           scope_string             LF
           account_1                LF
           …
           account_n                LF
           challenge

account_i = platform ":" username

declaration_code = "D" || first 30 characters of base32(SHA-256(preimage))
```

- `LF` is the byte `0x0A`. There is no trailing `LF`.
- `scope_string` is the full 31-byte scope string, including `_` padding
  (see ADR-0007).
- `account_1` … `account_n` are the accounts of the record's list, in the
  order of the list: ascending by `platform`, each platform at most once
  ([`record.md`](record.md), "The account list"). `n` is the length of the
  list, from 0 to the number of platforms of the proof log. With an empty list
  the preimage has three lines.
- `platform` is the platform ID, exactly as in the platform table
  ([`scope.md`](scope.md)). `username` is the account name on that platform,
  without `@`, in the `username` format of the platform.
- `challenge` is the challenge issued by the server for this card proof,
  written exactly as issued ([`challenge.md`](challenge.md)). It contains no
  `LF`.
- `base32` is the Crockford encoding defined in [`README.md`](README.md).

The result is 31 ASCII bytes: `D` followed by 30 characters carrying 150 bits
of the hash.

### One list, one preimage

Two different inputs never give the same preimage:

- No value contains `LF`. The first line is the tag, the second the scope
  string, the last the challenge; every line in between is one account.
- A platform ID contains no `:` ([`scope.md`](scope.md)), so an account line
  splits at its first `:` in only one way, whatever the `username` contains.
- The list has one order and no repeated platform, so one set of accounts
  has one sequence of lines.

A verifier never parses a preimage. It builds one from the record and
compares the result.

### Why there is no `action` line

Earlier drafts had a line `declare` or `withdraw`. A withdrawal is now a
list without the account, so there is one kind of statement left, and a
line with one possible value separates nothing.

What keeps a proof made for one purpose from being used for another:

- **The version tag** names this computation. Another statement a card may
  sign later (for another kind of record, or for a service) gets its own
  tag, and with it its own lines; it does not become a new value of a line
  here.
- **The first byte.** A declaration code starts with `D`. The circuit
  accepts as the second message only a string starting with an uppercase
  letter other than `S`, and as the first only a scope string (ADR-0013), so
  a code cannot stand in for a scope string or the reverse. Other first
  letters are reserved for other kinds of codes (ADR-0007).
- **The scope string.** A code computed for the public proof log is not valid
  for a test log or for the scope of another service.

The tag is still `v1`: no proof log has records computed the earlier ways, and
the tag counts the computations that records in a proof log were made with. No
preimage of an earlier draft equals one of this document: their second line
was `declare` or `withdraw`, which is not a scope string.

## Why each line is there

| Line | Purpose |
|---|---|
| Version tag | Says which statement this is, and lets the computation change later without ambiguity |
| `scope_string` | A code computed for one scope is not valid in another |
| The accounts | Name every account the card declares after this card proof. Every public platform shares one scope string and one scoped ID (ADR-0017), so these lines are the only thing that ties a proof to its platforms and accounts. Changing, adding or leaving out one account gives another code |
| `challenge` | Shows the card signed after the server issued the challenge |

## Verification

A verifier recomputes the code from the record's `scope_string`, `accounts`
and `challenge`, and checks that it equals the declaration code exposed as a
public input of the proof, `declaration_code_packed`: the 31 bytes packed as
in [`scope.md`](scope.md). This is the only place the challenge and the
accounts are bound: the circuit has no separate input for either.

## Test vectors

[`vectors/declaration-code.json`](vectors/declaration-code.json), with the
packed value of each code: lists of zero, one and two accounts, and lists
that differ by one account, one platform or the challenge.

Example, a list of one account:

```
iamreal-declaration-v1
iamreal:public:0_______________
threads:alice
2026-11-16.000G40R40M30E209185GR38E1W
```

gives `DYR31H79A046QB7TZR3EZ26GGF20ZV9` (SHA-256 of the preimage: `f606189d…c9b95e7f`).

The same with an empty list (three lines) gives `DW823ED4NZ8ABHYWZ583X7G4H6XPA6Q`.

Both are in the vectors file.
