// The CRL mirror in the local workerd when things go wrong or get large: a
// file that cannot get its line, files made to take long to read, an answer
// too large to be a CRL, an archive of more files than one listing gives,
// files left over from rounds that broke off, and two writers of the index
// at once. Seen from outside, as in test/mirror.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { der, makeCrl, testIssuerSpki } from "./crls.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { sha256Hex } from "./proofs.ts";

const INDEX = "crl/index.jsonl";
const nameOf = (file: Uint8Array): string => `crl/${sha256Hex(file)}.crl`;
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const indexText = async (worker: TestWorker): Promise<string> => new TextDecoder().decode((await worker.files(INDEX))[0]?.bytes ?? new Uint8Array());
const lineOf = async (worker: TestWorker, file: Uint8Array): Promise<string | undefined> => (await indexText(worker)).split("\n").find((l) => l.includes(`"sha256":"${sha256Hex(file)}"`));
const rootOf = async (worker: TestWorker, file: Uint8Array): Promise<string | undefined> => {
  const line = await lineOf(worker, file);
  return line === undefined ? undefined : (JSON.parse(line) as { root: string }).root;
};
/** The lines the Worker logged for files it read, oldest first. */
const indexedLog = (worker: TestWorker): { result: string; sha256: string; error?: string }[] =>
  worker.logLines().filter((l) => l.includes('"crl_index"')).map((l) => JSON.parse(l) as { result: string; sha256: string; error?: string });
/** The line of a file that is not DER. */
const notDerLine = (file: Uint8Array): string => `{"issuer":"-","crl_number":"-","this_update":"-","next_update":"-","crl_date":"-","sha256":"${sha256Hex(file)}","root":"-not_usable_der"}`;

async function withWorker(options: Parameters<typeof startWorker>[0], run: (worker: TestWorker) => Promise<void>): Promise<void> {
  const worker = await startWorker(options);
  try {
    await run(worker);
  } finally {
    await worker.close();
  }
}

const THURSDAY = new Date("2026-11-19T15:59:59Z");
const FRIDAY = new Date("2026-11-19T16:00:00Z");
const g2 = (number: bigint, serials: bigint[] = []): Uint8Array => makeCrl({ issuer: "G2", number, thisUpdate: THURSDAY, serials });
const g3 = (number: bigint, serials: bigint[] = []): Uint8Array => makeCrl({ issuer: "G3", number, thisUpdate: FRIDAY, serials });
/** A CRL whose tree takes a second or two to build. */
const slowG3 = (number: bigint): Uint8Array => g3(number, Array.from({ length: 20_000 }, (_, i) => (BigInt(i) << 64n) + 0x1_0000n + BigInt(i * 7919)));

describe("a file that cannot get its line", () => {
  test("is that file's trouble alone: the others get their lines, the roster's object hears of them, and the file is tried again", () =>
    withWorker({}, async (worker) => {
      const A = g3(11n, [4n]);
      const B = g3(12n, [4n, 5n]);
      worker.moica.serve("G2", g2(11n));
      worker.moica.serve("G3", A);
      assert.equal((await worker.runSchedule()).outcome, "ok");
      // A file whose bytes are not those its name promises: it never gets a line.
      const wrong = `crl/${"0".repeat(64)}.crl`;
      await worker.putFile(wrong, "not what its name says");
      worker.moica.serve("G3", B);

      for (const round of [2, 3]) {
        // The run still shows as failed, after everything else was done.
        assert.equal((await worker.runSchedule()).outcome, "exception", `round ${round}`);
        assert.match((await rootOf(worker, B)) ?? "", /^[0-9a-f]{64}$/, `round ${round}: the index lists the new CRL`);
        assert.deepEqual((await worker.newestCrls()).G3.map((c) => c.crlNumber), ["12", "11"], `round ${round}: the roster's object knows it`);
        assert.deepEqual((await worker.newestCrls()).G3[0]!.root, await rootOf(worker, B));
      }
      const failed = indexedLog(worker).filter((l) => l.result === "failed");
      assert.deepEqual(failed.map((l) => l.sha256), ["0".repeat(64), "0".repeat(64)], "tried once in each round");
      assert.match(failed[0]!.error!, /SHA-256/);
      assert.ok(!(await indexText(worker)).includes(`"sha256":"${"0".repeat(64)}"`));
    }));
});

