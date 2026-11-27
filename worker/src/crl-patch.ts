// CRL patches (spec/revocation-tree.md, "CRL patches"): a file that gives
// a CRL of the archive from the CRL before it of the same issuer key. Only
// two instructions: copy a part of the previous file, and write the bytes
// that follow. `applyPatch` is the spec's; `makePatch` is the mirror's own
// way of finding what the two files share, which the spec leaves open: how
// well it does that changes a patch's size, never what it gives.
import { hexOf } from "iamreal-protocol/bytes.ts";

/** The instructions' first bytes. */
const COPY = 0x00;
const WRITE = 0x01;

/** Why a patch cannot be used; any of them makes the whole patch unusable. */
export class UnusablePatch extends Error {
  override name = "UnusablePatch";
}

const u32 = (bytes: Uint8Array, at: number): number => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

/**
 * The file `patch` gives from `previous`, or `UnusablePatch`. Time and
 * memory are in proportion to the two inputs: the copies go forward through
 * `previous` and never overlap, so what they give is at most `previous`, and
 * what the writes give is in `patch`. The patch is read twice: once to
 * check it and count the bytes it gives, once to give them.
 */
export function applyPatch(previous: Uint8Array, patch: Uint8Array): Uint8Array<ArrayBuffer> {
  let length = 0;
  walk(previous, patch, (_from, _start, n) => {
    length += n;
  });
  const out = new Uint8Array(length);
  let at = 0;
  walk(previous, patch, (from, start, n) => {
    out.set(from.subarray(start, start + n), at);
    at += n;
  });
  return out;
}

/** Goes through the instructions, checking each, and hands `give` the bytes each gives: `n` bytes of `from` at `start`. */
function walk(previous: Uint8Array, patch: Uint8Array, give: (from: Uint8Array, start: number, n: number) => void): void {
  /** Where the last copy ended in `previous`: the next may not start before it. */
  let copied = 0;
  for (let at = 0; at < patch.length; ) {
    const instruction = patch[at]!;
    if (instruction === COPY) {
      if (at + 9 > patch.length) throw new UnusablePatch(`a copy at byte ${at} runs past the end of the patch`);
      const start = u32(patch, at + 1);
      const n = u32(patch, at + 5);
      if (start < copied) throw new UnusablePatch(`a copy at byte ${at} starts at ${start}, before the last copy ended at ${copied}`);
      if (start + n > previous.length) throw new UnusablePatch(`a copy at byte ${at} ends at ${start + n}, past the previous file's ${previous.length} bytes`);
      give(previous, start, n);
      copied = start + n;
      at += 9;
    } else if (instruction === WRITE) {
      if (at + 5 > patch.length) throw new UnusablePatch(`a write at byte ${at} runs past the end of the patch`);
      const n = u32(patch, at + 1);
      if (at + 5 + n > patch.length) throw new UnusablePatch(`a write at byte ${at} of ${n} bytes runs past the end of the patch`);
      give(patch, at + 5, n);
      at += 5 + n;
    } else {
      throw new UnusablePatch(`byte ${at} is ${instruction}, which is no instruction`);
    }
  }
}

/** The name of the patch from the file with SHA-256 `from` to the file with SHA-256 `to`, in the directory of patches. */
export const patchName = (from: string, to: string): string => `${from}-${to}.patch`;

/**
 * The file `patch` gives from `previous`, if it has the SHA-256 `sha256`
 * (the second half of the patch's name); otherwise `UnusablePatch`. What a
 * patch gives counts only with that check.
 */
export async function restore(previous: Uint8Array, patch: Uint8Array, sha256: string): Promise<Uint8Array> {
  const file = applyPatch(previous, patch);
  const got = hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", file)));
  if (got !== sha256) throw new UnusablePatch(`the patch gives a file with SHA-256 ${got}, not ${sha256}`);
  return file;
}

/**
 * How long a run of bytes the two files must share for `makePatch` to see
 * it, and the stride at which it indexes `previous`. A CRL entry of MOICA's
 * is about 40 bytes, its serial number 16 of them, so 32 bytes hold some of
 * a serial number wherever they start.
 */
const BLOCK = 32;
/** The base of the rolling hash; BASE ** BLOCK, mod 2^32, takes a byte out of it. */
const BASE = 0x01000193;
const BASE_TO_BLOCK = (() => {
  let p = 1;
  for (let i = 0; i < BLOCK; i++) p = Math.imul(p, BASE);
  return p;
})();

