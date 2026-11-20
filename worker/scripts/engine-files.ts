// The files of the proof verifier that are not this directory's source:
// Barretenberg's WebAssembly module and the two verification keys. Every
// build of the Worker starts here (test/build.ts, scripts/deploy-test.ts):
// this writes them into `generated/`, where src/engine.ts imports them
// from, and it stops the build if one of them does not have the SHA-256
// written below. `generated/` is not in version control.
//
// - `barretenberg.wasm`: the single-threaded module of bb.js 6.0.0. The
//   package has it as a gzip in a data: address inside
//   dest/browser/barretenberg_wasm/fetch_code/browser/barretenberg.js; this
//   takes it out and unpacks it. Nothing of bb.js's code goes into the
//   Worker.
// - `<circuit>.vk.bin`: verifier/vk/<circuit>.vk, the file the Go verifier
//   embeds, byte for byte. The copy is made at each build; the repository
//   keeps one.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the files are written. */
export const GENERATED_DIR = join(WORKER_DIR, "generated");

/** The module's file name in `generated/`. */
export const WASM_FILE = "barretenberg.wasm";

/** SHA-256 of the unpacked module of bb.js 6.0.0: 18,278,515 bytes (#16). */
export const WASM_SHA256 = "88c435ec45998ad74b51b25659b37e59b4beea256073138415547f8153f9ead9";

/** The accepted circuits and the SHA-256 of their verification keys (spec/proof-verification.md). */
export const VK_SHA256: Readonly<Record<string, string>> = {
  card_proof_rs2048: "816406c75c5422cefab5acd70276f3dc8ce5d269736aefd9795e230569bd3ac8",
  card_proof_rs4096: "bed43ed823a5273292150785bce9a24a24162711a25e8c3a4337a61bdc9f38c2",
};

/** A verification key's file name in `generated/`. */
export const vkFile = (circuit: string): string => `${circuit}.vk.bin`;

/** Where the files come from. */
export interface EngineSources {
  /** bb.js's file that holds the single-threaded module. */
  readonly bbjsModule: string;
  /** The directory of the verification keys, `<circuit>.vk`. */
  readonly vkDir: string;
}

/** bb.js as installed for this directory, and the Go verifier's keys. */
export function defaultSources(): EngineSources {
  const bbjs = join(WORKER_DIR, "node_modules", "@aztec-foundation", "bb.js");
  return {
    bbjsModule: join(bbjs, "dest", "browser", "barretenberg_wasm", "fetch_code", "browser", "barretenberg.js"),
    vkDir: join(WORKER_DIR, "..", "verifier", "vk"),
  };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function checked(what: string, bytes: Uint8Array, expected: string): Uint8Array {
  const got = sha256(bytes);
  if (got !== expected) throw new Error(`${what} has SHA-256 ${got}, not ${expected}: the build stops`);
  return bytes;
}

/** The module inside bb.js's file, unpacked. Throws if the file is not written the way 6.0.0 writes it. */
function wasmIn(file: string): Uint8Array {
  const m = /^const barretenberg = "data:application\/gzip;base64,([A-Za-z0-9+/=]+)";\s*export default barretenberg;\s*$/.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error(`${file} is not bb.js 6.0.0's file with the module in it`);
  return gunzipSync(Buffer.from(m[1]!, "base64"));
}

/** Writes `bytes` to `path` unless that is what the file already holds; never leaves half a file. */
function put(path: string, bytes: Uint8Array): void {
  try {
    if (Buffer.compare(readFileSync(path), bytes) === 0) return;
  } catch {
    // Not there yet.
  }
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, path);
}

/**
 * Checks every file's SHA-256 and writes them all into `outDir`. Throws,
 * having written nothing, if one is wrong.
 */
export function prepareEngineFiles(sources: EngineSources = defaultSources(), outDir: string = GENERATED_DIR): void {
  const files: [string, Uint8Array][] = [[WASM_FILE, checked(`the module in ${sources.bbjsModule}`, wasmIn(sources.bbjsModule), WASM_SHA256)]];
  for (const [circuit, expected] of Object.entries(VK_SHA256)) {
    const source = join(sources.vkDir, `${circuit}.vk`);
    files.push([vkFile(circuit), checked(source, readFileSync(source), expected)]);
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, bytes] of files) put(join(outDir, name), bytes);
}
