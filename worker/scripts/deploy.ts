// Deploying the test environment, in three steps that every way of
// deploying takes:
//
// 1. `buildSite()`: the card proof page, the test site's build of web/, put
//    into site/proof/ beside wrangler.jsonc and checked (proof-page.ts),
//    after the common reference string it carries is checked against its
//    SHA-256 (and downloaded, where there is none).
//    The other files of site/ (the style sheet, copy.js, _headers, _redirects) are
//    the repository's.
// 2. `buildDeploy(outDir)`: the deploy build of the Worker, bundled into a
//    directory by a wrangler dry run, with no token, then checked
//    (deploy-build-checks.ts). `bundleWorker` under it is the only place a
//    build of the Worker is made, the test build included (test/build.ts):
//    what has to happen before bundling (now: the proof verifier's files,
//    engine-files.ts) is done there and nowhere else.
// 3. `uploadArgs(entry)`: wrangler uploads that directory as it is
//    (`--no-bundle`), with the token. With it wrangler uploads the files
//    of Static Assets, which are not in that directory: it reads them from
//    site/ beside wrangler.jsonc (`assets.directory`), in the checkout it
//    runs in. Steps 1 and 2 checked which files are there and what they
//    hold (`checkProofPages`, `checkSiteFiles`).
//
// `pnpm run deploy:test` (deploy-test.ts) does all three on this computer.
// The workflow (.github/workflows/deploy-test.yml) runs build-deploy.ts
// (steps 1 and 2) in one job and the upload in another: the Worker's build
// and the page's build go from the first to the second as artifacts, the
// page's into site/proof/ of the second's checkout; the four files of
// site/ in the repository are that checkout's, at the same commit.
// test/workflows.test.ts checks that the workflow's lines are these
// arguments. Also here: how deploy-test.ts reads the token and the
// environment wrangler runs in.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClearedOn, checkDeployBuild, checkProofPages, configuredClearedOn, configuredProofPages } from "./deploy-build-checks.ts";
import { prepareEngineFiles } from "./engine-files.ts";
import { PROOF_DIR, buildProofPage, fetchCrs } from "./proof-page.ts";

export const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The arguments every wrangler command here shares.
 *
 * - `--config wrangler.jsonc`: that file and no other. Without it wrangler
 *   would follow a `.wrangler/deploy/config.json` to another one.
 * - `--env test`: the test environment, the only one this deploys.
 * - `--experimental-provision=false`: wrangler 4.160.1 otherwise asks
 *   Cloudflare whether each bound resource exists before it uploads, to
 *   create the ones that do not. The deploy token may not read R2
 *   (ADR-0029), that question is answered "Authentication error [code:
 *   10000]", and wrangler stops there (seen on the first deploy, 2026-11-19,
 *   when the Worker did not have the binding yet). The bucket is made in the
 *   dashboard, never by a deploy, so there is nothing to ask. The flag is a
 *   hidden one of wrangler, true by default; what is uploaded is the same
 *   with and without it. README.md, "第一次部署量到的", has the details.
 * - `--env-file=/dev/null`: wrangler 4.160.1 loads `.env`, `.env.local`,
 *   `.env.test` and `.env.test.local` from its working directory into its
 *   own environment when it starts, unless `--env-file` names the files to
 *   load instead (wrangler-dist/cli.js: `args["env-file"] ??
 *   getDefaultEnvFiles(args.env)`, then `loadDotEnv`). Such a file could set
 *   CLOUDFLARE_API_BASE_URL and have the token sent to another host. With
 *   /dev/null it loads nothing (test/deploy.test.ts).
 */
const WRANGLER_ARGS: readonly string[] = ["--config", "wrangler.jsonc", "--env", "test", ...wranglerSafeFlags()];

/** The two flags above that keep wrangler from making resources and from reading `.env` files: also the measurement's (measure/deploy.ts). */
export function wranglerSafeFlags(): string[] {
  return ["--experimental-provision=false", "--env-file=/dev/null"];
}

/** The arguments after `wrangler` that bundle the deploy build into `outDir` and upload nothing. */
export const buildArgs = (outDir: string): string[] => ["deploy", ...WRANGLER_ARGS, "--dry-run", "--outdir", outDir];

/**
 * The arguments after `wrangler` that upload a build made by `buildDeploy`:
 * `entry` is its `index.js`. wrangler takes the other modules of the
 * directory with it (Barretenberg's module, the verification keys), by its
 * rules for file types, and the bindings from wrangler.jsonc.
 */
export const uploadArgs = (entry: string): string[] => ["deploy", entry, "--no-bundle", ...WRANGLER_ARGS];

