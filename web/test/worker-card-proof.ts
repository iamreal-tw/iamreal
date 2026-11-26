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
// 4. The page is opened through the small server in front of the Worker
//    that stands in the place of the data domain (test/e2e/worker-site.ts):
//    it answers /crl/… from the Worker's bucket, read-only, and hands every
//    other request to the Worker as it is.
// 5. Clicks through the seven steps like a cardholder (real mouse events,
//    cdp.ts), declaring @alice on Threads.
// 6. Opens the home page and /p/<short ID>: the page of the card lists the
//    account just declared, by the sentences of design/copy/proof-page.md.
//    Takes screenshots of both at a desktop's and a phone's width.
// 7. Opens the FAQ (/faq, design/copy/faq.md): every question folded; a
//    click, or Enter, opens one and closes it again; a link to a category
//    opens none; a link to a question, on the page or from another, opens
//    that one, on the screen; without the script (/copy.js, blocked) a
//    question is still opened by a click. Screenshots of the page folded
//    and with one question opened by its address.
// 8. Opens the card's page of hanging its proof (/hang/<short ID>,
//    design/copy/hang.md, 示範): the demonstration plays in place of the five
//    pictures, to its last frame; its one button stops it there and plays it
//    again; the step being shown is marked; beside the steps on a desktop,
//    above them on a phone, where it starts once it is on the screen; with
//    reduced motion it plays all the same; without its player (/demo.js,
//    blocked) the page is the five pictures. Screenshots of the three. The
//    page without a proof (/hang) plays it too, with the examples; a device
//    that says it is Android shows Android's way back from the links on both.
//
// The screens' own sentences, every way a card proof stops and every kind
// of record are test/e2e/ui.ts's, which runs against the Worker too (#69);
// what only this file looks at is the visitors' pages after a card proof.
// The checks of a pull request run it with the other two browser tests
// (.github/workflows/checks-browser.yml).
//
// The browser resolves no host name but localhost and 127.0.0.1
// (--host-resolver-rules): the profile a page of a card embeds gets no
// further than its name.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { COPY } from "../src/ui/copy.ts";
import { Browser, type Page, sleep } from "./e2e/cdp.ts";
import { FakeComponent } from "./e2e/fake-component.ts";
import { startWorkerSite } from "./e2e/worker-site.ts";
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
const site = await startWorkerSite({ proofFiles: dist, issuers });
const { worker } = site;
const component = new FakeComponent();
let browser: Browser | undefined;

