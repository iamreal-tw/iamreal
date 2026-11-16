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
//    cdp.ts): first the card, then the choice, then the declaration. A
//    first declaration; card proof again (no account typed); a switch, with
//    "上一步" back and forth; withdraw; declare the same account again (not a
//    switch); withdraw; declare another (a switch); switches used up (the
//    button cannot be pressed, and the engine refuses it too); a submission
//    that did not get through, one the server refused (with its request ID
//    on the screen); 回到開頭 on section 6 and 取消 on sections 3 and 4, then
//    card proofs again on the same page with the same proof engine; the
//    PIN's wait running out; a window the browser blocked on each of the
//    three clicks, then the same click again; every case that stops before
//    the PIN is asked; a wrong PIN, a locked card, a PIN that is not sent;
//    the PIN typed and 確認卡片 pressed again while the card is confirmed.
// 5. Publishes the daily snapshot and re-verifies it with iamreal-verify:
//    the state is the one the screens showed.
// 6. Checks the response headers, that the page is cross-origin isolated,
//    that no Content-Security-Policy was violated, that the page and its
//    workers connected to nothing but their own origin (the component's
//    window aside), and that the browser's storage holds the CRL numbers
//    and nothing else; that the PIN is in no field, attribute, storage or
//    global after it was used, and neither are the name, the certificates
//    and the card's signatures once a card proof was left.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, createServer as netServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
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
const today = taiwanDate(Date.now());

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
  // G3: fresh, with the revoked card's serial.
  G3: await makeCrl({ issuer: issuerKeys.G3, serials: [...randomSerials(20_000, 3n), revoked.serial], crlNumber: 300n, thisUpdate: new Date(now - 6 * 3600_000) }),
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
let serverLog = "";
const server: ChildProcess = spawn(
  serverBin,
  ["serve", "-data", data, "-bb", BB, "-crs", crsDir, "-addr", `127.0.0.1:${serverPort}`, "-web", dist, "-roster", "test", "-test-issuers", issuersDir, "-test-moica", moicaUrl],
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

const browser = await Browser.launch({ dir: out });
const page = await browser.newPage();
await page.send("Page.enable");
const C = COPY;

// The windows the page opens (the component's). Each has a name of its own
// (src/card/hipki.ts), so none is reused by name: the last one must be
// closed before the next one opens. A script the test adds to every load of
// the page wraps window.open and reports, through a DevTools binding, each
// window's name and how many earlier windows were still open at that moment.
const windows = { opened: 0, names: new Set<string>(), badNames: [] as string[], openedWhileAnother: 0 };
await page.send("Runtime.enable");
await page.send("Runtime.addBinding", { name: "__iamrealWindowOpened" });
await page.send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const open = window.open.bind(window);
    const opened = [];
    window.open = function (url, name, features) {
      const othersOpen = opened.filter((w) => !w.closed).length;
      const w = open(url, name, features);
      if (w) { opened.push(w); window.__iamrealWindowOpened(JSON.stringify({ name: String(name), othersOpen })); }
      return w;
    };
  })()`,
});
browser.on((m, p, s) => {
  if (m !== "Runtime.bindingCalled" || s !== page.sessionId || p.name !== "__iamrealWindowOpened") return;
  const r = JSON.parse(p.payload) as { name: string; othersOpen: number };
  windows.opened++;
  if (windows.names.has(r.name) || !/^iamreal-[0-9a-f]{32}$/.test(r.name)) windows.badNames.push(r.name);
  windows.names.add(r.name);
  if (r.othersOpen > 0) windows.openedWhileAnother++;
});
const results: Record<string, unknown> = {};

const step = (name: string) => `document.querySelector('[data-step="${name}"]')`;
const messageText = () => page.text("[data-message]");
const waitStep = (name: string, what: string, ms = 30_000) => page.waitFor(step(name), what, ms);

/** The beginning: section 1. */
async function open(): Promise<void> {
  await page.goto(PAGE);
  await waitStep("before_pin", "section 1");
}

const componentCount = (func?: string) => component.requests.filter((r) => func === undefined || r.func === func).length;
const popupCount = () => new Set(browser.requests.filter((r) => r.url.startsWith(COMPONENT + "/popupForm")).map((r) => r.sessionId)).size;
const cardStateCount = () => browser.requests.filter((r) => r.url.endsWith("/api/v1/card-state")).length;
const challengeCount = () => browser.requests.filter((r) => r.url.endsWith("/api/v1/challenges")).length;

/** Buttons on the screen: text and whether they can be pressed. */
const buttons = () => page.eval<{ text: string; disabled: boolean }[]>(`[...document.querySelectorAll('main button')].map((b) => ({ text: b.textContent, disabled: b.disabled }))`);

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
  check(m === C.confirm_card.popup_blocked, `${label}: a blocked window says "${m}"`);
  await sleep(500);
  check(componentCount() === requests && popupCount() === popups && componentCount("MakeSignature") === signs, `${label}: nothing reached the component`);
  // On section 2 the PIN field is emptied by the click, as always: the button waits for the PIN again.
  check((await buttons()).some((b) => b.text === text && b.disabled === !!o.pinCleared), `${label}: the same button ${o.pinCleared ? "is there, waiting for the PIN" : "can be pressed again"}`);
}

/** Reads the card; resolves when the PIN field is there, or with the message if the screen stopped. */
async function readCard(): Promise<{ pin: boolean; message: string }> {
  await page.clickButton(C.before_pin.read_card);
  return page.waitFor<{ pin: boolean; message: string }>(
    `(() => { const m = document.querySelector('[data-message]')?.innerText; if (m) return { pin: false, message: m };
      if (document.querySelector('#pin')) return { pin: true, message: "" }; return null; })()`,
    "the PIN field or a message",
    30_000,
  );
}

async function confirmPin(pin: string): Promise<void> {
  await page.type("#pin", pin);
  await page.clickButton(C.confirm_card.confirm_card);
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
 * beginning): its PIN, the name, the certificates and the card's signatures
 * are nowhere on the page.
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

/** The status lines of sections 1 and 2 ([data-working]) as they appear, recorded in the page. */
async function watchWorking(): Promise<void> {
  await page.eval(`(() => {
    if (!window.__working) {
      new MutationObserver(() => {
        const t = document.querySelector('[data-working]')?.textContent;
        if (t && window.__working.at(-1) !== t) window.__working.push(t);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    }
    window.__working = [];
  })()`);
}
const workingSeen = () => page.eval<string[]>(`window.__working ?? []`);

interface StatusSeen {
  state: string;
  first: string;
  facts: string[];
  buttons: { text: string; disabled: boolean }[];
  main: string;
}

async function waitStatus(): Promise<StatusSeen> {
  await waitStep("status", "section 3");
  return {
    state: await page.eval<string>(`document.querySelector('[data-step="status"]').dataset.state`),
    first: await page.text("[data-status]"),
    facts: await page.eval<string[]>(`[...document.querySelectorAll('[data-fact]')].map((e) => e.innerText)`),
    buttons: await buttons(),
    main: await page.text(),
  };
}

interface ConsequenceSeen {
  record: string;
  switchLine: string;
  buttons: string[];
  main: string;
}

async function waitConsequence(): Promise<ConsequenceSeen> {
  await waitStep("consequence", "section 4");
  return {
    record: await page.text("[data-record-line]"),
    switchLine: await page.text("[data-switch-line]"),
    buttons: (await buttons()).map((b) => b.text),
    main: await page.text(),
  };
}

/** Types an account on section 3 (a card that never declared) or on the account screen, and presses "下一步". */
async function typeAccount(account: string): Promise<void> {
  await page.eval(`document.querySelector('#account').value = ""`);
  await page.type("#account", account);
  await page.clickButton(C.status.next);
}

async function waitDoneOrMessage(): Promise<{ done: boolean; main: string; message: string }> {
  const r = await page.waitFor<string>(`document.querySelector('[data-step="done"]') ? "done" : (document.querySelector('[data-message]')?.innerText ? "message" : null)`, "done or a message", 120_000);
  return { done: r === "done", main: await page.text(), message: await messageText() };
}

const screens = join(out, "screens");
mkdirSync(screens);
async function screenshot(name: string): Promise<void> {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(screens, `${name}.png`), Buffer.from(data, "base64"));
}
/** The line of section 4 (ends with "，"), and of section 6 (ends with "。"). */
const consequenceLine = (account: string, withdraw = false) =>
  fill(withdraw ? C.consequence.record_withdraw : C.consequence.record_declare, { today, platform: PLATFORM, account });
const doneLine = (account: string, withdraw = false) => fill(withdraw ? C.done.record_withdraw : C.done.record_declare, { today, platform: PLATFORM, account });

interface Shown {
  kind: string;
  seq: number;
  shortId: string;
}
const shown: Shown[] = [];

/** Section 1, and reading the card up to section 3. */
async function toStatus(o: { wrongPinFirst?: boolean; blockClicks?: boolean; screenshots?: string; samePage?: boolean } = {}): Promise<StatusSeen> {
  // samePage: section 1 is on the screen already (after cancel, or back to the beginning); no new page load.
  if (o.samePage) await waitStep("before_pin", "section 1, same page");
  else await open();
  await watchWorking();
  const s1 = await page.text();
  for (const s of [
    fill(C.before_pin.title, { platform: PLATFORM }),
    C.before_pin.insert,
    C.before_pin.pin_purpose,
    C.before_pin.nothing_public,
    C.before_pin.local_heading,
    C.before_pin.local_certificate,
    C.before_pin.local_signature,
    C.before_pin.card_and_pin,
    C.before_pin.needs,
  ]) {
    check(s1.includes(s), `section 1 says "${s}"`);
  }
  check(!(await page.eval<boolean>(`!!document.querySelector('#pin') || !!document.querySelector('#account')`)), "section 1: no PIN field, no account field");
  if (o.screenshots) await screenshot(`${o.screenshots}-1-before-pin`);
  if (o.blockClicks) await blockedClick(C.before_pin.read_card, "blocked window, reading the card");
  const signsBefore = componentCount("MakeSignature");
  const cardStates = cardStateCount();
  const r = await readCard();
  check(r.pin, `the card was read; the PIN field appeared ${r.message}`);
  check((await page.text("[data-card-read]")).includes(fill(C.confirm_card.card_read, { name: "測試用戶" })), "the name is shown");
  check(componentCount("MakeSignature") === signsBefore && cardStateCount() === cardStates, "nothing was signed or asked before the PIN");
  if (o.screenshots) await screenshot(`${o.screenshots}-2-pin`);
  if (o.wrongPinFirst) {
    await confirmPin("000000");
    const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the wrong PIN's message");
    check(m === C.confirm_card.pin_incorrect, `wrong PIN: "${m}"`);
    check(await pinGone(), "wrong PIN: the field is empty");
    check(await page.eval<boolean>(`document.querySelector('#pin')?.disabled === false`), "wrong PIN: the field can be typed in again");
    await sleep(1500);
    check(componentCount("MakeSignature") === signsBefore + 1, "wrong PIN: sent once, not again by itself");
    check(await page.eval<boolean>(`document.querySelector('button.primary:not([hidden])')?.disabled === true`), "wrong PIN: the button waits for a new PIN");
  }
  if (o.blockClicks) {
    // The PIN is typed without a click (a click would give the page a user activation).
    await page.eval(`document.querySelector('#pin').focus()`);
    await page.send("Input.insertText", { text: PIN });
    await blockedClick(C.confirm_card.confirm_card, "blocked window, confirming the card", { pinCleared: true });
    check(await pinGone(), "blocked window: the PIN field is empty, the PIN nowhere");
    check(await page.eval<boolean>(`document.querySelector('#pin') !== null`), "blocked window: still section 2");
  }
  const signs = componentCount("MakeSignature");
  await confirmPin(PIN);
  const st = await waitStatus();
  check(await pinGone(), "after the first signature, the PIN is nowhere on the page");
  check(!st.main.includes("測試用戶") && !(await page.eval<boolean>(`document.documentElement.outerHTML.includes("測試用戶")`)), "the name is gone after section 2");
  check(componentCount("MakeSignature") === signs + 1, "the first signature");
  const lastSign = component.requests.filter((x) => x.func === "MakeSignature").at(-1)!;
  check(lastSign.tbs === "iamreal-test:threads:0_________" && lastSign.pin === PIN, "the first signature: the test scope string, with the PIN");
  // What the page said while it read the card, checked it, and had it sign.
  const working = await workingSeen();
  const order = [C.before_pin.reading, C.confirm_card.checking, C.confirm_card.signing].map((t) => working.indexOf(t));
  check(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!)), `sections 1 and 2 said, in order, ${JSON.stringify(working)}`);
  check(await page.eval<boolean>(`!document.querySelector('[data-working]')`), "the status line is gone on section 3");
  if (o.screenshots) await screenshot(`${o.screenshots}-3-status`);
  return st;
}

/** From section 4: the last click, section 5, section 6. */
async function finish(o: {
  label: string;
  button: string;
  title: string;
  recordAccount: string;
  withdraw?: boolean;
  dropFirstSubmission?: boolean;
  blockClick?: boolean;
  screenshots?: string;
}): Promise<void> {
  if (o.blockClick) await blockedClick(o.button, "blocked window, the second signature");
  const signs = componentCount("MakeSignature");
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
    const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the submission's failure", 120_000);
    check(m.startsWith(C.stops.submit_failed), `a submission that did not get through: "${m}"`);
    await page.clickButton(C.stops.retry);
    const d = await waitDoneOrMessage();
    off();
    await page.send("Fetch.disable");
    finishDone(o, d);
  } else {
    await page.clickButton(o.button);
    check((await page.text("[data-progress]")).startsWith(C.progress.signing), "section 5: the card signs");
    const threads = Number(await page.waitFor<string>(`document.querySelector('[data-progress] progress')?.dataset.threads`, "the progress bar", 30_000).catch(() => "0"));
    check(threads > 1, `section 5: the progress bar is timed for a multithreaded proof (${threads} threads)`);
    if (o.screenshots) await screenshot(`${o.screenshots}-5-progress`);
    const d = await waitDoneOrMessage();
    finishDone(o, d);
  }
  if (o.screenshots) await screenshot(`${o.screenshots}-6-done`);
  check(componentCount("MakeSignature") === signs + 1, "the second signature, once");
  const sign2 = component.requests.filter((x) => x.func === "MakeSignature").at(-1)!;
  check(/^D[0-9A-Z]{30}$/.test(sign2.tbs ?? "") && sign2.pin === PIN, "the second signature: a declaration code, with the PIN");
  check(await pinGone(), "after the second signature, the PIN is nowhere on the page");
  const timings = await page.eval<[string, number][]>(`performance.getEntriesByType("measure").map((e) => [e.name, Math.round(e.duration)])`);
  results[o.label] = { timings };
  console.log(`   times (ms): ${timings.map(([n, ms]) => `${n.replace("iamreal:", "")} ${ms}`).join(", ")}`);
}

function finishDone(o: { title: string; recordAccount: string; withdraw?: boolean; label: string }, d: { done: boolean; main: string; message: string }): void {
  if (!check(d.done, `${o.label}: done ${d.message}`)) return;
  const lines = d.main.split("\n").filter(Boolean);
  check(lines[0] === o.title, `section 6: "${lines[0]}"`);
  const m = /名冊第 (\d+) 筆：(.*)$/.exec(d.main.split("\n").find((l) => l.startsWith("名冊第")) ?? "");
  check(!!m && m[2] === doneLine(o.recordAccount, o.withdraw), `section 6: the record line "${m?.[0]}"`);
  const sid = /編號開頭是 ([0-9A-Z]{6})。/.exec(d.main)?.[1] ?? "";
  check(d.main.includes(fill(C.done.short_id, { platform: PLATFORM, short_id: sid })) && d.main.includes(C.done.unplug), "section 6: the short ID and the rest");
  check(d.main.includes(C.done.advice) === !o.withdraw, `section 6: the advice to come back ${o.withdraw ? "is not there (withdrawn)" : "is there"}`);
  check(lines.at(-1) === C.done.restart, `section 6 ends with the button "${lines.at(-1)}"`);
  shown.push({ kind: o.title, seq: Number(m?.[1]), shortId: sid });
}

/** Section 4 says what the roster will record, and offers "上一步" and the last button. */
function checkConsequence(label: string, c: ConsequenceSeen, o: { account: string; withdraw?: boolean; switchesLeft?: number; button: string }): void {
  check(c.record === consequenceLine(o.account, o.withdraw), `${label}: section 4 records "${c.record}"`);
  check(c.main.includes(C.consequence.record_intro) && c.main.includes(C.consequence.with_id) && c.main.includes(C.consequence.permanent), `${label}: section 4, the record and that it cannot be deleted`);
  const switchLine = o.switchesLeft === undefined ? "" : fill(C.consequence.uses_switch, { switches_left: o.switchesLeft });
  check(c.switchLine === switchLine, `${label}: section 4, the switch line "${c.switchLine}"`);
  check(c.main.includes(o.withdraw ? C.consequence.later_withdraw : C.consequence.later), `${label}: section 4, what can be done later`);
  check(JSON.stringify(c.buttons) === JSON.stringify([C.consequence.back, C.consequence.cancel, o.button]), `${label}: section 4 buttons ${JSON.stringify(c.buttons)}`);
}

const tryStep = async (label: string, f: () => Promise<void>) => {
  console.log(`\n== ${label}`);
  try {
    await f();
  } catch (e) {
    check(false, `${label}: ${e instanceof Error ? e.stack : String(e)}`);
  }
};

// Every card proof here is today: 上次過卡是今天 (not 0 天前).
const declaredFacts = (switchesUsed: number) => [C.status.last_card_proof_today, fill(C.status.switches, { switches_used: switchesUsed, switches_left: 2 - switchesUsed })];
const choiceButtons = (st: StatusSeen) => JSON.stringify(st.buttons);

component.card = main.spec();

await tryStep("declare @alice (a wrong PIN first; a blocked window on each click)", async () => {
  const st = await toStatus({ wrongPinFirst: true, blockClicks: true, screenshots: "declare" });
  check(st.state === "never" && st.first === fill(C.status.not_declared, { platform: PLATFORM }), `section 3: "${st.first}"`);
  check(st.main.includes(C.status.account_label) && st.main.includes(fill(C.status.one_account, { platform: PLATFORM })) && st.main.includes(C.status.no_check), "section 3: the account field and what it means");
  await typeAccount("al ice");
  check((await messageText()) === C.status.bad_username, "an account not in the format: the message, and still section 3");
  await typeAccount("alice");
  const cq = await waitConsequence();
  checkConsequence("first", cq, { account: "alice", button: fill(C.consequence.button_first, { account: "alice" }) });
  await screenshot("declare-4-consequence");
  await finish({ label: "declare @alice", button: fill(C.consequence.button_first, { account: "alice" }), title: C.done.first, recordAccount: "alice", blockClick: true, screenshots: "declare" });
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

await tryStep("card proof again, no account typed (the first submission dropped)", async () => {
  const st = await toStatus();
  check(st.state === "declared" && st.first === fill(C.status.current, { account: "alice" }), `section 3: "${st.first}"`);
  check(JSON.stringify(st.facts) === JSON.stringify(declaredFacts(0)), `section 3 facts ${JSON.stringify(st.facts)}`);
  check(choiceButtons(st) === JSON.stringify([C.status.refresh, C.status.switch, C.status.withdraw, C.status.cancel].map((text) => ({ text, disabled: false }))), `section 3 choices ${choiceButtons(st)}`);
  check(st.main.includes(C.status.refresh_note) && st.main.includes(C.status.uses_switch), "section 3: what each choice does");
  check(!(await page.eval<boolean>(`!!document.querySelector('#account')`)), "no account field");
  await screenshot("refresh-3-status");
  await page.clickButton(C.status.refresh);
  checkConsequence("refresh", await waitConsequence(), { account: "alice", button: C.consequence.button_refresh });
  await finish({ label: "refresh", button: C.consequence.button_refresh, title: C.done.refresh, recordAccount: "alice", dropFirstSubmission: true });
});

await tryStep("switch to @bob, with 上一步 back and forth", async () => {
  await toStatus();
  const signs = componentCount();
  const states = cardStateCount();
  const challenges = challengeCount();
  await page.clickButton(C.status.switch);
  await waitStep("account", "the account screen");
  check((await page.text()).includes(C.status.new_account_label), "the account screen: 新的帳號");
  await typeAccount("bob");
  const cq = await waitConsequence();
  await screenshot("switch-4-consequence");
  checkConsequence("switch", cq, { account: "bob", switchesLeft: 1, button: fill(C.consequence.button_switch, { account: "bob" }) });
  await page.clickButton(C.consequence.back);
  await waitStep("account", "back: the account screen");
  check((await page.eval<string>(`document.querySelector('#account').value`)) === "bob", "back: the account typed is still there");
  await page.clickButton(C.status.back);
  const again = await waitStatus();
  check(again.first === fill(C.status.current, { account: "alice" }), "back: section 3 again");
  await page.clickButton(C.status.withdraw);
  checkConsequence("withdraw, looked at", await waitConsequence(), { account: "alice", withdraw: true, button: fill(C.consequence.button_withdraw, { account: "alice" }) });
  await page.clickButton(C.consequence.back);
  await waitStatus();
  await page.clickButton(C.status.switch);
  await waitStep("account", "the account screen");
  await typeAccount("bob");
  await waitConsequence();
  check(componentCount() === signs && cardStateCount() === states && challengeCount() === challenges, "back and forth: no signature, no card-state, no challenge");
  await finish({ label: "switch to @bob", button: fill(C.consequence.button_switch, { account: "bob" }), title: fill(C.done.switch, { account: "bob" }), recordAccount: "bob" });
});

await tryStep("withdraw @bob", async () => {
  const st = await toStatus();
  check(JSON.stringify(st.facts) === JSON.stringify(declaredFacts(1)), `section 3 facts ${JSON.stringify(st.facts)}`);
  await page.clickButton(C.status.withdraw);
  checkConsequence("withdraw", await waitConsequence(), { account: "bob", withdraw: true, button: fill(C.consequence.button_withdraw, { account: "bob" }) });
  await finish({ label: "withdraw @bob", button: fill(C.consequence.button_withdraw, { account: "bob" }), title: C.done.withdraw, recordAccount: "bob", withdraw: true });
});

await tryStep("withdrawn: declare @bob again (not a switch)", async () => {
  const st = await toStatus();
  check(st.state === "withdrawn" && st.first === fill(C.status.withdrawn, { last_declared: "bob" }), `section 3: "${st.first}"`);
  const back = fill(C.status.declare_back, { last_declared: "bob" });
  check(choiceButtons(st) === JSON.stringify([back, C.status.declare_other, C.status.cancel].map((text) => ({ text, disabled: false }))), `section 3 choices ${choiceButtons(st)}`);
  check(st.main.includes(C.status.not_a_switch) && st.main.includes(C.status.uses_switch), "section 3: which one is a switch");
  await screenshot("withdrawn-3-status");
  await page.clickButton(back);
  checkConsequence("declare again", await waitConsequence(), { account: "bob", button: fill(C.consequence.button_first, { account: "bob" }) });
  // A refresh by the roster rules; to the cardholder, 已宣告.
  await finish({ label: "declare @bob again", button: fill(C.consequence.button_first, { account: "bob" }), title: C.done.first, recordAccount: "bob" });
});

await tryStep("withdraw @bob again", async () => {
  const st = await toStatus();
  check(JSON.stringify(st.facts) === JSON.stringify(declaredFacts(1)), `section 3 facts ${JSON.stringify(st.facts)}`);
  await page.clickButton(C.status.withdraw);
  await waitConsequence();
  await finish({ label: "withdraw @bob again", button: fill(C.consequence.button_withdraw, { account: "bob" }), title: C.done.withdraw, recordAccount: "bob", withdraw: true });
});

await tryStep("withdrawn: declare another account, @carol (a switch)", async () => {
  await toStatus();
  await page.clickButton(C.status.declare_other);
  await waitStep("account", "the account screen");
  await typeAccount("carol");
  checkConsequence("declare another", await waitConsequence(), { account: "carol", switchesLeft: 0, button: fill(C.consequence.button_switch, { account: "carol" }) });
  await finish({ label: "declare @carol", button: fill(C.consequence.button_switch, { account: "carol" }), title: fill(C.done.switch, { account: "carol" }), recordAccount: "carol" });
});

// Switches used up: the button cannot be pressed, and the engine refuses the switch itself.
// Then a submission the server refuses: its code and request ID on the screen.
await tryStep("switches used up; then a submission the server refuses", async () => {
  const st = await toStatus();
  check(JSON.stringify(st.facts) === JSON.stringify(declaredFacts(2)), `section 3 facts ${JSON.stringify(st.facts)}`);
  const sw = st.buttons.find((b) => b.text === C.status.switch);
  check(sw?.disabled === true, "改成別的帳號 cannot be pressed");
  const next = /下一次可以更換是 (\d{4}-\d{2}-\d{2})。/.exec(st.main)?.[1] ?? "";
  check(next === new Date(Date.parse(today + "T00:00:00Z") + 365 * 86_400_000).toISOString().slice(0, 10) && st.main.includes(fill(C.status.switch_limit, { next_switch_date: next })), `the sentence next to it: next switch ${next}`);
  check(!st.main.includes(C.status.uses_switch), "no 會用掉一次更換 next to a button that cannot be pressed");
  await screenshot("limit-3-status");
  // Pressed anyway (the attribute removed by a script): the engine refuses it, and nothing is signed.
  const signs = componentCount();
  const challenges = challengeCount();
  await page.eval(`[...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.status.switch)}).disabled = false`);
  await page.clickButton(C.status.switch);
  await waitStep("account", "the account screen");
  await typeAccount("dave");
  const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText || null`, "the engine's refusal");
  check(m === "switch_limit" && (await page.eval<boolean>(`!!${step("account")}`)), `the engine refuses the switch: "${m}", still the account screen`);
  check(componentCount() === signs && challengeCount() === challenges, "refused: no signature, no challenge");
  await page.clickButton(C.status.back);
  await waitStatus();
  await page.clickButton(C.status.refresh);
  checkConsequence("refresh @carol", await waitConsequence(), { account: "carol", button: C.consequence.button_refresh });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/v1/records", requestStage: "Request" }] });
  const off = browser.on((msg, p, s) => {
    if (msg !== "Fetch.requestPaused" || s !== page.sessionId) return;
    // Another account: the proof no longer verifies.
    const body = JSON.parse(p.request.postData);
    body.username = "carl";
    void page.send("Fetch.continueRequest", { requestId: p.requestId, postData: Buffer.from(JSON.stringify(body)).toString("base64") });
  });
  await page.clickButton(C.consequence.button_refresh);
  const d = await waitDoneOrMessage();
  off();
  await page.send("Fetch.disable");
  const id = await page.text("[data-request-id]");
  const expected = fill(C.stops.rejected, { code: "proof" });
  check(!d.done && d.message.startsWith(expected), `refused: "${d.message}"`);
  const res = browser.responses.filter((r) => r.url.endsWith("/api/v1/records") && r.status === 400).at(-1);
  check(/^[0-9a-f]{16}$/.test(id) && res?.headers["x-request-id"] === id, `the request ID on the screen (${id}) is the response's (${res?.headers["x-request-id"]})`);
  check(d.message === `${expected}\n${fill(C.stops.request_id, { request_id: id })}`, `the request ID follows its label, on the next line: ${JSON.stringify(d.message)}`);
  check(serverLog.includes(`"id":"${id}"`) && serverLog.includes(`"error":"proof"`), "the server's log line has the same ID");
});

