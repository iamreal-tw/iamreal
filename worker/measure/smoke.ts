// The measurement on this computer, small (README.md in this directory,
// "在本機先跑一次"): the measurement's build in the local workerd, with the
// configuration the deploy makes and a key of this run's own, and then every
// step of load.ts with --quick. Not a test (`pnpm test` does not run it); no
// request leaves this computer.
//
//   node --experimental-strip-types measure/smoke.ts
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unstable_startWorker } from "wrangler";
import { WORKER_DIR } from "../scripts/deploy.ts";
import { prepareEngineFiles } from "../scripts/engine-files.ts";
import { writeMeasureConfig } from "./config.ts";

mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
const dir = mkdtempSync(join(WORKER_DIR, "test-output", "measure-"));
const key = randomBytes(32).toString("hex");
let status = 1;
try {
  prepareEngineFiles();
  // Only here is the key a plain setting: on Cloudflare it is the secret the operator sets (deploy.ts, `secret`).
  const config = writeMeasureConfig(join(dir, "config"), { MEASURE_KEY: key });
  // wrangler compares the configuration with worker-configuration.d.ts of its working directory, made for the test environment.
  process.chdir(dir);
  const worker = await unstable_startWorker({ config, dev: { persist: join(dir, "state"), server: { hostname: "127.0.0.1", port: 0 }, inspector: false, watch: false, logLevel: "warn" } });
  try {
    const url = await worker.url;
    // Not spawnSync: the local server answers from this process's event loop.
    const child = spawn(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "load.ts"), url.toString(), "all", "--quick", "--any-colo"], { stdio: "inherit", env: { ...process.env, MEASURE_KEY: key } });
    status = await new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  } finally {
    await worker.dispose();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
