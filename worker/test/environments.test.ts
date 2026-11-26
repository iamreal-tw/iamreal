// The settings of each environment in wrangler.jsonc, read the way wrangler
// reads them: which proof log the environment serves, the name of its proof log's
// object and its data bucket belong together. A change that makes the test
// site serve the production log, or write into another bucket, fails
// here, before it is merged and deployed.
//
// It also holds the CPU time the environment gives one invocation
// (`limits.cpu_ms`) to what a round of the CRL mirror counts on
// (src/round-budget.ts).
//
// And the files of Static Assets are routed and headed as the proof log of the
// environment needs (`checkSiteFiles`): the card proof page's files never
// run the Worker, and only a test log's site says noindex.
//
// This is the first of two guards. The second is in the Worker
// (src/settings.ts): at every request it checks that `PROOF_LOG_KIND` and
// `PROOF_LOG_OBJECT_NAME` fit each other, which also holds for a deploy from a
// computer with a configuration that never went through a pull request.
//
// There is one environment so far. **When the production environment is
// added, it gets its own entry in ENVIRONMENTS below**: kind "production",
// an object name that does not start with `test-`, and its own bucket.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { type ConfiguredSite, checkClearedOn, checkCpuLimit, checkSiteFiles, configuredClearedOn, configuredCpuMs, configuredSites, sha256InHead } from "../scripts/deploy-build-checks.ts";
import { RUN_WORKER_FIRST, SITE_FILES, SITE_REDIRECTS, siteHeaders } from "../scripts/site-files.ts";
import { CRL_CATCH_UP_MS, RESERVED_FOR_LARGEST_CRL_MS, ROUND_CPU_MS } from "../src/round-budget.ts";
import { WORKER_DIR } from "./build.ts";

/** What an environment's settings must be. */
interface Expected {
  readonly kind: "test" | "production";
  /** Whether the name of the proof log's object starts with `test-`: a test log's does, the production log's does not. */
  readonly objectNamedAsTest: boolean;
  readonly bucket: string;
  /** The bucket the connection log is written to (ADR-0022): another one than the public data's. */
  readonly logs: string;
}

const ENVIRONMENTS: Readonly<Record<string, Expected>> = {
  test: { kind: "test", objectNamedAsTest: true, bucket: "iamreal-test-data", logs: "iamreal-test-logs" },
};

/** The part of an environment's configuration this file looks at. */
interface Settings {
  readonly vars: Readonly<Record<string, unknown>>;
  readonly r2_buckets: readonly { readonly binding: string; readonly bucket_name?: string }[];
}

/** What is wrong with an environment's settings; empty if nothing. */
function problems(settings: Settings, expected: Expected): string[] {
  const out: string[] = [];
  const { PROOF_LOG_KIND: kind, PROOF_LOG_OBJECT_NAME: name } = settings.vars;
  if (kind !== expected.kind) out.push(`PROOF_LOG_KIND is not ${expected.kind}`);
  if (typeof name !== "string" || name.length <= "test-".length || name.startsWith("test-") !== expected.objectNamedAsTest) {
    out.push(`PROOF_LOG_OBJECT_NAME ${expected.objectNamedAsTest ? "does not start" : "starts"} with test-`);
  }
  const buckets = settings.r2_buckets.map((b) => `${b.binding}=${b.bucket_name}`);
  const wanted = [`DATA=${expected.bucket}`, `CONNECTION_LOG=${expected.logs}`];
  if (buckets.length !== 2 || buckets[0] !== wanted[0] || buckets[1] !== wanted[1]) out.push(`the buckets are not ${wanted.join(" and ")}`);
  return out;
}

/** The SHA-256 of a file as this commit holds it, by its path from the repository's root, read with git itself. */
const inHead = (path: string): string => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return createHash("sha256").update(execFileSync("git", ["show", `HEAD:${path}`], { cwd: WORKER_DIR, env })).digest("hex");
};

const read = (env: string): Settings => unstable_readConfig({ config: join(WORKER_DIR, "wrangler.jsonc"), env }) as unknown as Settings;

for (const [env, expected] of Object.entries(ENVIRONMENTS)) {
  test(`the ${env} environment serves the ${expected.kind} log, on an object named for it, with its own bucket`, () => {
    assert.deepEqual(problems(read(env), expected), []);
  });
}

test("the environments of wrangler.jsonc are the ones checked here", () => {
  const { rawConfig } = experimental_readRawConfig({ config: join(WORKER_DIR, "wrangler.jsonc") });
  assert.deepEqual(Object.keys(rawConfig.env ?? {}).sort(), Object.keys(ENVIRONMENTS).sort());
  // The top level has no proof log of its own: no setting and no bucket (README.md, "設定檔").
  assert.equal(rawConfig.vars, undefined);
  assert.equal(rawConfig.r2_buckets, undefined);
});