// From here to the PIN's wait running out, one page load: 回到開頭 and 取消 start the
// next card proof on the same page, with the same proof engine (ADR-0013).
const crsG1 = "/crs/bn254_g1_compressed_2p18.dat";
let samePage: { timeOrigin: number; crsFetches: number } | null = null;
const crsFetchCount = () => browser.requests.filter((r) => r.url.endsWith(crsG1)).length;

/** Section 1 again, on the same page, with no sentence; nothing of the last card proof on the page. */
async function backAtTheBeginning(label: string): Promise<void> {
  await waitStep("before_pin", `${label}: section 1`);
  check((await messageText()) === "", `${label}: section 1, with no message`);
  check((await buttons()).some((b) => b.text === C.before_pin.read_card && !b.disabled), `${label}: the read button is there`);
  await lastCardProofGone(label, main);
}

await tryStep("withdraw @carol; then 回到開頭", async () => {
  await toStatus();
  samePage = { timeOrigin: await page.eval<number>("performance.timeOrigin"), crsFetches: crsFetchCount() };
  await page.clickButton(C.status.withdraw);
  await waitConsequence();
  await finish({ label: "withdraw @carol", button: fill(C.consequence.button_withdraw, { account: "carol" }), title: C.done.withdraw, recordAccount: "carol", withdraw: true });
  await page.clickButton(C.done.restart);
  await backAtTheBeginning("回到開頭");
});

