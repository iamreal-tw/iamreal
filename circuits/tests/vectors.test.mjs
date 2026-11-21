// Fixed answers for the circuit's field hash (tests/vectors/poseidon2.json).
//
// Every other expected hash in the tests is computed at run time with bb.js.
// If a library upgrade changed how Poseidon2 absorbs its inputs, the circuit
// and bb.js could change together, every nullifier and every revocation tree
// root would change, and those tests would still pass. The values in the file
// are written down once; the circuit and the off-circuit code are both held to
// them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { chunkedHash, loadPoseidon2 } from "./lib/hashes.mjs";
import { limbs, SMT_DEPTH } from "./lib/inputs.mjs";
import { ROOT, runNoir } from "./lib/run.mjs";
import { Smt } from "./lib/smt.mjs";

const vectors = JSON.parse(readFileSync(join(ROOT, "tests", "vectors", "poseidon2.json"), "utf8"));
const big = (s) => BigInt(s);
const hexOf = (x) => "0x" + x.toString(16);
const zeros = (n) => Array(n).fill("0x0");

/** Runs the probe circuit; anything not given is a valid filler. */
async function probe({ pair = zeros(2), triple = zeros(3), chain = zeros(18), tree } = {}) {
  const t = tree ?? { root: 0n, key: 1n, siblings: [], oldKey: 0n, oldValue: 0n, isOld0: true };
  const r = await runNoir("probe_hash_vectors", {
    pair, triple, chain,
    smt_root: hexOf(t.root),
    smt_key: hexOf(t.key),
    smt_siblings: [...t.siblings.map(hexOf), ...zeros(SMT_DEPTH - t.siblings.length)],
    smt_old_key: hexOf(t.oldKey),
    smt_old_value: hexOf(t.oldValue),
    smt_is_old0: t.isOld0,
  });
  return r.ok ? { ok: true, hash2: big(r.returnValue[0]), hash3: big(r.returnValue[1]), chain: big(r.returnValue[2]) } : r;
}

describe("[poseidon2] fixed answers", () => {
  let offCircuit;
  before(async () => {
    offCircuit = await loadPoseidon2();
  });

  it("the file has every kind of case", () => {
    assert.equal(vectors.spec, "poseidon2");
    assert.ok(vectors.hash_2.length >= 5 && vectors.hash_3.length >= 5);
    assert.ok(vectors.scoped_id.cases.length >= 3 && vectors.revocation_tree.cases.length >= 3);
  });

  for (const [i, v] of vectors.hash_2.entries()) {
    it(`hash_2 case ${i}: circuit and bb.js`, async () => {
      const r = await probe({ pair: v.inputs });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.hash2, big(v.hash));
      assert.equal(offCircuit.hash2(...v.inputs.map(big)), big(v.hash));
    });
  }

  for (const [i, v] of vectors.hash_3.entries()) {
    it(`hash_3 case ${i}: circuit and bb.js`, async () => {
      const r = await probe({ triple: v.inputs });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.hash3, big(v.hash));
      assert.equal(offCircuit.hash3(...v.inputs.map(big)), big(v.hash));
    });
  }

  it("hash_3(a, b, 0) is not hash_2(a, b)", () => {
    const two = vectors.hash_2.find((v) => big(v.inputs[0]) === 1n && big(v.inputs[1]) === 2n);
    const three = vectors.hash_3.find((v) => big(v.inputs[0]) === 1n && big(v.inputs[1]) === 2n && big(v.inputs[2]) === 0n);
    assert.notEqual(two.hash, three.hash);
  });

  for (const [i, v] of vectors.scoped_id.cases.entries()) {
    it(`scoped_id case ${i}: limbs of the signature, then the hash chain; circuit and bb.js`, async () => {
      const cut = limbs(big("0x" + v.signature), 120, 18);
      assert.deepEqual(cut, v.limbs.map(big));
      const r = await probe({ chain: v.limbs });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.chain, big(v.scoped_id));
      assert.equal(chunkedHash(offCircuit, cut), big(v.scoped_id));
    });
  }

  for (const [i, v] of vectors.revocation_tree.cases.entries()) {
    it(`revocation tree case ${i} (${v.serials.length} serials): root, and each non-membership proof in the circuit`, async () => {
      const tree = new Smt(offCircuit.hash2, offCircuit.hash3);
      for (const s of v.serials) tree.insert(big(s));
      assert.equal(tree.root(), big(v.root));
      for (const a of v.absent) {
        const proof = { root: big(v.root), key: big(a.serial), siblings: a.siblings.map(big), oldKey: big(a.old_key), oldValue: big(a.old_value), isOld0: a.is_old0 };
        const r = await probe({ tree: proof });
        assert.equal(r.ok, true, `${a.serial}: ${r.error}`);
        // The proof in the file is the one the reference tree gives.
        const mine = tree.proveAbsent(big(a.serial));
        assert.deepEqual(mine.siblings.slice(0, a.siblings.length), proof.siblings);
        assert.ok(mine.siblings.slice(a.siblings.length).every((s) => s === 0n));
        assert.deepEqual([mine.oldKey, mine.oldValue, mine.isOld0], [proof.oldKey, proof.oldValue, proof.isOld0]);
        // Against a different root the same proof fails.
        assert.equal((await probe({ tree: { ...proof, root: proof.root + 1n } })).ok, false);
      }
      // A listed serial has no non-membership proof: its own leaf as "another leaf".
      for (const s of v.serials.slice(0, 2)) {
        const without = new Smt(offCircuit.hash2, offCircuit.hash3);
        for (const other of v.serials) if (other !== s) without.insert(big(other));
        const before = without.proveAbsent(big(s));
        const forged = { root: big(v.root), key: big(s), siblings: before.siblings, oldKey: big(s), oldValue: 1n, isOld0: false };
        assert.equal((await probe({ tree: forged })).ok, false);
        assert.equal((await probe({ tree: { ...forged, oldKey: before.oldKey, oldValue: before.oldValue, isOld0: before.isOld0 } })).ok, false);
      }
    });
  }
});
