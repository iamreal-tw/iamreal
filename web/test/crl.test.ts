// Poseidon2, the tree and the CRL checks against spec/vectors/poseidon2.json
// and against crl/testdata/ and crl/testdata/times/ (the files and results
// the Go tests use). Which
// CRL the device uses is tested against spec/vectors/device-checks.json
// (device-checks.test.ts).
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { bytesOfHex, sha256Hex } from "iamreal-protocol/bytes.ts";
import { buildWith } from "../src/crl/build.ts";
import { KEY_WORDS, Unusable, parseCrl, usableCrl, wordsOfKey } from "../src/crl/crl.ts";
import { type TreeResult, buildPart, checkAbsence } from "../src/crl/tree.ts";
import { DerError, TAG, children, readTlv, whole } from "../src/der.ts";
import { importRsaKey } from "../src/issuers.ts";
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

describe("revocation-tree.json", async () => {
  const p = await poseidon();
  const v = vectors("revocation-tree.json");
  const keyOf = async (issuer: string) => {
    const i = v.issuers.find((x: { issuer: string }) => x.issuer === issuer);
    return { key: await importRsaKey(BigInt(i.modulus), i.modulus_bits), bits: i.modulus_bits };
  };
  const crls = new Map<string, { root: bigint; keys: Uint32Array; count: number }>();
  for (const c of v.crls) {
    test(`CRL ${c.name}: usable, and its root`, async () => {
      const { key, bits } = await keyOf(c.issuer);
      const crl = await usableCrl(bytesOfHex(c.crl), key, bits);
      const root = buildPart(crl.keys, crl.count, p.hasher, null, 0).root;
      assert.equal(hex64(root), c.root);
      crls.set(c.name, { root, keys: crl.keys, count: crl.count });
    });
  }
  for (const c of v.cases) {
    for (const runners of [1, 2, 4]) {
      test(`${c.label} (${c.crl}), ${runners} part(s)`, async () => {
        const crl = crls.get(c.crl)!;
        const r = await buildWith(Array.from({ length: runners }, () => p.runner()), crl.keys, crl.count, BigInt(c.serial));
        assert.equal(r.inTree, c.in_tree);
        if (r.inTree) return;
        assert.deepEqual(
          {
            smt_root: hex64(r.proof.root),
            smt_siblings: r.proof.siblings.map(hex64),
            smt_old_key: hex64(r.proof.oldKey),
            smt_old_value: hex64(r.proof.oldValue),
            smt_is_old0: r.proof.isOld0,
          },
          c.path,
        );
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
  test("crl/testdata/times/: which spellings of a time are read, and the times read, as in expected.json", async () => {
    const cases: { name: string; sha256: string; line: string }[] = JSON.parse(new TextDecoder().decode(repoFile("crl/testdata/times/expected.json")));
    assert.ok(cases.length >= 50, `${cases.length} cases`);
    let read = 0;
    for (const c of cases) {
      const der = repoFile(`crl/testdata/times/${c.name}.crl`);
      assert.equal(await sha256Hex(der), c.sha256, c.name);
      const line = JSON.parse(c.line) as Record<string, string>;
      // Nobody trusts the key that signed these: a file that is read at all is not usable for its signature.
      await assert.rejects(usableCrl(der, key, bits), (err: unknown) => err instanceof Unusable && `-${err.code}` === line.root, c.name);
      if (line.root === "-not_usable_der") continue;
      const parsed = parseCrl(der);
      assert.equal(new Date(parsed.thisUpdate * 1000).toISOString().replace(".000Z", "Z"), line.this_update, c.name);
      assert.equal(formatDay(taiwanDayOfSeconds(parsed.thisUpdate)), line.crl_date, c.name);
      read++;
    }
    assert.ok(read >= 10 && cases.length - read >= 10, `${read} of ${cases.length} read`);
  });
  test("a time field of 300,000 characters is not DER, like any time that is not 13 or 15 bytes", async () => {
    // One element: its tag, its length in the long form, its content.
    const tlv = (tag: number, body: Uint8Array): Uint8Array => {
      const length = body.length < 0x80 ? [body.length] : body.length < 0x10000 ? [0x82, body.length >> 8, body.length & 0xff] : [0x83, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff];
      return Uint8Array.from([tag, ...length, ...body]);
    };
    const join = (parts: Uint8Array[]): Uint8Array => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    // A CRL of crl/testdata/ with its thisUpdate written as 300,000 zeros and Z; everything else as it was.
    const der = repoFile("crl/testdata/one.crl");
    const [tbs, ...rest] = children(der, readTlv(der, 0));
    const fields = children(der, tbs!);
    const at = fields.findIndex((f) => f.tag === TAG.UTC_TIME);
    assert.ok(at > 0, "thisUpdate is the first time of the TBSCertList");
    for (const [tag, text] of [
      [TAG.UTC_TIME, "0".repeat(300_000) + "Z"],
      [TAG.GENERALIZED_TIME, "0".repeat(300_000) + "Z"],
      [TAG.UTC_TIME, "26111916000000Z"], // one digit too many: 15 bytes, the length of the other type
    ] as const) {
      const time = tlv(tag, new TextEncoder().encode(text));
      const long = tlv(TAG.SEQUENCE, join([tlv(TAG.SEQUENCE, join(fields.map((f, i) => (i === at ? time : whole(der, f))))), ...rest.map((f) => whole(der, f))]));
      const what = `${tag === TAG.UTC_TIME ? "UTCTime" : "GeneralizedTime"} of ${text.length} characters`;
      assert.throws(() => parseCrl(long), DerError, what);
      await assert.rejects(usableCrl(long, key, bits), (err: unknown) => err instanceof Unusable && err.code === "not_usable_der", what);
    }
  });
  test("parse reads thisUpdate of files that are not usable", () => {
    const e = expected.find((x) => x.name === "bad-signature")!;
    const c = parseCrl(repoFile("crl/testdata/bad-signature.crl"));
    assert.equal(formatDay(taiwanDayOfSeconds(c.thisUpdate)), e.crl_date);
  });
});
