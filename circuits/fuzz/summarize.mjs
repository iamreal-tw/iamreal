// Summarizes results/<seed>/*.jsonl: counts per family and mutation, verdicts
// per circuit, expected-vs-got, findings grouped, reject reasons.
//   node summarize.mjs SEED [SEED...]
//   FUZZ_OUT=DIR node summarize.mjs SEED     results written with `run.mjs --out DIR`
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FUZZ } from "./lib/common.mjs";

const seeds = process.argv.slice(2);
const lines = [];
let first = Infinity, last = 0;
for (const seed of seeds) {
  const dir = join(process.env.FUZZ_OUT ?? FUZZ, "results", seed);
  for (const f of readdirSync(dir)) {
    const st = statSync(join(dir, f));
    first = Math.min(first, st.birthtimeMs);
    last = Math.max(last, st.mtimeMs);
    for (const l of readFileSync(join(dir, f), "utf8").trim().split("\n")) if (l) lines.push(JSON.parse(l));
  }
}
const inc = (o, k, n = 1) => (o[k] = (o[k] ?? 0) + n);
const fam = {}, mut = {}, verdicts = {}, confusion = {}, ms = {}, errs = {}, reasons = {};
const groups = new Map();
for (const l of lines) {
  inc(fam, l.family);
  inc(mut, `${l.family} ${l.mutation.split(" ")[0]}${l.family === "chain" && /^(time|smt|key|serial|names|keyusage|holder|sig)$/.test(l.mutation.split(" ")[0]) ? " " + l.mutation.split(" ")[1] : ""}`);
  inc(ms, l.family, l.ms);
  inc(reasons, `${l.family}: ${(l.ref?.reason ?? "?").replace(/; cert: .*/, "")}${l.ref?.cert ? " / cert " + l.ref.cert : ""}`);
  for (const r of l.rows) {
    if (r.circuit === "note") { inc(verdicts, "note: " + r.verdict); continue; }
    const c = r.circuit.replace(/^circom$/, "circom (not expressible)");
    inc(verdicts, `${c} ${r.verdict}`);
    inc(confusion, `${c} expected ${r.expected} got ${r.verdict}`);
    if (r.verdict === "reject" && r.error) {
      const e = /brillig/i.test(r.error) ? "brillig (unconstrained) failure" : /Assert Failed/.test(r.error) ? "circom Assert Failed" : r.error.replace(/Circuit execution failed: /, "").slice(0, 60);
      inc(errs, `${c.replace(/_rs\d+|RS\d+/, "")} | expected ${r.expected} | ${e}`);
    }
  }
  for (const i of l.issues) {
    const key = i.replace(/\[.*?\]/g, "[..]").replace(/\d{4,}/g, "N");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(`${l.index}:${l.mutation}`);
  }
}
const show = (title, o) => {
  console.log(`\n## ${title}\n`);
  for (const [k, v] of Object.entries(o).sort()) console.log(`${String(v).padStart(7)}  ${k}`);
};
console.log(`# ${seeds.join(", ")}: ${lines.length} cases, wall ${((last - first) / 60000).toFixed(1)} min`);
show("families", fam);
show("mean ms per case (one worker)", Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v / fam[k])])));
show("mutations", mut);
show("verdicts", verdicts);
show("expected vs got", confusion);
show("reject reasons", errs);
show("reference verdict reasons (first failing check; ok = accept)", reasons);
console.log(`\n## findings (${[...groups.values()].reduce((s, g) => s + g.length, 0)} issues in ${lines.filter((l) => l.issues.length).length} cases)\n`);
for (const [k, v] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(v.length).padStart(6)}  ${k}\n        e.g. ${v.slice(0, 4).join(", ")}`);
}
