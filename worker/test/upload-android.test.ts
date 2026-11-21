// The scripts of .github/workflows/upload-android.yml, run here as its jobs
// run them: the version the build gets, the signing of the bundle, and the
// calls to Google Play's API (with curl replaced by a stand-in that answers
// as the API does). The workflow itself is checked by test/workflows.test.ts.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WORKER_DIR } from "./build.ts";

const WORKFLOWS_DIR = join(WORKER_DIR, "..", ".github", "workflows");

/** A run of the API's list of a workflow's runs, as much of it as the script reads, and a little more. */
const run = (runNumber: number, createdAt: string, conclusion: string | null = "success"): object => ({
  run_number: runNumber,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  created_at: createdAt,
});

/** Runs android-version.sh as the version job does: the API's answer in a file, the run's number, the time now. */
function version(runs: object[] | null, runNumber: string, now: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "iamreal-android-version-"));
  try {
    const file = join(dir, "runs.json");
    writeFileSync(file, JSON.stringify({ total_count: runs?.length ?? 0, workflow_runs: runs }));
    const r = spawnSync("bash", [join(WORKFLOWS_DIR, "android-version.sh"), file, runNumber, now], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("android-version.sh: the first upload of a day in Taiwan is that date, the build is the run's number", () => {
  // Now is 2026-11-21 01:30 in Taiwan; the run before it, 15:59 UTC, was 23:59 on the 20th there.
  const r = version([run(7, "2026-11-20T17:29:00Z", null), run(6, "2026-11-20T15:59:00Z")], "7", "2026-11-20T17:30:00Z");
  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "name=2026.11.21\ncode=7\n");
});

test("android-version.sh: the day's second run in Taiwan adds .1, the third .2; runs of other days do not count", () => {
  // The day in Taiwan, 2026-11-21, runs from 16:00 UTC on the 20th to 15:59:59 UTC on the 21st.
  const before = [run(11, "2026-11-20T15:59:59Z"), run(10, "2026-11-19T20:00:00Z")];
  const today = [run(13, "2026-11-21T09:00:00Z"), run(12, "2026-11-20T16:00:00Z")];
  assert.equal(version([today[1]!, ...before], "13", "2026-11-21T09:00:01Z").stdout, "name=2026.11.21.1\ncode=13\n");
  assert.equal(version([...today, ...before], "14", "2026-11-21T15:59:59Z").stdout, "name=2026.11.21.2\ncode=14\n");
  // Past midnight in Taiwan the count starts again.
  assert.equal(version([...today, ...before], "14", "2026-11-21T16:00:00Z").stdout, "name=2026.11.22\ncode=14\n");
});

test("android-version.sh: a run of the day that failed counts too, so no two builds of a day have the same name; this run itself does not", () => {
  // Run 21 failed at the upload; its signed bundle may have gone to Google Play by hand (.github/README.md).
  // Run 22 is this one, in the list while it runs; 23 was started after it and waits.
  const runs = [run(23, "2026-11-21T03:01:00Z", null), run(22, "2026-11-21T03:00:00Z", null), run(21, "2026-11-21T02:00:00Z", "failure"), run(20, "2026-11-21T01:00:00Z", "cancelled")];
  assert.equal(version(runs, "22", "2026-11-21T03:00:05Z").stdout, "name=2026.11.21.2\ncode=22\n");
});

test("android-version.sh: stops on an answer that is not a list of runs, a run number that is not a build number, or a time it cannot read", () => {
  for (const [runs, runNumber, now] of [
    [null, "7", "2026-11-21T03:00:00Z"],
    [[run(6, "yesterday")], "7", "2026-11-21T03:00:00Z"],
    [[{ created_at: "2026-11-21T02:00:00Z" }], "7", "2026-11-21T03:00:00Z"],
    [[], "0", "2026-11-21T03:00:00Z"],
    [[], "7a", "2026-11-21T03:00:00Z"],
    [[], "", "2026-11-21T03:00:00Z"],
    // "The greatest value Google Play allows for versionCode is 2100000000" (Android's "Version your app").
    [[], "2100000001", "2026-11-21T03:00:00Z"],
    [[], "07", "2026-11-21T03:00:00Z"],
    [[], "7", "2026-11-21 03:00"],
  ] as const) {
    const r = version(runs as object[] | null, runNumber, now);
    assert.notEqual(r.status, 0, JSON.stringify([runs, runNumber, now]));
    assert.equal(r.stdout, "", JSON.stringify([runs, runNumber, now]));
  }
});

/**
 * A JDK, for keytool and jarsigner: JAVA_HOME, or on a Mac the one java_home
 * finds. GitHub's Ubuntu runners set JAVA_HOME; where CI is set and there is
 * none, the tests that need it fail instead of being skipped.
 */
function findJavaHome(): string | undefined {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  const r = spawnSync("/usr/libexec/java_home", ["-v", "17+"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}
const javaHome = findJavaHome();
const skipWithoutJdk = { skip: javaHome === undefined && !process.env.CI ? "no JDK: keytool and jarsigner are not there" : false };

const STORE_PASSWORD = "a password of the test";

/** A directory for one test, removed after it. */
function tempDir(t: { after: (f: () => void) => void }, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `iamreal-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An upload key as the environment holds it (#162): a PKCS12 file, base64, with the alias `upload`. */
function uploadKey(dir: string): { base64: string; certificate: string } {
  const store = join(dir, "upload.p12");
  const keytool = join(javaHome!, "bin", "keytool");
  execFileSync(keytool, ["-genkeypair", "-keystore", store, "-storetype", "PKCS12", "-storepass", STORE_PASSWORD, "-alias", "upload", "-keyalg", "RSA", "-keysize", "2048", "-validity", "1", "-dname", "CN=alice"], { stdio: "ignore" });
  const certificate = execFileSync(keytool, ["-exportcert", "-rfc", "-keystore", store, "-storetype", "PKCS12", "-storepass", STORE_PASSWORD, "-alias", "upload"], { encoding: "utf8" });
  const base64 = readFileSync(store).toString("base64");
  rmSync(store);
  return { base64, certificate };
}

/** A zip with a bundle's shape, enough for jarsigner: what the build job hands on. */
function unsignedBundle(dir: string): string {
  const files = join(dir, "bundle-files");
  mkdirSync(join(files, "base", "dex"), { recursive: true });
  writeFileSync(join(files, "base", "dex", "classes.dex"), "dex\n");
  writeFileSync(join(files, "BundleConfig.pb"), "config\n");
  mkdirSync(join(files, "base", "assets"), { recursive: true });
  writeFileSync(join(files, "base", "assets", "a name with spaces.json"), "{}\n");
  const bundle = join(dir, "app-release.aab");
  execFileSync("zip", ["--quiet", "--recurse-paths", bundle, "base", "BundleConfig.pb"], { cwd: files });
  return bundle;
}

/** Runs android-sign.sh as the upload job does, with the key in the environment and a temporary directory of the test's. */
function sign(dir: string, key: string, password: string, from: string, to: string, jdk = javaHome!): { status: number | null; stderr: string; temp: string } {
  const temp = join(dir, "temp");
  mkdirSync(temp, { recursive: true });
  const r = spawnSync("bash", [join(WORKFLOWS_DIR, "android-sign.sh"), from, to], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", JAVA_HOME: jdk, TMPDIR: temp, ANDROID_UPLOAD_KEYSTORE_BASE64: key, ANDROID_UPLOAD_KEYSTORE_PASSWORD: password },
  });
  return { status: r.status, stderr: r.stderr, temp };
}

test("android-sign.sh: signs the bundle with the upload key, leaves the bundle it was given as it was, and leaves no key behind", skipWithoutJdk, (t) => {
  assert.ok(javaHome, "no JDK, and CI is set: this test must run here");
  const dir = tempDir(t, "android-sign");
  const key = uploadKey(dir);
  const from = unsignedBundle(dir);
  const before = readFileSync(from);
  const to = join(dir, "signed", "app-release.aab");
  const r = sign(dir, key.base64, STORE_PASSWORD, from, to);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(from), before);
  assert.deepEqual(readdirSync(r.temp), []);
  const verified = execFileSync(join(javaHome, "bin", "jarsigner"), ["-verify", to], { encoding: "utf8" });
  assert.match(verified, /^jar verified\./m);
  // The certificate it is signed with is the upload key's.
  const signer = execFileSync(join(javaHome, "bin", "keytool"), ["-printcert", "-rfc", "-jarfile", to], { encoding: "utf8" });
  assert.ok(signer.includes(key.certificate.trim()), signer);
});

test("android-sign.sh: stops with the wrong password, and when the signed bundle holds more than the bundle and the signature", skipWithoutJdk, (t) => {
  assert.ok(javaHome, "no JDK, and CI is set: this test must run here");
  const dir = tempDir(t, "android-sign");
  const key = uploadKey(dir);
  const from = unsignedBundle(dir);

  const wrong = sign(dir, key.base64, "not the password", from, join(dir, "wrong", "app-release.aab"));
  assert.notEqual(wrong.status, 0);
  assert.deepEqual(readdirSync(wrong.temp), []);

  // A jarsigner that signs, and then puts one more file into what it signed.
  const jdk = join(dir, "jdk");
  mkdirSync(join(jdk, "bin"), { recursive: true });
  writeFileSync(join(dir, "extra file.dex"), "more\n");
  writeFileSync(
    join(jdk, "bin", "jarsigner"),
    `#!/usr/bin/env bash\nset -e\n"${javaHome}/bin/jarsigner" "$@"\nif [ "$1" != -verify ]; then (cd "${dir}" && zip --quiet "\${11}" "extra file.dex"); fi\n`,
    { mode: 0o755 },
  );
  const more = sign(dir, key.base64, STORE_PASSWORD, from, join(dir, "more", "app-release.aab"), jdk);
  assert.notEqual(more.status, 0);
  assert.match(more.stderr, /extra file\.dex/);
});

/**
 * A stand-in for curl, put first on PATH: it writes down each call (its
 * arguments, and what it read from each `@file` and from stdin) as a line of
 * JSON, and answers as Google's token endpoint and the Google Play Android
 * Developer API answer (https://developers.google.com/android-publisher).
 * The call whose URL has FAIL_AT in it gets the API's answer to a package
 * it does not know, with curl's exit code for --fail-with-body (22).
 */
const CURL = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
// What it read from a file or stdin, by the option and the argument: the bundle in base64, the rest as text.
const files = {};
for (const [i, a] of args.entries()) {
  if (i === 0 || !a.startsWith("@")) continue;
  const bytes = fs.readFileSync(a === "@-" ? 0 : a.slice(1));
  files[args[i - 1] + " " + a] = args[i - 1] === "--data-binary" ? bytes.toString("base64") : bytes.toString("utf8");
}
const url = args.find((a) => a.startsWith("https://"));
fs.appendFileSync(process.env.CURL_LOG, JSON.stringify({ args, files, url }) + "\n");
if (process.env.FAIL_AT && url.includes(process.env.FAIL_AT)) {
  process.stdout.write(JSON.stringify({ error: { code: 404, message: "Package not found: tw.iamreal.app.", status: "NOT_FOUND" } }));
  process.exit(22);
}
const answer =
  url === "https://oauth2.googleapis.com/token" ? { access_token: "ya29.a-token-of-the-test", expires_in: 3599, token_type: "Bearer" }
  : url.endsWith("/edits") ? { id: "an-edit", expiryTimeSeconds: "1795000000" }
  : url.includes("/bundles?") ? { versionCode: 7, sha1: "x", sha256: "y" }
  : url.includes("/tracks/") ? JSON.parse(args[args.indexOf("--data") + 1])
  : url.endsWith(":commit") ? { id: "an-edit" }
  : null;
if (answer === null) { process.stderr.write("no such call: " + url); process.exit(22); }
process.stdout.write(JSON.stringify(answer));
`;

type Call = { args: string[]; files: Record<string, string>; url: string };

/** A service account's key as Google gives it (its JSON), with a key made for the test. */
function serviceAccount(): { json: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const json = JSON.stringify({
    type: "service_account",
    project_id: "a-project",
    private_key_id: "0123",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    client_email: "uploader@a-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
  return { json, publicKey: publicKey.export({ type: "spki", format: "pem" }) as string };
}

/** Runs play-upload.sh as the upload job does, with curl replaced: the calls it made, in order. */
function upload(dir: string, json: string, bundle: string, failAt = ""): { status: number | null; stdout: string; stderr: string; calls: Call[] } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "curl"), CURL, { mode: 0o755 });
  const log = join(dir, "curl.log");
  rmSync(log, { force: true });
  const r = spawnSync("bash", [join(WORKFLOWS_DIR, "play-upload.sh"), bundle], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, CURL_LOG: log, FAIL_AT: failAt, PLAY_SERVICE_ACCOUNT_JSON: json },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call) : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/tw.iamreal.app";
const UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/tw.iamreal.app";

test("play-upload.sh: gets a token with the service account's key, then puts the bundle on the internal testing track of tw.iamreal.app in one edit", (t) => {
  const dir = tempDir(t, "play-upload");
  const account = serviceAccount();
  const bundle = join(dir, "app-release.aab");
  writeFileSync(bundle, "a bundle\n");
  const r = upload(dir, account.json, bundle);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.calls.map((c) => c.url),
    ["https://oauth2.googleapis.com/token", `${API}/edits`, `${UPLOAD_API}/edits/an-edit/bundles?uploadType=media`, `${API}/edits/an-edit/tracks/internal`, `${API}/edits/an-edit:commit`],
  );

  // The token: a JWT the service account's key signed, for the Android Publisher scope (Google's "Using OAuth 2.0 for Server to Server Applications").
  const [tokenCall, ...apiCalls] = r.calls;
  const form = new URLSearchParams(tokenCall!.files["--data @-"]!.trim());
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [header, claims, signature] = form.get("assertion")!.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const c = JSON.parse(Buffer.from(claims!, "base64url").toString());
  assert.equal(c.iss, "uploader@a-project.iam.gserviceaccount.com");
  assert.equal(c.scope, "https://www.googleapis.com/auth/androidpublisher");
  assert.equal(c.aud, "https://oauth2.googleapis.com/token");
  assert.ok(Math.abs(c.iat - Date.now() / 1000) < 60 && c.exp - c.iat <= 3600 && c.exp > c.iat, JSON.stringify(c));
  assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), createPublicKey(account.publicKey), Buffer.from(signature!, "base64url")), "the JWT's signature");

  // Every call to the API has the token, given from a file: no token and no key on any command line.
  for (const call of apiCalls) {
    const headers = Object.entries(call.files).filter(([k]) => k.startsWith("--header @")).map(([, v]) => v);
    assert.deepEqual(headers, ["Authorization: Bearer ya29.a-token-of-the-test\n"], call.url);
  }
  for (const call of r.calls) for (const a of call.args) assert.ok(!a.includes("ya29.") && !a.includes("PRIVATE KEY"), a);

  // The bundle, as it is; then the release of the version code Google Play gave it, rolled out to the testers.
  assert.equal(Buffer.from(apiCalls[1]!.files[`--data-binary @${bundle}`]!, "base64").toString(), "a bundle\n");
  const track = apiCalls[2]!;
  assert.ok(track.args.includes("PUT"), JSON.stringify(track.args));
  assert.deepEqual(JSON.parse(track.args[track.args.indexOf("--data") + 1]!), { track: "internal", releases: [{ versionCodes: ["7"], status: "completed" }] });
  assert.match(r.stdout, /versionCode 7/);
});

test("play-upload.sh: stops when Google Play turns the bundle away, and does not commit the edit", (t) => {
  const dir = tempDir(t, "play-upload");
  const bundle = join(dir, "app-release.aab");
  writeFileSync(bundle, "a bundle\n");
  const r = upload(dir, serviceAccount().json, bundle, "/bundles?");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /Package not found/);
  assert.ok(!r.calls.some((c) => c.url.endsWith(":commit")), JSON.stringify(r.calls.map((c) => c.url)));
});

test("android-version.sh: the greatest build number Google Play takes is taken", () => {
  assert.equal(version([], "2100000000", "2026-11-21T03:00:00Z").stdout, "name=2026.11.21\ncode=2100000000\n");
});
