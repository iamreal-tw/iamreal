// A production build (vite.config.ts, mode "production") holds MOICA's
// issuer keys and the component's real address, and nothing of the tests:
// no fake card, no test issuer keys, no fake component.
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

test("a production build holds nothing of the tests", async () => {
  const out = join(web, "test-output", "build-check");
  rmSync(out, { recursive: true, force: true });
  await build({ root: web, configFile: join(web, "vite.config.ts"), mode: "production", logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  const code = filesUnder(out)
    .filter((f) => /\.(js|html|css)$/.test(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  assert.ok(code.length > 100_000, "the build has its scripts");
  // MOICA's component and issuer keys (the first hex digits of G2's and G3's moduli).
  assert.ok(code.includes("http://localhost:61161"), "the component's address");
  assert.ok(code.includes("9fd8089c05559d63d5ab34bc5df685fb") && code.includes("ae5ae964e29305a7dec0863d7f57aa66"), "MOICA's issuer keys");
  // The public roster's scope string (src/target.ts: the production roster).
  assert.ok(code.includes("iamreal:public:0_______________"), "the public roster's scope string");
  // Nothing of the fake card (src/card/fake.ts), the test target or the fake component.
  for (const s of ["the card signs 31 bytes", "__IAMREAL_TEST", "FakeCard", "fake-component", "testIssuer", "PRIVATE KEY", "pkcs8"]) {
    assert.ok(!code.includes(s), `the build contains ${JSON.stringify(s)}`);
  }
  // The only address outside the page's own origin is the component's.
  const urls = new Set([...code.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)].map((m) => m[0]));
  for (const u of urls) {
    // Names in comments of the libraries (licences, specifications) are not requests; the page's CSP
    // allows only its own origin (connect-src 'self'), so these could not be fetched anyway.
    if (u === "http://localhost:61161") continue;
    assert.ok(!/localhost|127\.0\.0\.1/.test(u), `the build names ${u}`);
  }
  rmSync(out, { recursive: true, force: true });
});
