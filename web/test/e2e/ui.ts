// The whole card proof from the screen, in headless Chrome, against the real
// server: test keys, a fake card behind a fake component, a fake MOICA for
// the mirror. Nothing real: no card, no PIN, no certificate, no MOICA key.
//
//   IAMREAL_BB=/path/to/bb node --experimental-strip-types test/e2e/ui.ts
//
// 1. Makes throwaway issuer keys (G2, G3), cards and CRLs (test/fixtures/).
// 2. Builds the server with the tag iamrealtest (server/testissuers.go) and
//    runs it with those issuer keys, a fake MOICA, the test roster (its
//    platform table: test-example and threads), and the page built in mode
//    "test" (vite.config.ts) as its web directory.
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
//    cardholder, kind_mismatch); the third switch; the fourth that the web
//    page does not make (the row's lines; the engine refuses it); a fourth
//    switch made with a card's state that hid one, refused by the server's
//    policy (switch_restricted); a platform the page does not know (the
//    config without its row): the account kept in the list as it is; then
//    the server restarted with -accept-restricted-switches: the fourth and
//    fifth switches recorded, step 4 saying none is left, and a sixth
//    refused by the roster rules (switch_limit). Along the way: a submission
//    that did not get through (再試一次), one the server refused (its
//    request ID on the screen); 回到開頭 and 取消 on steps 4 and 5, then card
//    proofs again on the same page with the same proof engine; step 3's
//    上一步; the PIN's wait running out; a window the browser blocked on each
//    of the three clicks; every case that stops before the PIN is asked,
//    each written under its item (and a platform table the page cannot
//    read); a card's state it cannot read; a wrong PIN, a locked card, a PIN
//    that is not sent; 確認卡片 pressed again while the card is confirmed;
//    the preview of a profile (a new tab, nothing else); 複製連結. The
//    card's records fall on several days: the server's clock (-test-clock)
//    and the page's (Date.now) move ahead together, and the fake MOICA
//    publishes a CRL each day, fetched by the server's mirror.
// 5. Publishes the daily snapshot and re-verifies it with iamreal-verify:
//    every record valid, the kinds those the screens showed, the card's list
//    the one step 6 showed last. Then other cards: two cards declaring the
//    same account (還有別的卡片也宣告了), an answer whose kinds cannot be read
//    (名冊已經記下這次過卡), and an answer lost after the server appended the
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
//
// The browser resolves no host name but localhost and 127.0.0.1
// (--host-resolver-rules): the preview's new tab, on the platform's
// address, gets no further than its name.
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, createServer as netServer } from "node:net";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { SITE_DOMAIN, cardPath, handle, presentationOf } from "../../src/platforms.ts";
import { scopeOf } from "../../src/spec/scope.ts";
import { shortId } from "../../src/spec/scoped-id.ts";
import { STORAGE_KEY_PREFIX } from "../../src/storage.ts";
import { COPY, fill } from "../../src/ui/copy.ts";
import { CERT_POLICIES, KEY_USAGE_ENCRYPTION, AUTHORITY_KEY_ID, SUBJECT_KEY_ID, buildTbs, certificate, name, subjectDirectoryAttributes } from "../fixtures/certs.ts";
import { makeCrl } from "../fixtures/crls.ts";
import { type TestKey, hex, makeKey } from "../fixtures/der-build.ts";
import { randomSerials, testIssuerKeys } from "../fixtures/world.ts";
import { Browser, Page, sleep } from "./cdp.ts";
import { FakeComponent, type FakeCardSpec } from "./fake-component.ts";
import { CONTENT_SECURITY_POLICY, ISOLATION_HEADERS, OPENER_HEADERS } from "./headers.ts";

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
/** The test roster's scope string: the first signature signs it (src/spec/scope.ts). */
const SCOPE = scopeOf("test");
/** The test roster's platform table, as the server's config sends it (spec/scope.md). */
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
const issuersDir = join(out, "issuers");
mkdirSync(issuersDir);
for (const n of ["G2", "G3"] as const) writeFileSync(join(issuersDir, `issuer-${n}.der`), issuerKeys[n].spki);