try {
  // 3. The mirror ----------------------------------------------------------------
  worker.moica.serve("G2", crls.G2);
  worker.moica.serve("G3", crls.G3);
  const round = await worker.runSchedule();
  const index = new TextDecoder().decode((await worker.files("crl/index.jsonl"))[0]?.bytes ?? new Uint8Array());
  check(round.outcome === "ok" && index.split("\n").filter(Boolean).length === 2, `the Worker's schedule mirrored the two CRLs (${round.outcome})`);

  // 4. In the place of the data domain: the server in front of the Worker.
  const ORIGIN = site.origin;
  await component.start(COMPONENT_PORT);
  component.card = { certificates: [encryption, signing], signingCertificate: signing, signingKey: cardKey.privateKey, pin: PIN, tries: 3 };

  // 5. The seven steps --------------------------------------------------------------
  browser = await Browser.launch({ dir: out, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"] });
  const page = await browser.newPage();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const step = (n: string): string => `document.querySelector('[data-step="${n}"]')`;
  const where = (): Promise<string> => page.text("[data-where]");
  const stepLine = (n: number): string => C.common.step.replace("{step}", String(n)).replace("{steps}", "7");
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
  await waitStep("hang", "step 6", 180_000);
  check((await where()).includes(stepLine(6)), "step 6 (掛上去): the Worker verified the proof and wrote the record");
  const hang = await page.text();
  const short = /iamreal\.tw\/p\/([0-9A-Z]{10})/.exec(hang)?.[1] ?? "";
  check(short !== "", `step 6 gives the card's link: iamreal.tw/p/${short}`);
  await page.clickButton(C.common.next);
  await waitStep("done", "step 7");
  check((await where()).includes(stepLine(7)) && (await page.text()).includes(C.finish.first), "step 7 (完成和分享): 恭喜你完成島民證明");
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
  /**
   * The lines of the first code block of a section of proof-page.md, the example account kept (this card proof
   * declared @alice too), the example ordinal (第 128 張) replaced: this card is the first of a proof log that was empty.
   */
  const section = (heading: string): string[] => {
    const text = proofCopy.slice(proofCopy.indexOf(`\n## ${heading}`));
    return /```\n([\s\S]*?)\n```/.exec(text)![1]!
      .split("\n")
      .map((l) => l.trim().replace("第 128 張", "第 1 張"))
      .filter((l) => l !== "" && !/^（[^）]*）$/.test(l));
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
  // Section 4: its heading and the four rows of labels and values, for the first card proof of a card that never switched.
  const facts = section("4. ")
    .slice(0, 5)
    .map((l) => l.replace("2026-03-02", today).replace("4 次", "1 次").replace("更換過 1 次", "更換過 0 次"));
  for (const line of [`上次過卡：今天（${today}）`, ...section("2. ").slice(1), `iamreal.tw/p/${short}`, ...facts, `${today}　新宣告：@alice`]) {
    check(card.includes(squash(line)), `the page of the card says "${line}"`);
  }
  // The mark of a test log (design/copy/test-site.md), with the date of the Worker's setting in place of the example's.
  const mark = /```\n(.*)\n```/.exec(readFileSync(join(repo, "design", "copy", "test-site.md"), "utf8"))![1]!;
  const marked = new RegExp(squash(mark).replace(/\d{4}-\d{2}-\d{2}/, "\\d{4}-\\d{2}-\\d{2}"));
  check(/\d{4}-\d{2}-\d{2}$/.test(mark) && marked.test(card), `the page of the card has the mark of a test log: "${mark}", with its own date`);

  await visitor.goto(`${ORIGIN}/`);
  const home = squash(await visitor.text("body"));
  check(home.includes(squash("現在有 1 張島民證明")) && home.includes(squash("其中 1 張在過去三個月內過卡")), "the home page counts the card");
  await shot(visitor, "home-desktop.png", 1100);
  await shot(visitor, "home-phone.png", 390);
  check(await visitor.eval<boolean>("document.cookie === ''"), "the pages set no cookie");

  // 7. The FAQ: every question folded; a link to one opens it (design/copy/faq.md, at the top) --------------
  /** The ids of the questions that are open. */
  const openIds = (p: Page): Promise<string[]> => p.eval<string[]>(`[...document.querySelectorAll("details.question[open]")].map((d) => d.id)`);
  /** Whether the top of the element with this id is on the screen. */
  const onScreen = (p: Page, id: string): Promise<boolean> =>
    p.eval<boolean>(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()`);
  /** Back to a desktop's width, after a screenshot at a phone's. */
  const desktop = (p: Page): Promise<unknown> => p.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await desktop(visitor);
  await visitor.goto(`${ORIGIN}/faq`);
  const questions = await visitor.eval<number>(`document.querySelectorAll("details.question").length`);
  check(questions > 20 && (await openIds(visitor)).length === 0, `/faq: all ${questions} questions folded`);
  await shot(visitor, "faq-desktop.png", 1100);
  await shot(visitor, "faq-phone.png", 390);
  await desktop(visitor);
  // A click on a question opens it, another closes it; from the keyboard too.
  await visitor.click("#personal-data > summary");
  check((await openIds(visitor)).join() === "personal-data", "/faq: a click on a question opens it");
  await visitor.click("#personal-data > summary");
  check((await openIds(visitor)).length === 0, "/faq: a second click closes it");
  await visitor.eval(`document.querySelector("#government > summary").focus()`);
  for (const type of ["keyDown", "keyUp"]) await visitor.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" && { text: "\r" }) });
  check((await visitor.waitFor<string>(`document.querySelector("#government").open ? "open" : null`, "the question to open from the keyboard", 5_000).catch(() => "")) === "open", "/faq: Enter on a question opens it");
  // A link to a category scrolls to it and opens nothing.
  await visitor.goto(`${ORIGIN}/faq`);
  await visitor.click('.categories a[href="#cat-use"]');
  check((await visitor.waitFor<boolean>(`location.hash === "#cat-use"`, "the link to a category", 5_000)) && (await onScreen(visitor, "cat-use")) && (await openIds(visitor)).length === 0, "/faq#cat-use from the list of the categories: the category on the screen, no question opened");
  // A link on the same page to a question opens it.
  await visitor.eval(`(() => { const a = document.createElement("a"); a.href = "#lost-card"; a.id = "to-lost-card"; a.textContent = "lost-card"; document.querySelector(".categories").append(a); })()`);
  await visitor.click("#to-lost-card");
  await visitor.waitFor<boolean>(`document.querySelector("#lost-card").open`, "the question a link on the page goes to, to open", 5_000).catch(() => false);
  check((await openIds(visitor)).join() === "lost-card" && (await onScreen(visitor, "lost-card")), "/faq: a link on the page to #lost-card opens that question, on the screen");
  // An address that names a question, from another page: that question open, on the screen; no other.
  await visitor.goto(`${ORIGIN}/`);
  await visitor.goto(`${ORIGIN}/faq#threads-knows`);
  check((await openIds(visitor)).join() === "threads-knows" && (await onScreen(visitor, "threads-knows")), "/faq#threads-knows: that question open, on the screen, no other");
  // The whole page from its top, the question left open: a screenshot taken scrolled down leaves rows of it blank.
  await visitor.eval("scrollTo(0, 0)");
  await shot(visitor, "faq-question-desktop.png", 1100);
  await shot(visitor, "faq-question-phone.png", 390);
  // (From another page: Page.navigate from /faq#… to /faq#… is a navigation in the page, with no load event to wait for.)
  await visitor.goto(`${ORIGIN}/`);
  await visitor.goto(`${ORIGIN}/faq#cat-privacy`);
  check((await openIds(visitor)).length === 0 && (await onScreen(visitor, "cat-privacy")), "/faq#cat-privacy: the category on the screen, no question opened");
  // Without the script: the browser scrolls to the question but does not open it; a click does.
  const noScript = await browser.newPage();
  await noScript.send("Page.enable");
  await noScript.send("Runtime.enable");
  await noScript.send("Network.enable");
  await noScript.send("Network.setBlockedURLs", { urls: ["*/copy.js"] });
  await desktop(noScript);
  await noScript.goto(`${ORIGIN}/faq#threads-knows`);
  check((await openIds(noScript)).length === 0 && (await onScreen(noScript, "threads-knows")), "/faq#threads-knows without the script: the question on the screen, folded (the script is what opens it)");
  await noScript.click("#threads-knows > summary");
  check((await openIds(noScript)).join() === "threads-knows", "/faq without the script: a click on a question opens it");

  // 8. Hanging the proof: the demonstration of design/copy/hang.md (示範), played by /demo.js -----------------
  /** What the page shows of the demonstration: whether it plays, the button's word, the steps marked, how far the timeline is (ms). */
  const demoNow = (p: Page): Promise<{ playing: string | undefined; button: string; marked: string[]; at: number; still: number }> =>
    p.eval(`(() => {
      const demo = document.querySelector("[data-demo]");
      const row = demo.querySelector(".demo-row");
      const shown = (e) => e !== null && e.getClientRects().length > 0;
      return {
        playing: demo.dataset.playing,
        button: demo.querySelector("[data-demo-button]").textContent,
        marked: [...document.querySelectorAll("[data-step].now")].map((e) => e.dataset.step),
        at: row.getAnimations().length === 0 ? -1 : Number(row.getAnimations()[0].currentTime),
        still: [...document.querySelectorAll("figure.sketch")].filter(shown).length,
      };
    })()`);
  /** The whole timeline, in ms (design/motion/hang.json). */
  const DEMO_LENGTH = 20_700;
  const demoCopy = /\n## 示範\n([\s\S]*?)\n## /.exec(readFileSync(join(repo, "design", "copy", "hang.md"), "utf8"))![1]!;
  const stopWord = /\| 示範還在動 \| (.*) \|/.exec(demoCopy)![1]!;
  const replayWord = /\| 停了或動完了 \| (.*) \|/.exec(demoCopy)![1]!;
  const hangUrl = `${ORIGIN}/hang/${short}`;
  // A tab in the background is not drawn, so nothing comes onto its screen: each page here is brought to the front first.
  await visitor.send("Page.bringToFront");
  await desktop(visitor);
  await visitor.goto(hangUrl);
  // In place of the five pictures as the page opens; it plays once most of the picture is on the screen.
  check((await visitor.waitFor<string>(`document.querySelector("[data-demo]").dataset.playing`, "the player to show the demonstration", 10_000)) !== undefined, "the player shows the demonstration");
  await visitor.eval(`document.querySelector(".demo-picture").scrollIntoView({ block: "center" })`);
  await visitor.waitFor(`document.querySelector("[data-demo]").dataset.playing === "true"`, "the demonstration to start", 10_000);
  let demo = await demoNow(visitor);
  check(demo.button === stopWord && demo.still === 0, `/hang/<short ID>: the demonstration plays in place of the pictures, its button says ${stopWord}: ${JSON.stringify(demo)}`);
  check(await visitor.eval<boolean>(`(() => { const d = document.querySelector("[data-demo]"); const r = d.querySelector(".demo-picture").getBoundingClientRect(); return !d.hidden && Math.abs(r.width / r.height - 4 / 5) < 0.01; })()`), "the picture is shown, 4:5");
  // On a desktop the four steps are beside it; the first screen writes the card's account and address.
  check(await visitor.eval<boolean>(`document.querySelector(".steps").getBoundingClientRect().left >= document.querySelector(".demo-picture").getBoundingClientRect().right`), "on a desktop the four steps are to the right of the demonstration");
  check(squash(await visitor.eval<string>(`document.querySelector('[data-box="s0"]').textContent`)).includes(squash("@alice 的個人檔案")) && (await visitor.eval<string>(`document.querySelector('[data-box="s0"] .address').textContent`)).endsWith(`/p/${short}`), "the first screen writes the card's account and its address");
  // The step being shown is marked: at 6 s that is step 2 (the timeline's `step` events), and no other.
  await visitor.eval(`(() => { for (const a of document.getAnimations()) a.currentTime = 6000; })()`);
  await visitor.waitFor(`document.querySelector('[data-step="2"]').classList.contains("now")`, "step 2 to be marked", 5_000);
  demo = await demoNow(visitor);
  check(demo.marked.join() === "2" && demo.playing === "true", `at 6 s step 2 is the one marked, and it still plays: ${JSON.stringify(demo)}`);
  // 停止, halfway: straight to the last frame, and the button plays it again.
  await visitor.clickButton(stopWord);
  demo = await demoNow(visitor);
  check(demo.playing === "false" && demo.button === replayWord && demo.at === DEMO_LENGTH && demo.marked.length === 0, `${stopWord} goes to the last frame, the button then says ${replayWord}: ${JSON.stringify(demo)}`);
  const lastFrame = (p: Page): Promise<boolean> =>
    p.eval<boolean>(`(() => {
      const picture = document.querySelector(".demo-picture").getBoundingClientRect();
      const line = document.querySelector('[data-box="linkrow"]');
      const r = line.getBoundingClientRect();
      const tag = line.querySelector(".found-tag");
      return getComputedStyle(line).opacity === "1" && getComputedStyle(tag).opacity === "1" && r.left >= picture.left && r.right <= picture.right && r.top >= picture.top && r.bottom <= picture.bottom;
    })()`);
  check(await lastFrame(visitor), "the last frame: the line of the link on the profile, with its label, inside the picture");
  await shot(visitor, "hang-proof-demo-desktop.png", 1100);
  await desktop(visitor);
  // 再看一次: from the start.
  await visitor.clickButton(replayWord);
  demo = await demoNow(visitor);
  check(demo.playing === "true" && demo.button === stopWord && demo.at < 2_000, `${replayWord} plays it from the start: ${JSON.stringify(demo)}`);
  // Left alone it plays to the end and stops there by itself (the last second of it, here).
  await visitor.eval(`(() => { for (const a of document.getAnimations()) a.currentTime = ${DEMO_LENGTH - 1000}; })()`);
  await visitor.waitFor(`document.querySelector("[data-demo]").dataset.playing === "false"`, "the demonstration to end", 10_000);
  demo = await demoNow(visitor);
  check(demo.button === replayWord && demo.at === DEMO_LENGTH && (await lastFrame(visitor)), `played to the end it stops on the last frame, the button says ${replayWord}: ${JSON.stringify(demo)}`);
  // From the keyboard: the button takes the focus, shows it, and Enter plays.
  await visitor.eval(`document.querySelector("[data-demo-button]").focus()`);
  for (const type of ["keyDown", "keyUp"]) await visitor.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" && { text: "\r" }) });
  check((await visitor.waitFor<string>(`document.querySelector("[data-demo]").dataset.playing === "true" ? "playing" : null`, "Enter to play it", 5_000).catch(() => "")) === "playing", "Enter on the button plays it");
  check(await visitor.eval<boolean>(`(() => { const b = document.querySelector("[data-demo-button]"); return document.activeElement === b && b.matches(":focus-visible") && getComputedStyle(b).outlineStyle !== "none"; })()`), "used from the keyboard, the button shows its focus ring");
  await visitor.clickButton(stopWord);

  // On a phone the demonstration is above the four steps, and starts only when most of it is on the screen.
  const phone = await browser.newPage();
  await phone.send("Page.enable");
  await phone.send("Runtime.enable");
  await phone.send("Page.bringToFront");
  await phone.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 420, deviceScaleFactor: 1, mobile: true });
  await phone.goto(hangUrl);
  await sleep(800);
  demo = await demoNow(phone);
  check(demo.playing === "false" && demo.at === 0 && demo.button === replayWord, `on a short screen the demonstration waits below the fold, at its first frame: ${JSON.stringify(demo)}`);
  check(await phone.eval<boolean>(`document.querySelector(".steps").getBoundingClientRect().top >= document.querySelector(".demo-picture").getBoundingClientRect().bottom`), "on a phone the four steps are under the demonstration");
  await phone.eval(`document.querySelector(".demo-picture").scrollIntoView({ block: "center" })`);
  await phone.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await phone.waitFor(`document.querySelector("[data-demo]").dataset.playing === "true"`, "the demonstration to start once it is on the screen", 10_000);
  check(true, "scrolled onto the screen, it starts");
  // Another width while it plays: the same moment, aimed again.
  await phone.eval(`(() => { for (const a of document.getAnimations()) a.currentTime = ${DEMO_LENGTH - 500}; })()`);
  await phone.waitFor(`document.querySelector("[data-demo]").dataset.playing === "false"`, "the demonstration to end on the phone", 10_000);
  await phone.send("Emulation.setDeviceMetricsOverride", { width: 340, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  check(await lastFrame(phone), "at another width the last frame is aimed again: the line of the link inside the picture");
  await shot(phone, "hang-proof-demo-phone.png", 390);

  // With the system set to reduce motion it plays all the same (#369, the comment of 2026-11-26): the button is how to stop it.
  const calm = await browser.newPage();
  await calm.send("Page.enable");
  await calm.send("Runtime.enable");
  await calm.send("Page.bringToFront");
  await calm.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await desktop(calm);
  await calm.goto(hangUrl);
  await calm.waitFor(`document.querySelector("[data-demo]").dataset.playing`, "the player to show the demonstration", 10_000);
  await calm.eval(`document.querySelector(".demo-picture").scrollIntoView({ block: "center" })`);
  await calm.waitFor(`document.querySelector("[data-demo]").dataset.playing === "true"`, "the demonstration to start with reduced motion", 10_000);
  check(await calm.eval<boolean>(`matchMedia("(prefers-reduced-motion: reduce)").matches`), "with reduced motion the demonstration plays, with its button");

  // Without the player (blocked): the page as it was, the four pictures and the one of the result, no button of the demonstration.
  const noPlayer = await browser.newPage();
  await noPlayer.send("Page.enable");
  await noPlayer.send("Runtime.enable");
  await noPlayer.send("Page.bringToFront");
  await noPlayer.send("Network.enable");
  await noPlayer.send("Network.setBlockedURLs", { urls: ["*/demo.js"] });
  await desktop(noPlayer);
  await noPlayer.goto(hangUrl);
  await sleep(300);
  check(
    await noPlayer.eval<boolean>(`(() => { const shown = (e) => e.getClientRects().length > 0; return !shown(document.querySelector("[data-demo]")) && !shown(document.querySelector("[data-demo-button]")) && [...document.querySelectorAll("figure.sketch")].filter(shown).length === 5 && document.querySelectorAll("[data-step].now").length === 0; })()`),
    "/hang/<short ID> without the player: the five pictures, no demonstration and no button of it",
  );
  await shot(noPlayer, "hang-proof-still-desktop.png", 1100);
  // The page without a proof, without the player: its four pictures (it has none of the result), as it was.
  await desktop(noPlayer);
  await noPlayer.goto(`${ORIGIN}/hang`);
  await sleep(300);
  check(
    await noPlayer.eval<boolean>(`(() => { const shown = (e) => e.getClientRects().length > 0; return !shown(document.querySelector("[data-demo]")) && !shown(document.querySelector("[data-demo-button]")) && [...document.querySelectorAll("figure.sketch")].filter(shown).length === 4 && !document.querySelector("main").classList.contains("with-demo"); })()`),
    "/hang without the player: the four pictures, no demonstration and no button of it",
  );

  // The page without a proof (/hang, from the home page) plays the same demonstration, with hang.md's examples.
  const entry = await browser.newPage();
  await entry.send("Page.enable");
  await entry.send("Runtime.enable");
  await entry.send("Page.bringToFront");
  await desktop(entry);
  await entry.goto(`${ORIGIN}/hang`);
  await entry.waitFor(`document.querySelector("[data-demo]").dataset.playing`, "the player to show the demonstration on /hang", 10_000);
  await entry.eval(`document.querySelector(".demo-picture").scrollIntoView({ block: "center" })`);
  await entry.waitFor(`document.querySelector("[data-demo]").dataset.playing === "true"`, "the demonstration to start on /hang", 10_000);
  check(squash(await entry.eval<string>(`document.querySelector('[data-box="s0"]').textContent`)).includes(squash("@alice 的個人檔案")) && (await entry.eval<string>(`document.querySelector('[data-box="s0"] .address').textContent`)).endsWith("/p/7K2Q9FM4XD"), "/hang: the demonstration writes the example account and address");
  check((await entry.eval<string>(`document.querySelector("[data-demo]").dataset.variant`)) === "ios" && (await entry.eval<boolean>(`document.querySelector('[data-box="x3"]').getClientRects().length === 0`)), "/hang on a desktop: the iPhone's way back, ✕ not shown");
  await entry.eval(`(() => { for (const a of document.getAnimations()) a.currentTime = ${DEMO_LENGTH - 1000}; })()`);
  await entry.waitFor(`document.querySelector("[data-demo]").dataset.playing === "false"`, "the demonstration to end on /hang", 10_000);
  demo = await demoNow(entry);
  check(demo.button === replayWord && demo.at === DEMO_LENGTH && demo.still === 0 && (await lastFrame(entry)), `/hang: played to the end it stops on the last frame: ${JSON.stringify(demo)}`);
  await shot(entry, "hang-demo-desktop.png", 1100);

  // A browser that says it is Android shows Android's way back, on both pages: ✕ at the top left is marked and pressed, 完成 is grey.
  // The player chooses in the browser; the page is the one every device gets.
  const android = await browser.newPage();
  await android.send("Page.enable");
  await android.send("Runtime.enable");
  await android.send("Page.bringToFront");
  await android.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" });
  await android.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const url of [`${ORIGIN}/hang`, hangUrl]) {
    await android.goto(url);
    await android.waitFor(`document.querySelector("[data-demo]").dataset.playing`, "the player to show the demonstration on Android", 10_000);
    check((await android.eval<string>(`document.querySelector("[data-demo]").dataset.variant`)) === "android", `${url} on Android: Android's version`);
    // 16.7 s: the tap that goes back has just started (the timeline's `back`, 16.65 s).
    await android.eval(`(() => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = 16700; } })()`);
    check(
      await android.eval<boolean>(`(() => {
        const picture = document.querySelector(".demo-picture").getBoundingClientRect();
        const x = document.querySelector('[data-box="x3"]');
        const done = document.querySelector('[data-box="done3"]');
        const r = x.getBoundingClientRect();
        const inside = r.left >= picture.left && r.right <= picture.right && r.top >= picture.top && r.bottom <= picture.bottom;
        return inside && getComputedStyle(x.querySelector(".mark")).opacity === "1" && Number(getComputedStyle(x.querySelector(".ring")).opacity) > 0.5 && getComputedStyle(done.querySelector(".mark")).opacity === "0" && getComputedStyle(done).color !== getComputedStyle(x).color;
      })()`),
      `${url} on Android: going back, the camera is on ✕ at the top left, marked and pressed; 完成 is grey and not marked`,
    );
    await android.eval(`(() => { for (const a of document.getAnimations()) a.finish(); })()`);
    check(await lastFrame(android), `${url} on Android: the last frame is the line of the link`);
  }

  const violations = browser.logs.filter((l) => /Content Security Policy/i.test(l.text) && !/threads\.com/.test(l.text));
  check(violations.length === 0, `no Content-Security-Policy violation on the card proof page or the visitors' pages ${JSON.stringify(violations.map((l) => l.text))}`);
} catch (e) {
  check(false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await browser?.close().catch(() => undefined);
  await component.stop().catch(() => undefined);
  await site.close();
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