await tryStep("withdrawn, switches used up: 宣告別的帳號 cannot be pressed; then 取消 on section 3", async () => {
  const st = await toStatus({ samePage: true });
  check(st.first === fill(C.status.withdrawn, { last_declared: "carol" }), `section 3: "${st.first}"`);
  check(st.buttons.find((b) => b.text === C.status.declare_other)?.disabled === true, "宣告別的帳號 cannot be pressed");
  check(st.buttons.find((b) => b.text === fill(C.status.declare_back, { last_declared: "carol" }))?.disabled === false, "宣告回 @carol can");
  check(/一年最多更換兩次，下一次可以更換是 \d{4}-\d{2}-\d{2}。/.test(st.main), "the sentence next to it");
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await page.clickButton(C.status.cancel);
  await backAtTheBeginning("取消 on section 3");
  await sleep(500);
  check(componentCount("MakeSignature") === signs && challengeCount() === challenges, "取消 on section 3: no second signature, no challenge");
});

await tryStep("取消 on section 4, and on the account screen", async () => {
  // Section 4.
  await toStatus({ samePage: true });
  const signs = componentCount("MakeSignature");
  const challenges = challengeCount();
  await page.clickButton(fill(C.status.declare_back, { last_declared: "carol" }));
  await waitConsequence();
  await page.clickButton(C.consequence.cancel);
  await backAtTheBeginning("取消 on section 4");
  // The account screen (also section 3). Switches are used up here, so the button is opened by a script.
  await toStatus({ samePage: true });
  await page.eval(`[...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.status.declare_other)}).disabled = false`);
  await page.clickButton(C.status.declare_other);
  await waitStep("account", "the account screen");
  await page.clickButton(C.status.cancel);
  await backAtTheBeginning("取消 on the account screen");
  await sleep(500);
  check(componentCount("MakeSignature") === signs + 1 && challengeCount() === challenges, "取消: the first signature of each card proof only, no challenge");
});

