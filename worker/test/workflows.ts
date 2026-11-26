// The checks of the GitHub Actions workflows (.github/workflows/), as a
// function from the files' text to the problems found, so that
// test/workflows.test.ts can run it on the real files and on altered copies.
//
// What it is: a guard against slips and against plain changes to what
// ADR-0029, ADR-0036 and CONTRIBUTING.md ("部署會執行到的東西") require: only
// the deploy job's upload step has the token, nothing before it in that job
// runs code of the repository or of a package's install scripts; the keys
// of the apps' uploads are only in the upload jobs, which build nothing
// (upload-android.yml: in the env of the two steps that use them;
// upload-ios.yml: in its last step); every action is one of a short list
// at a fixed commit, and a pull request's checks can only read. It is a
// whitelist: the files are read by a reader of a small part of YAML
// (below) and anything outside that part is a problem, and the deploy
// workflow's two jobs, the device-core and android jobs of checks.yml, the
// jobs of cache.yml, the two jobs of upload-android.yml, the two jobs of
// upload-ios.yml (only its upload job in the environment with the App Store
// Connect key, and that key in its last step only), and the one job each of
// checks-ios.yml and checks-circuits.yml, must be exactly the ones written
// here.
//
// What it is not: a replacement for reading every line of a change to
// these files, which CONTRIBUTING.md requires. It does not see:
// - what the commands of checks.yml run: they run the repository's code,
//   by design, with no secret and a token that can only read;
// - what the commands of cache.yml leave in the caches it saves: they run
//   the code of main (the builds of device-core/ and android/), and every
//   later check that restores a cache builds on what that run left in it;
// - what the scripts upload-android.yml runs do (android-version.sh,
//   android-sign.sh, play-upload.sh): test/upload-android.test.ts runs them,
//   with curl replaced, and Google Play's own answers are seen only on GitHub;
// - what the build job of upload-ios.yml makes (ios/build-core.sh,
//   ios/archive.sh, Xcode and cargo on the repository's code): its archive
//   is what gets signed and uploaded; ios/check-archive.sh looks for the
//   known ways the wrong build could get in, not for everything;
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
  // One repository, one commit: `actions/cache` restores and has a step after the job that saves;
  // `actions/cache/restore` only restores. Which workflow may use which: CACHE_MODE, below.
  "actions/cache": { sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9", version: "v6.1.0" },
  "actions/cache/restore": { sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9", version: "v6.1.0" },
};

/**
 * Files at the root that are not in the repository now, and that would
 * change every check if a pull request added one: where and how pnpm
 * installs (.npmrc, .pnpmfile.cjs, a package.json at the root), the Go
 * workspace (go.work), a cargo configuration every cargo run below the
 * root would read (.cargo/config.toml), and how git checks files out
 * (.gitattributes). A pattern for a file that is not there matches the pull
 * request that adds it.
 */
export const ROOT_FILES_PATHS: readonly string[] = [".npmrc", ".pnpmfile.cjs", "package.json", "go.work", "go.work.sum", ".cargo/config.toml", ".gitattributes"];
/**
 * The paths whose change runs the browser tests (checks-browser.yml,
 * `on.pull_request.paths`), exactly. Each is a pattern of GitHub's (`**`
 * matches any characters, `/` included; a pattern matches the whole path
 * from the repository's root:
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore).
 * test/workflows.test.ts checks that every top-level directory and file the
 * browser tests use is here. spec/ is here though the check does not find
 * it used: the page's rules and their answers change together. worker/ is
 * here since the tests run against the Worker (#69). circuits/package.json is here as a package of the workspace: the job
 * runs `pnpm install --frozen-lockfile`, which compares the lockfile with
 * every package's package.json (the other three are in directories listed
 * whole). And ROOT_FILES_PATHS, as in the lists of the required checks: the
 * job installs with pnpm, builds Go and checks files out.
 */
export const BROWSER_PATHS: readonly string[] = [
  "web/**",
  "protocol/**",
  "design/**",
  "spec/**",
  "worker/**",
  "verifier/**",
  "prooflog/**",
  "crl/**",
  "cmd/**",
  "go.mod",
  "go.sum",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "circuits/package.json",
  ...ROOT_FILES_PATHS,
  ".github/workflows/checks-browser.yml",
];

/**
 * The paths whose change runs the iOS check (checks-ios.yml), exactly: the
 * app, the core it links, what the app carries (the circuits, the
 * verification keys) and what its tests read (the vectors, the copy, the
 * hashes of the page's CRS), and the workflow itself. Issue #155: macOS
 * minutes count for more, so the check runs only for these.
 * test/workflows.test.ts checks that every path the tests of ios/Tests/ and
 * ios/check-app.sh name is under one of them.
 */
export const IOS_PATHS: readonly string[] = ["ios/**", "device-core/**", "spec/vectors/**", "design/copy/**", "design/fonts/**", "design/motion/**", "design/tokens.json", "web/circuits/**", "verifier/vk/**", "web/scripts/fetch-crs.mjs", ".github/workflows/checks-ios.yml"];
/**
 * The paths whose change runs the circuits' check (checks-circuits.yml),
 * exactly (#247): the circuits' source, scripts and tests (circuits/, its
 * package.json among them), the files the rebuild compares with
 * (web/circuits/, verifier/vk/) and strips with
 * (web/scripts/strip-circuit.mjs), the vectors the tests read
 * (spec/vectors/poseidon2.json), what is installed (the lockfile, the
 * workspace, and the package.json of the workspace's other packages, which
 * `pnpm install --frozen-lockfile` compares the lockfile with too), the
 * files at the root that change every check once added (ROOT_FILES_PATHS:
 * a .pnpmfile.cjs can change what bb.js, and with it bb, resolves to; a
 * .gitattributes the bytes of the files rebuild.sh compares) and the
 * workflow itself. test/workflows.test.ts checks that every file outside
 * circuits/ that the sources of circuits/ name is here.
 */
export const CIRCUITS_PATHS: readonly string[] = [
  "circuits/**",
  "web/circuits/**",
  "verifier/vk/**",
  "spec/vectors/poseidon2.json",
  "web/scripts/strip-circuit.mjs",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "protocol/package.json",
  "web/package.json",
  "worker/package.json",
  ...ROOT_FILES_PATHS,
  ".github/workflows/checks-circuits.yml",
];
/** The one job of checks-circuits.yml. */
export const CIRCUITS_JOB = "circuits";

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
 * device-core/barretenberg.sha256 before unpacking it. Its tests hand their
 * proofs to bb only when IAMREAL_BB names one, so cargo test runs with it
 * empty; device-core/fetch-crs.sh downloads the common reference string and
 * checks it against device-core/crs.sha256.
 */
export const DEVICE_CORE_JOB = "device-core";
/** How a step of that job gets Barretenberg: the directory the script prints, and nothing if the script fails. */
export const FETCH_BARRETENBERG = 'BB_LIB_DIR="$(./fetch-barretenberg.sh)" && export BB_LIB_DIR && ';

/**
 * The other job that does not check bb's SHA-256: android/ runs no bb
 * either. Its Barretenberg comes from the same script, which
 * android/build-native.sh calls.
 */
export const ANDROID_JOB = "android";
/** The one line of that job that runs Gradle: the wrapper of the repository, with the runner's JDK 17. */
export const GRADLE_BUILD = 'JAVA_HOME="$JAVA_HOME_17_X64" ./gradlew --no-daemon build';
/** How that job gets the NDK, the platform and the build tools android/app/build.gradle.kts names, with the SDK manager the runner has. */
export const ANDROID_SDK_PARTS = '$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "ndk;29.0.14206865" "platforms;android-36" "build-tools;36.0.0" > /dev/null';
/**
 * The Gradle the wrapper downloads and the SHA-256 it checks the download
 * against, and the SHA-256 of the wrapper's own jar in the repository, which
 * android/gradlew (a shell script, read like any other of the repository)
 * starts. Both are the ones Gradle publishes
 * for this version (https://gradle.org/release-checksums/);
 * test/workflows.test.ts checks the files of android/gradle/wrapper/ against them.
 */
export const GRADLE_VERSION = "9.9.1";
export const GRADLE_DISTRIBUTION_SHA256 = "d8a18a7a841dd5df825d35a685fad6f2d7f12ac0c280e57b67c27b4a520ba228";
export const GRADLE_WRAPPER_JAR_SHA256 = "621008afc4f5d59357fcf06ffa644dd5aade5e091bdc363742710445f73cdaf8";

/** What each action may be given, exactly. */
const WITH: Readonly<Record<string, YamlMap>> = {
  "actions/checkout": { "persist-credentials": "false" },
  "actions/setup-node": { "node-version": NODE_VERSION, "package-manager-cache": "false" },
  "actions/setup-go": { "go-version-file": "go.mod", cache: "false" },
  "actions/upload-artifact": { name: "worker-build", path: "${{ runner.temp }}/worker-build", "if-no-files-found": "error" },
  "actions/download-artifact": { name: "worker-build", path: "${{ runner.temp }}/worker-build" },
};

/**
 * The second artifact of a deploy: the card proof page, which the build job
 * builds and checks in worker/site/proof/ of its checkout
 * (scripts/build-deploy.ts) and the deploy job puts at the same place of
 * its own, where wrangler finds it among the files of Static Assets
 * (wrangler.jsonc, `assets.directory`).
 */
const PROOF_PAGE_ARTIFACT: YamlMap = { name: "proof-page", path: "worker/site/proof" };

const uses = (action: string): string => `${action}@${ACTIONS[action]!.sha}`;
const step = (action: string): YamlMap => ({ uses: uses(action), with: WITH[action]! });

/**
 * The caches (#203, ADR-0029).
 *
 * Who may write one: only cache.yml, which runs on pushes to main and on
 * nothing else. What holds the others to that is `cache-mode`, at the top of
 * every workflow: `read` "allows cache restores but prevents cache saves",
 * `none` "prevents all cache access"
 * (https://github.blog/changelog/2026-09-10-control-github-actions-cache-access-with-cache-mode),
 * and "Access is enforced with scoped cache tokens, so a job cannot restore
 * or save caches beyond the mode it is granted"
 * (https://docs.github.com/actions/reference/workflows-and-actions/workflow-syntax#cache-mode).
 * That is the boundary, and not which action a step uses: the commands of
 * checks.yml run a pull request's code, and code in a job can talk to the
 * cache service with the job's own token, without any action
 * (https://adnanthekhan.com/2024/12/21/cacheract-the-monster-in-your-build-cache/).
 * "Job-level settings override workflow-level settings" (the changelog), so
 * `cache-mode` anywhere below the top level is a problem. A mode left out is
 * a problem too: "If you omit `cache-mode`, a `read` or `write` default is
 * used based on the trigger type" (the syntax page).
 *
 * Under that, GitHub scopes a cache to the branch of the run that made it:
 * "Workflow runs can restore caches created in either the current branch or
 * the default branch (usually `main`)", and a cache a pull request's run
 * makes "can only be restored by re-runs of the pull request"
 * (https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache).
 *
 * The actions follow the mode, so that the file says what it does:
 * checks.yml (`read`) uses only `actions/cache/restore`, which "works
 * similarly to the `cache` action except that it doesn't have a post step to
 * save the cache" (https://github.com/actions/cache/blob/v6.1.0/restore/README.md);
 * a workflow with `none` uses no cache action. A step that is not permitted
 * would not fail ("the cache step logs an informational message and
 * continues", the syntax page), so the wrong action would go unseen.
 *
 * CACHE_MODE: each workflow's `cache-mode`, exactly. A file not named here,
 * a new one too, must say `none`.
 */
export const CACHE_WORKFLOW = "cache.yml";
export const CACHE_MODE: Readonly<Record<string, "read" | "write">> = { "checks.yml": "read", [CACHE_WORKFLOW]: "write" };
const cacheMode = (file: string): "read" | "write" | "none" => CACHE_MODE[file] ?? "none";
/** The action each mode is written with. `actions/cache/save` is in no list: nothing here needs it. */
const CACHE_ACTION = { read: "actions/cache/restore", write: "actions/cache" } as const;

/**
 * The files whose hash is in the keys of device-core's caches: what decides
 * which packages cargo builds, with which features and settings, with which
 * Rust, and which Barretenberg they link; and cache.yml itself, which holds
 * the commands that fill the caches, so that a change to them (a flag, a
 * feature) is a new key. A cache is never saved twice under one key ("You
 * cannot change the contents of an existing cache",
 * https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching),
 * so whatever changes what should be in it must change the key. A key is one
 * cache, restored for exactly these files or not at all: no `restore-keys`,
 * so a run never gets a target/ built for another Cargo.lock or another Rust.
 */
const DEVICE_CORE_KEY_FILES: readonly string[] = [
  "device-core/Cargo.lock",
  "device-core/Cargo.toml",
  "device-core/checks/Cargo.toml",
  "device-core/prover/Cargo.toml",
  "device-core/rust-toolchain.toml",
  "device-core/.cargo/config.toml",
  "device-core/barretenberg.sha256",
  "device-core/fetch-barretenberg.sh",
];
/**
 * The files whose hash is in the keys of android's caches: device-core's,
 * as the android job builds device-core/ too; android/build-native.sh, which
 * holds the cargo command, its flags and the C compiler of the NDK that
 * cc-rs is given; the Gradle build files, which name the plugins, the
 * libraries, the SDK, the NDK and minSdk (the API level of that compiler);
 * gradle/verification-metadata.xml, the SHA-256 of every file Gradle
 * downloads, so that a new version of anything is a new key; and the
 * wrapper's properties, which name the Gradle. Not fetch-zig.sh and
 * zig.sha256: Zig only links the app's library, in Gradle's build directory,
 * which is not cached.
 */
const ANDROID_KEY_FILES: readonly string[] = [
  ...DEVICE_CORE_KEY_FILES,
  "android/build-native.sh",
  "android/settings.gradle.kts",
  "android/build.gradle.kts",
  "android/app/build.gradle.kts",
  "android/gradle.properties",
  "android/gradle/verification-metadata.xml",
  "android/gradle/wrapper/gradle-wrapper.properties",
];
/** cache.yml, the first file of every key: it holds the commands that fill the caches. */
const CACHE_WORKFLOW_PATH = `.github/workflows/${CACHE_WORKFLOW}`;
const hashOf = (files: readonly string[]): string => `\${{ hashFiles(${[CACHE_WORKFLOW_PATH, ...files].map((f) => `'${f}'`).join(", ")}) }}`;
/**
 * Every file a key hashes (android's list holds device-core's).
 * test/workflows.test.ts checks that each one is there: hashFiles skips a
 * path that matches nothing, so a misspelt one would quietly leave its file
 * out of the key.
 */
export const CACHE_KEY_FILES: readonly string[] = [CACHE_WORKFLOW_PATH, ...ANDROID_KEY_FILES];
const DEVICE_CORE_HASH = hashOf(DEVICE_CORE_KEY_FILES);
const ANDROID_HASH = hashOf(ANDROID_KEY_FILES);
const cacheKey = (name: string, hash: string): string => `${name}-\${{ runner.os }}-\${{ runner.arch }}-${hash}`;
/**
 * The caches, exactly: what a step that restores or saves one is given. One
 * path each, because the reader of YAML here reads no value of several lines.
 * cargo's registry holds the packages of Cargo.lock, as downloaded and
 * unpacked; device-core/target holds what was compiled. Neither is checked
 * again after it is restored: cargo checks a package against the checksum
 * in Cargo.lock when it downloads it, not one already in the registry. What
 * a restored cache holds is what the run of cache.yml on main left there.
 */
type Cache = { readonly path: string; readonly key: string };
export const DEVICE_CORE_CACHES = {
  registry: { path: "~/.cargo/registry", key: cacheKey("device-core-cargo-registry", DEVICE_CORE_HASH) },
  target: { path: "device-core/target", key: cacheKey("device-core-target", DEVICE_CORE_HASH) },
} as const satisfies Record<string, Cache>;
/**
 * android's caches: cargo's registry; the three directories of target/ the
 * android job's cargo builds into (android/build-native.sh): `release`, the
 * library the unit tests load on the JVM, which also holds the build scripts
 * and procedural macros of the two Android builds, and one directory per
 * Android target; and Gradle's caches and wrapper. One cache per directory,
 * so that `gh cache list` shows each one's size. Only `caches` and `wrapper`
 * of ~/.gradle: not its init scripts, its properties or the daemon's
 * directories. Gradle hashes again each library it takes from the restored
 * cache and checks it against verification-metadata.xml (the hashes it has
 * computed are kept in android/.gradle/, which is not cached); the wrapper
 * checks the distribution only when it downloads it; what Gradle made from
 * the libraries (transforms, compiled build scripts) and cargo's target/ are
 * not checked again (.github/README.md, "快取"). Lock files and gc.properties
 * are taken out before the save (GRADLE_CACHE_CLEANUP).
 */
export const ANDROID_CACHES = {
  registry: { path: "~/.cargo/registry", key: cacheKey("android-cargo-registry", ANDROID_HASH) },
  host: { path: "device-core/target/release", key: cacheKey("android-target-host", ANDROID_HASH) },
  aarch64: { path: "device-core/target/aarch64-linux-android", key: cacheKey("android-target-aarch64-linux-android", ANDROID_HASH) },
  x86_64: { path: "device-core/target/x86_64-linux-android", key: cacheKey("android-target-x86_64-linux-android", ANDROID_HASH) },
  gradleCaches: { path: "~/.gradle/caches", key: cacheKey("android-gradle-caches", ANDROID_HASH) },
  gradleWrapper: { path: "~/.gradle/wrapper", key: cacheKey("android-gradle-wrapper", ANDROID_HASH) },
} as const satisfies Record<string, Cache>;
const cacheSteps = (use: "read" | "write", caches: Readonly<Record<string, Cache>>): YamlMap[] => Object.values(caches).map((c) => ({ uses: uses(CACHE_ACTION[use]), with: { ...c } }));
/** The caches each job of checks.yml may restore: its own. */
const CACHES_OF_JOB: Readonly<Record<string, Readonly<Record<string, Cache>>>> = { [DEVICE_CORE_JOB]: DEVICE_CORE_CACHES, [ANDROID_JOB]: ANDROID_CACHES };

/**
 * The steps the device-core job of checks.yml and the job of cache.yml that
 * fills its caches share, written once: cargo reuses what is in target/ only
 * for the same commands with the same flags, so a change to one job that
 * leaves the other alone would leave a cache nobody uses.
 */
const DEVICE_CORE_SETUP: readonly YamlMap[] = [
  { name: "Install libc++ (Barretenberg's static library is built with it)", run: "sudo apt-get update && sudo apt-get install --yes --no-install-recommends libc++-dev libc++abi-dev" },
  { name: "Install the Rust of rust-toolchain.toml", "working-directory": "device-core", run: "rustup toolchain install" },
];
const DEVICE_CORE_CLIPPY: YamlMap = { name: "cargo clippy", "working-directory": "device-core", run: `${FETCH_BARRETENBERG}cargo clippy --locked --release --all-targets -- -D warnings` };
const DEVICE_CORE_TEST = `${FETCH_BARRETENBERG}IAMREAL_BB= cargo test --locked --release`;

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
    ...cacheSteps("read", DEVICE_CORE_CACHES),
    ...DEVICE_CORE_SETUP,
    { name: "cargo fmt --check", "working-directory": "device-core", run: "cargo fmt --check" },
    DEVICE_CORE_CLIPPY,
    { name: "Fetch the common reference string", "working-directory": "device-core", run: "./fetch-crs.sh" },
    { name: "cargo test", "working-directory": "device-core", run: DEVICE_CORE_TEST },
  ],
};

