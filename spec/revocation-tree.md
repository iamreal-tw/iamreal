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

- it is a `CertificateList` (RFC 5280 section 5) in DER, signed with
  sha256WithRSAEncryption with NULL parameters (both in `tbsCertList` and
  outside it), and the signature verifies under the issuer key;
- it has a `cRLNumber` extension holding a non-negative integer. The device
  compares CRL numbers ("Who checks what");
- it is a complete CRL for everything the key issued: it has neither a
  `deltaCRLIndicator` nor an `issuingDistributionPoint` extension, critical
  or not; no extension appears twice, in the CRL or in an entry; and no
  extension is critical, in the CRL or in any entry (so an indirect CRL, with
  a critical `certificateIssuer` entry extension, is not usable). MOICA's CRLs, as checked
  on 2026-11-16, carry only `authorityKeyIdentifier` and `cRLNumber`, and each
  entry only a non-critical `reasonCode`. If MOICA starts partitioning its
  CRLs, devices stop rather than build an incomplete tree, and this document
  changes;
- every serial number in `revokedCertificates` is a valid DER INTEGER in its
  shortest encoding, not negative, with at most 20 content bytes (a leading
  `00` counts), so that it gives a key (below);
- no two **different** keys share their lowest 127 bits. The same serial
  number listed twice is one key.

A CRL that fails any of these gives no tree. `crl/` stops with an error; the
device does not make a proof.

The **CRL date** is `thisUpdate` converted to a date in Taiwan (UTC+8).

### Times

`thisUpdate`, `nextUpdate` and every entry's `revocationDate` are read the
same way. A time is one of these spellings, and nothing else:

| Type | Characters |
|---|---|
| UTCTime | `YYMMDDhhmmss` or `YYMMDDhhmm`, then the zone |
| GeneralizedTime | `YYYYMMDDhhmmss`, then the zone |

- Every field is that many digits. There is no fraction of a second.
- The zone is `Z`, or an offset `+hhmm` or `-hhmm` with `hh` from 00 to 24
  and `mm` from 00 to 59, not both zero. With an offset, the fields give the
  local time, and the time is that minus the offset (`+0800` is 8 hours
  ahead of UTC).
- A UTCTime's year `YY` from 00 to 49 is 2000 to 2049, and from 50 to 99 is
  1950 to 1999, as the fields give it, before the offset is applied.
- The month is 01 to 12, the day is a day of that month in the proleptic
  Gregorian calendar (year 0000 is a leap year), the hour is 00 to 23, and
  the minute and the second are 00 to 59. A UTCTime without seconds has
  second 00.

This is wider than RFC 5280, which has only `Z` and always seconds: it is
what the library `crl/` reads times with accepts, written down so that every
implementation reads the same files the same way. The two CRLs MOICA
published on 2026-11-19 spell every time as a UTCTime of twelve digits and
`Z`.

A file with a time spelled any other way is not a DER `CertificateList`
(reason code `not_usable_der`, "Archive index").

