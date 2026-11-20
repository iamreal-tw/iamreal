// The CRL mirror against the Go crl/, case by case: every synthetic CRL of
// crl/testdata/ goes through the whole Worker in the local workerd, as the
// fake MOICA's answer, and the index the mirror leaves in the bucket must
// say of each what crl/testdata/expected.json says: usable or not, the
// reason code, the root. Then the Go `iamreal-crl index` rebuilds the index
// from the files the mirror stored, and the two must be the same bytes.
//
// The Go crl/ reads times a little more widely than DER allows (UTCTime
// without seconds, offsets), and so must the mirror: a list of CRLs with
// such times, signed by the test's G3 key, goes the same way, and here the
// Go index is the only answer.
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

/** `thisUpdate` written in ways MOICA does not write it; what each gives is for the Go crl/ to say. */
const TIMES: readonly ({ utc: string } | { generalized: string })[] = [
  { utc: "2611191600Z" }, // without seconds
  { utc: "261119160000+0800" },
  { utc: "2611191600-0330" },
  { utc: "261119160000+0000" }, // a zero offset is written Z
  { utc: "261119160000-0000" },
  { utc: "261119160000+2400" },
  { utc: "261119160000-2430" },
  { utc: "261119160000+2500" },
  { utc: "261119160000+0860" },
  { utc: "491231235959Z" }, // 2049
  { utc: "500101000000Z" }, // 1950
  { utc: "500101000000+0100" },
  { utc: "680229120000Z" }, // 1968
  { utc: "690101000000Z" }, // 1969
  { utc: "991231235959-0001" },
  { utc: "000229000000Z" }, // 2000 is a leap year
  { utc: "270229000000Z" }, // 2027 is not
  { utc: "261131000000Z" },
  { utc: "261300000000Z" },
  { utc: "260001000000Z" },
  { utc: "261100000000Z" },
  { utc: "261119240000Z" },
  { utc: "261119236000Z" },
  { utc: "261119235960Z" },
  { utc: "261119160000" },
  { utc: "261119160000z" },
  { utc: "261119160000.5Z" },
  { utc: "26111916000Z" },
  { utc: "20261119160000Z" },
  { utc: "2611191600 Z" },
  { utc: "+61119160000Z" },
  { generalized: "20261119160000Z" },
  { generalized: "20261119160000+0800" },
  { generalized: "202611191600Z" }, // GeneralizedTime needs its seconds
  { generalized: "20261119160000.000Z" },
  { generalized: "20261119160000" },
  { generalized: "00000101000000+0100" }, // the year before year 0
  { generalized: "00000229000000Z" },
  { generalized: "09991231235959Z" },
  { generalized: "99991231235959-0100" }, // year 10000
  { generalized: "99991231160000Z" }, // year 10000 in Taiwan
  { generalized: "19000229000000Z" }, // 1900 is not a leap year
  { generalized: "24000229000000Z" },
  { generalized: "261119160000Z" },
];
const TIMED = TIMES.map((thisUpdateAs, i) => makeCrl({ issuer: "G3", number: BigInt(1000 + i), thisUpdate: new Date("2026-11-19T16:00:00Z"), serials: [BigInt(i + 1)], thisUpdateAs }));
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
    // The list of times holds both kinds: some the Go crl/ reads, some it does not.
    const timed = TIMED.map((crl) => go.stdout.split("\n").find((l) => l.includes(sha256Hex(crl)))!);
    const refused = timed.filter((l) => l.includes("-not_usable_der")).length;
    assert.ok(refused >= 10 && timed.length - refused >= 10, `${refused} of ${timed.length} refused`);
    for (const year of ["1950-01-01T00:00:00Z", "-0001-12-31T23:00:00Z", '"crl_date":"10000-01-01"']) assert.ok(timed.some((l) => l.includes(year)), year);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
