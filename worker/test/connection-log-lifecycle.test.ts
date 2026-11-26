// The check of the connection log's bucket (scripts/check-connection-log.ts;
// issue #20): which lifecycle rules it takes, and which it fails on. No
// deploy runs it yet (README.md, "連線紀錄"). The rules here are written as Cloudflare's API
// answers them; no request is sent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { experimental_readRawConfig } from "wrangler";
import { CONNECTION_LOG_BUCKETS, MAX_AGE_SECONDS, PREFIX, describeRules, lifecycleProblem, refusalOf } from "../scripts/check-connection-log.ts";
import { WORKER_DIR } from "../scripts/deploy.ts";

const age = (days: number): unknown => ({ condition: { type: "Age", maxAge: days * 86_400 } });
const rule = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "connection-31-days", enabled: true, conditions: { prefix: "connection/" }, deleteObjectsTransition: age(31), ...over });
/** The rule every bucket has from the start: it deletes no object. */
const DEFAULT = { id: "Default Multipart Abort Rule", enabled: true, conditions: { prefix: "" }, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } } };

test("31 days is 2,678,400 seconds, under the prefix the Worker writes to, in the bucket wrangler.jsonc binds", () => {
  assert.equal(MAX_AGE_SECONDS, 2_678_400);
  // The Worker's own constant (its module is the Worker's, not read as code here).
  const written = /^export const CONNECTION_LOG_PREFIX = "([^"]+)";$/m.exec(readFileSync(join(WORKER_DIR, "src", "connection-log.ts"), "utf8"))?.[1];
  assert.equal(PREFIX, written);
  const { rawConfig } = experimental_readRawConfig({ config: join(WORKER_DIR, "wrangler.jsonc") });
  const environments = Object.entries((rawConfig.env ?? {}) as Record<string, { r2_buckets?: { binding: string; bucket_name: string }[] }>);
  const bucketOf = (env: { r2_buckets?: { binding: string; bucket_name: string }[] }, binding: string): string | undefined => env.r2_buckets?.find((b) => b.binding === binding)?.bucket_name;
  assert.deepEqual(Object.fromEntries(environments.map(([name, env]) => [name, bucketOf(env, "CONNECTION_LOG")])), CONNECTION_LOG_BUCKETS);
  // Not the bucket of the public data.
  for (const [name, env] of environments) assert.notEqual(bucketOf(env, "DATA"), bucketOf(env, "CONNECTION_LOG"), name);
});

test("one enabled rule that deletes what is under connection/ after 31 days is right, with or without the bucket's default rule and rules for other prefixes", () => {
  assert.equal(lifecycleProblem([rule()]), null);
  assert.equal(lifecycleProblem([DEFAULT, rule()]), null);
  // No prefix: every object of the bucket.
  assert.equal(lifecycleProblem([rule({ conditions: {} })]), null);
  assert.equal(lifecycleProblem([rule({ conditions: { prefix: "" } })]), null);
  // Another directory of the same bucket, kept for another time: not this check's.
  assert.equal(lifecycleProblem([rule(), rule({ id: "counts", conditions: { prefix: "counts/" }, deleteObjectsTransition: age(400) })]), null);
  // A rule that is not enabled deletes nothing.
  assert.equal(lifecycleProblem([rule(), rule({ id: "old", enabled: false, deleteObjectsTransition: age(7) })]), null);
  // A rule that moves objects to another storage class deletes none.
  assert.equal(lifecycleProblem([rule(), { id: "ia", enabled: true, conditions: { prefix: "connection/" }, storageClassTransitions: [{ condition: { type: "Age", maxAge: 86_400 }, storageClass: "InfrequentAccess" }] }]), null);
});

