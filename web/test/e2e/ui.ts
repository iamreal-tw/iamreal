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
//    cdp.ts): declare, card proof again, switch, switch to the limit,
//    withdraw; every case that stops before the PIN is asked; a wrong PIN,
//    a locked card, a submission that did not get through, one the server
//    refused (with its request ID on the screen).
// 5. Publishes the daily snapshot and re-verifies it with iamreal-verify:
//    the state is the one the screens showed.
// 6. Checks the response headers, that the page is cross-origin isolated,
//    that no Content-Security-Policy was violated, that the page and its
//    workers connected to nothing but their own origin (the component's
//    window aside), and that the browser's storage holds the CRL numbers
//    and nothing else; that the PIN is in no field, attribute, storage or
//    global after it was used.
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
import { Browser, type Page, sleep } from "./cdp.ts";
import { FakeComponent, type FakeCardSpec } from "./fake-component.ts";
import { CONTENT_SECURITY_POLICY, ISOLATION_HEADERS } from "./headers.ts";

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
const results: Record<string, unknown> = {};

const step = (name: string) => `document.querySelector('[data-step="${name}"]')`;
const messageText = () => page.text("[data-message]");

async function open(): Promise<void> {
  await page.goto(PAGE);
  await page.waitFor(step("enter"), "screen 1");
}

async function toBeforePin(account: string | null): Promise<void> {
  await open();
  if (account === null) {
    await page.clickButton(C.enter.withdraw);
  } else {
    await page.type("#account", account);
    await page.clickButton(C.enter.next);
  }
  await page.waitFor(step("before_pin"), "screen 2");
}

/** Reads the card; resolves when the PIN field is there, or with the message if the screen stopped. */
async function readCard(): Promise<{ pin: boolean; message: string }> {
  await page.clickButton(C.before_pin.read_card);
  const r = await page.waitFor<{ pin: boolean; message: string }>(
    `(() => { const m = document.querySelector('[data-message]')?.innerText; if (m) return { pin: false, message: m };
      if (document.querySelector('#pin')) return { pin: true, message: "" }; return null; })()`,
    "the PIN field or a message",
    30_000,
  );
  return r;
}

async function confirmPin(pin: string): Promise<void> {
  await page.type("#pin", pin);
  await page.clickButton(C.before_pin.confirm_card);
}

/** Nothing of the PIN anywhere the page keeps things. */
async function pinGone(): Promise<boolean> {
  return page.eval<boolean>(`(() => {
    const pin = ${JSON.stringify(PIN)};
    const f = document.querySelector('#pin');
    if (f && f.value !== "") return false;
    if (document.documentElement.outerHTML.includes(pin) || location.href.includes(pin)) return false;
    for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) if ((s.key(i) + s.getItem(s.key(i))).includes(pin)) return false;
    for (const k of Object.keys(window)) { try { if (String(window[k]).includes(pin)) return false; } catch {} }
    return true;
  })()`);
}

async function waitStatus(): Promise<{ status: string; buttons: string[]; main: string }> {
  await page.waitFor(step("status"), "screen 3", 30_000);
  return {
    status: await page.text("[data-status]"),
    buttons: await page.eval<string[]>(`[...document.querySelectorAll('button')].map((b) => b.textContent)`),
    main: await page.text(),
  };
}

async function waitDoneOrMessage(): Promise<{ done: boolean; main: string; message: string }> {
  const r = await page.waitFor<string>(`document.querySelector('[data-step="done"]') ? "done" : (document.querySelector('[data-message]')?.innerText ? "message" : null)`, "done or a message", 120_000);
  return { done: r === "done", main: await page.text(), message: await messageText() };
}

const componentCount = (func: string) => component.requests.filter((r) => r.func === func).length;

const screens = join(out, "screens");
mkdirSync(screens);
async function screenshot(name: string): Promise<void> {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(screens, `${name}.png`), Buffer.from(data, "base64"));
}
const recordLine = (account: string, withdraw = false) =>
  fill(withdraw ? C.status.record_withdraw : C.status.record_declare, { today, platform: PLATFORM, account });

interface Shown {
  kind: string;
  seq: number;
  shortId: string;
}
const shown: Shown[] = [];

