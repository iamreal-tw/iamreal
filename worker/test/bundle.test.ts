// What gets deployed holds MOICA's issuer keys and MOICA's two CRL
// addresses, written into the code, and nothing of the test build: no test
// issuer key, no fake MOICA, no switch for the clock (ADR-0028). The deploy
// build here is made by the command `pnpm run deploy:test` runs, as a dry
// run (test/build.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MOICA_ISSUERS } from "../src/issuers.ts";
import { type TestBuildValues, WORKER_DIR, buildWorker } from "./build.ts";
import { testIssuers } from "./harness.ts";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** The modules of a build, as wrangler would upload them (not the source map, which is not uploaded). */
function codeOf(kind: "deploy" | "test", values: TestBuildValues): string {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const out = mkdtempSync(join(WORKER_DIR, "test-output", `bundle-${kind}-`));
  try {
    if (kind === "deploy") buildWorker("deploy", out);
    else buildWorker("test", out, values);
    const files = filesUnder(out).filter((f) => !/\.map$|README\.md$/.test(f));
    assert.ok(files.length > 0, `${kind}: the build has files`);
    return files.map((f) => readFileSync(f, "utf8")).join("\n");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The two addresses crl/README.md tells people to download MOICA's CRLs from. */
function addressesInCrlReadme(): string[] {
  const readme = readFileSync(join(WORKER_DIR, "..", "crl", "README.md"), "utf8");
  const found = [...readme.matchAll(/^\s*- G[23]：`(http:\/\/[^`]+)`$/gm)].map((m) => m[1]!);
  assert.equal(found.length, 2, "crl/README.md lists two addresses");
  return found;
}

const urlsIn = (code: string): string[] => [...new Set([...code.matchAll(/https?:\/\/[^\s"'`\\)]+/g)].map((m) => m[0]))].sort();

const values: TestBuildValues = { moica: "http://127.0.0.1:59999", issuers: testIssuers() };
/** What only the test build holds. */
const TEST_ONLY = [values.moica, "127.0.0.1", "localhost", ...values.issuers.map((i) => i.modulus.slice(0, 64)), "__IAMREAL_TEST", "/__test/", "setTestClock", "testClock", "test-build"];

test("the deploy build holds MOICA's keys and addresses, and nothing of the test build", () => {
  const code = codeOf("deploy", values);
  // The only addresses in it are MOICA's two, the ones crl/README.md gives.
  assert.deepEqual(urlsIn(code), addressesInCrlReadme().sort());
  for (const k of MOICA_ISSUERS) assert.ok(code.includes(k.modulus.slice(0, 64)), `MOICA's ${k.name} key`);
  for (const s of TEST_ONLY) assert.ok(!code.includes(s), `the deploy build contains ${JSON.stringify(s)}`);
  for (const s of ["PRIVATE KEY", "pkcs8"]) assert.ok(!code.includes(s), `the deploy build contains ${JSON.stringify(s)}`);
});

test("the test build holds the test's keys, the fake MOICA and the clock's switch in their place", () => {
  // So that the check above could fail: these are the strings it looks for.
  const code = codeOf("test", values);
  for (const s of [values.moica, ...values.issuers.map((i) => i.modulus.slice(0, 64)), "/__test/clock", "setTestClock"]) {
    assert.ok(code.includes(s), `the test build lacks ${JSON.stringify(s)}`);
  }
  assert.deepEqual(urlsIn(code).filter((u) => !u.startsWith(values.moica)), [], "the test build names no address but the fake MOICA's");
});
