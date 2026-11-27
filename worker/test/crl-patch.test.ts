// CRL patches (src/crl-patch.ts) against spec/vectors/crl-patch.json, the
// answers every reader of patches is tested with; and the patches the
// mirror makes, which must give the file they are made for.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bytesOfHex } from "iamreal-protocol/bytes.ts";
import { UnusablePatch, applyPatch, makePatch, patchName, restore } from "../src/crl-patch.ts";
import { WORKER_DIR } from "./build.ts";
import { makeCrl, randomSerials as serials } from "./crls.ts";

interface UsableCase {
  readonly label: string;
  readonly previous: string;
  readonly patch: string;
  readonly file: string;
  readonly name: string;
}
interface UnusableCase {
  readonly label: string;
  readonly previous: string;
  readonly patch: string;
  readonly name?: string;
}
const vectors = JSON.parse(readFileSync(join(WORKER_DIR, "..", "spec", "vectors", "crl-patch.json"), "utf8")) as { usable: UsableCase[]; unusable: UnusableCase[] };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** The SHA-256 of the file a patch's name says it gives. */
const fileOfName = (name: string): string => /^[0-9a-f]{64}-([0-9a-f]{64})\.patch$/.exec(name)![1]!;

test("every usable patch of the vectors gives its file, and its name is the two files' SHA-256", async () => {
  assert.ok(vectors.usable.length >= 8);
  for (const c of vectors.usable) {
    const previous = bytesOfHex(c.previous);
    const file = bytesOfHex(c.file);
    assert.deepEqual(applyPatch(previous, bytesOfHex(c.patch)), file, c.label);
    assert.equal(patchName(sha256(previous), sha256(file)), c.name, c.label);
    assert.deepEqual(await restore(previous, bytesOfHex(c.patch), fileOfName(c.name)), file, c.label);
  }
});

test("every unusable patch of the vectors is refused", async () => {
  assert.ok(vectors.unusable.length >= 10);
  for (const c of vectors.unusable) {
    const previous = bytesOfHex(c.previous);
    const patch = bytesOfHex(c.patch);
    if (c.name === undefined) assert.throws(() => applyPatch(previous, patch), UnusablePatch, c.label);
    else await assert.rejects(restore(previous, patch, fileOfName(c.name)), UnusablePatch, c.label);
  }
});

const THEN = new Date("2026-11-19T16:00:00Z");

test("a patch the mirror makes gives the file it is made for, and is small when the two CRLs differ by little", () => {
  const before = serials(0, 2000);
  const pairs: [string, Uint8Array, Uint8Array][] = [
    ["entries added", makeCrl({ issuer: "G3", number: 1n, thisUpdate: THEN, serials: before }), makeCrl({ issuer: "G3", number: 2n, thisUpdate: THEN, serials: [...before.slice(0, 700), ...serials(5000, 30), ...before.slice(700)] })],
    ["entries taken out", makeCrl({ issuer: "G2", number: 1n, thisUpdate: THEN, serials: before }), makeCrl({ issuer: "G2", number: 2n, thisUpdate: THEN, serials: before.filter((_, i) => i % 400 !== 7) })],
    ["the same CRL", makeCrl({ issuer: "G3", number: 1n, thisUpdate: THEN, serials: before }), makeCrl({ issuer: "G3", number: 1n, thisUpdate: THEN, serials: before })],
  ];
  for (const [label, previous, next] of pairs) {
    const patch = makePatch(previous, next);
    assert.deepEqual(applyPatch(previous, patch), next, label);
    assert.ok(patch.length < 4000, `${label}: ${patch.length} bytes from ${next.length}`);
  }
});

test("a patch the mirror makes gives the file for files that share nothing, or are empty", () => {
  const some = Uint8Array.from({ length: 5000 }, (_, i) => (i * 131 + 7) & 0xff);
  const other = Uint8Array.from({ length: 3000 }, (_, i) => (i * 17 + 3) & 0xff);
  for (const [previous, next] of [[some, other], [other, some], [new Uint8Array(0), some], [some, new Uint8Array(0)], [new Uint8Array(0), new Uint8Array(0)], [some.subarray(0, 31), some.subarray(0, 33)]] as const) {
    assert.deepEqual(applyPatch(previous, makePatch(previous, next)), next);
  }
  // A file of runs that repeat: the copies only go forward, and still give the file.
  const repeated = Uint8Array.from({ length: 4096 }, (_, i) => i % 64);
  const shifted = Uint8Array.from({ length: 4096 }, (_, i) => (i + 32) % 64);
  assert.deepEqual(applyPatch(repeated, makePatch(repeated, shifted)), shifted);
  assert.deepEqual(applyPatch(shifted, makePatch(shifted, repeated)), repeated);
});
