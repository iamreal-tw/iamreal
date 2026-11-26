// The whole card proof from the screen, in headless Chrome, against the back
// end: the Worker (worker/) in the local workerd, its test build, with test
// keys, a fake card behind a fake component, a fake MOICA for the mirror.
// Nothing real: no card, no PIN, no certificate, no MOICA key. No Go server
// is built or started; the one Go program here is iamreal-verify, which
// re-verifies what the Worker published.
//
//   IAMREAL_BB=/path/to/bb node --experimental-strip-types test/e2e/ui.ts
//
// 1. Makes throwaway issuer keys (G2, G3), cards and CRLs (test/fixtures/).
// 2. Starts the Worker's test build (worker-site.ts, worker/test/harness.ts)
//    with those issuer keys, a fake MOICA, the test log (its platform
//    table: test-example and threads), and the page built in mode "test"
//    (vite.config.ts) as the files of its card proof page (Static Assets).
//    A small server in front of it stands in the place of the data domain:
//    it sends the CRL archive from the Worker's bucket, read-only.
// 3. Runs a fake component (fake-component.ts) on localhost:61171, the
//    test build's component address.
// 4. Clicks through the six steps like a cardholder (real mouse events,
//    cdp.ts; design/copy/card-proof.md): one card proof handles the card's
//    whole list of accounts (ADR-0017). With one card: a first declaration
//    of one platform; card proof again with nothing changed; a correction
//    on the day of the first; 3 records today (step 4 keeps the list and
//    offers nothing but 回到開頭); a second platform added, with 上一步 back
//    and forth; a switch; one account withdrawn; the server finding 3
//    records today when the list is sent; everything withdrawn; an empty
//    list for a card that declares nothing (請至少填一個帳號); both declared
//    again; a switch the server records as a switch where the screen said a
//    correction (the card's state changed on its way: the screen tells the
//    cardholder, kind_mismatch); the third switch; a fourth refused by the
//    server's policy, which the Worker was started with for this
//    (RESTRICT_LATE_SWITCHES: switch_restricted); a platform the page does
//    not know (the config without its row): the account kept in the list as
//    it is; then the Worker restarted as it runs by default (no such
//    policy): the fourth and fifth switches recorded, step 4 saying none is
//    left and refusing another account typed anyway, and a sixth refused by
//    the record rules (switch_limit). Along the way: a submission
//    that did not get through (再試一次), one the server refused (its
//    request ID on the screen); 回到開頭 and 取消 on steps 4 and 5, then card
//    proofs again on the same page with the same proof engine; step 3's
//    上一步; the PIN's wait running out; a window the browser blocked on each
//    of the three clicks; every case that stops before the PIN is asked,
//    each written under its item (and a platform table the page cannot
//    read); a card's state it cannot read; a wrong PIN, a locked card, a PIN
//    that is not sent; 確認卡片 pressed again while the card is confirmed;
//    the preview of a profile (a new tab, nothing else); 複製連結. The
//    card's records fall on several days: the Worker's clock (its test
//    build's) and the page's (Date.now) move ahead together, and the fake
//    MOICA publishes a CRL each day, fetched by the Worker's mirror.
// 5. Has the Worker publish the proof log as it does when the date changes,
//    and re-verifies everything it wrote with iamreal-verify:
//    every record valid, the kinds those the screens showed, the card's list
//    the one step 6 showed last. Then other cards: two cards declaring the
//    same account (還有別的卡片也宣告了), an answer whose kinds cannot be read
//    (證明紀錄已經記下這次過卡), and an answer lost after the server appended the
//    record (challenge_used, then the card's state shows the list); a
//    platform table with Threads only (steps 5 and 6 name the one platform).
// 6. Checks the response headers, that the page is cross-origin isolated,
//    that no Content-Security-Policy was violated, that the page and its
//    workers connected to nothing but their own origin (the component's
//    window aside), and that the browser's storage holds the CRL numbers
//    and nothing else; that the PIN is in no field, attribute, storage or
//    global after it was used, and neither are the name, the certificates
//    and the card's signatures once a card proof was left.
// 7. Opens the production build at step 1 (nothing clicked): it knows
//    Threads only, so step 1 names the one platform.
// 8. Opens the test site's build (mode "testsite") at step 1, served by a
//    Worker as a deploy serves it: the mark of a test log above the
//    page, the test site's headers, nothing asked of MOICA's component.
//
// The browser resolves no host name but localhost and 127.0.0.1
// (--host-resolver-rules): the preview's new tab, on the platform's
// address, gets no further than its name.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { SITE_DOMAIN, cardPath, handle, presentationOf } from "../../src/platforms.ts";
import { scopeOf } from "iamreal-protocol/scope.ts";
import { shortId } from "iamreal-protocol/scoped-id.ts";
import { STORAGE_KEY_PREFIX } from "../../src/storage.ts";
import { COPY, fill } from "../../src/ui/copy.ts";
import { CERT_POLICIES, KEY_USAGE_ENCRYPTION, AUTHORITY_KEY_ID, SUBJECT_KEY_ID, buildTbs, certificate, name, subjectDirectoryAttributes } from "../fixtures/certs.ts";
import { makeCrl } from "../fixtures/crls.ts";
import { type TestKey, hex, makeKey } from "../fixtures/der-build.ts";
import { randomSerials, testIssuerKeys } from "../fixtures/world.ts";
import { Browser, Page, sleep } from "./cdp.ts";
import { FakeComponent, type FakeCardSpec } from "./fake-component.ts";
import { CONTENT_SECURITY_POLICY, ISOLATION_HEADERS, OPENER_HEADERS, TEST_SITE_CONTENT_SECURITY_POLICY } from "./headers.ts";
import { startWorkerSite } from "./worker-site.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "..");
const repo = join(web, "..");
const out = join(web, "test-output", "ui");
const BB = process.env.IAMREAL_BB;
if (!BB) throw new Error("set IAMREAL_BB to the bb 6.0.0 executable (verifier/README.md)");
/** The test build's component address (a port other than the real component's 61161). */
const COMPONENT_PORT = 61171;
const COMPONENT = `http://localhost:${COMPONENT_PORT}`;
const PIN = "834271";
/** The test log's scope string: the first signature signs it (protocol/src/scope.ts). */
const SCOPE = scopeOf("test");
/** The test log's platform table, as the server's config sends it (spec/scope.md). */
const EXAMPLE = "test-example";
const EXAMPLE_NAME = "Example (no real service)";
const THREADS = "threads";
const THREADS_NAME = "Threads";
/**
 * The test build's wait for the second signature (the page's is 5 minutes,
 * test/flow.test.ts): long enough for every case here, short enough to wait out.
 */
const IDLE_MS = 25_000;

let failures = 0;
const check = (ok: boolean, what: string): boolean => {
  console.log(`${ok ? "ok    " : "FAIL  "} ${what}`);
  if (!ok) failures++;
  return ok;
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Keys, cards, CRLs ---------------------------------------------------------

const issuerKeys = await testIssuerKeys();
const issuers = [
  { name: "G2" as const, modulus: issuerKeys.G2.modulus.toString(16), bits: 2048 as const },
  { name: "G3" as const, modulus: issuerKeys.G3.modulus.toString(16), bits: 4096 as const },
];
// For iamreal-verify (-test-issuers): the keys the CRLs and the cards' certificates are signed by.
const issuersDir = join(out, "issuers");
mkdirSync(issuersDir);
for (const n of ["G2", "G3"] as const) writeFileSync(join(issuersDir, `issuer-${n}.der`), issuerKeys[n].spki);

const yymmdd = (d: Date) => d.toISOString().slice(2, 10).replace(/-/g, "");
const taiwanDate = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
/**
 * The test's clock, the Worker's and the page's together, runs `day` whole
 * days ahead of the machine's (setDay below): a card has at most 3 valid
 * records a day (spec/record-rules.md, check 6), a switch counts once a day
 * (a change on the day of the last one is a correction), and this test makes
 * many with one card. Each day the fake MOICA publishes a CRL dated that day.
 */
let day = 0;
const dayOf = (n: number) => taiwanDate(Date.now() + n * 86_400_000);
const today = () => dayOf(day);
const firstDay = dayOf(0);

interface TestCard {
  spec: () => FakeCardSpec;
  serial: bigint;
}

async function makeCard(o: {
  issuer?: TestKey;
  serial: string;
  notBefore?: string;
  notAfter?: string;
  holderExtensions?: Uint8Array[];
  cardKey?: TestKey;
  tries?: number;
}): Promise<TestCard> {
  const key = o.cardKey ?? (await makeKey(2048));
  const issuer = o.issuer ?? issuerKeys.G3;
  const tbs = (serial: string, leading?: Uint8Array[]) =>
    buildTbs({ spki: key.spki, serial: hex(serial), notBefore: o.notBefore, notAfter: o.notAfter, subject: name("測試用戶"), leadingExtensions: leading, holderExtensions: o.holderExtensions });
  const signing = await certificate(tbs(o.serial), issuer);
  const encryption = await certificate(tbs("7" + o.serial.slice(1), [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION]), issuer);
  return {
    serial: BigInt("0x" + o.serial),
    spec: () => ({ certificates: [encryption, signing], signingCertificate: signing, signingKey: key.privateKey, pin: PIN, tries: o.tries ?? 3 }),
  };
}

const main = await makeCard({ serial: "1234567890abcdef1234567890abcdef" });
const revoked = await makeCard({ serial: "5555567890abcdef1234567890abcdef" });
const g2card = await makeCard({ serial: "6666567890abcdef1234567890abcdef", issuer: issuerKeys.G2 });
const expired = await makeCard({ serial: "2345567890abcdef1234567890abcdef", notAfter: "251231155959Z" });
// Valid from 16:00 UTC on a day 40 days from now: 00:00 of the next day in Taiwan.
const notYetUtc = new Date(Date.now() + 40 * 86_400_000);
const notYet = await makeCard({ serial: "3456567890abcdef1234567890abcdef", notBefore: yymmdd(notYetUtc) + "160000Z" });
const notYetTaiwan = new Date(Date.parse(notYetUtc.toISOString().slice(0, 10)) + 86_400_000).toISOString().slice(0, 10);
const foreign = await makeCard({ serial: "4567567890abcdef1234567890abcdef", holderExtensions: [CERT_POLICIES, subjectDirectoryAttributes({ subjectKind: 0x09 })] });
const bigKey = await makeCard({ serial: "5678567890abcdef1234567890abcdef", cardKey: await makeKey(4096) });
const unknownIssuer = await makeCard({ serial: "6789567890abcdef1234567890abcdef", issuer: await makeKey(2048) });
const lockable = await makeCard({ serial: "7890567890abcdef1234567890abcdef", tries: 1 });
const fresh = await makeCard({ serial: "0890567890abcdef1234567890abcdef" });

const now = Date.now();
const G3_SERIALS = [...randomSerials(20_000, 3n), revoked.serial];
/** The G3 CRL of day `n`: dated its first second in Taiwan, numbered 300 + n. */
const g3CrlOf = (n: number) => makeCrl({ issuer: issuerKeys.G3, serials: G3_SERIALS, crlNumber: BigInt(300 + n), thisUpdate: new Date(Date.parse(`${dayOf(n)}T00:00:00+08:00`)) });
const crls = {
  G3: await g3CrlOf(0),
  // G2: 5 days old (Taiwan dates), more than the 3 days the server allows.
  G2: await makeCrl({ issuer: issuerKeys.G2, serials: randomSerials(2_000, 5n), crlNumber: 200n, thisUpdate: new Date(now - 5 * 86_400_000) }),
};
/** The highest G3 CRL number published so far: what the browser remembers once it used it. */
let g3Number = 300;

// 2. The Worker and the page ------------------------------------------------------

console.log("building iamreal-verify (tag iamrealtest: it takes the test's issuer keys)");
const verifyBin = join(out, "iamreal-verify");
execFileSync("go", ["build", "-tags", "iamrealtest", "-o", verifyBin, "./cmd/iamreal-verify"], { cwd: repo, stdio: "inherit" });
const crsDir = join(out, "crs");
mkdirSync(crsDir);
// bb verify reads only the first G1 point, (1, 2) (spec/proof-verification.md, "The CRS").
const point = new Uint8Array(64);
point[31] = 1;
point[63] = 2;
writeFileSync(join(crsDir, "bn254_g1.dat"), point);

console.log("building the page (mode test)");
const dist = join(out, "dist");
await build({
  root: web,
  configFile: join(web, "vite.config.ts"),
  mode: "test",
  logLevel: "warn",
  define: {
    __IAMREAL_TEST_ISSUERS__: JSON.stringify(issuers),
    __IAMREAL_TEST_COMPONENT__: JSON.stringify(COMPONENT),
    __IAMREAL_TEST_IDLE_MS__: JSON.stringify(IDLE_MS),
  },
  build: { outDir: dist, emptyOutDir: true },
});

// Started with the policy on the fourth and fifth switch (the setting
// RESTRICT_LATE_SWITCHES, which wrangler.jsonc does not have), for the case
// that checks switch_restricted; restarted as it runs by default before the
// fourth and fifth switches are made.
console.log("starting the Worker (test build) with that page");
const site = await startWorkerSite({ proofFiles: dist, issuers, settings: { RESTRICT_LATE_SWITCHES: "true" } });
const { worker } = site;
/** Has the Worker's schedule run once: its mirror fetches what the fake MOICA serves now. */
async function mirror(): Promise<void> {
  worker.moica.serve("G2", crls.G2);
  worker.moica.serve("G3", crls.G3);
  const round = await worker.runSchedule();
  if (round.outcome !== "ok") throw new Error(`the Worker's schedule: ${round.outcome}\n${worker.logLines().join("\n")}`);
}
await site.setClockAhead(0);
await mirror();
{
  const index = new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]?.bytes ?? new Uint8Array());
  if (index.split("\n").filter(Boolean).length < 2) throw new Error(`the Worker's mirror did not fetch the two CRLs:\n${index}\n${worker.logLines().join("\n")}`);
}
const PAGE_ORIGIN = site.origin;
// The card proof page is at /proof, its files under /proof/ (vite.config.ts `base`, worker/README.md).
const PAGE = `${PAGE_ORIGIN}/proof`;

// 3. The component -------------------------------------------------------------

const component = new FakeComponent();
await component.start(COMPONENT_PORT);

// 4. The screens -------------------------------------------------------------

// No host name resolves but the test's own: a tab the page opens on another site (the preview) connects nowhere.
const browser = await Browser.launch({ dir: out, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] });
const page = await browser.newPage();
await page.send("Page.enable");
const C = COPY;
const threadsUrl = presentationOf(THREADS)!.profileUrl!;

// The windows the page opens (the component's). Each has a name of its own
// (src/card/hipki.ts), so none is reused by name: the last one must be
// closed before the next one opens. A script the test adds to every load of
// the page wraps window.open and reports, through a DevTools binding, each
// window's name and how many earlier windows were still open at that moment.
// Every call is recorded too, with its arguments: the preview's (noopener)
// gives the page no window, so it is not counted among the component's.
const windows = { opened: 0, names: new Set<string>(), badNames: [] as string[], openedWhileAnother: 0 };
const windowCalls: { url: string; name: string; features: string; opened: boolean }[] = [];
await page.send("Runtime.enable");
await page.send("Runtime.addBinding", { name: "__iamrealWindowOpened" });
await page.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const open = window.open.bind(window);
    const opened = [];
    window.open = function (url, name, features) {
      const othersOpen = opened.filter((w) => !w.closed).length;
      const w = open(url, name, features);
      if (w) opened.push(w);
      window.__iamrealWindowOpened(JSON.stringify({ url: String(url), name: String(name), features: String(features), opened: !!w, othersOpen }));
      return w;
    };
  })()`,
});
browser.on((m, p, s) => {
  if (m !== "Runtime.bindingCalled" || s !== page.sessionId || p.name !== "__iamrealWindowOpened") return;
  const r = JSON.parse(p.payload) as { url: string; name: string; features: string; opened: boolean; othersOpen: number };
  windowCalls.push({ url: r.url, name: r.name, features: r.features, opened: r.opened });
  if (!r.opened) return;
  windows.opened++;
  if (windows.names.has(r.name) || !/^iamreal-[0-9a-f]{32}$/.test(r.name)) windows.badNames.push(r.name);
  windows.names.add(r.name);
  if (r.othersOpen > 0) {
    windows.openedWhileAnother++;
    console.log(`   (a window opened while ${r.othersOpen} other(s) still open)`);
  }
});
// Tabs this page opened that cannot reach it (noopener): the preview's. The
// component's windows can (they post their reply to this page).
const previews: { targetId: string; canAccessOpener?: boolean }[] = [];
const PROFILE_ORIGIN = new URL(threadsUrl("x")).origin;
browser.on((m, p) => {
  if (m === "Target.targetCreated" && p.targetInfo.type === "page" && p.targetInfo.openerId === page.targetId && p.targetInfo.canAccessOpener === false) {
    previews.push({ targetId: p.targetInfo.targetId, canAccessOpener: p.targetInfo.canAccessOpener });
  }
});
// The page's clock: Date.now, which the engine reads (src/index.ts), runs
// `day` days ahead, in every load of the page, set before its scripts run.
// The setter changes it in a page already loaded (the card proofs on one
// page load); it is not enumerable, so the checks of what the page keeps
// (foundOnPage) see the page's own globals only.
const clockSource = (n: number) => `(() => {
  const now = Date.now.bind(Date);
  let days = ${n};
  Object.defineProperty(window, "__iamrealClockDays", { set: (d) => { days = d; } });
  Date.now = () => now() + days * 86400000;
})()`;
let clockScript = (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: clockSource(0) })).identifier as string;
/**
 * Moves the Worker's and the page's clocks to `n` days ahead, and has the
 * fake MOICA publish that day's CRL, which the Worker's mirror fetches.
 */
async function setDay(n: number): Promise<void> {
  day = n;
  await site.setClockAhead(n * 86_400_000);
  crls.G3 = await g3CrlOf(n);
  g3Number = 300 + n;
  await mirror();
  await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockScript });
  clockScript = (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: clockSource(n) })).identifier as string;
  await page.eval(`window.__iamrealClockDays = ${n}`).catch(() => undefined);
  console.log(`\n== day ${n}: ${today()}`);
}
/** Moves the page's clock alone to `days` (whole or not) ahead of the machine's; the Worker's stays. */
async function setPageClock(days: number): Promise<void> {
  await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockScript });
  clockScript = (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: clockSource(days) })).identifier as string;
  await page.eval(`window.__iamrealClockDays = ${days}`).catch(() => undefined);
}
// "複製連結" writes to the clipboard; the test reads it back.
await browser.send("Browser.grantPermissions", { origin: PAGE_ORIGIN, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
const results: Record<string, unknown> = {};

const step = (name: string) => `document.querySelector('[data-step="${name}"]')`;
const messageText = () => page.text("[data-message]");
const waitStep = (name: string, what: string, ms = 30_000) => page.waitFor(step(name), what, ms);
const whereText = () => page.text("[data-where]");
/** The href of each link on the screen. */
const linksOnScreen = () => page.eval<string[]>(`[...document.querySelectorAll('#app a')].map((a) => a.getAttribute("href"))`);
/** Steps 1 to 5 link to no other page (docs/design/principles.md, principle 1). */
async function noLinkOut(label: string): Promise<void> {
  const links = await linksOnScreen();
  check(links.length === 0, `${label}: no link to another page ${JSON.stringify(links)}`);
}
const stepLine = (n: number) => fill(C.common.step, { step: n, steps: 6 });

/** Step 1's two links, in the question on how to get a card: a map's search, MOICA's site; each in a new tab, nothing else (card-proof.md, step 1). */
const STEP1_LINKS = [
  [C.before.find_office, "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent("戶政事務所")],
  [C.before.how_to_get_moica, "https://moica.nat.gov.tw/"],
];
async function step1Links(label: string, p: Page = page): Promise<void> {
  const links = await p.eval<[string, string, string][]>(`[...document.querySelectorAll('#app a')].map((a) => [a.textContent, a.getAttribute("href"), a.target + " " + a.rel + " " + !!a.closest('.asks details')])`);
  const want = STEP1_LINKS.map(([text, href]) => [text, href, "_blank noopener noreferrer true"]);
  check(JSON.stringify(links) === JSON.stringify(want), `${label}: the two links of how to get a card, in its question, in new tabs ${JSON.stringify(links)}`);
}

/** A new page load: step 1. */
async function open(): Promise<void> {
  await page.goto(PAGE);
  await waitStep("before", "step 1");
}

const componentCount = (func?: string) => component.requests.filter((r) => func === undefined || r.func === func).length;
const popupCount = () => new Set(browser.requests.filter((r) => r.url.startsWith(COMPONENT + "/popupForm")).map((r) => r.sessionId)).size;
const cardStateCount = () => browser.requests.filter((r) => r.url.endsWith("/api/v1/card-state")).length;
const challengeCount = () => browser.requests.filter((r) => r.url.endsWith("/api/v1/challenges")).length;
/** How many records the proof log has: the Worker has no route that says it between publications, so the test build's door is asked. */
const recordCount = async (): Promise<number> => (await worker.proofLog.stored()).proofLog.count;
/** Whether the Worker answered a request with that error code and that request ID (worker-site.ts). */
const refused = (error: string, requestId?: string): boolean => site.refusals.some((r) => r.error === error && (requestId === undefined || r.requestId === requestId));

/** Buttons on the screen: text and whether they can be pressed. */
const buttons = () => page.eval<{ text: string; disabled: boolean }[]>(`[...document.querySelectorAll('main button')].map((b) => ({ text: b.textContent, disabled: b.disabled }))`);
const buttonTexts = async () => (await buttons()).map((b) => b.text);

/**
 * Clicks the button from a script, with no user activation: the browser's
 * popup blocker blocks the component's window, as it does when a site is not
 * allowed to open windows. Waits first until the activation of the last real
 * click has expired.
 */
async function blockedClick(text: string, label: string, o: { pinCleared?: boolean } = {}): Promise<void> {
  await page.waitFor(`!navigator.userActivation.isActive || null`, "the last click's activation to expire", 15_000);
  const requests = componentCount();
  const popups = popupCount();
  const signs = componentCount("MakeSignature");
  await page.eval(`[...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(text)}).click()`);
  const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText || null`, `${label}: the message`, 10_000).catch(() => "");
  check(m === C.common.popup_blocked, `${label}: a blocked window says "${m}"`);
  await sleep(500);
  check(componentCount() === requests && popupCount() === popups && componentCount("MakeSignature") === signs, `${label}: nothing reached the component`);
  // On step 3 the PIN field is emptied by the click, as always: the button waits for the PIN again.
  check((await buttons()).some((b) => b.text === text && b.disabled === !!o.pinCleared), `${label}: the same button ${o.pinCleared ? "is there, waiting for the PIN" : "can be pressed again"}`);
}

