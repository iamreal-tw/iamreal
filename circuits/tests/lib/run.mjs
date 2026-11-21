// Runs one set of inputs through a circuit and reports accept / reject.
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Noir } from "@noir-lang/noir_js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Where the compiled circuits are. tests/counterfactual/ points this at a
// build with one check removed.
const NOIR_TARGET = process.env.ZKID_NOIR_TARGET ?? join(ROOT, "target");

const noirCircuits = new Map();

/** Executes the Noir circuit `name`. Returns { ok, returnValue } or { ok: false, error }. */
export async function runNoir(name, inputs) {
  if (!noirCircuits.has(name)) {
    const compiled = JSON.parse(readFileSync(join(NOIR_TARGET, `${name}.json`), "utf8"));
    noirCircuits.set(name, new Noir(compiled));
  }
  try {
    const { returnValue, witness } = await noirCircuits.get(name).execute(inputs);
    return { ok: true, returnValue, witness };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error).split("\n")[0] };
  }
}

// The circom circuit's witness generators, built from the `primary-card`
// branch (`yarn compile:all` in wallet-unit-poc/circom). Not part of this
// repository; without them the circom column is skipped.
const CIRCOM_BUILD =
  process.env.ZKID_CIRCOM_BUILD ?? join(ROOT, "..", "zkID", "wallet-unit-poc", "circom", "build");

const circomCircuits = new Map();
const require = createRequire(import.meta.url);

export function circomAvailable(name) {
  return existsSync(join(CIRCOM_BUILD, name, `${name}_js`, `${name}.wasm`));
}

/** Computes the circom witness. Returns { ok, witness } or { ok: false, error }. */
export async function runCircom(name, inputs) {
  if (!circomCircuits.has(name)) {
    const dir = join(CIRCOM_BUILD, name, `${name}_js`);
    const builder = require(join(dir, "witness_calculator.js"));
    circomCircuits.set(name, await builder(readFileSync(join(dir, `${name}.wasm`))));
  }
  try {
    const witness = await circomCircuits.get(name).calculateWitness(inputs, true);
    return { ok: true, witness };
  } catch (error) {
    return { ok: false, error: String(error.message ?? error).split("\n")[0] };
  }
}
