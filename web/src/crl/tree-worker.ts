// One tree worker: its own single-threaded Barretenberg (bb.js), building the
// groups it is sent (build.ts). It needs no cross-origin isolation. It
// receives CRL keys and, in one of the workers, the cardholder's serial
// number; it sends back only node hashes and where the path ends.
import { BackendType, BarretenbergSync } from "@aztec-foundation/bb.js";
import { bytesHasher, syncHash } from "./hasher.ts";
import { type PartResult, buildPart } from "./tree.ts";

export type TreeWorkerRequest =
  | { id: number; init: { wasmPath: string } }
  | { id: number; build: { groups: { keys: Uint32Array; count: number; target: Uint32Array | null }[]; depth: number } }
  | { id: number; hash2: [bigint, bigint] };

export type TreeWorkerReply = { id: number; reply: "ready" | PartResult[] | bigint } | { id: number; error: string };

let bb: BarretenbergSync | null = null;

const scope = self as unknown as { onmessage: ((e: MessageEvent<TreeWorkerRequest>) => void) | null; postMessage(m: TreeWorkerReply): void };

scope.onmessage = async ({ data }) => {
  try {
    if ("init" in data) {
      bb = await BarretenbergSync.new({ backend: BackendType.Wasm, threads: 1, wasmPath: data.init.wasmPath });
      scope.postMessage({ id: data.id, reply: "ready" });
    } else if ("build" in data) {
      const hasher = bytesHasher(bb!);
      const { groups, depth } = data.build;
      scope.postMessage({ id: data.id, reply: groups.map((g) => buildPart(g.keys, g.count, hasher, g.target, depth)) });
    } else {
      scope.postMessage({ id: data.id, reply: syncHash(bb!, data.hash2[0], data.hash2[1]) });
    }
  } catch (e) {
    scope.postMessage({ id: data.id, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
  }
};
