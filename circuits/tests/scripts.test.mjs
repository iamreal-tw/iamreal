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
  const commit = readFileSync(join(ROOT, "zkid-commit"), "utf8").trim();
  const circuits = ["certChainRS2048", "certChainRS4096", "userSigRS2048"];
  /**
   * Stand-ins on PATH for circom, git and corepack: git "fetches" a tree with
   * the circom source fuzz/ reads, and `yarn compile:all` writes the witness
   * generators of the circuits in `built`, and nothing else.
   */
  function standIns(built) {
    const bin = fresh();
    executable(join(bin, "circom"), "#!/bin/sh\necho 'circom compiler 2.2.3'\n");
    executable(join(bin, "git"), `#!/bin/sh
dir=.
if [ "$1" = -C ]; then dir=$2; shift 2; fi
case " $* " in
  *" init "*) for a in "$@"; do last=$a; done; mkdir -p "$last" ;;
  *" checkout "*) mkdir -p "$dir/wallet-unit-poc/circom/circuits/components" && echo constants > "$dir/wallet-unit-poc/circom/circuits/components/poseidonP256Constants.circom" ;;
  *" rev-parse "*) echo ${commit} ;;
esac
`);
    executable(join(bin, "corepack"), `#!/bin/sh
case " $* " in
  *" compile:all "*) for c in ${built.join(" ")}; do mkdir -p build/$c/\${c}_js && echo wasm > build/$c/\${c}_js/$c.wasm && echo js > build/$c/\${c}_js/witness_calculator.js; done ;;
esac
`);
    return { PATH: `${bin}:${process.env.PATH}` };
  }

  it("keeps only the witness generators, the circom source fuzz/ reads and COMMIT", () => {
    const dir = join(fresh(), "zkID");
    const r = run(join(ROOT, "build-circom.sh"), [dir], standIns(circuits));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, "COMMIT"), "utf8"), commit + "\n");
    for (const c of circuits) {
      assert.deepEqual(readdirSync(join(dir, "wallet-unit-poc/circom/build", c, `${c}_js`)).sort(), [`${c}.wasm`, "witness_calculator.js"]);
    }
    assert.ok(existsSync(join(dir, "wallet-unit-poc/circom/circuits/components/poseidonP256Constants.circom")));
    assert.deepEqual(readdirSync(dirname(dir)), ["zkID"], "nothing else left next to it");
  });

  it("stopping half-way leaves the build that was there as it was, and nothing else", () => {
    const parent = fresh();
    const dir = join(parent, "zkID");
    mkdirSync(dir);
    writeFileSync(join(dir, "COMMIT"), "an older commit\n");
    writeFileSync(join(dir, "older.wasm"), "older");
    // userSigRS2048 is not built: copying it fails.
    const r = run(join(ROOT, "build-circom.sh"), [dir], standIns(circuits.slice(0, 2)));
    assert.notEqual(r.status, 0);
    assert.deepEqual(readdirSync(dir).sort(), ["COMMIT", "older.wasm"]);
    assert.equal(readFileSync(join(dir, "COMMIT"), "utf8"), "an older commit\n");
    assert.deepEqual(readdirSync(parent), ["zkID"], "nothing left next to it");
  });

  it("refuses a directory it did not make, and leaves it as it was", () => {
    const dir = fresh();
    writeFileSync(join(dir, "notes.txt"), "someone's file");
    const r = run(join(ROOT, "build-circom.sh"), [dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not made by build-circom\.sh/);
    assert.deepEqual(readdirSync(dir), ["notes.txt"]);
  });
});