interface Item {
  item: string;
  state: string;
  st: string;
  why: string;
  label: string;
}
const items = (list: "read" | "progress") =>
  page.eval<Item[]>(
    `[...document.querySelectorAll('[data-list="${list}"] [data-item]')].map((li) => ({ item: li.dataset.item, state: li.dataset.state, st: li.querySelector(".st").innerText, label: li.querySelector(".label").innerText, why: li.querySelector("[data-why]")?.innerText ?? "" }))`,
  );
const READ_KEYS = ["component", "reader", "certificate", "check", "server", "crl"];

/** Records each state of step 2's list as it changes, in the page. */
async function watchList(): Promise<void> {
  await page.eval(`(() => {
    window.__lists = [];
    if (window.__listObserver) window.__listObserver.disconnect();
    window.__listObserver = new MutationObserver(() => {
      const l = document.querySelector('[data-list="read"]');
      if (!l) return;
      const s = [...l.querySelectorAll('[data-item]')].map((li) => li.dataset.state || "-").join(",");
      if (window.__lists.at(-1) !== s) window.__lists.push(s);
    });
    window.__listObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  })()`);
}

/**
 * Step 2: presses 讀取卡片 (or 再讀一次卡片), and resolves when every item is
 * done (下一步 appears), or with the reason under the item where it stopped,
 * or the message of a blocked window.
 */
async function readCard(label = C.read.read_card): Promise<{ done: boolean; item: string; why: string; message: string }> {
  await watchList();
  await page.clickButton(label);
  return page.waitFor<{ done: boolean; item: string; why: string; message: string }>(
    `(() => {
      const m = document.querySelector('[data-message]')?.innerText;
      if (m) return { done: false, item: "", why: "", message: m };
      const halt = document.querySelector('[data-list="read"] [data-state="halt"]');
      if (halt) return { done: false, item: halt.dataset.item, why: halt.querySelector('[data-why]')?.innerText ?? "", message: "" };
      const next = [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.common.next)});
      if (next && !next.disabled && document.querySelector('[data-step="read"]')) return { done: true, item: "", why: "", message: "" };
      return null;
    })()`,
    "step 2's list to end",
    30_000,
  );
}

/** The states step 2's list went through, each "state,state,…" ("-" for none). */
const listsSeen = () => page.eval<string[]>(`window.__lists ?? []`);

/** Every state the list showed: done items on top, then at most one in progress, then nothing. */
function listInOrder(seen: string[]): boolean {
  return seen.every((s) => {
    const st = s.split(",");
    let i = 0;
    while (i < st.length && st[i] === "done") i++;
    if (i < st.length && st[i] === "now") i++;
    while (i < st.length && st[i] === "-") i++;
    return i === st.length;
  });
}

async function confirmPin(pin: string): Promise<void> {
  await page.type("#pin", pin);
  await page.clickButton(C.pin.confirm_card);
}

/** Which of `values` the page keeps anywhere: a field, the HTML, the URL, storage, a global. */
async function foundOnPage(values: string[]): Promise<string[]> {
  return page.eval<string[]>(`(() => {
    const values = ${JSON.stringify(values)};
    const fields = [...document.querySelectorAll('input')].map((f) => f.value).join("\\n");
    let kept = [document.documentElement.outerHTML, document.body.innerText, location.href, fields];
    for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) kept.push(s.key(i) + s.getItem(s.key(i)));
    for (const k of Object.keys(window)) { try { kept.push(String(window[k])); } catch {} }
    return values.filter((v) => kept.some((t) => t.includes(v)));
  })()`);
}

/** Nothing of the PIN anywhere the page keeps things. */
async function pinGone(): Promise<boolean> {
  return (await page.eval<boolean>(`(() => { const f = document.querySelector('#pin'); return !f || f.value === ""; })()`)) && (await foundOnPage([PIN])).length === 0;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/**
 * After a card proof was left (cancel, the wait ran out, back to the
 * beginning, step 3's back): its PIN, the name, the certificates and the
 * card's signatures are nowhere on the page.
 */
async function lastCardProofGone(label: string, card: TestCard): Promise<void> {
  const spec = card.spec();
  const values: Record<string, string> = { PIN: PIN, name: "測試用戶" };
  for (const [i, c] of spec.certificates.entries()) values[`certificate ${i}`] = b64(c);
  for (const [i, s] of component.signatures.slice(-2).entries()) values[`signature ${i}`] = s;
  const found = await foundOnPage(Object.values(values));
  const names = Object.entries(values).filter(([, v]) => found.includes(v)).map(([k]) => k);
  check(names.length === 0 && (await pinGone()), `${label}: the PIN, the name, the certificates and the signatures are nowhere on the page${names.length ? ` (found: ${names.join(", ")})` : ""}`);
}

/** One row of step 4 as the screen shows it. */
interface RowSeen {
  platform: string;
  name: string;
  /** The field's value; null for a row without a field. */
  value: string | null;
  fixed: boolean;
  /** The account shown in a row without a field. */
  account: string;
  lines: string[];
  preview: boolean;
  why: string;
}

interface AccountsSeen {
  state: string;
  /** Which screen of step 4: fill (rows to fill), declared (what the card declares, and the actions), edit (修改帳號清單), switch (改成別的帳號). */
  mode: string;
  /** With the card declaring accounts: [the platform's name, or "" with one platform; the account]. */
  current: [string, string][];
  /** The line of the last card proof, under what the card declares; "" if none. */
  last: string;
  /** The h1 of step 4. */
  title: string;
  lead: string[];
  rows: RowSeen[];
  buttons: string[];
  main: string;
  /** The href of each link on the screen. */
  links: string[];
}

const rowsOnScreen = () =>
  page.eval<RowSeen[]>(`[...document.querySelectorAll('[data-row]')].map((r) => ({
    platform: r.dataset.row,
    name: r.querySelector('.plat-name').innerText,
    value: r.querySelector('input')?.value ?? null,
    fixed: r.hasAttribute('data-fixed'),
    account: r.querySelector('[data-row-account]')?.innerText ?? "",
    lines: [...r.querySelectorAll('[data-row-line]')].map((e) => e.innerText),
    preview: !!r.querySelector('button.pv'),
    why: r.querySelector('[data-row-message]')?.innerText ?? "",
  }))`);

async function waitAccounts(): Promise<AccountsSeen> {
  await waitStep("accounts", "step 4");
  return {
    state: await page.eval<string>(`document.querySelector('[data-step="accounts"]').dataset.state`),
    mode: await page.eval<string>(`document.querySelector('[data-step="accounts"]').dataset.mode`),
    current: await page.eval<[string, string][]>(`[...document.querySelectorAll('[data-current-row]')].map((r) => [r.querySelector('.plat-name')?.innerText ?? "", r.querySelector('[data-current-account]').innerText])`),
    last: await page.text("[data-last]"),
    title: await page.text(`[data-step="accounts"] h1`),
    lead: await page.eval<string[]>(`[...document.querySelectorAll('[data-status], [data-fact]')].map((e) => e.innerText)`),
    rows: await rowsOnScreen(),
    buttons: await buttonTexts(),
    main: await page.text(),
    links: await linksOnScreen(),
  };
}

/** One row of step 5: the platform's name and ID, the account, what happens. */
interface ConfirmRowSeen {
  platform: string;
  name: string;
  id: string;
  account: string;
  kinds: string[];
}

interface ConfirmSeen {
  intro: string;
  rows: ConfirmRowSeen[];
  buttons: string[];
  main: string;
  listedTogether: boolean;
  /** The points under the list. */
  points: string[];
  /** The words in bold ink in the points. */
  heed: string[];
  withdrawStays: boolean;
  links: string[];
}

async function waitConfirm(): Promise<ConfirmSeen> {
  await waitStep("confirm", "step 5");
  return {
    intro: await page.text("[data-intro]"),
    rows: await page.eval<ConfirmRowSeen[]>(`[...document.querySelectorAll('dt[data-confirm-row]')].map((dt) => {
      const dd = document.querySelector('dd[data-confirm-row="' + dt.dataset.confirmRow + '"]');
      return {
        platform: dt.dataset.confirmRow,
        name: dt.firstChild.textContent.trim(),
        id: dt.querySelector('[data-platform-id]').innerText,
        account: dd.querySelector('[data-account]').innerText,
        kinds: [...dd.querySelectorAll('[data-kind]')].map((e) => e.innerText),
      };
    })`),
    buttons: await buttonTexts(),
    main: await page.text(),
    listedTogether: await page.eval<boolean>(`!!document.querySelector('[data-step="confirm"] [data-listed-together]')`),
    points: await page.eval<string[]>(`[...document.querySelectorAll('[data-points] li')].map((e) => e.innerText)`),
    heed: await page.eval<string[]>(`[...document.querySelectorAll('[data-points] strong.heed')].map((e) => e.innerText)`),
    withdrawStays: await page.eval<boolean>(`!!document.querySelector('[data-withdraw-stays]')`),
    links: await linksOnScreen(),
  };
}

/** 修改帳號清單 (the card declares accounts, more than one platform): the rows, each changed on its own. */
async function openEdit(): Promise<AccountsSeen> {
  await page.clickButton(C.accounts.edit_list);
  await page.waitFor(`document.querySelector('[data-step="accounts"][data-mode="edit"]')`, "修改帳號清單", 10_000);
  return waitAccounts();
}

/**
 * Types the rows of step 4 (`entries`: platform → what to type, "" to empty
 * it) and presses 下一步. With the card declaring accounts, 修改帳號清單 first.
 */
async function typeRows(entries: Record<string, string>): Promise<void> {
  if (!(await page.eval<boolean>(`!!document.querySelector('[data-account-field]')`))) await openEdit();
  for (const [platform, typed] of Object.entries(entries)) {
    await page.eval(`document.querySelector('#account-${platform}').value = ""`);
    if (typed !== "") await page.type(`#account-${platform}`, typed);
  }
  await page.clickButton(C.common.next);
}

/** Step 6, or where step 5 stopped: the reason under its item, or the message of step 5. */
async function waitDoneOrMessage(): Promise<{ done: boolean; main: string; message: string; item: string }> {
  const r = await page.waitFor<string>(
    `document.querySelector('[data-step="done"]') ? "done" : (document.querySelector('[data-why]')?.innerText || document.querySelector('[data-message]')?.innerText ? "message" : null)`,
    "done or a message",
    120_000,
  );
  const halted = await page.eval<string>(`document.querySelector('[data-list="progress"] [data-state="halt"]')?.dataset.item ?? ""`);
  const message = (await page.text("[data-why]")) || (await messageText());
  return { done: r === "done", main: await page.text(), message, item: halted };
}

const screens = join(out, "screens");
mkdirSync(screens);
/** The whole page, as tall as it is. */
async function screenshot(name: string, p: Page = page): Promise<void> {
  // No scroll bar: the page as wide as the window (design/screens/: 1280px on a desktop). The mouse off every button.
  await p.send("Emulation.setScrollbarsHidden", { hidden: true });
  await p.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0 });
  const m = await p.send("Page.getLayoutMetrics");
  const h = Math.ceil(m.cssContentSize?.height ?? m.contentSize.height);
  const w = Math.ceil(m.cssLayoutViewport?.clientWidth ?? 1100);
  const { data } = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  writeFileSync(join(screens, `${name}.png`), Buffer.from(data, "base64"));
}

/** Answers a same-origin request of the page with other bytes, or fails it. */
async function intercept(pattern: string, act: (p: any) => Promise<unknown>, stage: "Request" | "Response" = "Request"): Promise<() => Promise<void>> {
  await page.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: stage }] });
  const off = browser.on((m, p, s) => {
    if (m === "Fetch.requestPaused" && s === page.sessionId) act(p).catch((e) => console.log(`   (intercepting ${p.request?.url}: ${e.message})`));
  });
  return async () => {
    off();
    await page.send("Fetch.disable");
  };
}

/**
 * Changes the server's JSON answers on `pattern` on their way to the page
 * (a server that reports something else than its proof log holds, or an answer
 * the page cannot read). `seen` gets each answer as the server sent it.
 */
async function rewrite(pattern: string, f: (body: any) => any, seen: unknown[] = []): Promise<() => Promise<void>> {
  return intercept(
    pattern,
    async (p) => {
      const r = await page.send("Fetch.getResponseBody", { requestId: p.requestId });
      const body = JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString() : r.body);
      seen.push(JSON.parse(JSON.stringify(body)));
      const changed = f(body) ?? body;
      await page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: p.responseHeaders, body: Buffer.from(JSON.stringify(changed)).toString("base64") });
    },
    "Response",
  );
}

