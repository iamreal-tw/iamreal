// Writes the compiled circuit the page loads from one that `nargo compile`
// wrote: the same `noir_version`, `abi` and `bytecode`, nothing else.
// Dropped: `file_map`, which holds the full source of the circuit and of the
// libraries it uses with the paths of the machine that compiled it;
// `debug_symbols`; `hash`, an integer above 2^53 that JSON.parse would not
// keep exactly. noir_js and bb.js read none of them (circuits/README.md).
//
//   node scripts/strip-circuit.mjs <nargo's card_proof_rsNNNN.json> <out>
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!output) throw new Error("usage: node scripts/strip-circuit.mjs <in> <out>");
const c = JSON.parse(readFileSync(input, "utf8"));
for (const key of ["noir_version", "abi", "bytecode"]) {
  if (!(key in c)) throw new Error(`no ${key} in ${input}`);
}
writeFileSync(output, JSON.stringify({ noir_version: c.noir_version, abi: c.abi, bytecode: c.bytecode }));
