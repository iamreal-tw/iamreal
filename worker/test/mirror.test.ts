// The CRL mirror in the local workerd (test/harness.ts), seen from outside:
// the index and the files its rounds leave in the simulated R2 bucket, and
// what the proof log's Durable Object then knows of the archive. The CRLs are
// signed by the test's issuer keys (test/crls.ts).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { KnownCrl } from "../src/crl-index.ts";
import { makeCrl } from "./crls.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { sha256Hex } from "./proofs.ts";

interface Line {
  readonly issuer: string;
  readonly crl_number: string;
  readonly this_update: string;
  readonly next_update: string;
  readonly crl_date: string;
  readonly sha256: string;
  readonly root: string;
}

const INDEX = "crl/index.jsonl";
const nameOf = (crl: Uint8Array): string => `crl/${sha256Hex(crl)}.crl`;

/** The index in the bucket: its bytes as text, its lines, and when it was written. */
async function indexOf(worker: TestWorker): Promise<{ text: string; lines: Line[]; uploaded: number; cacheControl: string | undefined }> {
  const [file] = await worker.files(INDEX);
  assert.ok(file, "the bucket has crl/index.jsonl");
  const text = new TextDecoder().decode(file.bytes);
  assert.ok(text === "" || text.endsWith("\n"), "the index ends in LF");
  return { text, lines: text.split("\n").slice(0, -1).map((l) => JSON.parse(l) as Line), uploaded: file.uploaded.getTime(), cacheControl: file.cacheControl };
}

const lineOf = (lines: readonly Line[], crl: Uint8Array): Line | undefined => lines.find((l) => l.sha256 === sha256Hex(crl));
const indexed = (worker: TestWorker): string[] => worker.logLines().filter((l) => l.includes('"crl_index"'));

/** One round; it must end well. */
async function round(worker: TestWorker): Promise<void> {
  assert.equal((await worker.runSchedule()).outcome, "ok", worker.logLines().join("\n"));
}

// 2026-11-19 16:00 UTC is 2026-11-20 in Taiwan.
const THURSDAY = new Date("2026-11-19T15:59:59Z");
const FRIDAY = new Date("2026-11-19T16:00:00Z");
const ROOT_OF_5 = "12b47395d98620576c5a8c714a9407c9b2d3a7ff91661f67ffb79c2b03b7ea32"; // spec/vectors/poseidon2.json, revocation_tree: the tree of the one serial 0x5