const yymmdd = (d: Date) => d.toISOString().slice(2, 10).replace(/-/g, "");
const taiwanDate = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
/**
 * The test's clock, the server's and the page's together, runs `day` whole
 * days ahead of the machine's (setDay below): a card has at most 3 valid
 * records a day (spec/roster-rules.md, check 6), a switch counts once a day
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

const moica = createServer((req, res) => {
  const m = /^\/(G2|G3)\.crl$/.exec(req.url ?? "");
  if (!m) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "application/pkix-crl" }).end(Buffer.from(crls[m[1] as "G2" | "G3"]));
});
await new Promise<void>((r) => moica.listen(0, "127.0.0.1", r));
const moicaUrl = `http://127.0.0.1:${(moica.address() as AddressInfo).port}`;

// 2. The server and the page -----------------------------------------------------

console.log("building the server (tag iamrealtest) and iamreal-verify");
const serverBin = join(out, "iamreal-server");
const verifyBin = join(out, "iamreal-verify");
execFileSync("go", ["build", "-tags", "iamrealtest", "-o", serverBin, "./server"], { cwd: repo, stdio: "inherit" });
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
    __IAMREAL_TEST_ISSUERS__: JSON.stringify([
      { name: "G2", modulus: issuerKeys.G2.modulus.toString(16), bits: 2048 },
      { name: "G3", modulus: issuerKeys.G3.modulus.toString(16), bits: 4096 },
    ]),
    __IAMREAL_TEST_COMPONENT__: JSON.stringify(COMPONENT),
    __IAMREAL_TEST_IDLE_MS__: JSON.stringify(IDLE_MS),
  },
  build: { outDir: dist, emptyOutDir: true },
});

const freePort = async (): Promise<number> => {
  const s = netServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
};
const serverPort = await freePort();
const data = join(out, "data");
/** The server's -test-clock: the days its clock runs ahead. */
const clockFile = join(out, "clock-days");
writeFileSync(clockFile, "0");
let serverLog = "";
const TEST_OPTIONS = ["-test-issuers", issuersDir, "-test-moica", moicaUrl];
let server: ChildProcess;
/**
 * Starts the server on its port, with the same data: the roster carries
 * over. `acceptRestricted`: -accept-restricted-switches (the fourth and fifth
 * switch of a slot accepted; refused by default, switch_restricted).
 */
async function startServer(o: { acceptRestricted?: boolean } = {}): Promise<void> {
  server = spawn(
    serverBin,
    [
      "serve",
      "-data",
      data,
      "-bb",
      BB!,
      "-crs",
      crsDir,
      "-addr",
      `127.0.0.1:${serverPort}`,
      "-web",
      dist,
      "-roster",
      "test",
      ...TEST_OPTIONS,
      "-test-clock",
      clockFile,
      ...(o.acceptRestricted ? ["-accept-restricted-switches"] : []),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  server.stderr!.on("data", (b: Buffer) => (serverLog += b.toString()));
  const t0 = Date.now();
  for (;;) {
    const lines = await fetch(`http://127.0.0.1:${serverPort}/crl/index.jsonl`)
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "");
    if (lines.split("\n").filter(Boolean).length >= 2) break;
    if (Date.now() - t0 > 30_000) throw new Error(`the server did not start, or its mirror did not fetch the CRLs:\n${serverLog}`);
    await sleep(200);
  }
}
async function stopServer(): Promise<void> {
  const exited = new Promise<void>((r) => server.once("exit", () => r()));
  server.kill();
  await exited;
}
await startServer();
const PAGE_ORIGIN = `http://localhost:${serverPort}`;
const PAGE = `${PAGE_ORIGIN}/`;

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
 * Moves the server's and the page's clocks to `n` days ahead, and has the
 * fake MOICA publish that day's CRL, which the server's mirror fetches.
 */
async function setDay(n: number): Promise<void> {
  day = n;
  writeFileSync(clockFile, String(n));
  crls.G3 = await g3CrlOf(n);
  g3Number = 300 + n;
  // Not execFileSync: the fake MOICA answers from this process.
  await promisify(execFile)(serverBin, ["mirror", "-data", data, ...TEST_OPTIONS]);
  await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockScript });
  clockScript = (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: clockSource(n) })).identifier as string;
  await page.eval(`window.__iamrealClockDays = ${n}`).catch(() => undefined);
  console.log(`\n== day ${n}: ${today()}`);
}
/** Moves the page's clock alone to `days` (whole or not) ahead of the machine's; the server's stays. */
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
const stepLine = (n: number) => fill(C.common.step, { step: n, steps: 6 });

/** A new page load: step 1. */
async function open(): Promise<void> {
  await page.goto(PAGE);
  await waitStep("before", "step 1");
}

const componentCount = (func?: string) => component.requests.filter((r) => func === undefined || r.func === func).length;
const popupCount = () => new Set(browser.requests.filter((r) => r.url.startsWith(COMPONENT + "/popupForm")).map((r) => r.sessionId)).size;
const cardStateCount = () => browser.requests.filter((r) => r.url.endsWith("/api/v1/card-state")).length;
const challengeCount = () => browser.requests.filter((r) => r.url.endsWith("/api/v1/challenges")).length;
const recordCount = async (): Promise<number> => (await (await fetch(`http://127.0.0.1:${serverPort}/api/v1/head`)).json()).count;

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
}
const items = (list: "read" | "progress") =>
  page.eval<Item[]>(
    `[...document.querySelectorAll('[data-list="${list}"] [data-item]')].map((li) => ({ item: li.dataset.item, state: li.dataset.state, st: li.querySelector(".st").innerText, why: li.querySelector("[data-why]")?.innerText ?? "" }))`,
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
  lead: string[];
  rows: RowSeen[];
  buttons: string[];
  main: string;
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
    lead: await page.eval<string[]>(`[...document.querySelectorAll('[data-status], [data-fact]')].map((e) => e.innerText)`),
    rows: await rowsOnScreen(),
    buttons: await buttonTexts(),
    main: await page.text(),
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
  /** With one platform, the sentence in place of listed together; "" if none. */
  listedSingle: string;
  withdrawStays: boolean;
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
    listedSingle: await page.text(`[data-step="confirm"] [data-listed-single]`),
    withdrawStays: await page.eval<boolean>(`!!document.querySelector('[data-withdraw-stays]')`),
  };
}

