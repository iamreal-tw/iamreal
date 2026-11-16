// bb.js in Node for tests: one BarretenbergSync on WebAssembly (not the
// native binary), the same code the page's workers run.
import { BackendType, BarretenbergSync } from "@aztec-foundation/bb.js";
import { inlineRunner } from "../src/crl/build.ts";
import { bytesHasher, syncHash } from "../src/crl/hasher.ts";

let bb: Promise<BarretenbergSync> | null = null;
export const syncBb = (): Promise<BarretenbergSync> => (bb ??= BarretenbergSync.new({ backend: BackendType.Wasm, threads: 1 }));

export async function poseidon() {
  const b = await syncBb();
  return {
    hash2: (x: bigint, y: bigint) => syncHash(b, x, y),
    hash3: (x: bigint, y: bigint, z: bigint) => syncHash(b, x, y, z),
    hasher: bytesHasher(b),
    runner: () => inlineRunner(bytesHasher(b), (x, y) => syncHash(b, x, y)),
  };
}
