// The check of a deployed site that needs no card (test/site-check.ts), run
// on the local Worker: it passes on a Worker as it is deployed, and each
// thing it is for makes it fail. The data domain is the simulated R2 bucket,
// with the CORS rule the operator set on the real one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type TestWorker, startWorker } from "./harness.ts";
import { CRL_TIME, freshRoster, publishCrl, tw } from "./records.ts";
import { type Reader, checkSite } from "./site-check.ts";

/** The date the pages of this test's roster say it was last cleared on: the test's own, not wrangler.jsonc's. It is the day the roster's object first runs. */
const CLEARED_ON = "2026-11-20";
const SITE_ORIGIN = "https://test.iamreal.tw";

let worker: TestWorker;
let proofFiles: string;
before(async () => {
  // A card proof page of made-up files, with a script of the site's own as the built page has: the check asks
  // whether the page and its help page are there, and what scripts they have.
  proofFiles = mkdtempSync(join(tmpdir(), "site-check-"));
  for (const name of ["index.html", "help.html"]) writeFileSync(join(proofFiles, name), '<!DOCTYPE html><title>proof</title><script type="module" crossorigin src="/proof/assets/index.js"></script><body></body>');
  worker = await startWorker({ proofFiles });
  await freshRoster(worker, { clearedOn: CLEARED_ON });
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

const site: Reader = (path, headers) => worker.fetch(path, { redirect: "manual", headers: { ...headers } });
/** The data domain: the files of the bucket, with the headers they were stored with, readable from the site's pages only. */
const data: Reader = async (path, headers) => {
  const file = (await worker.files(path.slice(1))).find((f) => `/${f.key}` === path);
  if (file === undefined) return new Response(null, { status: 404 });
  return new Response(new Blob([new Uint8Array(file.bytes)]), { headers: { "Cache-Control": file.cacheControl ?? "", ...(headers?.Origin === SITE_ORIGIN && { "Access-Control-Allow-Origin": SITE_ORIGIN }) } });
};

type Parts = Parameters<typeof checkSite>[0];
const AS_DEPLOYED: Parts = { site, data, today: "2026-11-21", clearedOn: CLEARED_ON };
/** What each failing line is about: its text up to the problem. */
const failed = async (parts: Partial<Parts>): Promise<string[]> => (await checkSite({ ...AS_DEPLOYED, ...parts })).filter((l) => !l.ok).map((l) => l.what);
/** The site, with the answer for one path changed. */
const siteWith = (path: string, change: (res: Response, body: string, headers?: Readonly<Record<string, string>>) => Response): Reader => async (p, headers) => {
  const res = await site(p, headers);
  return p === path ? change(res, await res.text(), headers) : res;
};
/** The data domain, with the answer for one path replaced. */
const dataWith = (path: string, answer: (res: Response, headers?: Readonly<Record<string, string>>) => Response | Promise<Response>): Reader => async (p, headers) => {
  const res = await data(p, headers);
  return p === path ? answer(res, headers) : res;
};
/** Fails exactly the line that starts with `line`. */
async function failsOnly(parts: Partial<Parts>, line: string, saying?: RegExp): Promise<void> {
  const lines = await failed(parts);
  assert.equal(lines.length, 1, lines.join("\n") || `nothing failed, ${line} should have`);
  assert.ok(lines[0]!.startsWith(`${line}: `), lines[0]);
  if (saying !== undefined) assert.match(lines[0]!, saying);
}

test("every check passes on the Worker as it is deployed, with a card proof page and CRLs of both issuer keys", async () => {
  const lines = await checkSite(AS_DEPLOYED);
  assert.deepEqual(lines.filter((l) => !l.ok), []);
  assert.equal(lines.length, 21, "a line for each thing checked");
  // The day after, before the alarm of midnight has run, the last line is yesterday's: that passes too.
  assert.deepEqual(await failed({ today: "2026-11-22" }), []);
});

test("a CRL older than 3 days fails, and so does an issuer key without a usable CRL", async () => {
  // The roster's own date is another line's to judge: here it is published on the day asked about.
  const publishedOn = (date: string): Reader => siteWith("/api/v1/fingerprint", (res, body) => new Response(body.replace("2026-11-21", date), { headers: res.headers }));
  const fingerprintsOn = (date: string): Reader => dataWith("/roster/fingerprints.jsonl", async (res) => new Response((await res.text()).replace("2026-11-21", date), { headers: res.headers }));
  const on = (date: string): Partial<Parts> => ({ today: date, site: publishedOn(date), data: fingerprintsOn(date) });
  assert.deepEqual(await failed(on("2026-11-23")), []);
  const late = await failed(on("2026-11-24"));
  assert.equal(late.length, 2, late.join("\n"));
  assert.match(late[0]!, /G2.*2026-11-20/);
  assert.match(late[1]!, /G3.*2026-11-20/);
  const withoutG2 = dataWith("/crl/index.jsonl", async (res) => new Response((await res.text()).split("\n").filter((l) => !l.includes('"G2"')).join("\n"), { headers: res.headers }));
  await failsOnly({ data: withoutG2 }, "the data domain: a usable CRL of G2 at most 3 days old", /no usable CRL of G2/);
});

test("a page: another status, a header missing, a cookie, no noindex in the page, another date beside the mark; each fails", async () => {
  const without = (name: string) => (res: Response, body: string): Response => {
    const headers = new Headers(res.headers);
    headers.delete(name);
    return new Response(body, { status: res.status, headers });
  };
  await failsOnly({ site: siteWith("/faq", without("Content-Security-Policy")) }, "GET /faq", /Content-Security-Policy/);
  await failsOnly({ site: siteWith("/roster", without("X-Robots-Tag")) }, "GET /roster", /X-Robots-Tag/);
  await failsOnly({ site: siteWith("/roster", (res, body) => new Response(body, { status: 500, headers: res.headers })) }, "GET /roster", /status is 500/);
  // The page of a card that is not on the roster must be a 404, whatever it says.
  await failsOnly({ site: siteWith("/p/7K2Q9FM4XD", (res, body) => new Response(body, { status: 200, headers: res.headers })) }, "GET /p/7K2Q9FM4XD", /status is 200/);
  const withCookie = (res: Response, body: string): Response => {
    const headers = new Headers(res.headers);
    headers.append("Set-Cookie", "a=b");
    return new Response(body, { status: res.status, headers });
  };
  await failsOnly({ site: siteWith("/", withCookie) }, "GET /", /cookie/);
  await failsOnly({ site: siteWith("/verify", (res, body) => new Response(body.replace('<meta name="robots" content="noindex">', ""), { status: res.status, headers: res.headers })) }, "GET /verify", /noindex/);
  const otherDate = await failed({ clearedOn: "2026-11-22" });
  assert.equal(otherDate.length, 8, otherDate.join("\n"));
  assert.ok(otherDate.every((w) => w.includes("the date 2026-11-22")), otherDate.join("\n"));
});

test("a script added to a page on its way to a browser fails: one of another origin, or one written into the page", async () => {
  // What a proxy in front of the site does: only a request that accepts HTML gets the page with the script.
  const adding = (script: string): Reader =>
    siteWith("/faq", (res, body, headers) => new Response(headers?.Accept === "text/html" ? body.replace("</body>", `${script}</body>`) : body, { status: res.status, headers: res.headers }));
  const line = "no page has a script that is not a file of this site";
  await failsOnly({ site: adding('<script type="module" src="https://example.com/beacon.js"></script>') }, line, /\/faq has <script type="module" src="https:\/\/example\.com/);
  await failsOnly({ site: adding('<script src="//example.com/a.js"></script>') }, line, /\/faq/);
  await failsOnly({ site: adding("<script>1</script>") }, line, /\/faq has <script>/);
  // The card proof page and its help page are read for the same.
  for (const path of ["/proof", "/proof/help.html"]) {
    const added = siteWith(path, (res, body, headers) => new Response(headers?.Accept === "text/html" ? body.replace("</body>", '<script type="module" src="https://example.com/beacon.js"></script></body>') : body, { status: res.status, headers: res.headers }));
    await failsOnly({ site: added }, line, new RegExp(`${path.replace(/[/.]/g, "\\$&")} has <script type="module" src="https://example\\.com`));
  }
});

test("a site without the card proof page, a style sheet kept by caches: each fails", async () => {
  await failsOnly({ site: siteWith("/proof", () => new Response(null, { status: 404 })) }, "GET /proof", /404/);
  await failsOnly({ site: siteWith("/proof/help.html", () => new Response(null, { status: 404 })) }, "GET /proof/help.html", /404/);
  await failsOnly({ site: siteWith("/pages.css", (res, body) => new Response(body, { headers: { ...Object.fromEntries(res.headers), "cache-control": "public, max-age=60" } })) }, "GET /pages.css", /Cache-Control/);
});

test("config: the production roster's platforms, another age for CRLs, an answer a cache may keep; each fails", async () => {
  const config = (change: (c: Record<string, unknown>) => void, headers?: Record<string, string>): Reader =>
    siteWith("/api/v1/config", (res, body) => {
      const c = JSON.parse(body) as Record<string, unknown>;
      change(c);
      return new Response(JSON.stringify(c), { headers: { ...Object.fromEntries(res.headers), ...headers } });
    });
  await failsOnly({ site: config((c) => (c.platforms = (c.platforms as { platform: string }[]).filter((p) => p.platform !== "test-example"))) }, "GET /api/v1/config", /platforms/);
  await failsOnly({ site: config((c) => (c.crl_max_age_days = 7)) }, "GET /api/v1/config", /crl_max_age_days/);
  await failsOnly({ site: config(() => undefined, { "cache-control": "public, max-age=60" }) }, "GET /api/v1/config", /Cache-Control/);
});

test("the fingerprint file: a last line that is not what the API answers fails; no file passes only when the API says nothing was published", async () => {
  const line = `{"date":"2026-11-20","count":0,"fingerprint":"${"0".repeat(64)}"}\n`;
  await failsOnly({ data: dataWith("/roster/fingerprints.jsonl", () => new Response(line)) }, "the data domain: the last line of /roster/fingerprints.jsonl is what GET /api/v1/fingerprint answers", /ends with/);
  // The file is gone and the API still answers a date: the bucket was emptied under a roster that was published.
  const noFile = dataWith("/roster/fingerprints.jsonl", () => new Response(null, { status: 404 }));
  await failsOnly({ data: noFile }, "the data domain: the last line of /roster/fingerprints.jsonl is what GET /api/v1/fingerprint answers", /there is no file/);
});

test("a roster that was never published passes on the day it was cleared and the two days after, and no longer", async () => {
  // As after a clearing: no file, no date.
  const neverPublished = siteWith("/api/v1/fingerprint", (res) => new Response(`{"date":null,"count":0,"fingerprint":"${"0".repeat(64)}"}`, { headers: res.headers }));
  const noFile = dataWith("/roster/fingerprints.jsonl", () => new Response(null, { status: 404 }));
  // Cleared on 2026-11-20: the first line is due at the midnight of the 21st, or of the 22nd if the object first ran on the 21st.
  assert.deepEqual(await failed({ site: neverPublished, data: noFile, today: "2026-11-20" }), []);
  assert.deepEqual(await failed({ site: neverPublished, data: noFile, today: "2026-11-22" }), []);
  // The 23rd: the object does not publish. (The CRLs of the 20th are still young enough that day.)
  await failsOnly({ site: neverPublished, data: noFile, today: "2026-11-23" }, "GET /api/v1/fingerprint: the roster was published today or yesterday, or was cleared at most 2 days ago and not published yet", /nothing was published yet.*2026-11-20; today is 2026-11-23/);
});

test("a roster whose daily publication stopped fails: the last line is older than yesterday", async () => {
  await failsOnly({ today: "2026-11-23" }, "GET /api/v1/fingerprint: the roster was published today or yesterday, or was cleared at most 2 days ago and not published yet", /"2026-11-21"; today is 2026-11-23/);
});

test("the data domain's CORS: not allowing the site fails, and so does allowing another site", async () => {
  const line = `the data domain: CORS allows ${SITE_ORIGIN} and no other origin`;
  const stripped = (res: Response): Headers => {
    const headers = new Headers(res.headers);
    headers.delete("Access-Control-Allow-Origin");
    return headers;
  };
  await failsOnly({ data: dataWith("/crl/index.jsonl", (res) => new Response(res.body, { headers: stripped(res) })) }, line, new RegExp(`for ${SITE_ORIGIN}`));
  const anyone = dataWith("/crl/index.jsonl", (res, headers) => {
    const out = stripped(res);
    if (headers?.Origin !== undefined) out.set("Access-Control-Allow-Origin", headers.Origin);
    return new Response(res.body, { headers: out });
  });
  await failsOnly({ data: anyone }, line, /for https:\/\/example\.com/);
});

test("on the local Worker of `pnpm local` (local: true), the data is the site's own origin: no CORS is asked, and a roster that was never published passes whenever it was cleared", async () => {
  const noCors: Reader = async (p, headers) => {
    const res = await data(p, headers);
    const out = new Headers(res.headers);
    out.delete("Access-Control-Allow-Origin");
    return new Response(res.body, { status: res.status, headers: out });
  };
  const lines = await checkSite({ ...AS_DEPLOYED, data: noCors, local: true });
  assert.deepEqual(lines.filter((l) => !l.ok), []);
  assert.equal(lines.length, 19, "the two lines about Cloudflare's running of the roster are not there");
  assert.ok(!lines.some((l) => l.what.startsWith("the data domain: CORS") || l.what.startsWith("GET /api/v1/fingerprint: the roster was published")));
  // A local roster publishes only on a midnight the command was running over: never published, long after the clearing, passes.
  const neverPublished = siteWith("/api/v1/fingerprint", (res) => new Response(`{"date":null,"count":0,"fingerprint":"${"0".repeat(64)}"}`, { headers: res.headers }));
  const noFile = dataWith("/roster/fingerprints.jsonl", () => new Response(null, { status: 404 }));
  assert.deepEqual(await failed({ site: neverPublished, data: noFile, today: "2026-11-23", local: true }), []);
  // The rest is checked as on the deployed site: a CRL older than 3 days still fails.
  assert.ok((await failed({ local: true, today: "2026-11-30" })).some((l) => l.startsWith("the data domain: a usable CRL of G2")));
});
