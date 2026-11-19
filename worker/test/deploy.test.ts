// The parts of `pnpm run deploy:test` that can be checked without
// deploying (scripts/deploy.ts): how it reads the token out of `.env.local`
// and which environment it runs wrangler in. The text here is made up; the
// real `.env.local` is never read by a test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPLOY_ARGS, deployTokenOf, wranglerEnv } from "../scripts/deploy.ts";

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

test("the command deploys the test environment and names nothing else", () => {
  // test/build.ts adds `--dry-run --outdir` to these, so the build test/bundle.test.ts looks at is
  // this command's. An `--alias` or `--define` added here would change that build.
  // Why `--experimental-provision=false`: scripts/deploy.ts, at DEPLOY_ARGS.
  assert.deepEqual(DEPLOY_ARGS, ["deploy", "--env", "test", "--experimental-provision=false"]);
});
