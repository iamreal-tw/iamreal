// `pnpm local`: the whole card proof on this computer, with a real card,
// reader and MOICA's component, against the Worker in the local workerd.
//
//   pnpm local [--port 8080] [--data DIR]
//
// 1. the common reference string (web/scripts/fetch-crs.mjs, only what is
//    missing or differs is downloaded)
// 2. the page, built in web/'s mode "localcard" (web/src/target-local.ts:
//    MOICA's issuer keys, the component at http://localhost:61161, no fake
//    card and no test key, and the test roster's scope string
//    `iamreal-test:public:0__________`, so that a real card tried out here
//    gets no scoped ID of the public roster)
// 3. the Worker's build for this computer (local-build/index.ts: the deployed
//    Worker, and the bucket's files at /crl/… and /roster/…), started with
//    wrangler.jsonc's test environment (the test roster) and its Durable
//    Object and bucket kept in DIR
// 4. one round of the CRL mirror, against MOICA's real CRLs
// 5. the check that needs no card (test/site-check.ts, `local`): every page,
//    its headers, the card proof page, the CRL archive. No request goes to
//    MOICA's component; nothing here opens a browser
//
// and it serves the page at http://localhost:PORT/proof and the rest of the
// site at http://localhost:PORT/. Ctrl-C stops it. The mirror does not run
// again by itself: start it again for newer CRLs.
//
// DIR (default worker/local/) keeps the roster between runs; delete it to
// start from an empty roster. It is not web/local/, where the Go back end
// kept its roster, which this does not read or write. The requests to other
// hosts are the CRS download (only if web/crs/ lacks a file) and the
// mirror's download of MOICA's two CRLs.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { unstable_startWorker } from "wrangler";
import { runSiteCheck } from "../test/site-check.ts";
import { WORKER_DIR } from "./deploy.ts";
import { prepareEngineFiles } from "./engine-files.ts";
import { fetchCrs } from "./proof-page.ts";

const WEB_DIR = join(WORKER_DIR, "..", "web");
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const port = Number(opt("--port", "8080"));
const data = resolve(opt("--data", join(WORKER_DIR, "local")));
if (data === resolve(WEB_DIR, "local")) throw new Error("web/local/ is the Go back end's roster: give another --data");

console.log("1/5 the CRS (web/scripts/fetch-crs.mjs)");
fetchCrs();

console.log("2/5 the page (vite build --mode localcard)");
const site = join(data, "site");
rmSync(site, { recursive: true, force: true });
cpSync(join(WORKER_DIR, "site"), site, { recursive: true, filter: (source) => source !== join(WORKER_DIR, "site", "proof") });
const vite = join(WEB_DIR, "node_modules", ".bin", "vite");
const built = spawnSync(vite, ["build", "--mode", "localcard", "--outDir", join(site, "proof"), "--emptyOutDir", "--logLevel", "warn"], { cwd: WEB_DIR, stdio: "inherit" });
if (built.status !== 0) throw new Error("vite build --mode localcard in web/ failed");

console.log("3/5 the Worker (local-build/index.ts, wrangler.jsonc's test environment)");
prepareEngineFiles();
mkdirSync(join(data, "state"), { recursive: true });
// A copy of wrangler.jsonc, byte for byte, beside the site: its "assets.directory" (./site) is then DIR/site.
copyFileSync(join(WORKER_DIR, "wrangler.jsonc"), join(data, "wrangler.jsonc"));
const worker = await unstable_startWorker({
  config: join(data, "wrangler.jsonc"),
  env: "test",
  entrypoint: join(WORKER_DIR, "local-build", "index.ts"),
  dev: { persist: join(data, "state"), server: { hostname: "127.0.0.1", port }, inspector: false, watch: false, logLevel: "log", testScheduled: true },
});
await worker.ready;

console.log("4/5 the CRL mirror, once (MOICA's G2 and G3 CRLs)");
// wrangler's door to the schedule (`testScheduled`): the same handler the hourly trigger runs on Cloudflare.
const round = await fetch(`http://127.0.0.1:${port}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent("0 * * * *")}`);
console.log(`the mirror: HTTP ${round.status} ${(await round.text()).trim()}`);

console.log("5/5 the check that needs no card (test/site-check.ts)");
await runSiteCheck(`http://localhost:${port}`, `http://localhost:${port}`);

console.log(`serving http://localhost:${port}/proof, and the rest of the site at http://localhost:${port}/ (test roster; Ctrl-C to stop)`);
const stop = async (): Promise<void> => {
  await worker.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
