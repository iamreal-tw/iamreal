// The two builds of the Worker, both made by wrangler without a network
// connection (`wrangler deploy --dry-run`):
//
// - "deploy": what `pnpm run deploy:test` uploads. The same command line
//   with `--dry-run --outdir`, nothing else.
// - "test": the test build. The entry point is test-build/index.ts and
//   `#target` (package.json, "imports") is test-build/target.ts in place of
//   src/target.ts; the fake MOICA's address and the test's issuer keys come
//   in as `--define`.
//
// test/bundle.test.ts checks that the deploy build holds nothing of the
// test build.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface TestIssuer {
  readonly name: "G2" | "G3";
  /** The RSA modulus, hex. */
  readonly modulus: string;
  readonly bits: 2048 | 4096;
}

export interface TestBuildValues {
  /** The fake MOICA's origin. */
  readonly moica: string;
  readonly issuers: readonly TestIssuer[];
}

/** The arguments after `wrangler` that upload the test environment, the same as in scripts/deploy-test.ts. */
export const DEPLOY_ARGS: readonly string[] = ["deploy", "--env", "test"];

export function buildWorker(kind: "deploy", outDir: string): void;
export function buildWorker(kind: "test", outDir: string, values: TestBuildValues): void;
export function buildWorker(kind: "deploy" | "test", outDir: string, values?: TestBuildValues): void {
  const args = [...DEPLOY_ARGS, "--dry-run", "--outdir", outDir];
  if (kind === "test") {
    args.splice(1, 0, "test-build/index.ts");
    args.push(
      "--alias",
      "#target:./test-build/target.ts",
      "--define",
      `__IAMREAL_TEST_MOICA__:${JSON.stringify(values!.moica)}`,
      "--define",
      `__IAMREAL_TEST_ISSUERS__:${JSON.stringify(values!.issuers)}`,
    );
  }
  const r = spawnSync(join(WORKER_DIR, "node_modules", ".bin", "wrangler"), args, {
    cwd: WORKER_DIR,
    encoding: "utf8",
    // A dry run sends nothing to Cloudflare; this turns off wrangler's usage report too.
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (r.status !== 0) throw new Error(`wrangler ${args.join(" ")}:\n${r.stdout}\n${r.stderr}`);
}
