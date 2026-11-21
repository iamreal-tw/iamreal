# Case-by-case comparison

110 cases; 29 intended difference(s), 1 part-level difference(s), 0 other disagreement(s).

- `Noir part`: the comparison circuit in `comparison/` that has the shape of the circom
  circuit: the certificate part (`cert_chain_rs2048`, `cert_chain_rs4096`) or one of the
  two signature parts (`user_sig_scope`, `user_sig_code`).
- `Noir card proof`: the card proof circuit (`card_proof_rs2048`, `card_proof_rs4096`),
  given the case's part and an honest rest of a card proof.
- `n/a`: the case cannot be expressed in this circuit (see note). `not run`: the circom
  witness generators were not found.

Intended differences (ADR-0013): the Noir circuits check the first signed byte (scope
string or declaration code); the circom circuit is one signature circuit with no such check.

Part-level difference: a signature by a card key that is not 2048 bits long. The Noir
signature part rejects it by itself. circom's signature circuit does not look at the key
length; its certificate circuit does, and the key commitment ties the two, so circom
rejects the same card over its three proofs. The table shows both halves.

"Same behaviour" (ADR-0012) is judged over the whole card proof: what the Noir card proof
accepts against what circom accepts over all of its proofs together. The two split the
statement into different parts, so which part rejects an input can differ without any
card being treated differently. A part-level difference is listed here and needs no ADR;
a difference in the whole card proof is either intended (with an ADR) or a bug.

