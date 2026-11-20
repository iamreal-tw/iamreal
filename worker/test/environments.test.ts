// The settings of each environment in wrangler.jsonc, read the way wrangler
// reads them: which roster the environment serves, the name of its roster's
// object and its data bucket belong together. A change that makes the test
// site serve the production roster, or write into another bucket, fails
// here, before it is merged and deployed.
//
// This is the first of two guards. The second is in the Worker
// (src/settings.ts): at every request it checks that `ROSTER_KIND` and
// `ROSTER_OBJECT_NAME` fit each other, which also holds for a deploy from a
// computer with a configuration that never went through a pull request.
//
// There is one environment so far. **When the production environment is
// added, it gets its own entry in ENVIRONMENTS below**: kind "production",
// an object name that does not start with `test-`, and its own bucket.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { experimental_readRawConfig, unstable_readConfig } from "wrangler";
import { WORKER_DIR } from "./build.ts";

/** What an environment's settings must be. */
interface Expected {
  readonly kind: "test" | "production";
  /** Whether the name of the roster's object starts with `test-`: a test roster's does, the production roster's does not. */
  readonly objectNamedAsTest: boolean;
  readonly bucket: string;
}

const ENVIRONMENTS: Readonly<Record<string, Expected>> = {
  test: { kind: "test", objectNamedAsTest: true, bucket: "iamreal-test-data" },
};

/** The part of an environment's configuration this file looks at. */
interface Settings {
  readonly vars: Readonly<Record<string, unknown>>;
  readonly r2_buckets: readonly { readonly binding: string; readonly bucket_name?: string }[];
}

/** What is wrong with an environment's settings; empty if nothing. */
function problems(settings: Settings, expected: Expected): string[] {
  const out: string[] = [];
  const { ROSTER_KIND: kind, ROSTER_OBJECT_NAME: name } = settings.vars;
  if (kind !== expected.kind) out.push(`ROSTER_KIND is not ${expected.kind}`);
  if (typeof name !== "string" || name.length <= "test-".length || name.startsWith("test-") !== expected.objectNamedAsTest) {
    out.push(`ROSTER_OBJECT_NAME ${expected.objectNamedAsTest ? "does not start" : "starts"} with test-`);
  }
  const buckets = settings.r2_buckets.map((b) => `${b.binding}=${b.bucket_name}`);
  if (buckets.length !== 1 || buckets[0] !== `DATA=${expected.bucket}`) out.push(`the only bucket is not DATA=${expected.bucket}`);
  return out;
}

const read = (env: string): Settings => unstable_readConfig({ config: join(WORKER_DIR, "wrangler.jsonc"), env }) as unknown as Settings;

for (const [env, expected] of Object.entries(ENVIRONMENTS)) {
  test(`the ${env} environment serves the ${expected.kind} roster, on an object named for it, with its own bucket`, () => {
    assert.deepEqual(problems(read(env), expected), []);
  });
}

test("the environments of wrangler.jsonc are the ones checked here", () => {
  const { rawConfig } = experimental_readRawConfig({ config: join(WORKER_DIR, "wrangler.jsonc") });
  assert.deepEqual(Object.keys(rawConfig.env ?? {}).sort(), Object.keys(ENVIRONMENTS).sort());
  // The top level has no roster of its own: no setting and no bucket (README.md, "設定檔").
  assert.equal(rawConfig.vars, undefined);
  assert.equal(rawConfig.r2_buckets, undefined);
});

test("altered copies of the test environment's settings are turned away, each for its own reason", () => {
  const real = read("test");
  const expected = ENVIRONMENTS.test!;
  const withVars = (vars: Record<string, unknown>): Settings => ({ ...real, vars: { ...real.vars, ...vars } });
  const cases: [string, Settings, string[]][] = [
    ["the production roster", withVars({ ROSTER_KIND: "production" }), ["ROSTER_KIND is not test"]],
    ["no kind", { ...real, vars: { ROSTER_OBJECT_NAME: real.vars.ROSTER_OBJECT_NAME } }, ["ROSTER_KIND is not test"]],
    ["an object not named as a test one", withVars({ ROSTER_OBJECT_NAME: "roster-1" }), ["ROSTER_OBJECT_NAME does not start with test-"]],
    ["an object named in another case", withVars({ ROSTER_OBJECT_NAME: "Test-1" }), ["ROSTER_OBJECT_NAME does not start with test-"]],
    ["an object named `test-` and nothing more", withVars({ ROSTER_OBJECT_NAME: "test-" }), ["ROSTER_OBJECT_NAME does not start with test-"]],
    ["another bucket", { ...real, r2_buckets: [{ binding: "DATA", bucket_name: "iamreal-data" }] }, ["the only bucket is not DATA=iamreal-test-data"]],
    ["a second bucket", { ...real, r2_buckets: [...real.r2_buckets, { binding: "OTHER", bucket_name: "iamreal-data" }] }, ["the only bucket is not DATA=iamreal-test-data"]],
    ["the production roster on its own object", withVars({ ROSTER_KIND: "production", ROSTER_OBJECT_NAME: "roster-1" }), ["ROSTER_KIND is not test", "ROSTER_OBJECT_NAME does not start with test-"]],
  ];
  for (const [name, settings, want] of cases) assert.deepEqual(problems(settings, expected), want, name);
});
