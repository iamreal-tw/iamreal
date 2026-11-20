// The checks of the GitHub Actions workflows (.github/workflows/), as a
// function from the files' text to the problems found, so that
// test/workflows.test.ts can run it on the real files and on altered copies.
//
// What it is: a guard against slips and against plain changes to what
// ADR-0029 and CONTRIBUTING.md ("部署會執行到的東西") require: only the deploy
// job's upload step has the token, nothing before it in that job runs code
// of the repository or of a package's install scripts, every action is one
// of a short list at a fixed commit, and a pull request's checks can only
// read. It is a whitelist: the files are read by a reader of a small part of
// YAML (below) and anything outside that part is a problem, and the deploy
// workflow's two jobs must be exactly the ones written here.
//
// What it is not: a replacement for reading every line of a change to
// these files, which CONTRIBUTING.md requires. It does not see:
// - what the commands of checks.yml run: they run the repository's code,
//   by design, with no secret and a token that can only read;
// - what the code run by the build job (scripts/build-deploy.ts and what it
//   imports) does: its output is what gets uploaded; its checks
//   (scripts/deploy-build-checks.ts) look for the known ways the test
//   build could get in, not for everything;
// - what the pinned actions do at their commits, what the lockfile resolves
//   to (wrangler, its dependencies), what pnpm 10.16.1 on npm is (no hash
//   is checked), and the parts of the repository the deploy job reads:
//   wrangler.jsonc, pnpm-workspace.yaml, pnpm-lock.yaml (some of this is
//   checked by test/workflows.test.ts, not all);
// - a difference between this reader and the YAML parser GitHub uses, for
//   a file inside the part of YAML read here. The part is kept small (no
//   flow style, quoted keys, anchors, tags, block or multi-line scalars,
//   escapes in double quotes, tabs or any byte outside printable ASCII,
//   comments included) to make such a difference unlikely; it is not proven
//   absent. One was found and closed: this reader once took spaces outside
//   ASCII (U+00A0, U+3000, U+2003, ...) for spaces, so a line of them
//   followed by `#` read here as a comment, while libyaml, which takes only
//   ASCII space for a space, read it as the next line of the value above
//   and folded the command after the `#` into a `run`. Every byte outside
//   printable ASCII is now a problem, and only the ASCII space (0x20) counts
//   as a space here.
import { uploadArgs, WRANGLER_QUIET } from "../scripts/deploy.ts";

/** A value of the part of YAML read here: a plain or quoted string, nothing (`key:` with nothing under it), a list or a map. */
export type Yaml = string | null | Yaml[] | { [key: string]: Yaml };
type YamlMap = { [key: string]: Yaml };

interface Line {
  readonly n: number;
  readonly indent: number;
  readonly text: string;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*):(?: (.*))?$/;

