// The whole Worker in the local workerd (test/harness.ts): what it answers
// over HTTP and what its schedule leaves in the simulated R2 bucket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

// Not CRLs: the mirror keeps whatever bytes MOICA gives, and checks nothing yet.
const G2_FIRST = bytes("the fake MOICA's G2 CRL, first");
const G3_FIRST = bytes("the fake MOICA's G3 CRL, first");
const G3_SECOND = bytes("the fake MOICA's G3 CRL, second");

const nameOf = (crl: Uint8Array): string => `crl/${sha256(crl)}.crl`;

describe("the Worker in the local workerd", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  test("it starts without a Cloudflare account and answers HTTP; it has no page or API yet", async () => {
    const res = await fetch(new URL("/", worker.url));
    assert.equal(res.status, 404);
    assert.equal((await worker.fetch("/api/v1/config")).status, 404);
  });

  test("the clock the Worker reads is the one the test set", async () => {
    worker.moica.serve("G2", G2_FIRST);
    worker.moica.serve("G3", G3_FIRST);
    await worker.setClock(new Date("2026-11-20T15:59:59.000Z"));
    await worker.runSchedule();
    const lines = worker.logLines().filter((l) => l.includes("crl_mirror"));
    assert.equal(lines.length, 2);
    for (const l of lines) assert.equal(JSON.parse(l).at, "2026-11-20T15:59:59.000Z");
  });
});

describe("the hourly schedule mirrors MOICA's two CRLs", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  test("each CRL is stored as the bytes MOICA gave, named by their SHA-256", async () => {
    worker.moica.serve("G2", G2_FIRST);
    worker.moica.serve("G3", G3_FIRST);
    assert.deepEqual(await worker.files(), []);

    assert.deepEqual(await worker.runSchedule(), { outcome: "ok", noRetry: false });

    const files = await worker.files();
    assert.deepEqual(files.map((f) => f.key), [nameOf(G2_FIRST), nameOf(G3_FIRST)].sort());
    for (const f of files) assert.equal(f.key, nameOf(f.bytes));
    // A file's name never gets other bytes: it may be cached for a year.
    for (const f of files) assert.equal(f.cacheControl, "public, max-age=31536000, immutable");
  });

  test("a second run with the same CRLs stores nothing again", async () => {
    const before = await worker.files();
    assert.equal(before.length, 2);
    await new Promise((resolve) => setTimeout(resolve, 20)); // so that a rewritten file would have a later time

    assert.equal((await worker.runSchedule()).outcome, "ok");

    const after = await worker.files();
    assert.deepEqual(after.map((f) => [f.key, f.uploaded.getTime()]), before.map((f) => [f.key, f.uploaded.getTime()]));
  });

  test("a CRL that changed is stored next to the earlier ones", async () => {
    worker.moica.serve("G3", G3_SECOND);

    assert.equal((await worker.runSchedule()).outcome, "ok");

    assert.deepEqual((await worker.files("crl/")).map((f) => f.key), [nameOf(G2_FIRST), nameOf(G3_FIRST), nameOf(G3_SECOND)].sort());
  });

  test("the requests to MOICA carry a general User-Agent that does not name the project", () => {
    assert.ok(worker.moica.requests.length >= 6);
    for (const r of worker.moica.requests) {
      assert.equal(r.userAgent, "Mozilla/5.0 (compatible)");
      // Every header the Worker's own code decides. `CF-Worker` is not one: Cloudflare adds it to
      // each request a Worker sends, with the name of the zone the Worker runs on, and the local
      // workerd imitates it with the Worker's name (README.md, "內政部看得到什麼").
      const { "cf-worker": _, ...own } = r.headers;
      assert.doesNotMatch(JSON.stringify(own), /iamreal/i);
    }
  });
});

describe("when MOICA answers with an error", () => {
  for (const [failing, working, crl] of [["G2", "G3", G3_FIRST], ["G3", "G2", G2_FIRST]] as const) {
    test(`${failing} fails: nothing of it is stored, ${working}'s CRL is, and the run shows as failed`, async () => {
      const worker = await startWorker();
      try {
        worker.moica.fail(failing, 503);
        worker.moica.serve(working, crl);

        assert.equal((await worker.runSchedule()).outcome, "exception");

        assert.deepEqual(worker.moica.requests.map((r) => r.issuer), ["G2", "G3"]);
        assert.deepEqual((await worker.files()).map((f) => f.key), [nameOf(crl)]);
      } finally {
        await worker.close();
      }
    });
  }

  test("both fail: nothing is stored", async () => {
    const worker = await startWorker();
    try {
      worker.moica.fail("G2", 500);
      // G3's address has no file: 404.
      assert.equal((await worker.runSchedule()).outcome, "exception");
      assert.deepEqual(worker.moica.requests.map((r) => r.issuer), ["G2", "G3"]);
      assert.deepEqual(await worker.files(), []);
    } finally {
      await worker.close();
    }
  });
});