await tryStep("the PIN's wait runs out: back to the beginning", async () => {
  const st = await toStatus({ samePage: true });
  const signs = componentCount("MakeSignature");
  await page.clickButton(fill(C.status.declare_back, { last_declared: "carol" }));
  await waitConsequence();
  const t0 = Date.now();
  await waitStep("before_pin", "the beginning, after the wait", IDLE_MS + 15_000);
  const waited = Date.now() - t0;
  const m = await messageText();
  check(m === C.before_pin.idle && st.state === "withdrawn", `back to the beginning after ${Math.round(waited / 1000)} s: "${m}"`);
  check(await pinGone(), "the wait ran out: the PIN is nowhere on the page");
  await lastCardProofGone("the wait ran out", main);
  check(componentCount("MakeSignature") === signs, "no second signature");
  check((await buttons()).some((b) => b.text === C.before_pin.read_card && !b.disabled), "the read button is there");
});

await tryStep("the same page after 回到開頭, 取消 and the wait: declare @carol again, withdraw again", async () => {
  await toStatus({ samePage: true });
  await page.clickButton(fill(C.status.declare_back, { last_declared: "carol" }));
  await waitConsequence();
  await finish({ label: "declare @carol again, same page", button: fill(C.consequence.button_first, { account: "carol" }), title: C.done.first, recordAccount: "carol" });
  await page.clickButton(C.done.restart);
  await backAtTheBeginning("回到開頭 after a declaration");
  const st = await toStatus({ samePage: true });
  check(st.first === fill(C.status.current, { account: "carol" }) && JSON.stringify(st.facts) === JSON.stringify(declaredFacts(2)), `section 3: "${st.first}" ${JSON.stringify(st.facts)}`);
  await page.clickButton(C.status.withdraw);
  await waitConsequence();
  await finish({ label: "withdraw @carol again, same page", button: fill(C.consequence.button_withdraw, { account: "carol" }), title: C.done.withdraw, recordAccount: "carol", withdraw: true });
  // One page load, one proof engine: the CRS was fetched once, the engine started once.
  const engineStarts = await page.eval<number>(`performance.getEntriesByName("iamreal:engine_engine_total").length`);
  check(
    samePage !== null && (await page.eval<number>("performance.timeOrigin")) === samePage.timeOrigin && crsFetchCount() === samePage.crsFetches && engineStarts === 1,
    `seven card proofs on one page load (three done), one proof engine: CRS fetched ${crsFetchCount() - (samePage?.crsFetches ?? 0)} more times, engine started ${engineStarts} time(s)`,
  );
});