/** Types the rows of step 4 (`entries`: platform → what to type, "" to empty it) and presses 下一步. */
async function typeRows(entries: Record<string, string>): Promise<void> {
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
 * (a server that reports something else than its roster holds, or an answer
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
  }
};

/** The short IDs step 6 showed (from its link), each card proof done. */
const shown: string[] = [];

/** From step 1 (after a page load, 取消, 回到開頭 or the wait running out) to step 2. */
async function toRead(o: { screenshots?: string } = {}): Promise<void> {
  await waitStep("before", "step 1");
  const s1 = await page.text();
  for (const s of [C.before.title, C.before.prepare_card, C.before.citizens_only, C.before.one_proof, C.before.listed_together, C.before.why_physical, C.before.how_to_get]) check(s1.includes(s), `step 1 says "${s}"`);
  // The test build knows two platforms (test-example and threads): step 1 does not speak of one.
  check((await page.text("[data-one-proof]")) === C.before.one_proof, `step 1: the test build knows more than one platform: "${await page.text("[data-one-proof]")}"`);
  check(!(await page.eval<boolean>(`!!document.querySelector('[data-step="before"] details [data-listed-together]')`)), "step 1: that the accounts are listed together is not in a question to open");
  check((await whereText()).includes(stepLine(1)), `step 1: "${await whereText()}"`);
  check((await page.text("header")) === C.common.service_name, `the header: the mark and "${C.common.service_name}"`);
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
  if (o.screenshots) await screenshot(`${o.screenshots}-2-read-done`);
  await page.clickButton(C.common.next);
  await waitStep("pin", "step 3");
  check((await whereText()).includes(stepLine(3)), "step 3: 第 3 步，共 6 步");
  const s3 = await page.text();
  check((await page.text("[data-card-read]")) === [C.pin.card_read, "測試用戶", C.pin.name_note].join("\n"), `step 3: the name, and that it stays here: ${JSON.stringify(await page.text("[data-card-read]"))}`);
  for (const s of [C.pin.purpose, C.pin.stays, C.pin.card_and_pin]) check(s3.includes(s), `step 3, next to the PIN field: "${s}"`);
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
  check(lastSign.tbs === SCOPE && lastSign.pin === PIN, `the first signature: the test roster's public scope string (${lastSign.tbs}), with the PIN`);
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

/** The notes of step 4 below the list, by the card's state. */
function checkAccountsNotes(label: string, st: AccountsSeen, kind: "never" | "declared" | "nothing"): void {
  const has = (s: string) => st.main.includes(s);
  const a = C.accounts;
  check(st.state === kind, `${label}: step 4 is "${st.state}"`);
  check(has(a.no_check) && has(a.acknowledged) && has(a.preview_note) && has(a.switches_limited), `${label}: step 4, that the account is not checked, the preview, that switches are limited`);
  check(has(a.how_refresh) === (kind === "declared"), `${label}: card proof again explained ${kind === "declared" ? "" : "not "}(什麼都不改……)`);
  check(has(a.how_change) === (kind !== "never") && has(a.one_per_platform) === (kind === "never"), `${label}: how to change the list`);
  check(!has("還有平台沒填"), `${label}: no nudge to fill every platform`);
  check(JSON.stringify(st.buttons.filter((b) => b !== C.accounts.preview)) === JSON.stringify([C.common.next, C.common.cancel]), `${label}: step 4 buttons ${JSON.stringify(st.buttons)}`);
}

/**
 * Step 5: the whole list to be signed, each row's platform name and ID and what happens; the buttons.
 * `single`: the one platform's name, when the screens speak of one platform.
 */
function checkConfirm(label: string, c: ConfirmSeen, want: [platform: string, name: string, account: string, kinds: string[]][], button: string, single: string | null = null): void {
  const rows = c.rows.map((r) => [r.platform, r.name, r.account, r.kinds]);
  check(JSON.stringify(rows) === JSON.stringify(want), `${label}: step 5's list ${JSON.stringify(rows)}`);
  check(c.rows.every((r) => r.id === r.platform), `${label}: step 5 shows each platform's ID beside its name`);
  const empty = button === C.confirm.button_withdraw_all;
  check(c.intro === (empty ? C.confirm.intro_withdraw_all : single !== null ? C.confirm.intro_single : C.confirm.intro), `${label}: step 5's first sentence "${c.intro}"`);
  check(c.main.includes(today()) && c.main.includes(C.confirm.short_id_label) && c.main.includes(C.confirm.no_identity) && c.main.includes(C.confirm.permanent), `${label}: step 5, the date, the short ID, that the record has no name, that it cannot be deleted`);
  check(c.listedTogether === (!empty && single === null), `${label}: step 5 ${!empty && single === null ? "says" : "does not say"} the accounts are listed together`);
  const listedSingle = !empty && single !== null ? fill(C.confirm.listed_single, { platform: single }) : "";
  check(c.listedSingle === listedSingle, `${label}: step 5 ${listedSingle ? `says "${listedSingle}"` : "does not say this one account is listed"} ("${c.listedSingle}")`);
  check(c.withdrawStays === want.some((r) => r[3].includes(C.kinds.withdraw)), `${label}: step 5, that a withdrawn account's records stay`);
  check(c.main.includes(empty ? C.confirm.later_withdraw : C.confirm.later), `${label}: step 5, what can be done later`);
  check(JSON.stringify(c.buttons) === JSON.stringify([C.common.back, button, C.common.cancel]), `${label}: step 5 buttons ${JSON.stringify(c.buttons)}`);
}

interface DoneSeen {
  title: string;
  card: [string, string][];
  link: string;
  record: [string, string, string[], boolean, string][];
  newCard: boolean;
  withdrawnLink: boolean;
  otherCards: string[];
  kindsUnreadable: boolean;
  /** Where to put the link (done.put_link or done.put_link_single); "" if none. */
  putLink: string;
  /** The points under what the roster recorded. */
  points: string[];
  main: string;
}

const doneSeen = async (): Promise<DoneSeen> => ({
  ...(await page.eval<Omit<DoneSeen, "main">>(`({
    title: document.querySelector('[data-step="done"] h1').innerText,
    card: [...document.querySelectorAll('[data-proof] dl.list dt')].map((dt) => [dt.innerText, dt.nextElementSibling.innerText]),
    link: document.querySelector('[data-link]')?.innerText ?? "",
    record: [...document.querySelectorAll('dt[data-done-row]')].map((dt) => {
      const dd = dt.nextElementSibling;
      return [dt.innerText, dd.querySelector('.acct').innerText, [...dd.querySelectorAll('[data-kind]')].map((e) => e.innerText), dd.hasAttribute('data-mismatch'), dd.querySelector('[data-code]')?.innerText ?? ""];
    }),
    newCard: !!document.querySelector('[data-new-card]'),
    withdrawnLink: !!document.querySelector('[data-withdrawn-link]'),
    otherCards: [...document.querySelectorAll('[data-other-cards]')].map((e) => e.innerText),
    kindsUnreadable: !!document.querySelector('[data-kinds-unreadable]'),
    putLink: document.querySelector('[data-put-link]')?.innerText ?? "",
    points: [...document.querySelectorAll('[data-step="done"] ul.three li')].map((e) => e.innerText),
  })`)),
  main: await page.text(),
});

interface DoneExpected {
  label: string;
  title: string;
  /** The card's list after the record: [name, account]; empty when everything was withdrawn. */
  card: [string, string][];
  /** The record's rows: [name, account, kind sentences]; null when the answer's kinds could not be read. */
  record: [string, string, string[]][] | null;
  newCard?: boolean;
  withdrawnLink?: boolean;
  otherCards?: string[];
  /** Platforms whose recorded kind is not what step 5 said: the code kind_mismatch under them. */
  mismatch?: string[];
  /** The one platform's name, when the screens speak of one platform. */
  single?: string;
}

function checkDone(o: DoneExpected, d: DoneSeen | null, message = ""): void {
  if (!check(d !== null, `${o.label}: done ${message}`)) return;
  const v = d!;
  check(v.title === o.title, `${o.label}: step 6's title "${v.title}"`);
  const withdrawAll = o.card.length === 0;
  check(JSON.stringify(v.card) === JSON.stringify(o.card), `${o.label}: the card lists ${JSON.stringify(v.card)}`);
  const sid = /^iamreal\.tw\/p\/([0-9A-Z]{10})$/.exec(v.link)?.[1] ?? (/島民編號開頭是 ([0-9A-Z]{10})。/.exec(v.main)?.[1] ?? "");
  check(withdrawAll ? v.link === "" : v.link === `${SITE_DOMAIN}/${cardPath(sid)}`, `${o.label}: the link is the card's page ${v.link}`);
  check(v.main.includes(C.done.recorded) && v.main.includes(today()) && v.main.includes(C.done.trust) && v.main.includes(C.done.unplug), `${o.label}: step 6, the roster's line, its date, that anyone can verify, unplug`);
  check(v.main.includes(C.done.advice) === !withdrawAll && v.main.includes(C.done.put_up) === !withdrawAll, `${o.label}: the advice to come back and how to put it up ${withdrawAll ? "are not there" : "are there"}`);
  const putLink = withdrawAll ? "" : o.single ? fill(C.done.put_link_single, { platform: o.single }) : C.done.put_link;
  check(v.putLink === putLink, `${o.label}: where to put the link "${v.putLink}"`);
  // The points: the advice and that a renamed account comes back, when the list is not empty; then that anyone can verify.
  const points = [...(withdrawAll ? [] : [C.done.advice, C.done.renamed]), `${C.done.trust} ${C.links.verify}`];
  check(JSON.stringify(v.points) === JSON.stringify(points), `${o.label}: step 6's points ${JSON.stringify(v.points)}`);
  if (o.record === null) {
    check(v.kindsUnreadable && v.record.length === 0 && !v.main.includes(C.done.record_list), `${o.label}: the kinds could not be read: the date and that sentence only`);
  } else {
    const rows = v.record.map((r) => [r[0], r[1], r[2]]);
    check(JSON.stringify(rows) === JSON.stringify(o.record), `${o.label}: the record's rows ${JSON.stringify(rows)}`);
    const recordLine = withdrawAll ? C.done.record_withdraw_all : o.single ? C.done.record_single : C.done.record_list;
    check(v.main.includes(recordLine), `${o.label}: the record's line "${recordLine}"`);
    const mismatch = v.record.filter((r) => r[3]).map((r) => r[0]);
    const want = (o.mismatch ?? []).map((p) => (p === THREADS ? THREADS_NAME : p === EXAMPLE ? EXAMPLE_NAME : p));
    check(JSON.stringify(mismatch) === JSON.stringify(want) && v.record.every((r) => r[4] === (r[3] ? "kind_mismatch" : "")), `${o.label}: what the server recorded and what step 5 said ${want.length ? "differ on " + want.join(", ") + " (kind_mismatch)" : "are the same"}`);
    const sidLine = fill(C.done.short_id, { short_id: sid });
    check(withdrawAll || v.main.includes(sidLine), `${o.label}: ${sidLine}`);
  }
  check(v.newCard === !!o.newCard, `${o.label}: ${o.newCard ? "says" : "does not say"} a new card has a new link`);
  check(v.withdrawnLink === !!o.withdrawnLink, `${o.label}: ${o.withdrawnLink ? "says" : "does not say"} the withdrawn account's link can go`);
  const others = (o.otherCards ?? []).map((a) => fill(C.done.other_cards, { account: a }));
  check(JSON.stringify(v.otherCards) === JSON.stringify(others), `${o.label}: other cards ${JSON.stringify(v.otherCards)}`);
  check(!/[✓✔]/.test(v.main), `${o.label}: step 6, no check mark`);
  const lines = v.main.split("\n").filter(Boolean);
  check(lines.at(-1) === C.done.restart, `${o.label}: step 6 ends with the button "${lines.at(-1)}"`);
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
    ? fill(A.row_no_switches_yet, { switches_left: 3 })
    : used < 3
      ? fill(A.row_switches, { switches_used: used, switches_left: 3 - used })
      : used < 5
        ? fill(A.row_app_later, { switches_used: used })
        : fill(A.row_used_up, { switches_used: used });
const lastProof = (daysAgo: number) => fill(A.current, {}) + (daysAgo === 0 ? A.last_card_proof_today : fill(A.last_card_proof, { days_ago: daysAgo }));

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
  const hrefs = await page.eval<string[]>(`[...document.querySelectorAll('main a')].map((a) => a.getAttribute("href") + " " + a.target + " " + a.rel)`);
  check(
    hrefs.includes("/help.html?topic=proof _blank noopener noreferrer") && hrefs.includes("/help.html?topic=verify _blank noopener noreferrer"),
    `step 6: 打開這張島民證明 and 怎麼驗證 lead to the help page, in a new tab ${JSON.stringify(hrefs)}`,
  );
  check(await page.eval<boolean>(`!!document.querySelector('[data-step="done"] .hero svg.logo-animated')`), "step 6: the mark's animation");
});