const tryStep = async (label: string, f: () => Promise<void>) => {
  console.log(`\n== ${label}`);
  try {
    await f();
  } catch (e) {
    check(false, `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    // What the screen showed and what the Worker last refused, to tell a stop of the page from a slow computer.
    const screen = await page.text().catch(() => "(the page does not answer)");
    console.log(`   (the screen: ${JSON.stringify(screen.slice(0, 600))}; the Worker's last refusals: ${JSON.stringify(site.refusals.slice(-3))})`);
  }
};

/** The short IDs step 6 showed (from its link), each card proof done. */
const shown: string[] = [];
/** How many times step 6 was checked: one for each card proof done. */
let doneScreens = 0;

/** From step 1 (after a page load, 取消, 回到開頭 or the wait running out) to step 2. */
async function toRead(o: { screenshots?: string } = {}): Promise<void> {
  await waitStep("before", "step 1");
  const s1 = await page.text();
  for (const s of [C.before.title, C.before.duration, C.before.prepare_card, C.before.citizens_only, C.before.one_proof, C.before.listed_together, C.before.why_physical, C.before.how_to_get]) check(s1.includes(s), `step 1 says "${s}"`);
  check(s1.indexOf(C.before.duration) < s1.indexOf(C.before.prepare_card), "step 1: how long it takes, first");
  await step1Links("step 1");
  // The test build knows two platforms (test-example and threads): step 1 does not speak of one.
  check((await page.text("[data-one-proof]")) === C.before.one_proof, `step 1: the test build knows more than one platform: "${await page.text("[data-one-proof]")}"`);
  check(!(await page.eval<boolean>(`!!document.querySelector('[data-step="before"] details [data-listed-together]')`)), "step 1: that the accounts are listed together is not in a question to open");
  check((await whereText()).includes(stepLine(1)), `step 1: "${await whereText()}"`);
  check((await page.text("header b")) === C.common.service_name && (await page.text("header [data-site]")) === C.common.site_name, `the header: the mark, "${C.common.service_name}" and the site, as the visitor pages write them`);
  check((await page.eval<number>(`document.querySelectorAll("header a").length`)) === 0, "the header links nowhere: the card proof's screens send no one elsewhere");
  check(!s1.includes(C.app.use_reader) && !s1.includes(C.app.use_phone), "step 1: no choice of device before the app is out");
  check(JSON.stringify(await buttonTexts()) === JSON.stringify([C.common.next]), `step 1: no 上一步 (the first screen), only 下一步 ${JSON.stringify(await buttonTexts())}`);
  check(!(await page.eval<boolean>(`!!document.querySelector('#pin') || !!document.querySelector('[data-account-field]')`)), "step 1: no PIN field, no account field");
  if (o.screenshots) {
    await page.eval(`document.querySelectorAll('details').forEach((d) => (d.open = true))`);
    await screenshot(`${o.screenshots}-1-before`);
    await page.eval(`document.querySelectorAll('details').forEach((d) => (d.open = false))`);
  }
  await page.clickButton(C.common.next);
  await waitStep("read", "step 2");
  check((await whereText()).includes(stepLine(2)), "step 2: 第 2 步，共 6 步");
  const list = await items("read");
  check(JSON.stringify(list.map((i) => i.item)) === JSON.stringify(READ_KEYS) && list.every((i) => i.state === "" && i.st === ""), `step 2: the six items, none started ${JSON.stringify(list.map((i) => i.state))}`);
  if (o.screenshots) await screenshot(`${o.screenshots}-2-read`);
}

/** Steps 1 to 3, up to step 4. */
async function toAccounts(o: { wrongPinFirst?: boolean; blockClicks?: boolean; screenshots?: string; samePage?: boolean } = {}): Promise<AccountsSeen> {
  // samePage: step 1 is on the screen already (after 取消, 回到開頭 or the wait); no new page load.
  if (!o.samePage) await open();
  await toRead(o);
  if (o.blockClicks) await blockedClick(C.read.read_card, "blocked window, reading the card");
  const signsBefore = componentCount("MakeSignature");
  const cardStates = cardStateCount();
  const r = await readCard();
  check(r.done, `the card was read; every item done ${r.item} ${r.why} ${r.message}`);
  const list = await items("read");
  check(list.every((i) => i.state === "done" && i.st === C.common.done), `step 2: every item 完成 ${JSON.stringify(list.map((i) => i.st))}`);
  const seen = await listsSeen();
  check(seen.length > 2 && listInOrder(seen), `step 2: top to bottom, one at a time ${JSON.stringify(seen)}`);
  check(componentCount("MakeSignature") === signsBefore && cardStateCount() === cardStates, "nothing was signed or asked before the PIN");
  check(!(await page.text()).includes("測試用戶"), "step 2 does not show the name");
  await noLinkOut("step 2, read");
  if (o.screenshots) await screenshot(`${o.screenshots}-2-read-done`);
  await page.clickButton(C.common.next);
  await waitStep("pin", "step 3");
  check((await whereText()).includes(stepLine(3)), "step 3: 第 3 步，共 6 步");
  const s3 = await page.text();
  check((await page.text("[data-card-read]")) === [C.pin.card_read, "測試用戶", C.pin.name_note].join("\n"), `step 3: the name, and that it stays here: ${JSON.stringify(await page.text("[data-card-read]"))}`);
  for (const s of [C.pin.purpose, C.pin.stays]) check(s3.includes(s), `step 3, next to the PIN field: "${s}"`);
  await noLinkOut("step 3");
  if (o.screenshots) await screenshot(`${o.screenshots}-3-pin`);
  if (o.wrongPinFirst) {
    await confirmPin("000000");
    const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the wrong PIN's message");
    check(m === C.pin.pin_incorrect, `wrong PIN: "${m}"`);
    check(await pinGone(), "wrong PIN: the field is empty");
    check(await page.eval<boolean>(`document.querySelector('#pin')?.disabled === false`), "wrong PIN: the field can be typed in again");
    if (o.screenshots) await screenshot(`${o.screenshots}-3-pin-wrong`);
    await sleep(1500);
    check(componentCount("MakeSignature") === signsBefore + 1, "wrong PIN: sent once, not again by itself");
    check((await buttons()).find((b) => b.text === C.pin.confirm_card)?.disabled === true, "wrong PIN: the button waits for a new PIN");
  }
  if (o.blockClicks) {
    // The PIN is typed without a click (a click would give the page a user activation).
    await page.eval(`document.querySelector('#pin').focus()`);
    await page.send("Input.insertText", { text: PIN });
    await blockedClick(C.pin.confirm_card, "blocked window, confirming the card", { pinCleared: true });
    check(await pinGone(), "blocked window: the PIN field is empty, the PIN nowhere");
    check(await page.eval<boolean>(`document.querySelector('#pin') !== null`), "blocked window: still step 3");
  }
  const signs = componentCount("MakeSignature");
  await watchWorking();
  await confirmPin(PIN);
  const st = await waitAccounts();
  check((await whereText()).includes(stepLine(4)), "step 4: 第 4 步，共 6 步");
  check(await pinGone(), "after the first signature, the PIN is nowhere on the page");
  check(!st.main.includes("測試用戶") && !(await page.eval<boolean>(`document.documentElement.outerHTML.includes("測試用戶")`)), "the name is gone after step 3");
  check(componentCount("MakeSignature") === signs + 1, "the first signature");
  const lastSign = component.requests.filter((x) => x.func === "MakeSignature").at(-1)!;
  check(lastSign.tbs === SCOPE && lastSign.pin === PIN, `the first signature: the test log's public scope string (${lastSign.tbs}), with the PIN`);
  check((await workingSeen()).includes(C.pin.signing), `step 3 said, after 確認卡片, "${C.pin.signing}"`);
  check(!st.main.includes(C.accounts.need_one), "step 4: no message before anything is pressed");
  if (o.screenshots) await screenshot(`${o.screenshots}-4-accounts`);
  return st;
}

/** The status line of step 3 ([data-working]) as it appears, recorded in the page. */
async function watchWorking(): Promise<void> {
  await page.eval(`(() => {
    if (!window.__workingObserver) {
      window.__workingObserver = new MutationObserver(() => {
        const t = document.querySelector('[data-working]')?.textContent;
        if (t && window.__working.at(-1) !== t) window.__working.push(t);
      });
      window.__workingObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
    }
    window.__working = [];
  })()`);
}
const workingSeen = () => page.eval<string[]>(`window.__working ?? []`);

/** A row of step 4 as expected: the name, the account (a field's value, or a fixed row's text), the lines. */
type RowExpected = [name: string, account: string, lines: string[], o?: { fixed?: boolean; preview?: boolean }];

function checkRows(label: string, rows: RowSeen[], want: Record<string, RowExpected>): void {
  check(JSON.stringify(rows.map((r) => r.platform)) === JSON.stringify(Object.keys(want)), `${label}: one row per platform, in order ${JSON.stringify(rows.map((r) => r.platform))}`);
  for (const r of rows) {
    const w = want[r.platform];
    if (!w) continue;
    const [name, account, lines, o] = w;
    const got = o?.fixed ? r.account : r.value;
    check(
      r.name === name && got === account && JSON.stringify(r.lines) === JSON.stringify(lines) && r.fixed === !!o?.fixed && r.preview === (o?.preview ?? (!o?.fixed && r.platform === THREADS)),
      `${label}: the row ${r.platform}: ${JSON.stringify([r.name, got, r.lines, r.fixed, r.preview])}`,
    );
  }
}

/** Step 4 with rows to fill (more than one platform), by the card's state: the notes below the list. */
function checkAccountsNotes(label: string, st: AccountsSeen, kind: "never" | "nothing"): void {
  const has = (s: string) => st.main.includes(s);
  const a = C.accounts;
  check(st.state === kind && st.mode === "fill", `${label}: step 4 is "${st.state}", "${st.mode}"`);
  check(st.title === a.title, `${label}: step 4's title "${st.title}"`);
  check(has(a.preview_note) && has(a.switches_limited), `${label}: step 4, the preview, that switches are limited`);
  check(has(a.how_change) === (kind === "nothing") && has(a.one_per_platform) === (kind === "never"), `${label}: how to change the list`);
  check(!has("還有平台沒填"), `${label}: no nudge to fill every platform`);
  check(st.links.length === 0, `${label}: step 4 links to no other page ${JSON.stringify(st.links)}`);
  check(JSON.stringify(st.buttons.filter((b) => b !== C.accounts.preview)) === JSON.stringify([C.common.next, C.common.cancel]), `${label}: step 4 buttons ${JSON.stringify(st.buttons)}`);
}

/** The line of the last card proof on step 4. */
const lastLine = (daysAgo: number) => (daysAgo === 0 ? C.accounts.last_proof_today : fill(C.accounts.last_proof, { days_ago: daysAgo }));

/**
 * Step 4 with the card declaring accounts: what it declares ([name, account]; the name "" with one
 * platform), the last card proof, 更新島民證明 and the other actions: with one platform 改成別的帳號 and
 * 收回對 @… 的宣告, with more 修改帳號清單.
 */
function checkDeclared(label: string, st: AccountsSeen, current: [string, string][], daysAgo: number): void {
  const a = C.accounts;
  const single = current.every(([name]) => name === "");
  check(st.state === "declared" && st.mode === "declared", `${label}: step 4 is "${st.state}", "${st.mode}"`);
  check(JSON.stringify(st.lead) === JSON.stringify([a.declared_now]) && JSON.stringify(st.current) === JSON.stringify(current), `${label}: step 4, what the card declares ${JSON.stringify(st.current)}`);
  check(st.last === lastLine(daysAgo), `${label}: step 4, "${st.last}"`);
  check(st.main.includes(a.refresh_note), `${label}: step 4, what 更新島民證明 does`);
  const others = single ? [a.switch, fill(a.withdraw, { account: current[0]![1] })] : [a.edit_list];
  check(JSON.stringify(st.buttons) === JSON.stringify([a.refresh, ...others, C.common.cancel]), `${label}: step 4 buttons ${JSON.stringify(st.buttons)}`);
  check(!st.main.includes(a.switches_limited) && !st.main.includes(a.switch_limit.split("，")[0]!), `${label}: step 4 does not speak of the switches' limit before 改成別的帳號`);
  check(st.links.length === 0, `${label}: step 4 links to no other page ${JSON.stringify(st.links)}`);
  check(st.rows.every((r) => r.value === null), `${label}: no field before an action is chosen`);
}

/**
 * Step 5: the whole list to be signed, each row's platform name and ID and what happens; the points; the buttons.
 * `single`: the one platform's name, when the screens speak of one platform. `platforms`: the names the points
 * give (the one, or each the page knows of the server's table).
 */
function checkConfirm(label: string, c: ConfirmSeen, want: [platform: string, name: string, account: string, kinds: string[]][], button: string, single: string | null = null, platforms: string[] = single !== null ? [single] : [EXAMPLE_NAME, THREADS_NAME]): void {
  const f = C.confirm;
  const rows = c.rows.map((r) => [r.platform, r.name, r.account, r.kinds]);
  check(JSON.stringify(rows) === JSON.stringify(want), `${label}: step 5's list ${JSON.stringify(rows)}`);
  check(c.rows.every((r) => r.id === r.platform), `${label}: step 5 shows each platform's ID beside its name`);
  check(c.links.length === 0, `${label}: step 5 links to no other page ${JSON.stringify(c.links)}`);
  const empty = want.every((r) => r[3].includes(C.kinds.withdraw));
  check(c.intro === (empty ? f.intro_withdraw_all : single !== null ? f.intro_public : f.intro), `${label}: step 5's first sentence "${c.intro}"`);
  check(c.main.includes(today()) && c.main.includes(f.short_id_label), `${label}: step 5, the date, the short ID`);
  const named = platforms.join(f.platform_separator);
  const notIdentifiable = fill(f.not_identifiable, { platform: named });
  const points = empty ? [f.history_stays, notIdentifiable, f.holder_later_withdraw] : [notIdentifiable, fill(f.holder_later, { platform: named, cannot_delete: f.cannot_delete })];
  check(JSON.stringify(c.points) === JSON.stringify(points), `${label}: step 5's points ${JSON.stringify(c.points)}`);
  check(JSON.stringify(c.heed) === JSON.stringify(empty ? [] : [f.cannot_delete]), `${label}: step 5, "${f.cannot_delete}" in bold ${JSON.stringify(c.heed)}`);
  check(c.listedTogether === (!empty && single === null), `${label}: step 5 ${!empty && single === null ? "says" : "does not say"} the accounts are listed together`);
  check(c.withdrawStays === (!empty && single === null && want.some((r) => r[3].includes(C.kinds.withdraw))), `${label}: step 5, that a withdrawn account's records stay`);
  check(JSON.stringify(c.buttons) === JSON.stringify([C.common.back, button, C.common.cancel]), `${label}: step 5 buttons ${JSON.stringify(c.buttons)}`);
}

interface DoneSeen {
  title: string;
  /** The small card's rows: [the platform's name, or "" where the screens speak of one platform; the account]. */
  card: [string, string][];
  link: string;
  /** What the QR code holds; "" if there is none. */
  qr: string;
  /** Where 打開你的島民證明 goes; "" if it is not there. */
  openProof: string;
  /** Under the heading of the last step: done.anyone or done.anyone_single; "" if none. */
  anyone: string;
  /** The links to the accounts' profiles: [text, href]. */
  profiles: [string, string][];
  /** The buttons that share the card's page: [text, href]. */
  shares: [string, string][];
  /** What else can be done is there. */
  optional: boolean;
  record: [string, string, string[], boolean, string][];
  /** The section of what the proof log recorded is there. */
  recordShown: boolean;
  newCard: boolean;
  withdrawnLink: boolean;
  otherCards: string[];
  kindsUnreadable: boolean;
  main: string;
  /** The card's ordinal as its page on the server writes it (the number of 第 N 張島民證明); "" when the link names no card. */
  pageOrdinal: string;
}

const doneSeen = async (): Promise<DoneSeen> => ({
  ...(await page.eval<Omit<DoneSeen, "main">>(`({
    title: document.querySelector('[data-step="done"] h1').innerText,
    card: [...document.querySelectorAll('[data-proof] [data-card-row]')].map((r) => [r.querySelector('[data-card-platform]')?.innerText ?? "", r.querySelector('[data-card-account]').innerText]),
    link: document.querySelector('[data-link]')?.innerText ?? "",
    qr: document.querySelector('[data-qr]')?.dataset.qr ?? "",
    openProof: document.querySelector('[data-open-proof]')?.getAttribute("href") ?? "",
    anyone: document.querySelector('[data-anyone]')?.innerText ?? "",
    profiles: [...document.querySelectorAll('a[data-profile]')].map((a) => [a.innerText, a.getAttribute("href")]),
    shares: [...document.querySelectorAll('a[data-share]')].map((a) => [a.innerText, a.getAttribute("href")]),
    optional: !!document.querySelector('[data-optional]'),
    record: [...document.querySelectorAll('dt[data-done-row]')].map((dt) => {
      const dd = dt.nextElementSibling;
      return [dt.innerText, dd.querySelector('.acct').innerText, [...dd.querySelectorAll('[data-kind]')].map((e) => e.innerText), dd.hasAttribute('data-mismatch'), dd.querySelector('[data-code]')?.innerText ?? ""];
    }),
    recordShown: !!document.querySelector('[data-record]'),
    newCard: !!document.querySelector('[data-new-card]'),
    withdrawnLink: !!document.querySelector('[data-withdrawn-link]'),
    otherCards: [...document.querySelectorAll('[data-other-cards]')].map((e) => e.innerText),
    kindsUnreadable: !!document.querySelector('[data-kinds-unreadable]'),
  })`)),
  main: await page.text(),
  pageOrdinal: await pageOrdinal(),
});

/** The ordinal the card's page on the server writes, for the card whose link step 6 shows: the proof log's, not the answer's. */
async function pageOrdinal(): Promise<string> {
  const link = await page.eval<string>(`document.querySelector('[data-link]')?.innerText ?? ""`);
  const sid = /^(?:test\.)?iamreal\.tw\/p\/([0-9A-Z]{10})$/.exec(link)?.[1];
  if (sid === undefined) return "";
  const html = await (await worker.fetch(`/${cardPath(sid)}`)).text();
  return /<p class="ordinal">第 ([0-9,]+) 張島民證明<\/p>/.exec(html)?.[1] ?? "";
}

interface DoneExpected {
  label: string;
  title: string;
  /** The card's list after the record: [name, account]; empty when everything was withdrawn. */
  card: [string, string][];
  /**
   * The record's rows: [name, account, kind sentences]; null when the
   * answer's kinds could not be read. The screen shows them only where they
   * differ from what step 5 said (`mismatch`); elsewhere, that they do not
   * differ is what is checked.
   */
  record: [string, string, string[]][] | null;
  newCard?: boolean;
  withdrawnLink?: boolean;
  otherCards?: string[];
  /** Platforms whose recorded kind is not what step 5 said: the code kind_mismatch under them. */
  mismatch?: string[];
  /** The one platform's name, when the screens speak of one platform. */
  single?: string;
  /** The page has no ordinal to share: the answer was not read, or the record was found in the card's state. */
  unnumbered?: boolean;
}

function checkDone(o: DoneExpected, d: DoneSeen | null, message = ""): void {
  if (!check(d !== null, `${o.label}: done ${message}`)) return;
  const v = d!;
  check(v.title === o.title, `${o.label}: step 6's title "${v.title}"`);
  const withdrawAll = o.card.length === 0;
  // With one platform, the small card names no platform.
  const card = o.single ? o.card.map(([, account]) => ["", account]) : o.card;
  check(JSON.stringify(v.card) === JSON.stringify(card), `${o.label}: the card lists ${JSON.stringify(v.card)}`);
  const sid = /^(?:test\.)?iamreal\.tw\/p\/([0-9A-Z]{10})$/.exec(v.link)?.[1] ?? (/島民編號開頭是 ([0-9A-Z]{10})。/.exec(v.main)?.[1] ?? "");
  check(withdrawAll ? v.link === "" : v.link === `${SITE_DOMAIN}/${cardPath(sid)}`, `${o.label}: the link is the card's page ${v.link}`);
  check(v.main.includes(fill(C.done.recorded_on, { date: today() }) + C.done.unplug), `${o.label}: step 6, the day it was recorded, unplug`);
  // Hanging it on the profile, and what else can be done: when the list is not empty.
  const hangTitle = o.single ? fill(C.done.hang_title_single, { platform: o.single }) : C.done.hang_title;
  const anyone = withdrawAll ? "" : o.single ? C.done.anyone_single : C.done.anyone;
  check(v.main.includes(hangTitle) === !withdrawAll && v.anyone === anyone, `${o.label}: the last step ${withdrawAll ? "is not there" : "is there"}: "${v.anyone}"`);
  check(v.qr === (withdrawAll ? "" : `https://${SITE_DOMAIN}/hang/${sid}`), `${o.label}: the QR code holds the card's page to hang it from ${v.qr}`);
  check(v.openProof === (withdrawAll ? "" : `/${cardPath(sid)}`), `${o.label}: 打開你的島民證明 goes to the card's page on this site ${v.openProof}`);
  const profiles = withdrawAll ? [] : o.card.filter(([name]) => name === THREADS_NAME).map(([, account]) => [fill(C.done.open_profile, { account, platform: THREADS_NAME }), `https://www.threads.com/${account}`]);
  check(JSON.stringify(v.profiles) === JSON.stringify(profiles), `${o.label}: the links to the profiles ${JSON.stringify(v.profiles)}`);
  // The text suggested: the card's ordinal, the one its page writes; without one, the sentence without a number.
  if (!withdrawAll && !o.unnumbered) check(/^[1-9][0-9,]*$/.test(v.pageOrdinal), `${o.label}: the card's page writes its ordinal "${v.pageOrdinal}"`);
  const sentence = o.unnumbered ? C.done.share_text_unnumbered : fill(C.done.share_text, { ordinal: v.pageOrdinal });
  const text = `${sentence}\nhttps://${SITE_DOMAIN}/${cardPath(sid)}`;
  const shares = withdrawAll ? [] : [[fill(C.done.share, { platform: THREADS_NAME }), `https://www.threads.com/intent/post?text=${encodeURIComponent(text)}`]];
  check(JSON.stringify(v.shares) === JSON.stringify(shares), `${o.label}: sharing to Threads, the text${o.unnumbered ? " without a number" : " with the card's ordinal"} and the card's page ${JSON.stringify(v.shares)}`);
  check(v.optional === !withdrawAll && v.main.includes(C.done.return_note) === !withdrawAll, `${o.label}: what else can be done ${withdrawAll ? "is not there" : "is there"}`);
  const mismatch = o.mismatch ?? [];
  check(v.main.includes(C.done.mismatch) === mismatch.length > 0 && v.recordShown === mismatch.length > 0, `${o.label}: what the proof log recorded ${mismatch.length ? "is shown, it differs" : "is not shown: it is what step 5 said"}`);
  if (o.record === null) {
    check(v.kindsUnreadable && v.record.length === 0, `${o.label}: the kinds could not be read: that sentence`);
  } else if (mismatch.length > 0) {
    const rows = v.record.map((r) => [r[0], r[1], r[2]]);
    check(JSON.stringify(rows) === JSON.stringify(o.record), `${o.label}: the record's rows ${JSON.stringify(rows)}`);
    const recordLine = withdrawAll ? C.done.record_withdraw_all : o.single ? C.done.record_single : C.done.record_list;
    check(v.main.includes(recordLine), `${o.label}: the record's line "${recordLine}"`);
    const differs = v.record.filter((r) => r[3]).map((r) => r[0]);
    const want = mismatch.map((p) => (p === THREADS ? THREADS_NAME : p === EXAMPLE ? EXAMPLE_NAME : p));
    check(JSON.stringify(differs) === JSON.stringify(want) && v.record.every((r) => r[4] === (r[3] ? "kind_mismatch" : "")), `${o.label}: what the server recorded and what step 5 said differ on ${want.join(", ")} (kind_mismatch)`);
    const sidLine = fill(C.done.short_id, { short_id: sid });
    check(v.main.includes(sidLine), `${o.label}: ${sidLine}`);
  } else {
    check(!v.kindsUnreadable, `${o.label}: the kinds were read`);
  }
  check(v.newCard === !!o.newCard, `${o.label}: ${o.newCard ? "says" : "does not say"} a new card has a new link`);
  check(v.withdrawnLink === !!o.withdrawnLink, `${o.label}: ${o.withdrawnLink ? "says" : "does not say"} the withdrawn account's link can go`);
  const others = (o.otherCards ?? []).map((a) => fill(C.done.other_cards, { account: a }));
  check(JSON.stringify(v.otherCards) === JSON.stringify(others), `${o.label}: other cards ${JSON.stringify(v.otherCards)}`);
  check(!/[✓✔]/.test(v.main), `${o.label}: step 6, no check mark`);
  const lines = v.main.split("\n").filter(Boolean);
  check(lines.at(-1) === C.done.restart, `${o.label}: step 6 ends with the button "${lines.at(-1)}"`);
  doneScreens++;
  // Everything withdrawn: no link, and no short ID on the screen unless what was recorded differs.
  if (sid) shown.push(sid);
}

/** From step 5: the last click, in progress, step 6. */
async function finish(o: DoneExpected & { button: string; dropFirstSubmission?: boolean; blockClick?: boolean; screenshots?: string; submissions?: Record<string, unknown>[] }): Promise<void> {
  if (o.blockClick) await blockedClick(o.button, "blocked window, the second signature");
  // The request bodies of the submission, as the page sent them.
  const undoCapture = o.submissions
    ? await intercept("*/api/v1/records", async (p) => {
        o.submissions!.push(JSON.parse(p.request.postData));
        await page.send("Fetch.continueRequest", { requestId: p.requestId });
      })
    : null;
  const signs = componentCount("MakeSignature");
  const before = await recordCount();
  if (o.dropFirstSubmission) {
    let dropped = false;
    const undo = await intercept("*/api/v1/records", async (p) => {
      if (!dropped) {
        dropped = true;
        await page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" });
      } else await page.send("Fetch.continueRequest", { requestId: p.requestId });
    });
    try {
      await page.clickButton(o.button);
      const d1 = await waitDoneOrMessage();
      check(d1.item === "submit" && d1.message === C.stops.submit_failed, `a submission that did not get through, under 送出: "${d1.message}" (${d1.item})`);
      check(JSON.stringify(await buttonTexts()) === JSON.stringify([C.read.read_again, C.progress.retry]), `stopped at 送出 (the PIN dropped after the second signature): 再讀一次卡片 and 再試一次: ${JSON.stringify(await buttonTexts())}`);
      if (o.screenshots) await screenshot(`${o.screenshots}-5-submit-failed`);
      await page.clickButton(C.progress.retry);
      const d = await waitDoneOrMessage();
      checkDone(o, d.done ? await doneSeen() : null, d.message);
    } finally {
      await undo();
    }
  } else {
    await page.clickButton(o.button);
    await waitStep("progress", "in progress");
    check((await whereText()).includes(stepLine(5)), "in progress: still 第 5 步，共 6 步");
    check((await page.text()).includes(C.progress.keep_open), "in progress: keep the page open");
    const labels = (await items("progress")).map((i) => i.label);
    check(labels[2] === C.progress.compute, `in progress: computing, what it makes and how long "${labels[2]}"`);
    await page.waitFor<boolean>(`document.querySelector('[data-item="compute"]')?.dataset.state === "now" || !!document.querySelector('[data-step="done"]') || null`, "computing", 120_000);
    await noLinkOut("in progress");
    const threadsUsed = Number(await page.waitFor<string>(`document.querySelector('[data-list="progress"]')?.dataset.threads`, "the engine's threads", 30_000).catch(() => "0"));
    check(threadsUsed > 1, `in progress: a multithreaded proof (${threadsUsed} threads)`);
    if (o.screenshots) await screenshot(`${o.screenshots}-5-progress`);
    const d = await waitDoneOrMessage();
    checkDone(o, d.done ? await doneSeen() : null, d.message);
  }
  await undoCapture?.();
  check((await recordCount()) === before + 1, "one record appended");
  if (o.screenshots) {
    await sleep(1500); // the mark's animation, played out
    await screenshot(`${o.screenshots}-6-done`);
  }
  check(componentCount("MakeSignature") === signs + 1, "the second signature, once");
  const sign2 = component.requests.filter((x) => x.func === "MakeSignature").at(-1)!;
  check(/^D[0-9A-Z]{30}$/.test(sign2.tbs ?? "") && sign2.pin === PIN, "the second signature: a declaration code, with the PIN");
  check(await pinGone(), "after the second signature, the PIN is nowhere on the page");
  const timings = await page.eval<[string, number][]>(`performance.getEntriesByType("measure").map((e) => [e.name, Math.round(e.duration)])`);
  results[o.label] = { timings };
}

/** Step 1 again, on the same page, with no sentence; nothing of the last card proof on the page. */
async function backAtTheBeginning(label: string, card: TestCard = main): Promise<void> {
  await waitStep("before", `${label}: step 1`);
  check((await messageText()) === "", `${label}: step 1, with no message`);
  await lastCardProofGone(label, card);
}

const K = C.kinds;
const A = C.accounts;
const at = (u: string) => handle(THREADS, u);
const count = (used: number) =>
  used === 0
    ? fill(A.row_no_switches_yet, { switches_left: 5 })
    : used < 5
      ? fill(A.row_switches, { switches_used: used, switches_left: 5 - used })
      : fill(A.row_used_up, { switches_used: used });

component.card = main.spec();

// Day 0 -----------------------------------------------------------------------------

await tryStep("a first declaration of one platform (a wrong PIN first; a blocked window on each click; an empty list; the formats; the preview)", async () => {
  const st = await toAccounts({ wrongPinFirst: true, blockClicks: true, screenshots: "first" });
  check(JSON.stringify(st.lead) === JSON.stringify([A.none_yet, A.fill_one]), `step 4: ${JSON.stringify(st.lead)}`);
  checkAccountsNotes("first", st, "never");
  checkRows("first", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "", [A.row_unused]], [THREADS]: [THREADS_NAME, "", [A.row_unused]] });
  check(st.buttons.filter((b) => b === A.preview).length === 1, "預覽個人檔案 on the Threads row only (no public page for the other)");
  // Nothing typed: the list is empty and the card declares nothing.
  const signs = componentCount();
  await page.clickButton(C.common.next);
  check((await messageText()) === A.need_one && (await page.eval<boolean>(`!!${step("accounts")}`)), `下一步 with no account: "${await messageText()}"`);
  await screenshot("first-4-accounts-need-one");
  // The preview: a name not in the format opens nothing; a good one opens the profile in a new tab.
  const tabs = previews.length;
  await page.type(`#account-${THREADS}`, "al ice");
  await page.clickButton(A.preview);
  await sleep(500);
  const why = (await rowsOnScreen()).find((r) => r.platform === THREADS)!.why;
  check(why === COPY.formats.threads && previews.length === tabs, `preview of an account not in the format: the hint under the row, nothing opened ("${why}")`);
  await screenshot("first-4-accounts-format");
  await page.eval(`document.querySelector('#account-${THREADS}').value = ""`);
  await page.type(`#account-${THREADS}`, "@Alice");
  const requests = browser.requests.length;
  const calls = windowCalls.length;
  await page.clickButton(A.preview);
  for (let i = 0; i < 100 && previews.length === tabs; i++) await sleep(50);
  // The new tab itself does not load under this test's DevTools (it holds every new tab; a
  // noopener tab is not let go even for a local address, tried), so the call is what is checked.
  const call = windowCalls.slice(calls);
  check(
    JSON.stringify(call) === JSON.stringify([{ url: threadsUrl("alice"), name: "_blank", features: "noopener,noreferrer", opened: false }]),
    `the preview: window.open of the profile's page, a new tab, noopener and noreferrer ${JSON.stringify(call)}`,
  );
  check(previews.length === tabs + 1, `the preview opened a tab that cannot reach this page (${previews.length - tabs} tab)`);
  check((await page.eval<boolean>(`!!${step("accounts")}`)) && (await rowsOnScreen()).every((r) => r.why === ""), "the preview: this page stays on step 4, no message");
  const ownRequests = browser.requests.slice(requests).filter((r) => r.sessionId === page.sessionId);
  check(ownRequests.every((r) => new URL(r.url).origin === PAGE_ORIGIN), `the preview: this page itself requested nothing elsewhere ${JSON.stringify(ownRequests.map((r) => r.url))}`);
  for (const p of previews) await browser.send("Target.closeTarget", { targetId: p.targetId }).catch(() => undefined);
  await page.send("Page.bringToFront");
  // A platform the copy has no format hint for: the code, under its row.
  await typeRows({ [EXAMPLE]: "A_B", [THREADS]: "alice" });
  const ex = (await rowsOnScreen()).find((r) => r.platform === EXAMPLE)!.why;
  check(ex === A.format_no_hint && (await page.eval<boolean>(`!!${step("accounts")}`)), `an account not in the format of a platform with no hint in the copy: the general sentence under its row ("${ex}")`);
  await screenshot("first-4-accounts-format-no-hint");
  check(componentCount() === signs && challengeCount() === 0, "step 4's messages: nothing signed, no challenge");
  await typeRows({ [EXAMPLE]: "", [THREADS]: "alice" });
  const c = await waitConfirm();
  check((await whereText()).includes(stepLine(5)), "step 5: 第 5 步，共 6 步");
  checkConfirm("first", c, [[THREADS, THREADS_NAME, at("alice"), [K.first]]], C.confirm.button_declare);
  await screenshot("first-5-confirm");
  await finish({
    label: "first",
    button: C.confirm.button_declare,
    title: C.done.first,
    card: [[THREADS_NAME, at("alice")]],
    record: [[THREADS_NAME, at("alice"), [K.first]]],
    newCard: true,
    blockClick: true,
    screenshots: "first",
  });
  // 複製連結: the whole https:// address of the card's page, to the clipboard.
  await page.clickButton(C.done.copy);
  await page.waitFor(`[...document.querySelectorAll('main button')].some((b) => b.textContent === ${JSON.stringify(C.done.copied)}) || null`, "已複製", 5_000).catch(() => undefined);
  const clip = await page.eval<string>(`navigator.clipboard.readText()`).catch((e) => `(${e.message})`);
  check(clip === `https://${SITE_DOMAIN}/${cardPath(shown.at(-1) ?? "")}`, `複製連結 copied ${clip}`);
  check((await buttons()).some((b) => b.text === C.done.copied), "the button says 已複製");
  // Every link of the screen opens a new tab: leaving the page would end it.
  const hrefs = await page.eval<string[]>(`[...document.querySelectorAll('main a')].map((a) => a.target + " " + a.rel)`);
  check(hrefs.length >= 3 && hrefs.every((h) => h === "_blank noopener noreferrer"), `step 6: every link opens a new tab ${JSON.stringify(hrefs)}`);
  check(await page.eval<boolean>(`!!document.querySelector('[data-step="done"] [data-proof] svg.logo-animated')`), "step 6: the mark's animation, on the small card");
  // The QR code is drawn on the page from what it holds, and nothing is asked of another origin for it.
  check(await page.eval<boolean>(`!!document.querySelector('[data-qr] svg path.qr-dark')?.getAttribute("d")`), "step 6: the QR code is an SVG drawn on the page");
});

