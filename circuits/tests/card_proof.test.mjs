// The card proof circuit as a whole: what the case-by-case comparison
// (equivalence.test.mjs) cannot cover. That the two signatures are checked
// under the certificate's key and cannot trade places; that the challenge is
// bound through the declaration code alone; the revocation tree
// with real entries (circom's tree is over another field); that the outputs
// match the hashes computed outside the circuit.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { buildCases, CODE, FIRST_BYTES, NOW, SCOPE } from "./cases.mjs";
import {
  AUTHORITY_KEY_ID, buildTbs, KEY_USAGE_ENCRYPTION, makeKey, serialOf, signWith, spkiOfModulus, SUBJECT_KEY_ID,
} from "./lib/cert.mjs";
import { chunkedHash, loadPoseidon2 } from "./lib/hashes.mjs";
import { declarationCode } from "./lib/declaration-code.mjs";
import { chainCase, limbs, noirCardProofInputs } from "./lib/inputs.mjs";
import { runNoir } from "./lib/run.mjs";
import { Smt } from "./lib/smt.mjs";

const { ca, user } = buildCases();
const ca4096 = makeKey(4096);
const other = makeKey(2048);
const tbs = buildTbs({ spki: user.spki });
const serial = serialOf(tbs);
const packed = (bytes) => BigInt("0x" + Buffer.from(bytes).reverse().toString("hex"));

const pass = (overrides = {}, chainOpts = {}) =>
  noirCardProofInputs({
    chain: chainCase({ ca, tbs: buildTbs({ spki: user.spki, ...chainOpts }), currentTime: NOW }),
    key: user, scope: SCOPE, code: CODE, ...overrides,
  });
const run = (inputs) => runNoir("card_proof_rs2048", inputs);