In the archive index a time is written in UTC as `YYYY-MM-DDTHH:MM:SSZ`, and
the CRL date as `YYYY-MM-DD`. The year has four digits; a year after 9999
has all its digits, and a year before 0000 is `-` and four digits (`-0001`
is the year before 0000). `next_update` is `-` only when the CRL has no
`nextUpdate` field: every time the field can hold is written, including
`0001-01-01T00:00:00Z`.

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
([`roster-rules.md`](roster-rules.md)). When no certificate was revoked
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
  (CPS v2.1 section 4.9.7). Within the 3 days, a card revoked after the last
  CRL still passes. After them, no card proof is accepted until a new CRL
  appears. The bound may be widened later: records valid under 3 days stay
  valid under a wider bound. Narrowing it can change the result of records
  already written; if it changes any, the narrower bound takes effect from
  an effective date ([`roster-rules.md`](roster-rules.md), "Changing these
  rules").

## Who checks what

**The mirror** fetches each issuer's CRL from MOICA every hour, using a
conditional request, so an unchanged file is neither downloaded nor stored.
It keeps every distinct CRL it has seen, as the original bytes, and publishes
all of them with an index (issuer, `thisUpdate`, `nextUpdate`, SHA-256 of the
file, root). The index is a convenience: anyone re-verifying downloads the
CRL, checks MOICA's signature, and rebuilds the root.

**The device**

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

**The server**, when accepting a card proof, accepts only the roots of the
two newest CRLs of that issuer in the mirror (the usable ones with the
highest `cRLNumber`), and none if today in Taiwan is later than the newest
one's CRL date plus 3 days. This keeps normal operation on fresh CRLs. Nobody else can
check it, since it depends on what the mirror had at that moment.

**Anyone re-verifying** checks the rule of the previous section against the
archived CRLs.

## Archive index

The archive comes with an index: one line per CRL file in the archive, in
the same one-spelling form as roster lines ([`record.md`](record.md)): a fixed
template, keys in this order, no whitespace, each line ending in `LF`.

```
{"issuer":"ISSUER","crl_number":"CRL_NUMBER","this_update":"THIS_UPDATE","next_update":"NEXT_UPDATE","crl_date":"CRL_DATE","sha256":"SHA256","root":"ROOT"}
```

| Field | Format |
|---|---|
| `issuer` | `G2` or `G3`: the key under which the RSA signature verifies, whatever the algorithm fields say; `-` if neither |
| `crl_number` | `cRLNumber` in decimal without leading zeros; `-` if missing, unreadable or negative |
| `this_update`, `next_update` | UTC, `YYYY-MM-DDTHH:MM:SSZ`; `-` if missing |
| `crl_date` | The CRL date, `YYYY-MM-DD`; `-` if `thisUpdate` is missing |
| `sha256` | SHA-256 of the file, 64 lowercase hex digits |
| `root` | The root, 64 lowercase hex digits; for a file that is not usable, `-` followed by the reason code below (for example `-not_usable_signature`) |

**Reason codes.** When several apply, the first in this order:

| # | Code | The file |
|---|---|---|
| 1 | `not_usable_der` | is not a DER `CertificateList` |
| 2 | `not_usable_algorithm` | has, in either place, a signature algorithm other than sha256WithRSAEncryption with NULL parameters |
| 3 | `not_usable_signature` | has a signature that verifies under neither key |
| 4 | `not_usable_duplicate_extension` | has an extension of the CRL twice |
| 5 | `not_usable_critical_extension` | has a critical extension of the CRL |
| 6 | `not_usable_delta` | has `deltaCRLIndicator` |
| 7 | `not_usable_partitioned` | has `issuingDistributionPoint` |
| 8 | `not_usable_crl_number` | has no `cRLNumber`, or one that is not a non-negative DER INTEGER |
| 9 | `not_usable_duplicate_extension`, `not_usable_critical_extension` or `not_usable_serial` | has an entry with an extension twice, a critical entry extension, or a serial number that gives no key. Entries are checked in order, and the first entry with a problem decides; within it, in this order |
| 10 | `not_usable_collision` | has two different keys with the same lowest 127 bits |

**Order.** Lines are sorted by `issuer` (bytes: `-` before `G2` before `G3`),
then `crl_number` as a number with `-` before every number, then `sha256`.

**Files.** The archive is one directory. Its index is the file `index.jsonl`
in it. Every other regular file in the directory whose name does not start
with `.` is a CRL file of the archive and has exactly one line, usable or
not, so the archive and the index can be checked against each other.
Subdirectories are not part of the archive. The mirror stores only files it
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

## Test vectors

[`vectors/poseidon2.json`](vectors/poseidon2.json), `revocation_tree`: small
trees with their roots and proofs of absence.
[`vectors/roster-rules.json`](vectors/roster-rules.json): records whose root
is or is not recognized.
[`../crl/testdata/`](../crl/testdata): synthetic CRLs, with whether each is
usable, its reason code and its root (`expected.json`); and in `times/`,
CRLs with times in each spelling of "Times", accepted or not, each with its
line of the archive index.
