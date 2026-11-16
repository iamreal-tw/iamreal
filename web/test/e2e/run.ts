// The headless browser test: builds the test page, serves it on 127.0.0.1
// with the README's Content-Security-Policy and a fake server, runs the whole
// card proof in Chrome with a fake card, then checks
//
//   - every card proof finished, and the proof verifies with the native
//     `bb verify -t noir-recursive` against verifier/vk/, with public inputs
//     rebuilt here from the submitted record (spec/proof-verification.md);
//   - no Content-Security-Policy violation, no request the server does not know;
//   - the browser's storage holds the CRL number and nothing else.
//
//   IAMREAL_BB=/path/to/bb node test/e2e/run.ts [config ...]
//
// A config is ISSUER-ISOLATION[-tTHREADS], for example G3-dip, G3-none,
// G2-dip, G3-dip-t4. ISOLATION `dip` sends Document-Isolation-Policy (the
// page is cross-origin isolated: multithreaded proof); `none` does not
// (single thread). Default: G3-dip G3-none G2-dip.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { bytesOfBigint, concatBytes, limbs } from "../../src/bytes.ts";
import { CIRCUIT_OF_BITS, type IssuerName } from "../../src/issuers.ts";
import { CIRCUITS } from "../../src/prover/artifacts.ts";
import { currentTime, parseChallenge } from "../../src/spec/challenge.ts";
import { declarationCode } from "../../src/spec/declaration-code.ts";
import { fieldBytes, pack31 } from "../../src/spec/field.ts";
import { parseScopedId } from "../../src/spec/scoped-id.ts";
import { STORAGE_KEY_PREFIX } from "../../src/storage.ts";
import { FakeBackend } from "../fixtures/backend.ts";
import { makeWorld, mirror, randomSerials } from "../fixtures/world.ts";
import { CONTENT_SECURITY_POLICY, ISOLATION_HEADERS } from "./headers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..");
const repo = join(web, "..");
const out = join(web, "test-output");
const BB = process.env.IAMREAL_BB;
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!BB) throw new Error("set IAMREAL_BB to the bb 6.0.0 executable (verifier/README.md)");

const configs = (process.argv.slice(2).length ? process.argv.slice(2) : ["G3-dip", "G3-none", "G2-dip"]).map((c) => {
  const m = /^(G2|G3)-(dip|none)(?:-t(\d+))?$/.exec(c);
  if (!m) throw new Error(`config ${c}: ISSUER-ISOLATION[-tTHREADS]`);
  return { label: c, issuer: m[1] as IssuerName, isolation: m[2] as "dip" | "none", maxThreads: m[3] ? Number(m[3]) : undefined };
});

// README.md must quote the policy the test runs under.
if (!readFileSync(join(web, "README.md"), "utf8").includes(CONTENT_SECURITY_POLICY)) {
  throw new Error("README.md does not quote the Content-Security-Policy of test/e2e/headers.ts");
}

mkdirSync(out, { recursive: true });
const dist = join(out, "dist");
await build({ root: join(here), configFile: join(web, "vite.config.ts"), mode: "engine", logLevel: "warn", build: { outDir: dist, emptyOutDir: true } });

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".gz": "application/gzip", ".dat": "application/octet-stream" };
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok    " : "FAIL  "} ${what}`);
  if (!ok) failures++;
};