test("altered copies of the test environment's settings are turned away, each for its own reason", () => {
  const real = read("test");
  const expected = ENVIRONMENTS.test!;
  const withVars = (vars: Record<string, unknown>): Settings => ({ ...real, vars: { ...real.vars, ...vars } });
  const BUCKETS = "the buckets are not DATA=iamreal-test-data and CONNECTION_LOG=iamreal-test-logs";
  const cases: [string, Settings, string[]][] = [
    ["the production log", withVars({ PROOF_LOG_KIND: "production" }), ["PROOF_LOG_KIND is not test"]],
    ["no kind", { ...real, vars: { PROOF_LOG_OBJECT_NAME: real.vars.PROOF_LOG_OBJECT_NAME } }, ["PROOF_LOG_KIND is not test"]],
    ["an object not named as a test one", withVars({ PROOF_LOG_OBJECT_NAME: "proof-log-1" }), ["PROOF_LOG_OBJECT_NAME does not start with test-"]],
    ["an object named in another case", withVars({ PROOF_LOG_OBJECT_NAME: "Test-1" }), ["PROOF_LOG_OBJECT_NAME does not start with test-"]],
    ["an object named `test-` and nothing more", withVars({ PROOF_LOG_OBJECT_NAME: "test-" }), ["PROOF_LOG_OBJECT_NAME does not start with test-"]],
    ["another bucket", { ...real, r2_buckets: [{ binding: "DATA", bucket_name: "iamreal-data" }, real.r2_buckets[1]!] }, [BUCKETS]],
    ["a third bucket", { ...real, r2_buckets: [...real.r2_buckets, { binding: "OTHER", bucket_name: "iamreal-data" }] }, [BUCKETS]],
    ["no bucket for the connection log", { ...real, r2_buckets: [real.r2_buckets[0]!] }, [BUCKETS]],
    ["the connection log in the bucket of the public data", { ...real, r2_buckets: [real.r2_buckets[0]!, { binding: "CONNECTION_LOG", bucket_name: "iamreal-test-data" }] }, [BUCKETS]],
    ["the connection log in a production bucket", { ...real, r2_buckets: [real.r2_buckets[0]!, { binding: "CONNECTION_LOG", bucket_name: "iamreal-logs" }] }, [BUCKETS]],
    ["the production log on its own object", withVars({ PROOF_LOG_KIND: "production", PROOF_LOG_OBJECT_NAME: "proof-log-1" }), ["PROOF_LOG_KIND is not test", "PROOF_LOG_OBJECT_NAME does not start with test-"]],
  ];
  for (const [name, settings, want] of cases) assert.deepEqual(problems(settings, expected), want, name);
});

test("every environment gives one invocation 300,000 ms of CPU time, which is what a round of the CRL mirror counts on", () => {
  assert.equal(ROUND_CPU_MS, 300_000);
  // Each read the way wrangler reads it for `--env <name>`, which is how it is uploaded (scripts/deploy.ts).
  assert.deepEqual(configuredCpuMs(), Object.fromEntries(Object.keys(ENVIRONMENTS).map((env) => [env, 300_000])));
  checkCpuLimit(configuredCpuMs());
  // Set once, at the top level, which every environment shares: an environment added later has it without repeating it.
  const { rawConfig } = experimental_readRawConfig({ config: join(WORKER_DIR, "wrangler.jsonc") });
  assert.deepEqual(rawConfig.limits, { cpu_ms: 300_000 });
  for (const [env, settings] of Object.entries(rawConfig.env ?? {})) assert.equal((settings as { limits?: unknown }).limits, undefined, `env.${env} has no limits of its own`);
});

test("a configuration in which an environment has another CPU time than the mirror counts on, or none, is turned away", () => {
  for (const other of [undefined, 30_000, 299_999, 300_001, 900_000]) {
    assert.throws(() => checkCpuLimit({ test: other }), /limits\.cpu_ms of the test environment/, String(other));
    // One environment with the right number does not make up for another.
    assert.throws(() => checkCpuLimit({ test: 300_000, production: other }), /limits\.cpu_ms of the production environment/, String(other));
  }
  // And a configuration with no environment has nothing that was checked.
  assert.throws(() => checkCpuLimit({}), /has an environment/);
});