// The page's headers and isolation, read from the first load.
{
  const doc = browser.responses.find((r) => r.url === PAGE);
  check(doc?.headers["content-security-policy"] === TEST_SITE_CONTENT_SECURITY_POLICY && readFileSync(join(web, "README.md"), "utf8").includes(TEST_SITE_CONTENT_SECURITY_POLICY), `the page's Content-Security-Policy: ${doc?.headers["content-security-policy"]}`);
  check(doc?.headers["document-isolation-policy"] === ISOLATION_HEADERS["Document-Isolation-Policy"], `the page's Document-Isolation-Policy: ${doc?.headers["document-isolation-policy"]}`);
  check(doc?.headers["cross-origin-opener-policy"] === OPENER_HEADERS["Cross-Origin-Opener-Policy"], `the page's Cross-Origin-Opener-Policy: ${doc?.headers["cross-origin-opener-policy"]}`);
  check(await page.eval<boolean>("crossOriginIsolated"), `the page on ${PAGE_ORIGIN} is cross-origin isolated`);
  const api = browser.responses.find((r) => r.url.endsWith("/api/v1/card-state"));
  check(/^[0-9a-f]{16}$/.test(api?.headers["x-request-id"] ?? ""), `an API response carries X-Request-Id ${api?.headers["x-request-id"]}`);
}

await tryStep("card proof again, nothing changed (the first submission dropped, then 再試一次)", async () => {
  // The server's table names the platforms otherwise: the screen writes the page's own names (src/platforms.ts).
  const seenConfig: any[] = [];
  const undoConfig = await rewrite("*/api/v1/config", (b) => void b.platforms.forEach((r: Record<string, string>) => (r.display_name = "Not " + r.display_name)), seenConfig);
  let st: AccountsSeen;
  try {
    st = await toAccounts({ screenshots: "refresh" });
  } finally {
    await undoConfig();
  }
  check(seenConfig.length === 1 && !st.main.includes("Not "), "the server's display names are not shown; the page's own are");
  checkDeclared("refresh", st, [[THREADS_NAME, at("alice")]], 0);
  // 修改帳號清單: each row with its counts, how to change the list; 不改了 goes back.
  const edit = await openEdit();
  check(edit.state === "declared" && JSON.stringify(edit.lead) === JSON.stringify([A.current]), `修改帳號清單: ${edit.state} ${JSON.stringify(edit.lead)}`);
  checkRows("refresh", edit.rows, { [EXAMPLE]: [EXAMPLE_NAME, "", [A.row_unused]], [THREADS]: [THREADS_NAME, "alice", [count(0), A.row_today]] });
  check(edit.main.includes(A.how_change) && edit.main.includes(A.preview_note), "修改帳號清單: how to change the list, the preview");
  check(JSON.stringify(edit.buttons.filter((b) => b !== A.preview)) === JSON.stringify([C.common.next, A.keep, C.common.cancel]), `修改帳號清單: the buttons ${JSON.stringify(edit.buttons)}`);
  await screenshot("refresh-4-accounts-edit");
  await page.clickButton(A.keep);
  checkDeclared("refresh, 不改了", await waitAccounts(), [[THREADS_NAME, at("alice")]], 0);
  // 更新島民證明: the list as it is, nothing typed.
  await page.clickButton(A.refresh);
  checkConfirm("refresh", await waitConfirm(), [[THREADS, THREADS_NAME, at("alice"), [K.unchanged]]], C.confirm.button_refresh);
  await screenshot("refresh-5-confirm");
  await finish({
    label: "refresh",
    button: C.confirm.button_refresh,
    title: C.done.refresh,
    card: [[THREADS_NAME, at("alice")]],
    record: [[THREADS_NAME, at("alice"), [K.unchanged]]],
    dropFirstSubmission: true,
    screenshots: "refresh",
  });
});

await tryStep("a correction on the day of the first declaration (@alice to @alicia: not a switch)", async () => {
  await toAccounts();
  await typeRows({ [THREADS]: "alicia" });
  const c = await waitConfirm();
  checkConfirm("correction", c, [[THREADS, THREADS_NAME, at("alicia"), [fill(K.switch, { previous: at("alice") }), C.confirm.switch_not_counted]]], C.confirm.button_declare);
  await screenshot("correction-5-confirm");
  await finish({
    label: "correction",
    button: C.confirm.button_declare,
    title: C.done.changed,
    card: [[THREADS_NAME, at("alicia")]],
    record: [[THREADS_NAME, at("alicia"), [fill(K.switch, { previous: at("alice") })]]],
    screenshots: "correction",
  });
});

await tryStep("3 records today: step 4 keeps the list, says so, and offers only 回到開頭", async () => {
  const st = await toAccounts();
  check(st.state === "daily_limit" && st.mode === "declared" && JSON.stringify(st.lead) === JSON.stringify([A.declared_now]) && st.last === lastLine(0), `step 4: ${st.state} ${JSON.stringify(st.lead)} ${st.last}`);
  check(JSON.stringify(st.current) === JSON.stringify([[THREADS_NAME, at("alicia")]]), `3 records today: what the card declares ${JSON.stringify(st.current)}`);
  check((await page.text("[data-daily-limit]")) === C.stops.daily_limit, "step 4: the sentence of 3 records today");
  check(JSON.stringify(st.buttons) === JSON.stringify([A.restart]), `step 4: only 回到開頭 ${JSON.stringify(st.buttons)}`);
  check(!(await page.eval<boolean>(`!!document.querySelector('[data-account-field]')`)), "no field to type in");
  await screenshot("daily-limit-4-accounts");
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await page.clickButton(A.restart);
  await backAtTheBeginning("回到開頭 on step 4, 3 records today");
  await sleep(500);
  check(componentCount("MakeSignature") === signs && challengeCount() === challenges, "3 records today: no second signature, no challenge");
});

// Day 1 -----------------------------------------------------------------------------

await setDay(1);

await tryStep("a second platform added, with 上一步 back and forth", async () => {
  const st = await toAccounts();
  checkDeclared("add", st, [[THREADS_NAME, at("alicia")]], 1);
  checkRows("add", (await openEdit()).rows, { [EXAMPLE]: [EXAMPLE_NAME, "", [A.row_unused]], [THREADS]: [THREADS_NAME, "alicia", [count(0)]] });
  const signs = componentCount();
  const states = cardStateCount();
  const challenges = challengeCount();
  await typeRows({ [EXAMPLE]: "a-b" });
  const want: [string, string, string, string[]][] = [
    [EXAMPLE, EXAMPLE_NAME, "a-b", [K.first]],
    [THREADS, THREADS_NAME, at("alicia"), [K.unchanged]],
  ];
  checkConfirm("add", await waitConfirm(), want, C.confirm.button_declare);
  await screenshot("add-5-confirm");
  await page.clickButton(C.common.back);
  const again = await waitAccounts();
  check(again.rows.find((r) => r.platform === EXAMPLE)?.value === "a-b" && again.rows.find((r) => r.platform === THREADS)?.value === "alicia", "上一步: step 4 with the rows as they were typed");
  await page.clickButton(C.common.next);
  checkConfirm("add, again", await waitConfirm(), want, C.confirm.button_declare);
  check(componentCount() === signs && cardStateCount() === states && challengeCount() === challenges, "back and forth: no signature, no card-state, no challenge");
  await finish({
    label: "add",
    button: C.confirm.button_declare,
    title: C.done.changed,
    card: [
      [EXAMPLE_NAME, "a-b"],
      [THREADS_NAME, at("alicia")],
    ],
    record: [
      [EXAMPLE_NAME, "a-b", [K.first]],
      [THREADS_NAME, at("alicia"), [K.unchanged]],
    ],
    screenshots: "add",
  });
});

await tryStep("a switch on Threads (@alicia to @bob)", async () => {
  await toAccounts();
  await typeRows({ [THREADS]: "bob" });
  checkConfirm(
    "switch",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS, THREADS_NAME, at("bob"), [fill(K.switch, { previous: at("alicia") }), fill(C.confirm.uses_switch, { switches_left: 4 })]],
    ],
    C.confirm.button_declare,
  );
  await screenshot("switch-5-confirm");
  await finish({
    label: "switch",
    button: C.confirm.button_declare,
    title: C.done.changed,
    card: [
      [EXAMPLE_NAME, "a-b"],
      [THREADS_NAME, at("bob")],
    ],
    record: [
      [EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS_NAME, at("bob"), [fill(K.switch, { previous: at("alicia") })]],
    ],
    screenshots: "switch",
  });
});

await tryStep("one account withdrawn (the test-example row emptied)", async () => {
  const st = await toAccounts({ screenshots: "withdraw-one" });
  checkRows("withdraw one", (await openEdit()).rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0), A.row_today]], [THREADS]: [THREADS_NAME, "bob", [count(1), A.row_today]] });
  await typeRows({ [EXAMPLE]: "" });
  checkConfirm(
    "withdraw one",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.withdraw]],
      [THREADS, THREADS_NAME, at("bob"), [K.unchanged]],
    ],
    C.confirm.button_declare,
  );
  await screenshot("withdraw-one-5-confirm");
  await finish({
    label: "withdraw one",
    button: C.confirm.button_declare,
    title: C.done.changed,
    card: [[THREADS_NAME, at("bob")]],
    record: [
      [EXAMPLE_NAME, "a-b", [K.withdraw]],
      [THREADS_NAME, at("bob"), [K.unchanged]],
    ],
    withdrawnLink: true,
    screenshots: "withdraw-one",
  });
});