// Only the ASCII space (0x20) is a space here: not trim*(), not \s, which take Unicode spaces too.
/** How many spaces `s` starts with. */
const leadingSpaces = (s: string): number => /^ */.exec(s)![0].length;
/** `s` without the spaces it ends with. */
const withoutTrailingSpaces = (s: string): string => s.replace(/ +$/, "");
/** Whether `s` is only spaces, or spaces then `#`: a blank line or a comment. */
const isBlankOrComment = (s: string): boolean => /^ *(#.*)?$/.test(s);

/** A scalar after `key: ` or `- `, with its comment taken off. Throws for anything outside the part of YAML read here. */
function scalar(raw: string, n: number): string {
  const s = withoutTrailingSpaces(raw);
  const rest = (after: string): void => {
    if (!/^( +#.*)?$/.test(after)) throw new Error(`line ${n}: something after the quoted value: ${after}`);
  };
  if (s.startsWith("'")) {
    let j = 1;
    let value = "";
    for (;;) {
      if (j >= s.length) throw new Error(`line ${n}: a single-quoted value is not closed on its line`);
      if (s[j] === "'" && s[j + 1] === "'") {
        value += "'";
        j += 2;
      } else if (s[j] === "'") break;
      else value += s[j++];
    }
    rest(s.slice(j + 1));
    return value;
  }
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end < 0) throw new Error(`line ${n}: a double-quoted value is not closed on its line`);
    const value = s.slice(1, end);
    if (value.includes("\\")) throw new Error(`line ${n}: an escape in a double-quoted value`);
    rest(s.slice(end + 1));
    return value;
  }
  if (/^[[\]{}&*!|>%@`,?#-]/.test(s) || s === "") throw new Error(`line ${n}: a value written in a way not read here: ${s}`);
  const value = s.replace(/ +#.*$/, "");
  if (/: |:$/.test(value)) throw new Error(`line ${n}: a plain value with ": " in it`);
  return value;
}

/**
 * Reads `text`, a file in the small part of YAML described above, into a
 * value. Throws, naming the line, for anything outside that part.
 */
export function readYaml(text: string): Yaml {
  // Printable ASCII and newlines only, comments included: no tab, carriage return, byte-order
  // mark, character some parsers take for a line break, or space other than 0x20.
  const bad = /[^\x20-\x7e\n]/.exec(text);
  if (bad) throw new Error(`line ${text.slice(0, bad.index).split("\n").length}: a character outside printable ASCII (U+${bad[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`);
  const lines: Line[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    if (isBlankOrComment(raw)) continue;
    const indent = leadingSpaces(raw);
    lines.push({ n: i + 1, indent, text: withoutTrailingSpaces(raw.slice(indent)) });
  }
  if (lines.length === 0) throw new Error("an empty file");

  function block(i: number, indent: number): [Yaml, number] {
    return lines[i]!.text === "-" || lines[i]!.text.startsWith("- ") ? list(i, indent) : map(i, indent);
  }

  /** The value after `key:` or a list item: the block under it if the next line is deeper, else nothing. */
  function under(i: number, indent: number): [Yaml, number] {
    const next = lines[i + 1];
    return next !== undefined && next.indent > indent ? block(i + 1, next.indent) : [null, i + 1];
  }

  function noDeeperLine(i: number, indent: number): void {
    const next = lines[i];
    if (next !== undefined && next.indent > indent) throw new Error(`line ${next.n}: a line deeper than a value on the line before it`);
  }

  function map(i: number, indent: number): [Yaml, number] {
    const out: YamlMap = {};
    while (i < lines.length && lines[i]!.indent === indent) {
      const line = lines[i]!;
      const m = KEY.exec(line.text);
      if (!m) throw new Error(`line ${line.n}: not \`key:\` or \`key: value\`: ${line.text}`);
      const key = m[1]!;
      if (Object.hasOwn(out, key)) throw new Error(`line ${line.n}: ${key} twice`);
      let value: Yaml;
      if (m[2] === undefined) [value, i] = under(i, indent);
      else {
        value = scalar(m[2], line.n);
        i++;
        noDeeperLine(i, indent);
      }
      out[key] = value;
    }
    return [out, i];
  }

  function list(i: number, indent: number): [Yaml, number] {
    const out: Yaml[] = [];
    while (i < lines.length && lines[i]!.indent === indent) {
      const line = lines[i]!;
      if (!line.text.startsWith("- ")) throw new Error(`line ${line.n}: a list item that is not \`- something\`: ${line.text}`);
      const item = line.text.slice(2);
      if (KEY.test(item)) {
        // `- key: …` starts a map whose keys are at the column of `key`.
        lines[i] = { n: line.n, indent: indent + 2, text: item };
        const [value, next] = map(i, indent + 2);
        out.push(value);
        i = next;
      } else {
        out.push(scalar(item, line.n));
        i++;
        noDeeperLine(i, indent);
      }
    }
    return [out, i];
  }

  if (lines[0]!.indent !== 0) throw new Error(`line ${lines[0]!.n}: the first line is indented`);
  const [value, end] = block(0, 0);
  if (end < lines.length) throw new Error(`line ${lines[end]!.n}: indented in a way that fits no block above it`);
  return value;
}

/** The actions a workflow may use: each at one commit, with the version that commit is. */
export const ACTIONS: Readonly<Record<string, { readonly sha: string; readonly version: string }>> = {
  "actions/checkout": { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7.0.1" },
  "actions/setup-node": { sha: "949feb2413d6458794dcd2491c4babbbce0c15c1", version: "v7.1.0" },
  "actions/setup-go": { sha: "b7ad1dad31e06c5925ef5d2fc7ad053ef454303e", version: "v7.0.0" },
  "actions/upload-artifact": { sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9", version: "v7.0.2" },
  "actions/download-artifact": { sha: "9000827ccba6bdab643e8b6fd33ac0654aef8333", version: "v8.0.2" },
};

/**
 * The paths whose change runs the browser tests (checks-browser.yml,
 * `on.pull_request.paths`), exactly. Each is a pattern of GitHub's (`**`
 * matches any characters, `/` included; a pattern matches the whole path
 * from the repository's root:
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore).
 * test/workflows.test.ts checks that every top-level directory and file the
 * browser tests use is here. spec/ is here though the check does not find
 * it used: the page's rules and their answers change together.
 */
export const BROWSER_PATHS: readonly string[] = [
  "web/**",
  "protocol/**",
  "design/**",
  "spec/**",
  "server/**",
  "verifier/**",
  "roster/**",
  "crl/**",
  "cmd/**",
  "go.mod",
  "go.sum",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".github/workflows/checks-browser.yml",
];

/**
 * The paths whose change runs the iOS check (checks-ios.yml), exactly: the
 * app, the core it links, and the workflow itself (issue #155: macOS
 * minutes count for more, so the check runs only for these).
 */
export const IOS_PATHS: readonly string[] = ["ios/**", "device-core/**", ".github/workflows/checks-ios.yml"];
/**
 * The runner of the iOS check, and the one Xcode it builds with, by its path
 * on that runner's image (.github/README.md gives the sources).
 */
export const IOS_RUNNER = "xcode-27";
export const IOS_DEVELOPER_DIR = "/Applications/Xcode_27.2.app/Contents/Developer";
/** The one job of checks-ios.yml. Like the device-core job, it runs no bb. */
export const IOS_JOB = "ios";

export const NODE_VERSION = "22.23.4";
export const PNPM_VERSION = "10.16.1";
/** How every job installs pnpm: from npm's registry, named here so no `.npmrc` can point elsewhere, running no install script. */
export const INSTALL_PNPM = `npm install --global --ignore-scripts --registry=https://registry.npmjs.org/ pnpm@${PNPM_VERSION}`;

/** The SHA-256 of build/amd64-linux/bb in the package @aztec-foundation/bb.js 6.0.0: bb 6.0.0 for Linux on x86-64 (test/workflows.test.ts checks it against the installed package). */
export const BB_AMD64_LINUX_SHA256 = "5bbb64800d431c6760a70d8723be4eaf37ed10e8fbfe2842bb85b8436180c130";
export const BB_PATH = "${{ github.workspace }}/web/node_modules/@aztec-foundation/bb.js/build/amd64-linux/bb";
export const CHECK_BB = `echo "${BB_AMD64_LINUX_SHA256}  $IAMREAL_BB" | sha256sum --check --strict`;

/**
 * The one job that does not check bb's SHA-256: device-core/ runs no bb. The
 * Barretenberg it links is the static library device-core/fetch-barretenberg.sh
 * downloads, whose SHA-256 that script checks against
 * device-core/barretenberg.sha256 before unpacking it.
 */
export const DEVICE_CORE_JOB = "device-core";
/** How a step of that job gets Barretenberg: the directory the script prints, and nothing if the script fails. */
export const FETCH_BARRETENBERG = 'BB_LIB_DIR="$(./fetch-barretenberg.sh)" && export BB_LIB_DIR && ';

/** What each action may be given, exactly. */
const WITH: Readonly<Record<string, YamlMap>> = {
  "actions/checkout": { "persist-credentials": "false" },
  "actions/setup-node": { "node-version": NODE_VERSION, "package-manager-cache": "false" },
  "actions/setup-go": { "go-version-file": "go.mod", cache: "false" },
  "actions/upload-artifact": { name: "worker-build", path: "${{ runner.temp }}/worker-build", "if-no-files-found": "error" },
  "actions/download-artifact": { name: "worker-build", path: "${{ runner.temp }}/worker-build" },
};

const uses = (action: string): string => `${action}@${ACTIONS[action]!.sha}`;
const step = (action: string): YamlMap => ({ uses: uses(action), with: WITH[action]! });

/**
 * The device-core job, exactly. cargo reads device-core/.cargo/config.toml only when it runs in
 * that directory, and that file is what stops barretenberg-rs from downloading a library nobody
 * checked; so the job is written out here instead of being described by rules.
 */
export const DEVICE_CORE_JOB_STEPS: YamlMap = {
  "runs-on": "ubuntu-24.04",
  "timeout-minutes": "30",
  steps: [
    step("actions/checkout"),
    { name: "Install libc++ (Barretenberg's static library is built with it)", run: "sudo apt-get update && sudo apt-get install --yes --no-install-recommends libc++-dev libc++abi-dev" },
    { name: "Install the Rust of rust-toolchain.toml", "working-directory": "device-core", run: "rustup toolchain install" },
    { name: "cargo fmt --check", "working-directory": "device-core", run: "cargo fmt --check" },
    { name: "cargo clippy", "working-directory": "device-core", run: `${FETCH_BARRETENBERG}cargo clippy --locked --release --all-targets -- -D warnings` },
    { name: "cargo test", "working-directory": "device-core", run: `${FETCH_BARRETENBERG}cargo test --locked --release` },
  ],
};

/**
 * The iOS job, exactly. ios/build-core.sh is the one step that gets
 * Barretenberg and the CRS: it calls device-core/fetch-barretenberg.sh and
 * device-core/fetch-crs.sh, which check each SHA-256 before use, then runs
 * cargo in device-core/. Xcode links what that step left. The destination is
 * a simulator the runner's image has (.github/README.md gives the source).
 */
const XCODEBUILD = 'xcodebuild -project IamrealApp.xcodeproj -scheme IamrealApp -destination "platform=iOS Simulator,name=iPhone 17" -derivedDataPath build';
export const IOS_JOB_STEPS: YamlMap = {
  "runs-on": IOS_RUNNER,
  "timeout-minutes": "30",
  steps: [
    step("actions/checkout"),
    { name: "Install the Rust of rust-toolchain.toml, with the simulator's target", "working-directory": "device-core", run: "rustup toolchain install && rustup target add aarch64-apple-ios-sim" },
    { name: "Build device-core/ for the simulator", "working-directory": "ios", run: "./build-core.sh simulator" },
    { name: "Build the app and run its tests in the simulator", "working-directory": "ios", run: `${XCODEBUILD} test` },
    { name: "check-app.sh turns away what it should", "working-directory": "ios", run: "./check-app-test.sh build/Build/Products/Debug-iphonesimulator/IamrealApp.app" },
    { name: "Build the release configuration, with its checks", "working-directory": "ios", run: `${XCODEBUILD} -configuration Release build` },
  ],
};

/** The line of the upload step: the arguments of `uploadArgs` (scripts/deploy.ts), with wrangler kept quiet. */
export const UPLOAD = `${Object.entries(WRANGLER_QUIET)
  .map(([k, v]) => `${k}=${v}`)
  .join(" ")} node_modules/.bin/wrangler ${uploadArgs('"$RUNNER_TEMP/worker-build/index.js"').join(" ")}`;

/** The deploy workflow's jobs, exactly. */
export const DEPLOY_JOBS: YamlMap = {
  build: {
    "runs-on": "ubuntu-24.04",
    "timeout-minutes": "15",
    steps: [
      step("actions/checkout"),
      step("actions/setup-node"),
      { name: "Install pnpm", run: INSTALL_PNPM },
      { run: "pnpm install --frozen-lockfile" },
      { name: "Build the Worker and check the build", "working-directory": "worker", run: 'node --experimental-strip-types scripts/build-deploy.ts "$RUNNER_TEMP/worker-build"' },
      step("actions/upload-artifact"),
    ],
  },
  deploy: {
    needs: "build",
    "runs-on": "ubuntu-24.04",
    "timeout-minutes": "15",
    steps: [
      step("actions/setup-node"),
      { name: "Install pnpm", run: INSTALL_PNPM },
      step("actions/checkout"),
      {
        name: "Install wrangler",
        run: "pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --registry=https://registry.npmjs.org/ --filter iamreal-worker",
      },
      step("actions/download-artifact"),
      {
        name: "Upload to iamreal-test",
        "working-directory": "worker",
        env: { CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}", CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" },
        run: UPLOAD,
      },
    ],
  },
};

/** The only lines of all the workflows with the word "secrets" in them, comments included. */
export const SECRET_LINES: readonly string[] = [
  "deploy-test.yml:          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}",
  "deploy-test.yml:          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
];

/**
 * The three workflows of a pull request's checks: each one's trigger, its
 * environment (values that are not secret) and its jobs' environment,
 * exactly, its concurrency group, and its runner when that is not
 * ubuntu-24.04. The groups differ: "concurrency group
 * names must be unique across workflows to avoid canceling in-progress jobs
 * or runs from other workflows"
 * (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency).
 */
const PULL_REQUEST_RULES: Readonly<Record<string, { readonly on: Yaml; readonly env: YamlMap; readonly jobEnv?: YamlMap; readonly group: string; readonly runsOn?: string; readonly envRequired?: true }>> = {
  "checks.yml": {
    on: { pull_request: null },
    env: { IAMREAL_BB: BB_PATH, WRANGLER_SEND_METRICS: "false", WRANGLER_HIDE_BANNER: "true" },
    group: "checks-${{ github.event.pull_request.number }}",
  },
  "checks-browser.yml": {
    on: { pull_request: { paths: [...BROWSER_PATHS] } },
    env: { IAMREAL_BB: BB_PATH },
    jobEnv: { CHROME: "/usr/bin/google-chrome" },
    group: "checks-browser-${{ github.event.pull_request.number }}",
  },
  "checks-ios.yml": {
    on: { pull_request: { paths: [...IOS_PATHS] } },
    env: { DEVELOPER_DIR: IOS_DEVELOPER_DIR },
    group: "checks-ios-${{ github.event.pull_request.number }}",
    runsOn: IOS_RUNNER,
    // Without DEVELOPER_DIR the runner's default Xcode builds the app.
    envRequired: true,
  },
};

const isMap = (v: Yaml | undefined): v is YamlMap => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const extra = (v: YamlMap, allowed: readonly string[]): string[] => Object.keys(v).filter((k) => !allowed.includes(k));

/**
 * The problems in a set of workflow files, by file name. None, for files
 * that keep to everything described at the top of this file.
 */
export function workflowProblems(files: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const names = Object.keys(files).sort();
  if (!same(names, ["checks-browser.yml", "checks-ios.yml", "checks.yml", "deploy-test.yml"])) problems.push(`the workflows are ${names.join(", ")}, not checks-browser.yml, checks-ios.yml, checks.yml and deploy-test.yml`);

  // Where the word "secrets" is, read line by line as written, comments included.
  const secretLines = names.flatMap((f) =>
    files[f]!.split("\n")
      .filter((l) => /secrets/i.test(l))
      .map((l) => `${f}:${l}`),
  );
  if (!same(secretLines, SECRET_LINES)) problems.push(`the lines with "secrets" in them are ${JSON.stringify(secretLines)}`);

  // Every line that mentions `uses`: an action of the list, at its commit, with its version.
  for (const f of names) {
    for (const l of files[f]!.split("\n")) {
      if (!/uses/.test(l) || /^ *#/.test(l)) continue;
      const m = /^ {6}- uses: ([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(l);
      const known = m && ACTIONS[m[1]!];
      if (!m || !known || known.sha !== m[2] || known.version !== m[3]) problems.push(`${f}: not an action of the list at its commit: ${l.replace(/^ +| +$/g, "")}`);
    }
  }

  for (const f of names) {
    let doc: Yaml;
    try {
      doc = readYaml(files[f]!);
    } catch (e) {
      problems.push(`${f}: ${(e as Error).message}`);
      continue;
    }
    const p = (s: string): number => problems.push(`${f}: ${s}`);
    if (!isMap(doc)) {
      p("not a map");
      continue;
    }
    const wrong = extra(doc, ["name", "on", "permissions", "concurrency", "env", "jobs"]);
    if (wrong.length) p(`keys not allowed at the top: ${wrong.join(", ")}`);
    if (!same(doc.permissions, { contents: "read" })) p("permissions is not exactly contents: read");
    const c = doc.concurrency;
    if (c !== undefined && !(isMap(c) && extra(c, ["group", "cancel-in-progress"]).length === 0 && Object.values(c).every((v) => typeof v === "string"))) p("concurrency is not group and cancel-in-progress");
    if (doc.name !== undefined && typeof doc.name !== "string") p("name is not a string");

    if (f === "deploy-test.yml") {
      if (!same(doc.on, { push: { branches: ["main"] } })) p("not triggered by a push to main only");
      if (doc.env !== undefined) p("an env at the top");
      if (!same(doc.jobs, DEPLOY_JOBS)) p(`the jobs are not exactly the ones in test/workflows.ts: ${JSON.stringify(doc.jobs)}`);
      continue;
    }
    const rules = PULL_REQUEST_RULES[f];
    if (rules === undefined) continue;

    // Not pull_request_target, workflow_run or any other: "secrets are not passed to the runner
    // when a workflow is triggered from a forked repository" and "The GITHUB_TOKEN has read-only
    // permissions in pull requests from forked repositories" hold for pull_request, while "The
    // workflow started by the workflow_run event is able to access secrets and write tokens"
    // (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
    // `paths` only where the rules say, as they say: a path left out is a check that does not run.
    if (!same(doc.on, rules.on)) p(`not triggered by pull_request only, as written in test/workflows.ts: ${JSON.stringify(doc.on)}`);
    if ((doc.env !== undefined || rules.envRequired) && !same(doc.env, rules.env)) p("the env at the top is not the one in test/workflows.ts");
    if (!same(doc.concurrency, { group: rules.group, "cancel-in-progress": "true" })) p(`concurrency is not group ${rules.group}, cancelling the run before`);
    if (!isMap(doc.jobs) || Object.keys(doc.jobs).length === 0) {
      p("no jobs");
      continue;
    }
    for (const [name, job] of Object.entries(doc.jobs)) {
      const j = (s: string): number => p(`job ${name}: ${s}`);
      if (!isMap(job)) {
        j("not a map");
        continue;
      }
      const wrongJob = extra(job, ["name", "runs-on", "timeout-minutes", "env", "steps"]);
      if (wrongJob.length) j(`keys not allowed: ${wrongJob.join(", ")}`);
      const runsOn = rules.runsOn ?? "ubuntu-24.04";
      if (job["runs-on"] !== runsOn) j(`runs-on is not ${runsOn}`);
      if (job.env !== undefined && !same(job.env, rules.jobEnv)) j("an env other than the one in test/workflows.ts");
      if (!Array.isArray(job.steps) || job.steps.length === 0) {
        j("no steps");
        continue;
      }
      let checksBb = false;
      for (const [i, s] of job.steps.entries()) {
        const sp = (x: string): number => j(`step ${i + 1}: ${x}`);
        if (!isMap(s)) {
          sp("not a map");
          continue;
        }
        const wrongStep = extra(s, ["name", "uses", "with", "run", "working-directory"]);
        if (wrongStep.length) sp(`keys not allowed: ${wrongStep.join(", ")}`);
        if ((s.uses === undefined) === (s.run === undefined)) sp("not exactly one of uses and run");
        if (s["working-directory"] !== undefined && !["protocol", "worker", "web", "device-core", "ios"].includes(s["working-directory"] as string)) sp("a working directory other than protocol, worker, web, device-core, ios");
        if (s.uses !== undefined) {
          const action = Object.keys(ACTIONS).find((a) => s.uses === uses(a));
          if (!action) sp(`an action not in the list: ${JSON.stringify(s.uses)}`);
          else if (!same(s.with, WITH[action])) sp(`${action} is not given exactly ${JSON.stringify(WITH[action])}`);
        } else if (s.with !== undefined) sp("with but no uses");
        if (s.run !== undefined) {
          if (typeof s.run !== "string") sp("run is not one line");
          else {
            if (/\bpnpm@/.test(s.run) && s.run !== INSTALL_PNPM) sp(`pnpm is installed another way: ${s.run}`);
            if (s.run === CHECK_BB) checksBb = true;
          }
        }
      }
      if (f === "checks.yml" && name === DEVICE_CORE_JOB) {
        // Exactly the steps written above: every cargo that links Barretenberg runs in device-core/
        // (where .cargo/config.toml is read) with the library the script checked.
        if (!same(job, DEVICE_CORE_JOB_STEPS)) j(`not exactly the job in test/workflows.ts: ${JSON.stringify(job)}`);
      } else if (f === "checks-ios.yml" && name === IOS_JOB) {
        // Exactly the steps written above, for the same reason: the one step that gets Barretenberg
        // and the CRS is ios/build-core.sh, which has each checked before cargo or Xcode uses it.
        if (!same(job, IOS_JOB_STEPS)) j(`not exactly the job in test/workflows.ts: ${JSON.stringify(job)}`);
      } else if (!checksBb) j("does not check bb's SHA-256");
    }
  }
  return problems;
}