/**
 * The steps the android job of checks.yml and the job of cache.yml that
 * fills its caches share, written once, for the reason given at
 * DEVICE_CORE_SETUP: cargo and Gradle reuse what they find only for the same
 * commands with the same SDK and JDK. The same `gradlew build` in both: with
 * --no-daemon no Gradle is left running when cache.yml's caches are saved.
 */
const ANDROID_SETUP: readonly YamlMap[] = [
  { name: "Install libc++ (Barretenberg's static library is built with it)", run: "sudo apt-get update && sudo apt-get install --yes --no-install-recommends libc++-dev libc++abi-dev" },
  { name: "Install the Rust of rust-toolchain.toml, with the targets of Android", "working-directory": "device-core", run: "rustup toolchain install && rustup target add aarch64-linux-android x86_64-linux-android" },
  { name: "Install the parts of the Android SDK that android/app/build.gradle.kts names", run: ANDROID_SDK_PARTS },
  { name: "Get the parameter files", "working-directory": "device-core", run: "./fetch-crs.sh" },
];
const ANDROID_BUILD: readonly YamlMap[] = [...ANDROID_SETUP, { name: "gradlew build", "working-directory": "android", run: GRADLE_BUILD }];
/**
 * The last step of cache.yml's android job, before actions/cache saves after
 * the job: Gradle's lock files and gc.properties out of ~/.gradle/caches.
 * Gradle's documentation, on copying its dependency cache: "Do not copy the
 * `*.lock` or `gc.properties` files if they exist"
 * (https://docs.gradle.org/current/userguide/dependency_caching.html).
 */