// After the PIN: a locked card, a challenge dated another day.
await tryStep("a wrong PIN that locks the card", async () => {
  component.card = lockable.spec();
  await open();
  check((await readCard()).pin, "read");
  await confirmPin("000000");
  const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the message");
  check(m === C.stops.card_locked, `locked: "${m}"`);
  check(await pinGone(), "locked: the PIN is nowhere");
});
/** Component windows opened for a request that was never sent (a PIN the bridge does not send). */
let unusedWindows = 0;
await tryStep("a PIN with +, % or a character that is not ASCII: not sent", async () => {
  component.card = main.spec();
  for (const bad of ["12+456", "12%456", "１２３４５６"]) {
    await open();
    check((await readCard()).pin, "read");
    const signs = componentCount("MakeSignature");
    const states = cardStateCount();
    const popups = popupCount();
    await confirmPin(bad);
    const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the message");
    check(m === C.confirm_card.pin_characters, `PIN ${JSON.stringify(bad)}: "${m}"`);
    await sleep(500);
    unusedWindows += popupCount() - popups;
    check(componentCount("MakeSignature") === signs && cardStateCount() === states, `PIN ${JSON.stringify(bad)}: nothing sent to the card, no card-state`);
    check((await foundOnPage([bad])).length === 0, `PIN ${JSON.stringify(bad)}: nowhere on the page`);
    check((await buttons()).some((b) => b.text === C.before_pin.read_card && !b.disabled), `PIN ${JSON.stringify(bad)}: the read button is there again`);
  }
});

