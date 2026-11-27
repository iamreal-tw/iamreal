// The app domain (ADR-0040; README.md, "app 網域"): through the Worker's
// HTTP (test/harness.ts), a request whose host is the test environment's app
// domain gets the two files a phone's system reads (Android App Links, iOS
// Universal Links) and, for every other path, the page for a phone without
// the app (design/copy/app-domain.md); a request to the test site gets
// neither file. And the check of a deploy build that the configuration
// gives the test environment that app domain with the two apps it opens.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type ConfiguredAppDomain, checkAppDomains, configuredAppDomains } from "../scripts/deploy-build-checks.ts";
import { block, copyLines, copySection, squash, testProofLogLine, visibleText, wantLines } from "./copy.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { VISITOR_CSP } from "./pages.ts";

const APP_HOST = "test-app.iamreal.tw";
const APP = `https://${APP_HOST}`;
const SITE = "https://test.iamreal.tw";

/**
 * The SHA-256 of the production app's two signing keys Google made, as Play
 * Console's App signing page shows them (#528): the key in use, the classic
 * one, and the earlier one. Both are listed until a phone shows which one the
 * app is signed with (#534). The test app is not in Play Console yet (#479).
 */
const PRODUCTION_APP_KEYS = [
  "22:D5:4D:E9:CB:EB:94:9C:B4:A1:E8:0D:B5:4D:4E:98:1D:B9:CF:5C:E2:43:C8:90:79:1F:AF:42:D9:B1:4A:7F",
  "66:06:64:3B:B7:90:85:B0:CC:DD:42:1A:AF:51:E1:59:1B:A4:54:D0:30:8E:1D:DC:B9:BA:59:70:A9:44:94:9B",
];

/** The Apple team ID (#528). */
const TEAM = "Z59T4S2753";

let worker: TestWorker;
let clearedOn: string;
before(async () => {
  worker = await startWorker();
  clearedOn = "2026-11-07";
  await worker.setSettings({ TEST_PROOF_LOG_CLEARED_ON: clearedOn });
});
after(async () => {
  await worker.close();
});

const get = (url: string, init: RequestInit = {}): Promise<Response> => worker.fetch(url, { redirect: "manual", ...init });

/** The headers the Worker set, without the ones the local workerd adds or that say how the body is sent. */
function ownHeaders(res: Response): Record<string, string> {
  const transport = new Set(["content-length", "transfer-encoding", "mf-content-encoding", "content-encoding", "connection", "date", "vary", "etag", "cf-cache-status"]);
  const got: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (!transport.has(name)) got[name] = value;
  });
  return got;
}

