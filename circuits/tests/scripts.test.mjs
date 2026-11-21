// The shell scripts of circuits/, by what they do when something is wrong:
// they stop with a non-zero exit code instead of going on, and they delete
// nothing they did not make. Each test runs a script, or a copy of it next to
// stand-ins for the tools it calls, in a temporary directory; none needs
// nargo, bb, circom or the network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { ROOT } from "./lib/run.mjs";

const temp = mkdtempSync(join(tmpdir(), "circuits-scripts-"));
after(() => rmSync(temp, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = join(temp, String(n++));
  mkdirSync(d, { recursive: true });
  return d;
};
const run = (script, args = [], env = {}) =>
  spawnSync(script, args, { encoding: "utf8", env: { ...process.env, ...env } });
/** Writes an executable file. */
const executable = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
};
/** Copies scripts of circuits/ to the same paths under `dir`. */
const copy = (dir, ...paths) => {
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    copyFileSync(join(ROOT, p), join(dir, p));
  }
};

describe("sha256.sh", () => {
  it("prints the SHA-256 of a file, and nothing else", () => {
    const f = join(fresh(), "abc");
    writeFileSync(f, "abc");
    const r = run(join(ROOT, "sha256.sh"), [f]);
    assert.equal(r.status, 0, r.stderr);
    // FIPS 180-2, appendix B.1.
    assert.equal(r.stdout, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n");
  });

  it("fails for a file that is not there", () => {
    const r = run(join(ROOT, "sha256.sh"), [join(fresh(), "missing")]);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  });
});

describe("build-circom.sh", () => {
  it("refuses a directory it did not make, and leaves it as it was", () => {
    const dir = fresh();
    writeFileSync(join(dir, "notes.txt"), "someone's file");
    const r = run(join(ROOT, "build-circom.sh"), [dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not made by build-circom\.sh/);
    assert.deepEqual(readdirSync(dir), ["notes.txt"]);
  });
});

describe("fuzz/selftest/make-mutants.sh", () => {
  it("stops when fetch-nargo.sh fails, and builds nothing", () => {
    const src = fresh();
    copy(src, "fuzz/selftest/make-mutants.sh");
    executable(join(src, "fetch-nargo.sh"), "#!/bin/sh\necho 'fetch-nargo: hash mismatch' >&2\nexit 1\n");
    // A nargo on PATH that would "build" anything: it must not be reached.
    const bin = fresh();
    executable(join(bin, "nargo"), "#!/bin/sh\nmkdir -p target\n");
    const work = fresh();
    const r = run(join(src, "fuzz/selftest/make-mutants.sh"), [], { FUZZ_WORK: work, PATH: `${bin}:${process.env.PATH}` });
    assert.notEqual(r.status, 0);
    assert.equal(existsSync(join(work, "mutants")), false);
  });

  it("exits non-zero when a mutant does not compile", () => {
    const src = fresh();
    copy(src, "fuzz/selftest/make-mutants.sh", "Nargo.toml");
    for (const d of ["lib/src", "card_proof_rs2048", "card_proof_rs4096", "comparison", "tests/probes"]) mkdirSync(join(src, d), { recursive: true });
    // Every text the script removes, so that each replacement finds it once.
    const script = readFileSync(join(ROOT, "fuzz/selftest/make-mutants.sh"), "utf8");
    const files = {};
    for (const m of script.matchAll(/^mk \S+ (\S+) (["'])(.*)\2 ""$/gm)) (files[m[1]] ??= []).push(m[3]);
    for (const [f, lines] of Object.entries(files)) writeFileSync(join(src, f), lines.join("\n") + "\n");
    const nargoDir = fresh();
    executable(join(nargoDir, "nargo"), "#!/bin/sh\nexit 1\n");
    executable(join(src, "fetch-nargo.sh"), `#!/bin/sh\necho ${join(nargoDir, "nargo")}\n`);
    const r = run(join(src, "fuzz/selftest/make-mutants.sh"), [], { FUZZ_WORK: fresh() });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout, /FAILED/);
  });
});

describe("fuzz/selftest/run-mutants.sh", () => {
  /**
   * A copy of the script next to a stand-in run.mjs that writes one result per
   * call, and a finding when the circuits it is given are named in `caught`.
   */
  function setUp(caught) {
    const src = fresh();
    copy(src, "fuzz/selftest/run-mutants.sh");
    writeFileSync(join(src, "fuzz/run.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arg = (k) => process.argv[process.argv.indexOf(k) + 1];
const out = arg("--out"), seed = arg("--seed"), target = arg("--noir-target");
mkdirSync(join(out, "results", seed), { recursive: true });
mkdirSync(join(out, "findings"), { recursive: true });
writeFileSync(join(out, "results", seed, "w" + arg("--id") + ".jsonl"), "{}\\n");
if (${JSON.stringify(caught)}.some((c) => target.includes(c))) writeFileSync(join(out, "findings", seed + "-1.json"), "{}");
`);
    const work = fresh();
    for (const m of ["mutant-a", "mutant-b"]) mkdirSync(join(work, "mutants", m, "target"), { recursive: true });
    return { script: join(src, "fuzz/selftest/run-mutants.sh"), env: { FUZZ_WORK: work } };
  }

  it("exits 0 when the real circuits give no finding and every mutant at least one", () => {
    const { script, env } = setUp(["mutant-a", "mutant-b"]);
    const r = run(script, ["4"], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it("exits non-zero when a mutant gives no finding", () => {
    const { script, env } = setUp(["mutant-a"]);
    const r = run(script, ["4"], env);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout + r.stderr, /mutant-b/);
  });

  it("exits non-zero when the real circuits give a finding", () => {
    const { script, env } = setUp(["mutant-a", "mutant-b", "target"]);
    const r = run(script, ["4"], env);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout + r.stderr, /baseline/);
  });
});
