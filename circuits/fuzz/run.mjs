// Worker: runs cases index = start + k * step (k = 0, 1, ...) of seed `seed`
// until `count` cases or `--until` (epoch ms). Appends one JSON line per case
// to results/<seed>/w<id>.jsonl and writes each finding's full inputs to
// findings/<seed>-<index>.json.
//
//   node run.mjs --seed S [--start 0 --step 1 --count N --id 0 --until T]
//   node run.mjs --seed S --case I [--verbose]       # one case, printed
//   node run.mjs ... --only chain|sig|card           # one family
//   node run.mjs ... --noir-target DIR --no-circom   # run against other Noir artifacts
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FUZZ, loadPool } from "./lib/common.mjs";
import { genCase } from "./lib/gen.mjs";
import { runCase, Runners } from "./lib/exec.mjs";

const { values: a } = parseArgs({ options: {
  seed: { type: "string", default: "1" }, start: { type: "string", default: "0" }, step: { type: "string", default: "1" },
  count: { type: "string", default: "1000000000" }, id: { type: "string", default: "0" }, until: { type: "string" },
  case: { type: "string" }, mutation: { type: "string" }, verbose: { type: "boolean", default: false }, only: { type: "string" },
  "noir-target": { type: "string" }, "no-circom": { type: "boolean", default: false }, out: { type: "string" },
} });

const pool = loadPool();
const rn = new Runners({ noirTarget: a["noir-target"], circom: !a["no-circom"] });
await rn.init();
const outDir = a.out ?? FUZZ;
const resDir = join(outDir, "results", a.seed);
const findDir = join(outDir, "findings");
mkdirSync(resDir, { recursive: true });
mkdirSync(findDir, { recursive: true });

const big = (k, v) => (typeof v === "bigint" ? "0x" + v.toString(16) : v?.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v);
const ser = (o) => JSON.parse(JSON.stringify(o, big));

async function one(index) {
  const c = genCase(a.seed, index, pool, a.only, a.mutation);
  const t0 = performance.now();
  let out;
  try {
    out = await runCase(rn, c, pool);
  } catch (e) {
    out = { rows: [], issues: [`harness exception: ${e.stack}`], inputs: {} };
  }
  const ms = Math.round(performance.now() - t0);
  const line = { index, family: c.family, mutation: c.mutation, position: c.position, bits: c.bits ?? c.chain?.bits,
    rows: out.rows.map(({ circuit, expected, verdict, error }) => ({ circuit, expected, verdict, error })), issues: out.issues, ref: out.ref, ms };
  if (out.issues.length) {
    const { tbs, ...rest } = c;
    writeFileSync(join(findDir, `${a.seed}-${index}.json`), JSON.stringify(ser({ case: { ...rest, tbs: c.tbs?.toString("hex") }, ...line, inputs: out.inputs }), null, 1));
  }
  return line;
}

if (a.case !== undefined) {
  const line = await one(Number(a.case));
  console.log(JSON.stringify(line, null, a.verbose ? 1 : 0));
  process.exit(0);
}

const start = Number(a.start), step = Number(a.step), count = Number(a.count);
const until = a.until ? Number(a.until) : Infinity;
const file = join(resDir, `w${a.id}.jsonl`);
for (let k = 0; k < count && Date.now() < until; k++) {
  const line = await one(start + k * step);
  appendFileSync(file, JSON.stringify(line) + "\n");
  if (line.issues.length) console.log(`[w${a.id}] case ${line.index} ${line.family} ${line.mutation}: ${line.issues.join(" | ")}`);
}
process.exit(0);
