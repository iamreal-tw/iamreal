// The card proof page (/proof) and its files, over the HTTP of the local
// workerd (test/harness.ts): Static Assets sends them itself, with the
// headers of site/_headers, and no code of the Worker runs for them
// (wrangler.jsonc, "assets"; README.md, "Static Assets"). The headers are the
// ones web/README.md says the page needs, word for word. The files here are
// made up; what the page does with those headers in a browser is for the
// tests of web/.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SITE_REDIRECTS, siteHeaders } from "../scripts/site-files.ts";
import { proofPageHeaders } from "../src/headers.ts";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { checkVisitorHeaders } from "./pages.ts";
import { freshProofLog } from "./records.ts";

const FILES: Readonly<Record<string, string>> = {
  "index.html": '<!DOCTYPE html><title>the card proof page</title><script type="module" src="/proof/assets/index.js"></script>',
  "assets/index.js": "console.log('the page');",
  "circuits/card_proof_rs2048.json": "{}",
  "crs/bn254_g2.dat": "\u0000\u0001",
  "bb/barretenberg.wasm.gz": "\u001f\u008b",
};

let worker: TestWorker;
let bare: TestWorker;
let production: TestWorker;
let dir: string;
before(async () => {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  dir = mkdtempSync(join(WORKER_DIR, "test-output", "proof-files-"));
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text, "latin1");
  }
  [worker, bare, production] = await Promise.all([startWorker({ proofFiles: dir }), startWorker(), startWorker({ proofFiles: dir, settings: { PROOF_LOG_KIND: "production", PROOF_LOG_OBJECT_NAME: "proof-log-1" } })]);
});
after(async () => {
  await Promise.all([worker.close(), bare.close(), production.close()]);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The three headers as web/README.md, "頁面需要的標頭", writes them for a site of that kind of proof log: the policy in
 * the code blocks of its section (the first the production log's site's, the second the test log's, which
 * differ in the data domain alone), the other two in their headings.
 */
function headersInWebReadme(kind: "test" | "production"): Record<string, string> {
  const readme = readFileSync(join(WORKER_DIR, "..", "web", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n## 頁面需要的標頭"));
  const policies = [...(/### `Content-Security-Policy`\n([\s\S]*?)\n### /.exec(section)?.[1] ?? "").matchAll(/\n```\n([^\n]+)\n```\n/g)].map((m) => m[1]!);
  assert.equal(policies.length, 2, "web/README.md quotes the policy of the production log's site, then the test log's");
  const others = [...section.matchAll(/^### `([A-Za-z-]+): ([^`]+)`$/gm)].map((m) => [m[1]!.toLowerCase(), m[2]!]);
  assert.equal(others.length, 2, "web/README.md has a heading for each of the other two headers");
  return { "content-security-policy": policies[kind === "production" ? 0 : 1]!, ...Object.fromEntries(others) };
}

/** What a response of the card proof page has for headers: the three of web/README.md, nosniff, and on a test log noindex; what describes the file aside. */
function checkProofHeaders(what: string, res: Response, expect: { test?: boolean; more?: readonly string[] } = {}): void {
  const want = { ...headersInWebReadme(expect.test === false ? "production" : "test"), "x-content-type-options": "nosniff", ...(expect.test !== false && { "x-robots-tag": "noindex" }) };
  const got: Record<string, string> = {};
  const aside = new Set(["content-type", "content-length", "transfer-encoding", "mf-content-encoding", "content-encoding", "connection", "date", "vary", "etag", "cache-control", "cf-cache-status", ...(expect.more ?? [])]);
  res.headers.forEach((value, name) => {
    if (!aside.has(name)) got[name] = value;
  });
  assert.deepEqual(got, want, `${what}: the headers`);
  assert.equal(res.headers.get("set-cookie"), null, `${what}: no cookie`);
}

test("web/README.md quotes the three headers the page needs for each kind of proof log, and they are the ones of src/headers.ts", () => {
  for (const kind of ["production", "test"] as const) {
    const quoted = headersInWebReadme(kind);
    assert.deepEqual(Object.keys(quoted).sort(), ["content-security-policy", "cross-origin-opener-policy", "document-isolation-policy"]);
    assert.deepEqual(quoted, Object.fromEntries(Object.entries(proofPageHeaders(kind)).map(([name, value]) => [name.toLowerCase(), value])), kind);
  }
});

test("the page may connect to its own origin and to the data domain of its proof log, and to no other: the two sites' policies differ in that domain alone", () => {
  const connect = (kind: "test" | "production"): string | undefined => /(?:^|; )connect-src ([^;]*)/.exec(proofPageHeaders(kind)["Content-Security-Policy"]!)?.[1];
  assert.equal(connect("production"), "'self' https://data.iamreal.tw");
  assert.equal(connect("test"), "'self' https://test-data.iamreal.tw");
  assert.equal(proofPageHeaders("test")["Content-Security-Policy"]!.replace("https://test-data.iamreal.tw", "https://data.iamreal.tw"), proofPageHeaders("production")["Content-Security-Policy"]);
});

test("site/_headers and site/_redirects in the repository are the ones written from src/headers.ts for a test log", () => {
  assert.equal(readFileSync(join(WORKER_DIR, "site", "_headers"), "utf8"), siteHeaders("test"));
  assert.equal(readFileSync(join(WORKER_DIR, "site", "_redirects"), "utf8"), SITE_REDIRECTS);
  // A production log's differ in two things: no noindex, and its own data domain in the card proof page's policy.
  assert.equal(
    siteHeaders("production"),
    siteHeaders("test")
      .replace(/^  X-Robots-Tag: noindex\n/gm, "")
      .replace("a test log", "a production log")
      .replaceAll("https://test-data.iamreal.tw", "https://data.iamreal.tw"),
  );
  assert.ok(!siteHeaders("production").includes("X-Robots-Tag") && siteHeaders("test").includes("X-Robots-Tag: noindex"));
  assert.ok(!siteHeaders("production").includes("test-data") && !siteHeaders("test").includes("https://data.iamreal.tw"));
  // Cloudflare's limits (README.md, "Static Assets"): 100 rules, 2,000 characters a line.
  for (const line of siteHeaders("test").split("\n")) assert.ok(line.length <= 2000);
});

test("/proof is the build's index.html, and every file of the build is under /proof/, each with the headers of web/README.md; none of them reaches the Worker's code", async () => {
  await freshProofLog(worker);
  await worker.seen();
  const page = await worker.fetch("/proof");
  assert.deepEqual([page.status, page.headers.get("content-type"), await page.text()], [200, "text/html; charset=utf-8", FILES["index.html"]]);
  checkProofHeaders("/proof", page);
  for (const [name, text] of Object.entries(FILES)) {
    if (name === "index.html") continue;
    const res = await worker.fetch(`/proof/${name}`);
    assert.deepEqual([res.status, Buffer.from(await res.arrayBuffer()).toString("latin1")], [200, text], name);
    checkProofHeaders(`/proof/${name}`, res);
  }
  assert.equal((await worker.fetch("/proof/assets/index.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.deepEqual(await worker.seen(), [], "the Worker's code ran for none of these requests");
  // The same door does see what the Worker answers.
  await worker.fetch("/");
  await worker.fetch("/api/v1/config");
  assert.deepEqual(await worker.seen(), ["GET /", "GET /api/v1/config"]);
});

test("/proof/ and /proof/index.html are redirected (301) to /proof, the one address of the page; the help page's old address to /prepare", async () => {
  await worker.seen();
  for (const [path, to] of [
    ["/proof/", "/proof"],
    ["/proof/index.html", "/proof"],
    ["/proof/?topic=prepare", "/proof?topic=prepare"],
    ["/proof/help.html", "/prepare"],
    ["/proof/help.html?topic=more", "/prepare?topic=more"],
  ] as const) {
    const res = await worker.fetch(path, { redirect: "manual" });
    assert.deepEqual([res.status, res.headers.get("location")], [301, to], path);
    checkProofHeaders(path, res, { more: ["location"] });
  }
  assert.deepEqual(await worker.seen(), []);
  // Where the apps' links to the help page land (design/copy/card-proof.md, app 改版之前還在用的句子): the Worker's page, with the query.
  const prepare = await worker.fetch("/prepare?topic=more");
  assert.deepEqual([prepare.status, (await prepare.text()).includes(">過卡需要什麼</h1>")], [200, true]);
});

test("what is not a file of the build is 404, a directory too, without the Worker; nothing outside the build is served under /proof", async () => {
  await worker.seen();
  for (const path of ["/proof/nothing.js", "/proof/assets", "/proof/assets/", "/proof/pages.css", "/proof/index", "/proof/help", "/proof/_headers", "/proof/Index.html", "/proof/..%2fpages.css"]) {
    const res = await worker.fetch(path, { redirect: "manual" });
    assert.deepEqual([res.status, await res.text()], [404, ""], path);
    checkProofHeaders(path, res);
  }
  assert.deepEqual(await worker.seen(), []);
  // Beside /proof, not under it: the Worker's page for what is not there. The two files that hold the rules are not served.
  for (const path of ["/proofs", "/proof.html", "/Proof", "/_headers", "/_redirects"]) {
    const res = await worker.fetch(path, { redirect: "manual" });
    assert.deepEqual([res.status, res.headers.get("content-type"), (await res.text()).includes("找不到這一頁")], [404, "text/html; charset=utf-8", true], path);
  }
  assert.deepEqual(await worker.seen(), ["GET /proofs", "GET /proof.html", "GET /Proof", "GET /_headers", "GET /_redirects"]);
});

test("another spelling of a file's path is redirected (307) to the file's own, or is 404; a path that leaves /proof is the path it normalizes to", async () => {
  for (const [path, to] of [["/proof//index.html", "/proof/index.html"], ["/proof/%69ndex.html", "/proof/index.html"], ["/proof/assets%2findex.js", "/proof/assets/index.js"]] as const) {
    const res = await worker.fetch(path, { redirect: "manual" });
    assert.deepEqual([res.status, res.headers.get("location")], [307, to], path);
  }
  // The URL is normalized before anything looks at it: this is /pages.css, with the style sheet's headers.
  for (const path of ["/proof/../pages.css", "/proof/%2e%2e/pages.css"]) {
    const res = await worker.fetch(path);
    assert.deepEqual([res.status, res.headers.get("content-type"), res.headers.get("document-isolation-policy")], [200, "text/css; charset=utf-8", null], path);
  }
});

test("the page and its files take GET and HEAD only, and are asked again by their ETag", async () => {
  await worker.seen();
  for (const method of ["POST", "PUT", "DELETE"]) {
    // Static Assets answers 405 by itself, without an Allow header.
    for (const path of ["/proof", "/proof/assets/index.js", "/proof/nothing.js"]) {
      const res = await worker.fetch(path, { method, redirect: "manual" });
      assert.deepEqual([res.status, await res.text()], [path === "/proof/nothing.js" ? 404 : 405, ""], `${method} ${path}`);
      checkProofHeaders(`${method} ${path}`, res);
    }
    // A redirect is the same for every method; what it leads to is the 405 above.
    const res = await worker.fetch("/proof/", { method, redirect: "manual" });
    assert.deepEqual([res.status, res.headers.get("location")], [301, "/proof"], `${method} /proof/`);
  }
  const head = await worker.fetch("/proof", { method: "HEAD" });
  assert.deepEqual([head.status, await head.text()], [200, ""]);
  checkProofHeaders("HEAD /proof", head);
  const first = await worker.fetch("/proof");
  assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
  const etag = first.headers.get("etag");
  assert.ok(etag);
  const again = await worker.fetch("/proof", { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  checkProofHeaders("/proof again", again);
  assert.deepEqual(await worker.seen(), []);
});

test("the settings do not reach the files: with settings the Worker answers 500 for, the page, the style sheet and the script are sent as before", async () => {
  await worker.setSettings({ PROOF_LOG_KIND: "production", PROOF_LOG_OBJECT_NAME: "test-1" });
  assert.equal((await worker.fetch("/")).status, 500);
  checkProofHeaders("/proof", await worker.fetch("/proof"));
  checkVisitorHeaders("/pages.css", await worker.fetch("/pages.css"), { cache: "no-cache" });
  checkVisitorHeaders("/copy.js", await worker.fetch("/copy.js"), { cache: "no-cache" });
  await freshProofLog(worker);
});

test("a production log's site: the same files, the same headers without noindex", async () => {
  await freshProofLog(production, { kind: "production" });
  const res = await production.fetch("/proof");
  assert.deepEqual([res.status, await res.text()], [200, FILES["index.html"]]);
  checkProofHeaders("/proof", res, { test: false });
  checkProofHeaders("/proof/assets/index.js", await production.fetch("/proof/assets/index.js"), { test: false });
  checkProofHeaders("/proof/nothing", await production.fetch("/proof/nothing"), { test: false });
  checkVisitorHeaders("/pages.css", await production.fetch("/pages.css"), { cache: "no-cache", noindex: false });
  checkVisitorHeaders("/copy.js", await production.fetch("/copy.js"), { cache: "no-cache", noindex: false });
});

test("a Worker without a build of web/ among its files: /proof and everything under it is 404, with the same headers and without the Worker", async () => {
  await bare.seen();
  for (const path of ["/proof", "/proof/index.html", "/proof/"]) {
    const res = await bare.fetch(path);
    assert.equal(res.status, 404, path);
    checkProofHeaders(path, res);
  }
  assert.equal((await bare.fetch("/pages.css")).status, 200);
  assert.equal((await bare.fetch("/copy.js")).status, 200);
  assert.deepEqual(await bare.seen(), []);
});
