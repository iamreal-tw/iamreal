# Protocol specification

These documents define what every implementation must compute identically:
the strings a card signs, the record format, and the roster rules. They are
not feature requirements.

Terms follow [`GLOSSARY.md`](../GLOSSARY.md); the English identifiers given
there are the names used here.

| Document | Defines | Status |
|---|---|---|
| [`scope.md`](scope.md) | Scope strings: format, the accepted list, packing. Platforms: the table of each roster, the `username` format of each platform, how one is added | Draft |
| [`challenge.md`](challenge.md) | The challenge: format, date, `current_time` | Draft |
| [`declaration-code.md`](declaration-code.md) | How the declaration code is computed | Draft |
| [`scoped-id.md`](scoped-id.md) | The scoped ID: computation, Poseidon2, text form, short ID | Draft |
| [`record.md`](record.md) | One record: fields, the one spelling of a line, roster files, record hash, the chain, how to verify it | Draft |
| [`roster-rules.md`](roster-rules.md) | How the state is computed from the records: one date per card, one slot per card and platform | Draft |
| [`revocation-tree.md`](revocation-tree.md) | The revocation tree: which CRLs, the tree, which roots a record may use, the mirror | Draft |
| [`issuers.md`](issuers.md) | MOICA's issuer keys, their sources, and which circuit each uses | Draft |
| [`proof-verification.md`](proof-verification.md) | The circuits, the public inputs and their encoding, the checks around `bb verify`, what a proof guarantees | Draft |

The public roster is one scope shared by every public platform: a card has
one scoped ID there and one slot on each platform (ADR-0017). The platform
is a field of the record and a line of the declaration code, not a part of
the scope string.

## Test vectors

`vectors/` holds one JSON file per document. `poseidon2.json` and
`poseidon2-constants.json` belong to `scoped-id.md` and
`revocation-tree.md`. Every implementation (Go,
TypeScript, and later the mobile apps) runs its tests against these same
files, so an implementation that drifts from the specification fails its
tests.

`scope.json`, `declaration-code.json`, `record.json` and
`roster-rules.json` still hold the vectors from before ADR-0017 and are to
be regenerated. Until then the documents and those four files disagree, and
so do the tests that read them.

## Shared conventions

- **Base32 alphabet**: Crockford, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
  Output is always uppercase, without padding or check symbol. Bytes are read
  as a big-endian bit string and cut into 5-bit groups from the most
  significant bit; a final short group is padded with zero bits on the right.
- **Text encoding**: UTF-8. Line separator is a single `0x0A`.