/** wrangler under node_modules. */
export const WRANGLER = join(WORKER_DIR, "node_modules", ".bin", "wrangler");

/**
 * Makes a build of the Worker in `outDir` with `wrangler deploy --dry-run`,
 * after putting the proof verifier's files into `generated/` (their SHA-256
 * checked: engine-files.ts). `entry` and `extraArgs` are the test build's
 * (test/build.ts); the deploy build has neither. Runs wrangler with no
 * token. Returns what wrangler printed (the bindings, among other things).
 */
export function bundleWorker(outDir: string, test?: { entry: string; extraArgs: readonly string[] }): string {
  prepareEngineFiles();
  const args = buildArgs(outDir);
  if (test) {
    args.splice(1, 0, test.entry);
    args.push(...test.extraArgs);
  }
  const r = spawnSync(WRANGLER, args, { cwd: WORKER_DIR, encoding: "utf8", env: wranglerEnv(process.env) });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

/** The environment these scripts deploy (`--env test` of WRANGLER_ARGS). */
const DEPLOYED_ENV = "test";

/**
 * Builds the card proof page of the test environment into site/proof/
 * (emptied first: whatever a computer had there is gone) and checks it;
 * throws if a check fails. The date beside the page's mark of a test
 * log is `TEST_PROOF_LOG_CLEARED_ON` of wrangler.jsonc, checked to be a
 * date before the build is given it. Before the build it has the common
 * reference string checked against its SHA-256, and downloaded if this
 * checkout has none (`fetchCrs`): the same on a computer and in the
 * workflow. It runs web/'s build and reads wrangler.jsonc; it has no token,
 * and that download is the only request it sends.
 */
export function buildSite(): void {
  const configured = configuredClearedOn();
  checkClearedOn(configured);
  fetchCrs();
  buildProofPage(PROOF_DIR, configured[DEPLOYED_ENV]!.clearedOn as string);
  checkProofPages(configuredProofPages());
}

/** The deploy build of the Worker in `outDir`, checked; throws if a check fails. Returns what wrangler printed. */
export function buildDeploy(outDir: string): string {
  const output = bundleWorker(outDir);
  checkDeployBuild(outDir, output);
  return output;
}

/** What deploying needs from `.env.local`. */
export interface DeployToken {
  /** CLOUDFLARE_API_TOKEN_TEST: can deploy the Worker `iamreal-test` and no other (ADR-0029). */
  readonly token: string;
  /** CLOUDFLARE_ACCOUNT_ID */
  readonly accountId: string;
}

/**
 * Reads the two lines out of the text of `.env.local`. A line is
 * `NAME=value`, with or without `export` before it and quotes around the
 * value; other lines are not looked at. If a name is there twice, the last
 * one counts. Throws, naming the variable and never a value, if one is
 * missing or empty.
 */
export function deployTokenOf(envFileText: string): DeployToken {
  return { token: envFileValue(envFileText, "CLOUDFLARE_API_TOKEN_TEST", ".env.local"), accountId: envFileValue(envFileText, "CLOUDFLARE_ACCOUNT_ID", ".env.local") };
}

/** The value of `name` in the text of an env file, read as `deployTokenOf` says; throws, naming `file` and the variable and never a value, if it is missing or empty. */
export function envFileValue(text: string, name: string, file: string): string {
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === name) value = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  if (value === undefined || value === "") throw new Error(`${file} has no ${name}`);
  return value;
}

/**
 * No usage report to Cloudflare. No banner, and with it no question to npm's
 * registry about a newer wrangler (wrangler still asks when it prints a
 * warning about the configuration or fails unexpectedly).
 */
export const WRANGLER_QUIET: Readonly<Record<string, string>> = { WRANGLER_SEND_METRICS: "false", WRANGLER_HIDE_BANNER: "true" };

/**
 * The environment wrangler runs in: the shell's, without any variable that
 * tells wrangler or Cloudflare's client where to send requests or who it is
 * (`CLOUDFLARE_*`, `CF_*`, `WRANGLER_*`), plus the ones set here. So a
 * `CLOUDFLARE_API_BASE_URL` or another token left in the shell does not
 * reach wrangler; with `token`, the only credential is that one.
 */
export function wranglerEnv(shell: Readonly<Record<string, string | undefined>>, token?: DeployToken): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(shell)) {
    if (value !== undefined && !/^(CLOUDFLARE_|CF_|WRANGLER_)/i.test(name)) env[name] = value;
  }
  Object.assign(env, WRANGLER_QUIET);
  if (token) {
    env.CLOUDFLARE_API_TOKEN = token.token;
    env.CLOUDFLARE_ACCOUNT_ID = token.accountId;
  }
  return env;
}
