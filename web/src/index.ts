// The page's entry point to the card proof engine. Everything a server could
// otherwise influence is fixed here: the issuer keys and the component's
// address (target.ts), the scope table's roster, the fetch (same origin
// only), the clock, the one storage key.
// The screen (src/ui/) calls startEngine() once when the page opens, then
// createCardProof() with that engine for each card proof (ADR-0013).
import { sameOriginFetch } from "./api.ts";
import type { Card } from "./card/card.ts";
import { startTreeBuilder, treeWorkerCount } from "./crl/parallel.ts";
import { CardProofFlow, type FlowDeps } from "./flow.ts";
import { proofEngine } from "./prover/engine.ts";
import type { Prover } from "./prover/prover.ts";
import type { Action } from "./spec/declaration-code.ts";
import type { Platform, Roster } from "./spec/scope.ts";
import { localStorageStore } from "./storage.ts";
import { ISSUERS } from "./target.ts";

/**
 * Which scope table the page uses. This stage runs the test scope string
 * (`iamreal-test:threads:0`); the production one waits for ADR-0007 to be
 * accepted.
 */
export const ROSTER: Roster = "test";

/** Where the build puts bb.js's WebAssembly (vite.config.ts). */
export const BB_WASM_PATH = "/bb/barretenberg.wasm.gz";

const wasmUrl = (): string => new URL(BB_WASM_PATH, location.origin).href;

/** Starts the page's one proof engine (bb.js, CRS, Noir). Call it once, when the page opens. */
export function startEngine(onTiming?: (step: string, ms: number) => void): Prover {
  return proofEngine({ fetch: sameOriginFetch, wasmPath: wasmUrl(), onTiming });
}

export function createCardProof(opts: {
  action: Action;
  platform: Platform;
  username?: string;
  card: Card;
  /** The page's one engine, from startEngine(). */
  prover: Prover;
  onBackgroundStop?: FlowDeps["onBackgroundStop"];
  onTiming?: FlowDeps["onTiming"];
}): CardProofFlow {
  return new CardProofFlow(
    {
      roster: ROSTER,
      issuers: ISSUERS,
      fetch: sameOriginFetch,
      clock: () => Date.now(),
      store: localStorageStore(),
      card: opts.card,
      prover: opts.prover,
      startTreeBuilder: () => startTreeBuilder(treeWorkerCount(navigator.hardwareConcurrency ?? 1), wasmUrl()),
      onBackgroundStop: opts.onBackgroundStop,
      onTiming: opts.onTiming,
    },
    { action: opts.action, platform: opts.platform, username: opts.username },
  );
}

export { CardProofFlow, FlowStop, type Stop, type CardRead, type CardStatus, type Done, type Phase } from "./flow.ts";
export { CardError, type Card, type CardErrorCode } from "./card/card.ts";
export { normalizeUsername } from "./spec/scope.ts";
export type { Prover, ThreadMode } from "./prover/prover.ts";
