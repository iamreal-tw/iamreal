# Scoped ID

Status: **Draft**.

The scoped ID identifies one card within one scope. Only the cardholder can
compute it: it is derived from the card's signature over the scope string
(ADR-0002). The same card has unrelated scoped IDs in different scopes. The
roster is keyed on (`scope_string`, `scoped_id`).

The algorithm does not change after launch (ADR-0012). Changing it would
give every card a new scoped ID and void every slot already declared.

## Computation

```
s         = card's RSASSA-PKCS1-v1_5 signature (SHA-256) over the 31 bytes
            of the scope string, as an integer below the card's modulus
            (the modulus is exactly 2048 bits)
limb[i]   = bits 120·i to 120·i + 119 of s, for i = 0 .. 17
            (least significant limb first)
state     = 0
for i in 0 .. 17:
    state = Poseidon2(state, limb[i])
scoped_id = state, an element of the BN254 scalar field
```

- PKCS#1 v1.5 signatures are deterministic, so `scoped_id` is a function of
  the card's key and the scope string.
- Each limb is below 2^120, and `s` is below the modulus. The circuit checks
  both, so one signature has exactly one list of limbs.
- `Poseidon2(a, b)` is Barretenberg's Poseidon2 sponge over the BN254 scalar
  field (state width 4, 8 full and 56 partial rounds) over the two elements
  `a`, `b`, as Noir's `Poseidon2::hash([a, b], 2)` computes it (the `poseidon`
  library, v0.3.0). The sponge construction (initial state, padding) is part
  of the definition. The vectors in `poseidon2.json` pin it down; an
  implementation that does not reproduce them is not this hash.
- The circuit names this value `nullifier`. It is a public input of the
  proof.

## Text form

Records, URLs and screens show the scoped ID as text:

```
bytes     = scoped_id as 32 bytes, little-endian
text      = base32(bytes)          (Crockford, see README.md)
```

- 52 uppercase characters. 256 bits fill 51 groups of 5 bits and one more
  bit, so the last character carries four zero padding bits and is always `0`
  or `G`.
- Little-endian, the reverse of the big-endian public input. The field
  modulus is about 2^253.6, so the most significant bits of a field element
  are not uniform. Big-endian text would start with `0` to `5` only, leaving
  the short ID with about 27.6 bits. Little-endian puts the uniform low bits
  first.

**Parsing** a scoped ID from a record is strict. The text is exactly 52
characters of the alphabet, uppercase, its padding bits are zero, and the
decoded value is below the field modulus. Equivalently: decode, then
re-encode, and require the same string. Anything else is rejected, so one
scoped ID has one spelling.

## Short ID

```
short_id = first 6 characters of the text form
```

30 bits, used only in URLs to point at one card on an account's badge page.
It is not unique across the roster. How pages resolve two cards with the
same short ID on one account is outside this document.

In URLs, short IDs are read case-insensitively, with `O` read as `0` and `I`
and `L` as `1`. This leniency applies to short IDs in URLs only, never to
records.

## Test vectors

- [`vectors/poseidon2.json`](vectors/poseidon2.json): `hash_2`, `hash_3`, and
  under `scoped_id` the full computation from a 256-byte signature through
  its 18 limbs to the field element. Its `revocation_tree` part belongs to
  the revocation tree specification (not written yet).
- [`vectors/scoped-id.json`](vectors/scoped-id.json): field elements and their
  little-endian bytes, text form and short ID; texts a parser must reject.

The signatures in the vectors come from throwaway keys, not from cards.