for (const cfg of configs) {
  console.log(`\n== ${cfg.label}`);
  const world = await makeWorld({ issuer: cfg.issuer });
  const crlTime = new Date(Date.now() - 6 * 3600_000);
  const files = new Map<string, Uint8Array>();
  // About the size of MOICA's CRLs: G3 about 176,000 entries, G2 about 340,000.
  const serials = randomSerials(cfg.issuer === "G3" ? 176_000 : 340_000, 7n);
  for (const f of await mirror(world, [{ serials, crlNumber: 4242n, thisUpdate: crlTime }])) files.set(f.path, f.bytes);
  const backend = new FakeBackend({ files, clock: () => Date.now() });
  const fixture = {
    certificates: [b64(world.encryptionCert), b64(world.signingCert)],
    cardKeyPkcs8: b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", world.card.privateKey))),
    pin: "123456",
    issuers: world.issuers.map((i) => ({ name: i.name, modulus: i.modulus.toString(16), bits: i.bits })),
    runs: [
      { action: "declare", username: "alice" },
      { action: "declare", username: "alice" },
    ],
    maxThreads: cfg.maxThreads,
  };
  const unknown: string[] = [];
  let resolveReport: (r: any) => void = () => undefined;
  const reported = new Promise<any>((r) => (resolveReport = r));

  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("Cache-Control", "no-store");
    if (cfg.isolation === "dip") for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
    if (path === "/__fixture.json") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(fixture));
    if (path === "/__report" && req.method === "POST") {
      res.writeHead(204).end();
      return resolveReport(JSON.parse(body));
    }
    if (path.startsWith("/api/") || path.startsWith("/crl/")) {
      const a = await backend.handle(req.method ?? "GET", path, body);
      return res.writeHead(a.status, { "Content-Type": a.type }).end(Buffer.from(a.bytes));
    }
    const file = normalize(join(dist, path === "/" ? "index.html" : path));
    if (!file.startsWith(dist)) return res.writeHead(404).end();
    try {
      const bytes = readFileSync(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(bytes);
    } catch {
      // The browser asks for a favicon by itself; the page does not.
      if (path !== "/favicon.ico") unknown.push(`${req.method} ${path}`);
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const profile = mkdtempSync(join(out, "profile-"));
  const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", `http://127.0.0.1:${port}/`], { stdio: "ignore" });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("no report within 300 s")), 300_000));
  let report: any;
  try {
    report = await Promise.race([reported, timeout]);
  } finally {
    chrome.kill();
    server.close();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(profile, { recursive: true, force: true });
  }
  writeFileSync(join(out, `e2e-${cfg.label}.json`), JSON.stringify(report, null, 2));
  if (report.error) {
    check(false, `page error: ${report.error}`);
    continue;
  }

  check(report.crossOriginIsolated === (cfg.isolation === "dip"), `crossOriginIsolated is ${report.crossOriginIsolated}`);
  const mode = report.engine.mode;
  check(mode.multithreaded === (cfg.isolation === "dip"), `engine: multithreaded ${mode.multithreaded}, threads ${mode.threads}, bb.js reported ${mode.reportedThreads}`);
  check(mode.reportedThreads === null || mode.reportedThreads === mode.threads, "bb.js started the threads the engine asked for");
  check(report.violations.length === 0, `no CSP violation ${JSON.stringify(report.violations)}`);
  check(unknown.length === 0, `no request the server does not know ${JSON.stringify(unknown)}`);

  // Storage: the CRL number of the issuer, nothing else.
  const st = report.storage;
  check(
    JSON.stringify(st.localStorage) === JSON.stringify({ [STORAGE_KEY_PREFIX + cfg.issuer]: "4242" }),
    `localStorage holds only the CRL number: ${JSON.stringify(st.localStorage)}`,
  );
  check(st.sessionStorage === 0 && st.indexedDB.length === 0 && st.caches.length === 0 && st.cookies === "", `nothing else stored: ${JSON.stringify({ ...st, localStorage: undefined })}`);

  // The record of each card proof: the proof verifies with the native bb.
  const issuer = world.issuers.find((i) => i.name === cfg.issuer)!;
  const circuit = CIRCUIT_OF_BITS[issuer.bits].circuit;
  for (const [i, r] of report.results.entries()) {
    check(r.ok, `card proof ${i + 1}: ${r.ok ? `${r.done.kind}, ${r.ms} ms` : JSON.stringify(r.stop)}`);
    if (!r.ok) continue;
    check(r.signed === 2 && r.name === "測試用戶", "the card signed twice; the name was read");
    const s = backend.submissions[i]!;
    check(JSON.stringify(s) === JSON.stringify(r.done.record), "the server got the record the page reports");
    check(s.circuit === CIRCUITS[circuit].vkSha256 && s.issuer === cfg.issuer && s.scope_string === "iamreal-test:threads:0_________", "circuit, issuer and scope string");
    const day = parseChallenge(s.challenge)!;
    const code = await declarationCode(s.action as "declare", s.scope_string as string, s.username as string, s.challenge as string);
    const pub = [
      ...limbs(issuer.modulus, 120, CIRCUIT_OF_BITS[issuer.bits].limbs),
      BigInt("0x" + s.smt_root),
      currentTime(day),
      parseScopedId(s.scoped_id as string)!,
      pack31(new TextEncoder().encode(s.scope_string as string)),
      pack31(code),
    ];
    const proof = Buffer.from(s.proof as string, "base64");
    check(proof.length === 14_656 && pub.length === CIRCUITS[circuit].publicInputs, `proof ${proof.length} bytes, ${pub.length} public inputs`);
    const dir = mkdtempSync(join(out, "verify-"));
    mkdirSync(join(dir, "crs"));
    // bb verify reads only the first G1 point, (1, 2) (spec/proof-verification.md, "The CRS").
    writeFileSync(join(dir, "crs", "bn254_g1.dat"), concatBytes(bytesOfBigint(1n, 32), bytesOfBigint(2n, 32)));
    writeFileSync(join(dir, "proof"), proof);
    writeFileSync(join(dir, "public_inputs"), concatBytes(...pub.map(fieldBytes)));
    const vk = join(repo, "verifier", "vk", `${circuit}.vk`);
    let verified = false;
    try {
      execFileSync(BB, ["verify", "-k", vk, "-p", join(dir, "proof"), "-i", join(dir, "public_inputs"), "-c", join(dir, "crs"), "-t", "noir-recursive"], { stdio: "pipe" });
      verified = true;
    } catch (e) {
      console.log(String((e as { stderr?: Buffer }).stderr ?? e).slice(-500));
    }
    check(verified, `bb verify -t noir-recursive with verifier/vk/${circuit}.vk`);
    // The same proof with one public input changed does not verify.
    writeFileSync(join(dir, "public_inputs"), concatBytes(...pub.map((x, k) => fieldBytes(k === pub.length - 1 ? x ^ 1n : x))));
    let rejected = false;
    try {
      execFileSync(BB, ["verify", "-k", vk, "-p", join(dir, "proof"), "-i", join(dir, "public_inputs"), "-c", join(dir, "crs"), "-t", "noir-recursive"], { stdio: "pipe" });
    } catch {
      rejected = true;
    }
    check(rejected, "the same proof with another declaration code does not verify");
    rmSync(dir, { recursive: true });
  }
  const t = (step: string, run = 0) => report.timings.filter((x: any) => x.step === step && x.run === run).map((x: any) => x.ms);
  console.log(
    `   times (ms): engine ready ${report.engine.ms} (bb.js ${t("engine_bb_backend", -1)}, CRS ${t("engine_crs_init", -1)}), ` +
      `CRL ${t("crl")}, tree workers ${t("tree_workers")}, ` +
      `tree ${t("tree_build")} / ${t("tree_build", 1)}, proof ${t("proof")} / ${t("proof", 1)}, ` +
      `card proof ${report.results.map((r: any) => r.ms).join(" / ")}; cores ${report.cores}`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
