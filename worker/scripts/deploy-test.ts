// `pnpm run deploy:test`: uploads the test environment (the Worker
// `iamreal-test`) from this computer, with the token in the repository's
// `.env.local` that can deploy that Worker and no other (ADR-0029). It does
// not use `wrangler login`.
//
// It reads two lines of `.env.local`, CLOUDFLARE_API_TOKEN_TEST and
// CLOUDFLARE_ACCOUNT_ID, and runs `wrangler deploy --env test` with them as
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (scripts/deploy.ts).
// `pnpm run deploy:test --dry-run` builds without uploading (and still
// wants the two lines).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOY_ARGS, deployTokenOf, wranglerEnv } from "./deploy.ts";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
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

const r = spawnSync(join(WORKER_DIR, "node_modules", ".bin", "wrangler"), [...DEPLOY_ARGS, ...extra], {
  cwd: WORKER_DIR,
  stdio: "inherit",
  env: wranglerEnv(process.env, deployTokenOf(text)),
});
process.exit(r.status ?? 1);