// The page's headers and isolation, read from the first load.
{
  const doc = browser.responses.find((r) => r.url === PAGE);
  check(doc?.headers["content-security-policy"] === CONTENT_SECURITY_POLICY, `the page's Content-Security-Policy: ${doc?.headers["content-security-policy"]}`);
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
  check(JSON.stringify(st.lead) === JSON.stringify([lastProof(0)]), `step 4: ${JSON.stringify(st.lead)}`);
  checkAccountsNotes("refresh", st, "declared");
  checkRows("refresh", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "", [A.row_unused]], [THREADS]: [THREADS_NAME, "alice", [count(0), A.row_today]] });
  await page.clickButton(C.common.next);
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
  check(st.state === "daily_limit" && JSON.stringify(st.lead) === JSON.stringify([lastProof(0)]), `step 4: ${st.state} ${JSON.stringify(st.lead)}`);
  checkRows("3 records today", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "", [], { fixed: true }], [THREADS]: [THREADS_NAME, at("alicia"), [], { fixed: true }] });
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
  check(JSON.stringify(st.lead) === JSON.stringify([lastProof(1)]), `step 4: ${JSON.stringify(st.lead)}`);
  checkRows("add", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "", [A.row_unused]], [THREADS]: [THREADS_NAME, "alicia", [count(0)]] });
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
      [THREADS, THREADS_NAME, at("bob"), [fill(K.switch, { previous: at("alicia") }), fill(C.confirm.uses_switch, { switches_left: 2 })]],
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
  checkRows("withdraw one", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0), A.row_today]], [THREADS]: [THREADS_NAME, "bob", [count(1), A.row_today]] });
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
  check(/^[0-9a-f]{16}$/.test(id) && res?.headers["x-request-id"] === id && serverLog.includes(`"error":"daily_limit"`), `the request ID on the screen (${id}) is the response's, and the server logged daily_limit`);
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
  checkRows("withdraw all", st.rows, {
    [EXAMPLE]: [EXAMPLE_NAME, "", [fill(A.row_withdrawn, { last_declared: "a-b" }), count(0)]],
    [THREADS]: [THREADS_NAME, "bob", [count(1)]],
  });
  await screenshot("withdraw-all-4-accounts");
  await typeRows({ [THREADS]: "" });
  checkConfirm("withdraw all", await waitConfirm(), [[THREADS, THREADS_NAME, at("bob"), [K.withdraw]]], C.confirm.button_withdraw_all);
  await screenshot("withdraw-all-5-confirm");
  await finish({ label: "withdraw all", button: C.confirm.button_withdraw_all, title: C.done.withdraw_all, card: [], record: [[THREADS_NAME, at("bob"), [K.withdraw]]], screenshots: "withdraw-all" });
  const v = await doneSeen();
  check(!(await page.eval<boolean>(`!!document.querySelector('[data-step="done"] .hero')`)) && v.link === "" && !v.main.includes(C.done.proof + "\n"), "everything withdrawn: no animation, no card, no link");
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
// correction, not counted. The roster records a switch, and step 6 says that
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
  check(JSON.stringify(st.lead) === JSON.stringify([lastProof(0)]), `step 4 as the wrong state says: ${JSON.stringify(st.lead)}`);
  checkRows("correction_date today", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, "bob", [count(1), A.row_today]] });
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