/** One whole card proof that is expected to finish. */
async function cardProof(o: {
  label: string;
  account: string | null;
  statusText: string;
  button: string;
  title: string;
  recordAccount: string;
  wrongPinFirst?: boolean;
  dropFirstSubmission?: boolean;
  /** A name for screenshots of each screen (test-output/ui/screens/). */
  screenshots?: string;
}): Promise<void> {
  console.log(`\n== ${o.label}`);
  component.card = main.spec();
  if (o.screenshots) {
    await open();
    await page.type("#account", o.account ?? "");
    await screenshot(`${o.screenshots}-1-account`);
  }
  await toBeforePin(o.account);
  if (o.screenshots) await screenshot(`${o.screenshots}-2-before-pin`);
  const screen2 = await page.text();
  if (o.account !== null) {
    // The four things: the account, what is published, what stays, the card and PIN.
    for (const s of [
      fill(C.before_pin.declaring, { platform: PLATFORM }),
      `@${o.account}`,
      fill(C.before_pin.public_declare, { platform: PLATFORM, account: o.account }),
      C.before_pin.local_pin,
      C.before_pin.local_certificate,
      C.before_pin.local_signature,
      fill(C.before_pin.card_and_pin_declare, { account: o.account }),
    ]) {
      check(screen2.includes(s), `screen 2 says "${s}"`);
    }
    check(
      await page.eval<boolean>(`getComputedStyle(document.querySelector('.columns')).display === "grid" && document.querySelectorAll('.columns > section').length === 2`),
      "screen 2: the two lists side by side",
    );
  } else {
    check(screen2.includes(fill(C.before_pin.withdrawing, { platform: PLATFORM })) && screen2.includes(C.before_pin.public_withdraw), "screen 2 (withdraw) says what it withdraws and publishes");
  }
  check(!(await page.eval<boolean>(`!!document.querySelector('#pin')`)), "no PIN field before the card is read");
  const signsBefore = componentCount("MakeSignature");
  const r = await readCard();
  check(r.pin, `the card was read; the PIN field appeared ${r.message}`);
  check((await page.text("[data-card-read]")).includes(fill(C.before_pin.card_read, { name: "測試用戶" })), "the name is shown");
  check(componentCount("MakeSignature") === signsBefore, "nothing was signed before the PIN");
  if (o.screenshots) await screenshot(`${o.screenshots}-2-pin`);
  if (o.wrongPinFirst) {
    await confirmPin("000000");
    const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the wrong PIN's message");
    check(m === C.before_pin.pin_incorrect, `wrong PIN: "${m}"`);
    check(await pinGone(), "wrong PIN: the field is empty");
    await sleep(1500);
    check(componentCount("MakeSignature") === signsBefore + 1, "wrong PIN: sent once, not again by itself");
    check(await page.eval<boolean>(`document.querySelector('button.primary:not([hidden])')?.disabled === true`), "wrong PIN: the button waits for a new PIN");
  }
  await confirmPin(PIN);
  const st = await waitStatus();
  check(await pinGone(), "after the first signature, the PIN is nowhere on the page");
  check(!st.main.includes("測試用戶") && !(await page.eval<boolean>(`document.documentElement.outerHTML.includes("測試用戶")`)), "the name is gone after screen 2");
  check(st.status === o.statusText, `screen 3: "${st.status}"`);
  check(st.buttons.includes(C.status.cancel) && st.buttons.includes(o.button), `screen 3 buttons ${JSON.stringify(st.buttons)}`);
  check(st.main.includes(recordLine(o.recordAccount, o.account === null)), "screen 3: the line the roster will record");
  if (o.screenshots) await screenshot(`${o.screenshots}-3-status`);
  const lastSign = component.requests.filter((x) => x.func === "MakeSignature").at(-1)!;
  check(lastSign.tbs === "iamreal-test:threads:0_________" && lastSign.pin === PIN, "the first signature: the test scope string, with the PIN");

  let dropped = false;
  if (o.dropFirstSubmission) {
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
    check((await page.text("[data-progress]")).startsWith(C.progress.signing), "screen 4: the card signs");
    const threads = Number(await page.waitFor<string>(`document.querySelector('[data-progress] progress')?.dataset.threads`, "the progress bar", 30_000).catch(() => "0"));
    check(threads > 1, `screen 4: the progress bar is timed for a multithreaded proof (${threads} threads)`);
    if (o.screenshots) await screenshot(`${o.screenshots}-4-progress`);
    const d = await waitDoneOrMessage();
    finishDone(o, d);
  }
  if (o.screenshots) await screenshot(`${o.screenshots}-5-done`);
  const sign2 = component.requests.filter((x) => x.func === "MakeSignature").at(-1)!;
  check(/^D[0-9A-Z]{30}$/.test(sign2.tbs ?? "") && sign2.pin === PIN, "the second signature: a declaration code, with the PIN");
  check(await pinGone(), "after the second signature, the PIN is nowhere on the page");
  const timings = await page.eval<[string, number][]>(`performance.getEntriesByType("measure").map((e) => [e.name, Math.round(e.duration)])`);
  results[o.label] = { timings };
  console.log(`   times (ms): ${timings.map(([n, ms]) => `${n.replace("iamreal:", "")} ${ms}`).join(", ")}`);
}

