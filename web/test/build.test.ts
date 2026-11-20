// A production build (vite.config.ts, mode "production") holds MOICA's
// issuer keys and the component's real address, the public roster's scope
// string, the data domain https://data.iamreal.tw (ADR-0027), and nothing of
// the tests: no fake card, no test issuer keys, no fake component, no test
// platform. The build for a real card on this computer (mode "localcard",
// `pnpm local`) holds MOICA's keys and the real component too and nothing
// of the tests, but signs the test roster's scope string and knows the test
// roster's platforms; it fetches the CRL from its own origin (the local
// server), so it names no data domain.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const web = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** The scripts, HTML and CSS of a build in `mode`. */
async function codeOf(mode: "production" | "localcard"): Promise<string> {
  const out = join(web, "test-output", `build-check-${mode}`);
  rmSync(out, { recursive: true, force: true });
  await build({ root: web, configFile: join(web, "vite.config.ts"), mode, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  const code = filesUnder(out)
    .filter((f) => /\.(js|html|css)$/.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  rmSync(out, { recursive: true, force: true });
  return code;
}

/** What both builds hold, and what neither does. `dataOrigin` is the one other origin the build may name, if any. */
function realCardOnly(code: string, mode: string, dataOrigin: string | null): void {
  assert.ok(code.length > 100_000, `${mode}: the build has its scripts`);
  // MOICA's component and issuer keys (the first hex digits of G2's and G3's moduli).
  assert.ok(code.includes("http://localhost:61161"), `${mode}: the component's address`);
  assert.ok(code.includes("9fd8089c05559d63d5ab34bc5df685fb") && code.includes("ae5ae964e29305a7dec0863d7f57aa66"), `${mode}: MOICA's issuer keys`);
  // Nothing of the fake card (src/card/fake.ts), the test target or the fake component.
  for (const s of ["the card signs 31 bytes", "__IAMREAL_TEST", "FakeCard", "fake-component", "testIssuer", "PRIVATE KEY", "pkcs8"]) {
    assert.ok(!code.includes(s), `${mode}: the build contains ${JSON.stringify(s)}`);
  }
  // The only addresses outside the page's own origin are the component's and the data domain's.
  const urls = new Set([...code.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)].map((m) => m[0]));
  for (const u of urls) {
    // Names in comments of the libraries (licences, specifications) are not requests; the page's CSP
    // allows only its own origin and the data domain, so these could not be fetched anyway.
    if (u === "http://localhost:61161" || u === dataOrigin) continue;
    assert.ok(!/localhost|127\.0\.0\.1|iamreal/.test(u), `${mode}: the build names ${u}`);
  }
  if (dataOrigin !== null) assert.ok(urls.has(dataOrigin), `${mode}: the data domain ${dataOrigin}`);
}

test("a production build holds nothing of the tests, and signs the public roster's scope string", async () => {
  const code = await codeOf("production");
  realCardOnly(code, "production", "https://data.iamreal.tw");
  assert.ok(code.includes("iamreal:public:0_______________"), "the public roster's scope string");
  // The test roster's second platform is not in it (src/presentations/test-example.ts).
  assert.ok(!code.includes("Example (no real service)"), "the production build has test-example's definition");
});

test("the local build (pnpm local): MOICA's keys and component, nothing of the tests, the test roster's scope string and platforms", async () => {
  const code = await codeOf("localcard");
  realCardOnly(code, "localcard", null);
  // The roster of src/target-local.ts: the test one. Both scope strings are in the table of
  // protocol/src/scope.ts; the target picks the test one (checked in Node below).
  assert.ok(code.includes("iamreal-test:public:0__________"), "the test roster's scope string");
  assert.ok(code.includes("Example (no real service)"), "the local build knows test-example");
});

test("the local target signs the test roster's scope string; the production target the public roster's", async () => {
  const local = await import("../src/target-local.ts");
  const production = await import("../src/target.ts");
  const { scopeOf } = await import("iamreal-protocol/scope.ts");
  assert.equal(scopeOf(local.ROSTER), "iamreal-test:public:0__________");
  assert.equal(scopeOf(production.ROSTER), "iamreal:public:0_______________");
  assert.deepEqual(local.ISSUERS, production.ISSUERS);
  assert.equal(local.COMPONENT_ORIGIN, production.COMPONENT_ORIGIN);
  assert.equal(local.IDLE_LIMIT_MS, production.IDLE_LIMIT_MS);
  // The CRL archive: on the data domain (ADR-0027); the local build's on the local server, its own origin.
  assert.equal(production.DATA_ORIGIN, "https://data.iamreal.tw");
  assert.equal(local.DATA_ORIGIN, "");
  assert.deepEqual(local.PRESENTATIONS.map((p) => p.platform), ["test-example", "threads"]);
  assert.deepEqual(production.PRESENTATIONS.map((p) => p.platform), ["threads"]);
});
