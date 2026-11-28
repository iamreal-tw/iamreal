# Revocation tree

Status: **Draft**.

The proof shows that the certificate's serial number is not in a tree whose
root is the public input `smt_root`. The tree is built from a certificate
revocation list (CRL) that MOICA signed. The cardholder's device builds the
tree itself from a copy of that CRL. A root supplied by the server could hide
extra serials and test whether a given person passes, so the device never
takes one.

This document defines the tree, which CRLs it is built from, and which roots
a record may use.

## One tree per issuer key

MOICA signs one CRL per issuer key: G2 (RSA 2048) and G3 (RSA 4096). Each CRL
gives its own tree. A card's certificate is checked against the tree of the
key that issued it, so a record with `issuer` `G3` uses the root of a G3 CRL.
The device needs only the CRL of its own issuer.

## Which CRLs

A CRL is usable if:

- it is a `CertificateList` (RFC 5280 section 5) in DER, with its times
  spelled as in "Times" below, signed with sha256WithRSAEncryption with
  NULL parameters (both in `tbsCertList` and outside it), and the signature
  verifies under the issuer key;
- it has a `cRLNumber` extension holding a non-negative DER INTEGER in its
  shortest encoding, with at most 20 content bytes (a leading `00` counts),
  the most RFC 5280 section 5.2.3 allows. The device compares CRL numbers
  ("Who checks what");
- it is a complete CRL for everything the key issued: it has neither a
  `deltaCRLIndicator` nor an `issuingDistributionPoint` extension, critical
  or not; no extension appears twice, in the CRL or in an entry; and no
  extension is critical, in the CRL or in any entry (so an indirect CRL, with
  a critical `certificateIssuer` entry extension, is not usable). MOICA's CRLs, as checked
  on 2026-11-16, carry only `authorityKeyIdentifier` and `cRLNumber`, and each
  entry only a non-critical `reasonCode`. If MOICA starts partitioning its
  CRLs, devices stop rather than build an incomplete tree, and this document
  changes;
- the CRL has at most 16 extensions, and so does each entry. RFC 5280
  defines 7 extensions of a CRL (sections 5.2.1 to 5.2.7) and 3 of an entry
  (5.3.1 to 5.3.3). MOICA's carry 2 and 1: every one of the 16 CRLs in the
  test site's archive on 2026-11-21 (`test-data.iamreal.tw`, G2 and G3, CRL
  numbers 2026111917 to 2026112110). The bound keeps the time and memory of
  reading a file in proportion to its size: the archive keeps every file the mirror
  downloads, signed or not ("Archive index"), and every re-verifier reads
  each of them;
- every serial number in `revokedCertificates` is a valid DER INTEGER in its
  shortest encoding, not negative, with at most 20 content bytes (a leading
  `00` counts), so that it gives a key (below);
- no two **different** keys share their lowest 127 bits. The same serial
  number listed twice is one key.

A CRL that fails any of these gives no tree. `crl/` stops with an error; the
device does not make a proof.

The **CRL date** is `thisUpdate` converted to a date in Taiwan (UTC+8).

### Times

`thisUpdate`, `nextUpdate` and the `revocationDate` of every entry are read
only in the two spellings RFC 5280 gives them (sections 4.1.2.5.1 and
4.1.2.5.2, which sections 5.1.2.4 to 5.1.2.6 apply to CRLs):

- `UTCTime` `YYMMDDHHMMSSZ`: twelve digits, then `Z`. `YY` from `50` to `99`
  is 1950 to 1999, from `00` to `49` is 2000 to 2049;
- `GeneralizedTime` `YYYYMMDDHHMMSSZ`: fourteen digits, then `Z`, for any
  year from 0000 to 9999.

The time must exist in the Gregorian calendar, extended backwards to year 0:
month `01` to `12`, a day the month has, hour `00` to `23`, minute and second
`00` to `59`. Nothing else is read: no offset such as `+0800`, not even
`+0000`; no time without seconds; no fraction of a second; no lowercase `z`.
Which of the two types holds a time is not checked against its year: a
`GeneralizedTime` in 2026 is read. A file with a time spelled in any other
way is not a DER `CertificateList`.

