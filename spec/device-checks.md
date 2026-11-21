# Checks on the device

Status: **Draft**.

Before the card signs anything, the cardholder's device chooses the
certificate a card proof uses, checks it, and checks the CRL it builds the
revocation tree from. These checks protect the cardholder: a card that
cannot pass is told so before any PIN is used, and a server cannot loosen
them (ADR-0015, ADR-0016). This document defines them, so that every
client (the web page, the Android and iOS apps) gives the same answer for
the same certificates, CRLs and date.

Each check either passes or stops the card proof with a reason code. The
codes are the names used in the test vectors; what the screen says for each
is in `design/copy/`, not here.

Terms follow [`GLOSSARY.md`](../GLOSSARY.md).

## The certificate

**Input.** The certificates the card returns, in the order it returns them;
today's date in Taiwan (UTC+8), from the device's clock; the issuer keys of
[`issuers.md`](issuers.md), in the order of its table (G2, then G3). A
citizen digital certificate card returns a signing certificate and an
encryption certificate; the device does not rely on how many it gets or in
which order.

### DER

Where this section reads DER, it reads it strictly: one-byte tags (a tag
whose low five bits are all set is refused), definite lengths in their
shortest form (a long form of at most 4 length bytes, without leading zero
bytes, only for lengths of 128 or more), and no element running past the
end of the element that contains it.

### Checking one certificate

The steps below are applied in order. Each certificate gets either "passes"
or a reason code, and is marked **signing** or not.

1. **Split.** The certificate is a DER `SEQUENCE` that ends at the last byte
   of the input and contains exactly three elements: a `SEQUENCE`
   (`tbsCertificate`, called *tbs* below), a `SEQUENCE`, and a `BIT STRING`
   whose first content byte (the number of unused bits) is `00`. The rest of
   the `BIT STRING` is the issuer's signature. The middle element
   (`signatureAlgorithm`) is not read; the walk checks the algorithm inside
   the tbs. Anything else: `unsupported_format`, not signing.
2. **Walk.** The tbs goes through the walk below, the one the circuit makes
   (zkid-noir `lib/src/der.nr` `check_certificate`, ADR-0008 to ADR-0011),
   without its date comparison. The walk stops at one of three steps:
   `key_usage`, `holder` or `structure`, or passes. The certificate is
   **signing** unless the walk stopped at `key_usage`: an encryption
   certificate differs from the signing one there first.
3. **Dates.** If the walk read both dates (it got past row 7 of the walk) and
   the certificate is signing, compare them with `now`, the `current_time`
   of today's date ([`challenge.md`](challenge.md), "The date and
   `current_time`"), as integers: `now > notAfter` gives `expired`;
   `now < notBefore` gives `not_yet_valid`. Dates come before the walk's
   result: an expired card is the one problem the cardholder can act on.
4. **The walk's result.** Stopped at `holder`: `not_citizen_primary`.
   Stopped at `key_usage` or `structure`: `unsupported_format`.
5. **Issuer.** The signature is checked under each issuer key in the order of
   the table, as RSASSA-PKCS1-v1_5 (RFC 8017 section 8.2.2) with SHA-256 and
   exponent 65537 over the bytes of the tbs (its tag and length included).
   It verifies only if:
   - its length is the key's size in bytes (256 for G2, 512 for G3), with no
     byte added or removed;
   - read as a big-endian integer, it is below the key's modulus;
   - the decoded block is exactly `00 01`, `FF` bytes, `00` and the
     DigestInfo `30 31 30 0d 06 09 60 86 48 01 65 03 04 02 01 05 00 04 20`
     followed by the SHA-256 of the tbs. A DigestInfo without the `05 00`
     (NULL) parameters does not verify.

   The first key under which it verifies is the certificate's issuer. None:
   `unknown_issuer`.
6. Otherwise the certificate **passes**.

### The walk

`n` is the length of the tbs, offsets count from 0, and `tbs[i]` is the byte
at offset `i`. Reading a byte at an offset of `n` or more stops the walk at
`structure`. A fixed byte string is compared byte by byte, in order: the
first byte that is past the end stops the walk at `structure`, and the first
byte that differs stops it at the row's step. Every other condition that
fails stops it at the row's step.

