// worker/ refers to protocol/ and to nothing else of this repository
// (CLAUDE.md, the table of directories), and its packages are pinned.
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

test("the only package the Worker's code depends on is protocol/", () => {
  assert.deepEqual(pkg.dependencies, { "iamreal-protocol": "workspace:*" });
});

test("every development package is pinned to one exact version", () => {
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) assert.match(version, /^\d+\.\d+\.\d+$/, name);
});

test("the code that runs in the Worker imports its own files, protocol/ and the runtime, nothing else", () => {
  const seen: string[] = [];
  for (const dir of ["src", "test-build"]) {
    for (const file of readdirSync(join(WORKER_DIR, dir))) {
      const source = readFileSync(join(WORKER_DIR, dir, file), "utf8");
      for (const m of source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(?\s*"([^"]+)"/g)) {
        const specifier = (m[1] ?? m[2])!;
        seen.push(specifier);
        const own = dir === "src" ? /^\.\/[a-z-]+\.ts$/ : /^\.\/[a-z-]+\.ts$|^\.\.\/src\/[a-z-]+\.ts$/;
        assert.ok(own.test(specifier) || specifier === "#target" || specifier === "cloudflare:workers" || /^iamreal-protocol\/[a-z-]+\.ts$/.test(specifier), `${dir}/${file} imports ${specifier}`);
      }
    }
  }
  assert.ok(seen.includes("#target") && seen.some((s) => s.startsWith("iamreal-protocol/")), "the check read the imports");
  assert.deepEqual(pkg.imports, { "#target": "./src/target.ts" });
});
