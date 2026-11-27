// The CRL mirror asks MOICA with a condition (issue #266; spec/revocation-tree.md, "Who checks what"): what MOICA said of
// the answer a file came in is kept with the file, and the next request is conditional on it. Against the fake MOICA of
// the local workerd (test/harness.ts), which answers 304 as a server does; no request leaves this computer.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { makeCrl } from "./crls.ts";
import { type MoicaRequest, type TestWorker, startWorker } from "./harness.ts";
import { sha256Hex } from "./proofs.ts";

const INDEX = "crl/index.jsonl";
const nameOf = (crl: Uint8Array): string => `crl/${sha256Hex(crl)}.crl`;
const THURSDAY = new Date("2026-11-19T15:59:59Z");
const FRIDAY = new Date("2026-11-19T16:00:00Z");

/** One round; it must end well. Returns the requests it made of MOICA and the lines it logged for its sources and files. */
async function round(worker: TestWorker): Promise<{ requests: MoicaRequest[]; sources: Record<string, { result: string; sha256?: string; error?: string }>; indexed: number }> {
  const requestsBefore = worker.moica.requests.length;
  const logBefore = worker.logLines().length;
  const outcome = (await worker.runSchedule()).outcome;
  const log = worker.logLines().slice(logBefore);
  const sources: Record<string, { result: string; sha256?: string; error?: string }> = {};
  for (const line of log.filter((l) => l.includes('"crl_mirror"'))) {
    const said = JSON.parse(line) as { issuer: string; result: string; sha256?: string; error?: string };
    sources[said.issuer] = said;
  }
  assert.equal(outcome, Object.values(sources).some((s) => s.result === "failed") ? "exception" : "ok", log.join("\n"));
  return { requests: worker.moica.requests.slice(requestsBefore), sources, indexed: log.filter((l) => l.includes('"crl_index"')).length };
}

/** The conditions a request carried. */
const conditionsOf = (requests: readonly MoicaRequest[], issuer: string): Record<string, unknown> => {
  const request = requests.find((r) => r.issuer === issuer);
  assert.ok(request, `MOICA was asked for ${issuer}`);
  return Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith("if-")));
};

/** Every file of the bucket and when it was written. */
const written = async (worker: TestWorker): Promise<[string, number][]> => (await worker.files("crl/")).map((f) => [f.key, f.uploaded.getTime()]);

