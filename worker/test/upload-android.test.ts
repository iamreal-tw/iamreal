// The scripts of .github/workflows/upload-android.yml and upload-android-test.yml, run here as their jobs
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

/** Runs android-version.sh as the build job does: the run's number, the time now, and the app's number (0: the production app's). */
function version(runNumber: string, now: string, added = "0"): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", [join(WORKFLOWS_DIR, "android-version.sh"), runNumber, now, added], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("android-version.sh: the name is the date in Taiwan, year.month.day with no zeros added; the build is the run's number", () => {
  // 2026-11-04 17:30 UTC is 01:30 on the 5th in Taiwan.
  const r = version("7", "2026-11-04T17:30:00Z");
  assert.equal(r.stderr, "");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "name=2026.11.5\ncode=7\n");
  // The day in Taiwan, 2026-11-21, runs from 16:00 UTC on the 20th to 15:59:59 UTC on the 21st.
  assert.equal(version("8", "2026-11-20T15:59:59Z").stdout, "name=2026.11.20\ncode=8\n");
  assert.equal(version("9", "2026-11-20T16:00:00Z").stdout, "name=2026.11.21\ncode=9\n");
  assert.equal(version("10", "2026-12-31T16:00:00Z").stdout, "name=2027.1.1\ncode=10\n");
  // A second run on the same day: the same name, the next build (.github/README.md).
  assert.equal(version("11", "2026-11-21T15:59:59Z").stdout, "name=2026.11.21\ncode=11\n");
});

test("android-version.sh: stops on a run number that is not a build number Google Play takes, or a time it cannot read", () => {
  for (const [runNumber, now] of [
    ["0", "2026-11-21T03:00:00Z"],
    ["7a", "2026-11-21T03:00:00Z"],
    ["", "2026-11-21T03:00:00Z"],
    ["07", "2026-11-21T03:00:00Z"],
    // "The greatest value Google Play allows for versionCode is 2100000000" (Android's "Version your app").
    ["2100000001", "2026-11-21T03:00:00Z"],
    ["7", "2026-11-21 03:00"],
    ["7", "yesterday"],
  ] as const) {
    const r = version(runNumber, now);
    assert.notEqual(r.status, 0, JSON.stringify([runNumber, now]));
    assert.equal(r.stdout, "", JSON.stringify([runNumber, now]));
  }
});

test("android-version.sh: the greatest build number Google Play takes is taken", () => {
  assert.equal(version("2100000000", "2026-11-21T03:00:00Z").stdout, "name=2026.11.21\ncode=2100000000\n");
  assert.equal(version("1100000000", "2026-11-21T03:00:00Z", "1000000000").stdout, "name=2026.11.21\ncode=2100000000\n");
});

test("android-version.sh: the test app's build is its run's number plus 1,000,000 (upload-android-test.yml, ADR-0040)", () => {
  assert.equal(version("1", "2026-11-21T03:00:00Z", "1000000").stdout, "name=2026.11.21\ncode=1000001\n");
  assert.equal(version("42", "2026-11-21T03:00:00Z", "1000000").stdout, "name=2026.11.21\ncode=1000042\n");
});

test("android-version.sh: stops on a number added that is not one, or a build number above what Google Play takes", () => {
  for (const [runNumber, added] of [
    ["7", ""],
    ["7", "-1"],
    ["7", "01000000"],
    ["7", "1e6"],
    ["2100000000", "1"],
  ] as const) {
    const r = version(runNumber, "2026-11-21T03:00:00Z", added);
    assert.notEqual(r.status, 0, JSON.stringify([runNumber, added]));
    assert.equal(r.stdout, "", JSON.stringify([runNumber, added]));
  }
  // Two arguments, as before #483: the app's number is not left to a default.
  const r = spawnSync("bash", [join(WORKFLOWS_DIR, "android-version.sh"), "7", "2026-11-21T03:00:00Z"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
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
function upload(dir: string, json: string, bundle: string, failAt = "", packageName = "tw.iamreal.app"): { status: number | null; stdout: string; stderr: string; calls: Call[] } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "curl"), CURL, { mode: 0o755 });
  const log = join(dir, "curl.log");
  rmSync(log, { force: true });
  const r = spawnSync("bash", [join(WORKFLOWS_DIR, "play-upload.sh"), packageName, bundle], {
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
  // A POST with no body still says how long its body is (an empty one): a server may want Content-Length.
  assert.equal(apiCalls[3]!.args[apiCalls[3]!.args.indexOf("--data") + 1], "");
  assert.match(r.stdout, /versionCode 7/);
});

test("play-upload.sh: the test app's bundle goes to tw.iamreal.app.test, the package it is given (upload-android-test.yml)", (t) => {
  const dir = tempDir(t, "play-upload");
  const bundle = join(dir, "app-trial.aab");
  writeFileSync(bundle, "a bundle\n");
  const r = upload(dir, serviceAccount().json, bundle, "", "tw.iamreal.app.test");
  assert.equal(r.status, 0, r.stderr);
  const api = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/tw.iamreal.app.test";
  const uploadApi = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/tw.iamreal.app.test";
  assert.deepEqual(
    r.calls.map((c) => c.url),
    ["https://oauth2.googleapis.com/token", `${api}/edits`, `${uploadApi}/edits/an-edit/bundles?uploadType=media`, `${api}/edits/an-edit/tracks/internal`, `${api}/edits/an-edit:commit`],
  );
  assert.match(r.stdout, /on the internal track of tw\.iamreal\.app\.test/);
});

test("play-upload.sh: stops before any call on a package that is not a package name", (t) => {
  const dir = tempDir(t, "play-upload");
  const bundle = join(dir, "app-release.aab");
  writeFileSync(bundle, "a bundle\n");
  for (const packageName of ["", "tw", "tw.iamreal.app/../other", "tw.iamreal.app?x=1", "Tw.iamreal.app", "tw.iamreal.app "]) {
    const r = upload(dir, serviceAccount().json, bundle, "", packageName);
    assert.notEqual(r.status, 0, JSON.stringify(packageName));
    assert.deepEqual(r.calls, [], JSON.stringify(packageName));
  }
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