MOICA's CRLs, as checked on 2026-11-19, spell every time as a `UTCTime` of
twelve digits and `Z`.

### Object identifiers

The `OBJECT IDENTIFIER` that names an extension, of the CRL or of an entry,
is read as DER writes one (X.690, 8.19), with one bound more. Its content is
one or more numbers, each written in base 128, most significant digit first,
one digit to a byte, every byte but the number's last with its highest bit
set. It must:

- not be empty;
- end where a number ends: its last byte has its highest bit clear;
- write every number in its shortest form: no number begins with the byte
  `0x80`;
- hold no number above 2^31 - 1 (2147483647). This counts the numbers as
  written, so the first, which stands for the identifier's first two arcs
  (40 times the first plus the second), is bounded like the others.

A file with an extension whose identifier is written in any other way is not
a DER `CertificateList`. The identifiers elsewhere in the file are not read
as numbers: the two of the signature algorithm are compared as bytes with
the one algorithm accepted ("Reason codes", row 2), and those inside the
issuer's name are not looked at. The bound is not DER's, which has none: it is what
the readers this specification started from accept, and it is written here
so that every implementation draws the line at the same number. The
identifiers of RFC 5280, and every one in MOICA's CRLs, are far below it.

## Tree

**Key.** The serial number's content bytes (without the DER tag and length)
read as an unsigned big-endian integer. This is the value the circuit reads
from the certificate. A serial number has at most 20 content bytes. The
serial number 0 gives the key 0.

**Shape.** circomlib's sparse Merkle tree, hashed with `Poseidon2`
([`scoped-id.md`](scoped-id.md)). For a set `S` of keys at level `l`,
starting from `l = 0` at the root:

```
node(S, l) = 0                              if S is empty
           = Poseidon2(k, 1, 1)             if S = {k}
           = Poseidon2(node(S0, l+1),       otherwise, where S0 holds the
                       node(S1, l+1))       keys whose bit l is 0, S1 those
                                            whose bit l is 1
root       = node(all keys, 0)
```

Bit `l` counts from the least significant bit. The path uses bits 0 to 126,
so two keys that agree on their lowest 127 bits cannot be in one tree. The
circuit's tree has depth 128 and requires the last sibling to be zero. An
empty CRL gives root `0`.

In records the root is written as 64 lowercase hex digits, big-endian
([`record.md`](record.md)).

**Proof of absence.** For the cardholder's key `k`, the device walks from
the root along the bits of `k` until it reaches an empty subtree or a single
leaf. It gives the circuit:

- the siblings along the way, from the root down, followed by zeros up to 128;
- whether the subtree reached is empty (`is_old0`);
- if not, the key in that leaf (`old_key`), which differs from `k`, and its
  value (`old_value`, which is `1`).

## Which roots a record may use

A record's `smt_root` is **recognized** if it is the root of a usable CRL
signed by the issuer key of the record's `issuer`, and the record's date `d`
(the date in its challenge) satisfies

```
CRL date − 1 day  ≤  d  ≤  CRL date + 3 days
```

Otherwise the record is invalid with code `root`
([`record-rules.md`](record-rules.md)). When no certificate was revoked
between two CRLs, both have the same tree and the same root; one usable CRL
whose date fits is enough.

- **The upper bound** means a record's date cannot run more than 3 days
  ahead of the newest CRL that exists. MOICA has not signed future CRLs, so
  the date cannot be written further into the future.
- **The lower bound** means a card proof is not older than the CRL it used,
  allowing one day around midnight: a challenge issued at 23:58 can be
  answered with a CRL issued at 00:00.
