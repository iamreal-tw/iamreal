// A production build (vite.config.ts, mode "production") holds MOICA's
// issuer keys and the component's real address, the public proof log's scope
// string, the data domain https://data.iamreal.tw (ADR-0027), and nothing of
// the tests: no fake card, no test issuer keys, no fake component, no test
// platform. The build for a real card on this computer (mode "localcard",
// worker/'s `pnpm local`) holds MOICA's keys and the real component too and nothing
// of the tests, but signs the test log's scope string and knows the test
// log's platforms; it fetches the CRL from its own origin (the local
// server), so it names no data domain. The test site's build (mode
// "testsite", what a deploy of test.iamreal.tw serves at /proof) is the local
// one with the test log's data domain, https://test-data.iamreal.tw, and
// the mark of a test log (design/copy/test-site.md) with the date it is
// built with.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const web = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

type Mode = "production" | "localcard" | "testsite";

/** A build in `mode`: its files by their path under the build, and the scripts, HTML and CSS among them one after another. */
async function buildOf(mode: Mode): Promise<{ files: Map<string, string>; code: string }> {
  const out = join(web, "test-output", `build-check-${mode}`);
  rmSync(out, { recursive: true, force: true });
  await build({ root: web, configFile: join(web, "vite.config.ts"), mode, logLevel: "silent", build: { outDir: out, emptyOutDir: true } });
  const files = new Map(filesUnder(out).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => [relative(out, f).split(sep).join("/"), readFileSync(f, "utf8")]));
  const all = filesUnder(out).map((f) => relative(out, f).split(sep).join("/"));
  rmSync(out, { recursive: true, force: true });
  for (const f of all) if (!files.has(f)) files.set(f, "");
  return { files, code: [...files.values()].join("\n") };
}

/** The scripts, HTML and CSS of a build in `mode`. */
const codeOf = async (mode: Mode): Promise<string> => (await buildOf(mode)).code;

/** The first hex digits of the moduli of MOICA's G2 and G3 issuer keys. */
const MOICA_KEYS = ["9fd8089c05559d63d5ab34bc5df685fb", "ae5ae964e29305a7dec0863d7f57aa66"];

