# Protocol specification

These documents define what every implementation must compute identically:
the strings a card signs, the record format, and the roster rules. They are
not feature requirements.

Terms follow [`GLOSSARY.md`](../GLOSSARY.md); the English identifiers given
there are the names used here.

| Document | Defines | Status |
|---|---|---|
| [`declaration-code.md`](declaration-code.md) | How the declaration code is computed | Draft |

Planned: `scoped-id.md`, `record.md`, `roster-rules.md`, `challenge.md`.

## Test vectors

`vectors/` holds one JSON file per document. Every implementation (Go,
TypeScript, and later the mobile apps) runs its tests against these same
files, so an implementation that drifts from the specification fails its
tests.

## Shared conventions

- **Base32 alphabet**: Crockford, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
  Output is always uppercase, without padding or check symbol. Bytes are read
  as a big-endian bit string and cut into 5-bit groups from the most
  significant bit; a final short group is padded with zero bits on the right.
- **Text encoding**: UTF-8. Line separator is a single `0x0A`.
