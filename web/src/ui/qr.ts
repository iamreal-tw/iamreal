// The QR code of the last screen (design/copy/hang.md, part 1): a text, the
// address of /hang/<short ID>, as a QR code (ISO/IEC 18004), drawn as an
// SVG. Byte mode (the text as UTF-8), error correction level M, the
// smallest of versions 1 to 10 that holds it, the mask with the lowest
// penalty. Not a package: the steps (Reed-Solomon, the function patterns,
// the placement, the penalty rules) follow Project Nayuki's QR Code generator
// library, cut down to what this page needs; test/qr.test.ts holds it to
// that library's codes, module for module.
//
// The code holds the text it is given and nothing else; nothing is sent.
//
// QR Code generator library: Copyright (c) Project Nayuki. (MIT License)
// https://www.nayuki.io/page/qr-code-generator-library
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions:
// - The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
// - The Software is provided "as is", without warranty of any kind, express or
//   implied, including but not limited to the warranties of merchantability,
//   fitness for a particular purpose and noninfringement. In no event shall the
//   authors or copyright holders be liable for any claim, damages or other
//   liability, whether in an action of contract, tort or otherwise, arising from,
//   out of or in connection with the Software or the use or other dealings in the
//   Software.

/** Level M, versions 1 to 10: the error correction codewords per block, and the data codewords of each block. */
const BLOCKS: readonly (readonly [number, readonly number[]])[] = [
  [10, [16]],
  [16, [28]],
  [26, [44]],
  [18, [32, 32]],
  [24, [43, 43]],
  [16, [27, 27, 27, 27]],
  [18, [31, 31, 31, 31]],
  [22, [38, 38, 39, 39]],
  [22, [36, 36, 36, 37, 37]],
  [26, [43, 43, 43, 43, 44]],
];
/** The centres of the alignment patterns, versions 1 to 10. */
const ALIGNMENT: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
/** Level M's two bits in the format information. */
const LEVEL_M = 0b00;

/** The bits of the length of a byte-mode text: 8 up to version 9, 16 from version 10. */
const lengthBits = (version: number): number => (version < 10 ? 8 : 16);

export interface QrCode {
  version: number;
  mask: number;
  /** modules[row][column]; true is dark. No quiet zone. */
  modules: boolean[][];
}

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] = result[i]! ^ gfMultiply(coef, factor)));
  }
  return result;
}

/** The codewords, data and error correction, interleaved as they are placed. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const [ecLength, blocks] = BLOCKS[version - 1]!;
  const capacity = blocks.reduce((a, b) => a + b, 0);
  const bits: number[] = [];
  const put = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, lengthBits(version));
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length)); // the terminator
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  const divisor = reedSolomonDivisor(ecLength);
  const dataBlocks: number[][] = [];
  let at = 0;
  for (const length of blocks) {
    dataBlocks.push(data.slice(at, at + length));
    at += length;
  }
  const ecBlocks = dataBlocks.map((b) => reedSolomonRemainder(b, divisor));
  const out: number[] = [];
  for (let i = 0; i < Math.max(...blocks); i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ecLength; i++) for (const b of ecBlocks) out.push(b[i]!);
  return out;
}

const MASKS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  functionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [size - 4, 3],
      [3, size - 4],
    ] as const) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) this.setFunction(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    const centres = ALIGNMENT[this.version - 1]!;
    const last = centres.length - 1;
    centres.forEach((cx, i) =>
      centres.forEach((cy, j) => {
        // Not where a finder pattern is.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }),
    );
    this.formatBits(0); // reserved now, written with the mask chosen
    if (this.version >= 7) {
      let rem = this.version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (this.version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.setFunction(a, b, dark);
        this.setFunction(b, a, dark);
      }
    }
  }

  formatBits(mask: number): void {
    const { size } = this;
    const data = (LEVEL_M << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    this.setFunction(8, size - 8, true); // the dark module
  }

  /** The codewords in the zigzag of two columns, from the bottom right, skipping the vertical timing pattern. */
  place(words: readonly number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < words.length * 8) {
            this.modules[y]![x] = ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
            i++;
          }
          // The remainder bits stay light.
        }
      }
    }
  }

  applyMask(mask: number): void {
    const f = MASKS[mask]!;
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.isFunction[y]![x] && f(x, y)) this.modules[y]![x] = !this.modules[y]![x];
  }

  /** The penalty of the four rules of ISO/IEC 18004, section 7.8.3. */
  penalty(): number {
    const { size, modules } = this;
    let result = 0;
    const lines = (get: (a: number, b: number) => boolean): void => {
      for (let a = 0; a < size; a++) {
        let runDark = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          if (get(a, b) === runDark) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            this.addHistory(run, history);
            if (!runDark) result += this.finderLike(history) * 40;
            runDark = get(a, b);
            run = 1;
          }
        }
        if (runDark) {
          this.addHistory(run, history);
          run = 0;
        }
        this.addHistory(run + size, history);
        result += this.finderLike(history) * 40;
      }
    };
    lines((y, x) => modules[y]![x]!);
    lines((x, y) => modules[y]![x]!);
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) result += 3;
      }
    }
    const dark = modules.reduce((a, row) => a + row.filter(Boolean).length, 0);
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }

  private addHistory(run: number, history: number[]): void {
    // The light border before the first run.
    if (history[0] === 0) run += this.size;
    history.pop();
    history.unshift(run);
  }

  /** How many 1:1:3:1:1 patterns with 4 light modules on a side end at the newest run. */
  private finderLike(h: readonly number[]): number {
    const n = h[1]!;
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0]! >= n * 4 && h[6]! >= n ? 1 : 0) + (core && h[6]! >= n * 4 && h[0]! >= n ? 1 : 0);
  }
}

/** `text` as a QR code; `mask` only to choose one (the tests), otherwise the one with the lowest penalty. */
export function qrCode(text: string, mask?: number): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = BLOCKS.findIndex(([, blocks], i) => {
    const capacityBits = blocks.reduce((a, b) => a + b, 0) * 8;
    return 4 + lengthBits(i + 1) + bytes.length * 8 <= capacityBits;
  }) + 1;
  if (version === 0) throw new Error(`a text of ${bytes.length} bytes is too long for a QR code of version 10 at level M`);
  const words = codewords(bytes, version);
  const make = (m: number): Grid => {
    const g = new Grid(version);
    g.functionPatterns();
    g.place(words);
    g.applyMask(m);
    g.formatBits(m);
    return g;
  };
  let chosen = mask ?? 0;
  let grid = make(chosen);
  if (mask === undefined) {
    let best = grid.penalty();
    for (let m = 1; m < 8; m++) {
      const g = make(m);
      const p = g.penalty();
      if (p < best) [best, grid, chosen] = [p, g, m];
    }
  }
  return { version, mask: chosen, modules: grid.modules };
}

const SVG = "http://www.w3.org/2000/svg";

/** The code as an SVG, with a quiet zone of 4 modules: one path of the dark modules, one unit each. */
export function qrSvg(text: string): SVGSVGElement {
  const { modules } = qrCode(text);
  const quiet = 4;
  const side = modules.length + quiet * 2;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${side} ${side}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  const light = document.createElementNS(SVG, "rect");
  light.setAttribute("width", String(side));
  light.setAttribute("height", String(side));
  light.setAttribute("class", "qr-light");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("class", "qr-dark");
  path.setAttribute("d", modules.flatMap((row, y) => row.flatMap((dark, x) => (dark ? [`M${x + quiet} ${y + quiet}h1v1h-1z`] : []))).join(""));
  svg.append(light, path);
  return svg;
}
