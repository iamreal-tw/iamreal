// The headless browser test of the engine: builds the engine's test page,
// serves it on 127.0.0.1 with the README's Content-Security-Policy in front
// of the Worker (worker/) in the local workerd, runs the whole card proof in
// Chrome with a fake card, then checks
//
//   - every card proof finished: the Worker verified the proof with the
//     verifier it is deployed with and wrote the record the page reports;
//   - the proof verifies with the native `bb verify -t noir-recursive` too,
//     against verifier/vk/, with public inputs rebuilt here from the record
//     (spec/proof-verification.md);
//   - no Content-Security-Policy violation, no request nothing answers;
//   - the browser's storage holds the CRL number, the card proof device ID
//     with its date, and nothing else;
//   - the submissions carried that device ID (the Worker's connection log),
//     and the Worker took the page's counts: every step of each card proof,
//     each a count of the table, under that device ID.
//
//   IAMREAL_BB=/path/to/bb node test/e2e/run.ts [config ...]
//
// A config is ISSUER-ISOLATION[-tTHREADS], for example G3-dip, G3-none,
// G2-dip, G3-dip-t4. ISOLATION `dip` sends Document-Isolation-Policy (the
// page is cross-origin isolated: multithreaded proof); `none` does not
// (single thread). Default: G3-dip G3-none G2-dip.
//
// The back end is the Worker's test build (worker-site.ts): the issuer keys
// are the test's, the CRLs come from a fake MOICA through the Worker's own
// mirror, and the page gets the CRL archive from a server in the place of
// the data domain. No Go program is built or started.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { bytesOfBigint, concatBytes, limbs } from "iamreal-protocol/bytes.ts";
import { CIRCUIT_OF_BITS, type IssuerName } from "../../src/issuers.ts";
import { CIRCUITS } from "../../src/prover/artifacts.ts";
import { currentTime, parseChallenge } from "iamreal-protocol/challenge.ts";
import { declarationCode } from "iamreal-protocol/declaration-code.ts";
import { fieldBytes, pack31 } from "iamreal-protocol/field.ts";
import { parseScopedId } from "iamreal-protocol/scoped-id.ts";
import { readCount } from "iamreal-protocol/counts.ts";
import { DEVICE_ID_KEY } from "../../src/counts.ts";
import { STORAGE_KEY_PREFIX } from "../../src/storage.ts";
import { makeCrl } from "../fixtures/crls.ts";
import { makeWorld, randomSerials, testIssuerKeys } from "../fixtures/world.ts";
import { CONTENT_SECURITY_POLICY, ISOLATION_HEADERS } from "./headers.ts";
import { startWorkerSite } from "./worker-site.ts";

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

const SCOPE = "iamreal-test:public:0__________";
/** The rows each card proof changes (page.ts), the list it signs, and what the server records on each platform. */
const RUNS: Record<string, string>[] = [{ "test-example": "a-b", threads: "alice" }, { "test-example": "" }];
const EXPECTED = [
  {
    accounts: [
      { platform: "test-example", username: "a-b" },
      { platform: "threads", username: "alice" },
    ],
    kinds: "test-example first a-b, threads first alice",
  },
  { accounts: [{ platform: "threads", username: "alice" }], kinds: "test-example withdraw a-b, threads refresh alice" },
];
const kindsText = (kinds: { platform: string; kind: string; username: string }[] | null) => (kinds === null ? "(none)" : kinds.map((k) => `${k.platform} ${k.kind} ${k.username}`).join(", "));

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".gz": "application/gzip", ".dat": "application/octet-stream" };
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok    " : "FAIL  "} ${what}`);
  if (!ok) failures++;
};

// The two CRLs the fake MOICA serves, one per issuer key, each with one number: an issuer the configs use has
// about as many entries as MOICA's (G3 about 176,000, G2 about 340,000), the other a few.
const issuerKeys = await testIssuerKeys();
const issuers = [
  { name: "G2" as const, modulus: issuerKeys.G2.modulus.toString(16), bits: 2048 as const },
  { name: "G3" as const, modulus: issuerKeys.G3.modulus.toString(16), bits: 4096 as const },
];
const CRL_NUMBER = 4242n;
const crlTime = new Date(Date.now() - 6 * 3600_000);
const used = (issuer: IssuerName): boolean => configs.some((c) => c.issuer === issuer);
const crls = {
  G2: await makeCrl({ issuer: issuerKeys.G2, serials: randomSerials(used("G2") ? 340_000 : 2_000, 7n), crlNumber: CRL_NUMBER, thisUpdate: crlTime }),
  G3: await makeCrl({ issuer: issuerKeys.G3, serials: randomSerials(used("G3") ? 176_000 : 2_000, 7n), crlNumber: CRL_NUMBER, thisUpdate: crlTime }),
};

