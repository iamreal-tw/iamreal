// The measurement's temporary Worker (measure/README.md) is deployed as
// `iamreal-measure` and nothing else, by the operator's command alone: its
// configuration names no deployed Worker and none of their buckets, no
// workflow and no script of package.json runs measure/, and its doors stay
// closed without the key the operator set. The load itself (measure/load.ts)
// is not run here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { unstable_startWorker } from "wrangler";
import { MEASURE_BUCKETS, MEASURE_WORKER, checkMeasureConfig, deployedNames, measureConfig, writeMeasureConfig } from "../measure/config.ts";
import { measureArgs, measureTokenOf } from "../measure/deploy.ts";
import { prepareEngineFiles } from "../scripts/engine-files.ts";
import { WORKER_DIR } from "./build.ts";

const REPO = join(WORKER_DIR, "..");

test("the measurement's configuration is the temporary Worker's: its own name and buckets, workers.dev only, no schedule", () => {
  const config = measureConfig();
  assert.equal(config["name"], MEASURE_WORKER);
  assert.ok(deployedNames().includes("iamreal-test"), "the names it is checked against include the test site's");
  assert.ok(!deployedNames().includes(MEASURE_WORKER));
  assert.deepEqual((config["r2_buckets"] as { bucket_name: string }[]).map((b) => b.bucket_name).sort(), Object.values(MEASURE_BUCKETS).sort());
  for (const name of Object.values(MEASURE_BUCKETS)) assert.ok(!readFileSync(join(WORKER_DIR, "wrangler.jsonc"), "utf8").includes(name), `${name} is no deployed environment's bucket`);
  assert.equal(config["workers_dev"], true);
  for (const key of ["triggers", "routes", "route", "env", "assets", "ratelimits"]) assert.equal(config[key], undefined, key);
  assert.equal(config["main"], join(WORKER_DIR, "measure-build", "index.ts"));
  const vars = config["vars"] as Record<string, string>;
  assert.equal(vars["PROOF_LOG_KIND"], "test");
  assert.equal(vars["PROOF_LOG_OBJECT_NAME"], "test-measure");
  assert.equal(vars["MEASURE_KEY"], undefined, "the key is the operator's secret, never a setting of the configuration");
});

test("a configuration that names another Worker, a schedule or another bucket is refused", () => {
  const good = measureConfig();
  for (const name of [...deployedNames(), "iamreal", "iamreal-production"]) assert.throws(() => checkMeasureConfig({ ...good, name }), /iamreal-measure/);
  assert.throws(() => checkMeasureConfig({ ...good, triggers: { crons: ["0 * * * *"] } }));
  assert.throws(() => checkMeasureConfig({ ...good, routes: ["test.iamreal.tw/*"] }));
  assert.throws(() => checkMeasureConfig({ ...good, env: { test: {} } }));
  assert.throws(() => checkMeasureConfig({ ...good, r2_buckets: [{ binding: "DATA", bucket_name: "iamreal-test-data" }, { binding: "CONNECTION_LOG", bucket_name: MEASURE_BUCKETS.CONNECTION_LOG }] }));
});

test("the measurement's deploy takes its own token and wrangler's safe flags, and no environment", () => {
  assert.deepEqual(measureTokenOf("CLOUDFLARE_API_TOKEN_MEASURE=a\nexport CLOUDFLARE_ACCOUNT_ID='b'\n"), { token: "a", accountId: "b" });
  // The test site's token (.env.local) is not one it reads.
  assert.throws(() => measureTokenOf("CLOUDFLARE_API_TOKEN_TEST=a\nCLOUDFLARE_ACCOUNT_ID=b\n"), /CLOUDFLARE_API_TOKEN_MEASURE/);
  for (const command of ["deploy", "secret"] as const) {
    const args = measureArgs(command, "/x/wrangler.json");
    assert.deepEqual(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2), ["--config", "/x/wrangler.json"]);
    assert.ok(args.includes("--env-file=/dev/null") && args.includes("--experimental-provision=false"));
    assert.ok(!args.includes("--env"));
  }
  assert.deepEqual(measureArgs("secret", "/x/wrangler.json").slice(0, 5), ["secret", "put", "MEASURE_KEY", "--name", MEASURE_WORKER]);
});

test("no workflow and no script of package.json runs the measurement", () => {
  const dir = join(REPO, ".github", "workflows");
  for (const file of readdirSync(dir)) assert.ok(!/measure/i.test(readFileSync(join(dir, file), "utf8")), `${file} names the measurement`);
  const scripts = (JSON.parse(readFileSync(join(WORKER_DIR, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  for (const [name, command] of Object.entries(scripts)) assert.ok(!/measure/i.test(`${name} ${command}`), `the script ${name} runs the measurement`);
});

test("the measurement's doors are closed without the key the operator set, with a wrong one and with a short one", async () => {
  prepareEngineFiles();
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "measure-doors-"));
  const key = "k".repeat(40);
  const cwd = process.cwd();
  try {
    for (const [set, sent] of [[undefined, `Bearer ${key}`], [key, undefined], [key, `Bearer ${"x".repeat(40)}`], ["short", "Bearer short"], [key, `Bearer ${key}`]] as const) {
      const config = writeMeasureConfig(join(dir, `config-${Math.random().toString(36).slice(2)}`), set === undefined ? {} : { MEASURE_KEY: set });
      // wrangler compares the configuration with worker-configuration.d.ts of its working directory, made for the test environment.
      process.chdir(dir);
      const worker = await unstable_startWorker({ config, dev: { persist: join(dir, "state"), server: { hostname: "127.0.0.1", port: 0 }, inspector: false, watch: false, logLevel: "none" } });
      try {
        const res = await worker.fetch("http://localhost/__measure/size", sent === undefined ? {} : { headers: { Authorization: sent } });
        const body = await res.text();
        if (set === key && sent === `Bearer ${key}`) assert.equal(res.status, 200, "the right key opens the door");
        else assert.equal(res.status, 404, `MEASURE_KEY ${set === undefined ? "not set" : set.length} characters, ${sent === undefined ? "none sent" : "another sent"}: ${body.slice(0, 100)}`);
      } finally {
        await worker.dispose();
        process.chdir(cwd);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
