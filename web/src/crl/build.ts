// Building the tree and the cardholder's proof of absence, in parts that
// run side by side (tree-worker.ts in the page, or inline in tests). Only
// the CRL's keys and the cardholder's own serial number go in; the serial
// number never leaves the device.
import { keyAt, wordsOfKey } from "./crl.ts";
import { type PartResult, type TreeHasher, type TreeResult, buildPart, combine, partition } from "./tree.ts";

/** Runs `buildPart` on some groups somewhere (a worker, or here). */
export interface PartRunner {
  build(groups: { keys: Uint32Array; count: number; target: Uint32Array | null }[], depth: number): Promise<PartResult[]>;
  hash2(a: bigint, b: bigint): Promise<bigint>;
}

export interface TreeBuilder {
  /** Builds the tree of `count` keys and the path of `serial`. */
  build(keys: Uint32Array, count: number, serial: bigint): Promise<TreeResult>;
  /** Ends the workers. */
  close(): void;
}

/** Splits the keys into 2^D groups over `runners.length` runners (D = log2 of it), then joins the parts. */
export async function buildWith(runners: PartRunner[], keys: Uint32Array, count: number, serial: bigint): Promise<TreeResult> {
  const D = Math.log2(runners.length);
  if (!Number.isInteger(D)) throw new Error("runners must be a power of two");
  const target = wordsOfKey(serial);
  const groups = partition(keys, count, D);
  const tg = Number(serial & BigInt((1 << D) - 1));
  const counts = groups.map((g) => g.count);
  const singles = groups.map((g) => (g.count === 1 ? keyAt(g.keys, 0) : null));
  const parts: PartResult[] = await Promise.all(
    groups.map(async (g, i) => {
      const [r] = await runners[i]!.build([{ keys: g.keys, count: g.count, target: i === tg ? target : null }], D);
      return r!;
    }),
  );
  return combine(D, counts, parts, singles, serial, (a, b) => runners[0]!.hash2(a, b));
}

/** A runner that builds in this thread. */
export function inlineRunner(hasher: TreeHasher<unknown>, hash2: (a: bigint, b: bigint) => bigint): PartRunner {
  return {
    build: async (groups, depth) => groups.map((g) => buildPart(g.keys, g.count, hasher, g.target, depth)),
    hash2: async (a, b) => hash2(a, b),
  };
}