await tryStep("the third switch (@carol to @dave): none left on the web after it", async () => {
  const st = await toAccounts();
  checkRows("two switches", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, "carol", [count(2)]] });
  await typeRows({ [THREADS]: "dave" });
  checkConfirm(
    "the third",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS, THREADS_NAME, at("dave"), [fill(K.switch, { previous: at("carol") }), C.confirm.uses_last_switch]],
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

await tryStep("3 switches: the row says none is left on the web; another account typed anyway is refused; 取消 on step 5", async () => {
  const st = await toAccounts();
  checkRows("three switches", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, "dave", [count(3), A.row_can_clear]] });
  await screenshot("web-limit-4-accounts");
  const requests = componentCount();
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await typeRows({ [THREADS]: "erin" });
  const why = (await rowsOnScreen()).find((r) => r.platform === THREADS)!.why;
  check(why === A.row_cannot_switch && (await page.eval<boolean>(`!!${step("accounts")}`)), `a fourth switch on the web: refused, the sentence under the row ("${why}")`);
  await screenshot("web-limit-4-accounts-refused");
  check(componentCount() === requests && challengeCount() === challenges, "refused: nothing asked of the component, no challenge");
  await typeRows({ [THREADS]: "dave" });
  await waitConfirm();
  await page.clickButton(C.common.cancel);
  await backAtTheBeginning("取消 on step 5");
  await sleep(500);
  check(componentCount("MakeSignature") === signs && challengeCount() === challenges, "取消 on step 5: no second signature, no challenge");
});

