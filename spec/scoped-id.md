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
- `Poseidon2(a, b)` is defined in the next section.
- The circuit names this value `nullifier`. It is a public input of the
  proof.

## Poseidon2

`Poseidon2(x_1, …, x_n)` for `n` = 2 or 3 field elements. `n = 3` is used by
the revocation tree.

**Field.** The BN254 scalar field, modulus

```
p = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001
```

Inputs are field elements, that is, integers below `p`.

**Sponge.** This construction is Barretenberg's, not the paper's.

```
state     = [0, 0, 0, n · 2^64]
state[i]  = state[i] + x_(i+1)        for i = 0 .. n−1
state     = permutation(state)
result    = state[0]
```

One permutation, no padding. The length `n` in the last element is what
keeps `Poseidon2(a, b)` and `Poseidon2(a, b, 0)` apart.

**Permutation.** The Poseidon2 permutation of Grassi, Khovratovich and
Schofnegger ("Poseidon2: A Faster Version of the Poseidon Hash Function",
2023) with:

| Parameter | Value |
|---|---|
| State width `t` | 4 |
| S-box | `x^5` |
| Full rounds | 8: 4 before the partial rounds, 4 after |
| Partial rounds | 56 |
| External matrix `M_E` | `[[5,7,1,3],[4,6,1,1],[1,3,5,7],[1,1,4,6]]` |
| Internal matrix `M_I` | `J + diag(d_0, d_1, d_2, d_3)`, `J` the all-ones matrix: `s_i ← s_i · d_i + (s_0 + s_1 + s_2 + s_3)` |

```
state = M_E · state
4 times:  state_i = (state_i + c_i)^5 for every i;  state = M_E · state
56 times: state_0 = (state_0 + c)^5;                 state = M_I · state
4 times:  state_i = (state_i + c_i)^5 for every i;  state = M_E · state
```

The round constants (4 × 4 + 56 + 4 × 4) and `d_0 .. d_3` are in
[`vectors/poseidon2-constants.json`](vectors/poseidon2-constants.json). They
come from the paper's reference generation procedure for these parameters
(Grain LFSR) and equal the constants in Barretenberg and in gnark-crypto.

**What pins it in the circuit.** The circuit calls Noir's built-in
`poseidon2_permutation`, which `nargo` (witness generation) and `bb` (the
proving system) implement. The versions that pin it are therefore `nargo`
1.0.0 and `bb` 6.0.0, not the version of the `poseidon` library that wraps
the sponge around it.

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

- [`vectors/poseidon2-constants.json`](vectors/poseidon2-constants.json): the
  constants, and the permutation of `[0, 1, 2, 3]`, to tell a wrong
  permutation from a wrong sponge.
- [`vectors/poseidon2.json`](vectors/poseidon2.json): `hash_2` and `hash_3`
  (`Poseidon2` of 2 and 3 elements), and under `scoped_id` the full computation from a 256-byte signature through
  its 18 limbs to the field element. Its `revocation_tree` part belongs to
  the revocation tree specification (not written yet).
- [`vectors/scoped-id.json`](vectors/scoped-id.json): field elements and their
  little-endian bytes, text form and short ID; texts a parser must reject;
  short IDs as typed in URLs and how they read.

The signatures in the vectors come from throwaway keys, not from cards.