const GRADLE_CACHE_CLEANUP: YamlMap = {
  name: "Leave Gradle's lock files and gc.properties out of the cache",
  run: `find "$HOME/.gradle/caches" -type f \\( -name "*.lock" -o -name gc.properties \\) -delete`,
};

/**
 * The android job of checks.yml, exactly, written out for the same reason
 * as the device-core job: what it runs is the Gradle wrapper of android/
 * (`build`: both installers, the unit tests, lint, the checks of what was
 * built), and everything it links or bundles comes from a script that
 * checks a SHA-256 (android/build-native.sh calls fetch-barretenberg.sh
 * and fetch-zig.sh).
 */
export const ANDROID_JOB_STEPS: YamlMap = {
  "runs-on": "ubuntu-24.04",
  "timeout-minutes": "30",
  steps: [step("actions/checkout"), ...cacheSteps("read", ANDROID_CACHES), ...ANDROID_BUILD],
};

/**
 * The iOS job, exactly. ios/build-core.sh is the one step that gets
 * Barretenberg and the CRS: it calls device-core/fetch-barretenberg.sh and
 * device-core/fetch-crs.sh, which check each SHA-256 before use, then runs
 * cargo in device-core/. Xcode links what that step left. The destination is
 * a simulator the runner's image has (.github/README.md gives the source).
 * The last two steps archive the store's build for an iPhone with the
 * script upload-ios.yml runs (#176), so that a pull request that breaks the
 * archive or its check is seen before the upload is started by hand; the
 * version and build are fixed ones, the check's test is given the same.
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
    { name: "Add the iPhone's target to the Rust of rust-toolchain.toml", "working-directory": "device-core", run: "rustup target add aarch64-apple-ios" },
    { name: "Build device-core/ for the iPhone", "working-directory": "ios", run: "./build-core.sh device" },
    {
      name: "Archive the store's build as upload-ios.yml does, and check-archive.sh turns away what it should",
      "working-directory": "ios",
      run: "./archive.sh build/IamrealApp.xcarchive 1 2026.1.1 && ./check-archive-test.sh build/IamrealApp.xcarchive 2026.1.1 1",
    },
  ],
};

/**
 * The circuits job, exactly (#247). Every tool it runs is checked by a
 * script of circuits/ before use, and the job is written out so that no
 * step can take one from elsewhere: nargo is the one fetch-nargo.sh
 * downloads and checks against circuits/nargo.sha256 (rebuild.sh calls it
 * too); bb, which rebuild.sh runs, is the one find-bb.sh checks against
 * circuits/bb.sha256, so the job has no step with CHECK_BB; circom is the
 * one fetch-circom.sh downloads and checks against circuits/circom.sha256,
 * put first on PATH for build-circom.sh alone. The last step fails unless
 * the comparison's table is the committed one, which has a circom verdict
 * for every case: a case whose circom column is "not run" fails it
 * (test/workflows.test.ts checks the committed table).
 */
