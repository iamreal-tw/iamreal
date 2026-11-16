// The whole card proof from the screen, in headless Chrome, against the real
// server: test keys, a fake card behind a fake component, a fake MOICA for
// the mirror. Nothing real: no card, no PIN, no certificate, no MOICA key.
//
//   IAMREAL_BB=/path/to/bb node --experimental-strip-types test/e2e/ui.ts
//
// 1. Makes throwaway issuer keys (G2, G3), cards and CRLs (test/fixtures/).
// 2. Builds the server with the tag iamrealtest (server/testissuers.go) and
//    runs it with those issuer keys, a fake MOICA, the test roster, and the
//    page built in mode "test" (vite.config.ts) as its web directory.
// 3. Runs a fake component (fake-component.ts) on localhost:61171, the
//    test build's component address.
// 4. Clicks through the screens like a cardholder (real mouse events,
//    cdp.ts): the platform, then the six steps (design/copy/card-proof.md).
//    A first declaration; card proof again (no account typed); a switch,
//    with "上一步" back and forth; withdraw; declare the same account again
//    (not a switch); withdraw; declare another (a switch); switches used up
//    (the button cannot be pressed, and the engine refuses it too); a
//    submission that did not get through ("再試一次"), one the server
//    refused (with its request ID on the screen), one whose answer was lost
//    and that the card's state shows was recorded (challenge_used); a card
//    with 3 records today (step 4 keeps the state and offers nothing but
//    回到開頭), and one the server finds has 3 when it is sent; 回到開頭 on
//    step 6 and 取消 on steps 4 and 5, then card proofs again on the same
//    page with the same proof engine; step 3's 上一步 (the card read again);
//    the PIN's wait running out; a window the browser blocked on each of the
//    three clicks, then the same click again; every case that stops before
//    the PIN is asked, each written under its item of the list; a wrong
//    PIN, a locked card, a PIN that is not sent; the PIN typed and 確認卡片
//    pressed again while the card is confirmed; the preview of the profile
//    (a new tab, nothing else); the two links of step 6 (account_cards) and
//    "複製連結". The ten card proofs of one card fall on four days: the
//    server's clock (-test-clock) and the page's (Date.now) move ahead
//    together, since a card has at most 3 valid records a day.
// 5. Publishes the daily snapshot and re-verifies it with iamreal-verify:
//    the state is the one the screens showed.
// 6. Checks the response headers, that the page is cross-origin isolated,
//    that no Content-Security-Policy was violated, that the page and its
//    workers connected to nothing but their own origin (the component's
//    window aside), and that the browser's storage holds the CRL numbers
//    and nothing else; that the PIN is in no field, attribute, storage or
//    global after it was used, and neither are the name, the certificates
//    and the card's signatures once a card proof was left.
//
// The browser resolves no host name but localhost and 127.0.0.1
// (--host-resolver-rules): the preview's new tab, on the platform's
// address, gets no further than its name.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { SITE_DOMAIN, handle, platformOf } from "../../src/platforms.ts";
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
const PLATFORM = "Threads";
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
 * records a day (spec/roster-rules.md, check 6), and this test makes ten
 * with one card. The days go from 0 to 3, the most the CRLs allow (3 days).
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
const crls = {
  // G3: fresh, with the revoked card's serial. Dated the first day in Taiwan (its first second), so that it
  // is no more than 3 days old on the test's last day.
  G3: await makeCrl({ issuer: issuerKeys.G3, serials: [...randomSerials(20_000, 3n), revoked.serial], crlNumber: 300n, thisUpdate: new Date(Date.parse(`${firstDay}T00:00:00+08:00`)) }),
  // G2: 5 days old (Taiwan dates), more than the 3 days the server allows.
  G2: await makeCrl({ issuer: issuerKeys.G2, serials: randomSerials(2_000, 5n), crlNumber: 200n, thisUpdate: new Date(now - 5 * 86_400_000) }),
};

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
const server: ChildProcess = spawn(
  serverBin,
  ["serve", "-data", data, "-bb", BB, "-crs", crsDir, "-addr", `127.0.0.1:${serverPort}`, "-web", dist, "-roster", "test", "-test-issuers", issuersDir, "-test-moica", moicaUrl, "-test-clock", clockFile],
  { stdio: ["ignore", "ignore", "pipe"] },
);
server.stderr!.on("data", (b: Buffer) => (serverLog += b.toString()));
const PAGE_ORIGIN = `http://localhost:${serverPort}`;
const PAGE = `${PAGE_ORIGIN}/`;
{
  const t0 = Date.now();
  for (;;) {
    const lines = await fetch(`http://127.0.0.1:${serverPort}/crl/index.jsonl`)
      .then((r) => (r.ok ? r.text() : ""))
      .catch(() => "");
    if (lines.split("\n").filter(Boolean).length === 2) break;
    if (Date.now() - t0 > 30_000) throw new Error(`the server's mirror did not fetch the CRLs:\n${serverLog}`);
    await sleep(200);
  }
}

// 3. The component -------------------------------------------------------------

const component = new FakeComponent();
await component.start(COMPONENT_PORT);

// 4. The screens -------------------------------------------------------------

