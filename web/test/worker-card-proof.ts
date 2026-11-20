// One card proof from the screen, in headless Chrome, against the Worker
// (worker/) in the local workerd, then the page of the card it made. Nothing
// real: test keys, a fake card behind a fake component, a fake MOICA.
//
//   node --experimental-strip-types test/worker-card-proof.ts   (pnpm test:worker)
//
// 1. Makes throwaway issuer keys (G2, G3), a card and a CRL of each
//    (test/fixtures/).
// 2. Builds the page in mode "test" (vite.config.ts) with those keys, and
//    starts the Worker's test build (worker/test/harness.ts) with the same
//    keys and that build as its card proof page (Static Assets). The Worker
//    verifies the proof with its own verifier and writes the record.
// 3. Has the Worker's hourly schedule mirror the two CRLs from the fake
//    MOICA into the simulated R2 bucket.
// 4. Puts a small server in front of the Worker, in the place of the data
//    domain: the test build of the page takes the CRL archive from its own
//    origin (test/e2e/target.ts, DATA_ORIGIN), and the Worker has no route
//    that sends a file of it. The server answers /crl/… from the bucket,
//    read-only, and hands every other request to the Worker as it is.
// 5. Clicks through the six steps like a cardholder (real mouse events,
//    cdp.ts), declaring @alice on Threads.
// 6. Opens the home page and /p/<short ID>: the page of the card lists the
//    account just declared, by the sentences of design/copy/proof-page.md.
//    Takes screenshots of both at a desktop's and a phone's width.
//
// The screens' own sentences, every way a card proof stops and every kind
// of record are test/e2e/ui.ts's, which still runs against the Go backend.
// This file is not under test/e2e/: the checks of a pull request do not run
// it, and what they run is what worker/test/workflows.test.ts reads there.
//
// The browser resolves no host name but localhost and 127.0.0.1
// (--host-resolver-rules): the profile a page of a card embeds gets no
// further than its name.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { startWorker } from "../../worker/test/harness.ts";
import { COPY } from "../src/ui/copy.ts";
import { Browser, type Page } from "./e2e/cdp.ts";
import { FakeComponent } from "./e2e/fake-component.ts";
import { AUTHORITY_KEY_ID, KEY_USAGE_ENCRYPTION, SUBJECT_KEY_ID, buildTbs, certificate, name } from "./fixtures/certs.ts";
import { makeCrl } from "./fixtures/crls.ts";
import { hex, makeKey } from "./fixtures/der-build.ts";
import { randomSerials, testIssuerKeys } from "./fixtures/world.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const repo = join(web, "..");
const out = join(web, "test-output", "worker");
/** The test build's component address (a port other than the real component's 61161). */
const COMPONENT_PORT = 61171;
const COMPONENT = `http://localhost:${COMPONENT_PORT}`;
const PIN = "834271";
const C = COPY;

let failures = 0;
const check = (ok: boolean, what: string): boolean => {
  console.log(`${ok ? "ok    " : "FAIL  "} ${what}`);
  if (!ok) failures++;
  return ok;
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. Keys, a card, CRLs ----------------------------------------------------------

const issuerKeys = await testIssuerKeys();
const issuers = [
  { name: "G2" as const, modulus: issuerKeys.G2.modulus.toString(16), bits: 2048 as const },
  { name: "G3" as const, modulus: issuerKeys.G3.modulus.toString(16), bits: 4096 as const },
];
const cardKey = await makeKey(2048);
const SERIAL = "1234567890abcdef1234567890abcdef";
const tbs = (serial: string, leading?: Uint8Array[]): Uint8Array => buildTbs({ spki: cardKey.spki, serial: hex(serial), subject: name("測試用戶"), leadingExtensions: leading });
const signing = await certificate(tbs(SERIAL), issuerKeys.G3);
const encryption = await certificate(tbs(`7${SERIAL.slice(1)}`, [AUTHORITY_KEY_ID, SUBJECT_KEY_ID, KEY_USAGE_ENCRYPTION]), issuerKeys.G3);
/** Dated the first second of today in Taiwan. */
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const crlTime = new Date(Date.parse(`${today}T00:00:00+08:00`));
const crls = {
  G2: await makeCrl({ issuer: issuerKeys.G2, serials: randomSerials(2_000, 5n), crlNumber: 200n, thisUpdate: crlTime }),
  G3: await makeCrl({ issuer: issuerKeys.G3, serials: randomSerials(20_000, 3n), crlNumber: 300n, thisUpdate: crlTime }),
};

// 2. The page and the Worker -------------------------------------------------------

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
    __IAMREAL_TEST_IDLE_MS__: JSON.stringify(25_000),
  },
  build: { outDir: dist, emptyOutDir: true },
});