/** Everything a page of a build loads when it opens: the scripts and style sheets its HTML names, and what those scripts import, by path under the build. */
function loadedBy(files: Map<string, string>, page: string): string[] {
  const seen = new Set<string>();
  const queue = [...files.get(page)!.matchAll(/(?:src|href)="\/proof\/([^"]+)"/g)].map((m) => m[1]!);
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of (files.get(f) ?? "").matchAll(/(?:from|import)\s*\(?\s*["'`]\.\/([^"'`]+)["'`]/g)) queue.push(`assets/${m[1]!}`);
  }
  return [...seen].sort();
}

/**
 * What both builds hold, and what neither does. `dataOrigin` is the one other origin the build may name, if any;
 * `appLink`, the app domain's link, the one other the screens link to (not a request: a link the cardholder follows).
 */
function realCardOnly(code: string, mode: string, dataOrigin: string | null, appLink: string | null = null): void {
  assert.ok(code.length > 100_000, `${mode}: the build has its scripts`);
  // MOICA's component and issuer keys (the first hex digits of G2's and G3's moduli).
  assert.ok(code.includes("http://localhost:61161"), `${mode}: the component's address`);
  assert.ok(MOICA_KEYS.every((k) => code.includes(k)), `${mode}: MOICA's issuer keys`);
  // Nothing of the fake card (src/card/fake.ts), the test target or the fake component.
  for (const s of ["the card signs 31 bytes", "__IAMREAL_TEST", "FakeCard", "fake-component", "testIssuer", "PRIVATE KEY", "pkcs8"]) {
    assert.ok(!code.includes(s), `${mode}: the build contains ${JSON.stringify(s)}`);
  }
  // The only addresses outside the page's own origin are the component's and the data domain's, and the app domain's link.
  const urls = new Set([...code.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)].map((m) => m[0]));
  for (const u of urls) {
    // Names in comments of the libraries (licences, specifications) are not requests; the page's CSP
    // allows only its own origin and the data domain, so these could not be fetched anyway.
    if (u === "http://localhost:61161" || u === dataOrigin || (appLink !== null && u === new URL(appLink).origin)) continue;
    assert.ok(!/localhost|127\.0\.0\.1|iamreal/.test(u), `${mode}: the build names ${u}`);
  }
  if (dataOrigin !== null) assert.ok(urls.has(dataOrigin), `${mode}: the data domain ${dataOrigin}`);
  // The link whole, as the QR code holds it; no app domain at all in a build without one.
  if (appLink !== null) assert.match(code, new RegExp(`["'\`]${appLink.replaceAll(".", "\\.")}["'\`]`), `${mode}: the app domain's link ${appLink}`);
  else assert.ok(!/["'`]https:\/\/[a-z-]*app\.iamreal\.tw/.test(code), `${mode}: no app domain`);
}

test("a production build holds nothing of the tests, and signs the public proof log's scope string", async () => {
  const code = await codeOf("production");
  realCardOnly(code, "production", "https://data.iamreal.tw");
  assert.ok(code.includes("iamreal:public:0_______________"), "the public proof log's scope string");
  // The test log's second platform is not in it (src/presentations/test-example.ts).
  assert.ok(!code.includes("Example (no real service)"), "the production build has test-example's definition");
});

test("the local build (pnpm local): MOICA's keys and component, nothing of the tests, the test log's scope string, Threads only", async () => {
  const code = await codeOf("localcard");
  realCardOnly(code, "localcard", null);
  // The proof log of src/target-local.ts: the test one. Both scope strings are in the table of
  // protocol/src/scope.ts; the target picks the test one (checked in Node below).
  assert.ok(code.includes("iamreal-test:public:0__________"), "the test log's scope string");
  // Threads only, as the production build (#309): the test log's second platform is not in it.
  assert.ok(!code.includes("Example (no real service)"), "the local build has test-example's definition");
});

/** The date a test site's build is given: when its proof log was last cleared (worker/wrangler.jsonc has the deployed one). */
const CLEARED_ON = "2026-10-31";
/** The sentence beside the mark of a test log (design/copy/test-site.md), up to its date. */
const MARK = /```\n(.*)\d{4}-\d{2}-\d{2}\n```/.exec(readFileSync(join(web, "..", "design", "copy", "test-site.md"), "utf8"))![1]!;

test("the test site's build: MOICA's keys and component, nothing of the tests, the test log's scope string, its data domain and no other address, the test site's links, the mark of a test log", async () => {
  process.env.IAMREAL_TEST_PROOF_LOG_CLEARED_ON = CLEARED_ON;
  const { files, code } = await buildOf("testsite").finally(() => delete process.env.IAMREAL_TEST_PROOF_LOG_CLEARED_ON);
  realCardOnly(code, "testsite", "https://test-data.iamreal.tw", "https://test-app.iamreal.tw/");
  assert.ok(code.includes("iamreal-test:public:0__________"), "the test log's scope string");
  assert.ok(!code.includes("Example (no real service)"), "the test site's build has test-example's definition (#309: Threads only)");
  assert.ok(!code.includes("https://data.iamreal.tw"), "not the production log's data domain");
  // The link of the last screen is the card's page on the test site (src/target-test-site.ts, SITE_DOMAIN).
  assert.match(code, /["'`]test\.iamreal\.tw["'`]/, "the test site's domain, for the link of the last screen");
  // The public site's domain nowhere but as the site's name in the header, which stays on the test site (design/copy/test-site.md).
  assert.doesNotMatch(code.replace(/site_name:["'`]iamreal\.tw["'`]/, ""), /["'`]iamreal\.tw["'`]/, "not the public site's domain");
  // The mark: one JSON text among the scripts the page loads (its entry, which this mode adds to the page, is bundled with
  // the page's own: the page is the build's one HTML), with the sentence, the date and the scope string of the build's target.
  assert.ok(MARK.startsWith("測試的證明紀錄"));
  const mark = JSON.stringify({ sentence: MARK, clearedOn: CLEARED_ON, scope: "iamreal-test:public:0__________" });
  const loaded = loadedBy(files, "index.html").filter((f) => f.endsWith(".js"));
  const holding = loaded.filter((f) => files.get(f)!.replaceAll("\\", "").includes(mark));
  assert.equal(holding.length, 1, `one script the page loads holds ${mark}`);
  assert.equal([...code.replaceAll("\\", "").matchAll(/"clearedOn":/g)].length, 1, "the mark once in the build");
});

test("the production build has nothing of the mark, and it is the one page: no help page", async () => {
  const { files, code } = await buildOf("production");
  assert.ok(![...files.keys()].some((f) => f.includes("test-proof-log")) && !code.includes("測試的證明紀錄") && !code.includes("test-proof-log"), "no file and no word of the mark");
  assert.match(code, /["'`]iamreal\.tw["'`]/, "the public site's domain, for the link of the last screen");
  assert.ok(!code.includes("test.iamreal.tw") && !code.includes("test-data.iamreal.tw"), "nothing of the test site");
  // The help page is gone (its old address goes to /prepare, worker/site/_redirects).
  assert.deepEqual([...files.keys()].filter((f) => f.endsWith(".html")), ["index.html"]);
  const page = loadedBy(files, "index.html").map((f) => files.get(f)!).join("\n");
  for (const s of [...MOICA_KEYS, "localhost:61161", "iamreal:public:0"]) assert.ok(page.includes(s), `the card proof page loads ${JSON.stringify(s)}`);
  // The site's icon, as every page of the site links to it (worker/src/pages/layout.ts, #356): the one file at /favicon.ico.
  assert.equal(files.get("index.html")!.match(/rel="icon"[^>]*/g)?.join(), 'rel="icon" href="/favicon.ico" /', "the page's icon is the site's /favicon.ico");
});

test("no other build has the mark of a test log", async () => {
  for (const mode of ["production", "localcard"] as const) {
    const code = await codeOf(mode);
    assert.ok(!code.includes("測試的證明紀錄") && !code.includes("test-proof-log") && !code.includes("test.iamreal.tw"), mode);
  }
});

test("the test site's build is not made without the date its proof log was last cleared on, or with one the calendar does not have", async () => {
  for (const date of [undefined, "", "2026-11-31", "20261120", "2026-11-20 "]) {
    if (date === undefined) delete process.env.IAMREAL_TEST_PROOF_LOG_CLEARED_ON;
    else process.env.IAMREAL_TEST_PROOF_LOG_CLEARED_ON = date;
    await assert.rejects(codeOf("testsite"), /IAMREAL_TEST_PROOF_LOG_CLEARED_ON/, JSON.stringify(date)).finally(() => delete process.env.IAMREAL_TEST_PROOF_LOG_CLEARED_ON);
  }
});

test("the local target signs the test log's scope string; the production target the public proof log's", async () => {
  const local = await import("../src/target-local.ts");
  const production = await import("../src/target.ts");
  const { scopeOf } = await import("iamreal-protocol/scope.ts");
  assert.equal(scopeOf(local.PROOF_LOG), "iamreal-test:public:0__________");
  assert.equal(scopeOf(production.PROOF_LOG), "iamreal:public:0_______________");
  assert.deepEqual(local.ISSUERS, production.ISSUERS);
  assert.equal(local.COMPONENT_ORIGIN, production.COMPONENT_ORIGIN);
  assert.equal(local.IDLE_LIMIT_MS, production.IDLE_LIMIT_MS);
  // The CRL archive: on the data domain (ADR-0027); the local build's on the local server, its own origin.
  assert.equal(production.DATA_ORIGIN, "https://data.iamreal.tw");
  assert.equal(local.DATA_ORIGIN, "");
  // Threads only in every build of a real card (#309); test-example is the headless tests' (test/e2e/target.ts).
  assert.deepEqual(local.PRESENTATIONS.map((p) => p.platform), ["threads"]);
  assert.deepEqual(production.PRESENTATIONS.map((p) => p.platform), ["threads"]);
});

test("the test site's target is the local one but for the data domain and the site: the test log's, https://test-data.iamreal.tw and test.iamreal.tw", async () => {
  const site = await import("../src/target-test-site.ts");
  const local = await import("../src/target-local.ts");
  const { scopeOf } = await import("iamreal-protocol/scope.ts");
  assert.equal(scopeOf(site.PROOF_LOG), "iamreal-test:public:0__________");
  assert.deepEqual(site.ISSUERS, local.ISSUERS);
  assert.equal(site.COMPONENT_ORIGIN, local.COMPONENT_ORIGIN);
  assert.equal(site.IDLE_LIMIT_MS, local.IDLE_LIMIT_MS);
  assert.deepEqual(site.PRESENTATIONS, local.PRESENTATIONS);
  assert.equal(site.DATA_ORIGIN, "https://test-data.iamreal.tw");
  // The link of the last screen: the card's page on the site of the build's proof log. On the test site, as
  // design/copy/test-site.md writes the address of a page of a card (寫出島民證明網址的地方).
  const copy = readFileSync(join(web, "..", "design", "copy", "test-site.md"), "utf8");
  const written = /\n## 寫出島民證明網址的地方\n[\s\S]*?```\n(.*)\n```/.exec(copy)?.[1];
  const { cardPath } = await import("../src/platforms.ts");
  assert.equal(`${site.SITE_DOMAIN}/${cardPath("7K2Q9FM4XD")}`, written);
  const production = await import("../src/target.ts");
  assert.deepEqual([site.SITE_DOMAIN, production.SITE_DOMAIN, local.SITE_DOMAIN], ["test.iamreal.tw", "iamreal.tw", "iamreal.tw"]);
  // The app domain (ADR-0040): the test site's, as design/copy/app-domain.md names it, with no path; none before the
  // production site has one (app.iamreal.tw, at launch), and none on this computer's server, which no app connects to.
  const appDomain = /\n## 測試網站（`([a-z.-]+)`）/.exec(readFileSync(join(web, "..", "design", "copy", "app-domain.md"), "utf8"))?.[1];
  assert.equal(appDomain, "test-app.iamreal.tw");
  assert.deepEqual([site.APP_LINK, production.APP_LINK, local.APP_LINK], [`https://${appDomain}/`, null, null]);
});