| circom test file | case | expected | Noir part | Noir card proof | circom | note |
| --- | --- | --- | --- | --- | --- | --- |
| certChainValidity | a certificate inside its validity period | accept | accept | accept | accept |  |
| certChainValidity | currentTime equal to notAfter | accept | accept | accept | accept |  |
| certChainValidity | currentTime equal to notBefore | accept | accept | accept | accept |  |
| certChainValidity | a 1-byte serial number | accept | accept | accept | accept |  |
| certChainValidity | a 20-byte serial number | accept | accept | accept | accept |  |
| certChainValidity | an issuer name of 127 content bytes | accept | accept | accept | accept |  |
| certChainValidity | a certificate that expired one second ago | reject | reject | reject | reject |  |
| certChainValidity | a certificate that becomes valid one second from now | reject | reject | reject | reject |  |
| certChainValidity | a GeneralizedTime notAfter (2050 or later) | reject | reject | reject | reject |  |
| certChainValidity | a GeneralizedTime notBefore | reject | reject | reject | reject |  |
| certChainValidity | a notAfter in 19YY (UTCTime year 50..99) | reject | reject | reject | reject |  |
| certChainValidity | an issuer name of 128 or more content bytes | reject | reject | reject | reject |  |
| certChainValidity | a TBS without the v3 version block | reject | reject | reject | reject |  |
| certChainValidity | a currentTime that does not fit in 40 bits | reject | reject | reject | reject |  |
| certChainModulusOffset | a subject Name of 127 content bytes | accept | accept | accept | accept |  |
| certChainModulusOffset | a subject Name of 128 content bytes | accept | accept | accept | accept |  |
| certChainModulusOffset | a subject Name of 255 content bytes | accept | accept | accept | accept |  |
| certChainModulusOffset | a subject Name of 256 content bytes | reject | reject | reject | reject |  |
| certChainModulusOffset | a 4096-bit RSA subject key | reject | reject | reject | reject |  |
| certChainModulusOffset | a decoy modulus prefix elsewhere in the TBS (same pk_commit as without it) | accept | accept | accept | accept |  |
| certChainKeyUsage | a signing certificate (digitalSignature) | accept | accept | accept | accept |  |
| certChainKeyUsage | an encryption certificate (keyEncipherment + dataEncipherment) | reject | reject | reject | reject |  |
| certChainKeyUsage | digitalSignature combined with another usage | reject | reject | reject | reject |  |
| certChainKeyUsage | a certificate with no keyUsage extension | reject | reject | reject | reject |  |
| certChainKeyUsage | keyUsage in a different position | reject | reject | reject | reject |  |
| certChainKeyUsage | a TBS truncated inside keyUsage, just before its last byte (0x80) | reject | reject | reject | reject |  |
| certChainKeyUsage | a signing keyUsage placed after an encryption keyUsage | reject | reject | reject | reject |  |
| certChainPrimaryCard | a primary-card certificate | accept | accept | accept | accept |  |
| certChainPrimaryCard | any tailOfPersonalID value | accept | accept | accept | accept |  |
| certChainPrimaryCard | an alien-resident primary-card certificate | reject | reject | reject | reject |  |
| certChainPrimaryCard | another subjectType | reject | reject | reject | reject |  |
| certChainPrimaryCard | an alien-resident certificate with cardHolderRank = mobile | reject | reject | reject | reject |  |
| certChainPrimaryCard | a certificate with cardHolderRank = mobile | reject | reject | reject | reject |  |
| certChainPrimaryCard | a certificate with cardHolderRank = secondary | reject | reject | reject | reject |  |
| certChainPrimaryCard | cardHolderRank placed before the other attributes | reject | reject | reject | reject |  |
| certChainPrimaryCard | the two attributes in the other order | reject | reject | reject | reject |  |
| certChainPrimaryCard | a different certificate policy | reject | reject | reject | reject |  |
| certChainPrimaryCard | no subjectDirectoryAttributes | reject | reject | reject | reject |  |
| certChainPrimaryCard | subjectDirectoryAttributes before certificatePolicies | reject | reject | reject | reject |  |
| certChainPrimaryCard | an unrelated extension between keyUsage and certificatePolicies | reject | reject | reject | reject |  |
| certChainPrimaryCard | a TBS truncated inside subjectDirectoryAttributes | reject | reject | reject | reject |  |
| certChainRS2048 | valid cert chain inputs | accept | accept | accept | accept |  |
| certChainRS2048 | a currentTime later than any UTCTime notAfter | reject | reject | reject | reject |  |
| certChainRS2048 | a currentTime earlier than notBefore | reject | reject | reject | reject |  |
| certChainRS2048 | a currentTime that does not fit in 40 bits | reject | reject | reject | reject |  |
| certChainRS4096 | valid cert chain inputs | accept | accept | accept | accept |  |
| certChainRS4096 | a currentTime later than any UTCTime notAfter | reject | reject | reject | reject |  |
| certChainRS4096 | a currentTime earlier than notBefore | reject | reject | reject | reject |  |
| certChainRS4096 | a currentTime that does not fit in 40 bits | reject | reject | reject | reject |  |
| auditV2Regression | baseline: the honest witness | accept | accept | accept | accept |  |
| auditV2Regression | forged serialNumber = 2 (version INTEGER) | reject | n/a | n/a | reject | no serial-number input |
| auditV2Regression | forged serialNumber = 65537 (RSA exponent INTEGER) | reject | n/a | n/a | reject | no serial-number input |
| auditV2Regression | baseline: canonical 31-byte payload | accept | accept | accept | accept |  |
| auditV2Regression | a 32-byte payload (appended tail) | reject | n/a | n/a | reject | the signed message is a fixed 31-byte input |
| userSigRS2048 | valid user signature inputs | accept | accept | accept | accept |  |
| userSigRS2048 | any value for the per-session challenge | accept | accept | accept | accept | challenge given to circom only: the Noir circuits have no challenge input |
| pk_commit_linking | the certificate part and both signature parts give the same pk_commit | same | same | n/a | same | the card proof circuit has no pk_commit: the key never leaves it |
| (new) | a TBS with one byte changed after signing | reject | reject | reject | reject |  |
| (new) | a TBS of 1527 bytes, the longest that fits with SHA-256 padding | accept | accept | accept | accept |  |
| (new) | a TBS of 1528 bytes | reject | reject | reject | reject |  |
| (new) | a signature by a key other than the committed one | reject | reject | reject | reject |  |
| (new) | a non-canonical signature (s + n) | reject | reject | reject | reject |  |
| (new) | the scope string signature in a non-canonical limb encoding (same integer) | reject | reject | reject | reject |  |
| (new) | the declaration code signature in a non-canonical limb encoding (same integer) | reject | reject | reject | reject |  |
| (new) | the issuer signature in a non-canonical limb encoding (same integer), 2048-bit issuer key | reject | reject | reject | reject |  |
| (new) | the issuer signature in a non-canonical limb encoding (same integer), 4096-bit issuer key | reject | reject | reject | reject |  |
| (new) | a 2047-bit subject key written into 256 modulus bytes | reject | reject | reject | reject |  |
| (new) | a 1024-bit subject key written into 256 modulus bytes | reject | reject | reject | reject |  |
| (new) | a subject key whose first modulus byte is 0x80 | accept | accept | n/a | accept | no card proof: nobody holds the private key of this modulus |
| (new) | a subject key whose first modulus byte is 0x7f | reject | reject | reject | reject |  |
| (new) | a signature by a 2047-bit key | reject | reject | reject | accept | part-level difference: circom checks the key length in its certificate part only; rejected there (the 2047-bit case above) |
| (kind) | as the scope string: a signature over a declaration code | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a signature over a declaration code | accept | accept | accept | accept |  |
| (kind) | as the declaration code: a signature over a scope string | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `a` | accept | accept | accept | accept |  |
| (kind) | as the declaration code: a message starting with `a` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `i` | accept | accept | accept | accept |  |
| (kind) | as the declaration code: a message starting with `i` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `z` | accept | accept | accept | accept |  |
| (kind) | as the declaration code: a message starting with `z` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `S` | accept | accept | accept | accept |  |
| (kind) | as the declaration code: a message starting with `S` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `A` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `A` | accept | accept | accept | accept |  |
| (kind) | as the scope string: a message starting with `D` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `D` | accept | accept | accept | accept |  |
| (kind) | as the scope string: a message starting with `R` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `R` | accept | accept | accept | accept |  |
| (kind) | as the scope string: a message starting with `T` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `T` | accept | accept | accept | accept |  |
| (kind) | as the scope string: a message starting with `Z` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `Z` | accept | accept | accept | accept |  |
| (kind) | as the scope string: a message starting with 0x60 | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with 0x60 | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `{` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `{` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `@` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `@` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `[` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `[` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `0` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `0` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `9` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `9` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with `_` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with `_` | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with 0x00 | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with 0x00 | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the scope string: a message starting with 0xe1 | reject | reject | reject | accept | intended difference: circom has no kind check |
| (kind) | as the declaration code: a message starting with 0xe1 | reject | reject | reject | accept | intended difference: circom has no kind check |