describe("the roster's object hears of a CRL as soon as the index lists it", () => {
  test("while the next file's tree is still being built", () =>
    withWorker({}, async (worker) => {
      const quick = g2(21n, [1n]);
      const slow = slowG3(21n);
      worker.moica.serve("G2", quick);
      worker.moica.serve("G3", slow);
      const run = worker.runSchedule();
      let done = false;
      void run.then(() => (done = true));

      let seen: Awaited<ReturnType<TestWorker["newestCrls"]>> | undefined;
      while (!done) {
        const newest = await worker.newestCrls();
        if (newest.G2.length === 1 && newest.G3.length === 0) {
          seen = newest;
          // And what it knows is in the index at that moment.
          assert.equal(await rootOf(worker, quick), newest.G2[0]!.root);
          break;
        }
        await sleep(20);
      }
      assert.ok(seen, "the object knew G2's CRL before G3's was done");
      assert.equal((await run).outcome, "ok");
      assert.deepEqual((await worker.newestCrls()).G3.map((c) => c.root), [await rootOf(worker, slow)]);
    }));
});

describe("two writers of the index at once", () => {
  test("a line written by another round while this one builds a tree is not lost", () =>
    withWorker({}, async (worker) => {
      const quick = g2(31n, [1n]);
      const slow = slowG3(31n);
      worker.moica.serve("G2", quick);
      worker.moica.serve("G3", slow);
      const run = worker.runSchedule();

      // Wait until this round has written G2's line, and is busy with G3's tree.
      let index = "";
      for (const started = Date.now(); !index.includes(sha256Hex(quick)); index = await indexText(worker)) {
        assert.ok(Date.now() - started < 20_000, "G2's line was written");
        await sleep(10);
      }
      assert.ok(!index.includes(sha256Hex(slow)), "G3's tree is still being built");
      // What another round would do meanwhile: store a file and write the index with its line.
      const other = text("stored by another round");
      await worker.putFile(nameOf(other), other);
      await worker.putFile(INDEX, `${notDerLine(other)}\n${index}`);

      assert.equal((await run).outcome, "ok", worker.logLines().join("\n"));
      const lines = (await indexText(worker)).split("\n").slice(0, -1);
      assert.equal(lines.length, 3);
      assert.equal(lines[0], notDerLine(other));
      assert.ok(lines[1]!.includes(sha256Hex(quick)) && lines[2]!.includes(sha256Hex(slow)));
      // And the other round's file was not read a second time.
      assert.ok(!indexedLog(worker).some((l) => l.sha256 === sha256Hex(other)));
    }));
});

describe("files an earlier round left without a line", () => {
  // Two CRLs put into the bucket behind the Worker's back, the one whose name sorts first put first.
  const [first, second] = [g3(41n, [1n]), g3(42n, [2n])].sort((a, b) => (sha256Hex(a) < sha256Hex(b) ? -1 : 1)) as [Uint8Array, Uint8Array];
  const leave = async (worker: TestWorker): Promise<void> => {
    await worker.putFile(nameOf(first), first);
    await sleep(50);
    await worker.putFile(nameOf(second), second);
  };
  const [freshG2, freshG3] = [g2(43n), g3(43n, [3n])];

  test("get theirs after this round's files, the one stored last first", () =>
    withWorker({}, async (worker) => {
      await leave(worker);
      worker.moica.serve("G2", freshG2);
      worker.moica.serve("G3", freshG3);
      assert.equal((await worker.runSchedule()).outcome, "ok");
      assert.deepEqual(indexedLog(worker).map((l) => l.sha256), [freshG2, freshG3, second, first].map(sha256Hex));
    }));

  test("are not started once the round has gone on for longer than its limit; this round's files get theirs all the same", () =>
    withWorker({ crlCatchUpMs: 0 }, async (worker) => {
      await leave(worker);
      worker.moica.serve("G2", freshG2);
      worker.moica.serve("G3", freshG3);
      assert.equal((await worker.runSchedule()).outcome, "ok");
      assert.deepEqual(indexedLog(worker).map((l) => l.sha256), [freshG2, freshG3].map(sha256Hex));
      assert.equal((await indexText(worker)).split("\n").length - 1, 2);
      assert.deepEqual((await worker.newestCrls()).G3.map((c) => c.crlNumber), ["43"]);
    }));
});

