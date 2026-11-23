// The page's entry point to the card proof engine. Everything a server could
// otherwise influence is fixed here: the proof log whose scope string the card
// signs, the issuer keys, the component's address and the data domain
// (target.ts), the fetch (same origin only; the CRL archive from the data
// domain), the clock, the one storage key.
// The screen (src/ui/) calls startEngine() once when the page opens, then
// createCardProof() with that engine for each card proof (ADR-0013).
import { dataOriginFetch, sameOriginFetch } from "./api.ts";
import { BASE } from "./base.ts";
import type { Card } from "./card/card.ts";
import { startTreeBuilder, treeWorkerCount } from "./crl/parallel.ts";
import { CardProofFlow, type FlowDeps } from "./flow.ts";
import { proofEngine } from "./prover/engine.ts";
import type { Prover } from "./prover/prover.ts";
import { KNOWN_PLATFORMS } from "./platforms.ts";
import { localStorageStore } from "./storage.ts";
import { DATA_ORIGIN, IDLE_LIMIT_MS, ISSUERS, PROOF_LOG } from "./target.ts";

export { PROOF_LOG };

/** Where the build puts bb.js's WebAssembly (vite.config.ts), under the build's base. */
export const BB_WASM_PATH = `${BASE}bb/barretenberg.wasm.gz`;

const wasmUrl = (): string => new URL(BB_WASM_PATH, location.origin).href;

/** Starts the page's one proof engine (bb.js, CRS, Noir). Call it once, when the page opens. */
export function startEngine(onTiming?: (step: string, ms: number) => void): Prover {
  return proofEngine({ fetch: sameOriginFetch, wasmPath: wasmUrl(), onTiming });
}

export function createCardProof(opts: {
  card: Card;
  /** The page's one engine, from startEngine(). */
  prover: Prover;
  onBackgroundStop?: FlowDeps["onBackgroundStop"];
  onTiming?: FlowDeps["onTiming"];
  onIdle?: FlowDeps["onIdle"];
  onProgress?: FlowDeps["onProgress"];
}): CardProofFlow {
  return new CardProofFlow({
    proofLog: PROOF_LOG,
    issuers: ISSUERS,
    knownPlatforms: KNOWN_PLATFORMS,
    fetch: sameOriginFetch,
    dataFetch: dataOriginFetch(DATA_ORIGIN),
    clock: () => Date.now(),
    store: localStorageStore(),
    card: opts.card,
    prover: opts.prover,
    startTreeBuilder: () => startTreeBuilder(treeWorkerCount(navigator.hardwareConcurrency ?? 1), wasmUrl()),
    onBackgroundStop: opts.onBackgroundStop,
    onTiming: opts.onTiming,
    onIdle: opts.onIdle,
    onProgress: opts.onProgress,
    idleMs: IDLE_LIMIT_MS,
  });
}

export {
  CardProofFlow,
  FlowStop,
  IDLE_MS,
  type Choice,
  type Consequence,
  type ConsequenceRow,
  type Stop,
  type CardRead,
  type CardStatus,
  type SlotStatus,
  type Done,
  type Phase,
  type Progress,
} from "./flow.ts";
export type { AcceptedKind, PlatformRow } from "./api.ts";
export type { Account } from "iamreal-protocol/declaration-code.ts";
export { CardError, type Card, type CardErrorCode } from "./card/card.ts";
export { KNOWN_PLATFORMS, SITE_DOMAIN, cardPath, handle, presentationOf } from "./platforms.ts";
export type { Prover, ThreadMode } from "./prover/prover.ts";