/** What the server in front of the Worker answers itself for the config that is running: the engine's test page, its fixture, its report. */
let current: { isolation: "dip" | "none"; fixture: unknown; report: (r: any) => void; unknown: string[] } | null = null;
const site = await startWorkerSite({
  issuers,
  // Reading a CRL of MOICA's size from the fake MOICA takes longer than the harness's 2 seconds on a busy computer.
  crlTimeoutMs: 60_000,
  own(req, res, path) {
    // The API and the data domain's files are not this server's.
    if (current === null || path.startsWith("/api/") || path.startsWith("/crl/") || path.startsWith("/proof-log/")) return false;
    const cfg = current;
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("Cache-Control", "no-store");
    if (cfg.isolation === "dip") for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
    if (path === "/__fixture.json") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(cfg.fixture)), true;
    if (path === "/__report" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(204).end();
        cfg.report(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      });
      return true;
    }
    const file = normalize(join(dist, path === "/" ? "index.html" : decodeURIComponent(path)));
    try {
      if (!file.startsWith(dist)) throw new Error("outside the build");
      const bytes = readFileSync(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" }).end(bytes);
    } catch {
      // The site's icon, which the page links to (index.html) and the Worker's Static Assets send; this server has none.
      if (path !== "/favicon.ico") cfg.unknown.push(`${req.method} ${path}`);
      res.writeHead(404).end();
    }
    return true;
  },
});
const { worker } = site;

