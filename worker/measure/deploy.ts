// Deploys the measurement's temporary Worker, or sets its key (README.md in
// this directory). Run by the operator, on their computer, with a token they
// made that can deploy `iamreal-measure` and no other Worker:
//
//   node --experimental-strip-types measure/deploy.ts deploy --token-file <file>
//   node --experimental-strip-types measure/deploy.ts secret --token-file <file>
//
// <file> has two lines, CLOUDFLARE_API_TOKEN_MEASURE=… and
// CLOUDFLARE_ACCOUNT_ID=…, and is outside the repository. It is read after
// the configuration is made and checked, and its values go to wrangler's
// environment only (scripts/deploy.ts, `wranglerEnv`), never to this
// process's.
//
// - `deploy` makes the configuration from wrangler.jsonc (config.ts), which
//   names `iamreal-measure` or is refused, and runs `wrangler deploy` with
//   it. wrangler bundles measure-build/index.ts itself; the checks of the
//   deploy build (scripts/deploy-build-checks.ts) are not run, and would
//   refuse it.
// - `secret` runs `wrangler secret put MEASURE_KEY` for that Worker: wrangler
//   asks for the value and reads it from the terminal. This program never
//   sees it.
//
// The flags are the deploy's (scripts/deploy.ts, `WRANGLER_ARGS`): no other
// configuration file, wrangler reads no `.env` file, and it makes no
// resource (the buckets are the operator's, made in the dashboard).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WORKER_DIR, WRANGLER, wranglerEnv } from "../scripts/deploy.ts";
import { prepareEngineFiles } from "../scripts/engine-files.ts";
import { MEASURE_WORKER, writeMeasureConfig } from "./config.ts";

/** The two values of the token file. Throws, naming the variable and never a value, if one is missing or empty. */
export function measureTokenOf(text: string): { token: string; accountId: string } {
  const valueOf = (name: string): string => {
    let value: string | undefined;
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] === name) value = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
    }
    if (value === undefined || value === "") throw new Error(`the token file has no ${name}`);
    return value;
  };
  return { token: valueOf("CLOUDFLARE_API_TOKEN_MEASURE"), accountId: valueOf("CLOUDFLARE_ACCOUNT_ID") };
}

/** The arguments after `wrangler` for a command and the configuration at `config`. */
export function measureArgs(command: "deploy" | "secret", config: string): string[] {
  const common = ["--config", config, "--experimental-provision=false", "--env-file=/dev/null"];
  return command === "deploy" ? ["deploy", ...common] : ["secret", "put", "MEASURE_KEY", "--name", MEASURE_WORKER, ...common];
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename);
if (isMain) {
  const [command, flag, file, ...rest] = process.argv.slice(2);
  if ((command !== "deploy" && command !== "secret") || flag !== "--token-file" || file === undefined || rest.length > 0) {
    throw new Error("usage: measure/deploy.ts deploy|secret --token-file <file>");
  }
  const path = resolve(file);
  if (path.startsWith(resolve(WORKER_DIR, "..") + "/")) throw new Error("the token file is kept outside the repository");
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} can be read by others: chmod 600 it first`);
  const dir = mkdtempSync(join(tmpdir(), "iamreal-measure-"));
  let status = 1;
  try {
    if (command === "deploy") prepareEngineFiles();
    const config = writeMeasureConfig(dir);
    const token = measureTokenOf(readFileSync(path, "utf8"));
    const r = spawnSync(WRANGLER, measureArgs(command, config), { cwd: WORKER_DIR, stdio: "inherit", env: wranglerEnv(process.env, token) });
    status = r.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(status);
}
