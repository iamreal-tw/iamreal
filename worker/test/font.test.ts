// The subset of the headings' typeface (design/fonts/README.md): that it has
// every character of design/copy/ and of printable ASCII, that it carries its
// licence, and that the visitors' pages are sent the same file. Read with
// Node's own Brotli: no package.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { brotliDecompressSync } from "node:zlib";
import { FONT_FILE } from "../scripts/site-files.ts";
import { WORKER_DIR } from "./build.ts";

const DESIGN_DIR = join(WORKER_DIR, "..", "design");
/** The subset as design/fonts/ has it, the one copy that is reviewed. */
const ORIGINAL = join(DESIGN_DIR, "fonts", "GenRyuMin2TW-B.woff2");

/**
 * Characters of design/copy/ that GenRyuMin2 TW itself does not have, so its
 * subset cannot: a page shows them in the system's typeface. Each with where
 * it is written.
 */
const NOT_IN_TYPEFACE: Readonly<Record<string, string>> = {
  "▸": "card-proof.md, the mark before the two questions of step 1",
};

/** The tables of a WOFF2 file, uncompressed, by tag (https://www.w3.org/TR/WOFF2/). Only tables that are stored as they are can be read. */
function woff2Tables(file: Buffer): Map<string, Buffer> {
  assert.equal(file.toString("latin1", 0, 4), "wOF2", "a WOFF2 file");
  const numTables = file.readUInt16BE(12);
  const compressedLength = file.readUInt32BE(20);
  const KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill"];
  let at = 48;
  const base128 = (): number => {
    let n = 0;
    for (let i = 0; i < 5; i++) {
      const b = file[at++]!;
      n = n * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return n;
    }
    throw new Error("a UIntBase128 of more than 5 bytes");
  };
  const entries: { tag: string; length: number; stored: boolean }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file[at++]!;
    let tag: string;
    if ((flags & 0x3f) === 0x3f) {
      tag = file.toString("latin1", at, at + 4);
      at += 4;
    } else tag = KNOWN[flags & 0x3f]!;
    const version = flags >> 6;
    const origLength = base128();
    // glyf and loca are transformed unless the version is 3; any other table is transformed unless it is 0.
    const transformed = tag === "glyf" || tag === "loca" ? version !== 3 : version !== 0;
    const length = transformed ? base128() : origLength;
    entries.push({ tag, length, stored: !transformed });
  }
  const data = brotliDecompressSync(file.subarray(at, at + compressedLength));
  const tables = new Map<string, Buffer>();
  let offset = 0;
  for (const e of entries) {
    if (e.stored) tables.set(e.tag, data.subarray(offset, offset + e.length));
    offset += e.length;
  }
  assert.equal(offset, data.length, "the tables fill the compressed stream");
  return tables;
}

/** Every code point a cmap table maps to a glyph, from its Unicode subtables of formats 4 and 12. */
function codePoints(cmap: Buffer): Set<number> {
  const out = new Set<number>();
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const t = cmap.subarray(cmap.readUInt32BE(8 + i * 8));
    const format = t.readUInt16BE(0);
    if (format === 4) {
      const segs = t.readUInt16BE(6) / 2;
      const ends = 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const ranges = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = t.readUInt16BE(ends + s * 2);
        const start = t.readUInt16BE(starts + s * 2);
        const delta = t.readUInt16BE(deltas + s * 2);
        const rangeOffset = t.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number;
          if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
          else {
            const g = t.readUInt16BE(ranges + s * 2 + rangeOffset + (c - start) * 2);
            glyph = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (glyph !== 0) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = t.readUInt32BE(12);
      for (let g = 0; g < groups; g++) {
        const start = t.readUInt32BE(16 + g * 12);
        const end = t.readUInt32BE(20 + g * 12);
        const glyph = t.readUInt32BE(24 + g * 12);
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c);
      }
    }
  }
  return out;
}

/** The IDs of the name table's records for Windows, Unicode, US English. */
function nameIds(name: Buffer): Set<number> {
  const out = new Set<number>();
  const count = name.readUInt16BE(2);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (name.readUInt16BE(r) === 3 && name.readUInt16BE(r + 2) === 1 && name.readUInt16BE(r + 4) === 0x409) out.add(name.readUInt16BE(r + 6));
  }
  return out;
}

const tables = woff2Tables(readFileSync(ORIGINAL));

test("the subset has every character of design/copy/ and the printable ASCII", () => {
  const have = codePoints(tables.get("cmap")!);
  const files = readdirSync(join(DESIGN_DIR, "copy")).sort();
  assert.ok(files.includes("home.md") && files.includes("card-proof.json"), "the check read design/copy/");
  const missing = new Map<string, string[]>();
  const want = new Set<string>();
  for (let c = 0x20; c <= 0x7e; c++) want.add(String.fromCodePoint(c));
  for (const file of files) {
    for (const ch of readFileSync(join(DESIGN_DIR, "copy", file), "utf8")) {
      if (/\p{Cc}/u.test(ch)) continue;
      want.add(ch);
      if (!have.has(ch.codePointAt(0)!) && !(ch in NOT_IN_TYPEFACE)) missing.set(ch, [...new Set([...(missing.get(ch) ?? []), file])]);
    }
  }
  for (const ch of want) if (!have.has(ch.codePointAt(0)!) && !(ch in NOT_IN_TYPEFACE) && !missing.has(ch)) missing.set(ch, ["printable ASCII"]);
  assert.deepEqual(Object.fromEntries(missing), {}, "characters not in the subset, by where they are written: run design/fonts/subset.sh (design/fonts/README.md)");
  for (const ch of Object.keys(NOT_IN_TYPEFACE)) {
    assert.ok(want.has(ch), `${ch} is still written in design/copy/: take it off NOT_IN_TYPEFACE`);
    assert.ok(!have.has(ch.codePointAt(0)!), `the subset has ${ch} now: take it off NOT_IN_TYPEFACE`);
  }
});

test("the subset carries the licence: records 13 and 14 of its name table", () => {
  const ids = nameIds(tables.get("name")!);
  assert.ok(ids.has(13), "the licence");
  assert.ok(ids.has(14), "the licence's URL");
  assert.ok(ids.has(1), "the check read the name table");
});

test("the visitors' pages are sent the subset of design/fonts/, byte for byte", () => {
  assert.equal(FONT_FILE, "fonts/GenRyuMin2TW-B.woff2");
  assert.ok(readFileSync(join(WORKER_DIR, "site", FONT_FILE)).equals(readFileSync(ORIGINAL)));
});