// No host name resolves but the test's own: a tab the page opens on another site (the preview) connects nowhere.
const browser = await Browser.launch({ dir: out, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] });
const page = await browser.newPage();
await page.send("Page.enable");
const C = COPY;
const threads = platformOf("threads");

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
  if (r.othersOpen > 0) windows.openedWhileAnother++;
});
// Tabs this page opened that cannot reach it (noopener): the preview's. The
// component's windows can (they post their reply to this page).
const previews: { targetId: string; canAccessOpener?: boolean }[] = [];
const PROFILE_ORIGIN = new URL(threads.profileUrl!("x")).origin;
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
/** Moves the server's and the page's clocks to `n` days ahead. */
async function setDay(n: number): Promise<void> {
  day = n;
  writeFileSync(clockFile, String(n));
  await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: clockScript });
  clockScript = (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: clockSource(n) })).identifier as string;
  await page.eval(`window.__iamrealClockDays = ${n}`).catch(() => undefined);
  console.log(`\n== day ${n}: ${today()}`);
}
// "複製連結" writes to the clipboard; the test reads it back.
await browser.send("Browser.grantPermissions", { origin: PAGE_ORIGIN, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
const results: Record<string, unknown> = {};

const step = (name: string) => `document.querySelector('[data-step="${name}"]')`;
const messageText = () => page.text("[data-message]");
const waitStep = (name: string, what: string, ms = 30_000) => page.waitFor(step(name), what, ms);
const whereText = () => page.text("[data-where]");
const stepLine = (n: number) => fill(C.common.step, { step: n, steps: 6 });

/** A new page load: the platforms. */
async function open(): Promise<void> {
  await page.goto(PAGE);
  await waitStep("platforms", "the platforms");
}

const componentCount = (func?: string) => component.requests.filter((r) => func === undefined || r.func === func).length;
const popupCount = () => new Set(browser.requests.filter((r) => r.url.startsWith(COMPONENT + "/popupForm")).map((r) => r.sessionId)).size;
const cardStateCount = () => browser.requests.filter((r) => r.url.endsWith("/api/v1/card-state")).length;
const challengeCount = () => browser.requests.filter((r) => r.url.endsWith("/api/v1/challenges")).length;
const recordCount = async (): Promise<number> => (await (await fetch(`http://127.0.0.1:${serverPort}/api/v1/head`)).json()).count;

/** Buttons on the screen: text and whether they can be pressed. A choice of step 4 by its label (its <b>). */
const buttons = () =>
  page.eval<{ text: string; disabled: boolean }[]>(`[...document.querySelectorAll('main button')].map((b) => ({ text: b.classList.contains("choice") ? b.querySelector("b").textContent : b.textContent, disabled: b.disabled }))`);

/** Clicks the choice of step 4 whose label is `label`. */
async function clickChoice(label: string): Promise<void> {
  const ok = await page.eval<boolean>(`(() => {
    const b = [...document.querySelectorAll("button.choice")].filter((b) => b.querySelector("b").textContent === ${JSON.stringify(label)});
    if (b.length !== 1) return false;
    b[0].setAttribute("data-click", "1");
    return true;
  })()`);
  if (!ok) throw new Error(`no single choice "${label}"`);
  await page.click('[data-click="1"]');
  await page.eval(`document.querySelector('[data-click="1"]')?.removeAttribute("data-click")`);
}

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
  const r = await page.waitFor<{ done: boolean; item: string; why: string; message: string }>(
    `(() => {
      const m = document.querySelector('[data-message]')?.innerText;
      if (m) return { done: false, item: "", why: "", message: m };
      const halt = document.querySelector('[data-list="read"] [data-state="halt"]');
      if (halt) return { done: false, item: halt.dataset.item, why: halt.querySelector('[data-why]')?.innerText ?? "", message: "" };
      const next = [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.common.next)});
      if (next && !next.disabled) return { done: true, item: "", why: "", message: "" };
      return null;
    })()`,
    "step 2's list to end",
    30_000,
  );
  return r;
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

interface StatusSeen {
  state: string;
  first: string;
  facts: string[];
  buttons: { text: string; disabled: boolean }[];
  main: string;
}

async function waitStatus(): Promise<StatusSeen> {
  await waitStep("choose", "step 4");
  return {
    state: await page.eval<string>(`document.querySelector('[data-step="choose"]').dataset.state`),
    first: await page.text("[data-status]"),
    facts: await page.eval<string[]>(`[...document.querySelectorAll('[data-fact]')].map((e) => e.innerText)`),
    buttons: await buttons(),
    main: await page.text(),
  };
}

interface ConsequenceSeen {
  record: string;
  account: string;
  switchLine: string;
  buttons: string[];
  main: string;
}

async function waitConsequence(): Promise<ConsequenceSeen> {
  await waitStep("confirm", "step 5");
  return {
    record: await page.text("[data-record-line]"),
    account: await page.text("[data-account]"),
    switchLine: await page.text("[data-switch-line]"),
    buttons: (await buttons()).map((b) => b.text),
    main: await page.text(),
  };
}

/** Types an account on step 4 (a card that never declared, or the new account) and presses "下一步". */
async function typeAccount(account: string): Promise<void> {
  await page.eval(`document.querySelector('#account').value = ""`);
  await page.type("#account", account);
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
async function screenshot(name: string): Promise<void> {
  const m = await page.send("Page.getLayoutMetrics");
  const h = Math.ceil(m.cssContentSize?.height ?? m.contentSize.height);
  const w = Math.ceil(m.cssLayoutViewport?.clientWidth ?? 1100);
  const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  writeFileSync(join(screens, `${name}.png`), Buffer.from(data, "base64"));
}
const handleOf = (u: string) => handle(threads, u);
/** The record lines of step 6. */
const doneLine = (account: string, withdraw = false) => fill(withdraw ? C.done.record_withdraw : C.done.record_declare, { platform: PLATFORM, account: handleOf(account) });

interface Shown {
  title: string;
  shortId: string;
}
const shown: Shown[] = [];

/**
 * From where the page is (the platforms, or step 1 after the wait ran out)
 * to step 2: Threads, then step 1's 下一步.
 */
async function toRead(o: { screenshots?: string } = {}): Promise<void> {
  if (await page.eval<boolean>(`!!${step("platforms")}`)) {
    const p = await page.text();
    check(p.includes(C.platforms.title) && p.includes(C.platforms.per_platform), "the platforms: the question and what a card gives on each");
    const rows = await page.eval<{ key: string; button: boolean; text: string }[]>(`[...document.querySelectorAll('[data-platform]')].map((e) => ({ key: e.dataset.platform, button: e.tagName === "BUTTON", text: e.innerText }))`);
    check(
      JSON.stringify(rows.map((r) => [r.key, r.button])) === JSON.stringify([["threads", true], ["x", false]]) && rows[1]!.text.includes("X") && rows[1]!.text.includes(C.platforms.not_open),
      `the platforms: Threads can be picked, X is listed as not open ${JSON.stringify(rows)}`,
    );
    check((await whereText()) === "", "the platforms come before the six steps");
    check((await page.text("header")) === C.common.service_name, `the header: the mark and "${C.common.service_name}"`);
    if (o.screenshots) await screenshot(`${o.screenshots}-0-platforms`);
    await page.click('[data-platform="threads"]');
  }
  await waitStep("before", "step 1");
  const s1 = await page.text();
  for (const s of [C.before.title, C.before.prepare_card, C.before.citizens_only, C.before.why_physical, C.before.how_to_get]) check(s1.includes(s), `step 1 says "${s}"`);
  check((await whereText()).includes(stepLine(1)), `step 1: "${await whereText()}"`);
  check(!s1.includes(C.app.use_reader) && !s1.includes(C.app.use_phone), "step 1: no choice of device before the app is out");
  check(!(await page.eval<boolean>(`!!document.querySelector('#pin') || !!document.querySelector('#account')`)), "step 1: no PIN field, no account field");
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
}

/** The platforms, steps 1 to 3, up to step 4. */
async function toStatus(o: { wrongPinFirst?: boolean; blockClicks?: boolean; screenshots?: string; samePage?: boolean } = {}): Promise<StatusSeen> {
  // samePage: the platforms (after cancel or 回到開頭) or step 1 (after the wait ran out) are on the screen already; no new page load.
  if (!o.samePage) await open();
  await toRead(o);
  if (o.screenshots) await screenshot(`${o.screenshots}-2-read`);
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
  const st = await waitStatus();
  check((await whereText()).includes(stepLine(4)), "step 4: 第 4 步，共 6 步");
  check(await pinGone(), "after the first signature, the PIN is nowhere on the page");
  check(!st.main.includes("測試用戶") && !(await page.eval<boolean>(`document.documentElement.outerHTML.includes("測試用戶")`)), "the name is gone after step 3");
  check(componentCount("MakeSignature") === signs + 1, "the first signature");
  const lastSign = component.requests.filter((x) => x.func === "MakeSignature").at(-1)!;
  check(lastSign.tbs === threads.scopeStrings.test && lastSign.pin === PIN, "the first signature: the test scope string, with the PIN");
  check((await workingSeen()).includes(C.pin.signing), `step 3 said, after 確認卡片, "${C.pin.signing}"`);
  if (o.screenshots) await screenshot(`${o.screenshots}-4-choose`);
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

/** From step 5: the last click, in progress, step 6. */
async function finish(o: {
  label: string;
  button: string;
  title: string;
  recordAccount: string;
  withdraw?: boolean;
  dropFirstSubmission?: boolean;
  blockClick?: boolean;
  screenshots?: string;
  /** The link step 6 suggests: the account's ("account") or this card's ("card"). */
  link?: "account" | "card";
  otherCards?: boolean;
}): Promise<void> {
  if (o.blockClick) await blockedClick(o.button, "blocked window, the second signature");
  const signs = componentCount("MakeSignature");
  const before = await recordCount();
  if (o.dropFirstSubmission) {
    let dropped = false;
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/v1/records", requestStage: "Request" }] });
    const off = browser.on((m, p, s) => {
      if (m !== "Fetch.requestPaused" || s !== page.sessionId) return;
      if (!dropped) {
        dropped = true;
        void page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" });
      } else void page.send("Fetch.continueRequest", { requestId: p.requestId });
    });
    await page.clickButton(o.button);
    const d1 = await waitDoneOrMessage();
    check(d1.item === "submit" && d1.message === C.stops.submit_failed, `a submission that did not get through, under 送出: "${d1.message}" (${d1.item})`);
    check(JSON.stringify((await buttons()).map((b) => b.text)) === JSON.stringify([C.read.read_again, C.progress.retry]), `stopped at 送出 (the PIN dropped after the second signature): 再讀一次卡片 and 再試一次: ${JSON.stringify((await buttons()).map((b) => b.text))}`);
    if (o.screenshots) await screenshot(`${o.screenshots}-5-submit-failed`);
    await page.clickButton(C.progress.retry);
    const d = await waitDoneOrMessage();
    off();
    await page.send("Fetch.disable");
    finishDone(o, d);
  } else {
    await page.clickButton(o.button);
    await waitStep("progress", "in progress");
    check((await whereText()).includes(stepLine(5)), "in progress: still 第 5 步，共 6 步");
    check((await page.text()).includes(C.progress.keep_open), "in progress: keep the page open");
    const threadsUsed = Number(await page.waitFor<string>(`document.querySelector('[data-list="progress"]')?.dataset.threads`, "the engine's threads", 30_000).catch(() => "0"));
    check(threadsUsed > 1, `in progress: a multithreaded proof (${threadsUsed} threads)`);
    if (o.screenshots) await screenshot(`${o.screenshots}-5-progress`);
    const d = await waitDoneOrMessage();
    finishDone(o, d);
  }
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
  console.log(`   times (ms): ${timings.map(([n, ms]) => `${n.replace("iamreal:", "")} ${ms}`).join(", ")}`);
}

function finishDone(o: { title: string; recordAccount: string; withdraw?: boolean; label: string; link?: "account" | "card"; otherCards?: boolean }, d: { done: boolean; main: string; message: string }): void {
  if (!check(d.done, `${o.label}: done ${d.message}`)) return;
  const lines = d.main.split("\n").filter(Boolean);
  const titleAt = lines.findIndex((l) => l === o.title);
  check(titleAt >= 0 && titleAt <= 2, `step 6: the title "${o.title}" (${JSON.stringify(lines.slice(0, 3))})`);
  const sid = /島民編號開頭是 ([0-9A-Z]{6})。/.exec(d.main)?.[1] ?? "";
  check(d.main.includes(doneLine(o.recordAccount, o.withdraw) + fill(C.done.short_id, { platform: PLATFORM, short_id: sid })), `step 6: the record line and the short ID (${sid})`);
  check(d.main.includes(C.done.recorded) && d.main.includes(today()) && d.main.includes(C.done.trust) && d.main.includes(C.done.unplug), "step 6: the roster's line, its date, that anyone can verify, unplug");
  check(d.main.includes(C.done.advice) === !o.withdraw, `step 6: the advice to come back ${o.withdraw ? "is not there (withdrawn)" : "is there"}`);
  check(d.main.includes(C.done.put_up) === !o.withdraw && d.main.includes(C.done.proof) === !o.withdraw, `step 6: the proof and how to put it up ${o.withdraw ? "are not there" : "are there"}`);
  check(!/[✓✔]/.test(d.main), "step 6: no check mark");
  check(lines.at(-1) === C.done.restart, `step 6 ends with the button "${lines.at(-1)}"`);
  if (!o.withdraw) {
    const link = o.link === "card" ? `${SITE_DOMAIN}/threads/@${o.recordAccount}/${sid}` : `${SITE_DOMAIN}/threads/@${o.recordAccount}`;
    check(d.main.includes(link) && (o.link === "card" || !d.main.includes(link + "/")), `step 6: the link ${link}`);
    const other = fill(C.done.other_cards, { account: handleOf(o.recordAccount) });
    check(d.main.includes(other) === !!o.otherCards, `step 6: ${o.otherCards ? "says" : "does not say"} that other cards declare it`);
  }
  shown.push({ title: o.title, shortId: sid });
}

/** Step 5 says what the roster will record, and offers 上一步, the last button and 取消. */
function checkConsequence(label: string, c: ConsequenceSeen, o: { account: string; withdraw?: boolean; switchesLeft?: number; nextSwitch?: string; button: string }): void {
  const record = fill(o.withdraw ? C.confirm.record_withdraw : C.confirm.record_declare, { platform: PLATFORM });
  check(c.record === record && c.account === handleOf(o.account), `${label}: step 5 records "${c.record}" ${c.account}`);
  check(c.main.includes(C.confirm.intro) && c.main.includes(today()) && c.main.includes(C.confirm.no_identity) && c.main.includes(C.confirm.permanent), `${label}: step 5, the record, its date, and that it cannot be deleted`);
  const switchLine =
    o.switchesLeft === undefined ? "" : o.nextSwitch ? fill(C.confirm.uses_last_switch, { next_switch_date: o.nextSwitch }) : fill(C.confirm.uses_switch, { switches_left: o.switchesLeft });
  check(c.switchLine === switchLine, `${label}: step 5, the switch line "${c.switchLine}"`);
  check(c.main.includes(o.withdraw ? C.confirm.later_withdraw : C.confirm.later), `${label}: step 5, what can be done later`);
  check(JSON.stringify(c.buttons) === JSON.stringify([C.common.back, o.button, C.common.cancel]), `${label}: step 5 buttons ${JSON.stringify(c.buttons)}`);
}

const tryStep = async (label: string, f: () => Promise<void>) => {
  console.log(`\n== ${label}`);
  try {
    await f();
  } catch (e) {
    check(false, `${label}: ${e instanceof Error ? e.stack : String(e)}`);
  }
};

// The last card proof today: 上次過卡是今天 (not 0 天前); otherwise days ago; one line with the switches.
const declaredFacts = (switchesUsed: number, daysAgo = 0) => [
  (daysAgo === 0 ? C.choose.last_card_proof_today : fill(C.choose.last_card_proof, { days_ago: daysAgo })) +
    (switchesUsed < 2 ? fill(C.choose.switches, { switches_used: switchesUsed, switches_left: 2 - switchesUsed }) : fill(C.choose.switches_used_up, { switches_used: switchesUsed })),
];
const choiceButtons = (st: StatusSeen) => JSON.stringify(st.buttons);

component.card = main.spec();

await tryStep("declare @alice (a wrong PIN first; a blocked window on each click; the preview)", async () => {
  const st = await toStatus({ wrongPinFirst: true, blockClicks: true, screenshots: "declare" });
  check(st.state === "never" && st.first === fill(C.choose.not_declared, { platform: PLATFORM }), `step 4: "${st.first}"`);
  check(
    st.main.includes(C.choose.account_label) && st.main.includes(fill(C.choose.one_account, { platform: PLATFORM })) && st.main.includes(C.choose.no_check) && st.main.includes(fill(C.choose.preview_note, { platform: PLATFORM })),
    "step 4: the account field, the preview and what it means",
  );
  check(choiceButtons(st) === JSON.stringify([C.choose.preview, C.common.next, C.common.cancel].map((text) => ({ text, disabled: false }))), `step 4 buttons ${choiceButtons(st)}`);
  // The preview: a name not in the format opens nothing; a good one opens the profile in a new tab.
  const tabs = previews.length;
  await page.type("#account", "al ice");
  await page.clickButton(C.choose.preview);
  await sleep(500);
  check((await messageText()) === COPY.formats.threads && previews.length === tabs, `preview of an account not in the format: the hint, nothing opened ("${await messageText()}")`);
  await screenshot("declare-4-choose-format");
  await page.eval(`document.querySelector('#account').value = ""`);
  await page.type("#account", "@Alice");
  const requests = browser.requests.length;
  const calls = windowCalls.length;
  await page.clickButton(C.choose.preview);
  for (let i = 0; i < 100 && previews.length === tabs; i++) await sleep(50);
  // The new tab itself does not load under this test's DevTools (it holds every new tab; a
  // noopener tab is not let go even for a local address, tried), so the call is what is checked.
  const call = windowCalls.slice(calls);
  check(
    JSON.stringify(call) === JSON.stringify([{ url: threads.profileUrl!("alice"), name: "_blank", features: "noopener,noreferrer", opened: false }]),
    `the preview: window.open of the profile's page, a new tab, noopener and noreferrer ${JSON.stringify(call)}`,
  );
  check(previews.length === tabs + 1, `the preview opened a tab that cannot reach this page (${previews.length - tabs} tab)`);
  check((await page.eval<boolean>(`!!${step("choose")}`)) && (await messageText()) === "", "the preview: this page stays on step 4");
  const ownRequests = browser.requests.slice(requests).filter((r) => r.sessionId === page.sessionId);
  check(ownRequests.every((r) => new URL(r.url).origin === PAGE_ORIGIN), `the preview: this page itself requested nothing elsewhere ${JSON.stringify(ownRequests.map((r) => r.url))}`);
  for (const p of previews) await browser.send("Target.closeTarget", { targetId: p.targetId }).catch(() => undefined);
  await page.send("Page.bringToFront");
  await typeAccount("al ice");
  check((await messageText()) === COPY.formats.threads, "an account not in the format: the hint, and still step 4");
  await typeAccount("alice");
  const cq = await waitConsequence();
  check((await whereText()).includes(stepLine(5)), "step 5: 第 5 步，共 6 步");
  checkConsequence("first", cq, { account: "alice", button: fill(C.confirm.button_first, { account: "@alice" }) });
  await screenshot("declare-5-confirm");
  await finish({ label: "declare @alice", button: fill(C.confirm.button_first, { account: "@alice" }), title: C.done.first, recordAccount: "alice", blockClick: true, screenshots: "declare", link: "account" });
  // 複製連結: the whole https:// address, to the clipboard.
  await page.clickButton(C.done.copy);
  await page.waitFor(`[...document.querySelectorAll('main button')].some((b) => b.textContent === ${JSON.stringify(C.done.copied)}) || null`, "已複製", 5_000).catch(() => undefined);
  const clip = await page.eval<string>(`navigator.clipboard.readText()`).catch((e) => `(${e.message})`);
  check(clip === `https://${SITE_DOMAIN}/threads/@alice`, `複製連結 copied ${clip}`);
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

await tryStep("card proof again, no account typed (the first submission dropped, then 再試一次)", async () => {
  const st = await toStatus();
  check(st.state === "declared" && st.first === fill(C.choose.current, { account: "@alice" }), `step 4: "${st.first}"`);
  check(JSON.stringify(st.facts) === JSON.stringify(declaredFacts(0)), `step 4 facts ${JSON.stringify(st.facts)}`);
  check(choiceButtons(st) === JSON.stringify([C.choose.refresh, C.choose.switch, C.choose.withdraw, C.common.cancel].map((text) => ({ text, disabled: false }))), `step 4 choices ${choiceButtons(st)}`);
  check(st.main.includes(C.choose.refresh_note) && st.main.includes(C.choose.uses_switch), "step 4: what each choice does");
  check(!(await page.eval<boolean>(`!!document.querySelector('#account')`)), "no account field");
  await screenshot("refresh-4-choose");
  await clickChoice(C.choose.refresh);
  checkConsequence("refresh", await waitConsequence(), { account: "alice", button: C.confirm.button_refresh });
  await finish({ label: "refresh", button: C.confirm.button_refresh, title: C.done.refresh, recordAccount: "alice", dropFirstSubmission: true, screenshots: "refresh", link: "account" });
});

await tryStep("switch to @bob, with 上一步 back and forth", async () => {
  await toStatus();
  const signs = componentCount();
  const states = cardStateCount();
  const challenges = challengeCount();
  await clickChoice(C.choose.switch);
  await waitStep("account", "the account screen");
  check((await page.text()).includes(C.choose.new_account) && (await whereText()).includes(stepLine(4)), "the account screen: 新的帳號, still step 4");
  check(JSON.stringify((await buttons()).map((b) => b.text)) === JSON.stringify([C.choose.preview, C.common.back, C.common.next, C.common.cancel]), `the account screen's buttons ${JSON.stringify((await buttons()).map((b) => b.text))}`);
  await screenshot("switch-4-account");
  await typeAccount("bob");
  const cq = await waitConsequence();
  await screenshot("switch-5-confirm");
  checkConsequence("switch", cq, { account: "bob", switchesLeft: 1, button: fill(C.confirm.button_switch, { account: "@bob" }) });
  await page.clickButton(C.common.back);
  await waitStep("account", "back: the account screen");
  check((await page.eval<string>(`document.querySelector('#account').value`)) === "bob", "back: the account typed is still there");
  await page.clickButton(C.common.back);
  const again = await waitStatus();
  check(again.first === fill(C.choose.current, { account: "@alice" }), "back: step 4 again");
  await clickChoice(C.choose.withdraw);
  const w = await waitConsequence();
  checkConsequence("withdraw, looked at", w, { account: "alice", withdraw: true, button: fill(C.confirm.button_withdraw, { account: "@alice" }) });
  await screenshot("withdraw-5-confirm");
  await page.clickButton(C.common.back);
  await waitStatus();
  await clickChoice(C.choose.switch);
  await waitStep("account", "the account screen");
  await typeAccount("bob");
  await waitConsequence();
  check(componentCount() === signs && cardStateCount() === states && challengeCount() === challenges, "back and forth: no signature, no card-state, no challenge");
  await finish({ label: "switch to @bob", button: fill(C.confirm.button_switch, { account: "@bob" }), title: fill(C.done.switch, { account: "@bob" }), recordAccount: "bob", link: "account", screenshots: "switch" });
});

// Three records of the card today: step 4 keeps the state and offers nothing but 回到開頭.
await tryStep("3 records today: step 4 keeps the state, says so, and offers only 回到開頭", async () => {
  const st = await toStatus();
  check(st.state === "daily_limit" && st.first === fill(C.choose.current, { account: "@bob" }) && JSON.stringify(st.facts) === JSON.stringify(declaredFacts(1)), `step 4: the state as it is "${st.first}" ${JSON.stringify(st.facts)}`);
  check((await page.text("[data-daily-limit]")) === fill(C.stops.daily_limit, { platform: PLATFORM }), "step 4: the sentence of 3 records today");
  check(choiceButtons(st) === JSON.stringify([{ text: C.choose.restart, disabled: false }]), `step 4: no choices, only 回到開頭 ${choiceButtons(st)}`);
  check(!(await page.eval<boolean>(`!!document.querySelector('#account')`)), "no account field");
  await screenshot("daily-limit-4-choose");
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await page.clickButton(C.choose.restart);
  await backAtTheBeginning("回到開頭 on step 4, 3 records today");
  await sleep(500);
  check(componentCount("MakeSignature") === signs && challengeCount() === challenges, "3 records today: no second signature, no challenge");
});

await setDay(1);

await tryStep("withdraw @bob", async () => {
  const st = await toStatus();
  check(JSON.stringify(st.facts) === JSON.stringify(declaredFacts(1, 1)), `step 4 facts ${JSON.stringify(st.facts)}`);
  await clickChoice(C.choose.withdraw);
  checkConsequence("withdraw", await waitConsequence(), { account: "bob", withdraw: true, button: fill(C.confirm.button_withdraw, { account: "@bob" }) });
  await finish({ label: "withdraw @bob", button: fill(C.confirm.button_withdraw, { account: "@bob" }), title: C.done.withdraw, recordAccount: "bob", withdraw: true, screenshots: "withdraw" });
});

await tryStep("withdrawn: declare @bob again (not a switch)", async () => {
  const st = await toStatus();
  check(st.state === "withdrawn" && st.first === C.choose.nothing_now && JSON.stringify(st.facts) === JSON.stringify([fill(C.choose.withdrawn, { last_declared: "@bob" })]), `step 4: "${st.first}" ${JSON.stringify(st.facts)}`);
  const back = fill(C.choose.declare_back, { last_declared: "@bob" });
  check(choiceButtons(st) === JSON.stringify([back, C.choose.declare_other, C.common.cancel].map((text) => ({ text, disabled: false }))), `step 4 choices ${choiceButtons(st)}`);
  check(st.main.includes(C.choose.not_a_switch) && st.main.includes(C.choose.uses_switch), "step 4: which one is a switch");
  await screenshot("withdrawn-4-choose");
  await clickChoice(back);
  checkConsequence("declare again", await waitConsequence(), { account: "bob", button: fill(C.confirm.button_first, { account: "@bob" }) });
  // A refresh by the roster rules; to the cardholder, a new proof.
  await finish({ label: "declare @bob again", button: fill(C.confirm.button_first, { account: "@bob" }), title: C.done.first, recordAccount: "bob", link: "account" });
});

await tryStep("withdraw @bob again", async () => {
  const st = await toStatus();
  check(JSON.stringify(st.facts) === JSON.stringify(declaredFacts(1)), `step 4 facts ${JSON.stringify(st.facts)}`);
  await clickChoice(C.choose.withdraw);
  await waitConsequence();
  await finish({ label: "withdraw @bob again", button: fill(C.confirm.button_withdraw, { account: "@bob" }), title: C.done.withdraw, recordAccount: "bob", withdraw: true });
});

// The card's state says 2 records today (the answer changed on its way); the
// server finds the third already there when the card proof is sent.
await tryStep("the server finds 3 records today when the card proof is sent (daily_limit)", async () => {
  const seen: unknown[] = [];
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/v1/card-state", requestStage: "Response" }] });
  const off = browser.on((m, p, s) => {
    if (m !== "Fetch.requestPaused" || s !== page.sessionId) return;
    void (async () => {
      const r = await page.send("Fetch.getResponseBody", { requestId: p.requestId });
      const state = JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString() : r.body);
      seen.push(state.proofs_on_last_date);
      state.proofs_on_last_date = 2;
      await page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: p.responseHeaders, body: Buffer.from(JSON.stringify(state)).toString("base64") });
    })().catch((e) => console.log(`   (card-state: ${e.message})`));
  });
  let st: StatusSeen;
  try {
    st = await toStatus();
  } finally {
    off();
    await page.send("Fetch.disable");
  }
  check(JSON.stringify(seen) === "[3]", `the server's card-state said ${JSON.stringify(seen)} record(s) today`);
  check(st.state === "withdrawn", `step 4 with 2 records today: "${st.first}"`);
  const before = await recordCount();
  const back = fill(C.choose.declare_back, { last_declared: "@bob" });
  await clickChoice(back);
  await waitConsequence();
  const signs = componentCount("MakeSignature");
  await page.clickButton(fill(C.confirm.button_first, { account: "@bob" }));
  const d = await waitDoneOrMessage();
  const expected = fill(C.stops.daily_limit, { platform: PLATFORM });
  const id = await page.text("[data-request-id]");
  check(!d.done && d.item === "submit" && d.message === `${expected}\n${fill(C.stops.request_id, { request_id: id })}`, `the server's daily_limit, under 送出: ${JSON.stringify(d.message)} (${d.item})`);
  const res = browser.responses.filter((r) => r.url.endsWith("/api/v1/records") && r.status === 400).at(-1);
  check(/^[0-9a-f]{16}$/.test(id) && res?.headers["x-request-id"] === id && serverLog.includes(`"error":"daily_limit"`), `the request ID on the screen (${id}) is the response's, and the server logged daily_limit`);
  check(componentCount("MakeSignature") === signs + 1, "the second signature, once");
  check((await recordCount()) === before, "nothing was appended");
  check(JSON.stringify((await buttons()).map((b) => b.text)) === JSON.stringify([C.read.read_again]), `stopped (the PIN dropped): 再讀一次卡片 only ${JSON.stringify((await buttons()).map((b) => b.text))}`);
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

await setDay(2);

await tryStep("withdrawn: declare another account, @carol (a switch, the last one)", async () => {
  await toStatus();
  await clickChoice(C.choose.declare_other);
  await waitStep("account", "the account screen");
  await typeAccount("carol");
  // The switches were on the first day (@bob) and today (@carol): the next one a year after the first.
  const next = new Date(Date.parse(firstDay + "T00:00:00Z") + 365 * 86_400_000).toISOString().slice(0, 10);
  const cq = await waitConsequence();
  checkConsequence("declare another", cq, { account: "carol", switchesLeft: 0, nextSwitch: next, button: fill(C.confirm.button_switch, { account: "@carol" }) });
  await screenshot("switch-last-5-confirm");
  await finish({ label: "declare @carol", button: fill(C.confirm.button_switch, { account: "@carol" }), title: fill(C.done.switch, { account: "@carol" }), recordAccount: "carol", link: "account" });
});

// Switches used up: the button cannot be pressed, and the engine refuses the switch itself.
// Then a submission the server refuses: its code and request ID under 送出.
await tryStep("switches used up; then a submission the server refuses", async () => {
  const st = await toStatus();
  check(JSON.stringify(st.facts) === JSON.stringify(declaredFacts(2)), `step 4 facts ${JSON.stringify(st.facts)}`);
  const sw = st.buttons.find((b) => b.text === C.choose.switch);
  check(sw?.disabled === true, "改成別的帳號 cannot be pressed");
  const next = /下一次可以更換是 (\d{4}-\d{2}-\d{2})。/.exec(st.main)?.[1] ?? "";
  check(next === new Date(Date.parse(firstDay + "T00:00:00Z") + 365 * 86_400_000).toISOString().slice(0, 10) && st.main.includes(fill(C.choose.switch_limit, { next_switch_date: next })), `the sentence under it: next switch ${next}`);
  check(!st.main.includes(C.choose.uses_switch), "no 會用掉一次更換 on a button that cannot be pressed");
  await screenshot("limit-4-choose");
  // Pressed anyway (the attribute removed by a script): the engine refuses it, and nothing is signed.
  const signs = componentCount();
  const challenges = challengeCount();
  await page.eval(`[...document.querySelectorAll('button.choice')].find((b) => b.querySelector("b").textContent === ${JSON.stringify(C.choose.switch)}).disabled = false`);
  await clickChoice(C.choose.switch);
  await waitStep("account", "the account screen");
  await typeAccount("dave");
  const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText || null`, "the engine's refusal");
  check(m === "switch_limit" && (await page.eval<boolean>(`!!${step("account")}`)), `the engine refuses the switch: "${m}", still the account screen`);
  check(componentCount() === signs && challengeCount() === challenges, "refused: no signature, no challenge");
  await page.clickButton(C.common.back);
  await waitStatus();
  await clickChoice(C.choose.refresh);
  checkConsequence("refresh @carol", await waitConsequence(), { account: "carol", button: C.confirm.button_refresh });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/v1/records", requestStage: "Request" }] });
  const off = browser.on((msg, p, s) => {
    if (msg !== "Fetch.requestPaused" || s !== page.sessionId) return;
    // Another account: the proof no longer verifies.
    const body = JSON.parse(p.request.postData);
    body.username = "carl";
    void page.send("Fetch.continueRequest", { requestId: p.requestId, postData: Buffer.from(JSON.stringify(body)).toString("base64") });
  });
  await page.clickButton(C.confirm.button_refresh);
  const d = await waitDoneOrMessage();
  off();
  await page.send("Fetch.disable");
  const id = await page.text("[data-request-id]");
  const expected = fill(C.stops.rejected, { code: "proof" });
  check(!d.done && d.item === "submit" && d.message.startsWith(expected), `refused, under 送出: "${d.message}"`);
  const res = browser.responses.filter((r) => r.url.endsWith("/api/v1/records") && r.status === 400).at(-1);
  check(/^[0-9a-f]{16}$/.test(id) && res?.headers["x-request-id"] === id, `the request ID on the screen (${id}) is the response's (${res?.headers["x-request-id"]})`);
  check(d.message === `${expected}\n${fill(C.stops.request_id, { request_id: id })}`, `the request ID follows its label, on the next line: ${JSON.stringify(d.message)}`);
  check(serverLog.includes(`"id":"${id}"`) && serverLog.includes(`"error":"proof"`), "the server's log line has the same ID");
  const list = await items("progress");
  check(JSON.stringify(list.map((i) => i.state)) === JSON.stringify(["done", "done", "done", "halt"]) && list[3]!.st === C.common.halted, `in progress: done, done, done, 停在這裡 ${JSON.stringify(list.map((i) => i.st))}`);
  check(JSON.stringify((await buttons()).map((b) => b.text)) === JSON.stringify([C.read.read_again]), "refused: 再讀一次卡片 only (no 再試一次)");
  await screenshot("rejected-5-progress");
});

// From here to the PIN's wait running out, one page load: 回到開頭 and 取消 start the
// next card proof on the same page, with the same proof engine (ADR-0013).
const crsG1 = "/crs/bn254_g1_compressed_2p18.dat";
let samePage: { timeOrigin: number; crsFetches: number } | null = null;
const crsFetchCount = () => browser.requests.filter((r) => r.url.endsWith(crsG1)).length;

/** The platforms again, on the same page, with no sentence; nothing of the last card proof on the page. */
async function backAtTheBeginning(label: string): Promise<void> {
  await waitStep("platforms", `${label}: the platforms`);
  check((await messageText()) === "", `${label}: the platforms, with no message`);
  await lastCardProofGone(label, main);
}

await tryStep("withdraw @carol; then 回到開頭", async () => {
  await toStatus();
  samePage = { timeOrigin: await page.eval<number>("performance.timeOrigin"), crsFetches: crsFetchCount() };
  await clickChoice(C.choose.withdraw);
  await waitConsequence();
  await finish({ label: "withdraw @carol", button: fill(C.confirm.button_withdraw, { account: "@carol" }), title: C.done.withdraw, recordAccount: "carol", withdraw: true });
  await page.clickButton(C.done.restart);
  await backAtTheBeginning("回到開頭");
});

await tryStep("withdrawn, switches used up: 宣告別的帳號 cannot be pressed; then 取消 on step 4", async () => {
  const st = await toStatus({ samePage: true });
  check(st.first === C.choose.nothing_now && st.facts[0] === fill(C.choose.withdrawn, { last_declared: "@carol" }), `step 4: "${st.first}"`);
  check(st.buttons.find((b) => b.text === C.choose.declare_other)?.disabled === true, "宣告別的帳號 cannot be pressed");
  check(st.buttons.find((b) => b.text === fill(C.choose.declare_back, { last_declared: "@carol" }))?.disabled === false, "宣告回 @carol can");
  check(/一年最多更換兩次，下一次可以更換是 \d{4}-\d{2}-\d{2}。/.test(st.main), "the sentence under it");
  await screenshot("withdrawn-limit-4-choose");
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await page.clickButton(C.common.cancel);
  await backAtTheBeginning("取消 on step 4");
  await sleep(500);
  check(componentCount("MakeSignature") === signs && challengeCount() === challenges, "取消 on step 4: no second signature, no challenge");
});

await tryStep("取消 on step 5, and on the account screen", async () => {
  await toStatus({ samePage: true });
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await clickChoice(fill(C.choose.declare_back, { last_declared: "@carol" }));
  await waitConsequence();
  await page.clickButton(C.common.cancel);
  await backAtTheBeginning("取消 on step 5");
  // The account screen (also step 4). Switches are used up here, so the button is opened by a script.
  await toStatus({ samePage: true });
  await page.eval(`[...document.querySelectorAll('button.choice')].find((b) => b.querySelector("b").textContent === ${JSON.stringify(C.choose.declare_other)}).disabled = false`);
  await clickChoice(C.choose.declare_other);
  await waitStep("account", "the account screen");
  await page.clickButton(C.common.cancel);
  await backAtTheBeginning("取消 on the account screen");
  await sleep(500);
  check(componentCount("MakeSignature") === signs + 1 && challengeCount() === challenges, "取消: the first signature of each card proof only, no challenge");
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
  // Back to the platforms for the next case: step 3's back, step 2's back, step 1's back.
  await page.clickButton(C.common.back);
  await waitStep("read", "step 2");
  await page.clickButton(C.common.back);
  await waitStep("before", "step 1");
  await page.clickButton(C.common.back);
  await backAtTheBeginning("上一步 to the platforms");
});

await tryStep("the PIN's wait runs out: back to step 1", async () => {
  const st = await toStatus({ samePage: true });
  const signs = componentCount("MakeSignature");
  await clickChoice(fill(C.choose.declare_back, { last_declared: "@carol" }));
  await waitConsequence();
  const t0 = Date.now();
  await waitStep("before", "step 1, after the wait", IDLE_MS + 15_000);
  const waited = Date.now() - t0;
  const m = await messageText();
  check(m === C.before.idle && st.state === "withdrawn", `back to step 1 after ${Math.round(waited / 1000)} s: "${m}"`);
  check((await whereText()).includes(stepLine(1)), "the wait ran out: 第 1 步");
  await screenshot("idle-1-before");
  check(await pinGone(), "the wait ran out: the PIN is nowhere on the page");
  await lastCardProofGone("the wait ran out", main);
  check(componentCount("MakeSignature") === signs, "no second signature");
});

await tryStep("the same page after 回到開頭, 取消 and the wait: declare @carol again, withdraw again", async () => {
  await toStatus({ samePage: true });
  await clickChoice(fill(C.choose.declare_back, { last_declared: "@carol" }));
  await waitConsequence();
  await finish({ label: "declare @carol again, same page", button: fill(C.confirm.button_first, { account: "@carol" }), title: C.done.first, recordAccount: "carol", link: "account" });
  await page.clickButton(C.done.restart);
  await backAtTheBeginning("回到開頭 after a declaration");
  // The third record of the card today: the next one on the next day, on the same page.
  await setDay(3);
  const st = await toStatus({ samePage: true });
  check(st.first === fill(C.choose.current, { account: "@carol" }) && JSON.stringify(st.facts) === JSON.stringify(declaredFacts(2, 1)), `step 4: "${st.first}" ${JSON.stringify(st.facts)}`);
  await clickChoice(C.choose.withdraw);
  await waitConsequence();
  await finish({ label: "withdraw @carol again, same page", button: fill(C.confirm.button_withdraw, { account: "@carol" }), title: C.done.withdraw, recordAccount: "carol", withdraw: true });
  // One page load, one proof engine: the CRS was fetched once, the engine started once.
  const engineStarts = await page.eval<number>(`performance.getEntriesByName("iamreal:engine_engine_total").length`);
  check(
    samePage !== null && (await page.eval<number>("performance.timeOrigin")) === samePage.timeOrigin && crsFetchCount() === samePage.crsFetches && engineStarts === 1,
    `nine card proofs on one page load (three done), one proof engine: CRS fetched ${crsFetchCount() - (samePage?.crsFetches ?? 0)} more times, engine started ${engineStarts} time(s)`,
  );
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

// After the PIN: a locked card, a challenge dated another day.
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
    await sleep(500);
    unusedWindows += popupCount() - popups;
    check(componentCount("MakeSignature") === signs && cardStateCount() === states, `PIN ${JSON.stringify(bad)}: nothing sent to the card, no card-state`);
    check((await foundOnPage([bad])).length === 0, `PIN ${JSON.stringify(bad)}: nowhere on the page`);
    check((await buttons()).some((b) => b.text === C.common.back && !b.disabled), `PIN ${JSON.stringify(bad)}: 上一步 is there (to read the card again)`);
  }
});

await tryStep("a challenge dated another day: stopped under 連上島民的伺服器; 回到上一步", async () => {
  await toPin(fresh.spec());
  await confirmPin(PIN);
  await waitStatus();
  await typeAccount("alice");
  await waitConsequence();
  const signs = componentCount("MakeSignature");
  const undo = await intercept("*/api/v1/challenges", (p) =>
    page.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify({ challenge: "2026-01-01.000G40R40M30E209185GR38E1W" })).toString("base64"),
    }),
  );
  await page.clickButton(fill(C.confirm.button_first, { account: "@alice" }));
  const d = await waitDoneOrMessage();
  await undo();
  check(!d.done && d.item === "server" && d.message === C.stops.date_mismatch, `challenge of another day, under 連上島民的伺服器: "${d.message}" (${d.item})`);
  const list = await items("progress");
  check(JSON.stringify(list.map((i) => i.state)) === JSON.stringify(["halt", "", "", ""]), `in progress: 停在這裡, then nothing ${JSON.stringify(list.map((i) => i.state))}`);
  check(JSON.stringify((await buttons()).map((b) => b.text)) === JSON.stringify([C.read.read_again]), "再讀一次卡片 only");
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
  await waitStatus();
  await typeAccount("alice");
  await waitConsequence();
  const before = await recordCount();
  const undo = await intercept("*/api/v1/records", (p) =>
    page.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 400,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify({ error: "challenge_unknown" })).toString("base64"),
    }),
  );
  await page.clickButton(fill(C.confirm.button_first, { account: "@alice" }));
  const d = await waitDoneOrMessage();
  await undo();
  check(!d.done && d.item === "submit" && d.message === C.stops.challenge_expired, `the challenge expired, under 送出: "${d.message}" (${d.item})`);
  check(JSON.stringify((await buttons()).map((b) => b.text)) === JSON.stringify([C.read.read_again]), `the PIN dropped: 再讀一次卡片 only ${JSON.stringify((await buttons()).map((b) => b.text))}`);
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
// confirmation is under way (the server slow to answer card-state). It used
// to have the card sign a second time and send card-state again, and to leave
// the first wait's timer running, which could later stop a card proof whose
// record was already sent.
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
    const during = await page.eval<{ pin: boolean | null; button: boolean | null; working: string }>(`({
      pin: document.querySelector('#pin')?.disabled ?? null,
      button: [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.pin.confirm_card)})?.disabled ?? null,
      working: document.querySelector('[data-working]')?.innerText ?? "",
    })`);
    check(during.pin === true && during.button === true && during.working === C.pin.signing, `while the card is confirmed, the PIN field and the button cannot be used: ${JSON.stringify(during)}`);
    await screenshot("signing-3-pin");
    // Typed and pressed again anyway, with the keyboard and the mouse.
    await confirmPin(PIN);
    await sleep(1500);
    check(componentCount("MakeSignature") === signs + 1, `pressed again: the card was asked to sign once (${componentCount("MakeSignature") - signs} times)`);
    check(cardStateCount() === states + 1, `pressed again: one card-state (${cardStateCount() - states})`);
    check((await messageText()) === "", `pressed again: no message "${await messageText()}"`);
    await release();
    const st = await waitStatus();
    check(st.state === "withdrawn", `step 4 after the answer: "${st.first}"`);
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
async function stopsBeforePin(label: string, card: FakeCardSpec | null, expected: string, item: string, o: { setup?: () => Promise<() => Promise<void>>; silent?: boolean; screenshot?: string } = {}): Promise<void> {
  component.card = card;
  component.silent = o.silent ?? false;
  await open();
  await toRead();
  const undo = o.setup ? await o.setup() : null;
  const signs = componentCount("MakeSignature");
  const cardStates = cardStateCount();
  const r = await readCard();
  check(!r.done && r.item === item && r.why === expected, `${label}: under "${item}": "${r.why}"`);
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

/** Answers a same-origin request of the page with other bytes, or fails it. */
async function intercept(pattern: string, act: (p: any) => Promise<unknown>, stage: "Request" | "Response" = "Request"): Promise<() => Promise<void>> {
  await page.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: stage }] });
  const off = browser.on((m, p, s) => {
    if (m === "Fetch.requestPaused" && process.env.DEBUG_FETCH) console.log(`   paused ${s} ${p.requestId} ${p.networkId} ${p.request?.url} ${p.responseStatusCode ?? "request"}`);
    if (m === "Fetch.requestPaused" && s === page.sessionId) act(p).catch((e) => console.log(`   (intercepting ${p.request?.url}: ${e.message})`));
  });
  return async () => {
    off();
    await page.send("Fetch.disable");
  };
}