describe("an archive of more files than one listing of the bucket gives", () => {
  test("every file is seen: lines stay, and the files without one get theirs", () =>
    withWorker({}, async (worker) => {
      // R2 lists at most 1,000 objects at a time.
      const files = Array.from({ length: 1003 }, (_, i) => text(`not a CRL, number ${i}`)).sort((a, b) => (sha256Hex(a) < sha256Hex(b) ? -1 : 1));
      for (const file of files) await worker.putFile(nameOf(file), file);
      // All have their line but the first and the last by name.
      const without = [files[0]!, files.at(-1)!];
      await worker.putFile(INDEX, files.filter((f) => !without.includes(f)).map((f) => `${notDerLine(f)}\n`).join(""));
      const [a, b] = [g2(51n), g3(51n)];
      worker.moica.serve("G2", a);
      worker.moica.serve("G3", b);

      assert.equal((await worker.runSchedule()).outcome, "ok", worker.logLines().slice(-5).join("\n"));

      const lines = (await indexText(worker)).split("\n").slice(0, -1);
      assert.equal(lines.length, 1005);
      for (const file of files) assert.ok(lines.includes(notDerLine(file)));
      assert.deepEqual(indexedLog(worker).map((l) => l.sha256).sort(), [a, b, ...without].map(sha256Hex).sort());
    }));
});

