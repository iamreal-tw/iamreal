// .github/workflows/gradle-retry.sh, run as the android check and the two
// Android uploads run it (#573), with Gradle replaced by a stand-in that
// fails as told, and sleep by one that only notes how long it was asked to
// wait. The workflows themselves are checked by test/workflows.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WORKER_DIR } from "./build.ts";

const SCRIPT = join(WORKER_DIR, "..", ".github", "workflows", "gradle-retry.sh");

/** What Gradle 9 printed on GitHub's runner when Maven Central did not answer (run 46045709756, #573). */
const PLUGIN_NOT_FOUND = `FAILURE: Build failed with an exception.

* Where:
Build file '/home/runner/work/iamreal/iamreal/android/build.gradle.kts' line: 2

* What went wrong:
Plugin [id: 'org.jetbrains.kotlin.android', version: '2.4.21', apply: false] was not found in any of the following sources:

- Gradle Core Plugins (plugin is not in 'org.gradle' namespace)
- Included Builds (No included builds contain this plugin)
- Plugin Repositories (could not resolve plugin artifact 'org.jetbrains.kotlin.android:org.jetbrains.kotlin.android.gradle.plugin:2.4.21')
  Searched in the following repositories:
    Google
    MavenRepo
`;
const COULD_NOT_RESOLVE = `* What went wrong:
Execution failed for task ':app:checkDebugAarMetadata'.
> Could not resolve all files for configuration ':app:debugRuntimeClasspath'.
   > Could not resolve androidx.core:core-ktx:1.17.0.
      > Could not get resource 'https://dl.google.com/dl/android/maven2/androidx/core/core-ktx/1.17.0/core-ktx-1.17.0.pom'.
         > Could not GET 'https://dl.google.com/dl/android/maven2/androidx/core/core-ktx/1.17.0/core-ktx-1.17.0.pom'.
            > Connection reset
`;
const COMPILE_ERROR = `e: file:///home/runner/work/iamreal/iamreal/android/app/src/main/kotlin/tw/iamreal/app/Main.kt:3:5 Unresolved reference 'x'.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> Compilation error. See log for more details
`;
const VERIFICATION_FAILED = `* What went wrong:
Execution failed for task ':app:checkDebugAarMetadata'.
> Could not resolve all files for configuration ':app:debugRuntimeClasspath'.
   > Dependency verification failed for configuration ':app:debugRuntimeClasspath'
     One artifact failed verification: core-ktx-1.17.0.aar (androidx.core:core-ktx:1.17.0) from repository Google
`;

/** One run of the stand-in Gradle: what it prints on stderr, and its exit status. */
interface Run {
  readonly stderr: string;
  readonly status: number;
}

/**
 * Runs gradle-retry.sh in a directory of its own, on a stand-in ./gradlew
 * that does on its n-th run what runs[n-1] says (the last one again after
 * that), and that writes its arguments to a file, one line a run.
 */