describe("card proof", () => {
  let honest;
  before(async () => {
    honest = await run(pass());
  });

  it("[honest] accepts an honest card proof and outputs both signed messages", async () => {
    assert.equal(honest.ok, true, honest.error);
    assert.equal(BigInt(honest.returnValue.scope_packed), packed(SCOPE));
    assert.equal(BigInt(honest.returnValue.declaration_code_packed), packed(CODE));
    assert.deepEqual(Object.keys(honest.returnValue).sort(), ["declaration_code_packed", "nullifier", "scope_packed"]);
  });

  it("accepts under a 4096-bit issuer key", async () => {
    const inputs = noirCardProofInputs({
      chain: chainCase({ ca: ca4096, tbs, currentTime: NOW }),
      key: user, scope: SCOPE, code: CODE,
    });
    assert.equal((await runNoir("card_proof_rs4096", inputs)).ok, true);
  });

  // The circuit has no challenge input. The challenge is bound only because the
  // verifier recomputes the declaration code from it and compares the code
  // with the proof's output: a code for another challenge needs a new
  // signature by the card.
  it("rejects a declaration code computed from another challenge that the card did not sign", async () => {
    const declaration = { action: "declare", scopeString: "iamreal:threads:0______________", username: "alice" };
    assert.deepEqual(declarationCode({ ...declaration, challenge: "1234567890" }), CODE); // the draft's example (tests/lib/declaration-code.mjs)
    const otherCode = declarationCode({ ...declaration, challenge: "1234567891" });
    assert.notDeepEqual(otherCode, CODE);

    // Same certificate, same signatures; only the declaration code changed.
    const signedForCode = signWith(user, CODE);
    assert.equal((await run(pass({ code: otherCode, codeSignature: signedForCode }))).ok, false);
    // The card signing the new code is what it takes.
    const resigned = await run(pass({ code: otherCode }));
    assert.equal(resigned.ok, true, resigned.error);
    assert.equal(BigInt(resigned.returnValue.declaration_code_packed), packed(otherCode));
  });

  it("rejects the two messages swapped", async () => {
    assert.equal((await run(pass({ scope: CODE, code: SCOPE }))).ok, false);
  });

  it("rejects a declaration code as the scope string, and a scope string as the declaration code", async () => {
    assert.equal((await run(pass({ scope: CODE }))).ok, false);
    assert.equal((await run(pass({ code: SCOPE }))).ok, false);
  });

  for (const [first, kind] of FIRST_BYTES) {
    const message = Buffer.concat([Buffer.from(first, "latin1"), SCOPE.subarray(1)]);
    it(`first byte 0x${message[0].toString(16).padStart(2, "0")}: as the scope string ${kind === "scope" ? "accepts" : "rejects"}, as the declaration code ${kind === "code" ? "accepts" : "rejects"}`, async () => {
      assert.equal((await run(pass({ scope: message }))).ok, kind === "scope");
      assert.equal((await run(pass({ code: message }))).ok, kind === "code");
    });
  }

  it("rejects a scope string signature or a declaration code signature made by another card", async () => {
    assert.equal((await run(pass({ scopeSignature: signWith(other, SCOPE) }))).ok, false);
    assert.equal((await run(pass({ codeSignature: signWith(other, CODE) }))).ok, false);
  });

  it("rejects signatures by a key other than the certificate's, even with that key's redc", async () => {
    // Everything signed by `other`, but the certificate is `user`'s.
    assert.equal((await run(pass({ key: other }))).ok, false);
  });

  it("[s+n] rejects a non-canonical scope string signature (s + n)", async () => {
    let key, s;
    do {
      key = makeKey(2048);
      s = signWith(key, SCOPE);
    } while (s + key.modulus >= 1n << 2048n);
    const chain = chainCase({ ca, tbs: buildTbs({ spki: key.spki }), currentTime: NOW });
    assert.equal((await run(noirCardProofInputs({ chain, key, scope: SCOPE, code: CODE }))).ok, true);
    assert.equal((await run(noirCardProofInputs({ chain, key, scope: SCOPE, code: CODE, scopeSignature: s + key.modulus }))).ok, false);
  });

  // The same integer in another limb encoding (one limb 2^120 larger, the next
  // 1 smaller). "Below the modulus" does not reject it; a range check on each
  // limb does. For the scope string this would be a second nullifier.
  describe("[limbs] rejects a signature in a non-canonical limb encoding of the same integer", () => {
    it("the scope string signature", async () => {
      assert.equal((await run(pass({ shiftScope: true }))).ok, false);
    });
    it("the declaration code signature", async () => {
      assert.equal((await run(pass({ shiftCode: true }))).ok, false);
    });
    it("the issuer signature (2048-bit issuer key)", async () => {
      const chain = chainCase({ ca, tbs, currentTime: NOW, shiftLimb: true });
      assert.equal((await run(noirCardProofInputs({ chain, key: user, scope: SCOPE, code: CODE }))).ok, false);
    });
    it("the issuer signature (4096-bit issuer key)", async () => {
      const honest4096 = chainCase({ ca: ca4096, tbs, currentTime: NOW });
      const shifted = { ...honest4096, shiftLimb: true };
      const inputs = (chain) => noirCardProofInputs({ chain, key: user, scope: SCOPE, code: CODE });
      assert.equal((await runNoir("card_proof_rs4096", inputs(honest4096))).ok, true);
      assert.equal((await runNoir("card_proof_rs4096", inputs(shifted))).ok, false);
    });
  });

  // ADR-0009: the card key is exactly 2048 bits. The pinned INTEGER header
  // fixes the length of the encoding only.
  describe("[key-2048] rejects a card key shorter than 2048 bits written into the 256 modulus bytes", () => {
    const withKey = (key) => run(noirCardProofInputs({
      chain: chainCase({ ca, tbs: buildTbs({ spki: spkiOfModulus(key.modulus) }), currentTime: NOW }),
      key, scope: SCOPE, code: CODE,
    }));
    it("the hand-built SPKI layout is the one Node exports for a 2048-bit key", async () => {
      assert.deepEqual(spkiOfModulus(user.modulus), user.spki);
      assert.equal((await withKey(user)).ok, true);
    });
    it("a 2047-bit key, with its own valid signatures", async () => {
      const key = makeKey(2047);
      assert.equal(key.modulus.toString(2).length, 2047);
      assert.equal((await withKey(key)).ok, false);
    });
    it("a 1024-bit key, with its own valid signatures", async () => {
      assert.equal((await withKey(makeKey(1024))).ok, false);
    });
  });

  it("still rejects what the certificate part rejects", async () => {
    assert.equal((await run(pass({}, { notAfter: "261114155958Z" }))).ok, false); // expired
    assert.equal((await run(pass({}, {
      leadingExtensions: [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION],
    }))).ok, false); // encryption certificate
    const inputs = pass();
    inputs.issuer_signature = [...inputs.issuer_signature];
    inputs.issuer_signature[0] = "0x1";
    assert.equal((await run(inputs)).ok, false); // issuer signature
    assert.equal((await run({ ...pass(), smt_root: "0x1" })).ok, false); // revocation tree root
  });

  it("bytes after the end of the TBS do not change the result", async () => {
    const inputs = pass();
    const dirty = await run({ ...inputs, tbs: inputs.tbs.map((b, i) => (i >= tbs.length ? 0xff : b)) });
    assert.equal(dirty.ok, true);
    assert.deepEqual(dirty.returnValue, honest.returnValue);
  });
});

