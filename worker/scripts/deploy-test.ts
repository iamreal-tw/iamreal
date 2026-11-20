// `pnpm run deploy:test`: uploads the test environment (the Worker
// `iamreal-test`) from this computer, with the token in the repository's
// `.env.local` that can deploy that Worker and no other (ADR-0029). It does
// not use `wrangler login`.
//
// The same two steps as the workflow (deploy.ts):
//
// 1. `buildDeploy`: the deploy build into a temporary directory, checked;
//    wrangler runs without the token. Before it, the proof verifier's files
//    are checked against their SHA-256 (engine-files.ts); a file that does
//    not match stops the deploy there.
// 2. The upload of that directory as it is (`uploadArgs`), with the token:
//    the two lines CLOUDFLARE_API_TOKEN_TEST and CLOUDFLARE_ACCOUNT_ID of
//    `.env.local`, given to wrangler as CLOUDFLARE_API_TOKEN and
//    CLOUDFLARE_ACCOUNT_ID.
//
// `pnpm run deploy:test --dry-run` does both and uploads nothing (and still
// wants the two lines).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_DIR, WRANGLER, buildDeploy, deployTokenOf, uploadArgs, wranglerEnv } from "./deploy.ts";

const ENV_FILE = join(WORKER_DIR, "..", ".env.local");

// The environment is always the test one: the only argument passed on is --dry-run.
const extra = process.argv.slice(2);
if (extra.some((a) => a !== "--dry-run")) throw new Error(`deploy-test takes no argument but --dry-run: ${extra.join(" ")}`);

let text: string;
try {
  text = readFileSync(ENV_FILE, "utf8");
} catch {
  throw new Error(`${ENV_FILE} is missing: it holds CLOUDFLARE_API_TOKEN_TEST and CLOUDFLARE_ACCOUNT_ID`);
}
const token = deployTokenOf(text);

const dir = mkdtempSync(join(tmpdir(), "iamreal-deploy-"));
let status = 1;
try {
  buildDeploy(dir);
  const r = spawnSync(WRANGLER, [...uploadArgs(join(dir, "index.js")), ...extra], { cwd: WORKER_DIR, stdio: "inherit", env: wranglerEnv(process.env, token) });
  status = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
