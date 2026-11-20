// The API of docs/api/card-proof.md as the whole Worker answers it in the
// local workerd (test/harness.ts): challenges, card-state and config, and
// what every answer under /api/ has in common. The cases are those of the Go
// backend's server/api_test.go for these endpoints.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { type TestWorker, startWorker } from "./harness.ts";

const repoText = (path: string): string => readFileSync(join(WORKER_DIR, "..", path), "utf8");

/** Noon in Taiwan on 2026-11-20. */
const NOON = new Date("2026-11-20T04:00:00.000Z");

const TEST_SCOPE = "iamreal-test:public:0__________";
/** A scoped ID in its one spelling (spec/vectors/scoped-id.json). */
const CARD: string = (JSON.parse(repoText("spec/vectors/scoped-id.json")) as { encoding: { scoped_id: string }[] }).encoding[0]!.scoped_id;

async function jsonOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

describe("GET /api/v1/config", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  test("the test roster's table lists test-example and threads, in ascending order, with the keys in the document's order", async () => {
    const res = await worker.fetch("/api/v1/config");
    assert.equal(res.status, 200);
    assert.equal(
      await res.text(),
      '{"crl_max_age_days":3,"platforms":[{"platform":"test-example","display_name":"Example (no real service)","username_format":"[a-z0-9-]{1,20}"},{"platform":"threads","display_name":"Threads","username_format":"[a-z0-9._]{1,30}"}]}',
    );
  });

  test("each format string is the one spec/scope.md writes, character for character", async () => {
    const { platforms } = (await jsonOf(await worker.fetch("/api/v1/config"))) as { platforms: { platform: string; display_name: string; username_format: string }[] };
    const spec = repoText("spec/scope.md");
    assert.equal(platforms.length, 2);
    for (const p of platforms) assert.ok(spec.includes(`| \`${p.platform}\` | ${p.display_name} | \`${p.username_format}\` |`), p.platform);
  });
});

/** Every endpoint of this back end so far, with a request it answers 200. */
const ENDPOINTS = [
  { method: "POST", path: "/api/v1/challenges", body: undefined },
  { method: "POST", path: "/api/v1/card-state", body: JSON.stringify({ scope_string: TEST_SCOPE, scoped_id: CARD }) },
  { method: "GET", path: "/api/v1/config", body: undefined },
] as const;

describe("every answer under /api/", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
    await worker.setClock(NOON);
  });
  after(() => worker.close());

  /** The headers every answer has, and the ones none has. Returns the request ID. */
  function checkHeaders(res: Response, what: string): string {
    assert.equal(res.headers.get("Content-Type"), "application/json", what);
    assert.equal(res.headers.get("Cache-Control"), "no-store", what);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff", what);
    const id = res.headers.get("X-Request-Id");
    assert.match(id ?? "", /^[0-9a-f]{16}$/, what);
    assert.equal(res.headers.get("Set-Cookie"), null, what);
    for (const [name] of res.headers) assert.doesNotMatch(name, /^access-control-/i, what);
    return id!;
  }

  test("is JSON, is not cached, carries a request ID of its own, and sets no cookie and no CORS header", async () => {
    const ids = new Set<string>();
    for (const e of ENDPOINTS) {
      const res = await worker.fetch(e.path, { method: e.method, body: e.body });
      assert.equal(res.status, 200, e.path);
      ids.add(checkHeaders(res, e.path));
      await res.text();
    }
    for (const [method, path] of [["GET", "/api/v1/nothing"], ["GET", "/api/v1/challenges"], ["POST", "/api/v1/card-state"]] as const) {
      const res = await worker.fetch(path, { method });
      ids.add(checkHeaders(res, `${method} ${path}`));
      await res.text();
    }
    assert.equal(ids.size, ENDPOINTS.length + 3);
  });

  test("a path that is no endpoint is 404 not_found", async () => {
    for (const [method, path] of [["GET", "/api/v1/card-state/QSP7N6"], ["GET", "/api/v1/nothing"], ["POST", "/api/v2/challenges"], ["GET", "/api/"], ["GET", "/api/v1/config/"], ["GET", "/api/v1/head"], ["POST", "/api/v1/toString"]] as const) {
      const res = await worker.fetch(path, { method });
      assert.equal(res.status, 404, path);
      assert.deepEqual(await jsonOf(res), { error: "not_found" }, path);
    }
  });

  test("another method is 405 method_not_allowed, with Allow", async () => {
    for (const [method, path, allow] of [["GET", "/api/v1/challenges", "POST"], ["GET", "/api/v1/card-state", "POST"], ["POST", "/api/v1/config", "GET"], ["PUT", "/api/v1/config", "GET"], ["DELETE", "/api/v1/challenges", "POST"], ["HEAD", "/api/v1/config", "GET"]] as const) {
      const res = await worker.fetch(path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get("Allow"), allow, `${method} ${path}`);
      if (method !== "HEAD") assert.deepEqual(await jsonOf(res), { error: "method_not_allowed" }, `${method} ${path}`);
    }
  });

  test("outside /api/ there is still no page", async () => {
    for (const path of ["/", "/api", "/apix/v1/config"]) assert.equal((await worker.fetch(path)).status, 404, path);
  });
});