describe("files made to take long to read", () => {
  // An unsigned file with the structure of a CRL whose cRLNumber is an INTEGER of `bytes` bytes.
  const ALGORITHM = der(0x30, der(0x06, Uint8Array.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])), der(0x05));
  const withNumber = (bytes: number): { file: Uint8Array; number: string } => {
    const content = Buffer.alloc(bytes, 0x9c);
    content[0] = 0x7f;
    const extensions = der(0xa0, der(0x30, der(0x30, der(0x06, Uint8Array.from([0x55, 0x1d, 0x14])), der(0x04, der(0x02, content)))));
    const tbs = der(0x30, der(0x02, Uint8Array.from([1])), ALGORITHM, der(0x30), der(0x17, Buffer.from("261119160000Z")), extensions);
    return { file: new Uint8Array(der(0x30, tbs, ALGORITHM, der(0x03, Uint8Array.from([0]), Buffer.alloc(256, 1)))), number: BigInt(`0x${content.toString("hex")}`).toString() };
  };

  test("a cRLNumber of 400 KB and one of 3 MB: each gets its line in seconds, with the number in decimal, as the Go crl/ writes it", (t) =>
    withWorker({}, async (worker) => {
      const [small, large] = [withNumber(400_000), withNumber(3_000_000)];
      worker.moica.serve("G2", small.file);
      worker.moica.serve("G3", large.file);
      const started = Date.now();
      assert.equal((await worker.runSchedule()).outcome, "ok");
      const took = Date.now() - started;
      assert.ok(took < 20_000, `the round took ${took} ms`);

      for (const { file, number } of [small, large]) {
        assert.equal(await lineOf(worker, file), `{"issuer":"-","crl_number":"${number}","this_update":"2026-11-19T16:00:00Z","next_update":"-","crl_date":"2026-11-20","sha256":"${sha256Hex(file)}","root":"-not_usable_signature"}`);
      }
      if (spawnSync("go", ["version"]).status !== 0) return t.diagnostic("no go: the lines were not compared with the Go crl/'s");
      const dir = mkdtempSync(join(tmpdir(), "crl-large-"));
      try {
        for (const { file } of [small, large]) writeFileSync(join(dir, `${sha256Hex(file)}.crl`), file);
        writeFileSync(join(dir, ".g3.der"), testIssuerSpki("G3"));
        const go = spawnSync("go", ["run", "./cmd/iamreal-crl", "index", "-key-g3", join(dir, ".g3.der"), dir], { cwd: join(WORKER_DIR, ".."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        assert.equal(await indexText(worker), go.stdout);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  test("30,000 extensions, the last of them a second cRLNumber: the line comes in seconds and says so", () =>
    withWorker({}, async (worker) => {
      // 2.5.29.<20000 + i>, each a different extension; then cRLNumber, which makeCrl has already written.
      const many = Array.from({ length: 30_000 }, (_, i) => der(0x30, der(0x06, Uint8Array.from([0x55, 0x1d, 0x80 | ((20_000 + i) >> 14), 0x80 | (((20_000 + i) >> 7) & 0x7f), (20_000 + i) & 0x7f])), der(0x04, der(0x05))));
      const again = der(0x30, der(0x06, Uint8Array.from([0x55, 0x1d, 0x14])), der(0x04, der(0x02, Uint8Array.from([1]))));
      const distinct = makeCrl({ issuer: "G2", number: 61n, thisUpdate: THURSDAY, moreExtensions: many });
      const twice = makeCrl({ issuer: "G3", number: 61n, thisUpdate: FRIDAY, moreExtensions: [...many, again] });
      worker.moica.serve("G2", distinct);
      worker.moica.serve("G3", twice);
      const started = Date.now();
      assert.equal((await worker.runSchedule()).outcome, "ok");
      const took = Date.now() - started;
      assert.ok(took < 10_000, `the round took ${took} ms`);
      assert.equal(await rootOf(worker, distinct), "0".repeat(64));
      assert.equal(await rootOf(worker, twice), "-not_usable_duplicate_extension");
    }));
});

describe("an answer larger than a CRL can be", () => {
  const LIMIT = 32 * 1024 * 1024;
  for (const how of ["with Content-Length", "chunked"] as const) {
    test(`${how}, one byte over the limit: it is not stored, and the other CRL is`, () =>
      withWorker({ crlTimeoutMs: 20_000 }, async (worker) => {
        const other = g3(71n, [7n]);
        worker.moica.serve("G2", new Uint8Array(LIMIT + 1), how);
        worker.moica.serve("G3", other);
        assert.equal((await worker.runSchedule()).outcome, "exception");
        assert.deepEqual((await worker.files("crl/")).map((f) => f.key).sort(), [nameOf(other), INDEX].sort());
        const failed = worker.logLines().filter((l) => l.includes('"crl_mirror"')).map((l) => JSON.parse(l) as { issuer: string; result: string; error?: string }).filter((l) => l.result === "failed");
        assert.deepEqual(failed.map((l) => l.issuer), ["G2"]);
        assert.match(failed[0]!.error!, /33554432/);
      }));
  }

  test("an answer of exactly the limit is stored", () =>
    withWorker({ crlTimeoutMs: 20_000 }, async (worker) => {
      const largest = new Uint8Array(LIMIT);
      worker.moica.serve("G2", largest, "chunked");
      worker.moica.serve("G3", g3(72n));
      assert.equal((await worker.runSchedule()).outcome, "ok");
      assert.ok((await worker.files("crl/")).some((f) => f.key === nameOf(largest)));
      assert.equal(await rootOf(worker, largest), "-not_usable_der");
    }));
});