// The card's state says 2 records today (the answer changed on its way); the
// server finds the third already there when the list is sent.
await tryStep("the server finds 3 records today when the list is sent (daily_limit)", async () => {
  const seen: any[] = [];
  const undo = await rewrite("*/api/v1/card-state", (b) => void (b.proofs_on_last_date = 2), seen);
  let st: AccountsSeen;
  try {
    st = await toAccounts();
  } finally {
    await undo();
  }
  check(seen.length === 1 && seen[0].proofs_on_last_date === 3, `the server's card-state said ${seen[0]?.proofs_on_last_date} record(s) today`);
  check(st.state === "declared", `step 4 with 2 records today: ${st.state}`);
  const before = await recordCount();
  await typeRows({ [EXAMPLE]: "a-b" });
  checkConfirm(
    "again",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.again]],
      [THREADS, THREADS_NAME, at("bob"), [K.unchanged]],
    ],
    C.confirm.button_declare,
  );
  const signs = componentCount("MakeSignature");
  await page.clickButton(C.confirm.button_declare);
  const d = await waitDoneOrMessage();
  const id = await page.text("[data-request-id]");
  check(!d.done && d.item === "submit" && d.message === `${C.stops.daily_limit}\n${fill(C.stops.request_id, { request_id: id })}`, `the server's daily_limit, under 送出: ${JSON.stringify(d.message)} (${d.item})`);
  const res = browser.responses.filter((r) => r.url.endsWith("/api/v1/records") && r.status === 400).at(-1);
  check(/^[0-9a-f]{16}$/.test(id) && res?.headers["x-request-id"] === id && refused("daily_limit", id), `the request ID on the screen (${id}) is the response's, and the Worker answered it daily_limit`);
  check(componentCount("MakeSignature") === signs + 1, "the second signature, once");
  check((await recordCount()) === before, "nothing was appended");
  check(JSON.stringify(await buttonTexts()) === JSON.stringify([C.read.read_again]), `stopped (the PIN dropped): 再讀一次卡片 only ${JSON.stringify(await buttonTexts())}`);
  await screenshot("daily-limit-5-server");
  // The card proof ended (the PIN was dropped): 再讀一次卡片 is step 2, reading the card in that click.
  const reads = componentCount("GetUserCert");
  await watchList();
  await page.clickButton(C.read.read_again);
  await waitStep("read", "再讀一次卡片: step 2");
  check((await whereText()).includes(stepLine(2)), "再讀一次卡片: 第 2 步");
  const r = await page.waitFor<string>(
    `(() => { const n = [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.common.next)}); return n && !n.disabled ? "read" : (document.querySelector('[data-list="read"] [data-state="halt"]') ? "stopped" : null); })()`,
    "the card read again",
    30_000,
  );
  check(r === "read" && componentCount("GetUserCert") === reads + 1, `再讀一次卡片: the card read again at once (${r})`);
  await lastCardProofGone("再讀一次卡片 after a stop", main);
});

// Day 2 -----------------------------------------------------------------------------

await setDay(2);

await tryStep("everything withdrawn", async () => {
  const st = await toAccounts();
  checkRows("withdraw all", (await openEdit()).rows, {
    [EXAMPLE]: [EXAMPLE_NAME, "", [fill(A.row_withdrawn, { last_declared: "a-b" }), count(0)]],
    [THREADS]: [THREADS_NAME, "bob", [count(1)]],
  });
  await screenshot("withdraw-all-4-accounts");
  await typeRows({ [THREADS]: "" });
  checkConfirm("withdraw all", await waitConfirm(), [[THREADS, THREADS_NAME, at("bob"), [K.withdraw]]], C.confirm.button_withdraw_all);
  await screenshot("withdraw-all-5-confirm");
  await finish({ label: "withdraw all", button: C.confirm.button_withdraw_all, title: C.done.withdraw_all, card: [], record: [[THREADS_NAME, at("bob"), [K.withdraw]]], withdrawnLink: true, screenshots: "withdraw-all" });
  const v = await doneSeen();
  check(!(await page.eval<boolean>(`!!document.querySelector('[data-step="done"] [data-proof], [data-qr]')`)) && v.link === "", "everything withdrawn: no card, no QR code, no link");
});

await tryStep("no account now: an empty list is refused; both declared again (not switches)", async () => {
  const st = await toAccounts();
  check(JSON.stringify(st.lead) === JSON.stringify([A.nothing_now, A.fill_one]), `step 4: ${JSON.stringify(st.lead)}`);
  checkAccountsNotes("nothing", st, "nothing");
  checkRows("nothing", st.rows, {
    [EXAMPLE]: [EXAMPLE_NAME, "", [fill(A.row_withdrawn, { last_declared: "a-b" }), count(0)]],
    [THREADS]: [THREADS_NAME, "", [fill(A.row_withdrawn, { last_declared: at("bob") }), count(1)]],
  });
  await page.clickButton(C.common.next);
  check((await messageText()) === A.need_one, `下一步 with an empty list, no account now: "${await messageText()}"`);
  await screenshot("nothing-4-accounts-need-one");
  await typeRows({ [EXAMPLE]: "a-b", [THREADS]: "bob" });
  checkConfirm(
    "both again",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.again]],
      [THREADS, THREADS_NAME, at("bob"), [K.again]],
    ],
    C.confirm.button_declare,
  );
  await screenshot("again-5-confirm");
  await finish({
    label: "both again",
    button: C.confirm.button_declare,
    title: C.done.changed,
    card: [
      [EXAMPLE_NAME, "a-b"],
      [THREADS_NAME, at("bob")],
    ],
    record: [
      [EXAMPLE_NAME, "a-b", [K.again]],
      [THREADS_NAME, at("bob"), [K.again]],
    ],
  });
});

// Day 3 -----------------------------------------------------------------------------

await setDay(3);

// The card's state says the Threads account was put there today (its
// correction_date changed on its way): the screen says the change is a
// correction, not counted. The proof log records a switch, and step 6 says that
// what was recorded is not what step 5 said.
await tryStep("a change the screen called a correction, recorded as a switch (the card's state wrong): kind_mismatch", async () => {
  // A state the rules can produce (the device does not read one they cannot): as if the card had switched to @bob today.
  const undo = await rewrite("*/api/v1/card-state", (b) => {
    b.platforms.threads.correction_date = today();
    b.last_card_proof = today();
    b.proofs_on_last_date = 1;
  });
  let st: AccountsSeen;
  try {
    st = await toAccounts();
  } finally {
    await undo();
  }
  checkDeclared("correction_date today", st, [[EXAMPLE_NAME, "a-b"], [THREADS_NAME, at("bob")]], 0);
  checkRows("correction_date today", (await openEdit()).rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, "bob", [count(1), A.row_today]] });
  await typeRows({ [THREADS]: "carol" });
  checkConfirm(
    "said a correction",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS, THREADS_NAME, at("carol"), [fill(K.switch, { previous: at("bob") }), C.confirm.switch_not_counted]],
    ],
    C.confirm.button_declare,
  );
  await finish({
    label: "recorded a switch",
    button: C.confirm.button_declare,
    title: C.done.changed,
    card: [
      [EXAMPLE_NAME, "a-b"],
      [THREADS_NAME, at("carol")],
    ],
    record: [
      [EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS_NAME, at("carol"), [fill(K.switch, { previous: at("bob") })]],
    ],
    mismatch: [THREADS],
    screenshots: "mismatch",
  });
  const note = await page.text("[data-mismatch-note]");
  const firstLine = (await page.text("[data-step=\"done\"]")).split("\n").filter(Boolean)[0];
  check(note === C.done.mismatch && firstLine === C.done.mismatch, `the difference, first of all, above the title: "${note}"`);
  const expected = await page.text(`dd[data-done-row="${THREADS}"] [data-expected]`);
  const used = await page.text(`dd[data-done-row="${THREADS}"] [data-switch-used]`);
  check(
    expected === fill(C.done.mismatch_expected, { expected: fill(K.switch, { previous: at("bob") }) + C.confirm.switch_not_counted }) && used === C.done.mismatch_switch_used,
    `under the row: what step 5 said ("${expected}"), and that a switch was used ("${used}")`,
  );
});

// Day 4 -----------------------------------------------------------------------------

await setDay(4);

await tryStep("the third switch (@carol to @dave): 2 left after it", async () => {
  const st = await toAccounts();
  checkRows("two switches", (await openEdit()).rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, "carol", [count(2)]] });
  await typeRows({ [THREADS]: "dave" });
  checkConfirm(
    "the third",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS, THREADS_NAME, at("dave"), [fill(K.switch, { previous: at("carol") }), fill(C.confirm.uses_switch, { switches_left: 2 })]],
    ],
    C.confirm.button_declare,
  );
  await screenshot("switch-third-5-confirm");
  await finish({
    label: "the third switch",
    button: C.confirm.button_declare,
    title: C.done.changed,
    card: [
      [EXAMPLE_NAME, "a-b"],
      [THREADS_NAME, at("dave")],
    ],
    record: [
      [EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS_NAME, at("dave"), [fill(K.switch, { previous: at("carol") })]],
    ],
  });
});

// Day 5 -----------------------------------------------------------------------------

await setDay(5);

await tryStep("3 switches: the row says 2 are left; 取消 on step 5", async () => {
  const st = await toAccounts();
  checkRows("three switches", (await openEdit()).rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, "dave", [count(3)]] });
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await typeRows({ [THREADS]: "dave" });
  await waitConfirm();
  await page.clickButton(C.common.cancel);
  await backAtTheBeginning("取消 on step 5");
  await sleep(500);
  check(componentCount("MakeSignature") === signs && challengeCount() === challenges, "取消 on step 5: no second signature, no challenge");
});

// The Worker was started with RESTRICT_LATE_SWITCHES: the page offers the
// fourth switch (the record rules allow 5), the server's policy refuses it
// (switch_restricted).
await tryStep("a fourth switch the server's policy refuses (RESTRICT_LATE_SWITCHES: switch_restricted)", async () => {
  await toAccounts({ samePage: true });
  await typeRows({ [THREADS]: "erin" });
  checkConfirm(
    "a fourth",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS, THREADS_NAME, at("erin"), [fill(K.switch, { previous: at("dave") }), fill(C.confirm.uses_switch, { switches_left: 1 })]],
    ],
    C.confirm.button_declare,
  );
  const before = await recordCount();
  await page.clickButton(C.confirm.button_declare);
  const d = await waitDoneOrMessage();
  const id = await page.text("[data-request-id]");
  check(!d.done && d.item === "submit" && d.message === `${C.stops.switch_restricted}\n${fill(C.stops.request_id, { request_id: id })}`, `switch_restricted, under 送出: ${JSON.stringify(d.message)}`);
  const res = browser.responses.filter((r) => r.url.endsWith("/api/v1/records") && r.status === 403).at(-1);
  check(res?.headers["x-request-id"] === id && refused("switch_restricted", id), `403 switch_restricted, its request ID on the screen (${id})`);
  check((await recordCount()) === before, "nothing was appended");
  check(JSON.stringify(await buttonTexts()) === JSON.stringify([C.read.read_again]), "refused: 再讀一次卡片 only");
  await screenshot("switch-restricted-5-progress");
});

// The server's config without the test-example row: a platform the page does
// not know, on which the card has an account. The row cannot be changed, and
// the account goes back into the list as it is (docs/api/card-proof.md).
await tryStep("a platform the page does not know: the account kept in the list as it is", async () => {
  const undo = await rewrite("*/api/v1/config", (b) => void (b.platforms = b.platforms.filter((p: { platform: string }) => p.platform !== EXAMPLE)));
  let st: AccountsSeen;
  try {
    st = await toAccounts();
  } finally {
    await undo();
  }
  checkRows("unknown", (await openEdit()).rows, { [EXAMPLE]: [EXAMPLE, "a-b", [A.row_unknown_platform], { fixed: true }], [THREADS]: [THREADS_NAME, "dave", [count(3)]] });
  // Threads alone on the table, and an account on a platform the page does not know: more than one.
  check(st.title === A.title, `unknown: step 4's title is that of more than one platform "${st.title}"`);
  await screenshot("unknown-4-accounts");
  await page.clickButton(C.common.next);
  checkConfirm(
    "unknown",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE, "a-b", [K.unchanged]],
      [THREADS, THREADS_NAME, at("dave"), [K.unchanged]],
    ],
    C.confirm.button_refresh,
    // The points name the platforms of the server's table the page knows: Threads alone now.
    null,
    [THREADS_NAME],
  );
  await screenshot("unknown-5-confirm");
  const submissions: Record<string, unknown>[] = [];
  await finish({
    label: "unknown kept",
    button: C.confirm.button_refresh,
    title: C.done.refresh,
    card: [
      [EXAMPLE, "a-b"],
      [THREADS_NAME, at("dave")],
    ],
    record: [
      [EXAMPLE, "a-b", [K.unchanged]],
      [THREADS_NAME, at("dave"), [K.unchanged]],
    ],
    submissions,
    screenshots: "unknown",
  });
  check(
    JSON.stringify(submissions.map((s) => s.accounts)) === JSON.stringify([[{ platform: EXAMPLE, username: "a-b" }, { platform: THREADS, username: "dave" }]]) &&
      submissions.every((s) => !("action" in s) && !("username" in s)),
    `the list sent: the kept account in its place, in byte order ${JSON.stringify(submissions.map((s) => s.accounts))}`,
  );
});

// From here to the PIN's wait running out, one page load: 回到開頭 and 取消 start the
// next card proof on the same page, with the same proof engine (ADR-0013).
const crsG1 = "/crs/bn254_g1_compressed_2p18.dat";
let samePage: { timeOrigin: number; crsFetches: number } | null = null;
const crsFetchCount = () => browser.requests.filter((r) => r.url.endsWith(crsG1)).length;

await tryStep("回到開頭, then 取消 on step 4", async () => {
  samePage = { timeOrigin: await page.eval<number>("performance.timeOrigin"), crsFetches: crsFetchCount() };
  await page.clickButton(C.done.restart);
  await backAtTheBeginning("回到開頭");
  await toAccounts({ samePage: true });
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await page.clickButton(C.common.cancel);
  await backAtTheBeginning("取消 on step 4");
  await sleep(500);
  check(componentCount("MakeSignature") === signs && challengeCount() === challenges, "取消 on step 4: no second signature, no challenge");
});

await tryStep("step 3's 上一步: step 2 again, the card read again", async () => {
  await toRead();
  check((await readCard()).done, "read");
  await page.clickButton(C.common.next);
  await waitStep("pin", "step 3");
  await page.type("#pin", PIN);
  const reads = componentCount("GetUserCert");
  const signs = componentCount("MakeSignature");
  await page.clickButton(C.common.back);
  await waitStep("read", "step 2 again");
  const list = await items("read");
  check(list.every((i) => i.state === "") && (await buttons()).some((b) => b.text === C.read.read_card && !b.disabled), "step 2 again: nothing read, 讀取卡片 can be pressed");
  await lastCardProofGone("step 3's 上一步", main);
  check((await readCard()).done, "read again");
  check(componentCount("GetUserCert") === reads + 1 && componentCount("MakeSignature") === signs, "the card read again; nothing signed");
  await page.clickButton(C.common.next);
  await waitStep("pin", "step 3 again");
  check(await pinGone(), "step 3 again: the PIN field is empty");
  // Back to step 1 for the next case: step 3's back, step 2's back.
  await page.clickButton(C.common.back);
  await waitStep("read", "step 2");
  await page.clickButton(C.common.back);
  await backAtTheBeginning("上一步 to step 1");
});

await tryStep("the PIN's wait runs out: back to step 1", async () => {
  await toAccounts({ samePage: true });
  const signs = componentCount("MakeSignature");
  await page.clickButton(A.refresh);
  await waitConfirm();
  const t0 = Date.now();
  await waitStep("before", "step 1, after the wait", IDLE_MS + 15_000);
  const waited = Date.now() - t0;
  const m = await messageText();
  check(m === C.before.idle, `back to step 1 after ${Math.round(waited / 1000)} s: "${m}"`);
  check((await whereText()).includes(stepLine(1)), "the wait ran out: 第 1 步");
  await screenshot("idle-1-before");
  check(await pinGone(), "the wait ran out: the PIN is nowhere on the page");
  await lastCardProofGone("the wait ran out", main);
  check(componentCount("MakeSignature") === signs, "no second signature");
});

await tryStep("the same page after 回到開頭, 取消 and the wait: card proof again", async () => {
  await toAccounts({ samePage: true });
  await page.clickButton(A.refresh);
  await waitConfirm();
  await finish({
    label: "refresh, same page",
    button: C.confirm.button_refresh,
    title: C.done.refresh,
    card: [
      [EXAMPLE_NAME, "a-b"],
      [THREADS_NAME, at("dave")],
    ],
    record: [
      [EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS_NAME, at("dave"), [K.unchanged]],
    ],
  });
  // One page load, one proof engine: the CRS was fetched once, the engine started once.
  const engineStarts = await page.eval<number>(`performance.getEntriesByName("iamreal:engine_engine_total").length`);
  check(
    samePage !== null && (await page.eval<number>("performance.timeOrigin")) === samePage.timeOrigin && crsFetchCount() === samePage.crsFetches && engineStarts === 1,
    `card proofs on one page load, one proof engine: CRS fetched ${crsFetchCount() - (samePage?.crsFetches ?? 0)} more times, engine started ${engineStarts} time(s)`,
  );
});

// The server as it runs by default: no policy on the fourth and fifth switch ----------

await tryStep("the Worker restarted without RESTRICT_LATE_SWITCHES (the default)", async () => {
  // The whole Worker and its Durable Object stop and start again: what they stored and the bucket's files stay,
  // the settings the test gave are gone (worker/test/harness.ts), and the clock is set again with the next request.
  const before = await recordCount();
  await worker.restart();
  const config = await (await fetch(`${PAGE_ORIGIN}/api/v1/config`)).json();
  check(Array.isArray(config.platforms) && config.platforms.length === 2 && (await recordCount()) === before, `the Worker answers again, on the same address, with the same proof log of ${before} records`);
});

/** A fourth or fifth switch, made on the web like the first three; the server records it. */
async function lateSwitch(label: string, from: string, to: string, used: number): Promise<void> {
  const st = await toAccounts();
  checkRows(label, (await openEdit()).rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, from, [count(used)]] });
  await typeRows({ [THREADS]: to });
  checkConfirm(
    label,
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS, THREADS_NAME, at(to), [fill(K.switch, { previous: at(from) }), used + 1 === 5 ? C.confirm.uses_final_switch : fill(C.confirm.uses_switch, { switches_left: 5 - used - 1 })]],
    ],
    C.confirm.button_declare,
  );
  await finish({
    label,
    button: C.confirm.button_declare,
    title: C.done.changed,
    card: [
      [EXAMPLE_NAME, "a-b"],
      [THREADS_NAME, at(to)],
    ],
    record: [
      [EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS_NAME, at(to), [fill(K.switch, { previous: at(from) })]],
    ],
  });
}

await setDay(6);
await tryStep("the fourth switch, accepted by default (@dave to @erin)", () => lateSwitch("the fourth switch", "dave", "erin", 3));
await setDay(7);
await tryStep("the fifth switch (@erin to @frank)", () => lateSwitch("the fifth switch", "erin", "frank", 4));
await setDay(8);

