# The secure channel of second-generation cards

Status: **Draft**.

What an app computes to verify the PIN and sign with a second-generation
card over the secure channel the card requires, field by field as in
[`vectors/card-channel.json`](vectors/card-channel.json).

Source: the secure channel's steps and key material are from `GpkiCard.kt`
of [`mctea01/my-Bonds-fork-android`](https://github.com/mctea01/my-Bonds-fork-android/blob/a8696253a4c4be6c88a3618fded4c716b13f72fa/core/src/commonMain/kotlin/diw/wallet/core/document/card/GpkiCard.kt)
(Apache-2.0, commit `a8696253`).

Bytes are written as lowercase hex. AES is AES-128; AES-CMAC is RFC 4493;
`||` is concatenation. Every value in the vectors is made up, including the
key material: an implementation passes the key material to its derivation
as a parameter, and the tests give it the vectors' values.

## `diversify`: the card's static keys

| Field | |
|---|---|
| `kek`, `master_enc` | The key material, 16 bytes each |
| `card_id` | The card identifier, 10 bytes (`card_id` below) |
| `master` | AES-ECB decryption of `master_enc` with `kek` |
| `k_enc_input`, `k_mac_input` | 32 bytes, all zero except: byte `0x0b` the constant (`04` for `k_enc`, `06` for `k_mac`); `0x0e` = `80`; `0x0f` = `01`; `0x10` = `01` for `k_enc`, `02` for `k_mac`; `0x11`–`0x1a` the card identifier; `0x1b`–`0x1f` the last five bytes of the security domain's AID `a000000283ff088692535389c00014` |
| `k_enc`, `k_mac` | AES-CMAC with `master` of `k_enc_input`, `k_mac_input` |

## `card_id`: the card identifier

`response` is the data of GET DATA (`80 ca 00 45`) from the security domain.
`card_id` is bytes 2–11 when the data is at least 12 bytes and begins with
`45 0a`; otherwise `null`, and the app stops before it sends the PIN.

## `initialize_update`: the card's challenge

`response` is the data of INITIALIZE UPDATE (`80 50 01 00`, the host
challenge as data). `accepted` is true when the data is at least 29 bytes and
byte 11 is `03`; then `card_challenge` is bytes 13–20 and `card_cryptogram`
bytes 21–28. When it is false, the app stops before it sends the PIN.

## `session`: the session keys

`kdf(key, constant, context, bits)` is AES-CMAC with `key` of
`00`×11 `|| constant || 00 || bits (2 bytes, big-endian) || i || context`, for
`i` = 1, 2, … (one byte), concatenated and cut to `bits / 8` bytes.

| Field | |
|---|---|
| `k_enc`, `k_mac` | The card's static keys |
| `host_challenge` | 8 bytes the app chose |
| `card_challenge`, `card_cryptogram` | From the card (`initialize_update`) |
| `s_mac` | `kdf(k_mac, 06, host_challenge \|\| card_challenge, 128)` |
| `s_enc` | `kdf(k_enc, 04, host_challenge \|\| card_challenge, 128)` |
| `expected_card_cryptogram` | `kdf(s_mac, 00, host_challenge \|\| card_challenge, 64)` |
| `accepted` | `card_cryptogram` equals `expected_card_cryptogram`. When it does not, the app stops before it sends the PIN, and the case has no further fields |
| `host_cryptogram` | `kdf(s_mac, 01, host_challenge \|\| card_challenge, 64)` |
| `external_authenticate` | `header` is `84 82 03 00 10`; `body` is `host_cryptogram` and the first 8 bytes of `mcv` |
| `mcv` | AES-CMAC with `s_mac` of `00`×16 `\|\| header \|\| host_cryptogram`: the chaining value the first command starts from |

## `sequence`: commands

One session (`s_enc`, `s_mac`, `mcv` as in `session`) and the commands sent
in it, in order. Each step gives the plain command (`cla`, `ins`, `p1`,
`p2` as numbers, `data`, `encrypt`) and what goes to the card:

| Field | |
|---|---|
| `counter` | The command's number in the session: 1 for the first command after EXTERNAL AUTHENTICATE, then one more for **every** command, with or without data |
| `iv` | When `encrypt` is true and `data` is not empty: AES-ECB encryption with `s_enc` of `00`×12 `\|\| counter (4 bytes, big-endian)`. Otherwise `null` |
| `header` | `cla \| 04`, `ins`, `p1`, `p2`, and the length of what follows the header (the encrypted data and 8) |
| `body` | When `iv` is not `null`: AES-CBC encryption with `s_enc` and `iv` of `data \|\| 80`, padded with `00` to a multiple of 16; then the first 8 bytes of the new `mcv` |
| `mcv` | AES-CMAC with `s_mac` of the previous `mcv \|\| header \|\| encrypted data`; the next command chains from it |

The expected length (Le) the app sends after `body` is not covered by the
MAC and is not in the vectors. The steps are those of one signing
(VERIFY, SELECT `5030`, SELECT `0810`, the two halves of `sign_block`, the
commands that read the rest of the signature) and a second VERIFY in the
same session, after two commands without data.

## `pin_block`

The data of VERIFY: the PIN's bytes, padded with `ff` to 10 bytes. A PIN of
fewer than 6 or more than 10 characters, or with a character outside
`0x20`–`0x7e`, has no block (`null`), and nothing is sent to the card.

## `sign_block`

What the card is given to sign for `message`: EMSA-PKCS1-v1_5 with SHA-256
for a 2048-bit key (RFC 8017), 256 bytes, sent as two halves of 128.

## The vectors

The file is written by `protocol/test/generate/card-channel.ts`, using AES
from `node:crypto` and AES-CMAC built on it (checked against the examples of
RFC 4493 first). Each case's acceptance is also written by hand in the
generator, which stops without writing if they differ. Run it from
`protocol/`:

```
node --experimental-strip-types test/generate/card-channel.ts
```
