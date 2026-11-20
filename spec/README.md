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
| [`declaration-code.md`](declaration-code.md) | How the declaration code is computed from a card's list of accounts | Draft |
| [`scoped-id.md`](scoped-id.md) | The scoped ID: computation, Poseidon2, text form, short ID | Draft |
| [`record.md`](record.md) | One record: fields, the account list, the one spelling of a line, roster files, record hash, the roster fingerprint, the published roster, how to verify it | Draft |
| [`roster-rules.md`](roster-rules.md) | How the state is computed from the records: one date and one daily count per card, one slot and 5 switches per card and platform. The card state file: the one spelling of a row, the file, how a re-verifier compares it with its own states | Draft |
| [`list-consequence.md`](list-consequence.md) | What a cardholder's list does, as the device shows it before the card signs: reading the platform table of `config` and the card's state, the list the card signs, one row per platform | Draft |
| [`revocation-tree.md`](revocation-tree.md) | The revocation tree: which CRLs, the tree, which roots a record may use, the mirror | Draft |
| [`issuers.md`](issuers.md) | MOICA's issuer keys, their sources, and which circuit each uses | Draft |
| [`device-checks.md`](device-checks.md) | The checks on the device before the card signs: choosing and checking the certificate, which CRL from the mirror it uses and when it refuses one | Draft |
| [`proof-verification.md`](proof-verification.md) | The circuits, the public inputs and their encoding, the checks around `bb verify`, what a proof guarantees | Draft |
| [`circuit-inputs.md`](circuit-inputs.md) | What the device gives the circuit, from the certificate, the signatures and the path, and the public inputs it expects back | Draft |

The public roster is one scope shared by every public platform: a card has
one scoped ID there and one slot on each platform (ADR-0017). One card
proof is one record, and a record states the card's whole list of accounts,
at most one per platform. The platforms are in that list and in the
declaration code, not in the scope string.

## Test vectors

`vectors/` holds one JSON file per document. `poseidon2.json` and
`poseidon2-constants.json` belong to `scoped-id.md` and
`revocation-tree.md`; `card-state-file.json` belongs to `roster-rules.md`
("The card state file"). Every implementation (Go,
TypeScript, and Rust in `device-core/`) runs its tests against these same
files, so an implementation that drifts from the specification fails its
tests.

## Shared conventions

- **Base32 alphabet**: Crockford, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
  Output is always uppercase, without padding or check symbol. Bytes are read
  as a big-endian bit string and cut into 5-bit groups from the most
  significant bit; a final short group is padded with zero bits on the right.
- **Text encoding**: UTF-8. Line separator is a single `0x0A`.
