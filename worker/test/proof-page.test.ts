// The card proof page a deploy puts among the files of Static Assets
// (scripts/proof-page.ts): the test site's build of web/ (mode "testsite"),
// made by `buildProofPage` and checked by `checkProofPage` before anything
// is uploaded (README.md, "Static Assets"). The checks are tried on made-up
// builds, one thing wrong in each, and on the real build.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkProofPages, moduliInSpec } from "../scripts/deploy-build-checks.ts";
import { type ProofPage, buildProofPage, checkProofPage, readProofPage } from "../scripts/proof-page.ts";
import { WORKER_DIR } from "./build.ts";

const CLEARED_ON = "2026-11-19";
const [G2, G3] = moduliInSpec();
/** A build as the test site's is, as far as the checks look: its files, and what its scripts say. */
const good: ProofPage = {
  files: {
    "index.html": 495,
    "help.html": 494,
    "assets/index-COXnmzfW.js": 234_741,
    "assets/test-proof-log-BGxzo_9J.css": 8364,
    "assets/acvm_js_bg-D_Jg3KxI.wasm": 3_050_251,
    "assets/GenRyuMin2TW-B-BGxSzql1.woff2": 177_340,
    "bb/barretenberg.wasm.gz": 4_067_387,
    "bb/barretenberg-threads.wasm.gz": 4_071_596,
    "circuits/card_proof_rs2048.json": 628_260,
    "circuits/card_proof_rs4096.json": 804_766,
    "crs/bn254_g1_compressed_2p18.dat": 8_388_608,
    "crs/bn254_g2.dat": 128,
  },
  code: `const component="http://localhost:61161";const data="https://test-data.iamreal.tw";const keys=["${G2}","${G3}"];const scopes=["iamreal:public:0_______________","iamreal-test:public:0__________"];const site="test.iamreal.tw";const mark=JSON.parse('{"sentence":"測試的證明紀錄　不定期清空，上次清空：","clearedOn":"${CLEARED_ON}","scope":"iamreal-test:public:0__________"}');// see https://www.w3.org/TR/wasm/`,
};
const withFiles = (change: (files: Record<string, number>) => void): ProofPage => {
  const files = { ...good.files };
  change(files);
  return { ...good, files };
};
const withCode = (from: string, to: string): ProofPage => {
  assert.ok(good.code.includes(from));
  return { ...good, code: good.code.replace(from, to) };
};

test("a build as the test site's is passes for a test log's site with that date", () => {
  checkProofPage(good, "test", CLEARED_ON);
});