describe("the mirror asks MOICA with a condition", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  const G2_A = makeCrl({ issuer: "G2", number: 2026111901n, thisUpdate: THURSDAY });
  const G2_B = makeCrl({ issuer: "G2", number: 2026112001n, thisUpdate: FRIDAY, serials: [7n] });
  const G3_A = makeCrl({ issuer: "G3", number: 2026111901n, thisUpdate: THURSDAY, serials: [5n] });
  const G3_B = makeCrl({ issuer: "G3", number: 2026112001n, thisUpdate: FRIDAY, serials: [5n, 6n] });
  // G2 says both of its answer, G3 only when it was last changed.
  const G2_A_SAID = { etag: '"100cdf3-6612bc6704b40"', lastModified: "Thu, 19 Nov 2026 15:59:59 GMT" };
  const G2_B_SAID = { etag: '"100d000-6612bc6704b41"', lastModified: "Thu, 19 Nov 2026 16:00:00 GMT" };
  const G3_A_SAID = { lastModified: "Thu, 19 Nov 2026 15:59:59 GMT" };
  const G3_B_SAID = { lastModified: "Thu, 19 Nov 2026 16:00:00 GMT" };

  test("the first round has nothing to be conditional on: both files are downloaded and stored", async () => {
    worker.moica.serve("G2", G2_A, "with Content-Length", G2_A_SAID);
    worker.moica.serve("G3", G3_A, "with Content-Length", G3_A_SAID);
    const { requests, sources, indexed } = await round(worker);

    assert.deepEqual(conditionsOf(requests, "G2"), {});
    assert.deepEqual(conditionsOf(requests, "G3"), {});
    assert.deepEqual([sources.G2?.result, sources.G3?.result], ["stored", "stored"]);
    assert.equal(indexed, 2);
    assert.deepEqual((await worker.files("crl/")).map((f) => f.key), [nameOf(G2_A), nameOf(G3_A), INDEX].sort());
  });

  test("the second round is conditional on what MOICA said: 304, nothing is downloaded, stored or built, and the round says which file it still has", async () => {
    const before = await written(worker);
    await new Promise((resolve) => setTimeout(resolve, 20)); // so that a rewritten object would have a later time
    const { requests, sources, indexed } = await round(worker);

    // The ETag where there is one, and then not the date too; the date where there is no ETag.
    assert.deepEqual(conditionsOf(requests, "G2"), { "if-none-match": G2_A_SAID.etag });
    assert.deepEqual(conditionsOf(requests, "G3"), { "if-modified-since": G3_A_SAID.lastModified });
    assert.deepEqual(sources.G2, { event: "crl_mirror", at: (sources.G2 as { at?: string }).at, issuer: "G2", result: "not_modified", sha256: sha256Hex(G2_A) });
    assert.deepEqual([sources.G3?.result, sources.G3?.sha256], ["not_modified", sha256Hex(G3_A)]);
    assert.equal(indexed, 0);
    assert.deepEqual(await written(worker), before);
    assert.deepEqual((await worker.newestCrls()).G2?.map((c) => c.crlNumber), ["2026111901"]);
  });

  test("MOICA has a new file: the condition is of the old one, the new one is downloaded whole and gets its line", async () => {
    worker.moica.serve("G2", G2_B, "with Content-Length", G2_B_SAID);
    worker.moica.serve("G3", G3_B, "with Content-Length", G3_B_SAID);
    const { requests, sources, indexed } = await round(worker);

    assert.deepEqual(conditionsOf(requests, "G2"), { "if-none-match": G2_A_SAID.etag });
    assert.deepEqual(conditionsOf(requests, "G3"), { "if-modified-since": G3_A_SAID.lastModified });
    assert.deepEqual([sources.G2, sources.G3].map((s) => [s?.result, s?.sha256]), [["stored", sha256Hex(G2_B)], ["stored", sha256Hex(G3_B)]]);
    assert.equal(indexed, 2);
    // The archive's files and its index; the patches of the two pairs are in test/mirror-patches.test.ts.
    assert.deepEqual((await worker.files("crl/")).map((f) => f.key).filter((key) => !key.startsWith("crl/patches/")), [nameOf(G2_A), nameOf(G2_B), nameOf(G3_A), nameOf(G3_B), INDEX].sort());
  });

  test("the next round is conditional on the new file", async () => {
    const { requests, sources } = await round(worker);
    assert.deepEqual(conditionsOf(requests, "G2"), { "if-none-match": G2_B_SAID.etag });
    assert.deepEqual(conditionsOf(requests, "G3"), { "if-modified-since": G3_B_SAID.lastModified });
    assert.deepEqual([sources.G2, sources.G3].map((s) => [s?.result, s?.sha256]), [["not_modified", sha256Hex(G2_B)], ["not_modified", sha256Hex(G3_B)]]);
  });

  test("the same bytes under other headers: downloaded whole once, found to be stored already, and from then on the condition is the new header", async () => {
    worker.moica.serve("G2", G2_B, "with Content-Length", { etag: '"another"' });
    const first = await round(worker);
    assert.deepEqual(conditionsOf(first.requests, "G2"), { "if-none-match": G2_B_SAID.etag });
    assert.deepEqual([first.sources.G2?.result, first.sources.G2?.sha256], ["already_stored", sha256Hex(G2_B)]);
    assert.equal(first.indexed, 0);

    const index = (await worker.files(INDEX))[0]!.uploaded.getTime();
    const second = await round(worker);
    assert.deepEqual(conditionsOf(second.requests, "G2"), { "if-none-match": '"another"' });
    assert.deepEqual([second.sources.G2?.result, second.sources.G2?.sha256], ["not_modified", sha256Hex(G2_B)]);
    assert.equal(second.indexed, 0);
    assert.equal((await worker.files(INDEX))[0]!.uploaded.getTime(), index, "the index is not written again");
  });

  test("the file the condition was of is gone from the bucket: the condition is of the file before it, which MOICA no longer has, so the new one is downloaded again", async () => {
    await worker.deleteFile(nameOf(G2_B));
    const { requests, sources } = await round(worker);
    assert.deepEqual(conditionsOf(requests, "G2"), { "if-none-match": G2_A_SAID.etag });
    assert.deepEqual([sources.G2?.result, sources.G2?.sha256], ["stored", sha256Hex(G2_B)]);
    assert.ok((await worker.files("crl/")).some((f) => f.key === nameOf(G2_B)));
  });

  test("no file of an address is left: asked without a condition", async () => {
    await worker.deleteFile(nameOf(G3_A));
    await worker.deleteFile(nameOf(G3_B));
    const { requests, sources } = await round(worker);
    assert.deepEqual(conditionsOf(requests, "G3"), {});
    assert.deepEqual([sources.G3?.result, sources.G3?.sha256], ["stored", sha256Hex(G3_B)]);
  });
});

