# Circuit inputs

Status: **Draft**.

What the cardholder's device gives the circuit, and the public inputs it
expects the proof to carry. Every implementation that makes a proof (the web
page, the apps' `device-core/`) computes the same inputs from the same
certificate, signatures and path, so the same proof statement is made
whichever one runs. [`proof-verification.md`](proof-verification.md) is the
other side: how a verifier builds the public inputs from a record.

## What goes in

- **The certificate**: the card's signing certificate, as the device read
  it from the card and checked it, in DER.
- **The issuer key**: the key of [`issuers.md`](issuers.md) under which the
  certificate's signature verifies. It decides the circuit: `G2` (RSA 2048)
  `card_proof_rs2048`, `G3` (RSA 4096) `card_proof_rs4096`. `K` below is the
  number of limbs of that table: 18 or 35.
- **The path**: the proof of absence of the certificate's serial number in
  the revocation tree ([`revocation-tree.md`](revocation-tree.md), "Proof of
  absence").
- **`current_time`**: from the date of the challenge
  ([`challenge.md`](challenge.md)).
- **The scope string** and the **declaration code**, 31 bytes each
  ([`scope.md`](scope.md), [`declaration-code.md`](declaration-code.md)),
  and the card's two signatures over them (RSASSA-PKCS1-v1_5, SHA-256),
  256 bytes each.

The device computes every input itself. The only value the server chose is
the challenge, which enters through `current_time` and the declaration code;
the root comes from the tree the device built, never from a server.

## Inputs

Numbers in limbs are split into 120-bit limbs, least significant first, the
way [`scoped-id.md`](scoped-id.md) splits a signature. A big-endian byte
string is read as an unsigned integer first.

| Input | Public | Value |
|---|---|---|
| `tbs` | no | The certificate's `tbsCertificate`, the whole element (tag, length, content), followed by zero bytes up to 1,536 bytes |
| `tbs_len` | no | The length of `tbsCertificate` in bytes, without the zeros |
| `issuer_modulus` | yes | The issuer key's modulus, `K` limbs |
| `issuer_redc` | no | `⌊2^(2·b + 6) / n⌋` for the issuer modulus `n` of `b` bits (2048 or 4096), `K` limbs |
| `issuer_signature` | no | The certificate's `signatureValue`: the BIT STRING's content after its first byte (unused bits, `00`), `b / 8` bytes, `K` limbs |
| `smt_root` | yes | The root of the revocation tree |
| `smt_siblings` | no | The path's 128 siblings, from the root down |
| `smt_old_key` | no | The key of the leaf the path ends at; `0` if it ends in an empty subtree |
| `smt_old_value` | no | `1` if the path ends at a leaf; `0` if it ends in an empty subtree |
| `smt_is_old0` | no | Whether the path ends in an empty subtree (a boolean) |
| `current_time` | yes | `current_time` of the challenge's date |
| `card_redc` | no | `⌊2^(2·2048 + 6) / m⌋` for the card's modulus `m`, read from the certificate's subject public key (2048 bits), 18 limbs |
| `scope` | no | The 31 bytes of the scope string |
| `scope_signature` | no | The card's signature over `scope`, 18 limbs |
| `declaration_code` | no | The 31 bytes of the declaration code |
| `declaration_code_signature` | no | The card's signature over `declaration_code`, 18 limbs |

`issuer_redc` and `card_redc` are the Barrett reduction parameters the
circuit's RSA check takes next to each modulus. The card's modulus is not an
input: the circuit reads it from `tbs`, at the position its walk of the
structure finds it.

The circuit accepts a `tbs_len` of at most 1,527: the reference circom
circuit takes the SHA-256-padded `tbsCertificate` in a 1,536-byte buffer,
and the padding adds at least 9 bytes. The device's checks of the
certificate stop a longer one before the PIN, so the device never reaches
this step with one.

## Public inputs the device expects

The proof carries the public inputs in the order of
[`proof-verification.md`](proof-verification.md), "Public inputs". The
device builds the same list from what it holds:

| Index | Value |
|---|---|
| `0` .. `K−1` | `issuer_modulus`, as above |
| `K` | `smt_root` |
| `K+1` | `current_time` |
| `K+2` | The scoped ID computed from `scope_signature` ([`scoped-id.md`](scoped-id.md)) |
| `K+3` | `scope` packed ([`scope.md`](scope.md)) |
| `K+4` | `declaration_code` packed ([`declaration-code.md`](declaration-code.md)) |

The first three come straight from the inputs; the circuit computes the last
three. The device compares the proof's public inputs with this list and
sends nothing if any differs: a proof whose scoped ID is not the one the
device computed, or whose declaration code is not the one the card signed,
would declare something the cardholder did not confirm.

## Test vectors

[`vectors/circuit-inputs.json`](vectors/circuit-inputs.json): certificates
issued by test keys (not MOICA's), with their paths, signatures and
`current_time`, the whole input map and the expected public inputs. Each
circuit has two cases: one path ends at a leaf, the other in an empty
subtree, one signs the test log's scope string and the other the public
proof log's. The circuits in [`../web/circuits/`](../web/circuits) accept each
input map, and compute the last three public inputs as listed. Each path is
the path of the certificate's serial number in the CRL the case names in
[`vectors/revocation-tree.json`](vectors/revocation-tree.json). How
`current_time` follows from a challenge and the declaration code from the
accounts have their own vectors, in
[`vectors/challenge.json`](vectors/challenge.json) and
[`vectors/declaration-code.json`](vectors/declaration-code.json); here they
are given.

A case's `current_time` is a JSON number, the decimal `YYMMDDHHMMSS`. In
its `inputs`, `tbs`, `scope` and `declaration_code` are written as hex
strings of their bytes, `tbs` with its zeros; `tbs_len` is a JSON number and
`smt_is_old0` a boolean; every other value, each limb included, is a
0x-prefixed field element of 64 hex digits.