function hashAt(bytes: Uint8Array, at: number): number {
  let h = 0;
  for (let i = at; i < at + BLOCK; i++) h = (Math.imul(h, BASE) + bytes[i]!) | 0;
  return h;
}

/**
 * A patch that gives `next` from `previous`. It looks up every run of
 * BLOCK bytes of `next` among the runs of `previous` that start at a
 * multiple of BLOCK, grows a run it finds as far as the bytes agree both
 * ways, and copies it; the bytes between are written. Since the copies go
 * forward through `previous`, a run is used only if it is past the last
 * copy. Of runs of `previous` that are the same, the first is kept: in a
 * CRL those are runs of a revocation date and the bytes around it, and the
 * first keeps the copy from jumping ahead.
 */
export function makePatch(previous: Uint8Array, next: Uint8Array): Uint8Array<ArrayBuffer> {
  // An open-addressing table of the runs of `previous`: hash, and where the run starts plus one (0 is empty).
  const blocks = Math.floor(previous.length / BLOCK);
  let size = 1;
  while (size < blocks * 2) size *= 2;
  const mask = size - 1;
  const hashes = new Int32Array(size);
  const starts = new Int32Array(size);
  for (let b = 0; b < blocks; b++) {
    const h = hashAt(previous, b * BLOCK);
    let slot = h & mask;
    while (starts[slot] !== 0 && hashes[slot] !== h) slot = (slot + 1) & mask;
    if (starts[slot] === 0) {
      hashes[slot] = h;
      starts[slot] = b * BLOCK + 1;
    }
  }
  const lookup = (h: number): number => {
    for (let slot = h & mask; starts[slot] !== 0; slot = (slot + 1) & mask) if (hashes[slot] === h) return starts[slot]! - 1;
    return -1;
  };

  const out = new PatchWriter();
  /** Where the last copy ended in `previous`, and where the bytes not yet copied or written start in `next`. */
  let copied = 0;
  let pending = 0;
  let j = 0;
  let h = next.length >= BLOCK ? hashAt(next, 0) : 0;
  while (j + BLOCK <= next.length) {
    let p = lookup(h);
    if (p >= copied && sameRun(previous, p, next, j)) {
      // Grown back over the bytes not yet written, and forward as far as the two agree.
      let start = j;
      while (start > pending && p > copied && previous[p - 1] === next[start - 1]) {
        start--;
        p--;
      }
      let end = j + BLOCK;
      let q = p + (end - start);
      while (end < next.length && q < previous.length && previous[q] === next[end]) {
        end++;
        q++;
      }
      out.write(next.subarray(pending, start));
      out.copy(p, q - p);
      copied = q;
      pending = end;
      j = end;
      if (j + BLOCK <= next.length) h = hashAt(next, j);
      continue;
    }
    if (j + BLOCK < next.length) h = (Math.imul(h, BASE) - Math.imul(next[j]!, BASE_TO_BLOCK) + next[j + BLOCK]!) | 0;
    j++;
  }
  out.write(next.subarray(pending));
  return out.bytes();
}

function sameRun(a: Uint8Array, at: number, b: Uint8Array, bt: number): boolean {
  for (let i = 0; i < BLOCK; i++) if (a[at + i] !== b[bt + i]) return false;
  return true;
}

/** The instructions' bytes, as they are added. */
class PatchWriter {
  #pieces: Uint8Array[] = [];
  #length = 0;

  copy(start: number, n: number): void {
    if (n === 0) return;
    const piece = new Uint8Array(9);
    const view = new DataView(piece.buffer);
    piece[0] = COPY;
    view.setUint32(1, start);
    view.setUint32(5, n);
    this.#add(piece);
  }

  write(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const head = new Uint8Array(5);
    head[0] = WRITE;
    new DataView(head.buffer).setUint32(1, bytes.length);
    this.#add(head);
    this.#add(bytes);
  }

  #add(piece: Uint8Array): void {
    this.#pieces.push(piece);
    this.#length += piece.length;
  }

  bytes(): Uint8Array<ArrayBuffer> {
    const whole = new Uint8Array(this.#length);
    let at = 0;
    for (const piece of this.#pieces) {
      whole.set(piece, at);
      at += piece.length;
    }
    return whole;
  }
}
