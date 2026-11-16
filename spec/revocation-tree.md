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

- it is a `CertificateList` (RFC 5280 section 5) signed with
  sha256WithRSAEncryption, and the signature verifies under the issuer key;
- it is a complete CRL for everything the key issued: it has neither a
  `deltaCRLIndicator` nor an `issuingDistributionPoint` extension, and no
  critical extension other than these rules know. MOICA's CRLs, as checked on
  2026-11-16, carry only `authorityKeyIdentifier` and `cRLNumber`. If MOICA
  starts partitioning its CRLs, devices stop rather than build an incomplete
  tree, and this document changes;
- every serial number in `revokedCertificates` gives a key (below), and no
  two keys share their lowest 127 bits.

A CRL that fails any of these gives no tree. `crl/` stops with an error; the
device does not make a proof.

The **CRL date** is `thisUpdate` converted to a date in Taiwan (UTC+8).

## Tree

**Key.** The serial number's content bytes (without the DER tag and length)
read as an unsigned big-endian integer. This is the value the circuit reads
from the certificate. A serial number is at most 20 bytes.

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
([`roster-rules.md`](roster-rules.md)).

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
  valid under a wider bound. Narrowing it would invalidate old records.

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
two newest CRLs of that issuer in the mirror, and none if the newest is more
than 3 days old. This keeps normal operation on fresh CRLs. Nobody else can
check it, since it depends on what the mirror had at that moment.

**Anyone re-verifying** checks the rule of the previous section against the
archived CRLs.

## Open items

- Where the archive is published and in what format.

## Test vectors

[`vectors/poseidon2.json`](vectors/poseidon2.json), `revocation_tree`: small
trees with their roots and proofs of absence.
[`vectors/roster-rules.json`](vectors/roster-rules.json): records whose root
is or is not recognized.