describe("fetch-circom.sh", () => {
  const RELEASE_URL = "https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64";
  const CIRCOM = "#!/bin/sh\necho circom compiler 2.2.3\n";
  /**
   * A copy of the script next to a circom.sha256 with `line`, and stand-ins on
   * PATH for uname (this machine is `system`) and curl, which "downloads"
   * `body` to its --output and writes the URL it was given to `asked`.
   */
  function setUp({ line, system = "Linux x86_64", body = CIRCOM }) {
    const dir = fresh();
    copy(dir, "fetch-circom.sh", "sha256.sh");
    writeFileSync(join(dir, "circom.sha256"), line + "\n");
    const bin = fresh();
    const [s, m] = system.split(" ");
    executable(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${s} ;; -m) echo ${m} ;; esac\n`);
    executable(join(bin, "curl"), `#!/bin/sh
out=
while [ $# -gt 1 ]; do
  case "$1" in --output) out=$2; shift ;; esac
  shift
done
echo "$1" > "${join(dir, "asked")}"
printf '%s' '${body}' > "$out"
`);
    return { dir, env: { PATH: `${bin}:${process.env.PATH}` } };
  }
  const sha = (text) => {
    const f = join(fresh(), "f");
    writeFileSync(f, text);
    return run(join(ROOT, "sha256.sh"), [f]).stdout.trim();
  };

  it("downloads circom from its release, checks its SHA-256 against circom.sha256, and prints the path of the executable", () => {
    const { dir, env } = setUp({ line: `${sha(CIRCOM)}  v2.2.3/circom-linux-amd64` });
    const r = run(join(dir, "fetch-circom.sh"), [], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, "asked"), "utf8"), RELEASE_URL + "\n");
    const circom = join(dir, ".tools", "circom", "linux-amd64", "circom");
    assert.equal(r.stdout, circom + "\n");
    assert.equal(spawnSync(circom, { encoding: "utf8" }).stdout, "circom compiler 2.2.3\n", "the downloaded file, made executable");
  });

  it("puts nothing in place of a download whose SHA-256 is not the one in circom.sha256", () => {
    const { dir, env } = setUp({ line: `${"0".repeat(64)}  v2.2.3/circom-linux-amd64` });
    const r = run(join(dir, "fetch-circom.sh"), [], env);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /SHA-256/);
    assert.equal(existsSync(join(dir, ".tools", "circom", "linux-amd64", "circom")), false);
  });

  it("downloads nothing on a machine circom.sha256 has no circom for", () => {
    const { dir, env } = setUp({ line: `${sha(CIRCOM)}  v2.2.3/circom-linux-amd64`, system: "Darwin arm64" });
    const r = run(join(dir, "fetch-circom.sh"), [], env);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(join(dir, "asked")), false);
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
   * A copy of the script next to a stand-in run.mjs. Each call writes as many
   * results as its --count asks, and a finding when the circuits it is given
   * are named in `caught`. `crash`: a call whose circuits are named there
   * exits 1 at once and writes nothing; `short`: one call of such circuits
   * writes one result fewer.
   */
  function setUp({ caught, crash = [], short = [] }) {
    const src = fresh();
    copy(src, "fuzz/selftest/run-mutants.sh");
    writeFileSync(join(src, "fuzz/run.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arg = (k) => process.argv[process.argv.indexOf(k) + 1];
const out = arg("--out"), seed = arg("--seed"), target = arg("--noir-target");
const named = (list) => list.some((c) => target.includes(c));
if (named(${JSON.stringify(crash)})) process.exit(1);
let count = Number(arg("--count"));
if (named(${JSON.stringify(short)}) && arg("--id") === "0") count -= 1;
mkdirSync(join(out, "results", seed), { recursive: true });
mkdirSync(join(out, "findings"), { recursive: true });
writeFileSync(join(out, "results", seed, "w" + arg("--id") + ".jsonl"), "{}\\n".repeat(count));
if (named(${JSON.stringify(caught)})) writeFileSync(join(out, "findings", seed + "-1.json"), "{}");
`);
    const work = fresh();
    for (const m of ["mutant-a", "mutant-b"]) mkdirSync(join(work, "mutants", m, "target"), { recursive: true });
    return { script: join(src, "fuzz/selftest/run-mutants.sh"), env: { FUZZ_WORK: work } };
  }

  it("exits 0 when every case ran, the real circuits give no finding and every mutant at least one", () => {
    const { script, env } = setUp({ caught: ["mutant-a", "mutant-b"] });
    const r = run(script, ["4"], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  it("exits non-zero when a mutant gives no finding", () => {
    const { script, env } = setUp({ caught: ["mutant-a"] });
    const r = run(script, ["4"], env);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout + r.stderr, /mutant-b/);
  });

  it("exits non-zero when the real circuits give a finding", () => {
    const { script, env } = setUp({ caught: ["mutant-a", "mutant-b", "target"] });
    const r = run(script, ["4"], env);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout + r.stderr, /baseline/);
  });

  it("exits non-zero when the workers of the real circuits crash at once, though nothing is found", () => {
    const { script, env } = setUp({ caught: ["mutant-a", "mutant-b"], crash: ["/fuzz/../target"] });
    const r = run(script, ["4"], env);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout + r.stderr, /baseline/);
  });

  it("exits non-zero when a round ran fewer cases than asked, and says which, how many and how many expected", () => {
    const { script, env } = setUp({ caught: ["mutant-a", "mutant-b"], short: ["mutant-a"] });
    const r = run(script, ["4"], env);
    assert.notEqual(r.status, 0, r.stdout);
    // 4 workers of 4 / 4 cases, and 40 cases of each of the 9 focused mutations.
    assert.match(r.stdout + r.stderr, /mutant-a: 363 cases, expected 364/);
  });
});
