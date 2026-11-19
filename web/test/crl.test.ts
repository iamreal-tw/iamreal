// Poseidon2, the tree and the CRL checks against spec/vectors/poseidon2.json
// and against crl/testdata/ (the files and results the Go tests use).
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { bytesOfHex, sha256Hex } from "iamreal-protocol/bytes.ts";
import { buildWith } from "../src/crl/build.ts";
import { KEY_WORDS, Unusable, parseCrl, usableCrl, wordsOfKey } from "../src/crl/crl.ts";
import { chooseFromIndex } from "../src/crl/revocation.ts";
import { type TreeResult, buildPart, checkAbsence } from "../src/crl/tree.ts";
import { formatDay, taiwanDayOfSeconds } from "iamreal-protocol/date.ts";
import { scopedId, signatureLimbs } from "iamreal-protocol/scoped-id.ts";
import { poseidon } from "./bb.ts";
import { repoFile, vectors } from "./vectors.ts";

const hex64 = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");

function keysOf(serials: bigint[]): Uint32Array {
  const keys = new Uint32Array(serials.length * KEY_WORDS);
  serials.forEach((s, i) => keys.set(wordsOfKey(s), i * KEY_WORDS));
  return keys;
}

describe("poseidon2.json", async () => {
  const p = await poseidon();
  const v = vectors("poseidon2.json");
  test("hash_2", () => {
    for (const c of v.hash_2) assert.equal(hex64(p.hash2(BigInt(c.inputs[0]), BigInt(c.inputs[1]))), hex64(BigInt(c.hash)));
  });
  test("hash_3", () => {
    for (const c of v.hash_3) assert.equal(hex64(p.hash3(BigInt(c.inputs[0]), BigInt(c.inputs[1]), BigInt(c.inputs[2]))), hex64(BigInt(c.hash)));
  });
  test("scoped_id", async () => {
    for (const c of v.scoped_id.cases) {
      const sig = bytesOfHex(c.signature);
      assert.deepEqual(signatureLimbs(sig).map((x) => x.toString(16)), c.limbs.map((x: string) => BigInt(x).toString(16)));
      assert.equal(hex64(await scopedId(sig, async (a, b) => p.hash2(a, b))), hex64(BigInt(c.scoped_id)));
    }
  });
  for (const [i, c] of v.revocation_tree.cases.entries()) {
    for (const runners of [1, 2, 4]) {
      test(`revocation_tree case ${i}, ${runners} part(s)`, async () => {
        const serials = c.serials.map((s: string) => BigInt(s));
        for (const a of c.absent) {
          const r = await buildWith(Array.from({ length: runners }, () => p.runner()), keysOf(serials), serials.length, BigInt(a.serial));
          assert.equal(r.inTree, false);
          if (r.inTree) return;
          assert.equal(hex64(r.proof.root), hex64(BigInt(c.root)));
          const sib = a.siblings.map((x: string) => BigInt(x));
          while (sib.length < 128) sib.push(0n);
          assert.deepEqual(r.proof.siblings, sib);
          assert.equal(r.proof.isOld0, a.is_old0);
          assert.equal(r.proof.oldKey, BigInt(a.old_key));
          assert.equal(r.proof.oldValue, BigInt(a.old_value));
        }
      });
    }
  }
});

describe("the tree in parts gives the tree in one piece", async () => {
  const p = await poseidon();
  test("random keys, targets in and out of the tree", async () => {
    let seed = 12345n;
    const rnd = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n));
    const serials: bigint[] = [];
    for (let i = 0; i < 300; i++) serials.push(((rnd() << 64n) | rnd()) >> BigInt(Number(rnd() % 40n)));
    serials.push(5n, 0n, (1n << 159n) + 7n);
    const keys = keysOf(serials);
    const targets = [...serials.slice(0, 5), 4n, 6n, 1n, (1n << 159n) + 3n, 12345678901234567890n];
    for (const t of targets) {
      const results: TreeResult[] = [];
      for (const n of [1, 2, 4]) results.push(await buildWith(Array.from({ length: n }, () => p.runner()), keys, serials.length, t));
      for (const r of results.slice(1)) assert.deepEqual(r, results[0]);
      const r = results[0]!;
      assert.equal(r.inTree, serials.includes(t));
      if (!r.inTree) assert.equal(await checkAbsence(r.proof, t, async (a, b) => p.hash2(a, b), async (a, b, c) => p.hash3(a, b, c)), true);
    }
  });
});

