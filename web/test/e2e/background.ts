// A measurement, not a test: how much longer a card proof takes when its tab
// is in the background (research note 33 saw one single-threaded proof take
// 25 s instead of 9, and guessed the tab was not in front). Runs the engine's
// test page (page.ts: two card proofs with a fake card and a fake server, no
// clicks) in headless Chrome, once with its tab in front and once with
// another tab in front for the whole load, with and without cross-origin
// isolation, and prints the times.
//
//   node --experimental-strip-types test/e2e/background.ts [repetitions]
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { FakeBackend } from "../fixtures/backend.ts";
import { makeWorld, mirror, randomSerials } from "../fixtures/world.ts";
import { Browser, sleep } from "./cdp.ts";
import { CONTENT_SECURITY_POLICY, ISOLATION_HEADERS } from "./headers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..");
const out = join(web, "test-output", "background");
mkdirSync(out, { recursive: true });
const reps = Number(process.argv[2] ?? "2");

const dist = join(out, "dist");
await build({ root: here, configFile: join(web, "vite.config.ts"), mode: "engine", logLevel: "warn", build: { outDir: dist, emptyOutDir: true } });

const world = await makeWorld({ issuer: "G3" });
const files = new Map<string, Uint8Array>();
for (const f of await mirror(world, [{ serials: randomSerials(176_000, 7n), crlNumber: 4242n, thisUpdate: new Date(Date.now() - 6 * 3600_000) }])) files.set(f.path, f.bytes);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fixture = {
  certificates: [b64(world.encryptionCert), b64(world.signingCert)],
  cardKeyPkcs8: b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", world.card.privateKey))),
  pin: "123456",
  issuers: world.issuers.map((i) => ({ name: i.name, modulus: i.modulus.toString(16), bits: i.bits })),
  // Each request gets a new fake server (no proof log kept): both card proofs are a first declaration.
  runs: [{ threads: "alice" }, { threads: "alice" }],
};
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".gz": "application/gzip", ".dat": "application/octet-stream" };

let isolation: "dip" | "none" = "dip";
let resolveReport: (r: any) => void = () => undefined;
const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("Cache-Control", "no-store");
  if (isolation === "dip") for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
  if (path === "/__fixture.json") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(fixture));
  if (path === "/__report") {
    res.writeHead(204).end();
    return resolveReport(JSON.parse(body));
  }
  if (path.startsWith("/api/") || path.startsWith("/crl/")) {
    const backend = new FakeBackend({ files, clock: () => Date.now() });
    const a = await backend.handle(req.method ?? "GET", path, body);
    return res.writeHead(a.status, { "Content-Type": a.type }).end(Buffer.from(a.bytes));
  }
  const file = normalize(join(dist, path === "/" ? "index.html" : path));
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(bytes);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${(server.address() as AddressInfo).port}/`;

const rows: string[] = [];
for (const iso of ["dip", "none"] as const) {
  for (let rep = 0; rep < reps; rep++) {
    for (const tab of ["front", "background"] as const) {
      isolation = iso;
      const browser = await Browser.launch({ dir: out });
      const page = await browser.newPage();
      await page.send("Page.enable");
      if (tab === "background") {
        const other = await browser.newPage();
        await browser.send("Target.activateTarget", { targetId: other.targetId });
        await sleep(300);
      }
      const reported = new Promise<any>((r) => (resolveReport = r));
      void page.send("Page.navigate", { url });
      const visibility = await page.waitFor<string>("document.visibilityState", "the page");
      const report = await Promise.race([reported, sleep(300_000).then(() => ({ error: "timeout" }))]);
      await browser.close();
      if (report.error) {
        rows.push(`| ${iso} | ${tab} (${visibility}) | error: ${String(report.error).slice(0, 80)} | | | |`);
        continue;
      }
      const t = (step: string, run: number) => report.timings.find((x: any) => x.step === step && x.run === run)?.ms ?? "";
      rows.push(
        `| ${iso} | ${tab} (${visibility}) | ${report.engine.mode.threads} | ${report.engine.ms} | ${t("tree_build", 0)} / ${t("tree_build", 1)} | ${t("proof", 0)} / ${t("proof", 1)} | ${report.results.map((r: any) => r.ms).join(" / ")} |`,
      );
      console.log(rows.at(-1));
    }
  }
}
server.close();
console.log("\n| isolation | tab | threads | engine ready (ms) | tree (ms) | proof (ms) | card proof (ms) |\n|---|---|---|---|---|---|---|");
for (const r of rows) console.log(r);