export const CIRCUITS_JOB_STEPS: YamlMap = {
  "runs-on": "ubuntu-24.04",
  "timeout-minutes": "30",
  steps: [
    step("actions/checkout"),
    step("actions/setup-node"),
    { name: "Install pnpm", run: INSTALL_PNPM },
    { name: "Install the packages (noir_js, and bb.js with its bb)", run: "pnpm install --frozen-lockfile" },
    { name: "Rebuild the two circuits and their verification keys, and compare them with the committed ones", "working-directory": "circuits", run: "./rebuild.sh" },
    { name: "Compile every circuit of the workspace", "working-directory": "circuits", run: '"$(./fetch-nargo.sh)" compile --workspace' },
    { name: "nargo test", "working-directory": "circuits", run: '"$(./fetch-nargo.sh)" test --workspace' },
    { name: "Build the circom witness generators", "working-directory": "circuits", run: 'circom="$(./fetch-circom.sh)" && PATH="${circom%/*}:$PATH" ./build-circom.sh' },
    { name: "pnpm test, with the case-by-case comparison", "working-directory": "circuits", run: "pnpm test" },
    { name: "The comparison's table is the committed one, every case run against circom", "working-directory": "circuits", run: "diff -u results/equivalence.md out/equivalence.md && cat out/equivalence.md" },
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
      { name: "Build the card proof page and the Worker, and check both builds", "working-directory": "worker", run: 'node --experimental-strip-types scripts/build-deploy.ts "$RUNNER_TEMP/worker-build"' },
      step("actions/upload-artifact"),
      { uses: uses("actions/upload-artifact"), with: { ...PROOF_PAGE_ARTIFACT, "if-no-files-found": "error" } },
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
      { uses: uses("actions/download-artifact"), with: PROOF_PAGE_ARTIFACT },
      {
        name: "Upload to iamreal-test",
        "working-directory": "worker",
        env: { CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}", CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" },
        run: UPLOAD,
      },
    ],
  },
};

/**
 * The workflow that uploads the iPhone app to App Store Connect (#176,
 * ADR-0036, ADR-0037): started by hand only, one run at a time, none
 * cancelled; the group's name is no other workflow's. Its environment is the
 * one Xcode of checks-ios.yml.
 */
export const IOS_UPLOAD_WORKFLOW = "upload-ios.yml";
export const IOS_UPLOAD_ON: Yaml = { workflow_dispatch: null };
export const IOS_UPLOAD_GROUP = "upload-ios";
/** The GitHub environment whose keys (App Store Connect's, #161; the Android upload key and Google Play's, #162) only main's runs get (ADR-0037). */
export const APP_ENVIRONMENT = "app-test";
/**
 * Its two jobs, exactly. "build" has no key and runs the repository's code:
 * the core for an iPhone (ios/build-core.sh, which checks Barretenberg's
 * library and the CRS against their SHA-256), then ios/archive.sh, which
 * archives the store's build unsigned and checks it (ios/check-archive.sh).
 * It hands on the archive in a tar file, so that its files keep their modes
 * (an artifact does not keep them), with ios/ExportOptions.plist.
 * "upload" is the only job in the environment app-test. It does not check
 * out the repository and runs no script of it: it unpacks the tar file and
 * runs Xcode's export, which signs and uploads. The archive is unsigned and
 * names no team, so the export options are given the team the environment
 * holds as a variable, APPLE_TEAM_ID (not a secret: every signed app shows
 * it). Only the last step has the key: it writes the key to a file only it
 * reads, and xcodebuild reads it.
 */
const IOS_UPLOAD_ARTIFACT: YamlMap = { name: "ios-upload", path: "${{ runner.temp }}/ios-upload" };
export const IOS_UPLOAD_JOBS: YamlMap = {
  build: {
    "runs-on": IOS_RUNNER,
    "timeout-minutes": "30",
    steps: [
      step("actions/checkout"),
      { name: "Install the Rust of rust-toolchain.toml, with the iPhone's target", "working-directory": "device-core", run: "rustup toolchain install && rustup target add aarch64-apple-ios" },
      { name: "Build device-core/ for the iPhone", "working-directory": "ios", run: "./build-core.sh device" },
      { name: "Archive the store's build and check it", "working-directory": "ios", run: './archive.sh "$RUNNER_TEMP/IamrealApp.xcarchive" "$GITHUB_RUN_NUMBER"' },
      {
        name: "Pack the archive, keeping its files' modes, with the export options",
        run: 'mkdir "$RUNNER_TEMP/ios-upload" && tar -C "$RUNNER_TEMP" -cf "$RUNNER_TEMP/ios-upload/IamrealApp.xcarchive.tar" IamrealApp.xcarchive && cp ios/ExportOptions.plist "$RUNNER_TEMP/ios-upload/"',
      },
      { uses: uses("actions/upload-artifact"), with: { ...IOS_UPLOAD_ARTIFACT, "if-no-files-found": "error" } },
    ],
  },
  upload: {
    needs: "build",
    "runs-on": IOS_RUNNER,
    "timeout-minutes": "30",
    environment: APP_ENVIRONMENT,
    steps: [
      { uses: uses("actions/download-artifact"), with: IOS_UPLOAD_ARTIFACT },
      { name: "Unpack the archive", run: 'tar -C "$RUNNER_TEMP" -xf "$RUNNER_TEMP/ios-upload/IamrealApp.xcarchive.tar"' },
      {
        name: "Name the team in the export options",
        env: { APPLE_TEAM_ID: "${{ vars.APPLE_TEAM_ID }}" },
        run: 'test -n "$APPLE_TEAM_ID" && plutil -replace teamID -string "$APPLE_TEAM_ID" "$RUNNER_TEMP/ios-upload/ExportOptions.plist"',
      },
      {
        name: "Sign and upload to App Store Connect",
        env: {
          APP_STORE_CONNECT_API_KEY_P8: "${{ secrets.APP_STORE_CONNECT_API_KEY_P8 }}",
          APP_STORE_CONNECT_API_KEY_ID: "${{ secrets.APP_STORE_CONNECT_API_KEY_ID }}",
          APP_STORE_CONNECT_API_ISSUER_ID: "${{ secrets.APP_STORE_CONNECT_API_ISSUER_ID }}",
        },
        run: [
          "umask 077",
          `printf '%s\\n' "$APP_STORE_CONNECT_API_KEY_P8" > "$RUNNER_TEMP/key.p8"`,
          'xcodebuild -exportArchive -archivePath "$RUNNER_TEMP/IamrealApp.xcarchive" -exportOptionsPlist "$RUNNER_TEMP/ios-upload/ExportOptions.plist" -exportPath "$RUNNER_TEMP/export" -allowProvisioningUpdates -authenticationKeyPath "$RUNNER_TEMP/key.p8" -authenticationKeyID "$APP_STORE_CONNECT_API_KEY_ID" -authenticationKeyIssuerID "$APP_STORE_CONNECT_API_ISSUER_ID"',
        ].join(" && "),
      },
    ],
  },
};

/**
 * How cache.yml is triggered and its concurrency group: pushes to main, one
 * run at a time, none cancelled. The group's name is no other workflow's.
 */
export const CACHE_ON: Yaml = { push: { branches: ["main"] } };
export const CACHE_GROUP = "cache";
/**
 * The jobs of cache.yml, exactly. Each compiles what its job of checks.yml
 * compiles, with the same commands in the same directory (the same
 * constants, above), so that what it saves is what that job's cargo and
 * Gradle look for. cache-device-core: clippy's check of every target and the
 * tests, with --release; the tests are built and not run (`--no-run`):
 * running them leaves nothing in target/ that a later run reuses.
 * cache-android: the whole `gradlew build` of the android job, tests and
 * lint included. A job's id is no id of checks.yml's jobs (REQUIRED_CHECKS,
 * below, on why names are unique across workflows).
 */
export const CACHE_JOBS: YamlMap = {
  "cache-device-core": {
    "runs-on": "ubuntu-24.04",
    "timeout-minutes": "30",
    steps: [
      step("actions/checkout"),
      ...cacheSteps("write", DEVICE_CORE_CACHES),
      ...DEVICE_CORE_SETUP,
      DEVICE_CORE_CLIPPY,
      { name: "cargo test, built and not run", "working-directory": "device-core", run: `${DEVICE_CORE_TEST} --no-run` },
    ],
  },
  "cache-android": {
    "runs-on": "ubuntu-24.04",
    "timeout-minutes": "30",
    steps: [step("actions/checkout"), ...cacheSteps("write", ANDROID_CACHES), ...ANDROID_BUILD, GRADLE_CACHE_CLEANUP],
  },
};

