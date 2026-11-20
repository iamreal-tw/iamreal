// worker/ refers to protocol/ and to nothing else of this repository
// (CLAUDE.md, the table of directories), and its packages are pinned. The
// proof verifier adds one package, msgpackr (#59), and the files a build
// writes into generated/ (scripts/engine-files.ts).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WORKER_DIR } from "./build.ts";

const pkg = JSON.parse(readFileSync(join(WORKER_DIR, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  imports?: Record<string, string>;
};

test("the only packages the Worker's code depends on are protocol/ and msgpackr", () => {
  assert.deepEqual(pkg.dependencies, { "iamreal-protocol": "workspace:*", msgpackr: "1.12.1" });
});

test("every development package is pinned to one exact version", () => {
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) assert.match(version, /^\d+\.\d+\.\d+$/, name);
});

/** The proof verifier and the Poseidon2 hash: the loader, the instance, and the two that use it. */
const ENGINE = ["barretenberg.ts", "engine.ts", "verify.ts", "poseidon2.ts"];
/** What a build writes into generated/. */
const GENERATED = /^\.\.\/generated\/(barretenberg\.wasm|card_proof_rs(2048|4096)\.vk\.bin)$/;

test("the code that runs in the Worker imports its own files, protocol/ and the runtime, nothing else; the proof verifier also msgpackr and its generated files", () => {
  const seen: string[] = [];
  for (const dir of ["src", "test-build"]) {
    for (const file of readdirSync(join(WORKER_DIR, dir))) {
      const source = readFileSync(join(WORKER_DIR, dir, file), "utf8");
      for (const m of source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"/g)) {
        const specifier = (m[1] ?? m[2])!;
        seen.push(specifier);
        const own = dir === "src" ? /^\.\/[a-z0-9-]+\.ts$/ : /^\.\/[a-z0-9-]+\.ts$|^\.\.\/src\/[a-z0-9-]+\.ts$/;
        const engines = dir === "src" && ((file === "barretenberg.ts" && specifier === "msgpackr") || (ENGINE.includes(file) && GENERATED.test(specifier)));
        assert.ok(engines || own.test(specifier) || specifier === "#target" || specifier === "cloudflare:workers" || /^iamreal-protocol\/[a-z-]+\.ts$/.test(specifier), `${dir}/${file} imports ${specifier}`);
      }
    }
  }
  assert.ok(seen.includes("#target") && seen.some((s) => s.startsWith("iamreal-protocol/")) && seen.includes("msgpackr"), "the check read the imports");
  assert.deepEqual(pkg.imports, { "#target": "./src/target.ts" });
});

test("the proof verifier takes nothing from what the test build replaces", () => {
  // The test build replaces `#target` and the entry point, nothing else
  // (test/build.ts). The verifier's files import neither `#target` nor any
  // file of src/ but each other, so the test build runs the same verifier
  // as the deployed one.
  const reachable = new Set<string>();
  const visit = (file: string): void => {
    if (reachable.has(file)) return;
    reachable.add(file);
    const source = readFileSync(join(WORKER_DIR, "src", file), "utf8");
    for (const m of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
      const specifier = m[1]!;
      assert.notEqual(specifier, "#target", `src/${file} imports #target`);
      const own = /^\.\/([a-z0-9-]+\.ts)$/.exec(specifier);
      if (own) visit(own[1]!);
    }
  };
  for (const file of ["verify.ts", "poseidon2.ts"]) visit(file);
  assert.deepEqual([...reachable].sort(), [...ENGINE].sort());
});