function finishDone(o: { title: string; recordAccount: string; account: string | null; label: string }, d: { done: boolean; main: string; message: string }): void {
  if (!check(d.done, `${o.label}: done ${d.message}`)) return;
  const lines = d.main.split("\n").filter(Boolean);
  check(lines[0] === o.title, `screen 5: "${lines[0]}"`);
  const m = /名冊第 (\d+) 筆：(.*)$/.exec(d.main.split("\n").find((l) => l.startsWith("名冊第")) ?? "");
  check(!!m && m[2] === recordLine(o.recordAccount, o.account === null), `screen 5: the record line "${m?.[0]}"`);
  const sid = /編號開頭是 ([0-9A-Z]{6})。/.exec(d.main)?.[1] ?? "";
  check(d.main.includes(fill(C.done.short_id, { platform: PLATFORM, short_id: sid })) && d.main.includes(C.done.unplug), "screen 5: the short ID and the rest");
  shown.push({ kind: o.title, seq: Number(m?.[1]), shortId: sid });
}

/** A case that stops on screen 2, before the PIN is asked. */
async function stopsBeforePin(label: string, card: FakeCardSpec | null, expected: string, o: { setup?: () => Promise<() => Promise<void>>; account?: string; silent?: boolean } = {}): Promise<void> {
  console.log(`\n== before the PIN: ${label}`);
  component.card = card;
  component.silent = o.silent ?? false;
  await toBeforePin(o.account ?? "alice");
  const undo = o.setup ? await o.setup() : null;
  const signs = componentCount("MakeSignature");
  const cardStates = browser.requests.filter((r) => r.url.endsWith("/api/v1/card-state")).length;
  const r = await readCard();
  check(!r.pin && r.message === expected, `${label}: "${r.message}"`);
  await sleep(300);
  check(!(await page.eval<boolean>(`!!document.querySelector('#pin')`)), `${label}: no PIN field`);
  check(componentCount("MakeSignature") === signs, `${label}: nothing signed`);
  check(browser.requests.filter((x) => x.url.endsWith("/api/v1/card-state")).length === cardStates, `${label}: no card-state request`);
  check(await page.eval<boolean>(`[...document.querySelectorAll('button')].some((b) => b.textContent === ${JSON.stringify(C.before_pin.read_card)} && !b.disabled)`), `${label}: the read button is there again`);
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

const tryStep = async (label: string, f: () => Promise<void>) => {
  try {
    await f();
  } catch (e) {
    check(false, `${label}: ${e instanceof Error ? e.stack : String(e)}`);
  }
};

const daysAgo0 = fill(C.status.current_same, { account: "alice", days_ago: 0 });

await tryStep("declare", () =>
  cardProof({ label: "declare @alice", account: "alice", statusText: C.status.not_declared, button: fill(C.status.button_first, { account: "alice" }), title: C.done.first, recordAccount: "alice", wrongPinFirst: true, screenshots: "declare" }),
);

// The page's headers and isolation, read from the first load.
{
  const doc = browser.responses.find((r) => r.url === PAGE);
  check(doc?.headers["content-security-policy"] === CONTENT_SECURITY_POLICY, `the page's Content-Security-Policy: ${doc?.headers["content-security-policy"]}`);
  check(doc?.headers["document-isolation-policy"] === ISOLATION_HEADERS["Document-Isolation-Policy"], `the page's Document-Isolation-Policy: ${doc?.headers["document-isolation-policy"]}`);
  check(await page.eval<boolean>("crossOriginIsolated"), `the page on ${PAGE_ORIGIN} is cross-origin isolated`);
  const api = browser.responses.find((r) => r.url.endsWith("/api/v1/card-state"));
  check(/^[0-9a-f]{16}$/.test(api?.headers["x-request-id"] ?? ""), `an API response carries X-Request-Id ${api?.headers["x-request-id"]}`);
}

await tryStep("refresh", () =>
  cardProof({ label: "card proof again, the first submission dropped", account: "alice", statusText: daysAgo0, button: C.status.button_refresh, title: C.done.refresh, recordAccount: "alice", dropFirstSubmission: true }),
);
await tryStep("switch", () =>
  cardProof({
    label: "switch to @bob",
    account: "bob",
    statusText: fill(C.status.current_other, { current: "alice", account: "bob", switches_left: 1 }),
    button: fill(C.status.button_switch, { account: "bob" }),
    title: fill(C.done.switch, { account: "bob" }),
    recordAccount: "bob",
  }),
);
await tryStep("switch 2", () =>
  cardProof({
    label: "switch to @carol",
    account: "carol",
    statusText: fill(C.status.current_other, { current: "bob", account: "carol", switches_left: 0 }),
    button: fill(C.status.button_switch, { account: "carol" }),
    title: fill(C.done.switch, { account: "carol" }),
    recordAccount: "carol",
  }),
);

// Switches used up: the third switch is not offered.
await tryStep("switch limit", async () => {
  console.log("\n== switch to @dave: used up");
  component.card = main.spec();
  await toBeforePin("dave");
  check((await readCard()).pin, "read");
  const signs = componentCount("MakeSignature");
  await confirmPin(PIN);
  const st = await waitStatus();
  const next = /下一次可以更換是 (\d{4}-\d{2}-\d{2})。/.exec(st.status)?.[1] ?? "";
  check(st.status === fill(C.status.switch_limit, { current: "carol", next_switch_date: next }), `screen 3: "${st.status}"`);
  check(JSON.stringify(st.buttons) === JSON.stringify([C.status.cancel]), `only cancel: ${JSON.stringify(st.buttons)}`);
  await sleep(500);
  check(componentCount("MakeSignature") === signs + 1, "the card signed once");
  await page.clickButton(C.status.cancel);
  await page.waitFor(step("enter"), "screen 1 after cancel");
  check(componentCount("MakeSignature") === signs + 1, "cancel: no second signature");
});

// A submission the server refuses: its code and request ID on the screen.
await tryStep("refused", async () => {
  console.log("\n== a submission the server refuses (the record changed on its way)");
  component.card = main.spec();
  await toBeforePin("carol");
  check((await readCard()).pin, "read");
  await confirmPin(PIN);
  const st = await waitStatus();
  check(st.status === fill(C.status.current_same, { account: "carol", days_ago: 0 }), `screen 3: "${st.status}"`);
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/v1/records", requestStage: "Request" }] });
  const off = browser.on((m, p, s) => {
    if (m !== "Fetch.requestPaused" || s !== page.sessionId) return;
    // Another account: the proof no longer verifies.
    const body = JSON.parse(p.request.postData);
    body.username = "carl";
    void page.send("Fetch.continueRequest", { requestId: p.requestId, postData: Buffer.from(JSON.stringify(body)).toString("base64") });
  });
  await page.clickButton(C.status.button_refresh);
  const d = await waitDoneOrMessage();
  off();
  await page.send("Fetch.disable");
  const id = await page.text("[data-request-id]");
  const expected = fill(C.stops.rejected, { code: "proof" });
  check(!d.done && d.message.startsWith(expected), `refused: "${d.message}"`);
  const res = browser.responses.filter((r) => r.url.endsWith("/api/v1/records") && r.status === 400).at(-1);
  check(/^[0-9a-f]{16}$/.test(id) && res?.headers["x-request-id"] === id, `the request ID on the screen (${id}) is the response's (${res?.headers["x-request-id"]})`);
  check(serverLog.includes(`"id":"${id}"`) && serverLog.includes(`"error":"proof"`), "the server's log line has the same ID");
});

await tryStep("withdraw", () =>
  cardProof({
    label: "withdraw",
    account: null,
    statusText: fill(C.status.withdraw_current, { account: "carol" }),
    button: fill(C.status.button_withdraw, { account: "carol" }),
    title: C.done.withdraw,
    recordAccount: "carol",
  }),
);

await tryStep("nothing to withdraw", async () => {
  console.log("\n== withdraw again: nothing to withdraw");
  component.card = main.spec();
  await toBeforePin(null);
  check((await readCard()).pin, "read");
  await confirmPin(PIN);
  const st = await waitStatus();
  check(st.status === C.status.withdraw_none, `screen 3: "${st.status}"`);
  check(JSON.stringify(st.buttons) === JSON.stringify([C.status.cancel]), `only cancel: ${JSON.stringify(st.buttons)}`);
  await page.clickButton(C.status.cancel);
});

// After the PIN: a locked card, a challenge dated another day.
await tryStep("locked", async () => {
  console.log("\n== a wrong PIN that locks the card");
  component.card = lockable.spec();
  await toBeforePin("alice");
  check((await readCard()).pin, "read");
  await confirmPin("000000");
  const m = await page.waitFor<string>(`document.querySelector('[data-message]')?.innerText`, "the message");
  check(m === C.stops.card_locked, `locked: "${m}"`);
  check(await pinGone(), "locked: the PIN is nowhere");
});
await tryStep("challenge date", async () => {
  console.log("\n== a challenge dated another day");
  component.card = fresh.spec();
  await toBeforePin("alice");
  check((await readCard()).pin, "read");
  await confirmPin(PIN);
  await waitStatus();
  const signs = componentCount("MakeSignature");
  const undo = await intercept("*/api/v1/challenges", (p) =>
    page.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(JSON.stringify({ challenge: "2026-01-01.000G40R40M30E209185GR38E1W" })).toString("base64"),
    }),
  );
  await page.clickButton(fill(C.status.button_first, { account: "alice" }));
  const d = await waitDoneOrMessage();
  await undo();
  check(!d.done && d.message === C.stops.date_mismatch, `challenge of another day: "${d.message}"`);
  await sleep(500);
  check(componentCount("MakeSignature") === signs, "no second signature");
});

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
for (const [label, card, expected, o] of tests) await tryStep(label, () => stopsBeforePin(label, card, expected, o));

