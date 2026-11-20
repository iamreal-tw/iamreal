// The two builds of the Worker, both made by `bundleWorker`
// (scripts/deploy.ts) as a wrangler dry run, which uploads nothing and
// needs no account:
//
// - "deploy": the build every deploy uploads, made the same way.
// - "test": the test build. The entry point is test-build/index.ts and
//   `#target` (package.json, "imports") is test-build/target.ts in place of
//   src/target.ts; the fake MOICA's address, the wait for it and the test's
//   issuer keys come in as `--define`.
//
// Both start, as deploying does, by putting the proof verifier's files into
// `generated/` after checking their SHA-256 (scripts/engine-files.ts):
// `bundleWorker` does that before every build.
//
// test/bundle.test.ts checks that the deploy build holds nothing of the
// test build.
import { WORKER_DIR, bundleWorker } from "../scripts/deploy.ts";
import type { IssuerKey } from "../src/issuers.ts";

export { WORKER_DIR };

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
  if (kind === "deploy") return bundleWorker(outDir);
  return bundleWorker(outDir, {
    entry: "test-build/index.ts",
    extraArgs: [
      "--alias",
      "#target:./test-build/target.ts",
      "--define",
      `__IAMREAL_TEST_MOICA__:${JSON.stringify(values!.moica)}`,
      "--define",
      `__IAMREAL_TEST_CRL_TIMEOUT_MS__:${JSON.stringify(values!.crlTimeoutMs)}`,
      "--define",
      `__IAMREAL_TEST_ISSUERS__:${JSON.stringify(values!.issuers)}`,
    ],
  });
}
