// A loader for Barretenberg's single-threaded WebAssembly module, the one
// bb.js 6.0.0 ships (scripts/engine-files.ts says where the file comes from
// and checks its SHA-256). bb.js loads the module by compiling bytes it
// fetched, which a Worker may not do; here the module arrives already
// compiled, as an import (src/engine.ts).
//
// What this does is what bb.js 6.0.0 does, read from its source
// (src/barretenberg_wasm/barretenberg_wasm_base/index.ts,
// src/barretenberg_wasm/barretenberg_wasm_main/index.ts, cbindCall, and
// src/cbind/generated/sync.ts): one memory and five functions for the
// module to import, and calls to its one entry point `bbapi` with a command
// in msgpack, encoded by msgpackr with the options bb.js uses.
//
// One instance is one use of the module's memory. A call that throws leaves
// that memory in whatever state the module was in when it stopped, and an
// instance that keeps throwing ends up refusing correct proofs too (#16):
// the caller drops an instance that threw and starts another.
import { Decoder, Encoder } from "msgpackr";

/** One page of WebAssembly memory. */
const PAGE = 65536;
/** The memory an instance starts with, in pages: what bb.js gives it. */
const INITIAL_PAGES = 37;
/**
 * The most memory an instance may grow to: 16 MiB. Verifying a proof ends
 * at 2.6 MiB (#16), and a Worker has 128 MB for everything.
 */
const MAXIMUM_PAGES = (16 * 1024 * 1024) / PAGE;
/** Room for a command or an answer; a larger one gets its own allocation. */
const SCRATCH = 64 * 1024;

/** BN254's G1 generator (1, 2), uncompressed: the whole CRS a verifier needs (spec/proof-verification.md, "The CRS"). */
const G1 = new Uint8Array(64);
G1[31] = 1;
G1[63] = 2;

/**
 * The G2 point of Barretenberg's CRS, the 128 bytes bb.js downloads as
 * `g2.dat`. The module has the point built in and aborts in `SrsInitSrs` if
 * this is not it, so a wrong byte here is a Worker that verifies nothing,
 * not one that verifies wrongly.
 */
const G2 = bytesOfHex(
  "0118c4d5b837bcc2bc89b5b398b5974e9f5944073b32078b7e231fec938883b0" +
    "260e01b251f6f1c7e7ff4e580791dee8ea51d87a358e038b4efe30fac09383c1" +
    "22febda3c0c0632a56475b4214e5615e11e6dd3f96e6cea2854a87d4dacc5e55" +
    "04fc6369f7110fe3d25156c1bb9a72859cf2a04641f99ba4ee413c80da6a5fe4",
);

function bytesOfHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

interface Exports {
  readonly _initialize: () => void;
  readonly bbmalloc: (size: number) => number;
  readonly bbfree: (pointer: number) => void;
  readonly bbapi: (input: number, inputLength: number, outputPointerAt: number, outputSizeAt: number) => void;
}

/** What a command answered: the name of the answer's kind and its fields. */
export type Answer = readonly [kind: string, fields: Record<string, unknown>];

/** One instance of the module, with the CRS loaded. */
export class Barretenberg {
  readonly #memory: WebAssembly.Memory;
  readonly #exports: Exports;
  readonly #input: number;
  readonly #output: number;

  /**
   * Instantiates the module and loads the CRS. Throws if the module does
   * not start: that is a broken build, and says nothing about any proof.
   */
  constructor(module: WebAssembly.Module) {
    this.#memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: MAXIMUM_PAGES });
    const instance = new WebAssembly.Instance(module, {
      env: {
        memory: this.#memory,
        // The module's `throw_or_abort`: every failed assertion ends here.
        throw_or_abort_impl: (address: number): never => {
          throw new Error(this.#textAt(address));
        },
        // The module's log lines. Not kept: they can quote what was being verified.
        logstr: (): void => {},
      },
      wasi_snapshot_preview1: {
        random_get: (out: number, length: number): void => {
          crypto.getRandomValues(new Uint8Array(this.#memory.buffer, out >>> 0, length));
        },
        clock_time_get: (_clock: number, _precision: bigint, out: number): void => {
          new DataView(this.#memory.buffer).setBigUint64(out >>> 0, BigInt(Date.now()) * 1000000n, true);
        },
        proc_exit: (): never => {
          throw new Error("proc_exit");
        },
      },
    });
    this.#exports = instance.exports as unknown as Exports;
    this.#exports._initialize();
    this.#input = this.#exports.bbmalloc(SCRATCH) >>> 0;
    this.#output = this.#exports.bbmalloc(SCRATCH) >>> 0;
    const [kind] = this.call("SrsInitSrs", { points_buf: G1, num_points: 1, g2_point: G2 });
    if (kind !== "SrsInitSrsResponse") throw new Error(`loading the CRS answered ${kind}`);
  }

  /**
   * Sends one command to `bbapi` and returns its answer. Throws whatever
   * the module throws; after that this instance must not be used again.
   */
  call(command: string, fields: Record<string, unknown>): Answer {
    const input = new Encoder({ useRecords: false }).pack([[command, fields]]);
    const own = input.length > SCRATCH;
    const inputAt = own ? this.#exports.bbmalloc(input.length) >>> 0 : this.#input;
    new Uint8Array(this.#memory.buffer).set(input, inputAt);

    // The module is told where it may write the answer and how much room
    // there is, in two 32-bit values that it overwrites with where the
    // answer is and how long: in that room, or in memory it allocated.
    const pointerAt = this.#output;
    const sizeAt = this.#output + 4;
    const room = this.#output + 8;
    let view = new DataView(this.#memory.buffer);
    view.setUint32(pointerAt, room, true);
    view.setUint32(sizeAt, SCRATCH - 8, true);

    this.#exports.bbapi(inputAt, input.length, pointerAt, sizeAt);
    if (own) this.#exports.bbfree(inputAt);

    // The memory may have grown, which replaces its buffer.
    view = new DataView(this.#memory.buffer);
    const answerAt = view.getUint32(pointerAt, true);
    const answer = new Uint8Array(this.#memory.buffer).slice(answerAt, answerAt + view.getUint32(sizeAt, true));
    if (answerAt !== room) this.#exports.bbfree(answerAt);
    return new Decoder({ useRecords: false }).unpack(answer) as Answer;
  }

  /** The module's memory now, in bytes. */
  get memoryBytes(): number {
    return this.#memory.buffer.byteLength;
  }

  #textAt(address: number): string {
    const memory = new Uint8Array(this.#memory.buffer);
    const start = address >>> 0;
    let end = start;
    while (end < memory.length && memory[end] !== 0) end++;
    return new TextDecoder().decode(memory.slice(start, end));
  }
}
