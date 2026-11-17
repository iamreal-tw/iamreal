# Declaration code

Status: **Draft**. Version tag: `iamreal-declaration-v1`.

The declaration code is the 31-byte string a card signs to state "this slot
is declared to this account, now" (or withdrawn from it). It is the second
of the two messages the card signs in a card proof.

## Computation

```
preimage = "iamreal-declaration-v1" LF
           action                   LF
           scope_string             LF
           platform                 LF
           username                 LF
           challenge

declaration_code = "D" || first 30 characters of base32(SHA-256(preimage))
```

- `LF` is the byte `0x0A`. There is no trailing `LF`.
- `action` is `declare` or `withdraw`.
- `scope_string` is the full 31-byte scope string, including `_` padding
  (see ADR-0007).
- `platform` is the platform ID of the account, exactly as in the platform
  table ([`scope.md`](scope.md)).
- `username` is the account name on the platform, without `@`, in the
  `username` format of the platform ([`scope.md`](scope.md)).
- `challenge` is the challenge issued by the server for this card proof,
  written exactly as issued ([`challenge.md`](challenge.md)). It contains no
  `LF`.
- `base32` is the Crockford encoding defined in [`README.md`](README.md).

The result is 31 ASCII bytes: `D` followed by 30 characters carrying 150 bits
of the hash.

The preimage always has exactly six lines, and no line contains `LF`, so it
splits back into its values in only one way.

### Where the platform line is, and why the tag is still `v1`

The lines go from the widest to the narrowest: the scope, the platform in
it, the account on the platform, then the challenge of this one card proof.
`platform` and `username` together name the account, so they are adjacent.
The challenge stays last ([`challenge.md`](challenge.md)).

The platform line was added while this document was a draft (ADR-0017). The
version tag did not change: no roster has records computed the earlier way,
and the tag counts the computations that records in a roster were made
with. The earlier draft had five lines, so no preimage of it equals a
preimage of this one.

## Why each line is there

| Line | Purpose |
|---|---|
| Version tag | Lets the computation change later without ambiguity |
| `action` | A proof made for a declaration cannot be replayed as a withdrawal, or the reverse |
| `scope_string` | A code computed for one scope is not valid in another |
| `platform` | A proof made for an account on one platform cannot be recorded as a declaration on another. Every public platform shares one scope string and one scoped ID (ADR-0017), so this line is the only thing that ties a proof to its platform |
| `username` | With `platform`, names the account the slot is declared to |
| `challenge` | Shows the card signed after the server issued the challenge |

## Verification

A verifier recomputes the code from the record's `action`, `scope_string`,
`platform`, `username` and `challenge`, and checks that it equals the declaration code
exposed as a public input of the proof, `declaration_code_packed`: the 31
bytes packed as in [`scope.md`](scope.md). This is the only place the challenge
and the platform are bound: the circuit has no separate input for either.

## Test vectors

[`vectors/declaration-code.json`](vectors/declaration-code.json), with the
packed value of each code. The file still holds the vectors of the five-line
draft; it is to be regenerated for this document.

Example:

```
iamreal-declaration-v1
declare
iamreal:public:0_______________
threads
alice
2026-11-16.000G40R40M30E209185GR38E1W
```

gives `D695PT7N31SNR4BF3G05H0JYD7RHC7W` (SHA-256 of the preimage:
`324b6d1e…12219831`). This value was computed once, with a short script
that also reproduces the example of the five-line draft. It is not yet
backed by the vectors file, and is to be confirmed when the vectors are
regenerated.