describe("what the mirror does not make a condition of", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  const G2_A = makeCrl({ issuer: "G2", number: 2026111901n, thisUpdate: THURSDAY });
  const G3_A = makeCrl({ issuer: "G3", number: 2026111901n, thisUpdate: THURSDAY, serials: [5n] });

  test("an answer without ETag and Last-Modified: every round downloads the whole file, as before", async () => {
    worker.moica.serve("G2", G2_A);
    worker.moica.serve("G3", G3_A);
    await round(worker);
    const { requests, sources } = await round(worker);
    assert.deepEqual(conditionsOf(requests, "G2"), {});
    assert.deepEqual(conditionsOf(requests, "G3"), {});
    assert.deepEqual([sources.G2?.result, sources.G3?.result], ["already_stored", "already_stored"]);
  });

  test("an answer that does not say how long it is: stored, and its headers are not kept", async () => {
    const chunked = makeCrl({ issuer: "G3", number: 2026112001n, thisUpdate: FRIDAY, serials: [5n, 6n] });
    worker.moica.serve("G3", chunked, "chunked", { etag: '"chunked"', lastModified: "Thu, 19 Nov 2026 16:00:00 GMT" });
    assert.equal((await round(worker)).sources.G3?.result, "stored");
    const { requests, sources } = await round(worker);
    assert.deepEqual(conditionsOf(requests, "G3"), {});
    assert.equal(sources.G3?.result, "already_stored");
  });

  test("a header that is not printable ASCII, or very long: as if MOICA had sent none", async () => {
    const next = makeCrl({ issuer: "G2", number: 2026112001n, thisUpdate: FRIDAY, serials: [7n] });
    worker.moica.serve("G2", next, "with Content-Length", { etag: `"${"x".repeat(300)}"` });
    assert.equal((await round(worker)).sources.G2?.result, "stored");
    assert.deepEqual(conditionsOf((await round(worker)).requests, "G2"), {});
  });

  test("304 to a request without a condition is a failure: nothing is stored, and the round says so", async () => {
    worker.moica.fail("G2", 304);
    const before = await written(worker);
    const { requests, sources } = await round(worker);
    assert.deepEqual(conditionsOf(requests, "G2"), {});
    assert.deepEqual([sources.G2?.result, sources.G2?.error], ["failed", "HTTP status 304"]);
    assert.deepEqual(await written(worker), before);
  });

  test("a file the archive had before, without what MOICA said of it: one more whole download, which keeps what MOICA says; then a condition", async () => {
    // G3_A is stored from the answer above, which said nothing: as a file stored before the mirror kept these headers.
    worker.moica.serve("G3", G3_A);
    await round(worker);
    worker.moica.serve("G3", G3_A, "with Content-Length", { etag: '"a"' });
    const { requests, sources } = await round(worker);
    assert.deepEqual(conditionsOf(requests, "G3"), {});
    assert.equal(sources.G3?.result, "already_stored");
    const next = await round(worker);
    assert.deepEqual(conditionsOf(next.requests, "G3"), { "if-none-match": '"a"' });
    assert.equal(next.sources.G3?.result, "not_modified");
    // The file still says how long it may be cached.
    for (const f of await worker.files("crl/")) assert.ok(f.cacheControl, f.key);
  });

  test("an answer that is not a CRL MOICA signed, sent with MOICA's own ETag: stored, listed as not usable, and no condition is made of it", async () => {
    const real = makeCrl({ issuer: "G3", number: 2026112101n, thisUpdate: FRIDAY, serials: [9n] });
    const said = { etag: '"real"' };
    // Somebody on the way answers once in MOICA's place: other bytes of the right length, under the real file's ETag.
    worker.moica.serve("G3", new TextEncoder().encode("not a CRL at all"), "with Content-Length", said);
    assert.equal((await round(worker)).sources.G3?.result, "stored");
    // MOICA itself again: it would answer 304 to that ETag, so the mirror must not ask with it.
    worker.moica.serve("G3", real, "with Content-Length", said);
    const { requests, sources } = await round(worker);
    assert.notDeepEqual(conditionsOf(requests, "G3"), { "if-none-match": said.etag });
    assert.deepEqual([sources.G3?.result, sources.G3?.sha256], ["stored", sha256Hex(real)]);
    assert.equal((await round(worker)).sources.G3?.result, "not_modified");
  });
});
