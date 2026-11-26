// Opens a running page (for example `pnpm local`'s) in headless Chrome, at
// the first screen (step 1, before you start), and stops there, before "read the card": the component is never
// asked anything, so this can run with a real card in the reader. Checks the
// headers, that the page is cross-origin isolated, that the proof engine
// started, that no Content-Security-Policy was violated and that the page
// connected only to its own origin.
//
// The Content-Security-Policy it expects is the one of the build at that
// address: the production proof log's site, iamreal.tw, lets the page connect
// to data.iamreal.tw; every other site is a test log's build (test.iamreal.tw,
// `pnpm local`, worker/wrangler.jsonc) and lets it connect to
// test-data.iamreal.tw (headers.ts).
//
//   node --experimental-strip-types test/e2e/smoke.ts http://localhost:8080/proof
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COPY } from "../../src/ui/copy.ts";
import { Browser } from "./cdp.ts";
import { CONTENT_SECURITY_POLICY, ISOLATION_HEADERS, OPENER_HEADERS, TEST_SITE_CONTENT_SECURITY_POLICY } from "./headers.ts";

const url = process.argv[2];
if (!url) throw new Error("usage: smoke.ts URL");
/** The production log's site (worker/src/settings.ts, SITE_HOSTS); any other is a test log's. */
const production = new URL(url).hostname === "iamreal.tw";
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-output", "smoke");
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok    " : "FAIL  "} ${what}`);
  if (!ok) failures++;
};

const browser = await Browser.launch({ dir: out });
const page = await browser.newPage();
await page.send("Page.enable");
await page.goto(url);
await page.waitFor(`document.querySelector('[data-step="before"]')`, "the first screen");
const doc = browser.responses.find((r) => r.url === url);
check(
  doc?.headers["content-security-policy"] === (production ? CONTENT_SECURITY_POLICY : TEST_SITE_CONTENT_SECURITY_POLICY),
  `Content-Security-Policy, the ${production ? "production" : "test"} log's site's`,
);
check(doc?.headers["document-isolation-policy"] === ISOLATION_HEADERS["Document-Isolation-Policy"], "Document-Isolation-Policy");
check(doc?.headers["cross-origin-opener-policy"] === OPENER_HEADERS["Cross-Origin-Opener-Policy"], "Cross-Origin-Opener-Policy");
check(await page.eval<boolean>("crossOriginIsolated"), "cross-origin isolated");
const engine = await page.waitFor<number>(`performance.getEntriesByName("iamreal:engine_engine_total")[0]?.duration`, "the engine", 60_000).catch(() => 0);
check(engine > 0, `the proof engine started (${Math.round(engine)} ms)`);
check((await page.text()).includes(COPY.before.title), "the first screen, step 1 (nothing clicked)");
const origin = new URL(url).origin;
const outside = browser.requests.filter((r) => ["page", "worker"].includes(r.targetType) && !r.url.startsWith("about:") && new URL(r.url).origin !== origin);
check(outside.length === 0, `connected only to ${origin} ${JSON.stringify(outside.map((r) => r.url).slice(0, 3))}`);
const csp = browser.logs.filter((l) => /Content Security Policy/i.test(l.text));
check(csp.length === 0, `no Content-Security-Policy violation ${JSON.stringify(csp.slice(0, 2))}`);
await browser.close();
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
