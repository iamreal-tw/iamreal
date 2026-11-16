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
           username                 LF
           challenge

declaration_code = "D" || first 30 characters of base32(SHA-256(preimage))
```

- `LF` is the byte `0x0A`. There is no trailing `LF`.
- `action` is `declare` or `withdraw`.
- `scope_string` is the full 31-byte scope string, including `_` padding
  (see ADR-0007).
- `username` is the account name on the platform, lowercase, without `@`.
- `challenge` is the challenge issued by the server for this card proof,
  written exactly as issued ([`challenge.md`](challenge.md)). It contains no
  `LF`.
- `base32` is the Crockford encoding defined in [`README.md`](README.md).

The result is 31 ASCII bytes: `D` followed by 30 characters carrying 150 bits
of the hash.

## Why each line is there

| Line | Purpose |
|---|---|
| Version tag | Lets the computation change later without ambiguity |
| `action` | A proof made for a declaration cannot be replayed as a withdrawal, or the reverse |
| `scope_string` | A code computed for one scope is not valid in another |
| `username` | Names the account the slot is declared to |
| `challenge` | Shows the card signed after the server issued the challenge |

## Verification

A verifier recomputes the code from the record's `action`, `scope_string`,
`username` and `challenge`, and checks that it equals the declaration code
exposed as a public input of the proof. This is the only place the challenge
is bound: the circuit has no separate challenge input.

## Test vectors

[`vectors/declaration-code.json`](vectors/declaration-code.json). Example:

```
iamreal-declaration-v1
declare
iamreal:threads:0______________
alice
2026-11-16.000G40R40M30E209185GR38E1W
```

gives `DKE20ETW3YCPWH84JD2YDE1766QY6HZ`.