await tryStep("5 switches: step 4 says none is left; another account typed anyway is refused; a sixth refused by the record rules (switch_limit)", async () => {
  const st = await toAccounts();
  checkRows("five switches", (await openEdit()).rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, "frank", [count(5), A.row_can_clear]] });
  await screenshot("used-up-4-accounts");
  const requests = componentCount();
  const challenges = challengeCount();
  await typeRows({ [THREADS]: "gina" });
  const why = (await rowsOnScreen()).find((r) => r.platform === THREADS)!.why;
  check(why === A.row_cannot_switch && (await page.eval<boolean>(`!!${step("accounts")}`)), `a sixth switch: refused, the sentence under the row ("${why}")`);
  await screenshot("used-up-4-accounts-refused");
  check(componentCount() === requests && challengeCount() === challenges, "refused: nothing asked of the component, no challenge");
  await page.clickButton(C.common.cancel);
  await backAtTheBeginning("取消 after 5 switches");
  const undo = await rewrite("*/api/v1/card-state", (b) => void (b.platforms.threads.switch_count = 2));
  try {
    await toAccounts({ samePage: true });
  } finally {
    await undo();
  }
  await typeRows({ [THREADS]: "gina" });
  await waitConfirm();
  const before = await recordCount();
  await page.clickButton(C.confirm.button_declare);
  const d = await waitDoneOrMessage();
  const id = await page.text("[data-request-id]");
  check(!d.done && d.item === "submit" && d.message === `${C.stops.switch_limit}\n${fill(C.stops.request_id, { request_id: id })}`, `the record rules' switch_limit, under 送出: ${JSON.stringify(d.message)}`);
  check((await recordCount()) === before && refused("switch_limit"), "nothing appended; the Worker answered switch_limit");
  await screenshot("switch-limit-5-progress");
});

// The card's state says test-example's account was put there today (as if it had been), step 5
// says changing it is a correction; midnight passes before the button is pressed. On the new date
// the change is a switch: nothing is signed, the sentence, and 回到開頭 only.
await tryStep("the date changes while step 5 is up: not signed, stops.date_changed, 回到開頭", async () => {
  // The page's clock (only the page's) set to 23:59:47 in Taiwan of the test's day, so that midnight
  // passes for real while step 5 is up, within the PIN's wait (25 s in the test build) from the first signature.
  const target = Date.parse(`${today()}T23:59:47+08:00`);
  const midnight = target + 13_000; // 00:00:00 of the next day in Taiwan
  try {
    await setPageClock((target - Date.now()) / 86_400_000);
    const undo = await rewrite("*/api/v1/card-state", (b) => {
      b.platforms[EXAMPLE].correction_date = today();
      b.last_card_proof = today();
      b.proofs_on_last_date = 1;
    });
    try {
      await toAccounts();
    } finally {
      await undo();
    }
    await typeRows({ [EXAMPLE]: "a-c" });
    const c = await waitConfirm();
    check(JSON.stringify(c.rows[0]?.kinds) === JSON.stringify([fill(K.switch, { previous: "a-b" }), C.confirm.switch_not_counted]), `step 5 says a correction: ${JSON.stringify(c.rows[0]?.kinds)}`);
    const pageNow = await page.eval<number>("Date.now()");
    check(pageNow < midnight, `step 5 is up before midnight (${Math.round((midnight - pageNow) / 1000)} s left)`);
    await sleep(Math.max(0, midnight - pageNow) + 1000);
    const signs = componentCount("MakeSignature");
    const challenges = challengeCount();
    const before = await recordCount();
    await page.clickButton(C.confirm.button_declare);
    const d = await waitDoneOrMessage();
    check(!d.done && d.item === "server" && d.message === C.stops.date_changed, `under 連上島民證明的伺服器: "${d.message}" (${d.item})`);
    check(JSON.stringify(await buttonTexts()) === JSON.stringify([A.restart]), `回到開頭 only: ${JSON.stringify(await buttonTexts())}`);
    await screenshot("date-changed-5-progress");
    await sleep(500);
    check(componentCount("MakeSignature") === signs && challengeCount() === challenges && (await recordCount()) === before, "no second signature, no challenge, nothing recorded");
    await page.clickButton(A.restart);
    await backAtTheBeginning("回到開頭 after the date changed");
  } finally {
    // The page's clock back to the test's whole days.
    await setPageClock(day);
  }
});

// 5. Snapshot and re-verification -----------------------------------------------

/** The kinds of the main card's records, in proof log order, as the screens' step 6 showed them. */
const KINDS: [string, string][][] = [
  [[THREADS, "first"]],
  [[THREADS, "refresh"]],
  [[THREADS, "correction"]],
  [[EXAMPLE, "first"], [THREADS, "refresh"]],
  [[EXAMPLE, "refresh"], [THREADS, "switch"]],
  [[EXAMPLE, "withdraw"], [THREADS, "refresh"]],
  [[THREADS, "withdraw"]],
  [[EXAMPLE, "refresh"], [THREADS, "refresh"]],
  [[EXAMPLE, "refresh"], [THREADS, "switch"]],
  [[EXAMPLE, "refresh"], [THREADS, "switch"]],
  [[EXAMPLE, "refresh"], [THREADS, "refresh"]],
  [[EXAMPLE, "refresh"], [THREADS, "refresh"]],
  [[EXAMPLE, "refresh"], [THREADS, "switch"]],
  [[EXAMPLE, "refresh"], [THREADS, "switch"]],
];
await tryStep("the proof log published, and iamreal-verify", async () => {
  // The Worker publishes the proof log when the date changes in Taiwan (the last log file and its hash list, the
  // card state file, a line of the fingerprint file): its alarm rang by itself after the clock moved to this
  // day, on which nothing was written yet. Run here once more, so that the publication of this day is done
  // whether or not that alarm has rung already.
  await worker.proofLog.runAlarm();
  // A copy of everything the Worker wrote to its bucket, which is what the data domain serves: iamreal-verify
  // reads it as it does by default (-data), with the real proofs, and rebuilds the CRL archive from its CRLs.
  const data = join(out, "data");
  for (const f of await worker.files()) {
    mkdirSync(dirname(join(data, f.key)), { recursive: true });
    writeFileSync(join(data, f.key), f.bytes);
  }
  const v = JSON.parse(execFileSync(verifyBin, ["-bb", BB, "-crs", crsDir, "-proof-log", "test", "-json", "-test-issuers", issuersDir, "-data", data], { stdio: ["ignore", "pipe", "pipe"] }).toString());
  writeFileSync(join(out, "verify.json"), JSON.stringify(v, null, 2));
  const kinds = v.results.map((r: { valid: boolean; kinds?: { platform: string; kind: string }[] }) => (r.valid ? r.kinds!.map((k) => [k.platform, k.kind]) : null));
  check(v.valid === true && v.results.every((r: { valid: boolean }) => r.valid) && JSON.stringify(kinds) === JSON.stringify(KINDS), `iamreal-verify: valid, every record valid, the kinds the screens showed: ${JSON.stringify(kinds)}`);
  check(doneScreens === KINDS.length, `the screens showed ${doneScreens} card proofs done`);
  const scope = v.state.find((s: { scope_string: string }) => s.scope_string === SCOPE);
  const cards = scope?.cards ?? [];
  check(
    cards.length === 1 &&
      JSON.stringify(cards[0].accounts) === JSON.stringify([{ platform: EXAMPLE, username: "a-b" }, { platform: THREADS, username: "frank" }]) &&
      cards[0].last_card_proof === dayOf(7),
    `one card, its list the one step 6 showed last, last card proof ${dayOf(7)}: ${JSON.stringify(cards)}`,
  );
  check(shown.every((s) => s === shortId(cards[0]?.scoped_id ?? "")), `the short ID on the screens is the card's: ${shortId(cards[0]?.scoped_id ?? "")}`);
});

/** Step 3 with the card read; `card` is in the component. */
async function toPin(card: FakeCardSpec): Promise<void> {
  component.card = card;
  await open();
  await toRead();
  check((await readCard()).done, "read");
  await page.clickButton(C.common.next);
  await waitStep("pin", "step 3");
}

// After the PIN: a locked card, a challenge dated another day, a card's state the page cannot read.
await tryStep("a wrong PIN that locks the card", async () => {
  await toPin(lockable.spec());
  await confirmPin("000000");
  const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the message");
  check(m === C.stops.card_locked, `locked: "${m}"`);
  check(await pinGone(), "locked: the PIN is nowhere");
  const b = await buttons();
  check(b.find((x) => x.text === C.common.back)?.disabled === false && b.find((x) => x.text === C.pin.confirm_card)?.disabled === true, `locked: 上一步 (to read the card again); 確認卡片 cannot be pressed ${JSON.stringify(b)}`);
  await screenshot("locked-3-pin");
});
/** Component windows opened for a request that was never sent (a PIN the bridge does not send). */
let unusedWindows = 0;
await tryStep("a PIN with +, % or a character that is not ASCII: not sent", async () => {
  for (const bad of ["12+456", "12%456", "１２３４５６"]) {
    await toPin(main.spec());
    const signs = componentCount("MakeSignature");
    const states = cardStateCount();
    const popups = popupCount();
    await confirmPin(bad);
    const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the message");
    check(m === C.pin.pin_characters, `PIN ${JSON.stringify(bad)}: "${m}"`);
    if (bad === "12+456") await screenshot("pin-characters-3-pin");
    await sleep(500);
    unusedWindows += popupCount() - popups;
    check(componentCount("MakeSignature") === signs && cardStateCount() === states, `PIN ${JSON.stringify(bad)}: nothing sent to the card, no card-state`);
    check((await foundOnPage([bad])).length === 0, `PIN ${JSON.stringify(bad)}: nowhere on the page`);
    check((await buttons()).some((b) => b.text === C.common.back && !b.disabled), `PIN ${JSON.stringify(bad)}: 上一步 is there (to read the card again)`);
  }
});

