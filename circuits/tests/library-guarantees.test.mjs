// Guarantees of the card proof circuit that rest, or used to rest, on a line
// inside a library: the list of audit/round2/b3/REPORT.md section 5. A library
// upgrade can drop such a line without any other test noticing. Each test here
// fails if its line is gone; tests/counterfactual/ removes each line in a copy
// and checks that. Run both before changing a library version.
//
//   tag         guarantee                                    held by
//   [G1-own]    one limb encoding per signature              lib/src/rsa.nr `from_array`
//   [G1-e2e]    the same, in the card proof circuit          that, and bignum expressions.nr (factor range checks)
//   [G2]        one limb encoding of a key                   bignum params.nr `validate_in_range` in `BigNumParams::new`
//   [G2-e2e]    the same for the issuer key, in the card     that; not always sensitive on its own (see the test)
//               proof circuit
//   [G3-issuer] issuer key exactly 2048 / 4096 bits          bignum params.nr top-limb check in `BigNumParams::new`
//   [G3-part]   card key exactly 2048 bits (certificate)     lib/src/der.nr `modulus[0] >= 0x80`
//   [G3-card]   the same, in the card proof circuit          that, and bignum params.nr top-limb check
//   [G4]        "below the modulus" is strict                bignum constrained_ops.nr `assert_is_not_zero_integer` in `validate_gt`
//   [G7-lib]    sha256_var rejects a length past its buffer  sha256 sha256.nr `assert(message_size <= N)`
//   [G7-e2e]    no certificate longer than 1527 bytes        lib/src/der.nr `tbs_len <= MAX_SIGNED_LEN`
//
// Two rows of that list are tested elsewhere:
//   [poseidon2] how Poseidon2 absorbs its inputs: tests/vectors.test.mjs.
//   sig^e is canonical before its bytes are compared (noir_rsa pkcs1v15.nr,
//   `to_le_bytes`): no input reaches it, only a changed witness hint does.
//   tests/counterfactual/ builds that hint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { buildCases, CODE, NOW, SCOPE } from "./cases.mjs";
import { buildTbs, makeKey, opaqueExtension, signWith, spkiOfModulus } from "./lib/cert.mjs";
import { chainCase, limbs, noirCardProofInputs, noirChainInputs, shiftedLimbs } from "./lib/inputs.mjs";
import { runNoir } from "./lib/run.mjs";

const { ca, user } = buildCases();
const hexOf = (x) => "0x" + x.toString(16);
const redc = (modulus, bits) => (1n << BigInt(2 * bits + 6)) / modulus;
const tbs = buildTbs({ spki: user.spki });

/** `canonical_signature` alone: no RSA verification follows it. */
const canonical = (modulus, value, { modulusLimbs, valueLimbs } = {}) =>
  runNoir("probe_canonical_signature", {
    modulus: (modulusLimbs ?? limbs(modulus, 120, 18)).map(hexOf),
    redc: limbs(redc(modulus, 2048), 120, 18).map(hexOf),
    signature: (valueLimbs ?? limbs(value, 120, 18)).map(hexOf),
  });

const cardProof = (circuit, chain, overrides = {}) =>
  runNoir(circuit, { ...noirCardProofInputs({ chain, key: user, scope: SCOPE, code: CODE }), ...overrides });

describe("[G1-own] canonical_signature: one limb encoding per signature", () => {
  const n = user.modulus;
  const s = signWith(user, SCOPE);

  it("accepts the canonical limbs of a signature", async () => {
    const r = await canonical(n, s);
    assert.equal(r.ok, true, r.error);
  });

  it("rejects the same integer with one limb 2^120 larger and the next 1 smaller, at every limb where the modulus limb is the larger one", async () => {
    const L = limbs(s, 120, 18);
    const M = limbs(n, 120, 18);
    let tried = 0;
    for (let i = 0; i < 17; i++) {
      if (!(M[i] > L[i] && L[i + 1] > 0n)) continue;
      const shifted = [...L];
      shifted[i] += 1n << 120n;
      shifted[i + 1] -= 1n;
      assert.equal(shifted.reduce((acc, l, j) => acc + (l << BigInt(120 * j)), 0n), s);
      assert.equal((await canonical(n, s, { valueLimbs: shifted })).ok, false, `limb ${i}`);
      tried++;
    }
    assert.ok(tried >= 1, "no limb could be shifted");
  });

  // Any value with a top limb wider than 8 bits is at least the modulus, so
  // validate_in_field rejects it too: this case does not depend on from_array.
  // The limb shift above is the case that does.
  it("rejects a top limb wider than 8 bits (also caught by validate_in_field)", async () => {
    const L = limbs(1n, 120, 18);
    L[17] = 1n << 8n;
    assert.equal((await canonical(n, 0n, { valueLimbs: L })).ok, false);
  });
});