test("a build with a file missing or empty, or a file that is no part of the page, is turned away", () => {
  const cases: [string, ProofPage | null, RegExp][] = [
    ["no build at all: /proof would be 404", null, /no build of web\//],
    ["no index.html", withFiles((f) => delete f["index.html"]), /index\.html/],
    ["no help page", withFiles((f) => delete f["help.html"]), /help\.html/],
    ["no CRS: the build was made before `pnpm fetch-crs`", withFiles((f) => (delete f["crs/bn254_g1_compressed_2p18.dat"], delete f["crs/bn254_g2.dat"])), /crs\/bn254_g1_compressed_2p18\.dat/],
    ["a circuit missing", withFiles((f) => delete f["circuits/card_proof_rs4096.json"]), /circuits\/card_proof_rs4096\.json/],
    ["no single-thread module", withFiles((f) => delete f["bb/barretenberg.wasm.gz"]), /bb\/barretenberg\.wasm\.gz/],
    ["no script", withFiles((f) => delete f["assets/index-COXnmzfW.js"]), /a script under assets\//],
    ["rules of Static Assets among the page's files", withFiles((f) => (f["_headers"] = 10)), /_headers/],
    ["a file beside the page's", withFiles((f) => (f["notes.txt"] = 10)), /notes\.txt/],
    ["a directory that is not the build's", withFiles((f) => (f["local/proof-log.db"] = 10)), /local\/proof-log\.db/],
    ["a page under assets/", withFiles((f) => (f["assets/other.html"] = 10)), /assets\/other\.html/],
    ["another kind of font under assets/", withFiles((f) => (f["assets/other.ttf"] = 10)), /assets\/other\.ttf/],
    ["an empty file where the CRS is", withFiles((f) => (f["crs/bn254_g2.dat"] = 0)), /crs\/bn254_g2\.dat of the card proof page is not empty/],
  ];
  for (const [name, page, message] of cases) assert.throws(() => checkProofPage(page, "test", CLEARED_ON), message, name);
});

test("a build of another target is turned away: the tests', the production log's, the one for a real card on this computer, or one with another date", () => {
  const cases: [string, ProofPage, RegExp][] = [
    ["the fake component's address", withCode("http://localhost:61161", "http://localhost:61171"), /localhost:61171|the component/],
    ["a second local address", { ...good, code: `${good.code}fetch("http://127.0.0.1:8080/x")` }, /127\.0\.0\.1:8080/],
    ["a test's issuer key in MOICA's place", withCode(G3!, "ab".repeat(512)), /MOICA's issuer keys/],
    ["the test target's values", { ...good, code: `${good.code}__IAMREAL_TEST_ISSUERS__` }, /__IAMREAL_TEST/],
    ["the fake card", { ...good, code: `${good.code}class FakeCard{}` }, /FakeCard/],
    ["a private key", { ...good, code: `${good.code}importKey("pkcs8",k)` }, /pkcs8/],
    ["the production log's data domain", withCode("https://test-data.iamreal.tw", "https://data.iamreal.tw"), /data\.iamreal\.tw/],
    ["both data domains", { ...good, code: `${good.code}"https://data.iamreal.tw"` }, /https:\/\/data\.iamreal\.tw/],
    ["no data domain: the build for a real card on this computer", withCode('"https://test-data.iamreal.tw"', '""'), /test-data\.iamreal\.tw/],
    ["another address of the project", { ...good, code: `${good.code}"https://iamreal.tw/api"` }, /https:\/\/iamreal\.tw/],
    ["no mark of a test log", withCode("測試的證明紀錄", ""), /mark of a test log/],
    ["the mark with another date than the Worker's setting", withCode(CLEARED_ON, "2026-11-18"), /2026-11-19/],
    ["a build whose target signs the public proof log's scope string", withCode('"scope":"iamreal-test:public:0__________"', '"scope":"iamreal:public:0_______________"'), /says the build signs iamreal-test:public:0__________/],
    ["a mark that does not say which scope string", withCode(',"scope":"iamreal-test:public:0__________"', ""), /says the build signs/],
    ["two marks", { ...good, code: `${good.code}'{"clearedOn":"${CLEARED_ON}","scope":"iamreal:public:0_______________"}'` }, /says the build signs/],
    ["the public site's domain in the links", withCode('"test.iamreal.tw"', '"iamreal.tw"'), /test\.iamreal\.tw/],
    ["both sites' domains", { ...good, code: `${good.code}const other="iamreal.tw"` }, /links with iamreal\.tw/],
    // The header's site name is let through once; a link with the public domain beside it is still caught.
    ["the site's name, and the public domain in a link", { ...good, code: `${good.code}const copy={site_name:"iamreal.tw"};const other="iamreal.tw"` }, /links with iamreal\.tw/],
  ];
  // The site's name in the header alone: iamreal.tw on every site (design/copy/test-site.md).
  checkProofPage({ ...good, code: `${good.code}const copy={common:{site_name:\`iamreal.tw\`}}` }, "test", CLEARED_ON);
  for (const [name, page, message] of cases) assert.throws(() => checkProofPage(page, "test", CLEARED_ON), message, name);
  // The date the build must carry is the one it is checked against.
  assert.throws(() => checkProofPage(good, "test", "2026-11-20"), /2026-11-20/);
  // No deploy of a production log's site is made here yet: its page is not this build.
  assert.throws(() => checkProofPage(good, "production", null), /production/);
});

test("every environment's page is checked against its own kind of proof log and date; an environment without a page is turned away", () => {
  checkProofPages({ test: { kind: "test", clearedOn: CLEARED_ON, page: good } });
  assert.throws(() => checkProofPages({ test: { kind: "test", clearedOn: CLEARED_ON, page: null } }), /the test environment: there is no build of web\//);
  assert.throws(() => checkProofPages({ test: { kind: "test", clearedOn: "2026-11-20", page: good } }), /the test environment: .*2026-11-20/);
  assert.throws(() => checkProofPages({ test: { kind: "test", clearedOn: undefined, page: good } }), /the test environment: .*last cleared on/);
  assert.throws(() => checkProofPages({ test: { kind: "staging", clearedOn: CLEARED_ON, page: good } }), /PROOF_LOG_KIND of the test environment/);
  // A second environment with the same page is not passed by the first: a production log's site needs another build.
  assert.throws(() => checkProofPages({ test: { kind: "test", clearedOn: CLEARED_ON, page: good }, production: { kind: "production", clearedOn: undefined, page: good } }), /the production environment/);
  assert.throws(() => checkProofPages({}), /has an environment/);
});

test("the test site's build of web/ passes, with the date it was given; without the CRS it is turned away for that", () => {
  mkdirSync(join(WORKER_DIR, "test-output"), { recursive: true });
  const dir = mkdtempSync(join(WORKER_DIR, "test-output", "proof-page-"));
  try {
    buildProofPage(dir, CLEARED_ON);
    const page = readProofPage(dir);
    assert.ok(page !== null && page.code.length > 100_000 && page.files["index.html"]! > 0);
    // web/crs/ is fetched by `pnpm fetch-crs` and is not in the repository: where a build is made without it (the
    // checks of a pull request), the build has no CRS, and that is what the check finds; where it is there (a
    // deploy's build job fetches it first), the build passes.
    if (existsSync(join(WORKER_DIR, "..", "web", "crs", "bn254_g2.dat"))) checkProofPage(page, "test", CLEARED_ON);
    else assert.throws(() => checkProofPage(page, "test", CLEARED_ON), /crs\/bn254_g1_compressed_2p18\.dat/);
    // Whatever the CRS, everything else about it holds.
    checkProofPage({ ...page, files: { ...page.files, "crs/bn254_g1_compressed_2p18.dat": 1, "crs/bn254_g2.dat": 1 } }, "test", CLEARED_ON);
    // The production build of web/ in its place is turned away: it has no mark, the public proof log's data domain and the public site's links.
    // The checks of a pull request have no CRS: the date is looked at on the copy that has one in its place.
    const whole = { ...page, files: { ...page.files, "crs/bn254_g1_compressed_2p18.dat": 1, "crs/bn254_g2.dat": 1 } };
    assert.throws(() => checkProofPage(whole, "test", "2026-11-20"), /2026-11-20/);
    assert.equal(readProofPage(join(dir, "nothing-here")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
