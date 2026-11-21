# Counterfactual check

33 checks over 17 variants; 0 unexpected.

| variant | what is removed or changed | verification keys vs. the real ones | tests | expected | got |  |
| --- | --- | --- | --- | --- | --- | --- |
| base | nothing removed; libraries as path dependencies | same | `.` in `library-guarantees.test.mjs` | pass | pass (18 passed, 0 failed) | as expected |
|  |  |  | `.` in `vectors.test.mjs` | pass | pass (22 passed, 0 failed) | as expected |
|  |  |  | `[(honest|s+n|limbs|key-2048)]` in `card_proof.test.mjs` | pass | pass (9 passed, 0 failed) | as expected |
| own_from_array | rsa.nr: signature built without `from_array` | different | `[G1-own]` in `library-guarantees.test.mjs` | fail | fail (2 passed, 1 failed) | as expected |
|  |  |  | `[G1-e2e]` in `library-guarantees.test.mjs` | pass | pass (4 passed, 0 failed) | as expected |
|  |  |  | `[limbs]` in `card_proof.test.mjs` | pass | pass (4 passed, 0 failed) | as expected |
| lib_factor_range | bignum expressions.nr: no range check of the factors of a product | same | `[G1-own]` in `library-guarantees.test.mjs` | pass | pass (3 passed, 0 failed) | as expected |
|  |  |  | `[G1-e2e]` in `library-guarantees.test.mjs` | pass | pass (4 passed, 0 failed) | as expected |
|  |  |  | `[limbs]` in `card_proof.test.mjs` | pass | pass (4 passed, 0 failed) | as expected |
| both_limb_range | both of the above | different | `[G1-e2e]` in `library-guarantees.test.mjs` | fail | fail (1 passed, 3 failed) | as expected |
|  |  |  | `[limbs]` in `card_proof.test.mjs` | fail | fail (0 passed, 4 failed) | as expected |
| lib_modulus_range | bignum params.nr: `BigNumParams::new` without the range check of the modulus limbs | different | `[G2]` in `library-guarantees.test.mjs` | fail | fail (0 passed, 1 failed) | as expected |
| lib_top_bit | bignum params.nr: `BigNumParams::new` without the top-bit check | different | `[G3-issuer]` in `library-guarantees.test.mjs` | fail | fail (0 passed, 2 failed) | as expected |
|  |  |  | `[G3-part]` in `library-guarantees.test.mjs` | pass | pass (1 passed, 0 failed) | as expected |
|  |  |  | `[G3-card]` in `library-guarantees.test.mjs` | pass | pass (1 passed, 0 failed) | as expected |
|  |  |  | `[key-2048]` in `card_proof.test.mjs` | pass | pass (3 passed, 0 failed) | as expected |
| own_top_bit | der.nr: no `modulus[0] >= 0x80` | different | `[G3-part]` in `library-guarantees.test.mjs` | fail | fail (0 passed, 1 failed) | as expected |
|  |  |  | `[G3-card]` in `library-guarantees.test.mjs` | pass | pass (1 passed, 0 failed) | as expected |
|  |  |  | `[key-2048]` in `card_proof.test.mjs` | pass | pass (3 passed, 0 failed) | as expected |
| both_top_bit | both of the above | different | `[G3-card]` in `library-guarantees.test.mjs` | fail | fail (0 passed, 1 failed) | as expected |
|  |  |  | `[key-2048]` in `card_proof.test.mjs` | fail | fail (2 passed, 1 failed) | as expected |
| lib_strict | bignum constrained_ops.nr: `validate_gt` without `assert_is_not_zero_integer` | different | `[G4]` in `library-guarantees.test.mjs` | fail | fail (2 passed, 1 failed) | as expected |
| own_in_field | rsa.nr: no `validate_in_field` | different | `[G4]` in `library-guarantees.test.mjs` | fail | fail (1 passed, 2 failed) | as expected |
|  |  |  | `[s+n]` in `card_proof.test.mjs` | fail | fail (0 passed, 1 failed) | as expected |
| hint_intermediate | hint: intermediate products returned as r + n | same | `[honest]` in `card_proof.test.mjs` | pass | pass (1 passed, 0 failed) | as expected |
| hint_all | hint: every product, sig^e too, returned as r + n | same | `[honest]` in `card_proof.test.mjs` | fail | fail (0 passed, 1 failed) | as expected |
| hint_all_unsafe_bytes | that hint, and noir_rsa pkcs1v15.nr with `to_le_bytes_unsafe` (no canonical check of sig^e) | different | `[honest]` in `card_proof.test.mjs` | fail | fail (0 passed, 1 failed) | as expected |
| lib_poseidon_iv | poseidon poseidon2.nr: initial value 0 instead of length * 2^64 | different | `[poseidon2]` in `vectors.test.mjs` | fail | fail (3 passed, 19 failed) | as expected |
| lib_poseidon_final | poseidon poseidon2.nr: one more permutation after a full block | different | `[poseidon2]` in `vectors.test.mjs` | fail | fail (14 passed, 8 failed) | as expected |
| lib_sha_length | sha256 sha256.nr: `sha256_var` without `assert(message_size <= N)` | different | `[G7-lib]` in `library-guarantees.test.mjs` | fail | fail (0 passed, 1 failed) | as expected |
|  |  |  | `[G7-e2e]` in `library-guarantees.test.mjs` | pass | pass (1 passed, 0 failed) | as expected |
| own_tbs_len | der.nr: no `tbs_len <= MAX_SIGNED_LEN` | different | `[G7-e2e]` in `library-guarantees.test.mjs` | fail | fail (0 passed, 1 failed) | as expected |
|  |  |  | `[G7-lib]` in `library-guarantees.test.mjs` | pass | pass (1 passed, 0 failed) | as expected |