/**
 * upload-android.yml (#175, ADR-0036, ADR-0037): builds the store's build of
 * the Android app (tw.iamreal.app) and puts it on Google Play's internal
 * testing track, when the operator starts it by hand (workflow_dispatch) on
 * main. Its two jobs, exactly:
 *
 * - build: no secret. It stops first when the run is not on main. Then
 *   the version (.github/workflows/android-version.sh: the date in Taiwan
 *   and the run's number), the steps of the android check up to Gradle, and
 *   `bundleRelease` with that version, which runs the checks of the bundle
 *   (android/app/build.gradle.kts: checkBundle, checkManifest,
 *   checkLibraries); it hands the bundle on as an artifact.
 * - upload: `environment: app-test`, whose secrets GitHub gives only to jobs
 *   on main (#162). It runs no build: it signs the bundle the build job
 *   checked with the upload key (android-sign.sh), keeps the signed bundle as
 *   an artifact (a new app's first build goes up by hand, from Play Console:
 *   .github/README.md), then uploads it (play-upload.sh). Each secret is in the
 *   env of the one step that uses it.
 *
 * Its token reads the code only, like every workflow's (`permissions`), and
 * it has no cache (`cache-mode: none`).
 */
export const UPLOAD_ANDROID_WORKFLOW = "upload-android.yml";
export const UPLOAD_ANDROID_ON: Yaml = { workflow_dispatch: null };
export const UPLOAD_ANDROID_GROUP = "upload-android";
/** The scripts of .github/workflows/ that upload-android.yml runs. */
export const UPLOAD_ANDROID_SCRIPTS: readonly string[] = ["android-version.sh", "android-sign.sh", "play-upload.sh"];
/** Where the build job leaves the bundle (AGP's place for it), and where the upload job puts the signed one. */
const UNSIGNED_BUNDLE: YamlMap = { name: "android-bundle", path: "android/app/build/outputs/bundle/release/app-release.aab" };
const SIGNED_BUNDLE = "signed/app-release.aab";
export const UPLOAD_ANDROID_JOBS: YamlMap = {
  build: {
    "runs-on": "ubuntu-24.04",
    "timeout-minutes": "30",
    steps: [
      { name: "Only from main", run: 'test "$GITHUB_REF" = refs/heads/main' },
      step("actions/checkout"),
      {
        name: "The version, the date in Taiwan, and the run's number",
        id: "version",
        run: 'bash .github/workflows/android-version.sh "$GITHUB_RUN_NUMBER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_OUTPUT"',
      },
      ...ANDROID_SETUP,
      {
        name: "gradlew bundleRelease, with the checks of the bundle",
        "working-directory": "android",
        env: { VERSION_NAME: "${{ steps.version.outputs.name }}", VERSION_CODE: "${{ steps.version.outputs.code }}" },
        run: 'JAVA_HOME="$JAVA_HOME_17_X64" ./gradlew --no-daemon bundleRelease -Piamreal.versionName="$VERSION_NAME" -Piamreal.versionCode="$VERSION_CODE"',
      },
      { uses: uses("actions/upload-artifact"), with: { ...UNSIGNED_BUNDLE, "if-no-files-found": "error" } },
    ],
  },
  upload: {
    needs: "build",
    "runs-on": "ubuntu-24.04",
    "timeout-minutes": "20",
    environment: APP_ENVIRONMENT,
    steps: [
      step("actions/checkout"),
      { uses: uses("actions/download-artifact"), with: { name: UNSIGNED_BUNDLE.name!, path: "${{ runner.temp }}/bundle" } },
      {
        name: "Sign the bundle with the upload key",
        env: { ANDROID_UPLOAD_KEYSTORE_BASE64: "${{ secrets.ANDROID_UPLOAD_KEYSTORE_BASE64 }}", ANDROID_UPLOAD_KEYSTORE_PASSWORD: "${{ secrets.ANDROID_UPLOAD_KEYSTORE_PASSWORD }}" },
        run: `JAVA_HOME="$JAVA_HOME_17_X64" bash .github/workflows/android-sign.sh "$RUNNER_TEMP/bundle/app-release.aab" "$RUNNER_TEMP/${SIGNED_BUNDLE}"`,
      },
      { uses: uses("actions/upload-artifact"), with: { name: "android-bundle-signed", path: `\${{ runner.temp }}/${SIGNED_BUNDLE}`, "if-no-files-found": "error" } },
      {
        name: "Upload to Google Play's internal testing",
        env: { PLAY_SERVICE_ACCOUNT_JSON: "${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}" },
        run: `bash .github/workflows/play-upload.sh "$RUNNER_TEMP/${SIGNED_BUNDLE}"`,
      },
    ],
  },
};

/** The only lines of all the workflows with the word "secrets" in them, comments included. */
export const SECRET_LINES: readonly string[] = [
  "deploy-test.yml:          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN_TEST }}",
  "deploy-test.yml:          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
  "upload-android.yml:          ANDROID_UPLOAD_KEYSTORE_BASE64: ${{ secrets.ANDROID_UPLOAD_KEYSTORE_BASE64 }}",
  "upload-android.yml:          ANDROID_UPLOAD_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_UPLOAD_KEYSTORE_PASSWORD }}",
  "upload-android.yml:          PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}",
  "upload-ios.yml:          APP_STORE_CONNECT_API_KEY_P8: ${{ secrets.APP_STORE_CONNECT_API_KEY_P8 }}",
  "upload-ios.yml:          APP_STORE_CONNECT_API_KEY_ID: ${{ secrets.APP_STORE_CONNECT_API_KEY_ID }}",
  "upload-ios.yml:          APP_STORE_CONNECT_API_ISSUER_ID: ${{ secrets.APP_STORE_CONNECT_API_ISSUER_ID }}",
];

/**
 * The checks the ruleset of main requires before a pull request is merged,
 * and that the merge queue waits for (#180): checks.yml's jobs, exactly,
 * none with a `name`. Required checks are matched by job name ("make sure
 * that job names are unique across all workflows. Using the same job name in
 * multiple workflows can cause ambiguous status check results",
 * https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
 * and `name` sets "a name for the job, which is displayed in the GitHub UI"
 * (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idname).
 * That a job with no `name` reports under its id is not written there; it is
 * what is seen: the ruleset of main requires go, typescript and device-core,
 * the ids of these jobs, none with a name (read 2026-11-21). android, the job
 * added after that, goes into the ruleset with the merge queue (#180). A job
 * renamed or given a name reports a check the ruleset does not wait for, and
 * the one it waits for never comes.
 */
export const REQUIRED_CHECKS: readonly string[] = ["go", "typescript", "device-core", "android"];

/**
 * How checks.yml is triggered: on every pull request, and on every merge
 * group of the merge queue (#180), with merge_group's one activity type
 * named ("specifying the activity type will keep your workflow specific if
 * more activity types are added in the future",
 * https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group).
 */
export const CHECKS_ON: Yaml = { pull_request: null, merge_group: { types: ["checks_requested"] } };

/**
 * checks.yml's concurrency group: a pull request's number, or where the event
 * has none (merge_group) github.ref, the merge group's own branch, so that
 * the merge groups' runs do not cancel each other
 * (.github/workflows/checks.yml, the comment at the top).
 */
export const CHECKS_GROUP = "checks-${{ github.event.pull_request.number || github.ref }}";

/**
 * Skipping by path (#206). On a pull request each required check runs only
 * when the pull request changes a file its list below names; in the merge
 * queue all four always run, so a file missing from a list cannot turn main
 * red. When "A job is skipped by a conditional", "The job reports "Success""
 * (https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks#handling-skipped-but-required-checks).
 *
 * The lists have the format of BROWSER_PATHS and IOS_PATHS and are matched
 * the same way: a pattern matches the whole path from the repository's root,
 * and `**` matches any characters, `/` included. Only two forms are written
 * here, and `pathsProblems` turns away any other: a path with no wildcard
 * (that one file), and `<directory>/**` (every file under it). The lists are
 * given to the changes job as its env, each joined with spaces, and
 * .github/workflows/changed-paths.sh reads them from there: there is no
 * second copy. test/workflows.test.ts checks that each list holds what its
 * check uses, as far as reading the sources finds it (.github/README.md
 * says what that does not find).
 */
/** In every list: the workflow and the script that decides, these rules and their tests, what is installed and how, the Go module, and ROOT_FILES_PATHS. */
export const EVERY_CHECK_PATHS: readonly string[] = [
  ".github/workflows/checks.yml",
  ".github/workflows/changed-paths.sh",
  "worker/test/workflows.ts",
  "worker/test/workflows.test.ts",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "go.mod",
  "go.sum",
  ...ROOT_FILES_PATHS,
];
/**
 * The go job: every directory with a Go package, what their tests read
 * (the vectors and the specifications they quote, the copy), and the package.json files
 * `pnpm install --frozen-lockfile` compares the lockfile with (bb comes from it).
 */