| # | Offsets | Condition | Step |
|---|---|---|---|
| 1 | | `n ≤ 1527` (the circuit hashes at most 1536 bytes, SHA-256 padding included) | `structure` |
| 2 | 0 to 3 | `30 82`, then `tbs[2] × 256 + tbs[3] + 4 = n` | `structure` |
| 3 | 4 to 8 | `a0 03 02 01 02` (version 3) | `structure` |
| 4 | 9, 10, then `s` bytes | `tbs[9] = 02`; `s = tbs[10]`, `1 ≤ s ≤ 20`. The **serial number** is the `s` bytes from offset 11, read as an unsigned big-endian integer (a leading `00` counts as one of the `s` bytes) | `structure` |
| 5 | `a = 11 + s`, 15 bytes | `30 0d 06 09 2a 86 48 86 f7 0d 01 01 0b 05 00` (sha256WithRSAEncryption) | `structure` |
| 6 | `i = a + 15` | `tbs[i] = 30`; `m = tbs[i+1] < 128` (the issuer name, not read further) | `structure` |
| 7 | `v = i + 2 + m`, 32 bytes | `30 1e 17 0d`; at `v+4`, 12 ASCII digits, the first below `5`: **notBefore**; `5a 17 0d`; at `v+19`, 12 ASCII digits, the first below `5`: **notAfter**; `5a`. Each date is the decimal integer `YYMMDDHHMMSS`, UTC | `structure` |
| 8 | `u = v + 32` | `tbs[u] = 30`. With `b1 = tbs[u+1]` and `b2 = tbs[u+2]` (both are read): if `b1 = 81`, the subject is `b2` bytes, `b2 ≥ 128`, after a 3-byte header; otherwise `b1 < 128` and the subject is `b1` bytes after a 2-byte header. `k` is the offset just past the subject | `structure` |
| 9 | `k`, 33 bytes, then 256 | `30 82 01 22 30 0d 06 09 2a 86 48 86 f7 0d 01 01 01 05 00 03 82 01 0f 00 30 82 01 0a 02 82 01 01 00`; the 256 bytes from `k + 33` are the **card's modulus**, big-endian, the first of them at least `80` (exactly 2048 bits) | `structure` |
| 10 | `e = k + 289`, 5 bytes | `02 03 01 00 01` (exponent 65537) | `structure` |
| 11 | `e+5`, `e+9` | `a3 82` at `e+5` and `30 82` at `e+9`; the lengths at `e+7`, `e+8`, `e+11`, `e+12` are not read | `structure` |
| 12 | `e+13`, 13 bytes | `30 1f 06 03 55 1d 23 04 18 30 16 80 14` (authorityKeyIdentifier; its 20-byte identifier is not read) | `structure` |
| 13 | `e+46`, 11 bytes | `30 1d 06 03 55 1d 0e 04 16 04 14` (subjectKeyIdentifier; its 20-byte identifier is not read) | `structure` |
| 14 | `e+77`, 16 bytes | `30 0e 06 03 55 1d 0f 01 01 ff 04 04 03 02 07 80` (keyUsage, critical, digitalSignature only, ADR-0010) | `key_usage` |
| 15 | `e+93`, 71 bytes | `30 14 06 03 55 1d 20 04 0d 30 0b 30 09 06 07 60 86 76 65 00 03 03 30 33 06 03 55 1d 09 04 2c 30 2a 30 15 06 07 60 86 76 01 64 02 01 31 0a 06 08 60 86 76 01 64 03 01 01 30 11 06 07 60 86 76 01 64 02 33 31 06 0c 04` (the certificate policy and subjectDirectoryAttributes of a citizen's primary card, ADR-0011) | `holder` |
| 16 | | `n ≥ e + 168` | `structure` |

The walk does not look at any extension after subjectDirectoryAttributes, nor
at the bytes after the tbs.

### Choosing the certificate

- No certificate: `no_certificate`.
- Exactly one passes: it is the card proof's certificate.
- More than one passes: if they are all the same bytes, the first of them;
  otherwise `ambiguous_certificate`. The device does not choose between two
  certificates that both pass.
- None passes: the first signing certificate, in the card's order, whose
  reason is not `unsupported_format` gives the reason. If there is none, the
  reason is `unsupported_format`. With `expired` the device also reports that
  certificate's notAfter, and with `not_yet_valid` its notBefore, so the
  screen can say the date.

### What the device reads from the chosen certificate

- the issuer key (`G2` or `G3`), which decides the CRL and the circuit
  ([`issuers.md`](issuers.md));
- the serial number (row 4), the key of the revocation tree
  ([`revocation-tree.md`](revocation-tree.md));
- the card's modulus (row 9), to check the card's signatures before using
  them;
- notBefore and notAfter (row 7);
- the **name**, shown to the cardholder before the PIN and never sent
  anywhere: the value of the first attribute of type `2.5.4.3`
  (commonName) in the subject, reading its relative distinguished names and
  their attributes in order. A `BMPString` (tag `1e`) is UTF-16 big-endian;
  a value of any other tag is UTF-8. No commonName: the name is empty. The
  name is not checked and never compared, so how an implementation reads a
  subject that is not a well-formed `Name`, or shows text that is not valid
  UTF-8 or UTF-16, is its own choice (the web page shows an empty name); the
  vectors contain none.

### Reason codes

| Code | The certificate, or the card |
|---|---|
| `no_certificate` | The card returned no certificate |
| `expired` | notAfter is before the last second of today in Taiwan |
| `not_yet_valid` | notBefore is after the last second of today in Taiwan |
| `not_citizen_primary` | The certificate policy or subjectDirectoryAttributes are not those of a citizen's primary card (ADR-0011) |
| `unsupported_format` | Any other place where the walk stops: a format the circuit does not accept |
| `unknown_issuer` | Neither issuer key signed it |
| `ambiguous_certificate` | More than one different certificate passes every check |

## The CRL

The device builds the revocation tree from a CRL it checked itself
([`revocation-tree.md`](revocation-tree.md), "Who checks what"). This section
defines which CRL it takes from the mirror and when it refuses it.

**Input.** The issuer of the chosen certificate; today's date in Taiwan;
`crl_max_age_days` from the server's `config`
([`docs/api/card-proof.md`](../docs/api/card-proof.md)); the highest CRL
number this device remembers for the issuer, or none; the mirror's archive
index and files ([`revocation-tree.md`](revocation-tree.md), "Archive
index").

### The age bound

```
L = min(crl_max_age_days, 7)
```

`crl_max_age_days` is a JSON number that is a non-negative integer no larger
than 2^53 − 1. A config with any other value (negative, a fraction, a
string, `null`, larger) is not read at all: it is a malformed response
(`malformed_response`, [`docs/api/card-proof.md`](../docs/api/card-proof.md)),
and the card proof stops before any CRL is used. The server writes the
number as plain digits; how a number written with a fraction or an exponent
part that is an integer (`3.0`, `3e0`) is read is not specified, and the
vectors contain none.

7 is the bound built into the device. The server can make it stricter, never
looser: a mirror that serves old CRLs could otherwise learn whether a card
was suspended then ([`revocation-tree.md`](revocation-tree.md), "Why the
device has its own bound").

### Choosing a file from the index

The index is used only to find the file; nothing else in it is trusted.

- The index is read as UTF-8 text, without a byte order mark at its start if
  there is one, and split at each `0A`. Empty lines, and lines that are not
  a JSON object, are skipped. A text that is not UTF-8 is
  `crl_unavailable`.
- A line is a **candidate** if its `issuer` is the certificate's issuer, its
  `crl_number` is a string of decimal digits without a leading zero (or
  `0`), its `sha256` is 64 lowercase hex digits, and its `root` is 64
  lowercase hex digits. A line for a file that is not usable has `-` and a
  reason code as its `root`, so it is not a candidate. Other fields are not
  read; neither is the value of `root`.
- The candidate with the highest `crl_number`, compared as integers of any
  size, is chosen. If two candidates have that number and different
  `sha256`, none is chosen. No candidate, or none chosen: `crl_unavailable`.

The mirror writes every line in the one spelling of the archive index. The
vectors cover lines in that spelling and lines that are plainly not JSON;
what an implementation does with unusual JSON (duplicate keys, other
whitespace) is not specified.

### Checking the file

In this order, the first that fails decides:

1. The file named `<sha256>.crl` (the chosen line's `sha256`) is downloaded
   from the mirror. It cannot be (the request fails, or any status other
   than `200`): `crl_unavailable`.
2. Its SHA-256 is not the chosen `sha256`: `crl_hash`.
3. It is not usable under the issuer key of the certificate's issuer
   ([`revocation-tree.md`](revocation-tree.md), "Which CRLs"): `crl_unusable`,
   with the reason code of the archive index's table (the first in that
   table's order). Only that one key is tried: a CRL signed by the other
   issuer key is `not_usable_signature` here.
4. Its `cRLNumber` is lower than the highest this device remembers for the
   issuer: `crl_rollback`. The same number is not lower.
5. `today − CRL date`, in days, is more than `L`: `crl_stale`. The CRL date
   is `thisUpdate` as a date in Taiwan. A CRL date after today is not stale.

If it passes, the device remembers, for the issuer, the higher of its
`cRLNumber` and the number it remembered. If it fails, the remembered number
does not change. The remembered number is kept between card proofs; a device
that has lost it (for example, its storage was cleared) starts from none.

The device then builds the tree from the CRL's serial numbers
([`revocation-tree.md`](revocation-tree.md)). If the certificate's serial
number is in the tree, the card proof stops with `revoked`.

### Reason codes

| Code | Details reported | The CRL |
|---|---|---|
| `crl_unavailable` | | No file chosen from the index, the index is not UTF-8, or the index or the file could not be downloaded |
| `crl_hash` | | The file's SHA-256 is not the one the index gave |
| `crl_unusable` | the reason code | Not usable under the issuer key |
| `crl_rollback` | its CRL number, the highest remembered | A lower CRL number than this device has used for the issuer |
| `crl_stale` | the days since its CRL date, `L` | Older than `L` days |
| `revoked` | | It passed, and the certificate's serial number is on it |

## The server's answers

Between reading the card and the card's second signature, the device also
reads answers of the server. An answer it does not take stops the card
proof with a reason code of its own, so that the screen can say which:

| Answer | Code | Not taken when | Rules |
|---|---|---|---|
| `GET /api/v1/config` | `malformed_response` | `crl_max_age_days` is not read, or the platform table cannot be read | "The age bound" above; [`list-consequence.md`](list-consequence.md), "Reading the platform table" |
| `POST /api/v1/card-state` | `malformed_response` | The card's state cannot be read | [`list-consequence.md`](list-consequence.md), "Reading the card's state" |
| `POST /api/v1/challenges` | `challenge_malformed` | Not a challenge in its one spelling | [`challenge.md`](challenge.md), "The cardholder's device" |
| | `challenge_not_today` | Its date is not today in Taiwan | [`challenge.md`](challenge.md), "The cardholder's device" |

An answer that is an error of the server carries the server's own code
([`docs/api/card-proof.md`](../docs/api/card-proof.md)), which the device
shows as it is.

## Test vectors

[`vectors/device-checks.json`](vectors/device-checks.json):

- `issuers`: two test keys standing in for G2 and G3, in that order. Every
  certificate and CRL of the file is checked against these, never against
  the keys of [`issuers.md`](issuers.md).
- `certificate.cases`: the certificates a card returned (DER, hex) and
  today's date; the result is either the chosen certificate (its index in the
  input, issuer, serial number, card's modulus, notBefore, notAfter, name)
  or the reason code, with notAfter for `expired` and notBefore for
  `not_yet_valid`.
- `crl.max_age`: the server's `crl_max_age_days` as it is in the JSON
  (`server_max_age_days`), and `L` (`max_age_days`), or `null` where the
  config is not read.
- `crl.index`: an index and an issuer; the chosen `crl_number` and `sha256`,
  or `crl_unavailable`.
- `crl.cases`: the certificate's issuer key, today, the server's
  `crl_max_age_days` (`server_max_age_days`), the remembered CRL number, and
  the mirror's answers by file name (`index.jsonl` and `<sha256>.crl`): the
  HTTP status and the body in hex; a name not listed is answered with `404`.
  A request that gets no answer at all is not in the vectors. The result is
  the CRL used (its number, CRL date and SHA-256) or the reason code with its
  details, and in both cases the number remembered afterwards. A case with
  `serial` gives the serial number of the cardholder's certificate (one of
  the certificates of `certificate.cases`); its result is `revoked` if the
  CRL passes and that serial number is on it. In a case without `serial`
  the certificate is not on the CRL.

Which CRLs are usable, case by case with their reason codes, is in
[`../crl/testdata/`](../crl/testdata) (`expected.json`).

The file is written by `web/test/generate/device-checks.ts` from the test
fixtures of `web/test/fixtures/`, with keys made on the spot (the private
keys are not kept), so regenerating it changes every certificate and CRL.
The expected result of each case is written by hand in the generator, which
stops without writing if the web page's code disagrees. Run it from `web/`:

```
node --experimental-strip-types test/generate/device-checks.ts
```