- **3 days** is how long the service keeps working if MOICA stops issuing
  CRLs. MOICA issues at least one per day, each valid for at most 36 hours
  (MOICA's Certification Practice Statement
  [v2.2](https://moica.nat.gov.tw/moica//upload/repository/1a21204c7f4000008879.pdf),
  section 4.9.7, page 35). Within the 3 days, a card revoked after the last
  CRL still passes. After them, no card proof is accepted until a new CRL
  appears. The bound may be widened later: records valid under 3 days stay
  valid under a wider bound. Narrowing it can change the result of records
  already written; if it changes any, the narrower bound takes effect from
  an effective date ([`record-rules.md`](record-rules.md), "Changing these
  rules").

## Who checks what

**The mirror** fetches each issuer's CRL from MOICA every hour, using a
conditional request, so an unchanged file is neither downloaded nor stored.
It keeps every distinct CRL it has seen, as the original bytes, and publishes
all of them with an index (issuer, `thisUpdate`, `nextUpdate`, SHA-256 of the
file, root). The index is a convenience: anyone re-verifying downloads the
CRL, checks MOICA's signature, and rebuilds the root. For each usable CRL it
also publishes a patch that gives the file from the issuer's previous one
("CRL patches"), so that a re-verifier need not download every file whole.

**The device**

- asks the server for the card proof's challenge before it downloads the
  index of the mirror, and has the card sign that challenge if the
  cardholder confirms within 5 minutes and on the same date in Taiwan
  ([`docs/api/card-proof.md`](../docs/api/card-proof.md),
  `POST /api/v1/challenges`). The challenge is then issued before the
  server learns of any CRL newer than the one the device uses, which the
  server's rule below needs;
- downloads the newest CRL of its certificate's issuer from the mirror;
- checks that it is usable, with the issuer key the device already trusts for
  its own certificate;
- stops if today (Taiwan date, from the device clock) is more than `L` days
  after the CRL date, and shows the cardholder that MOICA's list is out of
  date. `L` is the smaller of the bound the server currently announces and
  7, the bound built into the device;
- remembers, per issuer, the highest `cRLNumber` it has used, and does not
  use a CRL with a lower one;
- builds the tree and the proof of absence for its own serial number.

Which file it takes from the index, the order of these checks and their
reason codes are in [`device-checks.md`](device-checks.md), "The CRL".

**Why the device has its own bound.** The mirror chooses which CRL a device
gets. CRLs list suspended certificates only while they are suspended. A
mirror serving one cardholder an older CRL would learn, from whether the card
proof fails, that the card was suspended then and is not now. MOICA knows who
that was. The device's bound limits how far back a mirror can reach, and
remembering the highest `cRLNumber` stops it for any device that has seen a
newer CRL. A bound that protects the cardholder from the server cannot come
from the server, so the device takes the server's figure only when it is
smaller. The built-in 7 days is the widest the record rule is expected to
become, so that widening the rule from 3 days does not require updating
installed apps.

**The server**, when accepting a card proof, looks at the two newest CRLs of
that issuer in the mirror (the usable ones with the highest `cRLNumber`):

- it accepts the root of the newest one;
- it accepts the root of the second newest one only if the challenge was
  issued before the server first learned of the newest one, or at most 2
  minutes after. A card proof whose challenge was issued before MOICA's
  list changed goes through; one whose challenge comes later uses the newest
  list. Devices ask for the challenge before they download the index (above),
  so a list that changes during a card proof does not fail it, unless the
  cardholder took more than 5 minutes to confirm and the device asked for a
  new challenge then. The 2 minutes cover the
  60 seconds a device can be served the index from the cache of the data
  domain, and the time between the mirror writing the index and the part of
  the server that accepts card proofs learning of the CRL. The mirror tells
  it the newest CRLs again and again; what counts is the first time;
- it accepts none if today in Taiwan is later than the newest one's CRL
  date plus 3 days.

This keeps normal operation on fresh CRLs: without the time limit, the
second newest list would be accepted until the next one came, 5 to 7 hours
later, and a revoked card would pass for that much longer. It is the
server's policy, not part of the record rules: nobody else can check it,
since it depends on what the mirror had and when, and the record rules and
their version number do not change with it.

**Anyone re-verifying** checks the rule of the previous section against the
archived CRLs.

## Archive index

The archive comes with an index: one line per CRL file in the archive, in
the same one-spelling form as proof log lines ([`record.md`](record.md)): a fixed
template, keys in this order, no whitespace, each line ending in `LF`.

```
{"issuer":"ISSUER","crl_number":"CRL_NUMBER","this_update":"THIS_UPDATE","next_update":"NEXT_UPDATE","crl_date":"CRL_DATE","sha256":"SHA256","root":"ROOT"}
```

| Field | Format |
|---|---|
| `issuer` | `G2` or `G3`: the key under which the RSA signature verifies, whatever the algorithm fields say; `-` if neither |
| `crl_number` | `cRLNumber` in decimal without leading zeros; `-` if missing, unreadable, negative or longer than 20 content bytes, or if the CRL has more than 16 extensions |
| `this_update`, `next_update` | UTC, `YYYY-MM-DDTHH:MM:SSZ`; `-` if missing |
| `crl_date` | The CRL date, `YYYY-MM-DD`; `-` if `thisUpdate` is missing |
| `sha256` | SHA-256 of the file, 64 lowercase hex digits |
| `root` | The root, 64 lowercase hex digits; for a file that is not usable, `-` followed by the reason code below (for example `-not_usable_signature`) |

**Reason codes.** When several apply, the first in this order:

| # | Code | The file |
|---|---|---|
| 1 | `not_usable_der` | is not a DER `CertificateList`, or has a time not spelled as in "Times" |
| 2 | `not_usable_algorithm` | has, in either place, a signature algorithm other than sha256WithRSAEncryption with NULL parameters |
| 3 | `not_usable_signature` | has a signature that verifies under neither key |
| 4 | `not_usable_too_many_extensions` | has more than 16 extensions of the CRL |
| 5 | `not_usable_duplicate_extension` | has an extension of the CRL twice |
| 6 | `not_usable_critical_extension` | has a critical extension of the CRL |
| 7 | `not_usable_delta` | has `deltaCRLIndicator` (see row 8 for a file that also has `issuingDistributionPoint`) |
| 8 | `not_usable_partitioned` | has `issuingDistributionPoint`. Rows 7 and 8 are one step: in a file with both extensions, the one that comes first among the CRL's extensions decides |
| 9 | `not_usable_crl_number` | has no `cRLNumber`, or one that is not a non-negative DER INTEGER of at most 20 content bytes |
| 10 | `not_usable_too_many_extensions`, `not_usable_duplicate_extension`, `not_usable_critical_extension` or `not_usable_serial` | has an entry with more than 16 extensions, an extension twice, a critical entry extension, or a serial number that gives no key. Entries are checked in order, and the first entry with a problem decides; within it, in this order |
| 11 | `not_usable_collision` | has two different keys with the same lowest 127 bits |

**Order.** Lines are sorted by `issuer` (bytes: `-` before `G2` before `G3`),
then `crl_number` as a number with `-` before every number, then `sha256`.

**Files.** The archive is one directory. Its index is the file `index.jsonl`
in it. Every other regular file in the directory whose name does not start
with `.` is a CRL file of the archive and has exactly one line, usable or
not, so the archive and the index can be checked against each other.
Subdirectories are not part of the archive (the mirror's `patches/` is one:
"CRL patches"). The mirror stores only files it
has not seen (by SHA-256), so no two lines are the same. Two different files
with the same CRL number get two lines.

The mirror names each CRL file by its SHA-256 (64 lowercase hex digits)
followed by `.crl`; the index does not depend on file names. Where the
archive is published is not part of this specification (ADR-0027).

**Re-verifying with the index.** The index is a convenience: a re-verifier
can rebuild it from the files, and the rebuilt index is the one that counts.
A re-verifier that rebuilds it and finds a difference reports every
difference and continues with the rebuilt index. A missing `index.jsonl`,
and every line of it that is not well formed, also count as differences:
the rebuilt index does not need them. One that trusts the index without
rebuilding it checks every line's form, and that `root` is below `p`; there
a missing or malformed index is an error, since nothing else can stand in
for it.

## CRL patches

A **CRL patch** gives a usable CRL file of the archive from the previous one
of the same issuer key. It is a shortcut for downloading, not part of the
archive: the index does not list patches, re-verifying needs only the CRL
files, and what a patch gives counts only if it has the SHA-256 of the file
it stands for. So a re-verifier does not have to trust a patch, nor whoever
made it.

**Which pairs.** The previous CRL of a usable CRL is the one just before it
among the usable CRLs of the same `issuer`, in the order of the index
("Order": `crl_number` as a number, then `sha256`). A file that is not usable
has no patch and is no file's previous CRL. The first usable CRL of each
issuer key has none.

**Where.** In the subdirectory `patches/` of the archive's directory, named
`PREVIOUS-FILE.patch`: the SHA-256 of the previous CRL file, `-`, the SHA-256
of the file the patch gives, each as 64 lowercase hex digits. Two adjacent
usable lines of one issuer in the index give the name, so a reader does not
list the directory. `patches/` is a subdirectory, so it is not part of the
archive ("Files"), and copying the archive does not copy it. A patch may be
missing, and there may be patches of pairs that are no longer adjacent, after
a file was added to the archive between them; neither changes what the
archive is.

**Format.** A patch is a sequence of instructions, nothing before, between
or after them. Each instruction is one byte that says which it is, followed
by numbers of 4 bytes each, unsigned and big-endian:

| Instruction | Bytes | Gives |
|---|---|---|
| Copy | `00`, `START`, `LENGTH` | `LENGTH` bytes of the previous file, starting at its byte `START` (the first byte is 0) |
| Write | `01`, `LENGTH`, then `LENGTH` bytes | those bytes |

The file is what the instructions give, one after the other. A `LENGTH` of 0
gives nothing, and an empty patch gives an empty file. A copy does not start
before the previous copy ended (the first may start anywhere): copies go
forward through the previous file and never overlap. So the file a patch
gives is at most as long as the previous file and the patch together, and
giving it takes time and memory in proportion to those two.

**A patch that cannot be used.** A reader treats the whole patch as
unusable if

- a copy ends past the end of the previous file, or starts before the
  previous copy ended;
- an instruction, or the bytes a write says follow, runs past the end of the
  patch;
- an instruction starts with a byte other than `00` and `01`;
- the file it gives does not have the SHA-256 its name gives.

A reader that finds a patch unusable or missing downloads the file whole.
How a patch is made is not part of this specification: many patches give the
same file, and they differ only in size.

## Test vectors

[`vectors/poseidon2.json`](vectors/poseidon2.json), `revocation_tree`: small
trees with their roots and proofs of absence.
[`vectors/revocation-tree.json`](vectors/revocation-tree.json): CRLs in
MOICA's layout, signed by test keys (not MOICA's), with their roots, and the
proofs of absence of serial numbers in them, in the form of the circuit's
inputs ([`circuit-inputs.md`](circuit-inputs.md)) that `iamreal-crl prove`
prints; a serial number in the tree has none.
[`vectors/record-rules.json`](vectors/record-rules.json): records whose root
is or is not recognized.
[`../crl/testdata/`](../crl/testdata): synthetic CRLs, with whether each is
usable, its reason code and its root (`expected.json`). Its `times/`: CRLs
whose times are spelled in many ways, CRLs with an extension whose
identifier is at and past each line of "Object identifiers", and CRLs with
an element that holds more than it has, each with its line of the archive
index (`times/expected.json`).
[`vectors/crl-patch.json`](vectors/crl-patch.json): CRL patches ("CRL
patches") with the previous file, the file each gives and its name, and
patches that cannot be used, with the previous file each is read against.
