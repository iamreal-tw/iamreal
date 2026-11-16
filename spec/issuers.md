# Issuer keys

Status: **Draft**.

The proof's public input `issuer_modulus` must be the modulus of one of
MOICA's issuer keys. A proof made under any other key says nothing about a
citizen digital certificate. A record names the key by its `issuer` field
([`record.md`](record.md)), and the verifier takes the modulus from this
table, never from the record.

## The keys

| `issuer` | Issuer certificate | SHA-256 of the certificate (DER) | Key | Valid |
|---|---|---|---|---|
| `G2` | [`MOICA2.cer`](https://moica.nat.gov.tw/repository/Certs/MOICA2.cer) | `c4c462de463f856804dc898338d2cecb55fba74155851599d8fb7d70218fd1be` | RSA 2048, e = 65537 | 2014-01-02 to 2034-01-02 |
| `G3` | [`MOICA-G3.cer`](https://moica.nat.gov.tw/repository/Certs/MOICA-G3.cer) | `ed793fd0d50a2a398049d598982cf01e75f873b532066caec238f800a06ca9da` | RSA 4096, e = 65537 | 2024-01-23 to 2044-01-23 |

Both certificates have the subject `C=TW, O=行政院, OU=內政部憑證管理中心`.
The moduli, and the same moduli as the limbs of `issuer_modulus`, are in
[`vectors/issuers.json`](vectors/issuers.json).

**Who signed them.** Each is signed by a root of the Government Root
Certification Authority (GRCA):

| `issuer` | Root | SHA-256 of the root certificate (DER) | Source |
|---|---|---|---|
| `G2` | `C=TW, O=Government Root Certification Authority`, second generation (RSA 4096, valid to 2037-12-31) | `70b922bfda0e3f4a342e4ee22d579ae598d071cc5ec9c30f123680340388aea5` | [`IssuedToThisCA.p7b`](https://grca.nat.gov.tw/repository/Certs/IssuedToThisCA.p7b), the certificate whose key identifier is `D5:67:1D:E0:…:74:CD` |
| `G3` | `C=TW, O=行政院, CN=Government Root Certification Authority - G3` | `57df6f20e04c588e85f35be8832f5d4e78958336ae3b18fb7c9bae0dfead4044` | [`GRCAG3.crt`](https://grca.nat.gov.tw/repository/Certs/GRCAG3.crt) |

The G2 issuer certificate is not signed by the first-generation GRCA root
(`76:00:29:5E…`, valid to 2032), which has the same name.

**How to check this table.** Download the certificates over HTTPS from the
sources above, compare their SHA-256, and verify each issuer certificate
against its root. MOICA's CRLs verify under the same keys
([`revocation-tree.md`](revocation-tree.md)). The values were retrieved and
checked this way on 2026-11-16, over HTTPS.
Copies of `MOICA2.cer`, `GRCAG3.crt` and `IssuedToThisCA.p7b` fetched over
HTTP were byte-for-byte the same.

## Which circuit

| `issuer` | Limbs of `issuer_modulus` | Circuit |
|---|---|---|
| `G2` | 18 | `card_proof_rs2048` |
| `G3` | 35 | `card_proof_rs4096` |

The verification keys are listed in [`record.md`](record.md), "Accepted
circuits".

## Rules

- Only the keys in this table are accepted. Keys used in tests never appear
  here.
- A key is added as a new row when MOICA introduces one. It needs a circuit
  for its size, and a row in the accepted circuits. Rows are not removed:
  old records keep verifying under the key they used.
- The validity period of an issuer certificate is not checked by the proof or
  by the roster rules. The proof checks the cardholder's certificate against
  the date of the challenge (ADR-0008). A certificate MOICA issued with this
  key is checked against this key, whatever the date. If MOICA revokes an
  issuer key, this document changes.

## Test vectors

[`vectors/issuers.json`](vectors/issuers.json): for each key, the sources
and SHA-256 of the issuer and root certificates, the modulus, and its limbs
as the public input `issuer_modulus` (120 bits each, least significant
first).