await tryStep("a challenge dated another day", async () => {
  component.card = fresh.spec();
  await open();
  check((await readCard()).pin, "read");
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
  await page.clickButton(fill(C.consequence.button_first, { account: "alice" }));
  const d = await waitDoneOrMessage();
  await undo();
  check(!d.done && d.message === C.stops.date_mismatch, `challenge of another day: "${d.message}"`);
  await sleep(500);
  check(componentCount("MakeSignature") === signs, "no second signature");
});

// On section 2, the PIN typed again and 確認卡片 pressed again while the first
// confirmation is under way (the server slow to answer card-state). It used
// to have the card sign a second time and send card-state again, and to leave
// the first wait's timer running, which could later stop a card proof whose
// record was already sent.
await tryStep("確認卡片 pressed again while the card is confirmed: one signature, one card-state", async () => {
  component.card = main.spec();
  await open();
  check((await readCard()).pin, "read");
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
    const during = await page.eval<{ pin: boolean | null; button: boolean | null }>(`({
      pin: document.querySelector('#pin')?.disabled ?? null,
      button: [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.confirm_card.confirm_card)})?.disabled ?? null,
    })`);
    check(during.pin === true && during.button === true, `while the card is confirmed, the PIN field and the button cannot be used: ${JSON.stringify(during)}`);
    // Typed and pressed again anyway, with the keyboard and the mouse.
    await confirmPin(PIN);
    await sleep(1500);
    check(componentCount("MakeSignature") === signs + 1, `pressed again: the card was asked to sign once (${componentCount("MakeSignature") - signs} times)`);
    check(cardStateCount() === states + 1, `pressed again: one card-state (${cardStateCount() - states})`);
    check((await messageText()) === "", `pressed again: no message "${await messageText()}"`);
    await release();
    const st = await waitStatus();
    check(st.state === "withdrawn", `section 3 after the answer: "${st.first}"`);
    await sleep(1000);
    check(componentCount("MakeSignature") === signs + 1 && cardStateCount() === states + 1, "the first confirmation, once: one signature, one card-state");
  } finally {
    await release();
    await undo();
  }
  await page.clickButton(C.status.cancel);
  await backAtTheBeginning("取消 after 確認卡片 pressed again");
});