// Every case that stops before the PIN, each under its item.
const tests: [string, FakeCardSpec | null, string, string, Parameters<typeof stopsBeforePin>[4]?][] = [
  ["the component does not answer", main.spec(), C.stops.component_unreachable + " " + C.links.prepare, "component", { silent: true, screenshot: "stop-2-component" }],
  ["no reader", { ...main.spec(), noReader: true }, C.stops.no_reader, "reader", { screenshot: "stop-2-no-reader" }],
  ["no card", { ...main.spec(), noCard: true }, C.stops.no_card, "reader"],
  ["no certificate on the card", { ...main.spec(), certificates: [] }, C.stops.no_certificate, "certificate"],
  ["expired", expired.spec(), fill(C.stops.expired, { expiry_date: "2025-12-31" }), "check", { screenshot: "stop-2-expired" }],
  ["not yet valid", notYet.spec(), fill(C.stops.not_yet_valid, { valid_from: notYetTaiwan }), "check"],
  ["not a citizen's primary card", foreign.spec(), C.stops.not_citizen_primary, "check"],
  ["a format the circuit does not take", bigKey.spec(), C.stops.unsupported_format, "check"],
  ["two certificates that pass", { ...main.spec(), certificates: [...main.spec().certificates, ...revoked.spec().certificates] }, C.stops.two_certificates, "check", { screenshot: "stop-2-two-certificates" }],
  ["not issued by MOICA", unknownIssuer.spec(), C.stops.unknown_issuer, "check"],
  ["revoked", revoked.spec(), C.stops.revoked, "crl", { screenshot: "stop-2-revoked" }],
  // 5 days old on the first day; the clock is `day` days ahead by now.
  ["the CRL is 5 days old", g2card.spec(), fill(C.stops.crl_stale, { crl_days: 5 + day }), "crl"],
  [
    "the mirror's index has no usable CRL",
    main.spec(),
    fill(C.stops.crl_unavailable, { code: "crl_unavailable" }),
    "crl",
    {
      setup: () =>
        intercept("*/crl/index.jsonl", (p) => page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/jsonl" }], body: "" })),
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
    },
  ],
  [
    "the server does not answer",
    main.spec(),
    fill(C.stops.server_unreadable, { code: "network" }),
    "server",
    { setup: () => intercept("*/api/v1/config", (p) => page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" })), screenshot: "stop-2-server" },
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

// 5. Snapshot and re-verification -----------------------------------------------

const KINDS = ["first", "refresh", "switch", "withdraw", "refresh", "withdraw", "switch", "withdraw", "refresh", "withdraw"];
await tryStep("snapshot and iamreal-verify", async () => {
  execFileSync(serverBin, ["snapshot", "-data", data, "-bb", BB, "-crs", crsDir, "-roster", "test", "-test-issuers", issuersDir, "-test-clock", clockFile], { stdio: "pipe" });
  const v = JSON.parse(
    execFileSync(verifyBin, ["-bb", BB, "-crs", crsDir, "-roster", "test", "-json", "-test-issuers", issuersDir, "-crl-archive", join(data, "crl"), join(data, "roster")], { stdio: ["ignore", "pipe", "pipe"] }).toString(),
  );
  writeFileSync(join(out, "verify.json"), JSON.stringify(v, null, 2));
  const kinds = v.results.map((r: { kind: string }) => r.kind);
  check(v.valid === true && JSON.stringify(kinds) === JSON.stringify(KINDS), `iamreal-verify: valid, ${JSON.stringify(kinds)}`);
  check(shown.length === KINDS.length, `the screens showed ${shown.length} card proofs done`);
  const scope = v.state.find((s: { scope_string: string }) => s.scope_string === threads.scopeStrings.test);
  const cards = scope?.cards ?? [];
  check(cards.length === 1 && cards[0].current === null && cards[0].last_card_proof === today(), `one card, no current account, last card proof ${today()}: ${JSON.stringify(cards)}`);
  check(shown.every((s) => s.shortId === shortId(cards[0]?.scoped_id ?? "")), `the short ID on the screens is the card's: ${shortId(cards[0]?.scoped_id ?? "")}`);
});

// Other cards declare an account: step 6 links to this card's page. And a
// submission whose answer is lost after the server appended the record.
const other = await makeCard({ serial: "0990567890abcdef1234567890abcdef" });
await tryStep("one card declares @dave: the account's link (account_cards 1)", async () => {
  component.card = fresh.spec();
  await toStatus();
  await typeAccount("dave");
  await waitConsequence();
  await finish({ label: "@dave, one card", button: fill(C.confirm.button_first, { account: "@dave" }), title: C.done.first, recordAccount: "dave", link: "account" });
});
await tryStep("a second card declares @dave: this card's link, and why (account_cards 2)", async () => {
  component.card = other.spec();
  await toStatus();
  await typeAccount("dave");
  await waitConsequence();
  await finish({ label: "@dave, a second card", button: fill(C.confirm.button_first, { account: "@dave" }), title: C.done.first, recordAccount: "dave", link: "card", otherCards: true, screenshots: "other-cards" });
});
await tryStep("account_cards missing from the answer: done all the same, this card's link, no sentence about other cards", async () => {
  component.card = other.spec();
  await toStatus();
  await clickChoice(C.choose.refresh);
  await waitConsequence();
  const seen: unknown[] = [];
  const undo = await intercept(
    "*/api/v1/records",
    async (p) => {
      const r = await page.send("Fetch.getResponseBody", { requestId: p.requestId });
      const body = JSON.parse(r.base64Encoded ? Buffer.from(r.body, "base64").toString() : r.body);
      seen.push(body.account_cards);
      delete body.account_cards;
      await page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: p.responseStatusCode, responseHeaders: p.responseHeaders, body: Buffer.from(JSON.stringify(body)).toString("base64") });
    },
    "Response",
  );
  try {
    const before = await recordCount();
    await page.clickButton(C.confirm.button_refresh);
    const d = await waitDoneOrMessage();
    check(JSON.stringify(seen) === "[2]", `the server answered account_cards ${JSON.stringify(seen)}; the page got none`);
    finishDone({ label: "refresh @dave, no account_cards", title: C.done.refresh, recordAccount: "dave", link: "card", otherCards: false }, d);
    check((await recordCount()) === before + 1, "one record");
  } finally {
    await undo();
  }
});

await tryStep("the answer to the submission lost, the record appended: 再試一次 gets challenge_used, the card's state shows the record (the real server)", async () => {
  component.card = fresh.spec();
  await toStatus();
  await clickChoice(C.choose.refresh);
  await waitConsequence();
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
    // No account_cards on this path: this card's link, and no sentence about other cards.
    finishDone({ label: "refresh @dave, found in the card's state", title: C.done.refresh, recordAccount: "dave", link: "card", otherCards: false }, d);
    check((await recordCount()) === before + 1, "one record, not two");
    await sleep(1500);
    await screenshot("challenge-used-6-done");
  } finally {
    await undo();
  }
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
  check(JSON.stringify(st.local) === JSON.stringify({ [STORAGE_KEY_PREFIX + "G3"]: "300" }), `localStorage holds only the CRL number: ${JSON.stringify(st.local)}`);
  check(st.session === 0 && st.idb.length === 0 && st.caches.length === 0 && st.cookies === "", `nothing else stored: ${JSON.stringify(st)}`);
});

// Last, because it leaves a higher CRL number behind.
await tryStep("before the PIN: a CRL older than the one this browser used", () =>
  stopsBeforePin("a CRL older than the one this browser used", main.spec(), C.stops.crl_rollback, "crl", {
    setup: async () => {
      await page.eval(`localStorage.setItem(${JSON.stringify(STORAGE_KEY_PREFIX + "G3")}, "301")`);
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
    windowCalls.every((c) => c.url === COMPONENT + "/popupForm" || (c.url === threads.profileUrl!("alice") && c.features === "noopener,noreferrer")),
    `every window.open of the page: the component's window, or the preview (${windowCalls.length} calls)`,
  );
  const workers = browser.requests.filter((r) => r.targetType === "worker").length;
  check(workers > 0, `the requests of the workers were seen too (${workers})`);
  const csp = browser.logs.filter((l) => /Content Security Policy/i.test(l.text));
  check(csp.length === 0, `no Content-Security-Policy violation ${JSON.stringify(csp.slice(0, 3))}`);
  // Two windows had no request: the silent component's, and the one opened for the second
  // signature that the challenge of another day stopped (the window is closed unused).
  // The blocked clicks opened none. A PIN the bridge does not send: its window is closed unused
  // (and may not have loaded).
  check(
    popups.size === component.requests.length + 2 + unusedWindows && unusedWindows <= 3,
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
    await ours.waitFor(step("platforms"), "the platforms in the page the other site opened");

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
    await ours.click('[data-platform="threads"]');
    await ours.waitFor(step("before"), "step 1");
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

writeFileSync(join(out, "ui-report.json"), JSON.stringify({ results, shown, component: component.requests.map((r) => ({ func: r.func, tbs: r.tbs })) }, null, 2));
await browser.close();
await component.stop();
server.kill();
moica.close();
writeFileSync(join(out, "server.log"), serverLog);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