test("every environment sends the files of site/ past the Worker, with the headers of its kind of proof log", () => {
  const sites = configuredSites();
  assert.deepEqual(Object.keys(sites).sort(), Object.keys(ENVIRONMENTS).sort());
  for (const [env, expected] of Object.entries(ENVIRONMENTS)) {
    assert.deepEqual(sites[env], {
      kind: expected.kind,
      runWorkerFirst: ["/*", "!/copy.js", "!/demo.js", "!/favicon.ico", "!/fonts/*", "!/og-image.png", "!/pages.css", "!/proof", "!/proof/*"],
      binding: undefined,
      htmlHandling: "none",
      notFoundHandling: "none",
      headers: siteHeaders(expected.kind),
      redirects: SITE_REDIRECTS,
      // Without site/proof/, where a deploy builds the card proof page: that build is `configuredProofPages`'s to read
      // (test/proof-page.test.ts), and one left there by a deploy build made on this computer changes nothing here.
      files: ["_headers", "_redirects", "copy.js", "demo.js", "favicon.ico", "fonts/GenRyuMin2TW-B.woff2", "og-image.png", "pages.css"],
      // What it uploads is what this commit holds: the two files as they are in HEAD, byte for byte.
      styleSheetSha256: inHead("worker/site/pages.css"),
      committedStyleSheetSha256: inHead("worker/site/pages.css"),
      scriptSha256: inHead("worker/site/copy.js"),
      committedScriptSha256: inHead("worker/site/copy.js"),
      demoSha256: inHead("worker/site/demo.js"),
      committedDemoSha256: inHead("worker/site/demo.js"),
      faviconSha256: inHead("worker/site/favicon.ico"),
      committedFaviconSha256: inHead("worker/site/favicon.ico"),
      fontSha256: createHash("sha256").update(readFileSync(join(WORKER_DIR, "..", "design", "fonts", "GenRyuMin2TW-B.woff2"))).digest("hex"),
      ogImageSha256: createHash("sha256").update(readFileSync(join(WORKER_DIR, "..", "design", "screens", "og-image.png"))).digest("hex"),
    });
  }
  assert.deepEqual(RUN_WORKER_FIRST, ["/*", "!/copy.js", "!/demo.js", "!/favicon.ico", "!/fonts/*", "!/og-image.png", "!/pages.css", "!/proof", "!/proof/*"]);
  assert.deepEqual(SITE_FILES, ["_headers", "_redirects", "copy.js", "demo.js", "favicon.ico", "fonts/GenRyuMin2TW-B.woff2", "og-image.png", "pages.css"]);
  checkSiteFiles(sites);
  // Set once, at the top level, which every environment shares.
  const { rawConfig } = experimental_readRawConfig({ config: join(WORKER_DIR, "wrangler.jsonc") });
  for (const [env, settings] of Object.entries(rawConfig.env ?? {})) assert.equal((settings as { assets?: unknown }).assets, undefined, `env.${env} has no assets of its own`);
});