describe("[G4] canonical_signature: below the modulus, strictly", () => {
  const n = user.modulus;
  it("accepts n - 1 and 0", async () => {
    assert.equal((await canonical(n, n - 1n)).ok, true);
    assert.equal((await canonical(n, 0n)).ok, true);
  });
  it("rejects n", async () => {
    assert.equal((await canonical(n, n)).ok, false);
  });
  it("rejects n + 1 and s + n", async () => {
    assert.equal((await canonical(n, n + 1n)).ok, false);
    let key, s;
    do {
      key = makeKey(2048);
      s = signWith(key, SCOPE);
    } while (s + key.modulus >= 1n << 2048n);
    assert.equal((await canonical(key.modulus, s)).ok, true);
    assert.equal((await canonical(key.modulus, s + key.modulus)).ok, false);
  });
});

describe("[G1-e2e] card proof: a signature in a second limb encoding", () => {
  const chain = chainCase({ ca, tbs, currentTime: NOW });
  const inputs = (overrides) => noirCardProofInputs({ chain, key: user, scope: SCOPE, code: CODE, ...overrides });

  it("accepts the honest card proof these cases are made from", async () => {
    const r = await runNoir("card_proof_rs2048", inputs({}));
    assert.equal(r.ok, true, r.error);
  });
  it("rejects the scope string signature", async () => {
    assert.equal((await runNoir("card_proof_rs2048", inputs({ shiftScope: true }))).ok, false);
  });
  it("rejects the declaration code signature", async () => {
    assert.equal((await runNoir("card_proof_rs2048", inputs({ shiftCode: true }))).ok, false);
  });
  it("rejects the issuer signature", async () => {
    const shifted = chainCase({ ca, tbs, currentTime: NOW, shiftLimb: true });
    assert.equal((await cardProof("card_proof_rs2048", shifted)).ok, false);
  });
});

describe("[G2] a key has one limb encoding", () => {
  // `canonical_signature` compares its value with the modulus limb by limb.
  // With limb i of the modulus 2^120 larger and limb i + 1 one smaller, that
  // comparison still works out for a value whose limb i is larger than the
  // modulus's. So nothing but the range check on the modulus limbs rejects
  // these, and no witness hint is involved.
  it("the probe rejects a modulus with one limb 2^120 larger and the next 1 smaller, at every limb", async () => {
    const n = user.modulus;
    const M = limbs(n, 120, 18);
    for (let i = 0; i < 17; i++) {
      if (M[i + 1] === 0n || M[i] === (1n << 120n) - 1n) continue;
      const value = ((1n << 120n) - 1n) << BigInt(120 * i); // limb i all ones, the rest zero: below n
      assert.equal((await canonical(n, value)).ok, true, `limb ${i}, canonical modulus`);
      const shifted = [...M];
      shifted[i] += 1n << 120n;
      shifted[i + 1] -= 1n;
      assert.equal((await canonical(n, value, { modulusLimbs: shifted })).ok, false, `limb ${i}`);
    }
  });
});

describe("[G2-e2e] card proof: the issuer key in a second limb encoding", () => {
  // Without the range check, whether one of these is accepted depends on the
  // key and the certificate (the library's witness hints often fail on such a
  // modulus), so this test alone does not always notice the missing line;
  // [G2] does.
  it("rejects the issuer modulus with one limb 2^120 larger and the next 1 smaller, at every limb", async () => {
    const chain = chainCase({ ca, tbs, currentTime: NOW });
    assert.equal((await cardProof("card_proof_rs2048", chain)).ok, true);
    const M = limbs(ca.modulus, 120, 18);
    let tried = 0;
    for (let i = 0; i < 17; i++) {
      if (M[i + 1] === 0n) continue;
      const shifted = [...M];
      shifted[i] += 1n << 120n;
      shifted[i + 1] -= 1n;
      assert.equal((await cardProof("card_proof_rs2048", chain, { issuer_modulus: shifted.map(hexOf) })).ok, false, `limb ${i}`);
      tried++;
    }
    assert.equal(tried, 17);
  });
});