try {
  // The Worker's hourly schedule mirrors the two CRLs from the fake MOICA into its bucket.
  worker.moica.serve("G2", crls.G2);
  worker.moica.serve("G3", crls.G3);
  const round = await worker.runSchedule();
  const index = new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]?.bytes ?? new Uint8Array());
  check(round.outcome === "ok" && index.split("\n").filter(Boolean).length === 2, `the Worker's schedule mirrored the two CRLs (${round.outcome})`);

  /** The card proof device ID of each config's browser profile. */
  const devices: string[] = [];
  for (const cfg of configs) {
    console.log(`\n== ${cfg.label}`);
    const world = await makeWorld({ issuer: cfg.issuer });
    const fixture = {
      certificates: [b64(world.encryptionCert), b64(world.signingCert)],
      cardKeyPkcs8: b64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", world.card.privateKey))),
      pin: "123456",
      issuers,
      // A first declaration of two accounts, then a list without one of them
      // (its withdrawal) on the same page load. The Worker keeps the proof log,
      // so the second card proof sees the first.
      runs: RUNS,
      maxThreads: cfg.maxThreads,
    };
    const unknown: string[] = [];
    let resolveReport: (r: any) => void = () => undefined;
    const reported = new Promise<any>((r) => (resolveReport = r));
    current = { isolation: cfg.isolation, fixture, report: resolveReport, unknown };
    site.notFound.length = 0;
    const before = (await worker.proofLog.stored()).proofLog.count;

    const profile = mkdtempSync(join(out, "profile-"));
    const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", `${site.origin}/`], { stdio: "ignore" });
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("no report within 300 s")), 300_000));
    let report: any;
    try {
      report = await Promise.race([reported, timeout]);
    } finally {
      chrome.kill();
      await new Promise((r) => setTimeout(r, 500));
      rmSync(profile, { recursive: true, force: true });
    }
    unknown.push(...site.notFound.filter((r) => r !== "GET /favicon.ico"));
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
    check(unknown.length === 0, `no request that neither the test page's server nor the Worker has an answer for ${JSON.stringify(unknown)}`);

    // Storage: the CRL number of the issuer and the card proof device ID with the date it was made on, nothing else.
    const st = report.storage;
    const device = /^([0-9a-f]{32})\.\d{4}-\d{2}-\d{2}$/.exec(String(st.localStorage?.[DEVICE_ID_KEY]))?.[1] ?? null;
    check(
      device !== null && JSON.stringify({ ...st.localStorage, [DEVICE_ID_KEY]: undefined }) === JSON.stringify({ [STORAGE_KEY_PREFIX + cfg.issuer]: String(CRL_NUMBER) }),
      `localStorage holds only the CRL number and the card proof device ID: ${JSON.stringify(st.localStorage)}`,
    );
    if (device !== null) devices.push(device);
    // The submissions carried it: the connection log's entries of this config's records (ADR-0039).
    const submitted = (await worker.connectionLog()).filter((o) => o.key.startsWith("connection/") && typeof o.entry.seq === "number" && o.entry.seq > before);
    check(submitted.length === RUNS.length && submitted.every((o) => o.entry.device_id === device), `each submission carried the card proof device ID (${submitted.length} entries of the connection log)`);
    check(st.sessionStorage === 0 && st.indexedDB.length === 0 && st.caches.length === 0 && st.cookies === "", `nothing else stored: ${JSON.stringify({ ...st, localStorage: undefined })}`);

    // The record of each card proof: the proof verifies with the native bb.
    // What the Worker wrote to the proof log during this config, in order: the lines of its records.
    const written = (await worker.proofLog.stored()).records.filter((r) => r.seq > before);
    check(written.length === RUNS.length, `the Worker wrote ${written.length} records to the proof log`);
    const issuer = world.issuers.find((i) => i.name === cfg.issuer)!;
    const circuit = CIRCUIT_OF_BITS[issuer.bits].circuit;
    for (const [i, r] of report.results.entries()) {
      check(r.ok, `card proof ${i + 1}: ${r.ok ? `${kindsText(r.done.kinds)}, ${r.ms} ms` : JSON.stringify(r.stop)}`);
      if (!r.ok) continue;
      check(r.signed === 2 && r.name === "測試用戶", "the card signed twice; the name was read");
      const s = r.done.record;
      check(r.done.seq === before + i + 1 && written[i]?.line === `${JSON.stringify({ seq: r.done.seq, ...s })}\n`, `the Worker verified the proof and wrote the record the page reports, as record ${r.done.seq}`);
      check(s.circuit === CIRCUITS[circuit].vkSha256 && s.issuer === cfg.issuer && s.scope_string === SCOPE, "circuit, issuer and scope string");
      const want = EXPECTED[i]!;
      check(JSON.stringify(s.accounts) === JSON.stringify(want.accounts), `the list, in byte order: ${JSON.stringify(s.accounts)}`);
      check(kindsText(r.done.kinds) === want.kinds && r.done.mismatches.length === 0, `what the server recorded is what the page said before signing: ${kindsText(r.done.kinds)}`);
      const day = parseChallenge(s.challenge)!;
      // The declaration code of the whole list (spec/declaration-code.md), rebuilt here from the record.
      const code = await declarationCode(s.scope_string as string, s.accounts as { platform: string; username: string }[], s.challenge as string);
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
  // The counts (ADR-0032): the Worker writes a minute's counts when the minute is over, so wait for the clock's next one.
  // Three seconds into it: the object's own timer, a second in, has written by then.
  await new Promise((r) => setTimeout(r, 63_000 - (Date.now() % 60_000)));
  await worker.ringCounts();
  const counted = (await worker.connectionLog()).filter((o) => o.key.startsWith("count-events/")).flatMap((o) => (o.entry as { counts: Record<string, string>[] }).counts);
  check(counted.length > 0 && counted.every((c) => JSON.stringify(readCount(c)) === JSON.stringify(c) && c.client === "web"), `the Worker took ${counted.length} counts, each one of the table's`);
  for (const device of devices) {
    const own = counted.filter((c) => c.device_id === device);
    const attempts = [...new Set(own.map((c) => c.attempt_id!))];
    const stepsOf = (attempt: string): string[] => own.filter((c) => c.attempt_id === attempt && c.event === "step").map((c) => c.step!);
    check(
      attempts.length === RUNS.length && attempts.every((a) => ["read", "certificates", "certificate", "config", "circuit", "engine", "crl", "tree", "checked", "pin", "scope_signed", "state", "chosen", "confirmed", "challenge", "code_signed", "proved", "done"].every((s) => stepsOf(a).includes(s))),
      `a device's counts: ${attempts.length} card proofs, each with every step up to done (${attempts.map((a) => stepsOf(a).length).join(" / ")} steps)`,
    );
    check(own.every((c) => c.event === "step" || c.event === "duration"), "no card proof stopped: every count is a step or a duration");
    // The card reader's name reached the Worker: in every count of a card proof from its certificates on, in none before.
    check(
      // By step, not by order: the counts are sent without waiting, and may arrive in any order.
      attempts.every((a) => own.filter((c) => c.attempt_id === a).every((c) => (c.event === "step" && ["open", "read", "component"].includes(c.step!) ? c.reader === undefined : c.reader === "Fake Reader 0"))),
      "a device's counts: the card reader's name in each count once the card was read",
    );
    // Each card proof: how long the CRL, the tree and the proof took, each once, as a duration of the table.
    const durationsOf = (attempt: string): string[] => own.filter((c) => c.attempt_id === attempt && c.event === "duration").map((c) => `${c.step} ${c.took}`);
    check(
      attempts.every((a) => JSON.stringify(durationsOf(a).map((d) => d.split(" ")[0]).sort()) === JSON.stringify(["crl", "proved", "tree"])),
      `a device's counts: each card proof's three durations (${attempts.map((a) => durationsOf(a).join(", ")).join(" / ")})`,
    );
  }
} finally {
  await site.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