// 5. Snapshot and re-verification -----------------------------------------------

console.log("\n== snapshot and iamreal-verify");
await tryStep("snapshot", async () => {
  execFileSync(serverBin, ["snapshot", "-data", data, "-bb", BB, "-crs", crsDir, "-roster", "test", "-test-issuers", issuersDir], { stdio: "pipe" });
  const v = JSON.parse(
    execFileSync(verifyBin, ["-bb", BB, "-crs", crsDir, "-roster", "test", "-json", "-test-issuers", issuersDir, "-crl-archive", join(data, "crl"), join(data, "roster")], { stdio: ["ignore", "pipe", "pipe"] }).toString(),
  );
  writeFileSync(join(out, "verify.json"), JSON.stringify(v, null, 2));
  const kinds = v.results.map((r: { kind: string }) => r.kind);
  check(v.valid === true && JSON.stringify(kinds) === JSON.stringify(["first", "refresh", "switch", "switch", "withdraw"]), `iamreal-verify: valid, ${JSON.stringify(kinds)}`);
  check(JSON.stringify(shown.map((s) => s.seq)) === JSON.stringify([1, 2, 3, 4, 5]), `the screens showed records ${JSON.stringify(shown.map((s) => s.seq))}`);
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
await tryStep("rollback", () =>
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
  check(popups.size === component.requests.length + 2, `one component window per request (${popups.size} windows, ${component.requests.length} requests)`);
  check(component.requests.every((r) => r.func !== "MakeSignature" || (r.pin ?? "") !== ""), "no signing request without a PIN");
  check(component.requests.every((r) => ["GetUserCert", "MakeSignature"].includes(r.func)), "only GetUserCert and MakeSignature were asked of the component");
}

writeFileSync(join(out, "ui-report.json"), JSON.stringify({ results, shown, component: component.requests.map((r) => ({ func: r.func, tbs: r.tbs })) }, null, 2));
await browser.close();
await component.stop();
server.kill();
moica.close();
writeFileSync(join(out, "server.log"), serverLog);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