describe("[G3-issuer] the issuer key is exactly as long as the circuit says", () => {
  for (const [circuit, bits] of [["card_proof_rs2048", 2048], ["card_proof_rs4096", 4096]]) {
    it(`${circuit} rejects a certificate signed by an issuer key one or two bits shorter`, async () => {
      // OpenSSL makes a 2047-bit modulus for 2047 and a 4094-bit one for 4095.
      const short = makeKey(bits - 1);
      const length = short.modulus.toString(2).length;
      assert.ok(length === bits - 1 || length === bits - 2, `${length} bits`);
      // Same limb count and redc as a full-length key: nothing but the length differs.
      const chain = chainCase({ ca: { ...short, bits }, tbs, currentTime: NOW });
      assert.equal((await cardProof(circuit, chain)).ok, false);
    });
  }
});

describe("card key exactly 2048 bits", () => {
  const short = makeKey(2047);
  const shortTbs = buildTbs({ spki: spkiOfModulus(short.modulus) });
  const chain = chainCase({ ca, tbs: shortTbs, currentTime: NOW });

  it("[G3-part] the certificate part rejects a 2047-bit key written into 256 modulus bytes", async () => {
    assert.equal(short.modulus.toString(2).length, 2047);
    // cert_chain_rs2048 never builds BigNumParams for the card key: only der.nr stands here.
    const full = chainCase({ ca, tbs: buildTbs({ spki: spkiOfModulus(user.modulus) }), currentTime: NOW });
    assert.equal((await runNoir("cert_chain_rs2048", noirChainInputs(full))).ok, true);
    assert.equal((await runNoir("cert_chain_rs2048", noirChainInputs(chain))).ok, false);
  });

  it("[G3-card] the card proof rejects that key with its own valid signatures", async () => {
    const r = await runNoir("card_proof_rs2048", noirCardProofInputs({ chain, key: short, scope: SCOPE, code: CODE }));
    assert.equal(r.ok, false);
  });
});

describe("SHA-256 over a length past the buffer", () => {
  const message = Buffer.from(Array.from({ length: 128 }, (_, i) => (i * 7 + 3) & 0xff));
  const sha = (length) => runNoir("probe_sha256_var", { message: Array.from(message), length });

  it("[G7-lib] sha256_var hashes every length up to its buffer, and rejects 129, 192, 2^32 - 1", async () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128]) {
      const r = await sha(length);
      assert.equal(r.ok, true, r.error);
      const expected = createHash("sha256").update(message.subarray(0, length)).digest();
      assert.deepEqual(Buffer.from(r.returnValue.map(Number)), expected, `length ${length}`);
    }
    for (const length of [129, 192, 2 ** 32 - 1]) assert.equal((await sha(length)).ok, false, `length ${length}`);
  });

  it("[G7-e2e] the card proof rejects a certificate longer than 1527 bytes, and a tbs_len past the 1536-byte buffer", async () => {
    // Honestly signed certificates of exactly these lengths: only the bound
    // on the length rejects the longer ones.
    const ofLength = (length) => {
      const base = buildTbs({ spki: user.spki, extraExtensions: [opaqueExtension(Buffer.alloc(300))] }).length;
      const long = buildTbs({ spki: user.spki, extraExtensions: [opaqueExtension(Buffer.alloc(300 + length - base))] });
      assert.equal(long.length, length);
      return chainCase({ ca, tbs: long, currentTime: NOW });
    };
    assert.equal((await cardProof("card_proof_rs2048", ofLength(1527))).ok, true);
    for (const length of [1528, 1536]) {
      assert.equal((await cardProof("card_proof_rs2048", ofLength(length))).ok, false, `${length} bytes`);
    }
    const chain = chainCase({ ca, tbs, currentTime: NOW });
    for (const tbs_len of [1537, 1600, 2 ** 32 - 1]) {
      assert.equal((await cardProof("card_proof_rs2048", chain, { tbs_len })).ok, false, `tbs_len ${tbs_len}`);
    }
  });
});
