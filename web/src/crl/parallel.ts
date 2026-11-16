// The page's tree builder: up to 4 workers, each with its own bb.js
// (ADR-0015). Browser only.
import { type PartRunner, type TreeBuilder, buildWith } from "./build.ts";
import type { TreeWorkerReply, TreeWorkerRequest } from "./tree-worker.ts";

export const MAX_TREE_WORKERS = 4;

/** 1, 2 or 4: a power of two, at most 4, at most the number of cores. */
export function treeWorkerCount(cores: number): number {
  if (cores >= 4) return 4;
  if (cores >= 2) return 2;
  return 1;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

async function startWorker(wasmPath: string): Promise<PartRunner & { terminate(): void }> {
  const worker = new Worker(new URL("./tree-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let next = 0;
  worker.onmessage = ({ data }: MessageEvent<TreeWorkerReply>) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (!p) return;
    if ("error" in data) p.reject(new Error(data.error));
    else p.resolve(data.reply);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`tree worker: ${e.message}`));
    pending.clear();
  };
  const call = <T>(msg: Omit<TreeWorkerRequest, "id">, transfer: Transferable[] = []): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ id, ...msg }, transfer);
    });
  await call({ init: { wasmPath } } as Omit<TreeWorkerRequest, "id">);
  return {
    build: (groups, depth) =>
      call({ build: { groups, depth } } as Omit<TreeWorkerRequest, "id">, groups.map((g) => g.keys.buffer as ArrayBuffer)),
    hash2: (a, b) => call({ hash2: [a, b] } as Omit<TreeWorkerRequest, "id">),
    terminate: () => worker.terminate(),
  };
}

/** Starts `count` tree workers (1, 2 or 4). Their bb.js loads while the caller does other things. */
export async function startTreeBuilder(count: number, wasmPath: string): Promise<TreeBuilder> {
  const runners = await Promise.all(Array.from({ length: count }, () => startWorker(wasmPath)));
  return {
    build: (keys, n, serial) => buildWith(runners, keys, n, serial),
    close: () => runners.forEach((r) => r.terminate()),
  };
}
