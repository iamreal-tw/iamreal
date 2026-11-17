# Proof verification

Status: **Draft**.

How to verify the proof of a record: the circuits, the public inputs, how
they are encoded, and the checks a verifier makes before and around the
proving system's verifier. [`record.md`](record.md) says where each public
input comes from; this document says how to hand them to the verifier and
what to watch for. A verifier that skips one of these checks has a hole the
circuit cannot close.

## Circuits and proving system

| Circuit | `issuer` | Public inputs | Verification key SHA-256 |
|---|---|---|---|
| `card_proof_rs2048` | `G2` | 23 | `816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8` |
| `card_proof_rs4096` | `G3` | 40 | `bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2` |

- Written in Noir (ADR-0012), compiled with `nargo` 1.0.0, proved and
  verified with Barretenberg's UltraHonk, `bb` 6.0.0 and bb.js 6.0.0.
- One card proof is one proof (ADR-0013). The two circuits make the same
  statement; only the issuer key size differs.
- Verification keys are 3,680 bytes, written with
  `bb write_vk -t noir-recursive`: Poseidon2 transcript, zero knowledge.
- The verification key is the same for the zero-knowledge and the
  non-zero-knowledge settings. It therefore cannot tell the two apart; the
  checks below do.

## Public inputs

Every public input is one element of the BN254 scalar field, below
`p = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001`.
`K` is the number of issuer key limbs: 18 for `card_proof_rs2048`, 35 for
`card_proof_rs4096`.

| Index | Name | Value | From |
|---|---|---|---|
| `0` .. `K−1` | `issuer_modulus` | The issuer's RSA modulus in 120-bit limbs, least significant first | [`issuers.md`](issuers.md) |
| `K` | `smt_root` | Root of the revocation tree | [`revocation-tree.md`](revocation-tree.md) |
| `K+1` | `current_time` | The decimal integer `YYMMDDHHMMSS` (UTC) the certificate must be valid at | [`challenge.md`](challenge.md) |
| `K+2` | `nullifier` | The scoped ID | [`scoped-id.md`](scoped-id.md) |
| `K+3` | `scope_packed` | The scope string, packed | [`scope.md`](scope.md) |
| `K+4` | `declaration_code_packed` | The declaration code, packed | [`declaration-code.md`](declaration-code.md) |

The challenge is not a public input. It is bound to the proof only through
the declaration code. A verifier that does not recompute the declaration code
from the record's challenge has not checked the challenge at all.

The same holds for the accounts. Every public platform shares one scope
string (ADR-0017), so `scope_packed` and `nullifier` are the same whatever
the platforms, and the circuit knows nothing about platforms or accounts.
The record's whole account list goes into the declaration code
([`declaration-code.md`](declaration-code.md)); a verifier that does not
recompute the code from all of it has not checked which accounts the proof
was made for.

## Encoding

`bb` reads the public inputs as one file: each input as a 32-byte big-endian
integer, concatenated in the order above, nothing in between.

| File | Size |
|---|---|
| Proof | exactly 14,656 bytes |
| Public inputs, `card_proof_rs2048` | exactly 23 × 32 = 736 bytes |
| Public inputs, `card_proof_rs4096` | exactly 40 × 32 = 1,280 bytes |

This binary form is the only form. `bb verify` also accepts JSON forms of the
same proof and inputs, with numbers spelled in many ways. A verifier writes
the binary files itself from the record and never passes on files in
another form.

## Checks before and around `bb verify`

| # | The verifier | Without it |
|---|---|---|
| 1 | Uses the verification key whose SHA-256 is the record's `circuit`, from the accepted circuits ([`record.md`](record.md)), and only for its `issuer` | Under any other key a proof states something else |
| 2 | Checks, before calling `bb`, that the decoded proof is exactly 14,656 bytes and that it wrote exactly 23 or 40 public inputs, the count for the key | Inputs of the wrong count would be checked against the wrong statement, or rejected in a way that depends on `bb`'s parser |
| 3 | Checks, before calling `bb`, that each public input is below `p` | Another implementation of the verifier may reduce a value modulo `p`, giving a second spelling of the same value |
| 4 | Runs `bb verify -t noir-recursive`, and only that. A proof that fails is rejected; it is not tried again under another setting | Under `-t noir-recursive-no-zk` the same key accepts a proof made without zero knowledge (13,120 bytes); such a proof does not hide the witness |
| 5 | Treats every outcome other than success as a rejection: a non-zero exit code, a crash, an exception, a timeout. Runs `bb` where a crash does not take the service down (a child process) | Barretenberg's native verifier can throw or abort on a crafted proof instead of returning failure (advisory GHSA-73xc-j27q-wg75, which lists `@aztec/bb.js`, `@aztec-foundation/bb.js` and `barretenberg-rs`; `bb` 6.0.0 contains the same verifier). bb.js `verifyProof` throws on malformed input instead of returning `false` |
| 6 | Builds every public input from the record as [`record.md`](record.md) says, never from a file that came with the proof | A proof verifies for whatever inputs it was made for; only the comparison with the record gives them meaning |

Duplicates and replay are handled by the roster rules, on the record's
fields: one challenge is used once ([`roster-rules.md`](roster-rules.md)).
Records have one spelling, so the same event cannot appear twice under
different bytes.

## The CRS

`bb verify` reads one file of Barretenberg's common reference string:
`bn254_g1.dat`, 64 bytes, the BN254 G1 generator `(1, 2)`, SHA-256
`d6ba9329f8932c12192b37849f772104d20048f76434a3290512d9d814e4116f`. A
verifier writes this file itself (it is `(1, 2)` as two 32-byte big-endian
integers) or checks its SHA-256, and points `bb` at it with `-c`. Without
it, `bb` downloads the start of the CRS over plain HTTP before verifying;
it checks a built-in hash, but a verifier should not depend on a download.

## What a proof guarantees

For a proof that verifies, under a verification key above, with public
inputs built as above:

- There is a certificate that the key `issuer_modulus` signed
  (RSASSA-PKCS1-v1_5, SHA-256, exponent 65537).
- The certificate passes the structural walk from its first byte: v3, signed
  with sha256WithRSAEncryption, an RSA subject key of exactly 2048 bits with
  exponent 65537 read from its position in the structure (ADR-0009), keyUsage
  exactly digitalSignature (ADR-0010), a citizen's primary card (ADR-0011).
  The walk does not read the two length fields of the extensions, and looks at
  no extension after subjectDirectoryAttributes.
- `notBefore <= current_time <= notAfter` (ADR-0008).
- The certificate's serial number is not in the tree with root `smt_root`.
- The certificate's key signed the 31 bytes of the scope string, whose first
  byte is `a`..`z` or `S` (ADR-0007, ADR-0013).
- `nullifier` is the scoped ID computed from that signature. The signature
  has exactly one accepted encoding (every limb in range, and the integer
  below the modulus), so one card has one scoped ID per scope string: one
  in the public roster, for all its platforms (ADR-0017).
- The same key signed the 31 bytes of the declaration code, whose first byte
  is `A`..`Z` other than `S`.

It says nothing about the challenge or the accounts by itself; see "Public
inputs".

The circuits have had two rounds of AI-assisted review and a check of the
fixes that followed. They have not been audited by a person, and will not be
before launch (ADR-0012).

## Open items

- **Where the circuit source is published**, with the instructions to
  rebuild the verification keys and compare their SHA-256.
- **A real proof as a test vector.** One proof per circuit with its public
  inputs, made with test keys, for testing a verifier's handling of the
  checks above.
