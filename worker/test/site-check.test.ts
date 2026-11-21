// The check of a deployed site that needs no card (test/site-check.ts), run
// on the local Worker: it passes on a Worker as it is deployed, and each
// thing it is for makes it fail. The data domain is the simulated R2 bucket.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";
import { CRL_TIME, freshRoster, publishCrl, tw } from "./records.ts";
import { type Reader, checkSite } from "./site-check.ts";

let worker: TestWorker;
let proofFiles: string;
before(async () => {
  // A card proof page of one made-up file: the check asks only whether /proof is there.
  proofFiles = mkdtempSync(join(tmpdir(), "site-check-"));
  writeFileSync(join(proofFiles, "index.html"), "<!DOCTYPE html><title>proof</title>");
  worker = await startWorker({ proofFiles });
  await freshRoster(worker);
  // A usable CRL of each issuer key, dated 2026-11-20 in Taiwan.
  await publishCrl(worker, { issuer: "G2", number: 1, thisUpdate: CRL_TIME });
  await publishCrl(worker, { issuer: "G3", number: 1, thisUpdate: CRL_TIME });
  // The roster's object starts on 2026-11-20, and is published at the next midnight.
  await worker.fetch("/api/v1/fingerprint");
  await worker.setClock(tw("2026-11-21", "00:00:00"));
  await worker.roster.runAlarm();
});
after(async () => {
  await worker.close();
  rmSync(proofFiles, { recursive: true, force: true });
});

const site: Reader = (path) => worker.fetch(path, { redirect: "manual" });
/** The data domain: the files of the bucket, with the headers they were stored with. */
const data: Reader = async (path) => {
  const file = (await worker.files(path.slice(1))).find((f) => `/${f.key}` === path);
  return file === undefined ? new Response(null, { status: 404 }) : new Response(new Blob([new Uint8Array(file.bytes)]), { headers: { "Cache-Control": file.cacheControl ?? "" } });
};
const failed = async (parts: Parameters<typeof checkSite>[0]): Promise<string[]> => (await checkSite(parts)).filter((l) => !l.ok).map((l) => l.what);

test("every check passes on the Worker as it is deployed, with a card proof page and CRLs of both issuer keys", async () => {
  const lines = await checkSite({ site, data, today: "2026-11-21", clearedOn: "2026-11-19" });
  assert.deepEqual(lines.filter((l) => !l.ok), []);
  assert.ok(lines.length >= 15, "a line for each thing checked");
});

test("a CRL older than 3 days fails, and so does an issuer key without a usable CRL", async () => {
  assert.deepEqual(await failed({ site, data, today: "2026-11-23", clearedOn: "2026-11-19" }), []);
  const late = await failed({ site, data, today: "2026-11-24", clearedOn: "2026-11-19" });
  assert.equal(late.length, 2, late.join("\n"));
  assert.match(late[0]!, /G2.*2026-11-20/);
  assert.match(late[1]!, /G3.*2026-11-20/);
  const withoutG2: Reader = async (path) => {
    const res = await data(path);
    return path === "/crl/index.jsonl" ? new Response((await res.text()).split("\n").filter((l) => !l.includes('"G2"')).join("\n"), { headers: res.headers }) : res;
  };
  const none = await failed({ site, data: withoutG2, today: "2026-11-21", clearedOn: "2026-11-19" });
  assert.equal(none.length, 1, none.join("\n"));
  assert.match(none[0]!, /G2/);
});

test("a page with a header missing, a site without the card proof page, another date beside the mark: each fails", async () => {
  const noPolicy: Reader = async (path) => {
    const res = await site(path);
    const headers = new Headers(res.headers);
    if (path === "/faq") headers.delete("Content-Security-Policy");
    return new Response(res.body, { status: res.status, headers });
  };
  assert.deepEqual((await failed({ site: noPolicy, data, today: "2026-11-21", clearedOn: "2026-11-19" })).map((w) => w.split(":")[0]), ["GET /faq"]);
  const noProof: Reader = (path) => (path === "/proof" ? Promise.resolve(new Response(null, { status: 404 })) : site(path));
  assert.deepEqual((await failed({ site: noProof, data, today: "2026-11-21", clearedOn: "2026-11-19" })).map((w) => w.split(":")[0]), ["GET /proof"]);
  const otherDate = await failed({ site, data, today: "2026-11-21", clearedOn: "2026-11-22" });
  assert.ok(otherDate.length >= 5 && otherDate.every((w) => w.includes("2026-11-22")), otherDate.join("\n"));
});

test("a fingerprint file whose last line is not what the API answers fails", async () => {
  const other: Reader = async (path) => (path === "/roster/fingerprints.jsonl" ? new Response('{"date":"2026-11-20","count":0,"fingerprint":"' + "0".repeat(64) + '"}\n') : data(path));
  const lines = await failed({ site, data: other, today: "2026-11-21", clearedOn: "2026-11-19" });
  assert.equal(lines.length, 1, lines.join("\n"));
  assert.match(lines[0]!, /fingerprints\.jsonl/);
});
