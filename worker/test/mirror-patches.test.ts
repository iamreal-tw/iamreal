// The CRL patches the mirror writes (spec/revocation-tree.md, "CRL
// patches"), in the local workerd (test/harness.ts), seen from outside: the
// patches a round leaves in the simulated R2 bucket, read back with the
// spec's reading (src/crl-patch.ts, tested against spec/vectors/crl-patch.json).
// When a patch cannot be written is in test/mirror-invariant.test.ts: the
// local workerd's bucket cannot be made to fail.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { applyPatch } from "../src/crl-patch.ts";
import { makeCrl, randomSerials as serials } from "./crls.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { sha256Hex } from "./proofs.ts";

const PATCHES = "crl/patches/";
const nameOf = (crl: Uint8Array): string => `crl/${sha256Hex(crl)}.crl`;
const patchOf = (from: Uint8Array, to: Uint8Array): string => `${PATCHES}${sha256Hex(from)}-${sha256Hex(to)}.patch`;

/** The patches in the bucket, by name. */
async function patchesOf(worker: TestWorker): Promise<Map<string, { bytes: Uint8Array; cacheControl: string | undefined }>> {
  return new Map((await worker.files(PATCHES)).map((f) => [f.key, { bytes: f.bytes, cacheControl: f.cacheControl }]));
}

/** One round; it must end well. */
async function round(worker: TestWorker): Promise<void> {
  assert.equal((await worker.runSchedule()).outcome, "ok", worker.logLines().join("\n"));
}

async function withWorker(options: Parameters<typeof startWorker>[0], run: (worker: TestWorker) => Promise<void>): Promise<void> {
  const worker = await startWorker(options);
  try {
    await run(worker);
  } finally {
    await worker.close();
  }
}

const THEN = new Date("2026-11-19T16:00:00Z");
const BASE = serials(0, 300);
/** The G3 CRL numbered `number`: the base serials and `number` more. */
const g3 = (number: bigint): Uint8Array => makeCrl({ issuer: "G3", number, thisUpdate: THEN, serials: [...BASE, ...serials(1000, Number(number))] });
const g2 = (number: bigint): Uint8Array => makeCrl({ issuer: "G2", number, thisUpdate: THEN, serials: BASE.slice(0, 200 + Number(number)) });

describe("each usable CRL gets the patch from the one before it of its issuer key", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  const [G2_1, G3_1, G3_2, G3_4] = [g2(1n), g3(1n), g3(2n), g3(4n)];

  test("the first CRL of each key has none", async () => {
    worker.moica.serve("G2", G2_1);
    worker.moica.serve("G3", G3_1);
    await round(worker);
    assert.deepEqual([...(await patchesOf(worker)).keys()], []);
  });

  test("the second has one: named by the two files' SHA-256, it gives the file, and may be cached as long as the file", async () => {
    worker.moica.serve("G3", G3_2);
    await round(worker);
    const patches = await patchesOf(worker);
    assert.deepEqual([...patches.keys()], [patchOf(G3_1, G3_2)]);
    const patch = patches.get(patchOf(G3_1, G3_2))!;
    assert.deepEqual(applyPatch(G3_1, patch.bytes), G3_2);
    assert.ok(patch.bytes.length < G3_2.length / 5, `${patch.bytes.length} bytes for a file of ${G3_2.length}`);
    assert.equal(patch.cacheControl, (await worker.files(nameOf(G3_2)))[0]!.cacheControl);
    assert.equal(patch.cacheControl, "public, max-age=31536000, immutable");
    const logged = worker.logLines().filter((l) => l.includes('"crl_patch"')).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(logged.map((l) => [l.result, l.from, l.to, l.bytes]), [["written", sha256Hex(G3_1), sha256Hex(G3_2), patch.bytes.length]]);
  });

  test("a file that is not usable gets none, and is not the previous CRL of the next", async () => {
    const html = new TextEncoder().encode("<!doctype html><title>Service unavailable</title>");
    // Signed by G3 and with a CRL number, but two serial numbers share their lowest 127 bits.
    const collision = makeCrl({ issuer: "G3", number: 3n, thisUpdate: THEN, serials: [...BASE, 5n, (1n << 130n) + 5n] });
    for (const file of [html, collision, G3_4]) {
      worker.moica.serve("G3", file);
      await round(worker);
    }
    assert.deepEqual([...(await patchesOf(worker)).keys()].sort(), [patchOf(G3_1, G3_2), patchOf(G3_2, G3_4)].sort());
    assert.deepEqual(applyPatch(G3_2, (await patchesOf(worker)).get(patchOf(G3_2, G3_4))!.bytes), G3_4);
  });

  test("a CRL that comes after a later one: the patch into it, and the one from it to the later one", async () => {
    const G3_3 = g3(3n);
    worker.moica.serve("G3", G3_3);
    await round(worker);
    const patches = await patchesOf(worker);
    for (const [from, to] of [[G3_2, G3_3], [G3_3, G3_4]] as const) assert.deepEqual(applyPatch(from, patches.get(patchOf(from, to))!.bytes), to);
    // The patch from 2 to 4 stays: it still gives 4, it is only no longer of two adjacent CRLs.
    assert.ok(patches.has(patchOf(G3_2, G3_4)));
  });

  test("the archive's files and index are as they were without patches", async () => {
    const files = (await worker.files("crl/")).map((f) => f.key).filter((key) => !key.startsWith(PATCHES));
    assert.ok(files.every((key) => /^crl\/([0-9a-f]{64}\.crl|index\.jsonl)$/.test(key)), files.join(" "));
    const index = new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]!.bytes);
    assert.equal(index.split("\n").length - 1, files.length - 1);
    assert.ok(!index.includes(".patch"));
  });
});

describe("pairs that have no patch get theirs in a later round", () => {
  const crls = [g3(11n), g3(12n), g3(13n), g3(14n)];
  const pairs = crls.slice(1).map((to, i) => patchOf(crls[i]!, to));

  /** An archive of `crls` whose patches are gone, as the archive was before the mirror wrote patches. */
  async function withoutPatches(worker: TestWorker): Promise<void> {
    worker.moica.serve("G2", g2(1n));
    for (const crl of crls) {
      worker.moica.serve("G3", crl);
      await round(worker);
    }
    for (const key of (await patchesOf(worker)).keys()) await worker.deleteFile(key);
  }

  test("in the next round, every one of them, though no new CRL came", () =>
    withWorker({}, async (worker) => {
      await withoutPatches(worker);
      await round(worker);
      const patches = await patchesOf(worker);
      assert.deepEqual([...patches.keys()].sort(), [...pairs].sort());
      for (const [i, name] of pairs.entries()) assert.deepEqual(applyPatch(crls[i]!, patches.get(name)!.bytes), crls[i + 1]);
    }));

  test("not once the round has gone on for longer than its limit; the patch of this round's CRL all the same", () =>
    withWorker({ crlCatchUpMs: 0 }, async (worker) => {
      await withoutPatches(worker);
      const fresh = g3(15n);
      worker.moica.serve("G3", fresh);
      await round(worker);
      assert.deepEqual([...(await patchesOf(worker)).keys()], [patchOf(crls.at(-1)!, fresh)]);
    }));
});