describe("crl/testdata against crl/testdata/expected.json", async () => {
  const expected: Record<string, any>[] = JSON.parse(new TextDecoder().decode(repoFile("crl/testdata/expected.json")));
  const spki = repoFile("crl/testdata/issuer-public-key.der");
  const key = await crypto.subtle.importKey("spki", spki as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", await crypto.subtle.importKey("spki", spki as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]));
  const bits = atob(jwk.n!.replace(/-/g, "+").replace(/_/g, "/")).length * 8;
  const p = await poseidon();
  const files = readdirSync(new URL("../../crl/testdata/", import.meta.url)).filter((f) => f.endsWith(".crl"));
  test("every file has an expectation", () => assert.deepEqual(files.map((f) => f.slice(0, -4)).sort(), expected.map((e) => e.name).sort()));
  for (const e of expected) {
    test(e.name, async () => {
      const der = repoFile(`crl/testdata/${e.name}.crl`);
      assert.equal(await sha256Hex(der), e.sha256);
      try {
        const crl = await usableCrl(der, key, bits);
        assert.equal(e.usable, true, "usable here, not in Go");
        assert.equal(crl.crlNumber.toString(), e.crl_number);
        assert.equal(formatDay(taiwanDayOfSeconds(crl.thisUpdate)), e.crl_date);
        const part = buildPart(crl.keys, crl.count, p.hasher, null, 0);
        assert.equal(part.root.toString(16).padStart(64, "0"), e.root);
      } catch (err) {
        if (!(err instanceof Unusable)) throw err;
        assert.equal(e.usable, false, `not usable here (${err.message}), usable in Go`);
        assert.equal(err.code, e.reason);
      }
    });
  }
  test("parse reads thisUpdate of files that are not usable", () => {
    const e = expected.find((x) => x.name === "bad-signature")!;
    const c = parseCrl(repoFile("crl/testdata/bad-signature.crl"));
    assert.equal(formatDay(taiwanDayOfSeconds(c.thisUpdate)), e.crl_date);
  });
});

describe("choosing from the archive index", () => {
  const line = (issuer: string, n: string, sha: string, root = "11".repeat(32)) =>
    `{"issuer":"${issuer}","crl_number":"${n}","this_update":"2026-11-15T16:30:00Z","next_update":"2026-11-17T04:30:00Z","crl_date":"2026-11-16","sha256":"${sha}","root":"${root}"}`;
  test("the usable line of the issuer with the highest number", () => {
    const idx = [line("G2", "9", "aa".repeat(32)), line("G3", "7", "bb".repeat(32)), line("G3", "10", "cc".repeat(32)), line("G3", "11", "dd".repeat(32), "-not_usable_signature"), "garbage", ""].join("\n");
    assert.deepEqual(chooseFromIndex(idx, "G3"), { crlNumber: 10n, sha256: "cc".repeat(32) });
    assert.deepEqual(chooseFromIndex(idx, "G2"), { crlNumber: 9n, sha256: "aa".repeat(32) });
  });
  test("two files with the highest number: no choice", () => {
    const idx = [line("G3", "10", "cc".repeat(32)), line("G3", "10", "ee".repeat(32))].join("\n");
    assert.equal((chooseFromIndex(idx, "G3") as { code: string }).code, "crl_unavailable");
  });
  test("no line", () => assert.equal((chooseFromIndex("", "G3") as { code: string }).code, "crl_unavailable"));
});
