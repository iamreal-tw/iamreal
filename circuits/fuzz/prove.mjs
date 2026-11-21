// Confirms a Noir verdict with a real proof: executes `circuit` on the inputs
// stored for it in a findings file (or re-generated from --seed/--case), then
// runs `bb prove` and `bb verify` with the circuit's verification key.
//   node prove.mjs --circuit card_proof_rs2048 (--finding FILE | --seed S --case I)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FUZZ, loadPool, NOIR_ROOT } from "./lib/common.mjs";
import { genCase } from "./lib/gen.mjs";
import { runCase, Runners } from "./lib/exec.mjs";

const { values: a } = parseArgs({ options: { circuit: { type: "string" }, finding: { type: "string" }, seed: { type: "string" }, case: { type: "string" }, only: { type: "string" }, mutation: { type: "string" } } });
const rn = new Runners({ circom: false });
await rn.init();
let inputs;
if (a.finding) inputs = JSON.parse(readFileSync(a.finding, "utf8")).inputs[a.circuit];
else {
  const pool = loadPool();
  const out = await runCase(rn, genCase(a.seed, Number(a.case), pool, a.only, a.mutation), pool);
  inputs = out.inputs[a.circuit];
}
const res = await rn.runNoir(a.circuit, inputs);
console.log("execute:", res.verdict, res.error ?? "");
if (res.verdict !== "accept") process.exit(0);
const dir = join(FUZZ, "proofs", `${a.circuit}-${Date.now()}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "witness.gz"), res.witness);
const bb = join(NOIR_ROOT, ".tools", "bb", "bb");
const B = join(NOIR_ROOT, "target", `${a.circuit}.json`);
const crs = join(NOIR_ROOT, ".crs");
const vkDir = join(dir, "vk");
mkdirSync(vkDir);
const sh = (args) => execFileSync(bb, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
sh(["write_vk", "-b", B, "-o", vkDir, "-c", crs, "-t", "noir-recursive"]);
sh(["prove", "-b", B, "-w", join(dir, "witness.gz"), "-k", join(vkDir, "vk"), "-o", dir, "-c", crs, "-t", "noir-recursive"]);
console.log("bb prove: done");
try {
  sh(["verify", "-k", join(vkDir, "vk"), "-p", join(dir, "proof"), "-i", join(dir, "public_inputs"), "-c", crs, "-t", "noir-recursive"]);
  console.log("bb verify: OK");
} catch (e) {
  console.log("bb verify: FAILED", String(e.stderr).slice(0, 300));
}
console.log("vk sha256:", execFileSync("shasum", ["-a", "256", join(vkDir, "vk")]).toString().split(" ")[0]);
rmSync(dir, { recursive: true, force: true });