// The card's state hides a switch (2 where the roster has 3): the page makes
// what it takes for the third switch, the server finds the fourth, and its
// policy refuses it by default (switch_restricted).
await tryStep("a fourth switch the server's policy refuses (switch_restricted)", async () => {
  const undo = await rewrite("*/api/v1/card-state", (b) => void (b.platforms.threads.switch_count = 2));
  try {
    await toAccounts({ samePage: true });
  } finally {
    await undo();
  }
  await typeRows({ [THREADS]: "erin" });
  checkConfirm(
    "a fourth, shown as the third",
    await waitConfirm(),
    [
      [EXAMPLE, EXAMPLE_NAME, "a-b", [K.unchanged]],
      [THREADS, THREADS_NAME, at("erin"), [fill(K.switch, { previous: at("dave") }), C.confirm.uses_last_switch]],
    ],
    C.confirm.button_declare,
  );
  const before = await recordCount();
  await page.clickButton(C.confirm.button_declare);
  const d = await waitDoneOrMessage();
  const id = await page.text("[data-request-id]");
  const expected = fill(C.stops.rejected, { code: "switch_restricted" });
  check(!d.done && d.item === "submit" && d.message === `${expected}\n${fill(C.stops.request_id, { request_id: id })}`, `switch_restricted, under 送出: ${JSON.stringify(d.message)}`);
  const res = browser.responses.filter((r) => r.url.endsWith("/api/v1/records") && r.status === 403).at(-1);
  check(res?.headers["x-request-id"] === id && serverLog.includes(`"error":"switch_restricted"`), `403 switch_restricted, its request ID on the screen (${id})`);
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
  checkRows("unknown", st.rows, { [EXAMPLE]: [EXAMPLE, "a-b", [A.row_unknown_platform], { fixed: true }], [THREADS]: [THREADS_NAME, "dave", [count(3), A.row_can_clear]] });
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
  await page.clickButton(C.common.next);
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
  await page.clickButton(C.common.next);
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

// The server's policy opened: -accept-restricted-switches ---------------------------

await tryStep("the server restarted with -accept-restricted-switches", async () => {
  await stopServer();
  await startServer({ acceptRestricted: true });
  const config = await (await fetch(`http://127.0.0.1:${serverPort}/api/v1/config`)).json();
  check(Array.isArray(config.platforms) && config.platforms.length === 2, "the server answers again, on the same address, with the same roster");
});

/** A fourth or fifth switch: the card's state hides the switches beyond 2 (the web page makes no more), the server records it. */
async function hiddenSwitch(label: string, from: string, to: string, used: number): Promise<void> {
  const seen: any[] = [];
  const undo = await rewrite("*/api/v1/card-state", (b) => void (b.platforms.threads.switch_count = 2), seen);
  try {
    await toAccounts();
  } finally {
    await undo();
  }
  check(seen[0]?.platforms?.threads?.switch_count === used, `${label}: the roster has ${seen[0]?.platforms?.threads?.switch_count} switches`);
  await typeRows({ [THREADS]: to });
  await waitConfirm();
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
await tryStep("the fourth switch, accepted by the server's policy (@dave to @erin)", () => hiddenSwitch("the fourth switch", "dave", "erin", 3));
await setDay(7);
await tryStep("the fifth switch (@erin to @frank)", () => hiddenSwitch("the fifth switch", "erin", "frank", 4));
await setDay(8);

await tryStep("5 switches: step 4 says none is left; a sixth refused by the roster rules (switch_limit)", async () => {
  const st = await toAccounts();
  checkRows("five switches", st.rows, { [EXAMPLE]: [EXAMPLE_NAME, "a-b", [count(0)]], [THREADS]: [THREADS_NAME, "frank", [count(5), A.row_can_clear]] });
  await screenshot("used-up-4-accounts");
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
  check(!d.done && d.item === "submit" && d.message === `${C.stops.switch_limit}\n${fill(C.stops.request_id, { request_id: id })}`, `the roster rules' switch_limit, under 送出: ${JSON.stringify(d.message)}`);
  check((await recordCount()) === before && serverLog.includes(`"error":"switch_limit"`), "nothing appended; the server logged switch_limit");
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
    check(!d.done && d.item === "server" && d.message === C.stops.date_changed, `under 連上島民的伺服器: "${d.message}" (${d.item})`);
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

/** The kinds of the main card's records, in roster order, as the screens' step 6 showed them. */
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
await tryStep("snapshot and iamreal-verify", async () => {
  execFileSync(serverBin, ["snapshot", "-data", data, "-bb", BB, "-crs", crsDir, "-roster", "test", "-test-issuers", issuersDir, "-test-clock", clockFile], { stdio: "pipe" });
  const v = JSON.parse(
    execFileSync(verifyBin, ["-bb", BB, "-crs", crsDir, "-roster", "test", "-json", "-test-issuers", issuersDir, "-crl-archive", join(data, "crl"), join(data, "roster")], { stdio: ["ignore", "pipe", "pipe"] }).toString(),
  );
  writeFileSync(join(out, "verify.json"), JSON.stringify(v, null, 2));
  const kinds = v.results.map((r: { valid: boolean; kinds?: { platform: string; kind: string }[] }) => (r.valid ? r.kinds!.map((k) => [k.platform, k.kind]) : null));
  check(v.valid === true && v.results.every((r: { valid: boolean }) => r.valid) && JSON.stringify(kinds) === JSON.stringify(KINDS), `iamreal-verify: valid, every record valid, the kinds the screens showed: ${JSON.stringify(kinds)}`);
  check(shown.length === KINDS.length, `the screens showed ${shown.length} card proofs done`);
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

await tryStep("a challenge dated another day: stopped under 連上島民的伺服器", async () => {
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
  check(!d.done && d.item === "server" && d.message === C.stops.date_mismatch, `challenge of another day, under 連上島民的伺服器: "${d.message}" (${d.item})`);
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
async function stopsBeforePin(label: string, card: FakeCardSpec | null, expected: string, item: string, o: { setup?: () => Promise<() => Promise<void>>; silent?: boolean; screenshot?: string; requestId?: boolean } = {}): Promise<void> {
  component.card = card;
  component.silent = o.silent ?? false;
  await open();
  await toRead();
  const undo = o.setup ? await o.setup() : null;
  const signs = componentCount("MakeSignature");
  const cardStates = cardStateCount();
  const r = await readCard();
  // An answer of the server the page cannot read: its request ID on the next line (research/57, 14).
  const why = o.requestId ? r.why.split("\n")[0] : r.why;
  const idLine = o.requestId ? (r.why.split("\n")[1] ?? "") : "";
  check(!r.done && r.item === item && why === expected, `${label}: under "${item}": "${r.why}"`);
  if (o.requestId) check(new RegExp("^" + fill(C.stops.request_id, { request_id: "[0-9a-f]{16}" }) + "$").test(idLine), `${label}: the request ID on the next line: "${idLine}"`);
  const list = await items("read");
  const at = READ_KEYS.indexOf(item);
  check(list[at]?.st === C.common.halted && list.slice(at + 1).every((i) => i.state === ""), `${label}: 停在這裡, nothing after it ${JSON.stringify(list.map((i) => i.state))}`);
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
  ["the component does not answer", main.spec(), C.stops.component_unreachable + " " + C.links.prepare, "component", { silent: true, screenshot: "stop-2-component" }],
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
await tryStep("the answer's kinds the page cannot read: 名冊已經記下這次過卡", async () => {
  component.card = other.spec();
  await toAccounts();
  await page.clickButton(C.common.next);
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

await tryStep("a 201 whose body the page cannot read: 名冊已經記下這次過卡, not a failure", async () => {
  component.card = other.spec();
  await toAccounts();
  await page.clickButton(C.common.next);
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
      screenshots: "unreadable-201",
    });
  } finally {
    await undo();
  }
});

await tryStep("the answer to the submission lost, the record appended: 再試一次 gets challenge_used, the card's state shows the list (the real server)", async () => {
  component.card = fresh.spec();
  await toAccounts();
  await page.clickButton(C.common.next);
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
    const challengeUsed = browser.responses.some((r) => r.url.endsWith("/api/v1/records") && r.status === 400) && serverLog.includes(`"error":"challenge_used"`);
    check(challengeUsed, "the resubmission was answered challenge_used");
    check(cardStateCount() === states + 1, "the card's state asked again");
    // What the server recorded on each platform is not known on this path: the title of an answer not read.
    checkDone({ label: "found in the card's state", title: C.done.recorded_only, card: [[THREADS_NAME, at("zoe")]], record: null }, d.done ? await doneSeen() : null, d.message);
    check((await recordCount()) === before + 1, "one record, not two");
    await sleep(1500);
    await screenshot("challenge-used-6-done");
  } finally {
    await undo();
  }
});

// The server's table with Threads only (the first release's), and a card with no account
// elsewhere: steps 5 and 6 speak of one platform, by its name. (Step 1 of this build still
// speaks of more than one: it goes by the platforms the build knows, test-example and threads;
// the production build's step 1 is checked last.)
const single = await makeCard({ serial: "0a90567890abcdef1234567890abcdef" });
await tryStep("the platform table with Threads only: steps 5 and 6 speak of one platform", async () => {
  component.card = single.spec();
  const seenConfig: any[] = [];
  const undoConfig = await rewrite("*/api/v1/config", (b) => void (b.platforms = b.platforms.filter((p: { platform: string }) => p.platform === THREADS)), seenConfig);
  let st: AccountsSeen;
  try {
    st = await toAccounts();
  } finally {
    await undoConfig();
  }
  check(seenConfig.length === 1, "the config was read once, and changed on its way");
  check(st.state === "never", `a new card: ${st.state}`);
  checkRows("one platform", st.rows, { [THREADS]: [THREADS_NAME, "", [A.row_unused]] });
  await typeRows({ [THREADS]: "yui" });
  const c = await waitConfirm();
  checkConfirm("one platform", c, [[THREADS, THREADS_NAME, at("yui"), [K.first]]], C.confirm.button_declare_single, THREADS_NAME);
  check(c.listedSingle === "這個 Threads 帳號會公開列在島民證明上。", `step 5, one platform: "${c.listedSingle}"`);
  check(c.intro === "按下後，名冊會公開記下這張卡片宣告的帳號：", `step 5, one platform: "${c.intro}"`);
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
  check(
    (await page.text("[data-put-link]")) === "把下面的連結放在這個 Threads 帳號的個人檔案上。別人從帳號的個人檔案點進來，才知道帳號主人承認這張島民證明。",
    `step 6, one platform: "${await page.text("[data-put-link]")}"`,
  );
  check((await page.text()).includes("有一張有效的自然人憑證宣告了這個帳號："), "step 6, one platform: 有一張有效的自然人憑證宣告了這個帳號：");
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
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".svg": "image/svg+xml" };
  const site = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const file = join(prodDist, path === "/" ? "index.html" : path);
    let body: Buffer;
    try {
      if (!file.startsWith(prodDist)) throw new Error("outside");
      body = readFileSync(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Content-Security-Policy": CONTENT_SECURITY_POLICY, ...ISOLATION_HEADERS, ...OPENER_HEADERS }).end(body);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const prodUrl = `http://localhost:${(site.address() as AddressInfo).port}/`;
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
    const oneProof = await prod.text("[data-one-proof]");
    check(oneProof === fill(C.before.one_proof_single, { platform: THREADS_NAME }), `the production build's step 1: "${oneProof}"`);
    check(oneProof === "一張自然人憑證換一張島民證明，上面寫著這張卡片宣告的 Threads 帳號。", "the production build's step 1 names Threads");
    check(!(await prod.eval<boolean>(`!!document.querySelector('[data-listed-together]')`)) && !(await prod.text()).includes(C.before.listed_together), "the production build's step 1 does not say the accounts are listed together");
    await prod.eval(`document.querySelectorAll('details').forEach((d) => (d.open = true))`);
    await screenshot("single-1-before", prod);
    await sleep(1000);
    check(componentRequests.length === 0, `the production build's step 1 asked nothing of the component ${JSON.stringify(componentRequests)}`);
  } finally {
    off();
    await browser.send("Target.closeTarget", { targetId: prod.targetId }).catch(() => undefined);
    await new Promise((r) => site.close(r));
  }
});

writeFileSync(join(out, "ui-report.json"), JSON.stringify({ results, shown, component: component.requests.map((r) => ({ func: r.func, tbs: r.tbs })) }, null, 2));
await browser.close();
await component.stop();
await stopServer();
moica.close();
writeFileSync(join(out, "server.log"), serverLog);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
