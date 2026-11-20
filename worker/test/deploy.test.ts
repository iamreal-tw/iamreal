// The parts of deploying that can be checked without deploying
// (scripts/deploy.ts): how `pnpm run deploy:test` reads the token out of
// `.env.local`, which environment it runs wrangler in, and the arguments of
// the build and of the upload, which the workflow uses too. The text here is
// made up; the real `.env.local` is never read by a test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { WORKER_DIR, buildArgs, deployTokenOf, uploadArgs, wranglerEnv } from "../scripts/deploy.ts";

const TOKEN = "made-up-token_0123456789";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

test("the token and the account are read from their two lines, whatever else the file holds", () => {
  const expected = { token: TOKEN, accountId: ACCOUNT };
  const texts = [
    `CLOUDFLARE_API_TOKEN_TEST=${TOKEN}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`,
    `# a note\nOTHER=1\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n\nCLOUDFLARE_API_TOKEN_TEST=${TOKEN}`,
    `export CLOUDFLARE_API_TOKEN_TEST="${TOKEN}"\r\nexport CLOUDFLARE_ACCOUNT_ID='${ACCOUNT}'\r\n`,
    `  CLOUDFLARE_API_TOKEN_TEST = ${TOKEN}  \n\tCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\t\n`,
    // The last line of a name counts; a name that only starts or ends the same is another variable.
    `CLOUDFLARE_API_TOKEN_TEST=an-earlier-one\nCLOUDFLARE_API_TOKEN_TEST=${TOKEN}\nCLOUDFLARE_API_TOKEN=another\nCLOUDFLARE_API_TOKEN_TEST_OLD=another\nXCLOUDFLARE_ACCOUNT_ID=another\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`,
    // A commented-out line is not a line of that name.
    `#CLOUDFLARE_API_TOKEN_TEST=another\nCLOUDFLARE_API_TOKEN_TEST=${TOKEN}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n# CLOUDFLARE_ACCOUNT_ID=another\n`,
  ];
  for (const text of texts) assert.deepEqual(deployTokenOf(text), expected, JSON.stringify(text));
});

test("a missing or empty line is an error that names the variable and shows no value", () => {
  const cases: [string, RegExp][] = [
    ["", /CLOUDFLARE_API_TOKEN_TEST/],
    [`CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`, /CLOUDFLARE_API_TOKEN_TEST/],
    [`CLOUDFLARE_API_TOKEN_TEST=\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`, /CLOUDFLARE_API_TOKEN_TEST/],
    [`CLOUDFLARE_API_TOKEN_TEST=""\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`, /CLOUDFLARE_API_TOKEN_TEST/],
    [`CLOUDFLARE_API_TOKEN_TEST=${TOKEN}\n`, /CLOUDFLARE_ACCOUNT_ID/],
    [`CLOUDFLARE_API_TOKEN=${TOKEN}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`, /CLOUDFLARE_API_TOKEN_TEST/],
  ];
  for (const [text, names] of cases) {
    assert.throws(
      () => deployTokenOf(text),
      (e: Error) => names.test(e.message) && !e.message.includes(TOKEN) && !e.message.includes(ACCOUNT),
      JSON.stringify(text),
    );
  }
});

test("wrangler gets nothing of the shell that says where to send requests or as whom, only this token", () => {
  const shell = {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    CLOUDFLARE_API_BASE_URL: "https://elsewhere.example/client/v4",
    CLOUDFLARE_API_TOKEN: "the-shell's-token",
    CLOUDFLARE_API_KEY: "a-global-key",
    CLOUDFLARE_EMAIL: "someone@example.com",
    CLOUDFLARE_ACCOUNT_ID: "the-shell's-account",
    CLOUDFLARE_API_TOKEN_TEST: "the-shell's-test-token",
    CF_API_TOKEN: "an-old-name",
    cloudflare_api_base_url: "https://elsewhere.example/",
    WRANGLER_API_ENVIRONMENT: "staging",
    WRANGLER_SEND_METRICS: "true",
    WRANGLER_LOG_PATH: "/somewhere",
    UNSET: undefined,
  };
  assert.deepEqual(wranglerEnv(shell, { token: TOKEN, accountId: ACCOUNT }), {
    PATH: "/usr/bin",
    HOME: "/home/someone",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_HIDE_BANNER: "true",
    CLOUDFLARE_API_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  });
});

test("the builds the tests make run wrangler in the same environment, without a token", () => {
  assert.deepEqual(wranglerEnv({ PATH: "/usr/bin", CLOUDFLARE_API_TOKEN: "the-shell's-token", CLOUDFLARE_ACCOUNT_ID: "x" }), {
    PATH: "/usr/bin",
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_HIDE_BANNER: "true",
  });
});

test("deploying is two commands: a build of the test environment, then an upload of that build as it is", () => {
  // Why each argument: scripts/deploy.ts, at WRANGLER_ARGS. The test build (test/build.ts) adds an
  // entry point, `--alias` and `--define` to the first; nothing here may.
  assert.deepEqual(buildArgs("/tmp/out"), [
    "deploy",
    "--config",
    "wrangler.jsonc",
    "--env",
    "test",
    "--experimental-provision=false",
    "--env-file=/dev/null",
    "--dry-run",
    "--outdir",
    "/tmp/out",
  ]);
  assert.deepEqual(uploadArgs("/tmp/out/index.js"), [
    "deploy",
    "/tmp/out/index.js",
    "--no-bundle",
    "--config",
    "wrangler.jsonc",
    "--env",
    "test",
    "--experimental-provision=false",
    "--env-file=/dev/null",
  ]);
});

test("wrangler reads none of the .env files it would read by default", () => {
  // wrangler 4.160.1 loads `.env`, `.env.local`, `.env.<env>` and `.env.<env>.local` from its working
  // directory into its environment unless `--env-file` names others; one of them could set
  // CLOUDFLARE_API_BASE_URL and send the token elsewhere. Each file here sets
  // WRANGLER_OUTPUT_FILE_PATH, which wrangler writes to right after loading them, so the file
  // appears if and only if wrangler read that .env file. A dry run sends no request.
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "dotenv-"));
  try {
    copyFileSync(join(WORKER_DIR, "wrangler.jsonc"), join(dir, "wrangler.jsonc"));
    symlinkSync(join(WORKER_DIR, "node_modules"), join(dir, "node_modules"));
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "index.js"), "export class Roster {}\nexport default { fetch() { return new Response(null, { status: 404 }); } };\n");
    const read: string[] = [];
    const files = [".env", ".env.local", ".env.test", ".env.test.local"];
    for (const [i, file] of files.entries()) {
      const marker = join(dir, `marker-${i}`);
      writeFileSync(join(dir, file), `WRANGLER_OUTPUT_FILE_PATH=${marker}\n`);
      for (const [what, args] of [
        ["without the flag", uploadArgs("out/index.js").filter((a) => a !== "--env-file=/dev/null")],
        ["upload", uploadArgs("out/index.js")],
      ] as const) {
        rmSync(marker, { force: true });
        const r = spawnSync(join(dir, "node_modules", ".bin", "wrangler"), [...args, "--dry-run"], { cwd: dir, encoding: "utf8", env: wranglerEnv(process.env) });
        assert.equal(r.status, 0, `${what}, ${file}:\n${r.stdout}\n${r.stderr}`);
        if (existsSync(marker)) read.push(`${what} ${file}`);
      }
      rmSync(join(dir, file));
    }
    // Without the flag every file is read: the check can see it.
    assert.deepEqual(read, files.map((f) => `without the flag ${f}`));
    assert.ok(buildArgs("out").includes("--env-file=/dev/null"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
