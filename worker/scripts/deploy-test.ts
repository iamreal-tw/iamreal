// `pnpm run deploy:test`: uploads the test environment (the Worker
// `iamreal-test`) from this computer, with the token in the repository's
// `.env.local` that can deploy that Worker and no other (ADR-0029). It does
// not use `wrangler login`.
//
// The same two steps as the workflow (deploy.ts):
//
// 1. `buildDeploy`: the deploy build into a temporary directory, checked.
//    Before it, the proof verifier's files are checked against their
//    SHA-256 (engine-files.ts); a file that does not match stops the deploy
//    there. All of this is done before `.env.local` is read, so the token
//    is not in this process yet. wrangler runs twice in it:
//    - as a command, to bundle: a child process whose environment has no
//      token and none of the shell's `CLOUDFLARE_*`, `CF_*`, `WRANGLER_*`
//      (deploy.ts, `wranglerEnv`);
//    - as a library in this process, to read wrangler.jsonc for one of the
//      checks (deploy-build-checks.ts, `configuredCpuMs`). This process has
//      the shell's environment as it is; that code reads the file and
//      sends nothing.
// 2. The upload of that directory as it is (`uploadArgs`), with the token:
//    the two lines CLOUDFLARE_API_TOKEN_TEST and CLOUDFLARE_ACCOUNT_ID of
//    `.env.local`, read only now, and given to the wrangler command as
//    CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in its environment.
//    They are never put into this process's own environment; wrangler's
//    library stays loaded in it but is not called again.
//
// `pnpm run deploy:test --dry-run` does both and uploads nothing (and still
// wants the two lines).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_DIR, WRANGLER, buildDeploy, deployTokenOf, uploadArgs, wranglerEnv } from "./deploy.ts";

const ENV_FILE = join(WORKER_DIR, "..", ".env.local");

// The environment is always the test one: the only argument passed on is --dry-run.
const extra = process.argv.slice(2);
if (extra.some((a) => a !== "--dry-run")) throw new Error(`deploy-test takes no argument but --dry-run: ${extra.join(" ")}`);

// Said before the build, which takes a while; the file is read after it.
if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} is missing: it holds CLOUDFLARE_API_TOKEN_TEST and CLOUDFLARE_ACCOUNT_ID`);

const dir = mkdtempSync(join(tmpdir(), "iamreal-deploy-"));
let status = 1;
try {
  buildDeploy(dir);
  const token = deployTokenOf(readFileSync(ENV_FILE, "utf8"));
  const r = spawnSync(WRANGLER, [...uploadArgs(join(dir, "index.js")), ...extra], { cwd: WORKER_DIR, stdio: "inherit", env: wranglerEnv(process.env, token) });
  status = r.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