test("a configuration that runs the Worker for the card proof page's files, lets it read them, or sends them with another proof log's headers is turned away", () => {
  const real = configuredSites().test!;
  const cases: [string, Partial<ConfiguredSite>, RegExp][] = [
    ["the Worker first for everything", { runWorkerFirst: true }, /run_worker_first of the test environment/],
    ["no rule at all: a file that is not there would run the Worker", { runWorkerFirst: undefined }, /run_worker_first of the test environment/],
    ["/proof itself not among the rules", { runWorkerFirst: ["/*", "!/copy.js", "!/demo.js", "!/favicon.ico", "!/fonts/*", "!/og-image.png", "!/pages.css", "!/proof/*"] }, /run_worker_first of the test environment/],
    ["the script not among the rules: the Worker would answer /copy.js", { runWorkerFirst: ["/*", "!/demo.js", "!/favicon.ico", "!/fonts/*", "!/og-image.png", "!/pages.css", "!/proof", "!/proof/*"] }, /run_worker_first of the test environment/],
    ["the typeface not among the rules: the Worker would answer /fonts/…", { runWorkerFirst: ["/*", "!/copy.js", "!/demo.js", "!/favicon.ico", "!/og-image.png", "!/pages.css", "!/proof", "!/proof/*"] }, /run_worker_first of the test environment/],
    ["the image not among the rules: the Worker would answer /og-image.png", { runWorkerFirst: ["/*", "!/copy.js", "!/demo.js", "!/favicon.ico", "!/fonts/*", "!/pages.css", "!/proof", "!/proof/*"] }, /run_worker_first of the test environment/],
    ["a binding to read the files by", { binding: "ASSETS" }, /no binding/],
    ["index.html found for directories", { htmlHandling: "auto-trailing-slash" }, /html_handling/],
    ["a page for what is not there", { notFoundHandling: "single-page-application" }, /not_found_handling/],
    ["a production log's headers on the test site: no noindex", { headers: siteHeaders("production") }, /_headers of the test environment/],
    ["a header changed by hand", { headers: real.headers!.replace("same-origin-allow-popups", "unsafe-none") }, /_headers of the test environment/],
    ["no _headers", { headers: null }, /_headers of the test environment/],
    ["no _redirects", { redirects: null }, /_redirects of the test environment/],
    ["another redirect", { redirects: `${SITE_REDIRECTS}/proof/other.html https://example.org/ 302\n` }, /_redirects of the test environment/],
    ["a kind that is none", { kind: "staging" }, /PROOF_LOG_KIND of the test environment/],
    ["another file beside the eight", { files: [...real.files, "robots.txt"] }, /files of the test environment/],
    ["no style sheet", { files: ["_headers", "_redirects", "copy.js", "demo.js", "favicon.ico", "fonts/GenRyuMin2TW-B.woff2", "og-image.png"], styleSheetSha256: null }, /files of the test environment/],
    ["a style sheet that is not the one of HEAD: changed and not committed, or changed by the build", { styleSheetSha256: "0".repeat(64) }, /pages\.css of the test environment is the one of HEAD/],
    ["a style sheet that is not in HEAD, or a checkout that is not git's", { committedStyleSheetSha256: null }, /pages\.css of the test environment is the one of HEAD/],
    ["neither there nor in HEAD: null is not taken for the same", { styleSheetSha256: null, committedStyleSheetSha256: null }, /pages\.css of the test environment is the one of HEAD/],
    ["no script", { files: ["_headers", "_redirects", "demo.js", "favicon.ico", "fonts/GenRyuMin2TW-B.woff2", "og-image.png", "pages.css"], scriptSha256: null }, /files of the test environment/],
    ["a script that is not the one of HEAD", { scriptSha256: "0".repeat(64) }, /copy\.js of the test environment is the one of HEAD/],
    ["a script that is not in HEAD, or a checkout that is not git's", { committedScriptSha256: null }, /copy\.js of the test environment is the one of HEAD/],
    ["neither there nor in HEAD", { scriptSha256: null, committedScriptSha256: null }, /copy\.js of the test environment is the one of HEAD/],
    ["the player not among the rules: the Worker would answer /demo.js", { runWorkerFirst: ["/*", "!/copy.js", "!/favicon.ico", "!/fonts/*", "!/og-image.png", "!/pages.css", "!/proof", "!/proof/*"] }, /run_worker_first of the test environment/],
    ["no player", { files: ["_headers", "_redirects", "copy.js", "favicon.ico", "fonts/GenRyuMin2TW-B.woff2", "og-image.png", "pages.css"], demoSha256: null }, /files of the test environment/],
    ["a player that is not the one of HEAD", { demoSha256: "0".repeat(64) }, /demo\.js of the test environment is the one of HEAD/],
    ["a player that is not in HEAD", { committedDemoSha256: null }, /demo\.js of the test environment is the one of HEAD/],
    ["the icon not among the rules: the Worker would answer /favicon.ico", { runWorkerFirst: ["/*", "!/copy.js", "!/demo.js", "!/fonts/*", "!/og-image.png", "!/pages.css", "!/proof", "!/proof/*"] }, /run_worker_first of the test environment/],
    ["no icon", { files: ["_headers", "_redirects", "copy.js", "demo.js", "fonts/GenRyuMin2TW-B.woff2", "og-image.png", "pages.css"], faviconSha256: null }, /files of the test environment/],
    ["an icon that is not the one of HEAD", { faviconSha256: "0".repeat(64) }, /favicon\.ico of the test environment is the one of HEAD/],
    ["an icon that is not in HEAD", { committedFaviconSha256: null }, /favicon\.ico of the test environment is the one of HEAD/],
    ["an icon neither there nor in HEAD", { faviconSha256: null, committedFaviconSha256: null }, /favicon\.ico of the test environment is the one of HEAD/],
    ["no typeface", { files: ["_headers", "_redirects", "copy.js", "demo.js", "favicon.ico", "og-image.png", "pages.css"], fontSha256: null }, /files of the test environment/],
    ["a typeface that is not the subset of design/fonts/", { fontSha256: "0".repeat(64) }, /GenRyuMin2TW-B\.woff2 of the test environment is the subset of design\/fonts\//],
    ["no image", { files: ["_headers", "_redirects", "copy.js", "demo.js", "favicon.ico", "fonts/GenRyuMin2TW-B.woff2", "pages.css"], ogImageSha256: null }, /files of the test environment/],
    ["an image that is not design/screens/og-image.png", { ogImageSha256: "0".repeat(64) }, /og-image\.png of the test environment is design\/screens\/og-image\.png/],
  ];
  for (const [name, change, message] of cases) assert.throws(() => checkSiteFiles({ test: { ...real, ...change } }), message, name);
  // A production log's site with the test site's files says noindex: turned away too.
  assert.throws(() => checkSiteFiles({ test: real, production: { ...real, kind: "production" } }), /_headers of the production environment/);
  checkSiteFiles({ test: real, production: { ...real, kind: "production", headers: siteHeaders("production") } });
  assert.throws(() => checkSiteFiles({}), /has an environment/);
});

test("the style sheet and the script are checked against the ones this commit holds, read with git; with no such file to read, there is nothing they are the same as", () => {
  assert.equal(sha256InHead(join(WORKER_DIR, "site", "pages.css")), inHead("worker/site/pages.css"));
  assert.equal(sha256InHead(join(WORKER_DIR, "site", "copy.js")), inHead("worker/site/copy.js"));
  const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
  const dir = mkdtempSync(join(tmpdir(), "iamreal-head-"));
  try {
    // Not in a git checkout: no HEAD to read.
    writeFileSync(join(dir, "pages.css"), "body {}\n");
    assert.equal(sha256InHead(join(dir, "pages.css")), null);
    // In one, the file as HEAD holds it, whatever the working tree has; one HEAD does not hold is not there.
    // Nothing of this computer's git settings, nor a GIT_DIR this process was started with: the repository is the one made here.
    const gitEnv = {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "alice",
      GIT_AUTHOR_EMAIL: "alice@example.invalid",
      GIT_COMMITTER_NAME: "alice",
      GIT_COMMITTER_EMAIL: "alice@example.invalid",
    };
    const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, env: gitEnv, stdio: "ignore" });
    git("init", "--quiet");
    assert.equal(sha256InHead(join(dir, "pages.css")), null, "a repository with no commit");
    git("add", "pages.css");
    git("commit", "--quiet", "-m", "pages.css");
    assert.equal(sha256InHead(join(dir, "pages.css")), sha256("body {}\n"));
    writeFileSync(join(dir, "pages.css"), "body { color: red }\n");
    assert.equal(sha256InHead(join(dir, "pages.css")), sha256("body {}\n"), "changed and not committed");
    writeFileSync(join(dir, "copy.js"), "\n");
    assert.equal(sha256InHead(join(dir, "copy.js")), null, "not committed");
    assert.equal(sha256InHead(join(dir, "none.js")), null, "not there at all");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the date the test log was last cleared on is a date of the calendar; a configuration with another value is turned away before it is deployed", () => {
  const configured = configuredClearedOn();
  assert.deepEqual(Object.keys(configured).sort(), Object.keys(ENVIRONMENTS).sort());
  assert.deepEqual(configured.test, { kind: "test", clearedOn: read("test").vars.TEST_PROOF_LOG_CLEARED_ON });
  assert.match(String(configured.test!.clearedOn), /^\d{4}-\d{2}-\d{2}$/);
  checkClearedOn(configured);
  // Deployed, such a value makes the test site answer nothing but 500 (src/settings.ts).
  for (const other of ["2026-11-31", "2026-02-30", "2026-13-01", "2026-11-00", "2026-1-9", "20261119", "2026/11/19", "2026-11-19 ", "soon", "", undefined, 20261119]) {
    assert.throws(() => checkClearedOn({ test: { kind: "test", clearedOn: other } }), /TEST_PROOF_LOG_CLEARED_ON of the test environment/, String(other));
  }
  // A production log's pages have no mark: the setting is not read, and is not asked for.
  checkClearedOn({ test: configured.test!, production: { kind: "production", clearedOn: undefined } });
  assert.throws(() => checkClearedOn({}), /has an environment/);
});

test("a round stops starting older files 2.5 minutes in: what is left of the CPU time is several times what the largest CRL's tree was measured to take", () => {
  assert.equal(CRL_CATCH_UP_MS, 150_000);
  assert.equal(CRL_CATCH_UP_MS + RESERVED_FOR_LARGEST_CRL_MS, ROUND_CPU_MS);
  // README.md, "清冊鏡像量到的": the tree of MOICA's G2 CRL took up to 29.2 seconds in the local workerd.
  assert.ok(RESERVED_FOR_LARGEST_CRL_MS >= 3 * 29_200);
});
