// `pnpm run deploy:test`: uploads the test environment (the Worker
// `iamreal-test`) from this computer, with the token in the repository's
// `.env.local` that can deploy that Worker and no other (ADR-0029). It does
// not use `wrangler login`.
//
// It reads two lines of `.env.local`, CLOUDFLARE_API_TOKEN_TEST and
// CLOUDFLARE_ACCOUNT_ID, and runs `wrangler deploy --env test` with them as
// CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. `pnpm run deploy:test
// --dry-run` builds without uploading (and still wants the two lines).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(WORKER_DIR, "..", ".env.local");

/** The value of `NAME=value` in the text of an env file; quotes around the value are dropped. */
function valueOf(text: string, name: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === name) {
      const value = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
      if (value !== "") return value;
    }
  }
  throw new Error(`${ENV_FILE} has no ${name}`);
}

let text: string;
try {
  text = readFileSync(ENV_FILE, "utf8");
} catch {
  throw new Error(`${ENV_FILE} is missing: it holds CLOUDFLARE_API_TOKEN_TEST and CLOUDFLARE_ACCOUNT_ID`);
}

// The environment is always the test one: the only argument passed on is --dry-run.
const extra = process.argv.slice(2);
if (extra.some((a) => a !== "--dry-run")) throw new Error(`deploy-test takes no argument but --dry-run: ${extra.join(" ")}`);

const { CLOUDFLARE_API_KEY: _key, CLOUDFLARE_EMAIL: _email, ...inherited } = process.env;
const r = spawnSync(join(WORKER_DIR, "node_modules", ".bin", "wrangler"), ["deploy", "--env", "test", ...extra], {
  cwd: WORKER_DIR,
  stdio: "inherit",
  env: {
    ...inherited,
    // Only this token: never a login or a token of the shell this runs in.
    CLOUDFLARE_API_TOKEN: valueOf(text, "CLOUDFLARE_API_TOKEN_TEST"),
    CLOUDFLARE_ACCOUNT_ID: valueOf(text, "CLOUDFLARE_ACCOUNT_ID"),
    WRANGLER_SEND_METRICS: "false",
  },
});
process.exit(r.status ?? 1);
