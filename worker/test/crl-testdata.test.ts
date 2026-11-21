// The CRL mirror against the Go crl/, case by case: every synthetic CRL of
// crl/testdata/ goes through the whole Worker in the local workerd, as the
// fake MOICA's answer, and the index the mirror leaves in the bucket must
// say of each what crl/testdata/expected.json says: usable or not, the
// reason code, the root. Then the Go `iamreal-crl index` rebuilds the index
// from the files the mirror stored, and the two must be the same bytes.
//
// The CRLs of crl/testdata/times/ go the same way: times spelled in many
// ways, each with its line of the index (spec/revocation-tree.md, "Times":
// only the spellings of RFC 5280 are read). The Go crl/, web/ and
// device-core/ read the same file.
//
// The test build's G2 key is here the key that signed crl/testdata/ (only
// its public half exists); its G3 key is the test's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, test } from "node:test";
import { WORKER_DIR } from "./build.ts";
import { CRL_TESTDATA, makeCrl, testIssuerSpki, testIssuers, testdataIssuer } from "./crls.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { sha256Hex } from "./proofs.ts";

interface ExpectedCase {
  readonly name: string;
  readonly usable: boolean;
  readonly reason?: string;
  readonly crl_number: string;
  readonly this_update: string;
  readonly next_update: string;
  readonly crl_date: string;
  readonly sha256: string;
  readonly root?: string;
}

const cases = JSON.parse(readFileSync(join(CRL_TESTDATA, "expected.json"), "utf8")) as ExpectedCase[];
const fileOf = (c: ExpectedCase): Uint8Array => new Uint8Array(readFileSync(join(CRL_TESTDATA, `${c.name}.crl`)));

// Files that are not CRLs at all, and one the test's G3 key signed: the archive keeps them too.
const NOT_DER = [new TextEncoder().encode("<!doctype html><title>Service unavailable</title>"), Uint8Array.from([0x30, 0x03, 0x02, 0x01]), new Uint8Array(1)];
const G3_CRL = makeCrl({ issuer: "G3", number: 7n, thisUpdate: new Date("2026-11-19T16:00:00Z"), serials: [0x1234n, 0x5678n] });

/** crl/testdata/times/: CRLs whose times are spelled in many ways, with the line of the index of each. */
interface TimeCase {
  readonly name: string;
  readonly sha256: string;
  readonly line: string;
}
const timeCases = JSON.parse(readFileSync(join(CRL_TESTDATA, "times", "expected.json"), "utf8")) as TimeCase[];
const TIMED = timeCases.map((c) => new Uint8Array(readFileSync(join(CRL_TESTDATA, "times", `${c.name}.crl`))));
const OTHERS = [...NOT_DER, G3_CRL, ...TIMED];

let worker: TestWorker;
let index: string;
before(async () => {
  worker = await startWorker({ issuers: [testdataIssuer(), testIssuers()[1]!] });
  const files = [...cases.map(fileOf), ...OTHERS];
  // Two files a round, one at each of the fake MOICA's addresses.
  for (let i = 0; i < files.length; i += 2) {
    worker.moica.serve("G2", files[i]!);
    worker.moica.serve("G3", files[i + 1] ?? files[i]!);
    assert.equal((await worker.runSchedule()).outcome, "ok", worker.logLines().join("\n"));
  }
  index = new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]!.bytes);
});
after(() => worker.close());

test("every case of crl/testdata/expected.json: usable or not, the reason code and the root are the Go crl/'s", () => {
  assert.ok(cases.length >= 37, `${cases.length} cases`);
  const lines = new Map(index.split("\n").filter(Boolean).map((l) => [(JSON.parse(l) as { sha256: string }).sha256, JSON.parse(l) as Record<string, string>]));
  for (const c of cases) {
    assert.equal(sha256Hex(fileOf(c)), c.sha256, `${c.name}: the file is the one expected.json describes`);
    const line = lines.get(c.sha256);
    assert.ok(line, `${c.name}: the index has its line`);
    assert.equal(line.root, c.usable ? c.root : `-${c.reason}`, c.name);
    assert.equal(line.crl_number, c.crl_number || "-", c.name);
    assert.equal(line.this_update, c.this_update, c.name);
    assert.equal(line.next_update, c.next_update || "-", c.name);
    assert.equal(line.crl_date, c.crl_date, c.name);
  }
  // Every reason code but the first is among the cases; the first is the files that are not DER.
  const reasons = new Set(cases.flatMap((c) => (c.reason === undefined ? [] : [c.reason])));
  assert.equal(reasons.size, 9, [...reasons].join(" "));
  for (const bytes of NOT_DER) assert.equal(lines.get(sha256Hex(bytes))?.root, "-not_usable_der");
  assert.equal(lines.size, cases.length + OTHERS.length);
});

test("every case of crl/testdata/times/expected.json: the line of the index is the one expected.json gives", () => {
  assert.ok(timeCases.length >= 48, `${timeCases.length} cases`);
  const lines = new Set(index.split("\n"));
  for (const [i, c] of timeCases.entries()) {
    assert.equal(sha256Hex(TIMED[i]!), c.sha256, `${c.name}: the file is the one expected.json describes`);
    assert.ok(lines.has(c.line), `${c.name}: the index has no line ${c.line}; it has ${index.split("\n").find((l) => l.includes(c.sha256))}`);
  }
  // Both kinds are among them, and the times at the edges.
  const refused = timeCases.filter((c) => c.line.includes("-not_usable_der")).length;
  assert.ok(refused >= 10 && timeCases.length - refused >= 10, `${refused} of ${timeCases.length} refused`);
  for (const edge of ['"this_update":"1950-01-01T00:00:00Z"', '"this_update":"0000-02-29T00:00:00Z"', '"crl_date":"10000-01-01"', '"next_update":"0001-01-01T00:00:00Z"']) assert.ok(timeCases.some((c) => c.line.includes(edge)), edge);
});

test("the index the Go crl/ rebuilds from the files in the bucket is the same bytes", async (t) => {
  if (spawnSync("go", ["version"]).status !== 0) return t.skip("needs go");
  const dir = mkdtempSync(join(tmpdir(), "crl-archive-"));
  try {
    const crls = (await worker.files("crl/")).filter((f) => f.key.endsWith(".crl"));
    assert.equal(crls.length, cases.length + OTHERS.length);
    for (const f of crls) writeFileSync(join(dir, basename(f.key)), f.bytes);
    const g3 = join(dir, ".g3.der"); // a name starting with "." is not a file of the archive
    writeFileSync(g3, testIssuerSpki("G3"));
    const go = spawnSync("go", ["run", "./cmd/iamreal-crl", "index", "-key-g2", join(CRL_TESTDATA, "issuer-public-key.der"), "-key-g3", g3, dir], { cwd: join(WORKER_DIR, ".."), encoding: "utf8" });
    // It ends with 1 when the archive holds files that are not usable, and prints the index all the same.
    assert.ok(go.status === 0 || go.status === 1, go.stderr);
    assert.equal(index, go.stdout);
    assert.equal(index.split("\n").length - 1, crls.length);

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