describe("a round of the mirror writes the archive and its index", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  const G2_A = makeCrl({ issuer: "G2", number: 2026111901n, thisUpdate: THURSDAY });
  const G3_A = makeCrl({ issuer: "G3", number: 2026111901n, thisUpdate: THURSDAY, serials: [5n] });
  const G3_B = makeCrl({ issuer: "G3", number: 2026112001n, thisUpdate: FRIDAY, serials: [5n, 6n] });
  const HTML = new TextEncoder().encode("<!doctype html><title>Service unavailable</title>");

  test("each CRL is stored and gets one line: who signed it, its number, its times, its date in Taiwan, its SHA-256 and its root", async () => {
    worker.moica.serve("G2", G2_A);
    worker.moica.serve("G3", G3_A);
    await round(worker);

    const { text, lines } = await indexOf(worker);
    assert.equal(
      text,
      `{"issuer":"G2","crl_number":"2026111901","this_update":"2026-11-19T15:59:59Z","next_update":"2026-11-21T03:59:59Z","crl_date":"2026-11-19","sha256":"${sha256Hex(G2_A)}","root":"${"0".repeat(64)}"}\n` +
        `{"issuer":"G3","crl_number":"2026111901","this_update":"2026-11-19T15:59:59Z","next_update":"2026-11-21T03:59:59Z","crl_date":"2026-11-19","sha256":"${sha256Hex(G3_A)}","root":"${ROOT_OF_5}"}\n`,
    );
    assert.equal(lines.length, 2);
    assert.deepEqual((await worker.files("crl/")).map((f) => f.key), [nameOf(G2_A), nameOf(G3_A), INDEX].sort());
  });

  test("every object says how long it may be cached: a CRL file a year, the index a minute", async () => {
    for (const f of await worker.files("crl/")) assert.equal(f.cacheControl, f.key === INDEX ? "public, max-age=60" : "public, max-age=31536000, immutable", f.key);
    assert.equal((await worker.files("crl/")).length, 3);
  });

  test("the same CRLs again: nothing is stored again, no tree is built, and the index is not written again", async () => {
    const before = await worker.files("crl/");
    const builtBefore = indexed(worker).length;
    assert.equal(builtBefore, 2);
    await new Promise((resolve) => setTimeout(resolve, 20)); // so that a rewritten object would have a later time

    await round(worker);

    assert.deepEqual((await worker.files("crl/")).map((f) => [f.key, f.uploaded.getTime()]), before.map((f) => [f.key, f.uploaded.getTime()]));
    assert.equal(indexed(worker).length, builtBefore);
  });

  test("a new CRL: the index gains its line, in the order of the spec, and the earlier lines stay", async () => {
    const before = await indexOf(worker);
    worker.moica.serve("G3", G3_B);
    await round(worker);

    const { text, lines } = await indexOf(worker);
    assert.deepEqual(lines.map((l) => [l.issuer, l.crl_number]), [["G2", "2026111901"], ["G3", "2026111901"], ["G3", "2026112001"]]);
    assert.ok(text.startsWith(before.text));
    assert.equal(lineOf(lines, G3_B)?.crl_date, "2026-11-20");
    assert.match(lineOf(lines, G3_B)!.root, /^[0-9a-f]{64}$/);
    assert.notEqual(lineOf(lines, G3_B)!.root, ROOT_OF_5);
  });

  test("a file that is not a CRL is stored too, and listed as not usable", async () => {
    worker.moica.serve("G2", HTML);
    await round(worker);

    const { lines } = await indexOf(worker);
    assert.deepEqual(lineOf(lines, HTML), { issuer: "-", crl_number: "-", this_update: "-", next_update: "-", crl_date: "-", sha256: sha256Hex(HTML), root: "-not_usable_der" });
    // `-` sorts before G2 and G3.
    assert.equal(lines[0]!.sha256, sha256Hex(HTML));
    assert.equal(lines.length, 4);
    assert.ok((await worker.files("crl/")).some((f) => f.key === nameOf(HTML)));
  });

  test("a CRL signed by a key that is not an issuer key, and one whose bytes were changed, are not usable", async () => {
    // The G2 test key's CRL with one byte of a serial number changed: the signature no longer verifies.
    const changed = makeCrl({ issuer: "G2", number: 3n, thisUpdate: FRIDAY, serials: [0x1234n] });
    const at = changed.findIndex((b, i) => b === 0x12 && changed[i + 1] === 0x34);
    changed[at] = 0x13;
    worker.moica.serve("G2", changed);
    await round(worker);

    const line = lineOf((await indexOf(worker)).lines, changed);
    assert.deepEqual([line?.issuer, line?.crl_number, line?.root], ["-", "3", "-not_usable_signature"]);
  });
});

describe("a round that broke off is made good by the next", () => {
  const G2_A = makeCrl({ issuer: "G2", number: 11n, thisUpdate: THURSDAY, serials: [1n, 2n, 3n] });
  const G3_A = makeCrl({ issuer: "G3", number: 11n, thisUpdate: THURSDAY, serials: [4n] });
  const G3_B = makeCrl({ issuer: "G3", number: 12n, thisUpdate: FRIDAY, serials: [4n, 5n] });

  let worker: TestWorker;
  let whole: string;
  before(async () => {
    worker = await startWorker();
    worker.moica.serve("G2", G2_A);
    worker.moica.serve("G3", G3_A);
    await round(worker);
    worker.moica.serve("G3", G3_B);
    await round(worker);
    whole = (await indexOf(worker)).text;
    assert.equal(whole.split("\n").length - 1, 3);
  });
  after(() => worker.close());

  test("a file stored without its line (the round ended before the index was written) gets its line, even when MOICA no longer serves it", async () => {
    // As the bucket was after G3_B was stored and before its line was written; and MOICA has moved on to a CRL the archive has.
    await worker.putFile(INDEX, whole.split("\n").filter((l) => !l.includes(sha256Hex(G3_B))).join("\n"));
    worker.moica.serve("G3", G3_A);
    await round(worker);
    assert.equal((await indexOf(worker)).text, whole);
  });

  test("no index at all: it is built again from the files", async () => {
    await worker.deleteFile(INDEX);
    await round(worker);
    const index = await indexOf(worker);
    assert.equal(index.text, whole);
    assert.equal(index.cacheControl, "public, max-age=60");
  });

  for (const [what, broken] of [
    ["cut off in the middle of a line", (index: string) => index.slice(0, index.indexOf("\n") + 60)],
    ["with a line that is not as the spec writes it", (index: string) => index.replace('"root":"', '"root": "')],
    ["with a line twice", (index: string) => index + index.slice(0, index.indexOf("\n") + 1)],
    ["with a line of a file the archive does not have", (index: string) => `{"issuer":"-","crl_number":"-","this_update":"-","next_update":"-","crl_date":"-","sha256":"${"0".repeat(64)}","root":"-not_usable_der"}\n${index}`],
    ["that is not text", () => "\u0000�\u0001"],
  ] as const) {
    test(`an index ${what} is replaced by a whole one`, async () => {
      const bad = broken(whole);
      assert.notEqual(bad, whole);
      await worker.putFile(INDEX, bad);
      await round(worker);
      assert.equal((await indexOf(worker)).text, whole);
    });
  }

  test("the proof log's object is told again in every round, so one that missed a round catches up", async () => {
    assert.deepEqual((await worker.newestCrls()).G3.map((c) => c.crlNumber), ["12", "11"]);
  });
});