/** A case that stops in section 2, before the PIN is asked. */
async function stopsBeforePin(label: string, card: FakeCardSpec | null, expected: string, o: { setup?: () => Promise<() => Promise<void>>; silent?: boolean } = {}): Promise<void> {
  component.card = card;
  component.silent = o.silent ?? false;
  await open();
  const undo = o.setup ? await o.setup() : null;
  const signs = componentCount("MakeSignature");
  const cardStates = cardStateCount();
  const r = await readCard();
  check(!r.pin && r.message === expected, `${label}: "${r.message}"`);
  await sleep(300);
  check(!(await page.eval<boolean>(`!!document.querySelector('#pin')`)), `${label}: no PIN field`);
  check(componentCount("MakeSignature") === signs, `${label}: nothing signed`);
  check(cardStateCount() === cardStates, `${label}: no card-state request`);
  check((await buttons()).some((b) => b.text === C.before_pin.read_card && !b.disabled), `${label}: the read button is there again`);
  if (undo) await undo();
  component.silent = false;
}

/** Answers a same-origin request of the page with other bytes, or fails it. */
async function intercept(pattern: string, act: (p: any) => Promise<unknown>): Promise<() => Promise<void>> {
  await page.send("Fetch.enable", { patterns: [{ urlPattern: pattern, requestStage: "Request" }] });
  const off = browser.on((m, p, s) => {
    if (m === "Fetch.requestPaused" && process.env.DEBUG_FETCH) console.log(`   paused ${s} ${p.requestId} ${p.networkId} ${p.request?.url} ${p.responseStatusCode ?? "request"}`);
    if (m === "Fetch.requestPaused" && s === page.sessionId) act(p).catch((e) => console.log(`   (intercepting ${p.request?.url}: ${e.message})`));
  });
  return async () => {
    off();
    await page.send("Fetch.disable");
  };
}

