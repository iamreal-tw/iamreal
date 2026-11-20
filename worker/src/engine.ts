// The keeping of one Barretenberg instance: started when first needed,
// dropped as soon as it throws or answers something unexpected, so that the
// next command gets a fresh one (#16). The proof verifier (src/verify.ts)
// and the Poseidon2 hash (src/poseidon2.ts) share one `Engine`;
// src/in-worker.ts makes it, over the WebAssembly module.

/** What an `Engine` keeps: something that answers commands. `Barretenberg` (src/barretenberg.ts) is the one in the Worker. */
export interface Instance {
  /** Answers one command with a pair, the kind of the answer and its fields, or throws. */
  call(command: string, args: Record<string, unknown>): unknown;
}

/**
 * Thrown when a command got no usable answer: the instance did not start,
 * it threw, or what it answered is not the kind of answer asked for.
 */
export class EngineError extends Error {
  /**
   * True if no instance could be started at all. No input causes that: it
   * is a broken build or a broken runtime, and says nothing about what was
   * being verified or hashed.
   */
  readonly notStarted: boolean;

  constructor(message: string, notStarted: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = "EngineError";
    this.notStarted = notStarted;
  }
}

export class Engine {
  readonly #start: () => Instance;
  #instance: Instance | undefined;

  /** `start` makes a new instance, and throws if it cannot. It is called when a command finds none. */
  constructor(start: () => Instance) {
    this.#start = start;
  }

  /**
   * Sends one command and returns the fields of its answer, which is of
   * the kind `expected`. Otherwise throws an EngineError; unless the
   * instance did not start, the instance is dropped first, and the next
   * command starts another (about 2 ms).
   */
  call(command: string, args: Record<string, unknown>, expected: string): Record<string, unknown> {
    if (this.#instance === undefined) {
      try {
        this.#instance = this.#start();
      } catch (e) {
        throw new EngineError("Barretenberg did not start", true, e);
      }
    }
    let answer: unknown;
    try {
      answer = this.#instance.call(command, args);
    } catch (e) {
      this.#instance = undefined;
      throw new EngineError(`Barretenberg threw on ${command}`, false, e);
    }
    // An answer is a pair: the name of its kind, and its fields.
    if (Array.isArray(answer) && answer.length === 2 && answer[0] === expected && typeof answer[1] === "object" && answer[1] !== null) {
      return answer[1] as Record<string, unknown>;
    }
    this.#instance = undefined;
    const kind = Array.isArray(answer) && typeof answer[0] === "string" ? answer[0] : "something that is not an answer";
    throw new EngineError(`Barretenberg answered ${command} with ${kind}, not ${expected}`, false);
  }

  /** Drops the instance: the next command starts a fresh one. */
  drop(): void {
    this.#instance = undefined;
  }
}
