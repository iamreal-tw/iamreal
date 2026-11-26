// The site's icon (#356): scripts/favicon.ts draws the pages' mark into
// site/favicon.ico. These check the file it wrote, and how it writes one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FAVICON_SIZES, icoImages, icoOf, markSvg } from "../scripts/favicon.ts";
import { FAVICON_FILE } from "../scripts/site-files.ts";
import { LOGO } from "../src/pages/layout.ts";
import { WORKER_DIR } from "./build.ts";

test("site/favicon.ico holds the mark at 16, 32 and 48 pixels, each a PNG of its size", () => {
  const images = icoImages(readFileSync(join(WORKER_DIR, "site", FAVICON_FILE)));
  assert.deepEqual(images.map((i) => i.size), [16, 32, 48]);
  assert.deepEqual(FAVICON_SIZES, [16, 32, 48]);
});

test("the mark drawn is the pages' own, in the colours of design/tokens.json", () => {
  const tokens = JSON.parse(readFileSync(join(WORKER_DIR, "..", "design", "tokens.json"), "utf8")) as Record<string, string>;
  const svg = markSvg(32);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64" width="32" height="32">/);
  // Every shape of LOGO, its rectangles and its path, the same and in the same groups: only the colours differ.
  const shapes = (s: string): string[] => s.replace(/ (class|fill|stroke)="[^"]*"/g, "").match(/<(g|rect|path)\b[^>]*>/g)!;
  assert.deepEqual(shapes(svg), shapes(String(LOGO)));
  assert.ok(svg.includes(`fill="${tokens["--you"]}"`) && svg.includes(`fill="${tokens["--ink"]}" stroke="${tokens["--bg"]}"`) && svg.includes(`fill="${tokens["--bg"]}"`));
  assert.doesNotMatch(svg, /class=/);
});

test("an ICO of PNGs: the directory, an entry for each, the PNGs; read back as written", () => {
  const png = (size: number): Buffer => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(size, 16);
    b.writeUInt32BE(size, 20);
    return b;
  };
  const ico = icoOf([16, 32, 256].map((size) => ({ size, png: png(size) })));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 3]);
  // 256 is written as 0; each entry says 1 plane, 32 bits, the length and where the PNG starts.
  assert.deepEqual([ico[6 + 32], ico[6 + 33], ico.readUInt16LE(6 + 4), ico.readUInt16LE(6 + 6), ico.readUInt32LE(6 + 8), ico.readUInt32LE(6 + 12)], [0, 0, 1, 32, 33, 6 + 48]);
  assert.deepEqual(icoImages(ico).map((i) => [i.size, i.png.length]), [[16, 33], [32, 33], [256, 33]]);
  // An image whose PNG is not the size its entry says, or that is no PNG, is refused.
  assert.throws(() => icoImages(icoOf([{ size: 32, png: png(16) }])), /not 32 pixels square/);
  assert.throws(() => icoImages(icoOf([{ size: 16, png: Buffer.alloc(33) }])), /not a PNG/);
  assert.throws(() => icoImages(Buffer.from("GIF89a")), /not an ICO/);
});