function retry(runs: readonly Run[], args: readonly string[] = ["--no-daemon", "build"]) {
  const dir = mkdtempSync(join(tmpdir(), "gradle-retry-"));
  try {
    runs.forEach((r, i) => writeFileSync(join(dir, `run-${i + 1}`), r.stderr));
    const bin = join(dir, "bin");
    const gradlew = join(dir, "gradlew");
    writeFileSync(
      gradlew,
      `#!/usr/bin/env bash
n=$(( $(cat "${dir}/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "${dir}/count"
printf '%s\\n' "$*" >> "${dir}/args"
last=${runs.length}
i=$(( n < last ? n : last ))
echo "> Task :app:preBuild (run $n)"
cat "${dir}/run-$i" >&2
case $i in ${runs.map((r, k) => `${k + 1}) exit ${r.status} ;;`).join(" ")} esac
`,
    );
    chmodSync(gradlew, 0o755);
    mkdirSync(bin);
    writeFileSync(join(bin, "sleep"), `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> "${dir}/slept"\n`);
    chmodSync(join(bin, "sleep"), 0o755);
    const r = spawnSync("bash", [SCRIPT, "./gradlew", ...args], { cwd: dir, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
    const lines = (f: string): string[] => {
      try {
        return readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l !== "");
      } catch {
        return [];
      }
    };
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, args: lines("args"), slept: lines("slept") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ok: Run = { stderr: "", status: 0 };

test("gradle-retry.sh: a plugin Gradle could not find runs Gradle again, after a wait, and says why", () => {
  const r = retry([{ stderr: PLUGIN_NOT_FOUND, status: 1 }, ok]);
  assert.equal(r.status, 0);
  assert.equal(r.args.length, 2);
  assert.deepEqual(r.slept, ["30"]);
  assert.match(r.stdout, /^::warning::gradle-retry: attempt 1 of 3 failed resolving a plugin or a library \(Gradle printed "was not found in any of the following sources"\); running it again in 30 seconds$/m);
});

test("gradle-retry.sh: a library Gradle could not GET is retried too", () => {
  const r = retry([{ stderr: COULD_NOT_RESOLVE, status: 1 }, ok]);
  assert.equal(r.status, 0);
  assert.equal(r.args.length, 2);
  assert.match(r.stdout, /^::warning::gradle-retry: attempt 1 of 3 failed resolving a plugin or a library \(Gradle printed "Could not resolve"\); running it again in 30 seconds$/m);
});

test("gradle-retry.sh: three runs at most, waiting 30 seconds and then 60; the last failure ends it with Gradle's exit status", () => {
  const r = retry([{ stderr: PLUGIN_NOT_FOUND, status: 1 }, { stderr: COULD_NOT_RESOLVE, status: 1 }, { stderr: PLUGIN_NOT_FOUND, status: 5 }]);
  assert.equal(r.status, 5);
  assert.equal(r.args.length, 3);
  assert.deepEqual(r.slept, ["30", "60"]);
  assert.match(r.stdout, /^::warning::gradle-retry: attempt 2 of 3 failed resolving a plugin or a library \(Gradle printed "Could not resolve"\); running it again in 60 seconds$/m);
  assert.match(r.stdout, /^::warning::gradle-retry: attempt 3 of 3 failed resolving a plugin or a library \(Gradle printed "was not found in any of the following sources"\); not running it again$/m);
});

test("gradle-retry.sh: any other failure ends it at once, with Gradle's exit status, and prints no warning", () => {
  for (const status of [1, 2, 130]) {
    const r = retry([{ stderr: COMPILE_ERROR, status }, ok]);
    assert.equal(r.status, status);
    assert.equal(r.args.length, 1);
    assert.deepEqual(r.slept, []);
    assert.doesNotMatch(r.stdout, /gradle-retry/);
  }
});

test("gradle-retry.sh: a failed dependency verification is not retried, though Gradle also printed Could not resolve", () => {
  const r = retry([{ stderr: VERIFICATION_FAILED, status: 1 }, ok]);
  assert.equal(r.status, 1);
  assert.equal(r.args.length, 1);
  assert.deepEqual(r.slept, []);
});

test("gradle-retry.sh: Gradle is run with the arguments given, each run, and its output is shown as it was", () => {
  const args = ["--no-daemon", "bundleRelease", "-Piamreal.versionName=2026.11.28", "-Piamreal.versionCode=7", "a b"];
  const r = retry([{ stderr: PLUGIN_NOT_FOUND, status: 1 }, ok], args);
  assert.deepEqual(r.args, [args.join(" "), args.join(" ")]);
  assert.ok(r.stdout.includes(`> Task :app:preBuild (run 1)\n${PLUGIN_NOT_FOUND}`));
  assert.ok(r.stdout.includes("> Task :app:preBuild (run 2)\n"));
  assert.equal(r.stderr, "");
});

test("gradle-retry.sh: a run that succeeds at once is run once, with no wait", () => {
  const r = retry([ok]);
  assert.equal(r.status, 0);
  assert.equal(r.args.length, 1);
  assert.deepEqual(r.slept, []);
});