console.log("starting the Worker (test build) with that page");
const worker = await startWorker({ proofFiles: dist, issuers });
const component = new FakeComponent();
let browser: Browser | undefined;
const front = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0]!;
    // 4. In the place of the data domain: the CRL archive, from the bucket, read-only.
    if (path.startsWith("/crl/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();
      const file = (await worker.files(path.slice(1))).find((f) => f.key === path.slice(1));
      if (file === undefined) return void res.writeHead(404).end();
      return void res.writeHead(200, { "Content-Type": path.endsWith(".jsonl") ? "application/jsonl" : "application/pkix-crl", "Cache-Control": "no-store" }).end(Buffer.from(file.bytes));
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const answer = await worker.fetch(req.url ?? "/", { method: req.method, headers, redirect: "manual", ...(chunks.length > 0 && { body: Buffer.concat(chunks) }) });
    const out: Record<string, string> = {};
    answer.headers.forEach((value, key) => {
      // The body is sent as this server has it, not as the local workerd encoded it.
      if (!["content-encoding", "mf-content-encoding", "transfer-encoding", "content-length", "connection"].includes(key)) out[key] = value;
    });
    res.writeHead(answer.status, out).end(Buffer.from(await answer.arrayBuffer()));
  } catch (e) {
    res.writeHead(502).end(String(e));
  }
});

