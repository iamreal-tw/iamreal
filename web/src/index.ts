// The page's entry point to the card proof engine. Everything a server could
// otherwise influence is fixed here: the proof log whose scope string the card
// signs, the issuer keys, the component's address and the data domain
// (target.ts), the fetch (same origin only; the CRL archive from the data
// domain), the clock, the one storage key.
// The screen (src/ui/) calls startEngine() once when the page opens, then
// createCardProof() with that engine for each card proof (ADR-0013).
import { type Config, dataOriginFetch, requestConfig, sameOriginFetch } from "./api.ts";
import { BASE } from "./base.ts";
import type { Card } from "./card/card.ts";
import { startTreeBuilder, treeWorkerCount } from "./crl/parallel.ts";
import { CardProofFlow, type FlowDeps, tooMany as tooManyOf } from "./flow.ts";
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
  /** What `config` answered when the card proof started (askToStart). */
  startConfig?: Config | null;
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
    startConfig: opts.startConfig ?? null,
  });
}

/**
 * The cardholder pressed the button that starts a card proof: `config` asked
 * with the mark of a start (`?start`, docs/api/card-proof.md), the one
 * request counted against the site-wide limit (ADR-0026). `busy` when the
 * server turned it away as too many (429, or 503 `busy`): the screen says so
 * before a card is read. `paused` when card proofs are stopped. The config
 * otherwise, for the card proof to fall back on (createCardProof's
 * startConfig); null when there was no answer or none that could be read:
 * the card proof goes on, and the reading asks again.
 */
export async function askToStart(): Promise<"busy" | "paused" | Config | null> {
  try {
    const config = await requestConfig(sameOriginFetch, { start: true });
    return config.paused ? "paused" : config;
  } catch (e) {
    return tooManyOf(e) ? "busy" : null;
  }
}

/**
 * Whether the operator stopped taking card proofs (`config`'s `paused`), for
 * step 1 to say so before a card is read. Null when the server did not
 * answer or its answer was not read: step 1 then goes on, and step 2 asks
 * again (CardProofFlow.readCard).
 */
export async function cardProofsPaused(): Promise<boolean | null> {
  try {
    return (await requestConfig(sameOriginFetch)).paused;
  } catch {
    return null;
  }
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
  tooMany,
} from "./flow.ts";
export type { AcceptedKind, Config, PlatformRow } from "./api.ts";
export type { Account } from "iamreal-protocol/declaration-code.ts";
export { CardError, type Card, type CardErrorCode } from "./card/card.ts";
export { KNOWN_PLATFORMS, SITE_DOMAIN, cardPath, handle, presentationOf } from "./platforms.ts";
export type { Prover, ThreadMode } from "./prover/prover.ts";
