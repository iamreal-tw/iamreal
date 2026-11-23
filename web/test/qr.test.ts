// The QR code of the last screen (src/ui/qr.ts) is the one another encoder
// makes of the same text, module for module: qrcodegen 1.8.0, byte mode, level
// M (test/generate/qr-vectors.py wrote test/fixtures/qr-vectors.json).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { qrCode } from "../src/ui/qr.ts";

interface Vector {
  text: string;
  version: number;
  mask: number;
  rows: string[];
  forced_mask?: boolean;
}

const { vectors } = JSON.parse(readFileSync(new URL("fixtures/qr-vectors.json", import.meta.url), "utf8")) as { vectors: Vector[] };
const rowsOf = (modules: boolean[][]): string[] => modules.map((r) => r.map((m) => (m ? "1" : "0")).join(""));

test("the vectors cover versions 1 to 10, every mask, and a text that is not ASCII", () => {
  assert.deepEqual([...new Set(vectors.map((v) => v.version))].sort((a, b) => a - b), [1, 2, 3, 5, 6, 8, 9, 10]);
  assert.deepEqual([...new Set(vectors.map((v) => v.mask))].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(vectors.some((v) => /[^\x00-\x7f]/.test(v.text)));
});

for (const v of vectors.filter((x) => !x.forced_mask)) {
  test(`${JSON.stringify(v.text.slice(0, 40))} (${new TextEncoder().encode(v.text).length} bytes): version ${v.version}, mask ${v.mask}, as qrcodegen makes it`, () => {
    const q = qrCode(v.text);
    assert.equal(q.version, v.version);
    assert.equal(q.mask, v.mask);
    assert.deepEqual(rowsOf(q.modules), v.rows);
  });
}

for (const v of vectors.filter((x) => x.forced_mask)) {
  test(`${JSON.stringify(v.text.slice(0, 40))} with mask ${v.mask}, as qrcodegen makes it`, () => {
    const q = qrCode(v.text, v.mask);
    assert.equal(q.version, v.version);
    assert.deepEqual(rowsOf(q.modules), v.rows);
  });
}

test("a text longer than version 10 at level M holds is refused", () => {
  assert.doesNotThrow(() => qrCode("z".repeat(213)));
  assert.throws(() => qrCode("z".repeat(214)), /too long/);
});
