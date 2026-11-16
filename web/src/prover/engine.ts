// The page's proof engine: one Barretenberg (bb.js) per page load, started
// as soon as the page opens, reused for every retry (ADR-0013). Browser only.
//
// - bb.js's WebAssembly comes from the page's own origin (`wasmPath`, built
//   by vite.config.ts), not from a data: URL or a CDN.
// - The CRS is fetched from the page's own origin and checked against the
//   SHA-256 in artifacts.ts before it is handed to bb.js; bb.js's own CRS
//   download (Aztec's CDN, cached in IndexedDB) is never used.
// - Proofs are always made with VERIFIER_TARGET; no caller and no server
//   chooses the settings.
import { BackendType, Barretenberg, UltraHonkBackend } from "@aztec-foundation/bb.js";
import { Noir, acvm, abi } from "@noir-lang/noir_js";
import type { Fetch } from "../api.ts";
import { bigintOfBytes, bytesOfBigint } from "../bytes.ts";
import type { CircuitName } from "../issuers.ts";
import { CRS, CRS_POINTS, type CompiledCircuit, fetchChecked, loadCircuit } from "./artifacts.ts";
import { PROOF_BYTES, type ProofResult, type Prover, type ThreadMode, VERIFIER_TARGET } from "./prover.ts";

/**
 * The most threads a proof uses when the page is cross-origin isolated. On a
 * 10-core M1 Max in Chrome (README.md, "Times"), a card_proof_rs4096 proof
 * took 3.4 to 3.8 s with 4 threads, 2.4 to 2.9 s with 8 and 2.7 to 3.2 s
 * with 10: more than 8 bought nothing, and 8 leaves cores to the page.
 */
export const MAX_PROOF_THREADS = 8;

export function threadMode(maxThreads: number = MAX_PROOF_THREADS): Omit<ThreadMode, "reportedThreads"> {
  const g = globalThis as { crossOriginIsolated?: boolean; SharedArrayBuffer?: unknown; navigator?: { hardwareConcurrency?: number } };
  const multithreaded = g.crossOriginIsolated === true && typeof g.SharedArrayBuffer !== "undefined";
  const cores = g.navigator?.hardwareConcurrency ?? 1;
  return { multithreaded, threads: multithreaded ? Math.max(1, Math.min(maxThreads, cores)) : 1 };
}

export interface EngineOptions {
  fetch: Fetch;
  /** Absolute URL of bb.js's single-threaded WebAssembly; the threaded one is next to it. */
  wasmPath: string;
  /** For measurements only; the page uses MAX_PROOF_THREADS. */
  maxThreads?: number;
  /** Times of each step, for the caller's progress display and measurements. */
  onTiming?: (step: string, ms: number) => void;
}

let noirReady: Promise<void> | null = null;
function initNoir(): Promise<void> {
  // The web builds of acvm_js and noirc_abi load their WebAssembly next to
  // their module (a file of this page's build).
  const init = (m: unknown): Promise<unknown> => {
    const f = (m as { default?: () => Promise<unknown> }).default;
    return typeof f === "function" ? f() : Promise.resolve();
  };
  noirReady ??= Promise.all([init(acvm), init(abi)]).then(() => undefined);
  return noirReady;
}

class Engine implements Prover {
  private readonly opts: EngineOptions;
  private readonly started: Promise<{ api: Barretenberg; mode: ThreadMode }>;
  private readonly circuits = new Map<CircuitName, Promise<CompiledCircuit>>();

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.started = this.start();
    // Nobody may be waiting yet; the error is reported to whoever calls ready().
    this.started.catch(() => undefined);
  }

  private time<T>(step: string, p: Promise<T>): Promise<T> {
    const t = performance.now();
    return p.then((v) => {
      this.opts.onTiming?.(step, performance.now() - t);
      return v;
    });
  }

  private async start(): Promise<{ api: Barretenberg; mode: ThreadMode }> {
    const t0 = performance.now();
    const base = threadMode(this.opts.maxThreads);
    let reportedThreads: number | null = null;
    const logger = (msg: string): void => {
      const m = /threads: (\d+); shared memory: (true|false)/.exec(String(msg));
      if (m) reportedThreads = Number(m[1]);
    };
    const [api, g1, g2] = await Promise.all([
      this.time(
        "bb_backend",
        Barretenberg.new({ backend: BackendType.WasmWorker, threads: base.threads, wasmPath: this.opts.wasmPath, skipSrsInit: true, logger }),
      ),
      this.time("crs_g1_fetch", fetchChecked(this.opts.fetch, CRS.g1.path, CRS.g1.sha256)),
      this.time("crs_g2_fetch", fetchChecked(this.opts.fetch, CRS.g2.path, CRS.g2.sha256)),
      this.time("noir_init", initNoir()),
    ]);
    // Hand bb.js the checked bytes. It returns the decompressed points so a
    // caller could cache them; the page does not keep them anywhere.
    await this.time("crs_init", api.srsInitSrs({ pointsBuf: g1, numPoints: CRS_POINTS, g2Point: g2 }));
    this.opts.onTiming?.("engine_total", performance.now() - t0);
    return { api, mode: { ...base, reportedThreads } };
  }

  async ready(): Promise<ThreadMode> {
    return (await this.started).mode;
  }

  async hash2(a: bigint, b: bigint): Promise<bigint> {
    const { api } = await this.started;
    const { hash } = await api.poseidon2Hash({ inputs: [bytesOfBigint(a, 32), bytesOfBigint(b, 32)] });
    return bigintOfBytes(hash);
  }

  private circuit(name: CircuitName): Promise<CompiledCircuit> {
    let c = this.circuits.get(name);
    if (!c) {
      c = this.time(`circuit_${name}`, loadCircuit(this.opts.fetch, name));
      this.circuits.set(name, c);
      // A failed load is not cached: a retry fetches again (and checks again).
      c.catch(() => this.circuits.delete(name));
    }
    return c;
  }

  async preloadCircuit(name: CircuitName): Promise<void> {
    await this.circuit(name);
  }

  async prove(name: CircuitName, inputs: Record<string, unknown>): Promise<ProofResult> {
    const [{ api }, circuit] = await Promise.all([this.started, this.circuit(name)]);
    const noir = new Noir(circuit as ConstructorParameters<typeof Noir>[0]);
    const { witness } = await this.time("witness", noir.execute(inputs as Parameters<typeof noir.execute>[0]));
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const proof = await this.time("prove", backend.generateProof(witness, { verifierTarget: VERIFIER_TARGET }));
    if (proof.proof.length !== PROOF_BYTES) throw new Error(`proof of ${proof.proof.length} bytes, not ${PROOF_BYTES}`);
    return { proof: proof.proof, publicInputs: proof.publicInputs.map((h) => BigInt(h)) };
  }
}

let pageEngine: Engine | null = null;

/**
 * The page's one engine. The first call starts it; later calls return the
 * same engine whatever their options (ADR-0013: retries reuse it).
 */
export function proofEngine(opts: EngineOptions): Prover {
  pageEngine ??= new Engine(opts);
  return pageEngine;
}