describe("the proof log's Durable Object keeps the two newest usable CRLs of each issuer key", () => {
  let worker: TestWorker;
  before(async () => {
    worker = await startWorker();
  });
  after(() => worker.close());

  const g3 = (number: bigint, thisUpdate: Date, serials: bigint[]): Uint8Array => makeCrl({ issuer: "G3", number, thisUpdate, serials });
  const G3_5 = g3(5n, new Date("2026-11-17T16:00:00Z"), [5n]);
  const G3_7 = g3(7n, new Date("2026-11-19T16:00:00Z"), [5n, 7n]);
  const G3_6 = g3(6n, new Date("2026-11-18T16:00:00Z"), [5n, 6n]);
  // Two different serial numbers with the same lowest 127 bits: signed by G3, and not usable.
  const G3_99 = g3(99n, new Date("2026-11-20T16:00:00Z"), [5n, (1n << 130n) + 5n]);
  const G2_3 = makeCrl({ issuer: "G2", number: 3n, thisUpdate: new Date("2026-11-19T16:00:00Z") });

  const rootOf = async (crl: Uint8Array): Promise<string> => lineOf((await indexOf(worker)).lines, crl)!.root;

  test("before any round it knows of none", async () => {
    assert.deepEqual(await worker.newestCrls(), { G2: [], G3: [] });
  });

  test("after a round: each key's CRL, with its root, number and date", async () => {
    worker.moica.serve("G2", G2_3);
    worker.moica.serve("G3", G3_5);
    await round(worker);
    assert.deepEqual(await worker.newestCrls(), {
      G2: [{ root: "0".repeat(64), crlNumber: "3", crlDate: "2026-11-20" }],
      G3: [{ root: ROOT_OF_5, crlNumber: "5", crlDate: "2026-11-18" }],
    });
  });

  test("the newest two by CRL number, the newest first, whatever order they arrived in; a CRL that is not usable does not count", async () => {
    for (const crl of [G3_7, G3_6, G3_99]) {
      worker.moica.serve("G3", crl);
      await round(worker);
    }
    assert.equal(await rootOf(G3_99), "-not_usable_collision");
    const expected: KnownCrl[] = [
      { root: await rootOf(G3_7), crlNumber: "7", crlDate: "2026-11-20" },
      { root: await rootOf(G3_6), crlNumber: "6", crlDate: "2026-11-19" },
    ];
    assert.deepEqual((await worker.newestCrls()).G3, expected);
    assert.equal(new Set([ROOT_OF_5, ...expected.map((c) => c.root)]).size, 3);
  });

  test("it still knows them after it was stopped and started again", async () => {
    const before = await worker.newestCrls();
    assert.equal(before.G3.length, 2);
    const atOf = (): string => (JSON.parse(worker.logLines().findLast((l) => l.includes('"crl_mirror"'))!) as { at: string }).at;
    await worker.setClock(new Date("2001-01-01T00:00:00Z"));
    await round(worker);
    assert.equal(atOf(), "2001-01-01T00:00:00.000Z");

    await worker.restart();

    assert.deepEqual(await worker.newestCrls(), before);
    // It did start again: the clock the test set was in the Worker's memory, and is gone.
    await round(worker);
    assert.notEqual(atOf(), "2001-01-01T00:00:00.000Z");
  });

  test("a round in which MOICA fails leaves what it knows", async () => {
    const before = await worker.newestCrls();
    worker.moica.fail("G2", 503);
    worker.moica.fail("G3", 503);
    assert.equal((await worker.runSchedule()).outcome, "exception");
    assert.deepEqual(await worker.newestCrls(), before);
  });
});