export const GO_PATHS: readonly string[] = [
  ...EVERY_CHECK_PATHS,
  "cmd/**",
  "crl/**",
  "prooflog/**",
  "verifier/**",
  "spec/**",
  "design/copy/**",
  "circuits/package.json",
  "protocol/package.json",
  "web/package.json",
  "worker/package.json",
];
/**
 * The typescript job: the three packages, what their tests read, the Go
 * programs worker/'s tests build and run, and android/, ios/, device-core/,
 * circuits/ and the workflows, which test/workflows.test.ts reads. That is every
 * directory of the repository but docs/.
 */
export const TYPESCRIPT_PATHS: readonly string[] = [
  ...EVERY_CHECK_PATHS,
  "protocol/**",
  "worker/**",
  "web/**",
  "design/**",
  "spec/**",
  "cmd/**",
  "crl/**",
  "prooflog/**",
  "verifier/**",
  "android/**",
  "ios/**",
  "device-core/**",
  ".github/workflows/**",
  "circuits/**",
];
/**
 * The device-core job: the Rust, the files of the repository its tests
 * read, and cache.yml, which is hashed into the key of the caches the job
 * restores (a change to it is a job that builds from nothing).
 */
export const DEVICE_CORE_PATHS: readonly string[] = [...EVERY_CHECK_PATHS, "device-core/**", "spec/**", "crl/testdata/**", "web/circuits/**", "verifier/vk/**", ".github/workflows/cache.yml"];
/** The android job: the app, the Rust it links, the files Gradle bundles into the app, the ones its unit tests read, and cache.yml, hashed into the keys of its caches like device-core's. */
export const ANDROID_PATHS: readonly string[] = [...EVERY_CHECK_PATHS, "android/**", "device-core/**", "web/circuits/**", "verifier/vk/**", "spec/vectors/**", "design/fonts/**", "design/copy/**", "design/motion/**", ".github/workflows/cache.yml"];
/** A list of patterns for each required check, by the check's name. */
export type CheckLists = Readonly<Record<string, readonly string[]>>;
/** Each required check's list. */
export const CHECK_PATHS: CheckLists = { go: GO_PATHS, typescript: TYPESCRIPT_PATHS, "device-core": DEVICE_CORE_PATHS, android: ANDROID_PATHS };

/** Whether `path`, from the repository's root, matches one of `patterns`, each of the two forms above. */
export const matchesPaths = (patterns: readonly string[], path: string): boolean => patterns.some((p) => (p.endsWith("/**") ? path.startsWith(p.slice(0, -2)) : path === p));

/**
 * The problems in the lists themselves: a pattern of another form, a list
 * without the paths every list has, a list without a file that is hashed
 * into the key of a cache its job restores (a change to that file changes
 * what the job restores, so the job runs), or, where `isDirectory` says which
 * paths are directories of the repository, a directory written without
 * `/**`, which the script takes for one file's name and which then matches
 * nothing.
 */
export function pathsProblems(lists: CheckLists, isDirectory: (path: string) => boolean = () => false): string[] {
  const problems: string[] = [];
  if (!same(Object.keys(lists).sort(), [...REQUIRED_CHECKS].sort())) problems.push(`the lists are not one for each required check: ${Object.keys(lists).join(", ")}`);
  for (const [check, list] of Object.entries(lists)) {
    for (const p of list) if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*(\/\*\*)?$/.test(p) || p.split("/").some((part) => part === "." || part === "..")) problems.push(`${check}: not a path or <directory>/**: ${p}`);
    for (const p of list) if (!p.endsWith("/**") && isDirectory(p)) problems.push(`${check}: a directory without /**: ${p}`);
    for (const p of EVERY_CHECK_PATHS) if (!list.includes(p)) problems.push(`${check}: ${p} is not in the list`);
    // The files a key of the job's caches hashes, as written in the key: `hashFiles('<file>', ...)`.
    const hashed = new Set(Object.values(CACHES_OF_JOB[check] ?? {}).flatMap((c) => [...(/hashFiles\(([^)]*)\)/.exec(c.key)?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1]!)));
    for (const f of hashed) if (!matchesPaths(list, f)) problems.push(`${check}: ${f} is in the key of a cache the job restores, and not in the list`);
  }
  return problems;
}

/** The job of checks.yml that decides which required checks run, and the script it runs. */
export const CHANGES_JOB = "changes";
export const CHANGED_PATHS_SCRIPT = ".github/workflows/changed-paths.sh";
/** The name of the env variable that hands a check's list to the script: GO_PATHS, DEVICE_CORE_PATHS. */
export const pathsEnvName = (check: string): string => `${check.toUpperCase().replaceAll("-", "_")}_PATHS`;
/**
 * The changes job, exactly, for these lists. It uses one action, GitHub's
 * own checkout, with the whole history (`fetch-depth: 0`): the script
 * compares the pull request's head with its merge base with the base branch
 * (`git diff base...head`, the "three-dot diff" GitHub's own `paths` filter
 * uses for pull requests), and both commits and what lies between must be
 * there. The event's name and the two commits reach the script through env,
 * not through the text of a command.
 */
export const changesJob = (lists: CheckLists): YamlMap => ({
  "runs-on": "ubuntu-24.04",
  "timeout-minutes": "5",
  outputs: Object.fromEntries(REQUIRED_CHECKS.map((c) => [c, `\${{ steps.paths.outputs.${c} }}`])),
  env: {
    EVENT_NAME: "${{ github.event_name }}",
    BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    ...Object.fromEntries(REQUIRED_CHECKS.map((c) => [pathsEnvName(c), (lists[c] ?? []).join(" ")])),
  },
  steps: [
    { uses: uses("actions/checkout"), with: { "persist-credentials": "false", "fetch-depth": "0" } },
    { name: "Which checks the changed paths call for", id: "paths", run: `bash ${CHANGED_PATHS_SCRIPT}` },
  ],
});
/**
 * The first step of every required check: it fails unless the changes job
 * succeeded. With the job's `if` (below) this is what makes a required
 * check fail, not skip, when the changes job fails or is cancelled. The
 * result reaches the command through env, like everything the changes job
 * is given.
 */
export const CHANGES_SUCCEEDED_STEP: YamlMap = { name: "The changes job succeeded", env: { CHANGES_RESULT: "${{ needs.changes.result }}" }, run: 'test "$CHANGES_RESULT" = success' };

/** What a job's `if` is evaluated in: the changes job's result and outputs, the event, and whether the run was cancelled. */
export interface IfState {
  readonly result: "success" | "failure" | "cancelled" | "skipped";
  readonly outputs: Readonly<Record<string, string>>;
  readonly event: string;
  readonly runCancelled: boolean;
}

/**
 * Whether a job with this `if` runs in `state`. Reads a small part of
 * GitHub's expressions (strings in single quotes, `==`, `!=`, `!`, `&&`,
 * `||`, parentheses, the status functions, `needs.changes.result`,
 * `needs.changes.outputs.<name>`, `github.event_name`) and throws for
 * anything else. As GitHub does: strings compare without regard to case, an
 * empty string is false, and an `if` that calls no status function is
 * `success() && (...)`: "A default status check of success() is applied
 * unless you include one of these functions"
 * (https://docs.github.com/en/actions/reference/workflows-and-actions/expressions#status-check-functions).
 */
