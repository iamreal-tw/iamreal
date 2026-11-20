// The one Barretenberg instance of this isolate, shared by the proof
// verifier (src/verify.ts) and the Poseidon2 hash (src/poseidon2.ts). The
// module is imported already compiled; scripts/engine-files.ts puts the
// file there and checks its SHA-256 at every build.
import wasm from "../generated/barretenberg.wasm";
import { type Answer, Barretenberg } from "./barretenberg.ts";

let instance: Barretenberg | undefined;

/**
 * Thrown when a command could not be answered by a working instance: the
 * module threw, or it would not start.
 */
export class EngineError extends Error {
  /** True if the module could not be instantiated at all, which no input causes. */
  readonly notStarted: boolean;

  constructor(cause: unknown, notStarted: boolean) {
    super(notStarted ? "Barretenberg did not start" : "Barretenberg threw", { cause });
    this.notStarted = notStarted;
  }
}

/**
 * Sends one command to Barretenberg, starting an instance if there is
 * none. If the module throws, the instance is dropped, so the next command
 * starts a fresh one (about 2 ms), and an EngineError is thrown.
 */
export function callEngine(command: string, fields: Record<string, unknown>): Answer {
  if (instance === undefined) {
    try {
      instance = new Barretenberg(wasm);
    } catch (e) {
      throw new EngineError(e, true);
    }
  }
  try {
    return instance.call(command, fields);
  } catch (e) {
    instance = undefined;
    throw new EngineError(e, false);
  }
}

/** Drops the instance: the next command starts a fresh one. */
export function dropEngine(): void {
  instance = undefined;
}
