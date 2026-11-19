// What `pnpm run deploy:test` (scripts/deploy-test.ts) is made of, apart
// from running it: the arguments it gives wrangler, how it reads the token,
// and the environment it runs wrangler in. test/build.ts makes the deploy
// build the tests look at from the same arguments and the same environment
// (plus `--dry-run`), so a change here is a change in what they check.

/** The arguments after `wrangler` that upload the test environment. */
export const DEPLOY_ARGS: readonly string[] = ["deploy", "--env", "test"];

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
  const valueOf = (name: string): string => {
    let value: string | undefined;
    for (const line of envFileText.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[1] === name) value = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
    }
    if (value === undefined || value === "") throw new Error(`.env.local has no ${name}`);
    return value;
  };
  return { token: valueOf("CLOUDFLARE_API_TOKEN_TEST"), accountId: valueOf("CLOUDFLARE_ACCOUNT_ID") };
}

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
  // No usage report to Cloudflare. No banner, and with it no question to
  // npm's registry about a newer wrangler (wrangler still asks when it
  // prints a warning about the configuration or fails unexpectedly).
  env.WRANGLER_SEND_METRICS = "false";
  env.WRANGLER_HIDE_BANNER = "true";
  if (token) {
    env.CLOUDFLARE_API_TOKEN = token.token;
    env.CLOUDFLARE_ACCOUNT_ID = token.accountId;
  }
  return env;
}