await tryStep("a card's state the page cannot read (no platforms): stopped under the PIN field", async () => {
  await toPin(fresh.spec());
  const undo = await rewrite("*/api/v1/card-state", (b) => void delete b.platforms);
  try {
    await confirmPin(PIN);
    const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText || null`, "the message");
    const id = await page.text("[data-request-id]");
    check(m.startsWith(fill(C.stops.server_unreadable, { code: "malformed_response" })), `card-state without platforms: "${m}" (${id})`);
  } finally {
    await undo();
  }
  check(!(await page.eval<boolean>(`!!${step("accounts")}`)) && (await buttons()).some((b) => b.text === C.common.back && !b.disabled), "still step 3, 上一步 to read the card again; no list");
  await screenshot("state-unreadable-3-pin");
});

await tryStep("a challenge dated another day: stopped under 連上島民證明的伺服器", async () => {
  await toPin(fresh.spec());
  await confirmPin(PIN);
  await waitAccounts();
  await typeRows({ [THREADS]: "alice" });
  await waitConfirm();
  const signs = componentCount("MakeSignature");
  const undo = await intercept("*/api/v1/challenges", (p) =>
    page.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify({ challenge: "2026-01-01.000G40R40M30E209185GR38E1W" })).toString("base64"),
    }),
  );
  await page.clickButton(C.confirm.button_declare);
  const d = await waitDoneOrMessage();
  await undo();
  check(!d.done && d.item === "server" && d.message === C.stops.date_mismatch, `challenge of another day, under 連上島民證明的伺服器: "${d.message}" (${d.item})`);
  const list = await items("progress");
  check(JSON.stringify(list.map((i) => i.state)) === JSON.stringify(["halt", "", "", ""]), `in progress: 停在這裡, then nothing ${JSON.stringify(list.map((i) => i.state))}`);
  check(JSON.stringify(await buttonTexts()) === JSON.stringify([C.read.read_again]), "再讀一次卡片 only");
  await screenshot("date-5-progress");
  await sleep(500);
  check(componentCount("MakeSignature") === signs, "no second signature");
  const reads = componentCount("GetUserCert");
  await page.clickButton(C.read.read_again);
  await waitStep("read", "再讀一次卡片: step 2");
  for (let i = 0; i < 100 && componentCount("GetUserCert") === reads; i++) await sleep(50);
  check(componentCount("GetUserCert") === reads + 1, "再讀一次卡片: the card read again");
});

// The server says the challenge expired (challenge_unknown) when the record is
// sent: the engine dropped the PIN at the second signature, so the card proof
// starts again from reading the card.
await tryStep("the challenge expired when sent (challenge_unknown): 再讀一次卡片, then the card proof again", async () => {
  await toPin(fresh.spec());
  await confirmPin(PIN);
  await waitAccounts();
  await typeRows({ [THREADS]: "alice" });
  await waitConfirm();
  const before = await recordCount();
  const undo = await intercept("*/api/v1/records", (p) =>
    page.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 400,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify({ error: "challenge_unknown" })).toString("base64"),
    }),
  );
  await page.clickButton(C.confirm.button_declare);
  const d = await waitDoneOrMessage();
  await undo();
  check(!d.done && d.item === "submit" && d.message === C.stops.challenge_expired, `the challenge expired, under 送出: "${d.message}" (${d.item})`);
  check(JSON.stringify(await buttonTexts()) === JSON.stringify([C.read.read_again]), `the PIN dropped: 再讀一次卡片 only ${JSON.stringify(await buttonTexts())}`);
  check((await recordCount()) === before, "nothing appended");
  await screenshot("expired-5-progress");
  await watchList();
  await page.clickButton(C.read.read_again);
  const r = await page.waitFor<string>(
    `(() => { const n = [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.common.next)}); return n && !n.disabled && document.querySelector('[data-step="read"]') ? "read" : null; })()`,
    "the card read again",
    30_000,
  );
  check(r === "read", "再讀一次卡片: step 2, every item done");
  await page.clickButton(C.common.next);
  await waitStep("pin", "step 3");
  check(await pinGone(), "step 3 again: the PIN field is empty (the PIN is typed again)");
});

// On step 3, the PIN typed again and 確認卡片 pressed again while the first
// confirmation is under way (the server slow to answer card-state).
await tryStep("確認卡片 pressed again while the card is confirmed: one signature, one card-state", async () => {
  await toPin(main.spec());
  const signs = componentCount("MakeSignature");
  const states = cardStateCount();
  const held: string[] = [];
  let holding = true;
  const undo = await intercept("*/api/v1/card-state", async (p) => {
    if (holding) held.push(p.requestId);
    else await page.send("Fetch.continueRequest", { requestId: p.requestId });
  });
  const release = async (): Promise<void> => {
    holding = false;
    for (const id of held.splice(0)) await page.send("Fetch.continueRequest", { requestId: id }).catch(() => undefined);
  };
  try {
    await confirmPin(PIN);
    for (let i = 0; i < 200 && held.length === 0; i++) await sleep(50);
    check(held.length === 1, "the first card-state is on its way, its answer held");
    const during = await page.eval<{ pin: boolean | null; button: boolean | null; back: boolean | null; working: string }>(`({
      back: [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.common.back)})?.disabled ?? null,
      pin: document.querySelector('#pin')?.disabled ?? null,
      button: [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.pin.confirm_card)})?.disabled ?? null,
      working: document.querySelector('[data-working]')?.innerText ?? "",
    })`);
    check(during.pin === true && during.button === true && during.back === true && during.working === C.pin.signing, `while the card is confirmed, the PIN field, the button and 上一步 cannot be used: ${JSON.stringify(during)}`);
    await screenshot("signing-3-pin");
    // Typed and pressed again anyway, with the keyboard and the mouse.
    await confirmPin(PIN);
    await sleep(1500);
    check(componentCount("MakeSignature") === signs + 1, `pressed again: the card was asked to sign once (${componentCount("MakeSignature") - signs} times)`);
    check(cardStateCount() === states + 1, `pressed again: one card-state (${cardStateCount() - states})`);
    check((await messageText()) === "", `pressed again: no message "${await messageText()}"`);
    await release();
    const st = await waitAccounts();
    check(st.state === "declared", `step 4 after the answer: ${st.state}`);
    await sleep(1000);
    check(componentCount("MakeSignature") === signs + 1 && cardStateCount() === states + 1, "the first confirmation, once: one signature, one card-state");
  } finally {
    await release();
    await undo();
  }
  await page.clickButton(C.common.cancel);
  await backAtTheBeginning("取消 after 確認卡片 pressed again");
});

/** A case that stops on step 2, before the PIN is asked: the reason under its item. */
async function stopsBeforePin(label: string, card: FakeCardSpec | null, expected: string, item: string, o: { setup?: () => Promise<() => Promise<void>>; silent?: boolean; screenshot?: string; requestId?: boolean; link?: string } = {}): Promise<void> {
  component.card = card;
  component.silent = o.silent ?? false;
  await open();
  await toRead();
  const undo = o.setup ? await o.setup() : null;
  const signs = componentCount("MakeSignature");
  const cardStates = cardStateCount();
  const r = await readCard();
  // An answer of the server the page cannot read: its request ID on the next line.
  const why = o.requestId ? r.why.split("\n")[0] : r.why;
  const idLine = o.requestId ? (r.why.split("\n")[1] ?? "") : "";
  check(!r.done && r.item === item && why === expected, `${label}: under "${item}": "${r.why}"`);
  if (o.requestId) check(new RegExp("^" + fill(C.stops.request_id, { request_id: "[0-9a-f]{16}" }) + "$").test(idLine), `${label}: the request ID on the next line: "${idLine}"`);
  const list = await items("read");
  const at = READ_KEYS.indexOf(item);
  check(list[at]?.st === C.common.halted && list.slice(at + 1).every((i) => i.state === ""), `${label}: 停在這裡, nothing after it ${JSON.stringify(list.map((i) => i.state))}`);
  if (o.link) {
    const links = await page.eval<string[]>(`[...document.querySelectorAll('main a')].map((a) => a.getAttribute("href") + " " + a.target + " " + a.rel)`);
    check(links.length === 1 && links[0] === `${o.link} _blank noopener noreferrer`, `${label}: the one link goes to ${o.link}, in a new tab ${JSON.stringify(links)}`);
  }
  if (o.screenshot) await screenshot(o.screenshot);
  await sleep(300);
  check(!(await page.eval<boolean>(`!!document.querySelector('#pin')`)), `${label}: no PIN field`);
  check(componentCount("MakeSignature") === signs, `${label}: nothing signed`);
  check(cardStateCount() === cardStates, `${label}: no card-state request`);
  check((await buttons()).some((b) => b.text === C.read.read_again && !b.disabled), `${label}: 再讀一次卡片`);
  if (undo) await undo();
  component.silent = false;
}

// Every case that stops before the PIN, each under its item.
const tests: [string, FakeCardSpec | null, string, string, Parameters<typeof stopsBeforePin>[4]?][] = [
  ["the component does not answer", main.spec(), C.stops.component_unreachable + " " + C.links.prepare, "component", { silent: true, screenshot: "stop-2-component", link: "/prepare" }],
  ["no reader", { ...main.spec(), noReader: true }, C.stops.no_reader, "reader", { screenshot: "stop-2-no-reader" }],
  ["no card", { ...main.spec(), noCard: true }, C.stops.no_card, "reader", { screenshot: "stop-2-no-card" }],
  ["no certificate on the card", { ...main.spec(), certificates: [] }, C.stops.no_certificate, "certificate", { screenshot: "stop-2-no-certificate" }],
  ["expired", expired.spec(), fill(C.stops.expired, { expiry_date: "2025-12-31" }), "check", { screenshot: "stop-2-expired" }],
  ["not yet valid", notYet.spec(), fill(C.stops.not_yet_valid, { valid_from: notYetTaiwan }), "check", { screenshot: "stop-2-not-yet-valid" }],
  ["not a citizen's primary card", foreign.spec(), C.stops.not_citizen_primary, "check", { screenshot: "stop-2-not-citizen" }],
  ["a format the circuit does not take", bigKey.spec(), C.stops.unsupported_format, "check", { screenshot: "stop-2-unsupported-format" }],
  ["two certificates that pass", { ...main.spec(), certificates: [...main.spec().certificates, ...revoked.spec().certificates] }, C.stops.two_certificates, "check", { screenshot: "stop-2-two-certificates" }],
  ["not issued by MOICA", unknownIssuer.spec(), C.stops.unknown_issuer, "check", { screenshot: "stop-2-unknown-issuer" }],
  ["revoked", revoked.spec(), C.stops.revoked, "crl", { screenshot: "stop-2-revoked" }],
  // 5 days old on the first day; the clock is `day` days ahead by now.
  ["the CRL is 5 days old", g2card.spec(), fill(C.stops.crl_stale, { crl_days: 5 + day }), "crl", { screenshot: "stop-2-crl-stale" }],
  [
    "the mirror's index has no usable CRL",
    main.spec(),
    fill(C.stops.crl_unavailable, { code: "crl_unavailable" }),
    "crl",
    {
      setup: () =>
        intercept("*/crl/index.jsonl", (p) => page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/jsonl" }], body: "" })),
      screenshot: "stop-2-crl-unavailable",
    },
  ],
  [
    "a circuit file with other bytes",
    main.spec(),
    C.stops.artifact,
    "server",
    {
      setup: () =>
        intercept("*/circuits/card_proof_rs4096.json", (p) =>
          page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from("{}").toString("base64") }),
        ),
      screenshot: "stop-2-artifact",
    },
  ],
  [
    "the server does not answer",
    main.spec(),
    fill(C.stops.server_unreadable, { code: "network" }),
    "server",
    { setup: () => intercept("*/api/v1/config", (p) => page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" })), screenshot: "stop-2-server" },
  ],
  [
    "a platform table the page cannot read (no row in the one form of a format)",
    main.spec(),
    fill(C.stops.server_unreadable, { code: "malformed_response" }),
    "server",
    { setup: () => rewrite("*/api/v1/config", (b) => void (b.platforms = b.platforms.map((p: Record<string, string>) => ({ ...p, username_format: "^[a-z]+$" })))), screenshot: "stop-2-platform-table", requestId: true },
  ],
];
for (const [label, card, expected, item, o] of tests) await tryStep(`before the PIN: ${label}`, () => stopsBeforePin(label, card, expected, item, o));

await tryStep("再讀一次卡片 reads the card again", async () => {
  component.card = { ...main.spec(), noCard: true };
  await open();
  await toRead();
  const r1 = await readCard();
  check(!r1.done && r1.item === "reader", "an empty reader first");
  component.card = main.spec();
  const r2 = await readCard(C.read.read_again);
  check(r2.done, "the card inserted, 再讀一次卡片: every item done");
});

// Other cards: the same account declared by two cards; answers the page cannot read, or never got.
const other = await makeCard({ serial: "0990567890abcdef1234567890abcdef" });
await tryStep("one card declares @zoe (account_cards 1): no sentence about other cards", async () => {
  component.card = fresh.spec();
  const st = await toAccounts();
  check(st.state === "never", `a new card: ${st.state}`);
  await typeRows({ [THREADS]: "zoe" });
  await waitConfirm();
  await finish({ label: "@zoe, one card", button: C.confirm.button_declare, title: C.done.first, card: [[THREADS_NAME, at("zoe")]], record: [[THREADS_NAME, at("zoe"), [K.first]]], newCard: true });
});
await tryStep("a second card declares @zoe (account_cards 2): the sentence about other cards", async () => {
  component.card = other.spec();
  await toAccounts();
  await typeRows({ [EXAMPLE]: "z-1", [THREADS]: "zoe" });
  await waitConfirm();
  await finish({
    label: "@zoe, a second card",
    button: C.confirm.button_declare,
    title: C.done.first,
    card: [
      [EXAMPLE_NAME, "z-1"],
      [THREADS_NAME, at("zoe")],
    ],
    record: [
      [EXAMPLE_NAME, "z-1", [K.first]],
      [THREADS_NAME, at("zoe"), [K.first]],
    ],
    newCard: true,
    otherCards: [at("zoe")],
    screenshots: "other-cards",
  });
});
await tryStep("the answer's kinds the page cannot read: 證明紀錄已經記下這次過卡", async () => {
  component.card = other.spec();
  await toAccounts();
  await page.clickButton(A.refresh);
  await waitConfirm();
  const seen: any[] = [];
  const undo = await rewrite("*/api/v1/records", (b) => void (b.kinds = [{ platform: THREADS, kind: "renewal", username: "zoe", account_cards: 2 }]), seen);
  try {
    await finish({
      label: "kinds unreadable",
      button: C.confirm.button_refresh,
      title: C.done.recorded_only,
      card: [
        [EXAMPLE_NAME, "z-1"],
        [THREADS_NAME, at("zoe")],
      ],
      record: null,
      screenshots: "kinds-unreadable",
    });
  } finally {
    await undo();
  }
  check(seen.length === 1 && Array.isArray(seen[0].kinds), "the server's answer had kinds; the page got a kind it does not know");
});

await tryStep("a 201 whose body the page cannot read: 證明紀錄已經記下這次過卡, not a failure", async () => {
  component.card = other.spec();
  await toAccounts();
  await page.clickButton(A.refresh);
  await waitConfirm();
  const undo = await rewrite("*/api/v1/records", () => ({ unexpected: true }));
  try {
    await finish({
      label: "201 unreadable",
      button: C.confirm.button_refresh,
      title: C.done.recorded_only,
      card: [
        [EXAMPLE_NAME, "z-1"],
        [THREADS_NAME, at("zoe")],
      ],
      record: null,
      unnumbered: true,
      screenshots: "unreadable-201",
    });
  } finally {
    await undo();
  }
});

await tryStep("the answer to the submission lost, the record appended: 再試一次 gets challenge_used, the card's state shows the list (the real server)", async () => {
  component.card = fresh.spec();
  await toAccounts();
  await page.clickButton(A.refresh);
  await waitConfirm();
  const before = await recordCount();
  const states = cardStateCount();
  // The first submission reaches the server; its answer is dropped on the way back.
  let dropped = false;
  const undo = await intercept(
    "*/api/v1/records",
    async (p) => {
      if (!dropped) {
        dropped = true;
        await page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionReset" });
      } else await page.send("Fetch.continueRequest", { requestId: p.requestId });
    },
    "Response",
  );
  try {
    await page.clickButton(C.confirm.button_refresh);
    const d1 = await waitDoneOrMessage();
    check(d1.item === "submit" && d1.message === C.stops.submit_failed, `the answer lost: "${d1.message}" under ${d1.item}`);
    check((await recordCount()) === before + 1, "the server appended the record all the same");
    await page.clickButton(C.progress.retry);
    const d = await waitDoneOrMessage();
    const challengeUsed = browser.responses.some((r) => r.url.endsWith("/api/v1/records") && r.status === 400) && refused("challenge_used");
    check(challengeUsed, "the resubmission was answered challenge_used");
    check(cardStateCount() === states + 1, "the card's state asked again");
    // What the server recorded on each platform is not known on this path: the title of an answer not read.
    checkDone({ label: "found in the card's state", title: C.done.recorded_only, card: [[THREADS_NAME, at("zoe")]], record: null, unnumbered: true }, d.done ? await doneSeen() : null, d.message);
    check((await recordCount()) === before + 1, "one record, not two");
    await sleep(1500);
    await screenshot("challenge-used-6-done");
  } finally {
    await undo();
  }
});

// The server's table with Threads only (the first release's), and a card with no account
// elsewhere: steps 4, 5 and 6 speak of one platform, by its name. (Step 1 of this build still
// speaks of more than one: it goes by the platforms the build knows, test-example and threads;
// the production build's step 1 is checked last.) One card, from its first declaration to
// everything withdrawn, each by the button step 4 has for it: 下一步 with the field filled,
// 更新島民證明, 改成別的帳號, 收回對 @… 的宣告.
const single = await makeCard({ serial: "0a90567890abcdef1234567890abcdef" });
/** Steps 1 to 4 with the server's table cut to Threads on its way to the page. */
async function toAccountsThreadsOnly(o: { screenshots?: string; seen?: unknown[] } = {}): Promise<AccountsSeen> {
  const undo = await rewrite("*/api/v1/config", (b) => void (b.platforms = b.platforms.filter((p: { platform: string }) => p.platform === THREADS)), o.seen);
  try {
    return await toAccounts({ screenshots: o.screenshots });
  } finally {
    await undo();
  }
}

await tryStep("Threads only: a first declaration (the field alone)", async () => {
  component.card = single.spec();
  const seenConfig: unknown[] = [];
  const st = await toAccountsThreadsOnly({ screenshots: "single", seen: seenConfig });
  check(seenConfig.length === 1, "the config was read once, and changed on its way");
  check(st.state === "never" && st.mode === "fill", `a new card: ${st.state} ${st.mode}`);
  // The field alone: no line under it, no rules of switching, nothing about who owns the account.
  checkRows("one platform", st.rows, { [THREADS]: [THREADS_NAME, "", []] });
  check(st.title === "你的 Threads 帳號" && st.title === fill(A.title_single, { platform: THREADS_NAME }), `step 4, one platform: the title "${st.title}"`);
  check(JSON.stringify(st.lead) === JSON.stringify([A.none_yet, "填上你要宣告的 Threads 帳號。"]), `step 4, one platform: ${JSON.stringify(st.lead)}`);
  check(
    !st.main.includes(A.switches_limited) && !st.main.includes(A.one_per_platform) && !st.main.includes(A.fill_one),
    "step 4, one platform, a first declaration: no rules of switching, not the sentences of more than one",
  );
  check(st.main.includes(A.preview_note), "step 4, one platform: the preview");
  check((await page.eval<string>("document.title")) === "你的 Threads 帳號", "step 4, one platform: the page's title");
  check(JSON.stringify(st.buttons) === JSON.stringify([A.preview, C.common.next, C.common.cancel]), `step 4, one platform: the buttons ${JSON.stringify(st.buttons)}`);
  await screenshot("single-4-accounts");
  await typeRows({ [THREADS]: "yui" });
  const c = await waitConfirm();
  checkConfirm("one platform", c, [[THREADS, THREADS_NAME, at("yui"), [K.first]]], C.confirm.button_declare_single, THREADS_NAME);
  check(c.intro === "按下後，證明紀錄會記下新的證明並公開給所有人：", `step 5, one platform: "${c.intro}"`);
  check(c.buttons.includes("宣告這個帳號"), `step 5, one platform: the button ${JSON.stringify(c.buttons)}`);
  await screenshot("single-5-confirm");
  await finish({
    label: "one platform",
    button: C.confirm.button_declare_single,
    title: C.done.first,
    card: [[THREADS_NAME, at("yui")]],
    record: [[THREADS_NAME, at("yui"), [K.first]]],
    newCard: true,
    single: THREADS_NAME,
    screenshots: "single",
  });
  // The words of design/copy/card-proof.md, step 6, as written there.
  const hangTitle = await page.text("[data-step=\"done\"] h2.hang-title");
  check(hangTitle === "最後一步：掛到你的 Threads 個人檔案", `step 6, one platform: the heading "${hangTitle}"`);
  check(
    (await page.text("[data-anyone]")) === "任何人都能宣告任何帳號。你把連結掛上個人檔案，別人才知道這個帳號承認這張證明。",
    `step 6, one platform: "${await page.text("[data-anyone]")}"`,
  );
  check((await page.text("[data-new-card]")) === "如果你換了新的自然人憑證：新卡片的島民編號和連結都和舊的不同。請把個人檔案的連結換成這一個。", "step 6: a new card's new link");
  check((await page.text()).includes("越久沒過卡，說服力越低。每次過卡，島民證明上的日期就會更新成今天。"), "step 6: why come back");
});

await tryStep("Threads only, declared: 更新島民證明 (the list as it is), 上一步 and again", async () => {
  await setDay(day + 1);
  const st = await toAccountsThreadsOnly();
  checkDeclared("one platform, declared yesterday", st, [["", at("yui")]], 1);
  check(st.title === "你的 Threads 帳號", `one platform, declared: the title "${st.title}"`);
  await page.eval(`document.activeElement?.blur()`);
  await screenshot("single-4-accounts-existing");
  const signs = componentCount("MakeSignature");
  await page.clickButton(A.refresh);
  const want: [string, string, string, string[]][] = [[THREADS, THREADS_NAME, at("yui"), [K.unchanged]]];
  checkConfirm("one platform, 更新島民證明", await waitConfirm(), want, C.confirm.button_refresh, THREADS_NAME);
  check(C.confirm.button_refresh === A.refresh, "step 5's button is step 4's word: 更新島民證明");
  await screenshot("single-5-confirm-refresh");
  await page.clickButton(C.common.back);
  checkDeclared("上一步 from 更新島民證明", await waitAccounts(), [["", at("yui")]], 1);
  await page.clickButton(A.refresh);
  checkConfirm("one platform, 更新島民證明 again", await waitConfirm(), want, C.confirm.button_refresh, THREADS_NAME);
  check(componentCount("MakeSignature") === signs, "back and forth: nothing signed");
  await finish({ label: "one platform, 更新島民證明", button: C.confirm.button_refresh, title: C.done.refresh, card: [[THREADS_NAME, at("yui")]], record: [[THREADS_NAME, at("yui"), [K.unchanged]]], single: THREADS_NAME });
});

await tryStep("Threads only: 改成別的帳號 (@yui to @yui.tw): the limit said only then; 不改了; an empty field; 上一步", async () => {
  const st = await toAccountsThreadsOnly();
  checkDeclared("one platform, declared today", st, [["", at("yui")]], 0);
  await page.clickButton(A.switch);
  const sw = await waitAccounts();
  check(sw.mode === "switch" && sw.title === "你的 Threads 帳號", `改成別的帳號: ${sw.mode} "${sw.title}"`);
  check(JSON.stringify(sw.lead) === JSON.stringify([fill(A.declared_inline, { account: at("yui") })]), `改成別的帳號: ${JSON.stringify(sw.lead)}`);
  checkRows("改成別的帳號", sw.rows, { [THREADS]: [THREADS_NAME, "", []] });
  const lines = await page.eval<string[]>(`[...document.querySelectorAll('[data-switch-lines] p')].map((e) => e.innerText)`);
  check(JSON.stringify(lines) === JSON.stringify([fill(A.switch_effect, { account: at("yui") }) + fill(A.switch_limit, { switches_left: 4 }), A.preview_note]), `改成別的帳號: what it does, the switches left after it ${JSON.stringify(lines)}`);
  check(JSON.stringify(sw.buttons) === JSON.stringify([A.preview, C.common.next, A.keep, C.common.cancel]), `改成別的帳號: the buttons ${JSON.stringify(sw.buttons)}`);
  await page.eval(`document.activeElement?.blur()`);
  await screenshot("single-4-accounts-switch");
  // An empty field: nowhere (withdrawing is the other button).
  await page.clickButton(C.common.next);
  const why = (await rowsOnScreen()).find((r) => r.platform === THREADS)?.why;
  check(why === A.need_one && (await page.eval<boolean>(`!!${step("accounts")}`)), `改成別的帳號, empty: "${why}"`);
  // 不改了: back to what the card declares.
  await page.clickButton(A.keep);
  checkDeclared("不改了", await waitAccounts(), [["", at("yui")]], 0);
  await page.clickButton(A.switch);
  await waitAccounts();
  await typeRows({ [THREADS]: "yui.tw" });
  const want: [string, string, string, string[]][] = [[THREADS, THREADS_NAME, at("yui.tw"), [fill(K.switch, { previous: at("yui") }), fill(C.confirm.uses_switch, { switches_left: 4 })]]];
  checkConfirm("one platform, a switch", await waitConfirm(), want, C.confirm.button_declare_single, THREADS_NAME);
  await screenshot("single-5-confirm-switch");
  await page.clickButton(C.common.back);
  const again = await waitAccounts();
  check(again.mode === "switch" && again.rows[0]?.value === "yui.tw", `上一步: 改成別的帳號 with what was typed (${again.mode}, ${again.rows[0]?.value})`);
  await page.clickButton(C.common.next);
  checkConfirm("one platform, a switch again", await waitConfirm(), want, C.confirm.button_declare_single, THREADS_NAME);
  await finish({
    label: "one platform, 改成別的帳號",
    button: C.confirm.button_declare_single,
    title: C.done.changed,
    card: [[THREADS_NAME, at("yui.tw")]],
    record: [[THREADS_NAME, at("yui.tw"), [fill(K.switch, { previous: at("yui") })]]],
    single: THREADS_NAME,
  });
});

await tryStep("Threads only: 收回對 @yui.tw 的宣告; the next day, the field again with what was withdrawn under it", async () => {
  const st = await toAccountsThreadsOnly();
  checkDeclared("one platform, switched today", st, [["", at("yui.tw")]], 0);
  const withdraw = fill(A.withdraw, { account: at("yui.tw") });
  await page.clickButton(withdraw);
  const button = fill(C.confirm.button_withdraw, { account: at("yui.tw") });
  check(button === withdraw, "step 5's button is step 4's words: 收回對 @yui.tw 的宣告");
  checkConfirm("one platform, withdrawn", await waitConfirm(), [[THREADS, THREADS_NAME, at("yui.tw"), [K.withdraw]]], button, THREADS_NAME);
  await screenshot("single-5-confirm-withdraw");
  const submissions: Record<string, unknown>[] = [];
  await finish({ label: "one platform, 收回", button, title: C.done.withdraw_all, card: [], record: [[THREADS_NAME, at("yui.tw"), [K.withdraw]]], withdrawnLink: true, single: THREADS_NAME, submissions });
  check(JSON.stringify(submissions.map((s) => s.accounts)) === JSON.stringify([[]]), `收回: the list sent is empty ${JSON.stringify(submissions.map((s) => s.accounts))}`);
  // 3 records today: the next day, step 4 as for a first declaration, with what was withdrawn and the switches left.
  await setDay(day + 1);
  const none = await toAccountsThreadsOnly();
  check(none.state === "nothing" && none.mode === "fill", `everything withdrawn: ${none.state} ${none.mode}`);
  check(JSON.stringify(none.lead) === JSON.stringify([A.nothing_now, "填上你要宣告的 Threads 帳號。"]), `everything withdrawn: ${JSON.stringify(none.lead)}`);
  checkRows("one platform, withdrawn", none.rows, { [THREADS]: [THREADS_NAME, "", [fill(A.row_withdrawn, { last_declared: at("yui.tw") }), count(1)]] });
  await screenshot("single-4-accounts-nothing");
  await page.clickButton(C.common.cancel);
  await waitStep("before", "step 1, after 取消");
});
// 6. Storage, connections, policy ---------------------------------------------

await tryStep("storage", async () => {
  const st = await page.eval<any>(`(async () => ({
    local: Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).map((k) => [k, localStorage.getItem(k)])),
    session: sessionStorage.length,
    idb: (await indexedDB.databases()).map((d) => d.name),
    caches: await caches.keys(),
    cookies: document.cookie,
  }))()`);
  check(JSON.stringify(st.local) === JSON.stringify({ [STORAGE_KEY_PREFIX + "G3"]: String(g3Number) }), `localStorage holds only the CRL number (${g3Number}): ${JSON.stringify(st.local)}`);
  check(st.session === 0 && st.idb.length === 0 && st.caches.length === 0 && st.cookies === "", `nothing else stored: ${JSON.stringify(st)}`);
});

// Last, because it leaves a higher CRL number behind.
await tryStep("before the PIN: a CRL older than the one this browser used", () =>
  stopsBeforePin("a CRL older than the one this browser used", main.spec(), C.stops.crl_rollback, "crl", {
    setup: async () => {
      await page.eval(`localStorage.setItem(${JSON.stringify(STORAGE_KEY_PREFIX + "G3")}, "${g3Number + 1}")`);
      return async () => undefined;
    },
  }),
);

{
  const componentOrigin = new URL(COMPONENT).origin;
  // The component's windows: the tabs that loaded its /popupForm. Chrome's own
  // targets (its UI, its built-in extensions' service workers) are not the page's.
  // The preview's tabs are on the platform's site by design (and resolved nothing).
  const popups = new Set(browser.requests.filter((r) => r.url.startsWith(COMPONENT + "/popupForm")).map((r) => r.sessionId));
  const previewSessions = new Set([...browser.sessions.entries()].filter(([, s]) => previews.some((p) => p.targetId === s.targetId)).map(([id]) => id));
  const ours = browser.requests.filter((r) => ["page", "worker", "iframe"].includes(r.targetType) && !previewSessions.has(r.sessionId));
  const outside = ours.filter((r) => {
    if (r.url.startsWith("about:")) return false;
    const origin = new URL(r.url).origin;
    return popups.has(r.sessionId) ? origin !== componentOrigin : origin !== PAGE_ORIGIN;
  });
  const types = [...new Set(ours.map((r) => r.targetType))];
  check(outside.length === 0, `the page and its workers (${types.join(", ")}) connected only to ${PAGE_ORIGIN}; the component's window only to ${componentOrigin}: ${JSON.stringify(outside.slice(0, 5))}`);
  // On its own origin, the page asked for the page itself and its files under /proof/, the API
  // and the CRL mirror, nothing else (the page moved from / to /proof). /favicon.ico is the
  // browser's own request, not the page's.
  const own = ours
    .filter((r) => !popups.has(r.sessionId) && !r.url.startsWith("about:") && new URL(r.url).origin === PAGE_ORIGIN)
    .map((r) => new URL(r.url).pathname)
    .filter((p) => p !== "/favicon.ico");
  const elsewhere = own.filter((p) => p !== "/proof" && !p.startsWith("/proof/") && !p.startsWith("/api/") && !p.startsWith("/crl/"));
  check(
    own.includes("/proof") && own.some((p) => p.startsWith("/proof/assets/")) && own.some((p) => p.startsWith("/proof/circuits/")) && own.some((p) => p.startsWith("/proof/crs/")) && own.some((p) => p.startsWith("/proof/bb/")) && elsewhere.length === 0,
    `the page's own requests: /proof and its files under /proof/, the API and the CRLs only ${JSON.stringify([...new Set(elsewhere)].slice(0, 5))}`,
  );
  const previewRequests = browser.requests.filter((r) => previewSessions.has(r.sessionId));
  check(
    previews.length === 1 && previewRequests.every((r) => new URL(r.url).origin === PROFILE_ORIGIN),
    `one preview tab, which asked for nothing but the platform's page: ${JSON.stringify(previewRequests.map((r) => r.url).slice(0, 3))}`,
  );
  check(
    windowCalls.every((c) => c.url === COMPONENT + "/popupForm" || (c.url === threadsUrl("alice") && c.features === "noopener,noreferrer")),
    `every window.open of the page: the component's window, or the preview (${windowCalls.length} calls)`,
  );
  const workers = browser.requests.filter((r) => r.targetType === "worker").length;
  check(workers > 0, `the requests of the workers were seen too (${workers})`);
  const csp = browser.logs.filter((l) => /Content Security Policy/i.test(l.text));
  check(csp.length === 0, `no Content-Security-Policy violation ${JSON.stringify(csp.slice(0, 3))}`);
  // Three windows had no request: the silent component's, and the two opened for the second
  // signature that the challenge of another day and the date that changed on step 5 stopped
  // (each closed unused). The blocked clicks opened none. A PIN the bridge does not send: its
  // window is closed unused (and may not have loaded).
  check(
    popups.size === component.requests.length + 3 + unusedWindows && unusedWindows <= 3,
    `one component window per request (${popups.size} windows, ${component.requests.length} requests, ${unusedWindows} closed unused for a PIN not sent)`,
  );
  check(component.requests.every((r) => r.func !== "MakeSignature" || (r.pin ?? "") !== ""), "no signing request without a PIN");
  check(component.requests.every((r) => ["GetUserCert", "MakeSignature"].includes(r.func)), "only GetUserCert and MakeSignature were asked of the component");
  check(
    windows.opened > 0 && windows.opened >= popups.size && windows.openedWhileAnother === 0,
    `each window opened only after the page closed the last one (${windows.opened} windows opened, ${windows.openedWhileAnother} while another was open)`,
  );
  check(windows.badNames.length === 0, `each window a name of its own, iamreal- and 128 random bits (${windows.names.size} names; not so: ${JSON.stringify(windows.badNames.slice(0, 3))})`);
}

