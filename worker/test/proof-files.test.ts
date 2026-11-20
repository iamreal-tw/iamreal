// The card proof page (/proof) and its files, through the Worker's HTTP
// (test/harness.ts): the files of Static Assets, sent by the Worker with the
// headers web/README.md says the page needs, word for word. The files here
// are made up; what the page does with those headers in a browser is for the
// tests of web/.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { freshRoster } from "./records.ts";

const FILES: Readonly<Record<string, string>> = {
  "index.html": '<!DOCTYPE html><title>the card proof page</title><script type="module" src="/proof/assets/index.js"></script>',
  "help.html": "<!DOCTYPE html><title>help</title>",
  "assets/index.js": "console.log('the page');",
  "circuits/card_proof_rs2048.json": "{}",
  "crs/bn254_g2.dat": "\u0000\u0001",
  "bb/barretenberg.wasm.gz": "\u001f\u008b",
};

let worker: TestWorker;
let bare: TestWorker;
let dir: string;
before(async () => {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  dir = mkdtempSync(join(WORKER_DIR, "test-output", "proof-files-"));
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text, "latin1");
  }
  [worker, bare] = await Promise.all([startWorker({ proofFiles: dir }), startWorker()]);
});
after(async () => {
  await Promise.all([worker.close(), bare.close()]);
  rmSync(dir, { recursive: true, force: true });
});

/** The three headers as web/README.md, "頁面需要的標頭", writes them: the policy in its code block, the other two in their headings. */
function headersInWebReadme(): Record<string, string> {
  const readme = readFileSync(join(WORKER_DIR, "..", "web", "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("\n## 頁面需要的標頭"));
  const csp = /### `Content-Security-Policy`\n[\s\S]*?\n```\n([^\n]+)\n```\n/.exec(section)?.[1];
  assert.ok(csp !== undefined, "web/README.md quotes the policy");
  const others = [...section.matchAll(/^### `([A-Za-z-]+): ([^`]+)`$/gm)].map((m) => [m[1]!.toLowerCase(), m[2]!]);
  assert.equal(others.length, 2, "web/README.md has a heading for each of the other two headers");
  return { "content-security-policy": csp, ...Object.fromEntries(others) };
}

/** What a response of the card proof page has for headers: the three of web/README.md, nosniff, and on a test roster noindex; what describes the file aside. */
function checkProofHeaders(what: string, res: Response, expect: { test?: boolean; more?: readonly string[] } = {}): void {
  const want = { ...headersInWebReadme(), "x-content-type-options": "nosniff", ...(expect.test !== false && { "x-robots-tag": "noindex" }) };
  const got: Record<string, string> = {};
  const aside = new Set(["content-type", "content-length", "transfer-encoding", "mf-content-encoding", "content-encoding", "connection", "date", "vary", "etag", "cache-control", ...(expect.more ?? [])]);
  res.headers.forEach((value, name) => {
    if (!aside.has(name)) got[name] = value;
  });
  assert.deepEqual(got, want, `${what}: the headers`);
  assert.equal(res.headers.get("set-cookie"), null, `${what}: no cookie`);
}

test("web/README.md quotes the three headers the page needs", () => {
  assert.deepEqual(Object.keys(headersInWebReadme()).sort(), ["content-security-policy", "cross-origin-opener-policy", "document-isolation-policy"]);
});

test("/proof is the build's index.html, and every file of the build is under /proof/, each with the headers of web/README.md", async () => {
  await freshRoster(worker);
  const page = await worker.fetch("/proof");
  assert.deepEqual([page.status, page.headers.get("content-type"), await page.text()], [200, "text/html; charset=utf-8", FILES["index.html"]]);
  checkProofHeaders("/proof", page);
  for (const [name, text] of Object.entries(FILES)) {
    const res = await worker.fetch(`/proof/${name}`);
    assert.deepEqual([res.status, Buffer.from(await res.arrayBuffer()).toString("latin1")], [200, text], name);
    checkProofHeaders(`/proof/${name}`, res);
  }
  assert.equal((await worker.fetch("/proof/assets/index.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
  // The help page is linked with a query (design/copy/home.md, section 9).
  const help = await worker.fetch("/proof/help.html?topic=prepare");
  assert.deepEqual([help.status, await help.text()], [200, FILES["help.html"]]);
});

test("/proof/ is redirected (301) to /proof, the one address of the page", async () => {
  const res = await worker.fetch("/proof/", { redirect: "manual" });
  assert.deepEqual([res.status, res.headers.get("location")], [301, "/proof"]);
  checkProofHeaders("/proof/", res, { more: ["location"] });
});

test("what is not a file of the build is 404, a directory too; nothing outside it is served under /proof", async () => {
  for (const path of ["/proof/nothing.js", "/proof/assets", "/proof/assets/", "/proof/pages.css", "/proof/index", "/proof/help", "/proofs", "/proof.html"]) {
    const res = await worker.fetch(path, { redirect: "manual" });
    assert.equal(res.status, 404, path);
    if (path.startsWith("/proof/")) checkProofHeaders(path, res);
  }
  // The style sheet is the visitors' pages', with their headers, not the card proof page's.
  const css = await worker.fetch("/pages.css");
  assert.equal(css.headers.get("document-isolation-policy"), null);
  assert.match(css.headers.get("content-security-policy") ?? "", /^default-src 'none'; style-src 'self';/);
});

test("the page and its files take GET and HEAD only, and are asked again by their ETag", async () => {
  for (const path of ["/proof", "/proof/assets/index.js", "/proof/"]) {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await worker.fetch(path, { method, redirect: "manual" });
      assert.deepEqual([res.status, res.headers.get("allow")], [405, "GET, HEAD"], `${method} ${path}`);
      checkProofHeaders(`${method} ${path}`, res, { more: ["allow"] });
    }
  }
  const head = await worker.fetch("/proof", { method: "HEAD" });
  assert.deepEqual([head.status, await head.text()], [200, ""]);
  checkProofHeaders("HEAD /proof", head);
  const etag = (await worker.fetch("/proof")).headers.get("etag");
  assert.ok(etag);
  const again = await worker.fetch("/proof", { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  checkProofHeaders("/proof again", again);
});

test("on the production roster the same, without noindex", async () => {
  await freshRoster(worker, { kind: "production" });
  const res = await worker.fetch("/proof");
  assert.equal(res.status, 200);
  checkProofHeaders("/proof", res, { test: false });
  await freshRoster(worker);
});

test("a Worker without a build of web/ among its files: /proof and everything under it is 404, with the same headers", async () => {
  for (const path of ["/proof", "/proof/index.html", "/proof/help.html"]) {
    const res = await bare.fetch(path);
    assert.equal(res.status, 404, path);
    checkProofHeaders(path, res);
  }
  assert.equal((await bare.fetch("/proof/", { redirect: "manual" })).status, 301);
  assert.equal((await bare.fetch("/pages.css")).status, 200);
});
