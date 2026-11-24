# Protocol specification

These documents define what every implementation must compute identically:
the strings a card signs, the record format, and the record rules. They are
not feature requirements.

Terms follow [`GLOSSARY.md`](../GLOSSARY.md); the English identifiers given
there are the names used here.

| Document | Defines | Status |
|---|---|---|
| [`scope.md`](scope.md) | Scope strings: format, the accepted list, packing. Platforms: the table of each proof log, the `username` format of each platform, how one is added | Draft |
| [`challenge.md`](challenge.md) | The challenge: format, date, `current_time`, and the device's check when it receives one | Draft |
| [`declaration-code.md`](declaration-code.md) | How the declaration code is computed from a card's list of accounts | Draft |
| [`scoped-id.md`](scoped-id.md) | The scoped ID: computation, Poseidon2, text form, short ID | Draft |
| [`record.md`](record.md) | One record: fields, the account list, the one spelling of a line, log files, record hash, the proof log fingerprint, the published proof log, how to verify it | Draft |
| [`record-rules.md`](record-rules.md) | How the state is computed from the records: one date and one daily count per card, one slot and 5 switches per card and platform; the ordinal of each card. The card state file: the one spelling of a row, the file, how a re-verifier compares it with its own states | Draft |
| [`list-consequence.md`](list-consequence.md) | What a cardholder's list does, as the device shows it before the card signs: reading the platform table of `config` and the card's state, the card's state as the screen shows it, the list the card signs, one row per platform | Draft |
| [`records-response.md`](records-response.md) | The answer to a submission, as the device reads it after the card proof: `seq`, `record_hash`, the kinds of the record on each platform, and where they differ from the rows the confirmation screen showed | Draft |
| [`revocation-tree.md`](revocation-tree.md) | The revocation tree: which CRLs, the tree, which roots a record may use, the mirror | Draft |
| [`issuers.md`](issuers.md) | MOICA's issuer keys, their sources, and which circuit each uses | Draft |
| [`device-checks.md`](device-checks.md) | The checks on the device before the card signs: choosing and checking the certificate, which CRL from the mirror it uses and when it refuses one, and the reason codes for answers of the server it does not take | Draft |
| [`proof-verification.md`](proof-verification.md) | The circuits, the public inputs and their encoding, the checks around `bb verify`, what a proof guarantees | Draft |
| [`circuit-inputs.md`](circuit-inputs.md) | What the device gives the circuit, from the certificate, the signatures and the path, and the public inputs it expects back | Draft |
| [`min-app.md`](min-app.md) | The minimum app version in the server's `config`: how an app reads `min_app`, and when it goes on, warns or stops | Draft |
| [`card-channel.md`](card-channel.md) | The secure channel of second-generation cards, field by field as in its vectors | Draft |

The public proof log is one scope shared by every public platform: a card has
one scoped ID there and one slot on each platform (ADR-0017). One card
proof is one record, and a record states the card's whole list of accounts,
at most one per platform. The platforms are in that list and in the
declaration code, not in the scope string.

## Test vectors

`vectors/` holds one JSON file per document. `poseidon2.json` and
`poseidon2-constants.json` belong to `scoped-id.md` and
`revocation-tree.md`; `card-state-file.json` belongs to `record-rules.md`
("The card state file"); `card-status.json` belongs to
`list-consequence.md` ("The card's state, as shown"). Every implementation (Go,
TypeScript, and Rust in `device-core/`) runs its tests against these same
files, so an implementation that drifts from the specification fails its
tests. Of `record-rules.json`, Rust reads every case's `state` and not its
`ordinals`: the device does not compute the ordinal (`record-rules.md`, "The
ordinal"). `card-channel.json` is read by the tests of `android/` and `ios/`.

## Shared conventions

- **Base32 alphabet**: Crockford, `0123456789ABCDEFGHJKMNPQRSTVWXYZ`.
  Output is always uppercase, without padding or check symbol. Bytes are read
  as a big-endian bit string and cut into 5-bit groups from the most
  significant bit; a final short group is padded with zero bits on the right.
- **Text encoding**: UTF-8. Line separator is a single `0x0A`.
