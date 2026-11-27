// Writes site/favicon.ico again: the site's icon, the mark the pages' header
// draws (src/pages/layout.ts, LOGO) in the colours of design/tokens.json,
// at 16, 32 and 48 pixels (#356). Every page links to it, and it is at
// /favicon.ico, where a browser or a link preview asks for an icon by itself
// (README.md, "Static Assets"). The apps' icon is the same mark on white (#490).
//
// Run it by hand after the mark changes:
//
//   node --experimental-strip-types scripts/favicon.ts
//
// It draws each size with the Chrome on this computer (headless, the one
// web/test/e2e/ uses; CHROME names another), from an SVG of the mark at that
// size, on a transparent ground, and packs the three PNGs into one ICO file
// (the ICO format allows PNG images since Windows Vista; every browser reads
// them). No package. Nothing of a deploy or a build runs it: the icon is the
// committed file, which a deploy build checks is the one of HEAD
// (deploy-build-checks.ts, `checkSiteFiles`). Another Chrome may draw the
// edges a pixel differently, so a run writes a file only when asked.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGO } from "../src/pages/layout.ts";
import { FAVICON_FILE } from "./site-files.ts";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The sizes the icon holds, in pixels: a browser's tab and bookmarks, and a link preview's small icon. */
export const FAVICON_SIZES: readonly number[] = [16, 32, 48];

/** The three colours of the mark (design/tokens.json): the card, the chip and the island's outline, the island. */
function markColours(): { you: string; bg: string; ink: string } {
  const tokens = JSON.parse(readFileSync(join(WORKER, "..", "design", "tokens.json"), "utf8")) as Record<string, unknown>;
  const colour = (name: string): string => {
    const v = tokens[name];
    if (typeof v !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(v)) throw new Error(`design/tokens.json: ${name} is not a colour`);
    return v;
  };
  return { you: colour("--you"), bg: colour("--bg"), ink: colour("--ink") };
}

/**
 * The mark as a document of its own, `size` pixels square: LOGO, its
 * classes (the style sheet's colours, .logo-* of site/pages.css) written as
 * the colours they stand for.
 */
export function markSvg(size: number): string {
  const c = markColours();
  const svg = String(LOGO)
    .replace(/^<svg class="logo" viewBox="0 0 64 64" aria-hidden="true" focusable="false">/, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">`)
    .replace(' class="logo-card-body"', ` fill="${c.you}"`)
    .replace(' class="logo-chip"', ` fill="${c.bg}"`)
    .replace(' class="logo-island-body"', ` fill="${c.ink}" stroke="${c.bg}"`)
    .replace(/ class="logo-(card|island)"/g, "");
  if (!svg.startsWith("<svg xmlns=") || svg.includes("class=")) throw new Error("LOGO is not the mark this script knows how to colour");
  return svg;
}

/** One image of an ICO file: its size and its PNG. */
export interface IcoImage {
  size: number;
  png: Buffer;
}

/**
 * The ICO file of these PNGs: the directory (reserved 0, type 1, the
 * count), one 16-byte entry per image (width and height, 0 for 256; no
 * palette; 1 plane; 32 bits; the PNG's length and where it starts), then the
 * PNGs one after the other.
 */
export function icoOf(images: readonly IcoImage[]): Buffer {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  for (const [i, img] of images.entries()) {
    const at = 6 + 16 * i;
    head.writeUInt8(img.size === 256 ? 0 : img.size, at);
    head.writeUInt8(img.size === 256 ? 0 : img.size, at + 1);
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(img.png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += img.png.length;
  }
  return Buffer.concat([head, ...images.map((img) => img.png)]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The images of an ICO file, each a square PNG whose IHDR says the size its entry says; throws on anything else. */
export function icoImages(ico: Buffer): IcoImage[] {
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error("not an ICO file");
  const out: IcoImage[] = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const at = 6 + 16 * i;
    const size = ico.readUInt8(at) || 256;
    if ((ico.readUInt8(at + 1) || 256) !== size) throw new Error(`image ${i}: not square`);
    const png = ico.subarray(ico.readUInt32LE(at + 12), ico.readUInt32LE(at + 12) + ico.readUInt32LE(at + 8));
    // The PNG signature, then the IHDR chunk: its width and height (https://www.w3.org/TR/png-3/#11IHDR).
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE) || png.toString("latin1", 12, 16) !== "IHDR") throw new Error(`image ${i}: not a PNG`);
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) throw new Error(`image ${i}: the PNG is not ${size} pixels square`);
    out.push({ size, png: Buffer.from(png) });
  }
  return out;
}

/** The mark drawn by Chrome at `size` pixels, on a transparent ground. */
function draw(chrome: string, dir: string, size: number): Buffer {
  const page = join(dir, `mark-${size}.html`);
  const png = join(dir, `mark-${size}.png`);
  writeFileSync(page, `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${markSvg(size)}`);
  execFileSync(chrome, ["--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--default-background-color=00000000", `--window-size=${size},${size}`, `--screenshot=${png}`, `file://${page}`], { stdio: "ignore" });
  return readFileSync(png);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const dir = mkdtempSync(join(tmpdir(), "favicon-"));
  try {
    const ico = icoOf(FAVICON_SIZES.map((size) => ({ size, png: draw(chrome, dir, size) })));
    icoImages(ico); // each image is the size it says
    writeFileSync(join(WORKER, "site", FAVICON_FILE), ico);
    console.log(`Wrote site/${FAVICON_FILE}: the mark at ${FAVICON_SIZES.join(", ")} pixels, ${ico.length} bytes.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