test("no rule, or none that deletes under connection/, fails", () => {
  for (const [what, rules] of [
    ["no rules at all", undefined],
    ["an empty list", []],
    ["only the default rule", [DEFAULT]],
    ["the rule is not enabled", [rule({ enabled: false })]],
    ["the rule is for another prefix", [rule({ conditions: { prefix: "counts/" } })]],
    ["the rule deletes nothing", [rule({ deleteObjectsTransition: undefined })]],
  ] as const) {
    assert.match(lifecycleProblem(rules) ?? "", /no enabled rule deletes the objects under connection\//, what);
  }
  assert.match(lifecycleProblem({ rules: [] }) ?? "", /not a list/);
});

test("any other age than 31 days, or a date, fails", () => {
  for (const days of [1, 30, 32, 90, 365]) assert.match(lifecycleProblem([rule({ deleteObjectsTransition: age(days) })]) ?? "", /it must be 2678400 \(31 days\)/, `${days} days`);
  assert.match(lifecycleProblem([rule({ deleteObjectsTransition: { condition: { type: "Age", maxAge: 31 } } })]) ?? "", /deletes after 31 seconds/);
  assert.match(lifecycleProblem([rule({ deleteObjectsTransition: { condition: { type: "Age", maxAge: "2678400" } } })]) ?? "", /it must be 2678400/);
  assert.match(lifecycleProblem([rule({ deleteObjectsTransition: { condition: { type: "Date", date: "2027-01-01T00:00:00Z" } } })]) ?? "", /does not delete by age/);
  assert.match(lifecycleProblem([rule({ deleteObjectsTransition: {} })]) ?? "", /does not delete by age/);
});

test("a rule that covers only a part of connection/, or a second rule that reaches it, fails", () => {
  // Only one day's objects.
  assert.match(lifecycleProblem([rule({ conditions: { prefix: "connection/2026-11" } })]) ?? "", /it must be "connection\/" or none/);
  // A beginning of the prefix that is not all of the bucket: other things could match it too, and it is not what was agreed.
  assert.match(lifecycleProblem([rule({ conditions: { prefix: "conn" } })]) ?? "", /it must be "connection\/" or none/);
  // Two rules: the earlier one would decide, whatever the other says.
  assert.match(lifecycleProblem([rule(), rule({ id: "sooner", conditions: { prefix: "" }, deleteObjectsTransition: age(7) })]) ?? "", /2 enabled rules delete objects under connection\//);
  assert.match(lifecycleProblem([rule(), rule({ id: "same" })]) ?? "", /2 enabled rules/);
  assert.match(lifecycleProblem([rule(), rule({ id: "a part", conditions: { prefix: "connection/2026" }, deleteObjectsTransition: age(1) })]) ?? "", /2 enabled rules/);
});

test("what the run's log says of the rules, and of an answer that is not the rules", () => {
  assert.deepEqual(describeRules([DEFAULT, rule()]), [
    'rule "Default Multipart Abort Rule": enabled, prefix "", deletes nothing',
    'rule "connection-31-days": enabled, prefix "connection/", deletes after 2678400 seconds',
  ]);
  assert.match(refusalOf(403, "iamreal-test-logs"), /Workers R2 Storage Read/);
  assert.match(refusalOf(401, "iamreal-test-logs"), /expired or been revoked/);
  assert.match(refusalOf(404, "iamreal-test-logs"), /knows no bucket "iamreal-test-logs"/);
  assert.match(refusalOf(500, "iamreal-test-logs"), /HTTP 500/);
});

const SCRIPT = join(WORKER_DIR, "scripts", "check-connection-log.ts");
const run = (args: string[], env: Record<string, string>): { status: number | null; out: string } => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
};

test("the command stops before it sends anything when it is not given an environment, a token and an account, and shows no value", () => {
  assert.deepEqual([run([], {}).status, run(["production"], {}).status], [1, 1]);
  const noToken = run(["test"], { CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) });
  assert.equal(noToken.status, 1);
  assert.match(noToken.out, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not both set/);
  const badAccount = run(["test"], { CLOUDFLARE_API_TOKEN: "a-token-that-must-not-be-printed", CLOUDFLARE_ACCOUNT_ID: "not an account" });
  assert.equal(badAccount.status, 1);
  assert.match(badAccount.out, /not 32 hex digits/);
  assert.ok(!badAccount.out.includes("a-token-that-must-not-be-printed") && !badAccount.out.includes("not an account"));
});

test("the script imports nothing but Node's own modules: what runs with its token is that file and Node", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:url"]);
  // And it never prints what it was given.
  assert.ok(!/console\.(log|error)\([^)]*(token|account)\b/.test(source));
});