export function jobRuns(expression: string, state: IfState): boolean {
  const t = (expression.match(/\s+|&&|\|\||==|!=|[()!]|'[^']*'|[A-Za-z_][A-Za-z0-9_.-]*|./g) ?? []).filter((x) => !/^\s+$/.test(x));
  let i = 0;
  let statusFunction = false;
  type Value = string | boolean;
  const truthy = (v: Value): boolean => v !== false && v !== "";
  const take = (x: string): void => {
    if (t[i] !== x) throw new Error(`${x} expected, not ${t[i] ?? "the end"}`);
    i++;
  };
  const primary = (): Value => {
    const x = t[i++];
    if (x === undefined) throw new Error("it ends early");
    if (x === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (x.startsWith("'") && x.length >= 2) return x.slice(1, -1);
    if (t[i] === "(") {
      i++;
      take(")");
      statusFunction = true;
      if (x === "always") return true;
      if (x === "cancelled") return state.runCancelled;
      if (x === "success") return !state.runCancelled && state.result === "success";
      if (x === "failure") return !state.runCancelled && state.result === "failure";
      throw new Error(`a function not read here: ${x}`);
    }
    if (x === "needs.changes.result") return state.result;
    if (x === "github.event_name") return state.event;
    if (x.startsWith("needs.changes.outputs.")) return state.outputs[x.slice("needs.changes.outputs.".length)] ?? "";
    throw new Error(`not read here: ${x}`);
  };
  const unary = (): Value => {
    if (t[i] !== "!") return primary();
    i++;
    return !truthy(unary());
  };
  const comparison = (): Value => {
    const a = unary();
    const op = t[i];
    if (op !== "==" && op !== "!=") return a;
    i++;
    const b = unary();
    if (typeof a !== "string" || typeof b !== "string") throw new Error("a comparison of something other than two strings");
    return (a.toLowerCase() === b.toLowerCase()) === (op === "==");
  };
  const and = (): Value => {
    let v = comparison();
    while (t[i] === "&&") {
      i++;
      const w = comparison();
      if (truthy(v)) v = w;
    }
    return v;
  };
  function or(): Value {
    let v = and();
    while (t[i] === "||") {
      i++;
      const w = and();
      if (!truthy(v)) v = w;
    }
    return v;
  }
  const value = or();
  if (i < t.length) throw new Error(`something after the expression: ${t[i]}`);
  return (statusFunction || (!state.runCancelled && state.result === "success")) && truthy(value);
}

/**
 * The problems in how a required check of checks.yml depends on the changes
 * job. It must need that job and no other, start with the step above, and
 * have an `if` under which, whatever the other checks' outputs and whether
 * or not the run was cancelled:
 * - it runs on every event other than pull_request (the merge queue);
 * - it runs whenever the changes job did not succeed, so that the first
 *   step fails it. Without always(), when "A job depends on a failed job",
 *   "The dependent job is skipped and may not block merging" (the table of
 *   the page quoted above, which says to "Use always() with needs for
 *   required checks that depend on other jobs");
 * - it runs when the changes job's output for it is `true`.
 */
export function requiredCheckProblems(name: string, job: YamlMap): string[] {
  const problems: string[] = [];
  if (job.needs !== CHANGES_JOB) problems.push(`does not need the ${CHANGES_JOB} job, and only it`);
  if (!Array.isArray(job.steps) || !same(job.steps[0], CHANGES_SUCCEEDED_STEP)) problems.push(`the first step is not the one that fails unless the ${CHANGES_JOB} job succeeded`);
  if (typeof job.if !== "string") return [...problems, "no if"];
  const others = REQUIRED_CHECKS.filter((c) => c !== name);
  const skipped = new Set<string>();
  try {
    for (const result of ["success", "failure", "cancelled", "skipped"] as const)
      for (const event of ["pull_request", "merge_group"])
        for (const runCancelled of [false, true])
          for (const own of ["true", "false", ""])
            for (const other of ["true", "false"]) {
              const outputs = { ...Object.fromEntries(others.map((c) => [c, other])), [name]: own };
              if (jobRuns(job.if, { result, outputs, event, runCancelled })) continue;
              if (event !== "pull_request") skipped.add("can be skipped on merge_group");
              if (result !== "success") skipped.add(`is skipped, not failed, when the ${CHANGES_JOB} job's result is ${result}`);
              if (own === "true") skipped.add(`can be skipped when the ${CHANGES_JOB} job says it runs`);
            }
  } catch (e) {
    problems.push(`an if not read here (${(e as Error).message}): ${job.if}`);
  }
  return [...problems, ...skipped];
}

/**
 * The four workflows of a pull request's checks: each one's trigger, its
 * environment (values that are not secret) and its jobs' environment,
 * exactly, its concurrency group, and its runner when that is not
 * ubuntu-24.04. The groups differ: "concurrency group
 * names must be unique across workflows to avoid canceling in-progress jobs
 * or runs from other workflows"
 * (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency).
 *
 * `requiredChecks`: the workflow's jobs, exactly, none with a `name`, where
 * they are the checks main requires; with them, the changes job that
 * decides which of them a pull request runs (#206). checks-browser.yml, checks-ios.yml and
 * checks-circuits.yml do not run in the merge queue (#180).
 */
const PULL_REQUEST_RULES: Readonly<
  Record<
    string,
    {
      readonly on: Yaml;
      readonly env: YamlMap;
      readonly jobEnv?: YamlMap;
      readonly group: string;
      readonly runsOn?: string;
      readonly envRequired?: true;
      readonly requiredChecks?: readonly string[];
    }
  >
> = {
  "checks.yml": {
    on: CHECKS_ON,
    env: { IAMREAL_BB: BB_PATH, WRANGLER_SEND_METRICS: "false", WRANGLER_HIDE_BANNER: "true" },
    group: CHECKS_GROUP,
    requiredChecks: REQUIRED_CHECKS,
  },
  "checks-browser.yml": {
    on: { pull_request: { paths: [...BROWSER_PATHS] } },
    env: { IAMREAL_BB: BB_PATH },
    jobEnv: { CHROME: "/usr/bin/google-chrome" },
    group: "checks-browser-${{ github.event.pull_request.number }}",
  },
  "checks-circuits.yml": {
    on: { pull_request: { paths: [...CIRCUITS_PATHS] } },
    env: {},
    group: "checks-circuits-${{ github.event.pull_request.number }}",
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
 * The problems with caches (CACHE_MODE) that are read line by line as
 * written, so that they hold whatever job or step the line is in: a
 * `cache-mode` below the top level, which would override the workflow's, and
 * a cache action the workflow's mode does not go with. A line with
 * `actions/cache` in it that is not a comment is a use of a cache action. The
 * caches the other actions keep are off where they are used: WITH gives
 * setup-node `package-manager-cache: false` and setup-go `cache: false`,
 * exactly.
 */
function cacheProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  const mode = cacheMode(file);
  for (const [i, l] of text.split("\n").entries()) {
    if (/^ *#/.test(l)) continue;
    if (/cache-mode/.test(l) && !/^cache-mode: /.test(l)) problems.push(`${file}: line ${i + 1}: cache-mode below the top level, or not written as the key of a line`);
    if (!/actions\/cache/.test(l)) continue;
    const action = /uses: (actions\/cache(?:\/[\w.-]+)*)@/.exec(l)?.[1] ?? "actions/cache";
    const p = (s: string): number => problems.push(`${file}: line ${i + 1}: uses ${action}${s}`);
    if (mode === "none") p(": this workflow may use no cache");
    else if (mode === "read" && action !== CACHE_ACTION.read) p(", which saves a cache: this workflow may only restore one");
  }
  return problems;
}

/** The workflows, exactly, by file name: one to a line, in order. */
export const WORKFLOW_FILES: readonly string[] = [
  "cache.yml",
  "checks-browser.yml",
  "checks-circuits.yml",
  "checks-ios.yml",
  "checks.yml",
  "deploy-test.yml",
  UPLOAD_ANDROID_WORKFLOW,
  IOS_UPLOAD_WORKFLOW,
];

/**
 * The problems in a set of workflow files, by file name. None, for files
 * that keep to everything described at the top of this file.
 */
export function workflowProblems(files: Readonly<Record<string, string>>, checkPaths: CheckLists = CHECK_PATHS): string[] {
  const problems: string[] = [];
  const names = Object.keys(files).sort();
  if (!same(names, WORKFLOW_FILES)) problems.push(`the workflows are ${names.join(", ")}, not ${WORKFLOW_FILES.join(", ")}`);

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
      const m = /^ {6}- uses: ([\w.-]+\/[\w.-]+(?:\/[\w.-]+)?)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(l);
      const known = m && ACTIONS[m[1]!];
      if (!m || !known || known.sha !== m[2] || known.version !== m[3]) problems.push(`${f}: not an action of the list at its commit: ${l.replace(/^ +| +$/g, "")}`);
    }
  }

  for (const f of names) problems.push(...cacheProblems(f, files[f]!));

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
    const wrong = extra(doc, ["name", "on", "permissions", "cache-mode", "concurrency", "env", "jobs"]);
    if (wrong.length) p(`keys not allowed at the top: ${wrong.join(", ")}`);
    if (!same(doc.permissions, { contents: "read" })) p("permissions is not exactly contents: read");
    // What the cache service lets the workflow's jobs do (CACHE_MODE): said in every file, never left to the trigger's default.
    if (doc["cache-mode"] !== cacheMode(f)) p(`cache-mode is not ${cacheMode(f)}`);
    const c = doc.concurrency;
    if (c !== undefined && !(isMap(c) && extra(c, ["group", "cancel-in-progress"]).length === 0 && Object.values(c).every((v) => typeof v === "string"))) p("concurrency is not group and cancel-in-progress");
    if (doc.name !== undefined && typeof doc.name !== "string") p("name is not a string");

    if (f === "deploy-test.yml") {
      if (!same(doc.on, { push: { branches: ["main"] } })) p("not triggered by a push to main only");
      if (doc.env !== undefined) p("an env at the top");
      if (!same(doc.jobs, DEPLOY_JOBS)) p(`the jobs are not exactly the ones in test/workflows.ts: ${JSON.stringify(doc.jobs)}`);
      continue;
    }
    if (f === UPLOAD_ANDROID_WORKFLOW) {
      // By hand only: no push, pull request or other workflow starts an upload.
      if (!same(doc.on, UPLOAD_ANDROID_ON)) p(`not triggered by hand (workflow_dispatch) only: ${JSON.stringify(doc.on)}`);
      if (!same(doc.concurrency, { group: UPLOAD_ANDROID_GROUP, "cancel-in-progress": "false" })) p(`concurrency is not group ${UPLOAD_ANDROID_GROUP}, one run at a time and none cancelled`);
      if (doc.env !== undefined) p("an env at the top");
      if (!same(doc.jobs, UPLOAD_ANDROID_JOBS)) p(`the jobs are not exactly the ones in test/workflows.ts: ${JSON.stringify(doc.jobs)}`);
      continue;
    }
    if (f === IOS_UPLOAD_WORKFLOW) {
      // Started by hand only: not on a push, a pull request or any event a change can bring about.
      if (!same(doc.on, IOS_UPLOAD_ON)) p(`not triggered by hand only: ${JSON.stringify(doc.on)}`);
      if (!same(doc.env, { DEVELOPER_DIR: IOS_DEVELOPER_DIR })) p("the env at the top is not the one in test/workflows.ts");
      if (!same(doc.concurrency, { group: IOS_UPLOAD_GROUP, "cancel-in-progress": "false" })) p(`concurrency is not group ${IOS_UPLOAD_GROUP}, one run at a time and none cancelled`);
      if (!same(doc.jobs, IOS_UPLOAD_JOBS)) p(`the jobs are not exactly the ones in test/workflows.ts: ${JSON.stringify(doc.jobs)}`);
      continue;
    }
    // Whatever saves a cache runs on pushes to main and nothing else: on any other event (a pull
    // request, a merge group, a run started by hand on a branch) the code that runs before the
    // save is not main's. With the rule for every file above (permissions exactly contents: read)
    // and SECRET_LINES, the step that saves holds no secret and a token that can only read.
    if (cacheMode(f) === "write" && !same(doc.on, CACHE_ON)) p(`saves a cache and is not triggered by a push to main only: ${JSON.stringify(doc.on)}`);
    if (f === CACHE_WORKFLOW) {
      if (!same(doc.concurrency, { group: CACHE_GROUP, "cancel-in-progress": "false" })) p(`concurrency is not group ${CACHE_GROUP}, one run at a time and none cancelled`);
      if (doc.env !== undefined) p("an env at the top");
      if (!same(doc.jobs, CACHE_JOBS)) p(`the jobs are not exactly the ones in test/workflows.ts: ${JSON.stringify(doc.jobs)}`);
      continue;
    }
    const rules = PULL_REQUEST_RULES[f];
    if (rules === undefined) continue;

    // Not pull_request_target, workflow_run or any other: "secrets are not passed to the runner
    // when a workflow is triggered from a forked repository" and "The GITHUB_TOKEN has read-only
    // permissions in pull requests from forked repositories" hold for pull_request, while "The
    // workflow started by the workflow_run event is able to access secrets and write tokens"
    // (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).
    // merge_group only in checks.yml: the documentation does not say that limit holds for a merge
    // group's run, so what keeps it safe is the rest of these rules (no secret, read only).
    // `paths` only where the rules say, as they say: a path left out is a check that does not run.
    if (!same(doc.on, rules.on)) p(`not triggered as written in test/workflows.ts: ${JSON.stringify(doc.on)}`);
    if ((doc.env !== undefined || rules.envRequired) && !same(doc.env, rules.env)) p("the env at the top is not the one in test/workflows.ts");
    if (!same(doc.concurrency, { group: rules.group, "cancel-in-progress": "true" })) p(`concurrency is not group ${rules.group}, cancelling the run before`);
    if (!isMap(doc.jobs) || Object.keys(doc.jobs).length === 0) {
      p("no jobs");
      continue;
    }
    const required = rules.requiredChecks;
    if (required !== undefined && !same(Object.keys(doc.jobs).sort(), [...required, CHANGES_JOB].sort())) p(`the jobs are not exactly the checks main requires, ${required.join(", ")}, and ${CHANGES_JOB}: ${Object.keys(doc.jobs).join(", ")}`);
    if (required !== undefined) for (const x of pathsProblems(checkPaths)) p(x);
    for (const [name, whole] of Object.entries(doc.jobs)) {
      const j = (s: string): number => p(`job ${name}: ${s}`);
      if (!isMap(whole)) {
        j("not a map");
        continue;
      }
      let job = whole;
      if (required !== undefined && name === CHANGES_JOB) {
        // Exactly the job written above: one action, GitHub's checkout, then the script, with the lists of this file.
        if (!same(job, changesJob(checkPaths))) j(`not exactly the job in test/workflows.ts: ${JSON.stringify(job)}`);
        continue;
      }
      if (required !== undefined) {
        // How the check depends on the changes job is looked at here; the rest of the job, below, as it was before that job.
        for (const x of requiredCheckProblems(name, job)) j(x);
        const { needs: _needs, if: _if, ...rest } = job;
        job = { ...rest, ...(Array.isArray(job.steps) ? { steps: job.steps.slice(1) } : {}) };
      }
      // A job's name is the name its check reports: none where main requires the checks by id.
      const wrongJob = extra(job, [...(required === undefined ? ["name"] : []), "runs-on", "timeout-minutes", "env", "steps"]);
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
        if (s["working-directory"] !== undefined && !["protocol", "worker", "web", "device-core", "android", "ios", "circuits"].includes(s["working-directory"] as string)) sp("a working directory other than protocol, worker, web, device-core, android, ios, circuits");
        if (s.uses !== undefined) {
          const action = Object.keys(ACTIONS).find((a) => s.uses === uses(a));
          if (!action) sp(`an action not in the list: ${JSON.stringify(s.uses)}`);
          else if (action in WITH) {
            if (!same(s.with, WITH[action])) sp(`${action} is not given exactly ${JSON.stringify(WITH[action])}`);
          } else {
            // A cache action: only in a job that has caches, and given exactly one of them.
            const caches = Object.values(CACHES_OF_JOB[name] ?? {});
            if (caches.length === 0) sp("restores a cache that is not this job's");
            else if (!caches.some((c) => same(s.with, c))) sp(`${action} is not given exactly one of ${JSON.stringify(caches)}`);
          }
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
      } else if (f === "checks.yml" && name === ANDROID_JOB) {
        // Exactly the steps written above: Gradle is the wrapper of android/, and Barretenberg, Zig
        // and the parameter files come from the scripts that check their SHA-256.
        if (!same(job, ANDROID_JOB_STEPS)) j(`not exactly the job in test/workflows.ts: ${JSON.stringify(job)}`);
      } else if (f === "checks-ios.yml" && name === IOS_JOB) {
        // Exactly the steps written above, for the same reason: the one step that gets Barretenberg
        // and the CRS is ios/build-core.sh, which has each checked before cargo or Xcode uses it.
        if (!same(job, IOS_JOB_STEPS)) j(`not exactly the job in test/workflows.ts: ${JSON.stringify(job)}`);
      } else if (f === "checks-circuits.yml" && name === CIRCUITS_JOB) {
        // Exactly the steps written above: nargo, bb and circom each come from the script of circuits/
        // that checks its SHA-256, and the last step turns away a comparison without circom.
        if (!same(job, CIRCUITS_JOB_STEPS)) j(`not exactly the job in test/workflows.ts: ${JSON.stringify(job)}`);
      } else if (!checksBb) j("does not check bb's SHA-256");
    }
  }
  return problems;
}