describe("the two files on the app domain", () => {
  test("/.well-known/assetlinks.json lets the production app handle every address, with both of its signing keys; no other app", async () => {
    const res = await get(`${APP}/.well-known/assetlinks.json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "tw.iamreal.app", sha256_cert_fingerprints: PRODUCTION_APP_KEYS },
      },
    ]);
  });

  test("/.well-known/apple-app-site-association lets the production app and the test app open every path, not the development build", async () => {
    const res = await get(`${APP}/.well-known/apple-app-site-association`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { applinks: { details: [{ appIDs: [`${TEAM}.tw.iamreal.app`, `${TEAM}.tw.iamreal.app.test`], components: [{ "/": "*" }] }] } });
  });

  for (const path of ["/.well-known/assetlinks.json", "/.well-known/apple-app-site-association"]) {
    test(`${path}: application/json, no redirect, nothing that keeps a fetcher out, the same for HEAD`, async () => {
      const res = await get(`${APP}${path}`, { headers: { "User-Agent": "Apple-Site-Association-Fetcher" } });
      assert.equal(res.status, 200);
      assert.deepEqual(ownHeaders(res), { "content-type": "application/json", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" });
      const body = await res.text();
      const head = await get(`${APP}${path}`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-type"), "application/json");
      assert.equal(await head.text(), "");
      // With no User-Agent at all, the same file.
      const bare = await get(`${APP}${path}`, { headers: { "User-Agent": "" } });
      assert.equal(await bare.text(), body);
    });
  }

  for (const path of ["/.well-known/", "/.well-known", "/.well-known/assetlinks.json/", "/.well-known/apple-app-site-association.json", "/.well-known/security.txt", "/.well-known/assetlinks.json/x"]) {
    test(`${path} on the app domain is 404`, async () => {
      const res = await get(`${APP}${path}`);
      assert.equal(res.status, 404);
      await res.body?.cancel();
    });
  }

  test("another method than GET and HEAD is 405", async () => {
    const res = await get(`${APP}/.well-known/assetlinks.json`, { method: "POST", body: "" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
    await res.body?.cancel();
  });
});

describe("the test site has neither file", () => {
  for (const host of [SITE, "http://localhost"]) {
    for (const path of ["/.well-known/assetlinks.json", "/.well-known/apple-app-site-association"]) {
      test(`${host}${path} is the page for what is not there, 404`, async () => {
        const res = await get(`${host}${path}`);
        assert.equal(res.status, 404);
        assert.match(await res.text(), /找不到這一頁/);
      });
    }
  }

  test("its home page is the home page, not the page for a phone without the app", async () => {
    const res = await get(`${SITE}/`);
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.ok(!page.includes("測試版 app"), "not the app domain's page");
    assert.ok(page.includes('<a class="button nav-button" href="/proof"'), "the site's navigation bar");
  });
});

describe("the page for a phone without the app", () => {
  const lines = block("app-domain.md", "測試網站");

  /** Each link of the copy file's block: its words and where it goes, in order. */
  const links = lines.flatMap((l) => [...l.matchAll(/\[\s*([^\]]*?)\s*\]\((https:\/\/[^)\s]+)\)/g)].map((m) => ({ words: m[1]!, href: m[2]! })));

  for (const path of ["/", "/anything", "/p/7K2Q9FM4XD", "/hang/7K2Q9FM4XD", "/proof-log", "/api/v1/config", "/?s=7K2Q9FM4XD&from=card", "/.well-knowns/assetlinks.json"]) {
    test(`${path}: the page of app-domain.md, word for word, 200`, async () => {
      const res = await get(`${APP}${path}`);
      assert.equal(res.status, 200);
      const page = await res.text();
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      wantLines(page, [testProofLogLine(clearedOn), ...copyLines(lines)]);
      // Nothing but the mark and those lines.
      assert.equal(squash(visibleText(page)), squash([testProofLogLine(clearedOn), ...copyLines(lines)].join("")));
    });
  }

  test("the title is its first line; it has the test log's mark above everything, noindex, the style sheet, no script, no link preview", async () => {
    const res = await get(`${APP}/`);
    const page = await res.text();
    assert.match(page, new RegExp(`<title>${lines[0]}｜島民證明</title>`));
    assert.match(page, new RegExp(`<h1 class="title">${lines[0]}</h1>`));
    assert.ok(page.indexOf(testProofLogLine(clearedOn).split("　")[0]!) < page.indexOf("<main>"), "the mark is above everything else");
    assert.ok(page.includes('<meta name="robots" content="noindex">'));
    assert.ok(page.includes('<link rel="stylesheet" href="/pages.css">'));
    assert.ok(page.includes('<link rel="icon" href="/favicon.ico">'));
    assert.doesNotMatch(page, /<\s*script/i, "no script: no counts, no device detection, no redirect");
    assert.doesNotMatch(page, /http-equiv|og:/i, "no refresh, no link preview");
    assert.deepEqual(ownHeaders(res), {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "content-security-policy": VISITOR_CSP,
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    });
  });

  test("its links are the copy file's, in order: the store's test as a button, and back to the test site", async () => {
    assert.deepEqual(
      links.map((l) => l.words),
      ["Android：加入 Google Play 測試", "回到 test.iamreal.tw"],
    );
    assert.equal(links[1]!.href, `${SITE}/`);
    const page = await (await get(`${APP}/`)).text();
    const onPage = [...page.matchAll(/<a\s([^>]*)>([^<]*)<\/a>/g)].map((m) => ({ attrs: m[1]!, words: m[2]! }));
    assert.deepEqual(
      onPage.map((a) => ({ words: a.words, href: /href="([^"]*)"/.exec(a.attrs)![1] })),
      links,
    );
    assert.deepEqual(
      onPage.map((a) => /class="([^"]*)"/.exec(a.attrs)?.[1] ?? null),
      ["button", null],
    );
  });

  test("HEAD: the same headers and no body; another method is 405", async () => {
    const head = await get(`${APP}/`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await head.text(), "");
    const post = await get(`${APP}/`, { method: "POST", body: "" });
    assert.equal(post.status, 405);
    await post.body?.cancel();
  });

  test("the proof log is asked nothing", async () => {
    await worker.seen();
    await (await get(`${APP}/p/7K2Q9FM4XD`)).text();
    await (await get(`${APP}/.well-known/assetlinks.json`)).text();
    assert.ok(!worker.logLines().some((l) => l.includes("internal_error")));
  });
});

describe("the app domain's setting, as the Worker reads it", () => {
  test("a setting that is not right: the app domain answers 500, the test site goes on", async () => {
    await worker.setSettings({ TEST_PROOF_LOG_CLEARED_ON: clearedOn, APP_DOMAIN: { host: APP_HOST, apple_team_id: TEAM, apps: [{ id: "tw.iamreal.app", android_sha256: ["22:d5"] }] } });
    try {
      for (const path of ["/", "/.well-known/assetlinks.json", "/.well-known/apple-app-site-association"]) {
        const res = await get(`${APP}${path}`);
        assert.equal(res.status, 500, path);
        await res.body?.cancel();
      }
      const site = await get(`${SITE}/faq`);
      assert.equal(site.status, 200);
      await site.body?.cancel();
    } finally {
      await worker.setSettings({ TEST_PROOF_LOG_CLEARED_ON: clearedOn });
    }
  });

  test("with no app domain set, its host is only another name of the site", async () => {
    await worker.setSettings({ TEST_PROOF_LOG_CLEARED_ON: clearedOn, APP_DOMAIN: null });
    try {
      const res = await get(`${APP}/.well-known/assetlinks.json`);
      assert.equal(res.status, 404);
      assert.match(await res.text(), /找不到這一頁/);
    } finally {
      await worker.setSettings({ TEST_PROOF_LOG_CLEARED_ON: clearedOn });
    }
  });
});

describe("the check of a deploy build", () => {
  const good = configuredAppDomains();

  test("wrangler.jsonc passes: the test environment's app domain is test-app.iamreal.tw, with the production app and the test app", () => {
    assert.deepEqual(Object.keys(good), ["test"]);
    checkAppDomains(good);
  });

  const testEnv = good.test!;
  const domain = testEnv.appDomain as { host: string; apple_team_id: string; apps: { id: string; android_sha256: string[] }[] };
  const withDomain = (appDomain: unknown): Record<string, ConfiguredAppDomain> => ({ test: { kind: "test", appDomain } });
  const withApps = (apps: unknown): Record<string, ConfiguredAppDomain> => withDomain({ ...domain, apps });
  const production = domain.apps.find((a) => a.id === "tw.iamreal.app")!;
  const testApp = domain.apps.find((a) => a.id === "tw.iamreal.app.test")!;

  const bad: [string, Record<string, ConfiguredAppDomain>][] = [
    ["no app domain", withDomain(undefined)],
    ["an app domain that is not an object", withDomain("test-app.iamreal.tw")],
    ["another host", withDomain({ ...domain, host: "app.iamreal.tw" })],
    ["a host with a path", withDomain({ ...domain, host: "test-app.iamreal.tw/" })],
    ["no team ID", withDomain({ host: domain.host, apps: domain.apps })],
    ["a team ID in lowercase", withDomain({ ...domain, apple_team_id: "z59t4s2753" })],
    ["a team ID one character short", withDomain({ ...domain, apple_team_id: "Z59T4S275" })],
    ["one app fewer: no test app", withApps([production])],
    ["one app fewer: no production app", withApps([testApp])],
    ["one app more: the development build", withApps([production, testApp, { id: "tw.iamreal.app.dev", android_sha256: [] }])],
    ["the same app twice", withApps([production, production, testApp])],
    ["another app in place of the test app", withApps([production, { ...testApp, id: "tw.iamreal.app.tests" }])],
    ["a fingerprint in lowercase", withApps([{ ...production, android_sha256: [production.android_sha256[0]!.toLowerCase()] }, testApp])],
    ["a fingerprint without the colons", withApps([{ ...production, android_sha256: [production.android_sha256[0]!.replaceAll(":", "")] }, testApp])],
    ["a fingerprint a byte short", withApps([{ ...production, android_sha256: [production.android_sha256[0]!.slice(3)] }, testApp])],
    ["a SHA-1 fingerprint", withApps([{ ...production, android_sha256: ["14:6D:E9:83:C5:73:06:50:D8:EE:B9:95:2F:34:FC:64:16:A0:83:42"] }, testApp])],
    ["the same fingerprint twice", withApps([{ ...production, android_sha256: [production.android_sha256[0]!, production.android_sha256[0]!] }, testApp])],
    ["the production app with no fingerprint", withApps([{ ...production, android_sha256: [] }, testApp])],
    ["the test app with a fingerprint before it is in Play Console (#479)", withApps([production, { ...testApp, android_sha256: [production.android_sha256[0]!] }])],
    ["fingerprints that are not a list", withApps([{ ...production, android_sha256: production.android_sha256[0] }, testApp])],
    ["an app with another key", withApps([{ ...production, sha256: production.android_sha256 }, testApp])],
    ["another key on the app domain", withDomain({ ...domain, ios: true })],
    ["an app domain on a production log's environment", { production: { kind: "production", appDomain: domain } }],
  ];
  for (const [what, configured] of bad) {
    test(`does not pass: ${what}`, () => {
      assert.throws(() => checkAppDomains(configured), assert.AssertionError);
    });
  }

  test("a production log's environment with no app domain passes, until launch day (ADR-0040)", () => {
    checkAppDomains({ ...good, production: { kind: "production", appDomain: undefined } });
  });
});

test("app-domain.md has the one section the page is made from", () => {
  assert.match(copySection("app-domain.md", "測試網站"), /test-app\.iamreal\.tw/);
});