try {
  // 3. The mirror ----------------------------------------------------------------
  worker.moica.serve("G2", crls.G2);
  worker.moica.serve("G3", crls.G3);
  const round = await worker.runSchedule();
  const index = new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]?.bytes ?? new Uint8Array());
  check(round.outcome === "ok" && index.split("\n").filter(Boolean).length === 2, `the Worker's schedule mirrored the two CRLs (${round.outcome})`);

  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const ORIGIN = `http://localhost:${(front.address() as AddressInfo).port}`;
  await component.start(COMPONENT_PORT);
  component.card = { certificates: [encryption, signing], signingCertificate: signing, signingKey: cardKey.privateKey, pin: PIN, tries: 3 };

  // 5. The six steps ----------------------------------------------------------------
  browser = await Browser.launch({ dir: out, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] });
  const page = await browser.newPage();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const step = (n: string): string => `document.querySelector('[data-step="${n}"]')`;
  const where = (): Promise<string> => page.text("[data-where]");
  const stepLine = (n: number): string => C.common.step.replace("{step}", String(n)).replace("{steps}", "6");
  const stopped = `(document.querySelector('[data-list] [data-state="halt"] [data-why]')?.innerText || document.querySelector('[data-message]')?.innerText || "")`;
  /** Waits for a step, or stops with what the page says where it stopped. */
  const waitStep = async (n: string, what: string, ms = 60_000): Promise<void> => {
    const r = await page.waitFor<string>(`${step(n)} ? "there" : (${stopped} || null)`, what, ms);
    if (r !== "there") throw new Error(`${what}: the page stopped with "${r}"`);
  };

  await page.goto(`${ORIGIN}/proof`);
  await waitStep("before", "step 1");
  check((await where()).includes(stepLine(1)), `step 1 (開始之前): "${await where()}"`);
  check(await page.eval<boolean>("crossOriginIsolated"), "the page is cross-origin isolated: the Worker sent the headers it needs");
  await page.clickButton(C.common.next);
  await waitStep("read", "step 2");
  check((await where()).includes(stepLine(2)), "step 2 (讀取卡片)");
  await page.clickButton(C.read.read_card);
  const read = await page.waitFor<string>(
    `(() => {
      const why = ${stopped};
      if (why) return why;
      const next = [...document.querySelectorAll('main button')].find((b) => b.textContent === ${JSON.stringify(C.common.next)});
      return next && !next.disabled ? "done" : null;
    })()`,
    "step 2's list to end",
    60_000,
  );
  check(read === "done", `the card was read, its certificate checked against the CRL the Worker mirrored: ${read}`);
  await page.clickButton(C.common.next);
  await waitStep("pin", "step 3");
  check((await where()).includes(stepLine(3)), "step 3 (輸入 PIN)");
  await page.type("#pin", PIN);
  await page.clickButton(C.pin.confirm_card);
  await waitStep("accounts", "step 4");
  check((await where()).includes(stepLine(4)), "step 4 (你的帳號): the Worker answered for the card's state");
  await page.type("#account-threads", "alice");
  await page.clickButton(C.common.next);
  await waitStep("confirm", "step 5");
  check((await where()).includes(stepLine(5)), "step 5 (確認)");
  await page.clickButton(C.confirm.button_declare);
  await waitStep("done", "step 6", 180_000);
  check((await where()).includes(stepLine(6)), "step 6 (完成): the Worker verified the proof and wrote the record");
  const done = await page.text();
  const short = /iamreal\.tw\/p\/([0-9A-Z]{10})/.exec(done)?.[1] ?? "";
  check(short !== "" && done.includes(C.done.first), `step 6 gives the card's link: iamreal.tw/p/${short}`);
  const records = component.requests.filter((r) => r.func === "MakeSignature").length;
  check(records === 2, `the card signed twice (${records})`);

  // 6. The pages -----------------------------------------------------------------
  const screens = join(out, "screens");
  mkdirSync(screens, { recursive: true });
  const shot = async (p: Page, file: string, width: number): Promise<void> => {
    await p.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    const m = await p.send("Page.getLayoutMetrics");
    const height = Math.ceil(m.cssContentSize?.height ?? m.contentSize.height);
    const { data } = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(join(screens, file), Buffer.from(data, "base64"));
  };
  const proofCopy = readFileSync(join(repo, "design", "copy", "proof-page.md"), "utf8");
  /** The lines of the first code block of a section of proof-page.md, the example account kept (this card proof declared @alice too). */
  const section = (heading: string): string[] => {
    const text = proofCopy.slice(proofCopy.indexOf(`\n## ${heading}`));
    return /```\n([\s\S]*?)\n```/.exec(text)![1]!.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^（[^）]*）$/.test(l));
  };
  const squash = (s: string): string => s.replace(/\s/gu, "");

  const visitor = await browser.newPage();
  await visitor.send("Page.enable");
  await visitor.send("Runtime.enable");
  const res = await fetch(`${ORIGIN}/p/${short}`);
  check(res.status === 200 && res.headers.get("cache-control") === "public, max-age=60", `GET /p/${short}: ${res.status}, cached for at most 60 seconds`);
  await visitor.goto(`${ORIGIN}/p/${short}`);
  await shot(visitor, "card-desktop.png", 1100);
  await shot(visitor, "card-phone.png", 390);
  // 全部紀錄 is folded: opened, so that its rows are among the text.
  await visitor.eval(`document.querySelectorAll('details').forEach((d) => (d.open = true))`);
  const card = squash(await visitor.text("body"));
  for (const line of section("1. ")) check(card.includes(squash(line)), `the page of the card says "${line}"`);
  for (const line of [`上次過卡：今天（${today}）`, ...section("2. ").slice(1), `iamreal.tw/p/${short}`, `第一次過卡：${today}`, "過卡 1 次", `${today}　新宣告：@alice`]) {
    check(card.includes(squash(line)), `the page of the card says "${line}"`);
  }
  // The mark of a test roster (design/copy/test-site.md), with the date of the Worker's setting in place of the example's.
  const mark = /```\n(.*)\n```/.exec(readFileSync(join(repo, "design", "copy", "test-site.md"), "utf8"))![1]!;
  const marked = new RegExp(squash(mark).replace(/\d{4}-\d{2}-\d{2}/, "\\d{4}-\\d{2}-\\d{2}"));
  check(/\d{4}-\d{2}-\d{2}$/.test(mark) && marked.test(card), `the page of the card has the mark of a test roster: "${mark}", with its own date`);

  await visitor.goto(`${ORIGIN}/`);
  const home = squash(await visitor.text("body"));
  check(home.includes(squash("現在有 1 張島民證明")) && home.includes(squash("其中 1 張在過去三個月內過卡")), "the home page counts the card");
  await shot(visitor, "home-desktop.png", 1100);
  await shot(visitor, "home-phone.png", 390);
  check(await visitor.eval<boolean>("document.cookie === ''"), "the pages set no cookie");
  const violations = browser.logs.filter((l) => /Content Security Policy/i.test(l.text) && !/threads\.com/.test(l.text));
  check(violations.length === 0, `no Content-Security-Policy violation on the card proof page or the visitors' pages ${JSON.stringify(violations.map((l) => l.text))}`);
} catch (e) {
  check(false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await browser?.close().catch(() => undefined);
  await component.stop().catch(() => undefined);
  front.closeAllConnections();
  await new Promise((r) => front.close(r));
  await worker.close();
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
