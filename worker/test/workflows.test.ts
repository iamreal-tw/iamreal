// The GitHub Actions workflows (.github/workflows/) keep to ADR-0029 and to
// CONTRIBUTING.md, "部署會執行到的東西": what a pull request runs gets no
// secret, and only the job that uploads the Worker holds the deploy token.
//
// The workflows are read line by line, not with a YAML parser (there is none
// among the packages, and none is added for this): each file keeps to the
// plain block style the helpers below read. A file written another way
// fails these tests rather than passing them unread.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { unstable_readConfig } from "wrangler";
import { DEPLOY_ARGS } from "../scripts/deploy.ts";
import { WORKER_DIR } from "./build.ts";

const WORKFLOWS_DIR = join(WORKER_DIR, "..", ".github", "workflows");

interface Workflow {
  readonly file: string;
  readonly lines: readonly string[];
}

/** A line without its comment, if it has one. */
const code = (line: string): string => line.replace(/(^|\s)#.*$/, "");

function workflows(): Workflow[] {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, "there are workflows");
  return files.map((file) => ({ file, lines: readFileSync(join(WORKFLOWS_DIR, file), "utf8").split("\n") }));
}

test("every action is pinned to a full commit SHA, with the version it is in a comment", () => {
  let seen = 0;
  for (const w of workflows()) {
    for (const line of w.lines) {
      if (!/^\s*(-\s+)?uses:/.test(line)) continue;
      seen++;
      assert.match(line, /^\s*(-\s+)?uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${w.file}: ${line.trim()}`);
    }
  }
  assert.ok(seen > 0, "the check read the actions");
});

test("no workflow is triggered by pull_request_target or workflow_run, which run with the secrets", () => {
  for (const w of workflows()) {
    for (const line of w.lines) assert.doesNotMatch(code(line), /pull_request_target|workflow_run/, `${w.file}: ${line.trim()}`);
  }
});

/** The lines of a workflow without comments and blank lines, each with the job it is in ("" outside the jobs). */
function linesByJob(w: Workflow): { job: string; line: string }[] {
  let inJobs = false;
  let job = "";
  const out: { job: string; line: string }[] = [];
  for (const line of w.lines.map((l) => code(l).trimEnd())) {
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      inJobs = line === "jobs:";
      job = "";
    } else if (inJobs && /^ {2}\S/.test(line)) {
      const m = /^ {2}([\w-]+):$/.exec(line);
      assert.ok(m, `${w.file}: a job is written \`  name:\`, not ${line}`);
      job = m[1]!;
    }
    out.push({ job, line });
  }
  return out;
}

/** The block of `key` at the top level: its own line and the lines under it, without comments and blank lines. */
function topLevel(w: Workflow, key: string): string[] {
  const lines = linesByJob(w).map((l) => l.line);
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines.slice(start, end < 0 ? undefined : end);
}

function workflow(file: string): Workflow {
  const w = workflows().find((w) => w.file === file);
  assert.ok(w, `.github/workflows/${file}`);
  return w;
}

/** Every line of every workflow that refers to a secret, with its file and its job. */
function secretsReferred(): { file: string; job: string; line: string }[] {
  return workflows().flatMap((w) =>
    linesByJob(w)
      .filter((l) => /\bsecrets\b/.test(l.line))
      .map((l) => ({ file: w.file, job: l.job, line: l.line.trim() })),
  );
}

test("a pull request's checks are triggered by pull_request only, can only read and refer to no secret", () => {
  const w = workflow("checks.yml");
  assert.deepEqual(topLevel(w, "on"), ["on:", "  pull_request:"]);
  assert.deepEqual(topLevel(w, "permissions"), ["permissions:", "  contents: read"]);
  // No job asks for more than the workflow gives.
  const jobPermissions = linesByJob(w).filter((l) => l.job !== "" && /^\s*permissions:/.test(l.line));
  assert.deepEqual(jobPermissions, []);
  assert.deepEqual(
    secretsReferred().filter((s) => s.file === w.file),
    [],
  );
});

/** The steps of a job: each one's lines, from its `- ` on. */
function steps(jobLines: readonly string[]): string[][] {
  const out: string[][] = [];
  let inSteps = false;
  for (const line of jobLines) {
    if (/^ {4}\S/.test(line)) inSteps = line === "    steps:";
    else if (inSteps && line.startsWith("      - ")) out.push([line]);
    else if (inSteps) out.at(-1)!.push(line);
  }
  return out;
}

function jobLines(w: Workflow, job: string): string[] {
  const lines = linesByJob(w)
    .filter((l) => l.job === job)
    .map((l) => l.line);
  assert.ok(lines.length > 0, `${w.file} has the job ${job}`);
  return lines;
}

test("the test site is deployed on a push to main, by a build job and a deploy job after it", () => {
  const w = workflow("deploy-test.yml");
  assert.deepEqual(topLevel(w, "on"), ["on:", "  push:", "    branches:", "      - main"]);
  assert.deepEqual(topLevel(w, "permissions"), ["permissions:", "  contents: read"]);
  assert.deepEqual(
    [...new Set(linesByJob(w).map((l) => l.job))].filter((j) => j !== ""),
    ["build", "deploy"],
  );
  assert.ok(jobLines(w, "deploy").includes("    needs: build"));
});

test("only the deploy job has the deploy token, and only in the step that uploads", () => {
  const referred = secretsReferred();
  assert.deepEqual(
    referred.map((s) => `${s.file} ${s.job} ${s.line}`),
    [
      "deploy-test.yml deploy CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}",
      "deploy-test.yml deploy CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    ],
  );
  // The two are in the env of the last step, which uploads what the build job made and builds nothing.
  const last = steps(jobLines(workflow("deploy-test.yml"), "deploy")).at(-1)!;
  for (const s of referred) assert.ok(last.some((l) => l.trim() === s.line), `${s.line} is in the last step`);
  assert.ok(last.some((l) => l.trim() === "env:"), "in the step's env");
  assert.equal(
    last.find((l) => l.trim().startsWith("run:"))?.trim(),
    `run: node_modules/.bin/wrangler deploy "$RUNNER_TEMP/worker-build/index.js" --config wrangler.jsonc --no-bundle ${DEPLOY_ARGS.slice(1).join(" ")}`,
  );
});

test("before the upload, the deploy job runs no install script of a package and no script of the repository", () => {
  const before = steps(jobLines(workflow("deploy-test.yml"), "deploy")).slice(0, -1).flat();
  const runs = before.filter((l) => /^\s*(- )?run:/.test(l));
  for (const l of runs) assert.doesNotMatch(l, /run:\s*[|>]/, `one line per command: ${l.trim()}`);
  const installs = runs.filter((l) => /\binstall\b/.test(l));
  assert.ok(installs.length > 0, "the check read the installs");
  for (const l of installs) assert.match(l, /--ignore-scripts\b/, l.trim());
  for (const l of runs) assert.doesNotMatch(l, /\bpnpm (run|exec|test|dlx)\b|\bnode\b|\bnpx\b|wrangler/, l.trim());
});

test("the build job makes the build the tests check: the arguments of `pnpm run deploy:test` and --dry-run", () => {
  // test/build.ts makes the build test/bundle.test.ts checks with the same arguments.
  const build = jobLines(workflow("deploy-test.yml"), "build");
  const step = `run: node_modules/.bin/wrangler ${DEPLOY_ARGS.join(" ")} --dry-run --outdir "$RUNNER_TEMP/worker-build"`;
  assert.ok(
    build.some((l) => l.trim() === step),
    step,
  );
});

test("deploying runs no command of the repository: the wrangler configuration has no build command", () => {
  // wrangler runs `build.command` before it uploads, even with --no-bundle, so a command there would
  // run in the deploy job with the token (CONTRIBUTING.md, "部署會執行到的東西").
  const config = unstable_readConfig({ config: join(WORKER_DIR, "wrangler.jsonc"), env: "test" });
  assert.equal(config.build.command, undefined);
});
