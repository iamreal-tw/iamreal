// The whole Worker in the local workerd (test/harness.ts): what it answers
// over HTTP and what its schedule leaves in the simulated R2 bucket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { IssuerName } from "../src/issuers.ts";
import { type TestWorker, startWorker } from "./harness.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

// Not CRLs: the mirror keeps whatever bytes MOICA gives, and the index lists them as not usable
// (test/mirror.test.ts has the CRLs).
const G2_FIRST = bytes("the fake MOICA's G2 CRL, first");
const G3_FIRST = bytes("the fake MOICA's G3 CRL, first");
const G3_SECOND = bytes("the fake MOICA's G3 CRL, second");

const nameOf = (crl: Uint8Array): string => `crl/${sha256(crl)}.crl`;

/** The names of the CRL files in the bucket: everything but the index. */
const stored = async (worker: TestWorker): Promise<string[]> => (await worker.files()).map((f) => f.key).filter((key) => key !== "crl/index.jsonl");

describe("the Worker in the local workerd", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  test("it starts without a Cloudflare account and answers HTTP; it has an API (test/api.test.ts) and no page yet", async () => {
    const res = await fetch(new URL("/", worker.url));
    assert.equal(res.status, 404);
    assert.equal((await worker.fetch("/api/v1/config")).status, 200);
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

    const files = (await worker.files()).filter((f) => f.key !== "crl/index.jsonl");
    assert.deepEqual(files.map((f) => f.key), [nameOf(G2_FIRST), nameOf(G3_FIRST)].sort());
    for (const f of files) assert.equal(f.key, nameOf(f.bytes));
    // A file's name never gets other bytes: it may be cached for a year.
    for (const f of files) assert.equal(f.cacheControl, "public, max-age=31536000, immutable");
  });

  test("a second run with the same CRLs stores nothing again, and leaves the index as it is", async () => {
    const before = await worker.files();
    assert.equal(before.length, 3);
    await new Promise((resolve) => setTimeout(resolve, 20)); // so that a rewritten file would have a later time

    assert.equal((await worker.runSchedule()).outcome, "ok");

    const after = await worker.files();
    assert.deepEqual(after.map((f) => [f.key, f.uploaded.getTime()]), before.map((f) => [f.key, f.uploaded.getTime()]));
  });

  test("a CRL that changed is stored next to the earlier ones", async () => {
    worker.moica.serve("G3", G3_SECOND);

    assert.equal((await worker.runSchedule()).outcome, "ok");

    assert.deepEqual(await stored(worker), [nameOf(G2_FIRST), nameOf(G3_FIRST), nameOf(G3_SECOND)].sort());
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

        assert.deepEqual(worker.moica.requests.map((r) => r.issuer).sort(), ["G2", "G3"]);
        assert.deepEqual(await stored(worker), [nameOf(crl)]);
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
      assert.deepEqual(worker.moica.requests.map((r) => r.issuer).sort(), ["G2", "G3"]);
      assert.deepEqual(await stored(worker), []);
    } finally {
      await worker.close();
    }
  });
});

describe("when MOICA's answer is not a complete one", () => {
  const PART = bytes("x".repeat(100));
  const other = (issuer: IssuerName): IssuerName => (issuer === "G2" ? "G3" : "G2");

  /** One run in which `issuer` goes wrong as `arrange` says and the other key's CRL is there: only that one is stored. */
  async function onlyTheOtherIsStored(issuer: IssuerName, arrange: (worker: TestWorker) => void): Promise<void> {
    const worker = await startWorker({ crlTimeoutMs: 1500 });
    try {
      arrange(worker);
      worker.moica.serve(other(issuer), G3_FIRST);
      const started = Date.now();

      assert.equal((await worker.runSchedule()).outcome, "exception");

      assert.ok(Date.now() - started < 10_000, "the run ends soon after the limit");
      assert.deepEqual(await stored(worker), [nameOf(G3_FIRST)]);
      const failed = worker.logLines().filter((l) => l.includes("crl_mirror")).map((l) => JSON.parse(l) as { issuer: string; result: string }).filter((l) => l.result === "failed");
      assert.deepEqual(failed.map((l) => l.issuer), [issuer]);
    } finally {
      await worker.close();
    }
  }

  for (const issuer of ["G2", "G3"] as const) {
    test(`${issuer} never answers: the other CRL is stored without waiting for it, and ${issuer} fails when the limit has passed`, async () => {
      const worker = await startWorker({ crlTimeoutMs: 3000 });
      try {
        worker.moica.stall(issuer);
        worker.moica.serve(other(issuer), G3_FIRST);
        const started = Date.now();
        const run = worker.runSchedule();

        // The other CRL is there well before the limit.
        let keys: string[] = [];
        while (keys.length === 0 && Date.now() - started < 2000) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          keys = await stored(worker);
        }
        assert.deepEqual(keys, [nameOf(G3_FIRST)]);
        assert.ok(Date.now() - started < 2500, "stored before the limit");

        assert.equal((await run).outcome, "exception");
        assert.ok(Date.now() - started < 12_000, "the run ends soon after the limit");
        assert.deepEqual(await stored(worker), [nameOf(G3_FIRST)]);
      } finally {
        await worker.close();
      }
    });
  }

  test("an answer that stops in the middle and stays open fails when the limit has passed", () => onlyTheOtherIsStored("G2", (w) => w.moica.stall("G2", PART)));

  test("an answer cut off before its Content-Length is not stored", () => onlyTheOtherIsStored("G2", (w) => w.moica.cutOff("G2", PART, 1000)));

  test("an answer of 200 with no bytes is not stored", () => onlyTheOtherIsStored("G3", (w) => w.moica.serve("G3", new Uint8Array(0))));

  test("a chunked answer cut off before its end looks complete to the Worker, and what arrived is stored", async () => {
    // Not what one would want, but what happens: the local workerd reports no error for a chunked body
    // whose connection closes before the last chunk, so nothing at the level of HTTP tells it from a
    // complete answer (src/mirror.ts). Such a file is not a CRL MOICA signed, and the index lists it as
    // not usable. If this test fails, the runtime started reporting the error: say so in src/mirror.ts
    // and README.md.
    const worker = await startWorker();
    try {
      worker.moica.cutOff("G2", PART, "chunked");
      worker.moica.serve("G3", G3_FIRST);

      assert.equal((await worker.runSchedule()).outcome, "ok");

      assert.deepEqual(await stored(worker), [nameOf(PART), nameOf(G3_FIRST)].sort());
      assert.match(new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]!.bytes), new RegExp(`"sha256":"${sha256(PART)}","root":"-not_usable_der"`));
    } finally {
      await worker.close();
    }
  });

  test("a complete answer of 200 that is no CRL is stored all the same", async () => {
    // Usable or not, every file is kept; the index tells them apart (test/mirror.test.ts).
    const worker = await startWorker();
    try {
      const html = bytes("<!doctype html><title>Service unavailable</title>");
      worker.moica.serve("G2", html);
      worker.moica.serve("G3", G3_FIRST);

      assert.equal((await worker.runSchedule()).outcome, "ok");

      assert.deepEqual(await stored(worker), [nameOf(html), nameOf(G3_FIRST)].sort());
    } finally {
      await worker.close();
    }
  });
});