describe("outputs match the off-circuit Poseidon2", () => {
  it("nullifier is the hash chain over the 18 signature limbs; both messages are packed little-endian", async () => {
    const r = await run(pass());
    const poseidon2 = await loadPoseidon2();
    assert.equal(BigInt(r.returnValue.nullifier), chunkedHash(poseidon2, limbs(signWith(user, SCOPE), 120, 18)));
    assert.equal(BigInt(r.returnValue.scope_packed), packed(SCOPE));
    assert.equal(BigInt(r.returnValue.declaration_code_packed), packed(CODE));
  });
});

describe("revocation tree", () => {
  let poseidon2, tree;
  const withTree = (smt) =>
    run(noirCardProofInputs({ chain: chainCase({ ca, tbs, currentTime: NOW, smt }), key: user, scope: SCOPE, code: CODE }));
  const newTree = () => new Smt(poseidon2.hash2, poseidon2.hash3);

  before(async () => {
    poseidon2 = await loadPoseidon2();
    tree = newTree();
    for (let i = 1n; i <= 40n; i++) tree.insert((i * 0x9e3779b97f4a7c15n * 0x1234567n) & ((1n << 128n) - 1n));
  });

  it("accepts a serial whose path ends in an empty subtree", async () => {
    // Both leaves are on the other side of the first branch.
    const t = newTree();
    t.insert(serial ^ 1n);
    t.insert(serial ^ 3n);
    const proof = t.proveAbsent(serial);
    assert.equal(proof.isOld0, true);
    assert.equal((await withTree(proof)).ok, true);
  });

  it("accepts a serial whose path ends at another serial's leaf", async () => {
    const t = newTree();
    t.insert(serial ^ 4n);
    const proof = t.proveAbsent(serial);
    assert.equal(proof.isOld0, false);
    assert.equal((await withTree(proof)).ok, true);
  });

  it("accepts a serial that is absent from a tree of 40 scattered serials", async () => {
    assert.equal((await withTree(tree.proveAbsent(serial))).ok, true);
  });

  it("accepts a serial next to a revoked one that shares its first 100 path bits", async () => {
    const t = newTree();
    t.insert(serial ^ (1n << 100n));
    t.insert(serial ^ 1n);
    const proof = t.proveAbsent(serial);
    assert.equal(proof.siblings.filter((s) => s !== 0n).length >= 1, true);
    assert.equal((await withTree(proof)).ok, true);
  });

  it("rejects a revoked serial", async () => {
    const revoked = newTree();
    for (const k of [...tree.leaves.keys()]) revoked.insert(k);
    const before = revoked.proveAbsent(serial);
    revoked.insert(serial);
    const root = revoked.root();
    // The honest path to the serial's own leaf, presented as "another leaf".
    assert.equal((await withTree({ ...before, root, oldKey: serial, oldValue: 1n, isOld0: false })).ok, false);
    // The same path, claiming the subtree is empty.
    assert.equal((await withTree({ ...before, root, isOld0: true })).ok, false);
    // The proof from before the revocation, against the new root.
    assert.equal((await withTree({ ...before, root })).ok, false);
  });

  it("rejects a proof against another root, or with a changed sibling", async () => {
    const proof = tree.proveAbsent(serial);
    assert.equal((await withTree({ ...proof, root: proof.root + 1n })).ok, false);
    const siblings = [...proof.siblings];
    siblings[0] += 1n;
    assert.equal((await withTree({ ...proof, siblings })).ok, false);
  });

  it("rejects a path that reaches the bottom of the tree", async () => {
    const proof = tree.proveAbsent(serial);
    const siblings = [...proof.siblings];
    siblings[127] = 1n;
    assert.equal((await withTree({ ...proof, siblings })).ok, false);
  });
});