// Every case that stops before the PIN.
const tests: [string, FakeCardSpec | null, string, Parameters<typeof stopsBeforePin>[3]?][] = [
  ["the component does not answer", main.spec(), C.stops.component_unreachable + " " + C.links.prepare, { silent: true }],
  ["no card", { ...main.spec(), noCard: true }, C.stops.no_card],
  ["no certificate on the card", { ...main.spec(), certificates: [] }, C.stops.no_certificate],
  ["expired", expired.spec(), fill(C.stops.expired, { expiry_date: "2025-12-31" })],
  ["not yet valid", notYet.spec(), fill(C.stops.not_yet_valid, { valid_from: notYetTaiwan })],
  ["not a citizen's primary card", foreign.spec(), C.stops.not_citizen_primary],
  ["a format the circuit does not take", bigKey.spec(), C.stops.unsupported_format],
  ["two certificates that pass", { ...main.spec(), certificates: [...main.spec().certificates, ...revoked.spec().certificates] }, C.stops.unsupported_format],
  ["not issued by MOICA", unknownIssuer.spec(), C.stops.unknown_issuer],
  ["revoked", revoked.spec(), C.stops.revoked],
  ["the CRL is 5 days old", g2card.spec(), fill(C.stops.crl_stale, { crl_days: 5 })],
  [
    "the mirror's index has no usable CRL",
    main.spec(),
    fill(C.stops.crl_unavailable, { code: "crl_unavailable" }),
    {
      setup: () =>
        intercept("*/crl/index.jsonl", (p) => page.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/jsonl" }], body: "" })),
    },
  ],
  [
    "a circuit file with other bytes",
    main.spec(),
    C.stops.artifact,
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
    { setup: () => intercept("*/api/v1/config", (p) => page.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "ConnectionFailed" })) },
  ],
];
for (const [label, card, expected, o] of tests) await tryStep(`before the PIN: ${label}`, () => stopsBeforePin(label, card, expected, o));

// 5. Snapshot and re-verification -----------------------------------------------

const KINDS = ["first", "refresh", "switch", "withdraw", "refresh", "withdraw", "switch", "withdraw", "refresh", "withdraw"];
await tryStep("snapshot and iamreal-verify", async () => {
  execFileSync(serverBin, ["snapshot", "-data", data, "-bb", BB, "-crs", crsDir, "-roster", "test", "-test-issuers", issuersDir], { stdio: "pipe" });
  const v = JSON.parse(
    execFileSync(verifyBin, ["-bb", BB, "-crs", crsDir, "-roster", "test", "-json", "-test-issuers", issuersDir, "-crl-archive", join(data, "crl"), join(data, "roster")], { stdio: ["ignore", "pipe", "pipe"] }).toString(),
  );
  writeFileSync(join(out, "verify.json"), JSON.stringify(v, null, 2));
  const kinds = v.results.map((r: { kind: string }) => r.kind);
  check(v.valid === true && JSON.stringify(kinds) === JSON.stringify(KINDS), `iamreal-verify: valid, ${JSON.stringify(kinds)}`);
  check(JSON.stringify(shown.map((s) => s.seq)) === JSON.stringify(KINDS.map((_, i) => i + 1)), `the screens showed records ${JSON.stringify(shown.map((s) => s.seq))}`);
  const scope = v.state.find((s: { scope_string: string }) => s.scope_string === "iamreal-test:threads:0_________");
  const cards = scope?.cards ?? [];
  check(cards.length === 1 && cards[0].current === null && cards[0].last_card_proof === today, `one card, no current account, last card proof ${today}: ${JSON.stringify(cards)}`);
  check(shown.every((s) => s.shortId === shortId(cards[0]?.scoped_id ?? "")), `the short ID on the screens is the card's: ${shortId(cards[0]?.scoped_id ?? "")}`);
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
  stopsBeforePin("a CRL older than the one this browser used", main.spec(), C.stops.crl_rollback, {
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
  const popups = new Set(browser.requests.filter((r) => r.url.startsWith(COMPONENT + "/popupForm")).map((r) => r.sessionId));
  const ours = browser.requests.filter((r) => ["page", "worker", "iframe"].includes(r.targetType));
  const outside = ours.filter((r) => {
    if (r.url.startsWith("about:")) return false;
    const origin = new URL(r.url).origin;
    return popups.has(r.sessionId) ? origin !== componentOrigin : origin !== PAGE_ORIGIN;
  });
  const types = [...new Set(ours.map((r) => r.targetType))];
  check(outside.length === 0, `the page and its workers (${types.join(", ")}) connected only to ${PAGE_ORIGIN}; the component's window only to ${componentOrigin}: ${JSON.stringify(outside.slice(0, 5))}`);
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
    await ours.waitFor(step("before_pin"), "section 1 in the page the other site opened");

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
    // The last case above left a higher CRL number behind; this card proof should get to the PIN.
    await ours.eval(`localStorage.removeItem(${JSON.stringify(STORAGE_KEY_PREFIX + "G3")})`);
    component.hold = new Promise<void>((r) => (release = r));
    const requests = component.requests.length;
    await ours.send("Page.bringToFront");
    await ours.clickButton(C.before_pin.read_card);
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
    const r = await ours
      .waitFor<{ pin: boolean; message: string }>(
        `(() => { const m = document.querySelector('[data-message]')?.innerText; if (m) return { pin: false, message: m };
          if (document.querySelector('#pin')) return { pin: true, message: "" }; return null; })()`,
        "the PIN field or a message",
        40_000,
      )
      .catch(() => ({ pin: false, message: "(nothing)" }));
    check(r.pin, `the page and the component's window went back and forth: ${r.pin ? "the PIN field" : r.message}`);

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