// A page on another site opens this page with window.open. With
// Cross-Origin-Opener-Policy: same-origin-allow-popups the opener loses its
// hold on this page, and this page still talks to the component's window it
// opens (README.md, "Cross-Origin-Opener-Policy"). It runs last, after the
// checks of where the page connected, because the other site's pages
// connect elsewhere by design.
//
// The other site's pages are served from the fake component's origin. A
// page can find a window by its name only if it is in the same origin as
// that window (Chrome 157, tried); this is the strongest opener, and the
// one with which, without Cross-Origin-Opener-Policy and with a fixed
// window name, the component's window was taken.
await tryStep("a page on another site opens this page (Cross-Origin-Opener-Policy)", async () => {
  const hits: string[] = [];
  component.pages = (path) => {
    hits.push(path);
    if (path === "/__opener") {
      return `<!doctype html><title>opener</title><button id="go" onclick="window.w = window.open('${PAGE}', '_blank')">open</button><button id="steal">steal</button>`;
    }
    if (path.startsWith("/__elsewhere/")) return `<!doctype html><p>elsewhere ${path}</p>`;
    return null;
  };
  const ELSEWHERE = `${COMPONENT}/__elsewhere`;
  const created: { targetId: string; openerId?: string }[] = [];
  const off = browser.on((m, p) => {
    if (m === "Target.targetCreated" && p.targetInfo.type === "page") created.push({ targetId: p.targetInfo.targetId, openerId: p.targetInfo.openerId });
  });
  const pageOf = async (targetId: string): Promise<Page> => {
    for (let i = 0; i < 200; i++) {
      for (const [sessionId, s] of browser.sessions) if (s.targetId === targetId) return new Page(browser, sessionId, targetId);
      await sleep(50);
    }
    throw new Error(`target ${targetId} did not attach`);
  };
  const urlOf = (targetId: string) => [...browser.sessions.values()].find((s) => s.targetId === targetId)?.url ?? "";
  let release: () => void = () => undefined;
  try {
    const opener = await browser.newPage();
    await opener.send("Page.enable");
    await opener.goto(`${COMPONENT}/__opener`);
    await opener.click("#go");
    for (let i = 0; i < 100 && !created.some((c) => c.openerId === opener.targetId); i++) await sleep(50);
    const t = created.find((c) => c.openerId === opener.targetId);
    if (!check(t !== undefined, "the other site opened this page")) return;
    const ours = await pageOf(t!.targetId);
    await ours.waitFor(step("before"), "step 1 in the page the other site opened");

    // 1. The page is still cross-origin isolated.
    check(await ours.eval<boolean>("crossOriginIsolated"), "opened by another site: the page is cross-origin isolated");
    // 2. The page has no opener.
    check(await ours.eval<boolean>("window.opener === null"), "opened by another site: the page's window.opener is null");
    // 3. The opener's handle on the page is cut.
    check(await opener.eval<boolean>("window.w.closed === true"), "the other site's handle on the page is closed");

    // 4 and 5. The page reads the card through the component's window; while
    // that window waits for the card, the other site opens a window by its
    // name. The component's window is not taken; the reply still comes back.
    component.card = main.spec();
    component.silent = false;
    // The last case above left a higher CRL number behind; this card proof should read the card through.
    await ours.eval(`localStorage.removeItem(${JSON.stringify(STORAGE_KEY_PREFIX + "G3")})`);
    await ours.send("Page.bringToFront");
    await ours.clickButton(C.common.next);
    await ours.waitFor(step("read"), "step 2");
    component.hold = new Promise<void>((r) => (release = r));
    const requests = component.requests.length;
    await ours.clickButton(C.read.read_card);
    for (let i = 0; i < 200 && component.requests.length === requests; i++) await sleep(50);
    check(component.requests.length === requests + 1 && component.requests.at(-1)?.func === "GetUserCert", "the component's window got the page's request");
    const w = created.find((c) => c.openerId === ours.targetId);
    if (!check(w !== undefined, "the page opened the component's window")) return;
    const popup = await pageOf(w!.targetId);
    const name = await popup.eval<string>("window.name");
    check(/^iamreal-[0-9a-f]{32}$/.test(name), `the component's window has a name of its own: ${name}`);
    await opener.eval(`document.getElementById("steal").onclick = () => { window.stolen = window.open(${JSON.stringify(ELSEWHERE + "/stolen-window")}, ${JSON.stringify(name)}); }`);
    await opener.send("Page.bringToFront");
    await opener.click("#steal");
    await sleep(1500);
    // The attempt was made (a window loaded the address), and it did not land in the component's window.
    const attempted = (await opener.eval<boolean>("!!window.stolen")) && hits.includes("/__elsewhere/stolen-window");
    check(
      attempted && urlOf(w!.targetId).startsWith(COMPONENT + "/popupForm"),
      `the other site's window.open by that name (made: ${attempted}) left the component's window where it was: ${urlOf(w!.targetId)}`,
    );
    await ours.send("Page.bringToFront");
    release();
    component.hold = null;
    const done = await ours
      .waitFor<string>(
        `(() => { const h = document.querySelector('[data-list="read"] [data-state="halt"]'); if (h) return "stopped: " + h.innerText;
          const next = [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.common.next)}); return next && !next.disabled ? "read" : null; })()`,
        "step 2's list to end",
        40_000,
      )
      .catch(() => "(nothing)");
    check(done === "read", `the page and the component's window went back and forth: ${done}`);

    // 6. The other site cannot replace the page.
    await opener.eval(`try { window.w.location = ${JSON.stringify(ELSEWHERE + "/tab-replaced")}; } catch (e) {} true`);
    await sleep(1500);
    const href = await ours.eval<string>("location.href").catch(() => "");
    check(href === PAGE && !hits.includes("/__elsewhere/tab-replaced"), `the other site's w.location = … changed nothing: the page is at ${href}`);

    for (const c of created) if (c.targetId !== page.targetId) await browser.send("Target.closeTarget", { targetId: c.targetId }).catch(() => undefined);
    await browser.send("Target.closeTarget", { targetId: opener.targetId }).catch(() => undefined);
  } finally {
    release();
    component.hold = null;
    off();
    component.pages = null;
  }
});

// The production build's step 1: it knows Threads only, and there is no platform table yet, so
// step 1 goes by that: the one platform named, and nothing about accounts listed together. The
// page is served from a plain local server with the page's headers and opened to step 1 only:
// nothing is clicked, and any request to MOICA's component (the real one's address) is failed
// and counted (there should be none).
await tryStep("the production build's step 1: one platform, named", async () => {
  const prodDist = join(out, "dist-production");
  await build({ root: web, configFile: join(web, "vite.config.ts"), mode: "production", logLevel: "warn", build: { outDir: prodDist, emptyOutDir: true } });
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  const site = createServer((req, res) => {
    // The page at /proof, its files under /proof/, as the server serves them.
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file = join(prodDist, path === "/proof" ? "index.html" : path.startsWith("/proof/") ? path.slice("/proof".length) : "/nothing");
    let body: Buffer;
    try {
      if (!file.startsWith(prodDist + "/")) throw new Error("outside");
      body = readFileSync(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Content-Security-Policy": CONTENT_SECURITY_POLICY, ...ISOLATION_HEADERS, ...OPENER_HEADERS }).end(body);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const prodUrl = `http://localhost:${(site.address() as AddressInfo).port}/proof`;
  const prod = await browser.newPage();
  const componentRequests: string[] = [];
  const off = browser.on((m, p, s) => {
    if (m !== "Fetch.requestPaused" || s !== prod.sessionId) return;
    componentRequests.push(p.request.url);
    void prod.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
  });
  try {
    await prod.send("Page.enable");
    await prod.send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:61161/*" }, { urlPattern: "http://127.0.0.1:61161/*" }] });
    await prod.goto(prodUrl);
    await prod.waitFor(step("before"), "the production build's step 1");
    // One platform: what the proof says and that it is public is step 5's first sentence, not step 1's.
    const s1 = await prod.text();
    check(!(await prod.eval<boolean>(`!!document.querySelector('[data-one-proof]')`)) && !s1.includes(C.before.one_proof), "the production build's step 1: no sentence of what the proof lists");
    check(
      [C.before.title, C.before.duration, C.before.prepare_card, C.before.citizens_only, C.before.why_physical, C.before.how_to_get].every((x) => s1.includes(x)) && !s1.includes("我們只收台灣中華民國國民的自然人憑證正卡"),
      "the production build's step 1: the words of card-proof.md",
    );
    await step1Links("the production build's step 1", prod);
    check(!(await prod.eval<boolean>(`!!document.querySelector('[data-listed-together]')`)) && !(await prod.text()).includes(C.before.listed_together), "the production build's step 1 does not say the accounts are listed together");
    await screenshot("single-1-before", prod);
    await prod.eval(`document.querySelectorAll('details').forEach((d) => (d.open = true))`);
    await screenshot("single-1-before-open", prod);
    await sleep(1000);
    check(componentRequests.length === 0, `the production build's step 1 asked nothing of the component ${JSON.stringify(componentRequests)}`);
  } finally {
    off();
    await browser.send("Target.closeTarget", { targetId: prod.targetId }).catch(() => undefined);
    await new Promise((r) => site.close(r));
  }
});

// The test site's build (mode "testsite"), served as a deploy serves it: by a Worker's Static Assets, with the
// headers of a test log's site. Opened to step 1 only, nothing clicked: MOICA's keys and the real component's
// address are in this build, so any request to the component is failed and counted (there should be none).
await tryStep("the test site's build: the mark of a test log, the test site's headers", async () => {
  const CLEARED_ON = "2026-10-31";
  const siteDist = join(out, "dist-testsite");
  process.env.IAMREAL_TEST_PROOF_LOG_CLEARED_ON = CLEARED_ON;
  await build({ root: web, configFile: join(web, "vite.config.ts"), mode: "testsite", logLevel: "warn", build: { outDir: siteDist, emptyOutDir: true } }).finally(() => delete process.env.IAMREAL_TEST_PROOF_LOG_CLEARED_ON);
  const testSite = await startWorkerSite({ proofFiles: siteDist, settings: { TEST_PROOF_LOG_CLEARED_ON: CLEARED_ON } });
  const tab = await browser.newPage();
  const componentRequests: string[] = [];
  const off = browser.on((m, p, s) => {
    if (m !== "Fetch.requestPaused" || s !== tab.sessionId) return;
    componentRequests.push(p.request.url);
    void tab.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
  });
  const logsBefore = browser.logs.length;
  try {
    await tab.send("Page.enable");
    await tab.send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:61161/*" }, { urlPattern: "http://127.0.0.1:61161/*" }] });
    // The mark as the Worker's own pages write it (design/copy/test-site.md): the sentence, then the date.
    const copy = /```\n(.*)\n```/.exec(readFileSync(join(repo, "design", "copy", "test-site.md"), "utf8"))![1]!;
    const mark = copy.replace(/\d{4}-\d{2}-\d{2}$/, CLEARED_ON);
    const markOf = (p: Page) => p.eval<{ first: boolean; text: string; date: string } | null>(`(() => {
      const m = document.querySelector("p.test-proof-log");
      return m ? { first: document.body.firstElementChild === m, text: m.textContent, date: m.querySelector("time")?.textContent ?? "" } : null;
    })()`);
    await tab.goto(`${testSite.origin}/`);
    const home = await markOf(tab);
    check(home?.text === mark, `the Worker's home page has the mark: "${home?.text}"`);
    await tab.goto(`${testSite.origin}/proof`);
    await tab.waitFor(step("before"), "the test site's build's step 1");
    const shown = await markOf(tab);
    check(mark !== copy && shown !== null && shown.first && shown.text === mark && shown.date === CLEARED_ON, `the card proof page has the same mark, above everything else, its date in an element of its own: ${JSON.stringify(shown)}`);
    // The scope string the build's target has the card sign, as the page that runs says it (src/ui/test-proof-log.ts reads the target the flow reads).
    const signs = await tab.eval<string>(`document.querySelector("p.test-proof-log").dataset.scope`);
    check(signs === SCOPE && signs === "iamreal-test:public:0__________", `the test site's build signs the test log's scope string: ${signs}`);
    // The link of the last screen is the card's page on the test site. The screen itself needs a card proof, which this build
    // makes only with a real card: read from the scripts the page was sent.
    const sent = [...new Set(browser.responses.filter((r) => r.url.startsWith(`${testSite.origin}/proof/assets/`) && r.url.endsWith(".js")).map((r) => r.url))];
    const scripts = (await Promise.all(sent.map(async (u) => (await fetch(u)).text()))).join("\n");
    // iamreal.tw only as the site's name in the header, which stays on the test site (design/copy/test-site.md).
    const withoutName = scripts.replace(/site_name:["'`]iamreal\.tw["'`]/, "");
    check(sent.length > 0 && /["'`]test\.iamreal\.tw["'`]/.test(scripts) && !/["'`]iamreal\.tw["'`]/.test(withoutName), `the scripts the page was sent write links with test.iamreal.tw, not iamreal.tw (${sent.length} scripts)`);
    const doc = browser.responses.filter((r) => r.url === `${testSite.origin}/proof`).at(-1);
    check(
      doc?.headers["content-security-policy"] === TEST_SITE_CONTENT_SECURITY_POLICY &&
        doc.headers["document-isolation-policy"] === ISOLATION_HEADERS["Document-Isolation-Policy"] &&
        doc.headers["cross-origin-opener-policy"] === OPENER_HEADERS["Cross-Origin-Opener-Policy"] &&
        doc.headers["x-robots-tag"] === "noindex",
      `the test site's headers on the page: ${JSON.stringify(doc?.headers)}`,
    );
    check(await tab.eval<boolean>("crossOriginIsolated"), "the test site's build is cross-origin isolated");
    // Threads only, as the production build (#309): step 1 of one platform.
    check(!(await tab.eval<boolean>(`!!document.querySelector('[data-one-proof]')`)), "the test site's build's step 1 is the one of one platform: no sentence of what the proof lists");
    check(!(await tab.text()).includes(C.before.listed_together), "the test site's build's step 1 does not say the accounts are listed together");
    await screenshot("testsite-1-before", tab);
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
    await screenshot("testsite-1-before-phone", tab);
    await tab.send("Emulation.clearDeviceMetricsOverride");
    await sleep(1000);
    const requests = browser.requests.filter((r) => r.sessionId === tab.sessionId || browser.sessions.get(r.sessionId)?.url.startsWith(testSite.origin)).map((r) => r.url);
    check(requests.length > 0 && requests.every((u) => u.startsWith("about:") || new URL(u).origin === testSite.origin), `the test site's build's step 1 asked for nothing outside its own origin ${JSON.stringify(requests.filter((u) => !u.startsWith(testSite.origin)).slice(0, 5))}`);
    check(componentRequests.length === 0, `the test site's build's step 1 asked nothing of the component ${JSON.stringify(componentRequests)}`);
    // The help page is gone: its old address, which the apps still link to, is the site's /prepare.
    await tab.goto(`${testSite.origin}/proof/help.html?topic=more`);
    const landed = await tab.waitFor<string>(`location.pathname === "/prepare" ? location.pathname : null`, "the old address of the help page, redirected").catch(() => "");
    check(landed === "/prepare", `/proof/help.html goes to /prepare: ${await tab.eval<string>("location.href")}`);
    const violations = browser.logs.slice(logsBefore).filter((l) => /Content Security Policy/i.test(l.text));
    check(violations.length === 0, `no Content-Security-Policy violation on the test site's build ${JSON.stringify(violations.map((l) => l.text))}`);
  } finally {
    off();
    await browser.send("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined);
    await testSite.close();
  }
});

writeFileSync(join(out, "ui-report.json"), JSON.stringify({ results, shown, component: component.requests.map((r) => ({ func: r.func, tbs: r.tbs })) }, null, 2));
await browser.close();
await component.stop();
writeFileSync(join(out, "worker.log"), worker.logLines().join("\n"));
await site.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
