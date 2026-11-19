// The two builds of the Worker, both made by wrangler as a dry run, which
// uploads nothing and needs no account:
//
// - "deploy": what `pnpm run deploy:test` uploads. The arguments and the
//   environment are that command's own (scripts/deploy.ts), with
//   `--dry-run --outdir` added and no token.
// - "test": the test build. The entry point is test-build/index.ts and
//   `#target` (package.json, "imports") is test-build/target.ts in place of
//   src/target.ts; the fake MOICA's address, the wait for it and the test's
//   issuer keys come in as `--define`.
//
// test/bundle.test.ts checks that the deploy build holds nothing of the
// test build.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPLOY_ARGS, wranglerEnv } from "../scripts/deploy.ts";
import type { IssuerKey } from "../src/issuers.ts";

export const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface TestBuildValues {
  /** The fake MOICA's origin. */
  readonly moica: string;
  readonly issuers: readonly IssuerKey[];
  /** How long the mirror waits for the fake MOICA, in milliseconds. */
  readonly crlTimeoutMs: number;
}

/** Makes a build in `outDir` and returns what wrangler printed (the bindings, among other things). */
export function buildWorker(kind: "deploy", outDir: string): string;
export function buildWorker(kind: "test", outDir: string, values: TestBuildValues): string;
export function buildWorker(kind: "deploy" | "test", outDir: string, values?: TestBuildValues): string {
  const args = [...DEPLOY_ARGS, "--dry-run", "--outdir", outDir];
  if (kind === "test") {
    args.splice(1, 0, "test-build/index.ts");
    args.push(
      "--alias",
      "#target:./test-build/target.ts",
      "--define",
      `__IAMREAL_TEST_MOICA__:${JSON.stringify(values!.moica)}`,
      "--define",
      `__IAMREAL_TEST_CRL_TIMEOUT_MS__:${JSON.stringify(values!.crlTimeoutMs)}`,
      "--define",
      `__IAMREAL_TEST_ISSUERS__:${JSON.stringify(values!.issuers)}`,
    );
  }
  const r = spawnSync(join(WORKER_DIR, "node_modules", ".bin", "wrangler"), args, { cwd: WORKER_DIR, encoding: "utf8", env: wranglerEnv(process.env) });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")}:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
