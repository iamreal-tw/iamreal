# Protocol specification

These documents define what every implementation must compute identically:
the strings a card signs, the record format, and the roster rules. They are
not feature requirements.

Terms follow [`GLOSSARY.md`](../GLOSSARY.md); the English identifiers given
there are the names used here.

| Document | Defines | Status |
|---|---|---|
| [`scope.md`](scope.md) | Scope strings: format, the accepted list, the `username` format of each, packing | Draft |
| [`challenge.md`](challenge.md) | The challenge: format, date, `current_time` | Draft |
| [`declaration-code.md`](declaration-code.md) | How the declaration code is computed | Draft |
| [`scoped-id.md`](scoped-id.md) | The scoped ID: computation, Poseidon2, text form, short ID | Draft |
| [`record.md`](record.md) | One record: fields, the one spelling of a line, roster files, record hash, the chain, how to verify it | Draft |
| [`roster-rules.md`](roster-rules.md) | How the state is computed from the records | Draft |

Planned: the revocation tree (how `crl/` builds it and which roots are
recognized), the issuer keys, and the checks on proofs and public inputs.

## Test vectors

`vectors/` holds one JSON file per document. `poseidon2.json` and
`poseidon2-constants.json` belong to `scoped-id.md` and will be shared with
the revocation tree. Every implementation (Go,
TypeScript, and later the mobile apps) runs its tests against these same
files, so an implementation that drifts from the specification fails its
tests.

## Shared conventions

- **Base32 alphabet**: Crockford, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
  Output is always uppercase, without padding or check symbol. Bytes are read
  as a big-endian bit string and cut into 5-bit groups from the most
  significant bit; a final short group is padded with zero bits on the right.
- **Text encoding**: UTF-8. Line separator is a single `0x0A`.
