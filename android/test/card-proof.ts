// Card proofs from the app's screens, on an Android emulator, with a fake
// card, against the Worker (worker/) in the local workerd. Nothing real:
// test keys, a card that is not there, a fake MOICA.
//
// The Worker, the keys, the card and the CRLs are web/test/app-backend.ts's,
// which both apps' tests share. It runs this file as its command, and when
// this file ends well has Go's iamreal-verify re-verify the proof log these
// card proofs wrote, record by record:
//
//   cd ../web && IAMREAL_BB=<bb 6.0.0> node --experimental-strip-types test/app-backend.ts \
//     first,refresh,switch,withdraw -- node --experimental-strip-types ../android/test/card-proof.ts
//
// Needs: an emulator that is running (android/README.md, "模擬器"), and
// ANDROID_HOME and JAVA_HOME as for the build. This file reads what
// app-backend.ts wrote (web/test-output/app/backend.json) and talks HTTP; it
// uses no code of web/ or worker/. A phone on a cable is never given a
// command: every adb command names the emulator (emulator.ts).
//
// 1. Reads backend.json: where the back end listens, the issuer keys, the
//    card (its certificates, its key, its PIN).
// 2. Puts a small server between the app and that back end. It hands every
//    request on as it is, and notes what each called itself (User-Agent).
//    Three paths are the test's own, for the fake build of the app:
//    /__test/issuers (the issuer keys), /__test/tap (which card is held to
//    the phone, src/fake/) and /__test/pin (a card was handed a PIN).
// 3. Builds the app's build type `fake` (the fake card, the library of the
//    tests, this server as its site), installs it on the emulator, turns
//    the emulator's network off and forwards its port 18169 to the server
//    (`adb reverse`): the app reaches this server and nothing else.
// 4. Goes through the six steps the way a cardholder does (taps and typing,
//    the screen read with uiautomator), four times with the same card: a
//    first declaration and a card proof again today; a switch and a
//    withdrawal the next day (the back end's clock and the emulator's are
//    moved a day on). Every sentence it expects on a screen is read from
//    design/copy/card-proof.json. Twice a card with another certificate is
//    held to the phone at a tap that would hand over the PIN (the second,
//    the third): it gets none. At the end the app's storage holds nothing
//    of a card proof.
// 5. The reminder (issue #297): step 6 offers it, the screen of its interval
//    and time turns it on, the card proofs after it set it again, the
//    settings show it. The emulator's clock is moved to the day and the time
//    of the reminder: the notification's words, "一週後再提醒我" on it, the
//    notification opening step 1 with the reminder's sentence, and the
//    reminder turned off in the settings, after which the app's storage
//    holds nothing of it. Every sentence is read from design/copy/app.json
//    and card-proof.json.
//
// What stops a card proof (a card that left, a wrong PIN, the 5 minutes, an
// old version) is not here: issue #171.
import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Emulator, type Node, sleep } from "./emulator.ts";

const here = dirname(fileURLToPath(import.meta.url));
const android = join(here, "..");
const repo = join(android, "..");
const out = join(android, "test-output");
const APP = "tw.iamreal.app.dev.fake";
/** The port of the emulator the fake build asks (src/fake/…/Target.kt). */
const DEVICE_PORT = 18169;
const SITE = `127.0.0.1:${DEVICE_PORT}`;
const NAME = "測試用戶";
const C = JSON.parse(readFileSync(join(repo, "design", "copy", "card-proof.json"), "utf8")) as Record<string, Record<string, string>>;
const say = (key: string, values: Record<string, string | number> = {}): string => {
  const [group, item] = key.split(".") as [string, string];
  let s = C[group]?.[item];
  if (s === undefined) throw new Error(`design/copy/card-proof.json has no ${key}`);
  for (const [k, v] of Object.entries(values)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

/** The words only the app has (design/copy/app.json). */
const A = JSON.parse(readFileSync(join(repo, "design", "copy", "app.json"), "utf8")) as Record<string, Record<string, string>>;
const APP_COPY = A as unknown as { splash: { name: string; site: string } };
const app = (key: string, values: Record<string, string | number> = {}): string => {
  const [group, item] = key.split(".") as [string, string];
  let s = A[group]?.[item];
  if (s === undefined) throw new Error(`design/copy/app.json has no ${key}`);
  for (const [k, v] of Object.entries(values)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

/** The day `weeks` weeks after `date` (YYYY-MM-DD). */
const weeksAfter = (date: string, weeks: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** A day as the app writes it (design/copy/app.md, "日子和時刻"): 2027-02-08（星期一）. */
const dayText = (date: string): string => app("when.day", { date, weekday: app(`when.${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}`) });
/** The reminder's time unless another is chosen. */
const NINE = `${app("when.evening")} 9:00`;
/** What step 6 says of a reminder that is offered, or on, for the day 12 weeks after `date` (design/copy/card-proof.md, "6. 完成", app, "提醒"). */
const reminderSays = (date: string): string[] => [
  say("app_done.reminder_title"),
  say("app_done.reminder_why") + say("app_done.reminder_next_about", { day: dayText(weeksAfter(date, 12)), time: NINE, interval: app("interval.weeks_12") }),
  say("app_done.reminder_local"),
];

let failures = 0;
const check = (ok: boolean, what: string): boolean => {
  console.log(`${ok ? "ok    " : "FAIL  "} ${what}`);
  if (!ok) failures++;
  return ok;
};

const sdk = process.env.ANDROID_HOME;
if (sdk === undefined) throw new Error("ANDROID_HOME is not set");
const emulator = Emulator.find(join(sdk, "platform-tools", "adb"));
console.log(`the emulator is ${emulator.serial}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1. The back end and the card, as app-backend.ts wrote them -----------------------

interface Backend {
  origin: string;
  now: string;
  issuers: { issuer: string; modulus: string }[];
  certificates: string[];
  signing: number;
  private_key: string;
  pin: string;
}
const backendFile = join(repo, "web", "test-output", "app", "backend.json");
let backend: Backend;
try {
  backend = JSON.parse(readFileSync(backendFile, "utf8")) as Backend;
} catch {
  throw new Error(`${backendFile} is not there: this file is run by web/test/app-backend.ts (see the top of this file)`);
}
const PIN = backend.pin;
/** The card's key as Java reads it (PKCS #8). */
const key = createPrivateKey({ key: Buffer.from(backend.private_key, "base64"), format: "der", type: "pkcs1" }).export({ format: "der", type: "pkcs8" }).toString("base64");
/** The card as the fake build takes it (src/fake/…/FakeCard.kt). `pauseMs`: how long it takes over each thing, so that the panel can be read. */
const card = async (pauseMs = 0): Promise<string> => JSON.stringify({ certificates: backend.certificates, key, pin: PIN, pause_ms: pauseMs });
/**
 * A card that is not the one read: where the app looks for the signing certificate, it has another one
 * (the same two certificates, in the other order). Same key, same PIN: only the comparison keeps the PIN from it.
 */
const otherCard = JSON.stringify({ certificates: [...backend.certificates].reverse(), key, pin: PIN, pause_ms: 0 });

/** The date in Taiwan `days` after the day the back end's clock starts on. */
const dayAfter = (days: number): string => new Date(Date.parse(backend.now) + 8 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);
const today = dayAfter(0);
const tomorrow = dayAfter(1);
/** From now on the back end's clock and the emulator's show `time`. */
async function setClocks(time: Date): Promise<void> {
  const res = await fetch(`${backend.origin}/__app-test/clock`, { method: "PUT", body: time.toISOString() });
  if (res.status !== 204) throw new Error(`setting the back end's clock: HTTP ${res.status}`);
  emulator.shell(`date @${Math.floor(time.getTime() / 1000)}`);
}

// 2. The server between the app and the back end -----------------------------------

/** The taps the app is waiting for, and the cards the test holds out. */
const waitingTaps: ServerResponse[] = [];
let taps = 0;
/** How many times a card was handed a PIN (src/fake/…/FakeCard.kt tells). */
let pinsHanded = 0;
/** What the app's requests called themselves (User-Agent), each once. */
const userAgents = new Set<string>();
/** Holds a card to the phone: answers the tap the app is waiting with. */
const hold = async (held: string): Promise<void> => {
  for (let i = 0; i < 100 && waitingTaps.length === 0; i++) await sleep(100);
  const res = waitingTaps.shift();
  if (res === undefined) throw new Error("the app is not waiting for a card");
  taps++;
  res.writeHead(200, { "Content-Type": "application/json" }).end(held);
};

const front = createServer(async (req, res) => {
  try {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/__test/issuers") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(backend.issuers));
    if (path === "/__test/pin") {
      pinsHanded++;
      return void res.writeHead(200).end();
    }
    if (path === "/__test/tap") {
      waitingTaps.push(res);
      // The app gave the tap up (the panel's 取消).
      res.on("close", () => {
        const i = waitingTaps.indexOf(res);
        if (i >= 0) waitingTaps.splice(i, 1);
      });
      return;
    }
    // What the app itself asks: the API and the CRL archive.
    if (path.startsWith("/api/") || path.startsWith("/crl/")) userAgents.add(req.headers["user-agent"] ?? "");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const answer = await fetch(backend.origin + (req.url ?? "/"), { method: req.method, headers, redirect: "manual", ...(chunks.length > 0 && { body: Buffer.concat(chunks) }) });
    const sent: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      // The body is sent as this server has it, whatever the back end's server did to send it.
      if (!["content-encoding", "transfer-encoding", "content-length", "connection"].includes(name)) sent[name] = value;
    });
    res.writeHead(answer.status, sent).end(Buffer.from(await answer.arrayBuffer()));
  } catch (e) {
    res.writeHead(502).end(String(e));
  }
});

// The screen -----------------------------------------------------------------------

/** Saves what the screen shows, as test-output/screens/<nn>-<name>.png. */
let shots = 0;
function shot(name: string): void {
  mkdirSync(join(out, "screens"), { recursive: true });
  writeFileSync(join(out, "screens", `${String(++shots).padStart(2, "0")}-${name}.png`), emulator.screenshot());
}

/**
 * Where to save the screens design/screens/ has of the app, when IAMREAL_DESIGN_SCREENS names a directory (design/screens/README.md):
 * each as a phone's screen there is, 390 wide, a pixel a dp, from under the system's bar to the end of the step, at least 844 tall.
 */
const DESIGN_SCREENS = process.env.IAMREAL_DESIGN_SCREENS;
/** The system's bar at the top, in dp, on the emulator's Android 10: left out of those screens. */
const STATUS_BAR = 24;
/** A phone's density, which the test gives the emulator's screen. */
const DENSITY = 420;

/** Makes the emulator's screen one of design/screens/'s (390 dp wide, a pixel a dp) for a moment: `height` tall with the system's bars. */
async function designSize(height: number): Promise<void> {
  emulator.shell(`wm size 390x${height}; wm density 160`);
  await sleep(1_500);
}

/** Puts the emulator's screen back as the test has it. */
async function testSize(): Promise<void> {
  emulator.shell(`wm size reset; wm density ${DENSITY}`);
  await sleep(1_500);
}

/** Saves the screen as `file` of DESIGN_SCREENS, `height` tall from `top` (under the system's bar). Cropped with macOS's sips: the option is for a Mac. */
function designCapture(file: string, height: number, top = STATUS_BAR): void {
  const png = join(DESIGN_SCREENS!, file);
  writeFileSync(png, emulator.screenshot());
  execFileSync("sips", ["--cropOffset", String(top), "0", "-c", String(height), "390", png], { stdio: "ignore" });
}

/** The end of the step on the screen as `file` of DESIGN_SCREENS, if it is set: the last 844 of it, as a phone shows it scrolled to the bottom. */
async function designShotEnd(file: string): Promise<void> {
  if (DESIGN_SCREENS === undefined) return;
  await designSize(4_000);
  const bottom = Math.max(...visible().filter((n) => n.text !== "").map((n) => n.bottom)) + 72;
  designCapture(file, 844, Math.max(STATUS_BAR, bottom - 844));
  await testSize();
}

/** The step on the screen as `file` of DESIGN_SCREENS, if it is set: the whole step, on a screen tall enough for it. */
async function designShot(file: string): Promise<void> {
  if (DESIGN_SCREENS === undefined) return;
  await designSize(4_000);
  // The end of the step: its last text (not the step's own node, as tall as the screen), the bottom half of a button around it and the step's space under it.
  const bottom = Math.max(...visible().filter((n) => n.text !== "").map((n) => n.bottom));
  designCapture(file, Math.max(844, bottom + 72 - STATUS_BAR));
  await testSize();
}

/** What is on the screen now. */
const visible = (): Node[] => emulator.dump();
const textsOf = (nodes: Node[]): string[] => nodes.map((n) => n.text).filter((t) => t !== "");

/** Waits until the screen shows `text`, or stops with what it shows. */
async function waitText(text: string, what: string, ms = 60_000): Promise<Node> {
  const until = Date.now() + ms;
  let last: Node[] = [];
  while (Date.now() < until) {
    last = visible();
    const found = last.find((n) => n.text === text);
    if (found) return found;
    await sleep(300);
  }
  throw new Error(`${what}: the screen never showed "${text}". It shows: ${JSON.stringify(textsOf(last))}`);
}

/** Every text of the step on the screen, from its top to its bottom. The screen is left at the bottom. */
function wholeScreen(): string[] {
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const before = seen.size;
    for (const t of textsOf(visible())) seen.add(t);
    if (i > 0 && seen.size === before) break;
    emulator.scrollDown();
  }
  return [...seen];
}

/** Finds a node, scrolling for it: down to the end of the step, then back up to its top. */
function find(match: (n: Node) => boolean, what: string): Node {
  let last: Node[] = [];
  for (const scroll of [() => emulator.scrollDown(), () => emulator.scrollUp()]) {
    let before = "";
    for (let i = 0; i < 12; i++) {
      last = visible();
      const node = last.find(match);
      // Not one that only peeks over an edge of the screen.
      if (node && node.bottom < emulator.size().height - 80 && node.top > 80) return node;
      const now = JSON.stringify(last.map((n) => [n.text, n.top]));
      if (now === before) break;
      before = now;
      scroll();
    }
  }
  shot("not-found");
  throw new Error(`${what} is not on the screen. It shows: ${JSON.stringify(textsOf(last))}`);
}

/** Presses the button with this label: the middle of its text. */
function press(label: string): void {
  emulator.tap(find((n) => n.text === label, `the button ${label}`));
}

/** Presses a button of the bar at the top of the screen (設定, 返回): it does not scroll, and is always within the top of the screen. */
async function pressBar(label: string): Promise<void> {
  emulator.tap(await waitText(label, `the button ${label} at the top`, 10_000));
}

/** The field a test finds by its name (the app's test tag). */
const field = (id: string): Node => find((n) => n.id === id, `the field ${id}`);

/** Puts the keyboard on the screen away, if it is up: it covers the lower part of the step, where a swipe would scroll. */
function hideKeyboard(): void {
  if (/mInputShown=true/.test(emulator.shell("dumpsys input_method"))) emulator.shell("input keyevent KEYCODE_BACK");
}

/** Checks that each sentence is on the screen, word for word. */
function shows(screen: string[], where: string, sentences: string[]): void {
  for (const s of sentences) check(screen.includes(s), `${where} says "${s.length > 60 ? `${s.slice(0, 60)}…` : s}"`);
}

const step = (n: number): string => say("common.step", { step: n, steps: 6 });
const THREADS = "Threads";
const SPOT = say("app_read.spot_android");
const READ_ITEMS = [say("read.server"), say("app_read.certificate"), say("read.check"), say("read.crl")];
const PROGRESS_ITEMS = [say("progress.server"), say("app_progress.sign"), say("app_progress.compute", { seconds: 10 }), say("progress.submit")];

/** The panel of a tap, while the card is read or signs: what it says in turn (design/copy/card-proof.md, "app：感應的面板"). */
async function tapWithPanel(o: { signs: boolean }): Promise<void> {
  await waitText(say("app_panel.android_wait_title"), "the panel");
  shot("panel-waiting");
  shows(textsOf(visible()), "the panel, waiting for the card,", [say("app_panel.android_wait_title"), say("app_panel.android_wait"), say("common.cancel")]);
  await hold(await card(6_000));
  await waitText(say("app_panel.reading"), "the panel while the card is read", 20_000);
  shows(textsOf(visible()), "the panel, reading,", [say("app_panel.android_busy_title"), say("app_panel.reading")]);
  if (o.signs) {
    await waitText(say("app_panel.signing"), "the panel while the card signs", 20_000);
    shows(textsOf(visible()), "the panel, signing,", [say("app_panel.android_busy_title"), say("app_panel.signing")]);
  }
  const done = o.signs ? say("app_panel.signed") : say("app_panel.read");
  await waitText(done, "the panel when the card is done", 20_000);
  shot("panel-done");
  shows(textsOf(visible()), "the panel, done,", [say("app_panel.android_done_title"), done]);
}

/** A tap without reading the panel: the card is held to the phone as soon as the app waits for it. */
const tap = async (): Promise<void> => hold(await card());

interface Proof {
  /** For the log, and for the names of the screenshots. */
  what: string;
  name: string;
  /** Reads every screen against the copy (the first card proof); the others read what differs. */
  thorough: boolean;
  /** What step 4 shows before anything is typed. */
  accounts: { lead: string[]; rowLines: string[]; notes: string[]; absent: string[] };
  /** At the last tap, another card is held to the phone first. */
  otherCardAtLastTap?: boolean;
  /** What is typed into the Threads row: null leaves it; "" clears it. */
  type: string | null;
  /** The account the row holds before. */
  current: string;
  confirm: { intro: string; account: string; under: string; button: string; shows: string[]; absent: string[] };
  /** `card`: the card's proof, the hanging and what can be done besides are shown (all but a withdrawal of every account). `reminder`: what the reminder's part says. */
  done: { title: string; shows: string[]; absent: string[]; card: boolean; reminder: string[] };
  date: string;
}

/** One card proof, from step 1 to step 6. Returns the short ID the screens showed. */
async function cardProof(p: Proof): Promise<string> {
  console.log(`\n${p.what}`);
  const tapsBefore = taps;

  // Step 1
  await waitText(step(1), "step 1");
  if (p.thorough) {
    shot("step-1");
    await designShot("card-proof-app-1-before-phone.png");
    const s = wholeScreen();
    shows(s, "step 1", [say("common.service_name"), say("before.title"), say("before.prepare_card"), say("before.citizens_only"), say("before.one_proof_single", { platform: THREADS }), say("before.why_physical"), say("before.how_to_get"), say("common.next")]);
    check(!s.includes(say("before.listed_together")) && !s.includes(say("common.back")), "step 1 has no 上一步, and with one platform not the sentence about several");
    check(!s.includes(say("before.duration")), "step 1 does not say the web's sentence of a card reader and 3 minutes");
  }
  press(say("common.next"));

  // Step 2
  await waitText(step(2), "step 2");
  if (p.thorough) {
    shot("step-2");
    await designShot("card-proof-app-2-read-android-phone.png");
    const s = wholeScreen();
    shows(s, "step 2", [say("read.title"), say("app_read.how", { spot: SPOT }), ...READ_ITEMS, say("common.back"), say("app_read.tap_card")]);
    check(![say("read.component"), say("read.reader"), say("read.certificate")].some((x) => s.includes(x)), "step 2's list has no item of MOICA's component or a card reader");
    const figure = find((n) => n.id === "tap-place", "step 2's figure of where the card goes");
    check(figure.description === say("app_read.figure_android"), "step 2's figure reads as its one sentence of the copy");
  }
  press(say("app_read.tap_card"));
  if (p.thorough) await tapWithPanel({ signs: false });
  else await tap();
  await waitText(say("app_read.lift"), "step 2's list to end", 120_000);
  {
    if (p.thorough) shot("step-2-read");
    const s = wholeScreen();
    check(s.filter((t) => t === say("common.done")).length >= 1 && !s.includes(say("common.halted")) && !s.includes(say("common.working")), "step 2: the card was read, its certificate checked, the CRL the Worker mirrored downloaded and checked");
    shows(s, "step 2, done,", [say("app_read.lift"), say("common.next")]);
    check(!s.includes(say("app_read.tap_card")), "step 2, done: 感應卡片 gave way to 下一步");
  }
  press(say("common.next"));

  // Step 3
  await waitText(step(3), "step 3");
  {
    if (p.thorough) shot("step-3");
    const s = wholeScreen();
    shows(s, "step 3", [NAME, say("pin.name_note")]);
    if (p.thorough) {
      shows(s, "step 3", [say("pin.title"), say("pin.card_read"), say("pin.label"), say("pin.purpose"), say("app_pin.stays"), say("pin.card_and_pin"), say("common.back"), say("pin.confirm_card")]);
      check(!s.includes(say("pin.stays")) && !s.includes(say("pin.pin_characters")), "step 3 says 這支手機, and nothing about characters a PIN may not have");
      // Without a PIN, no panel.
      press(say("pin.confirm_card"));
      await waitText(say("app_pin.need_pin"), "the sentence for an empty PIN", 10_000);
      check(waitingTaps.length === 0 && !textsOf(visible()).includes(say("app_panel.android_wait_title")), "step 3: with no PIN typed, no panel and no tap");
      // A PIN no card takes: not sent, no panel, and gone (the right PIN typed next into an empty field signs below).
      emulator.tap(field("pin"));
      emulator.type("12345");
      press(say("pin.confirm_card"));
      await waitText(say("app_pin.pin_format"), "the sentence for a PIN no card takes", 10_000);
      check(waitingTaps.length === 0 && !textsOf(visible()).includes(say("app_panel.android_wait_title")), "step 3: a PIN of 5 characters brings no panel and no tap");
    }
  }
  emulator.tap(field("pin"));
  emulator.type(PIN);
  if (p.thorough && DESIGN_SCREENS !== undefined) {
    hideKeyboard();
    await designShot("card-proof-app-3-pin-phone.png");
  }
  {
    const s = wholeScreen();
    check(!s.some((t) => t.includes(PIN)), "step 3: the PIN typed is not on the screen");
    check(!s.includes(say("app_pin.need_pin")) && !s.includes(say("app_pin.pin_format")), "step 3: with a PIN typed, no 請輸入 PIN。 and no sentence of the PIN's form");
  }
  press(say("pin.confirm_card"));
  if (p.thorough) await tapWithPanel({ signs: true });
  else await tap();

  // Step 4
  await waitText(step(4), "step 4", 120_000);
  {
    shot(`step-4-${p.name}`);
    const s = wholeScreen();
    shows(s, "step 4", [say("accounts.title_single", { platform: THREADS }), ...p.accounts.lead, ...p.accounts.rowLines, ...p.accounts.notes]);
    for (const a of p.accounts.absent) check(!s.includes(a), `step 4 does not say "${a.slice(0, 40)}…"`);
    if (p.thorough) {
      shows(s, "step 4", [THREADS, "@", say("app_accounts.preview"), say("app_accounts.preview_note", { platform: THREADS }), say("common.next"), say("accounts.not_yours_single", { platform: THREADS }), say("common.cancel")]);
      check(!s.includes(say("accounts.preview")) && !s.includes(say("accounts.title")) && !s.includes(say("accounts.not_yours")), "step 4 is the one-platform screen, with 預覽");
    }
    check(field("account-threads").text === p.current, `step 4: the Threads row holds "${p.current}"`);
  }
  if (p.type !== null) {
    emulator.tap(field("account-threads"));
    emulator.erase(p.current.length);
    if (p.type !== "") emulator.type(p.type);
    hideKeyboard();
    check(field("account-threads").text === p.type, `step 4: the Threads row now holds "${p.type}"`);
    if (p.thorough) await designShot("card-proof-app-4-accounts-phone.png");
  }
  press(say("common.next"));

  // Step 5
  await waitText(say("confirm.title"), "step 5");
  let shortId = "";
  {
    shot(`step-5-${p.name}`);
    if (p.thorough) await designShot("card-proof-app-5-confirm-phone.png");
    const s = wholeScreen();
    shows(s, "step 5", [step(5), p.confirm.intro, THREADS, p.confirm.account, p.confirm.under, say("confirm.date"), p.date, say("confirm.short_id_label"), say("confirm.no_identity"), ...p.confirm.shows, say("common.back"), p.confirm.button, say("common.cancel")]);
    for (const a of p.confirm.absent) check(!s.includes(a), `step 5 does not say "${a.slice(0, 40)}…"`);
    const opening = new RegExp(`^${say("confirm.short_id", { short_id: "([0-9A-Z]{10})" })}$`);
    shortId = s.map((t) => opening.exec(t)?.[1]).find((x) => x !== undefined) ?? "";
    check(shortId !== "", `step 5 shows how the card's short ID begins: ${shortId}`);
  }
  press(p.confirm.button);
  await waitText(say("progress.title"), "step 5, in progress");
  if (p.otherCardAtLastTap) {
    // Not the card that was read: it gets no PIN, and the same tap is offered again.
    const handed = pinsHanded;
    await hold(otherCard);
    await waitText(say("app_stops.other_card_declare"), "step 5: the sentence for another card", 20_000);
    shows(wholeScreen(), "step 5, with another card held to the phone,", [say("common.halted"), say("app_stops.other_card_declare"), say("app_read.tap_again"), say("common.cancel")]);
    check(pinsHanded === handed, "step 5: the other card was not handed the PIN");
    taps--;
    press(say("app_read.tap_again"));
    await waitText(say("app_panel.android_wait_title"), "the panel again", 20_000);
  }
  if (p.thorough) {
    shows(textsOf(visible()), "step 5, in progress,", [step(5), say("app_progress.keep_open"), ...PROGRESS_ITEMS]);
    await tapWithPanel({ signs: true });
    await waitText(say("app_read.lift"), "step 5: the card can be taken away", 20_000);
    shot("step-5-in-progress");
    await designShot("card-proof-app-5-progress-phone.png");
    const s = textsOf(visible());
  } else await tap();

  // Step 6
  await waitText(step(6), "step 6", 300_000);
  check(taps - tapsBefore === 3, `the card was held to the phone three times (${taps - tapsBefore})`);
  {
    shot(`step-6-${p.name}`);
    if (p.thorough) await designShot("card-proof-app-6-done-phone.png");
    const s = wholeScreen();
    const link = `${SITE}/p/${shortId}`;
    shows(s, "step 6", [step(6), p.done.title, say("done.recorded_on", { date: p.date }), say("done.restart"), ...p.done.shows]);
    const hanging = [
      say("done.proof"),
      `${say("confirm.short_id_label")} ${say("confirm.short_id", { short_id: shortId })}`,
      say("done.hang_title_single", { platform: THREADS }),
      say("done.anyone_single"),
      link,
      say("done.copy"),
      say("done.open_profile", { account: p.confirm.account, platform: THREADS }),
      say("done.step_edit"),
      say("done.step_link"),
      say("done.step_add"),
      say("done.step_paste"),
      say("done.hung", { open_proof: say("done.open_proof") }),
      say("done.hung_done"),
      say("done.optional"),
      say("done.share_title"),
      say("done.share_note", { platform: THREADS }),
      say("app_done.share"),
    ];
    if (p.done.card) {
      shows(s, "step 6", [p.confirm.account, ...hanging, ...p.done.reminder]);
      // The reminder in the place of the web's sentences: they are only for a phone that does not let the app notify.
      check(!s.includes(say("done.return_title")) && !s.includes(say("done.return_note")), "step 6: the reminder, not 記得每三個月回來過卡一次");
    } else {
      check(!s.includes(say("app_done.reminder_title")), "step 6 with every account withdrawn has no reminder");
      // Not done.proof: 島民證明 is the service's name in the header too.
      for (const a of hanging.filter((x) => x !== say("done.proof"))) check(!s.includes(a), `step 6 does not say "${a.slice(0, 40)}"`);
    }
    // The server's answer was read (the title is by its kinds) and is what step 5 said: no record of it shown, nothing of the web's QR code or its
    // computer.
    for (const a of [
      say("done.unplug"),
      say("done.mismatch"),
      say("done.recorded"),
      say("done.kinds_unreadable"),
      say("done.recorded_only"),
      say("done.other_cards", { account: p.confirm.account }),
      say("done.by_phone"),
      say("done.by_phone_scan"),
      say("done.on_computer"),
      ...p.done.absent,
    ]) {
      check(!s.includes(a), `step 6 does not say "${a.slice(0, 40)}"`);
    }
  }
  return shortId;
}

/**
 * Before any record: the first tap is given up on the panel and made again; at the second tap a card with another certificate is held to the phone. It gets no PIN; the first card
 * then goes on to step 4, where 取消 goes back to step 1.
 */
async function anotherCardThenCancel(): Promise<void> {
  console.log("\n取消 on the panel, another card at the second tap, then 取消");
  await waitText(step(1), "step 1");
  press(say("common.next"));
  await waitText(step(2), "step 2");
  // 取消 on the panel: back to the screen as it was, nothing said.
  press(say("app_read.tap_card"));
  await waitText(say("app_panel.android_wait_title"), "the panel");
  press(say("common.cancel"));
  for (let i = 0; i < 50 && waitingTaps.length > 0; i++) await sleep(100);
  const back = textsOf(visible());
  check(waitingTaps.length === 0 && !back.includes(say("app_panel.android_wait_title")) && back.includes(say("app_read.tap_card")) && !back.includes(say("common.halted")), "step 2: 取消 on the panel gives the tap up and leaves the step as it was");
  press(say("app_read.tap_card"));
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end", 120_000);
  press(say("common.next"));
  await waitText(step(3), "step 3");
  emulator.tap(field("pin"));
  emulator.type(PIN);
  press(say("pin.confirm_card"));
  await hold(otherCard);
  await waitText(say("app_stops.other_card"), "step 3: the sentence for another card", 20_000);
  check(pinsHanded === 0, "step 3: the other card was not handed the PIN");
  // The PIN is still in the field: the same tap again, with the card that was read.
  press(say("pin.confirm_card"));
  await tap();
  await waitText(step(4), "step 4", 120_000);
  check(pinsHanded === 1, "step 3: the card that was read was handed the PIN, once");
  press(say("common.cancel"));
  await waitText(step(1), "step 1 again, after 取消", 20_000);
  check(true, "step 4: 取消 goes back to step 1");
  taps = 0;
}

/** The sentence of step 6 that is a link to the card's page. */
const HUNG = say("done.hung", { open_proof: say("done.open_proof") });

/** The activity on top of the screen, and the address it was opened with, as the system reports them. */
const onTop = (): string => emulator.shell("dumpsys activity activities").split("\n").filter((l) => /mResumedActivity|^\s*Intent \{ act=android.intent.action.VIEW/.test(l)).join("\n");
const backToApp = async (): Promise<void> => {
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  // Where it was left: step 6.
  find((n) => n.text === step(6) || n.text === HUNG, "the app again, still at step 6");
};

// 5. The reminder ---------------------------------------------------------------------

/** Where the app keeps the reminder (src/main/…/reminder/Phone.kt), and what is in it. */
const REMINDER_FILE = `/data/data/${APP}/shared_prefs/reminder.xml`;
const reminderStored = (): string => emulator.shell(`cat ${REMINDER_FILE} 2>/dev/null; true`);
const storedDay = (): string | undefined => /<string name="day">([0-9-]+)<\/string>/.exec(reminderStored())?.[1];

/**
 * Step 6 of the first card proof, which offered the reminder: its interval and time, turned on, the
 * settings. Back at step 6.
 */
async function reminderTurnedOn(shortId: string): Promise<void> {
  console.log("\nthe reminder, turned on from step 6");
  await designShotEnd("app-reminder-1-done-phone.png");
  check(reminderStored().indexOf("<string") < 0, "before 開啟提醒 the phone stores nothing of the reminder");
  press(say("app_done.reminder_adjust"));
  await waitText(app("reminder.from_today"), "the screen of the interval and the time");
  const next = (weeks: number): string => app("reminder.next", { day: dayText(weeksAfter(today, weeks)), time: NINE });
  {
    shot("reminder-schedule");
    await designShot("app-reminder-2-schedule-phone.png");
    const s = wholeScreen();
    shows(s, "the screen of the interval and the time", [
      app("reminder.title"), app("reminder.from_today"), app("reminder.how_often"), app("reminder.weeks_4"), app("reminder.weeks_12"), app("reminder.suggested"),
      app("reminder.weeks_26"), app("reminder.pick_date"), app("reminder.when"), app("reminder.time"), NINE, app("reminder.change"), next(12), app("reminder.evening"),
      app("reminder.turn_on"), app("reminder.cancel"),
    ]);
    check(!s.includes(app("reminder.save")), "the screen of the interval and the time, with the reminder off, says 開啟提醒, not 儲存");
  }
  // The next reminder follows the interval chosen, from today, on the same day of the week.
  press(app("reminder.weeks_4"));
  await waitText(next(4), "the next reminder, a month on", 10_000);
  press(app("reminder.weeks_12"));
  await waitText(next(12), "the next reminder, three months on", 10_000);
  check(true, "the next reminder follows the interval chosen");
  press(app("reminder.turn_on"));
  await waitText(step(6), "step 6 again, the reminder on", 10_000);
  {
    const s = wholeScreen();
    shows(s, "step 6, the reminder on,", [...reminderSays(today), say("app_done.reminder_change")]);
    check(!s.includes(say("app_done.reminder_turn_on")), "step 6, the reminder on: no 開啟提醒");
  }
  check(storedDay() === weeksAfter(today, 12), `the phone stores the day of the next reminder: ${storedDay()}`);
  const kept = [...reminderStored().matchAll(/name="([a-z]+)"/g)].map((m) => m[1]).sort();
  check(JSON.stringify(kept) === JSON.stringify(["day", "interval", "on", "time"]), `the phone stores the reminder's four things and nothing else: ${JSON.stringify(kept)}`);
  check(!reminderStored().includes(shortId) && !reminderStored().includes("alice"), "the reminder's file has no short ID and no account");

  // The settings.
  await pressBar(app("settings.open"));
  await waitText(app("settings.back"), "the settings");
  {
    shot("settings");
    await designShot("app-settings-phone.png");
    const s = wholeScreen();
    shows(s, "the settings", [
      app("settings.title"), app("settings.reminder"), app("settings.switch"), app("settings.interval"), app("interval.weeks_12"), app("settings.time"), NINE,
      app("settings.next"), dayText(weeksAfter(today, 12)), app("settings.stored"), app("settings.about"), app("settings.version"), app("settings.faq"),
      app("settings.privacy"), app("settings.source"),
    ]);
    check(field("version").text === "dev", `the settings show the build's version: ${field("version").text}`);
  }
  press(app("settings.faq"));
  await sleep(2_000);
  check(onTop().includes(`dat=http://${SITE}/faq`), "the settings: 常見問題 opens the site's /faq in the browser");
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  await pressBar(app("settings.back"));
  await waitText(step(6), "step 6 again, from the settings", 10_000);
  check(true, "the settings: 返回 goes back to step 6");
}

/**
 * The app's notification that is up, as the system describes it, or undefined: its record in the list of
 * notifications posted, up to the next record or the end of that list (not the archive of the ones taken away).
 */
function posted(): string | undefined {
  const lines = emulator.shell("dumpsys notification --noredact").split("\n");
  const at = lines.findIndex((l) => /NotificationRecord\(.*pkg=/.test(l) && l.includes(`pkg=${APP} `));
  if (at < 0) return undefined;
  const end = lines.findIndex((l, i) => i > at && (/NotificationRecord\(/.test(l) || /^ {2}m[A-Z]/.test(l)));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

/** Waits for the reminder's notification; returns what the system says of it. */
async function notification(what: string): Promise<string> {
  for (const until = Date.now() + 60_000; Date.now() < until; await sleep(500)) {
    const ours = posted();
    if (ours !== undefined) return ours;
  }
  throw new Error(`${what}: no notification of the app`);
}

/**
 * Moves the emulator's clock (not the back end's) past `date` at 9 in the evening in Taiwan: past the end of the
 * alarm's window (10 minutes, src/main/…/reminder/Phone.kt), so that the system must deliver it now, whatever
 * other alarms it batches it with.
 */
function eveningOf(date: string): void {
  emulator.shell(`date @${Math.floor(Date.parse(`${date}T21:10:05+08:00`) / 1000)}`);
}

/** The day of the reminder `day`: the notification, 一週後再提醒我 on it, then the notification opening step 1; then turned off. */
async function reminderComes(day: string): Promise<void> {
  console.log("\nthe reminder's notification");
  check(storedDay() === day, `after the last card proof the reminder is 12 weeks on: ${storedDay()}`);
  eveningOf(day);
  {
    const n = await notification("the reminder's day");
    check(n.includes(`android.title=String (${app("notification.title")})`) && n.includes(`android.text=String (${app("notification.body")})`), "the notification says 該回來過卡了 and 拿出自然人憑證，花 3 分鐘更新島民證明。");
    check(n.includes(app("notification.snooze")), "the notification has 一週後再提醒我");
    check(!n.includes("alice") && !n.includes("bob"), "the notification names no account");
  }
  // The system's own panel: design/screens/ keeps its sketch of it (design/screens/README.md).
  emulator.shell("cmd statusbar expand-notifications");
  emulator.tap(await waitText(app("notification.snooze"), "一週後再提醒我 on the notification", 10_000));
  await sleep(2_000);
  emulator.shell("cmd statusbar collapse");
  check(storedDay() === weeksAfter(day, 1), `一週後再提醒我 on the notification: the reminder is 7 days on (${storedDay()})`);
  check(posted() === undefined, "一週後再提醒我 takes the notification away");

  // A week on: the notification opens step 1, which says it is the reminder.
  const later = weeksAfter(day, 1);
  eveningOf(later);
  await notification("a week on");
  emulator.shell("cmd statusbar expand-notifications");
  emulator.tap(await waitText(app("notification.title"), "the notification a week on", 10_000));
  await waitText(app("from_notification.note"), "step 1, opened from the notification", 20_000);
  {
    shot("from-notification");
    await designShot("app-reminder-4-from-notification-phone.png");
    shows(wholeScreen(), "step 1, opened from the notification,", [app("from_notification.note"), app("notification.snooze"), step(1), say("before.title")]);
  }
  press(app("notification.snooze"));
  const snoozed = app("from_notification.snoozed", { day: dayText(weeksAfter(later, 1)), time: NINE });
  await waitText(snoozed, "step 1 after 一週後再提醒我", 10_000);
  check(storedDay() === weeksAfter(later, 1), `一週後再提醒我 on step 1: the reminder is 7 days on (${storedDay()})`);

  // Turned off in the settings: nothing of it is left.
  await pressBar(app("settings.open"));
  await waitText(app("settings.back"), "the settings");
  check(field("settings-next").text === dayText(weeksAfter(later, 1)), `the settings show the next reminder: ${field("settings-next").text}`);
  emulator.tap(field("reminder-switch"));
  await sleep(1_000);
  {
    const s = wholeScreen();
    check(!s.includes(app("settings.interval")) && !s.includes(app("settings.next")), "the settings, the reminder off, show no interval, time or day");
  }
  check(!/<string/.test(reminderStored()), `turned off, the phone stores nothing of the reminder: ${reminderStored()}`);
  await pressBar(app("settings.back"));
}

/** The emulator's setting for the keyboard on the screen, before the test changed it. */
let imeBefore = "";
try {
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const port = (front.address() as AddressInfo).port;

  // 3. The app ---------------------------------------------------------------------
  if (process.env.IAMREAL_SKIP_BUILD === undefined) {
    console.log("building the app (build type fake)");
    execFileSync(join(android, "gradlew"), ["-q", ":app:assembleFake"], { cwd: android, stdio: "inherit" });
  }
  emulator.adb("root");
  emulator.adb("wait-for-device");
  emulator.adb("install", "-r", join(android, "app", "build", "outputs", "apk", "fake", "app-fake.apk"));
  // A phone's density, no keyboard drawn over the screen, the clock left alone.
  imeBefore = emulator.shell("settings get secure show_ime_with_hard_keyboard").trim();
  emulator.shell(`wm density ${DENSITY}; settings put secure show_ime_with_hard_keyboard 0; settings put global auto_time 0`);
  // No network but the port forwarded below: what the app opens in a browser (Threads) is asked of no one.
  emulator.shell("svc wifi disable; svc data disable");
  // The emulator's clock is the back end's.
  await setClocks(new Date(backend.now));
  emulator.shell(`pm clear ${APP}`);
  emulator.adb("reverse", `tcp:${DEVICE_PORT}`, `tcp:${port}`);
  emulator.shell("input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard");
  // The reminder's days are the phone's: the test's are Taiwan's.
  if (emulator.shell("getprop persist.sys.timezone").trim() !== "Asia/Taipei") throw new Error("the emulator's time zone is not Asia/Taipei (android/README.md, \"模擬器\")");
  // The splash on a screen of design/screens/'s size: 844 between the system's bars (Android 10's navigation bar is 48 dp).
  if (DESIGN_SCREENS !== undefined) await designSize(STATUS_BAR + 844 + 48);
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  // The splash first: the name and the site of app.json, for a moment.
  {
    let seen: string[] = [];
    for (const until = Date.now() + 5_000; Date.now() < until && !seen.includes(APP_COPY.splash.site); ) seen = textsOf(visible());
    if (DESIGN_SCREENS !== undefined && seen.includes(APP_COPY.splash.site)) designCapture("app-splash-phone.png", 844);
    check(seen.includes(APP_COPY.splash.site) && seen.includes(APP_COPY.splash.name), `the app opens on the splash: ${APP_COPY.splash.name} │ ${APP_COPY.splash.site} (${JSON.stringify(seen)})`);
    if (DESIGN_SCREENS !== undefined) await testSize();
  }

  // 4. Four card proofs --------------------------------------------------------------
  const HANDLE = { alice: "@alice", bob: "@bob" };
  const more = say("accounts.switches_limited");
  const later = say("confirm.later") + say("confirm.permanent");

  await anotherCardThenCancel();

  // A first declaration: @alice.
  const shortId = await cardProof({
    what: "a first declaration: @alice",
    name: "first",
    thorough: true,
    accounts: {
      lead: [say("accounts.none_yet"), say("accounts.fill_one_single", { platform: THREADS })],
      rowLines: [say("accounts.row_unused")],
      notes: [say("accounts.one_per_platform_single", { platform: THREADS }) + more],
      absent: [say("accounts.how_refresh"), say("accounts.current")],
    },
    type: "alice",
    current: "",
    confirm: { intro: say("confirm.intro_single"), account: HANDLE.alice, under: say("kinds.first"), button: say("confirm.button_declare_single"), shows: [say("confirm.listed_single", { platform: THREADS }), later], absent: [say("confirm.listed_together"), say("confirm.withdraw_stays")] },
    done: { title: say("done.first"), shows: [say("done.new_card")], absent: [say("done.withdrawn_link")], card: true, reminder: [...reminderSays(today), say("app_done.reminder_turn_on"), say("app_done.reminder_adjust")] },
    date: today,
  });

  await reminderTurnedOn(shortId);

  // The buttons of step 6.
  press(say("done.copy"));
  await waitText(say("done.copied"), "the button after the link was copied", 10_000);
  check(true, "step 6: 複製連結 turns into 已複製");
  press(say("done.open_profile", { account: HANDLE.alice, platform: THREADS }));
  await sleep(2_000);
  check(/dat=https:\/\/www\.threads\.com\/@alice/.test(onTop()), "step 6: 打開 @alice 的 Threads 個人檔案 opens https://www.threads.com/@alice outside the app");
  await backToApp();
  press(HUNG);
  await sleep(4_000);
  const browser = onTop();
  check(browser.includes(`dat=http://${SITE}/p/${shortId}`) && !new RegExp(`mResumedActivity.*${APP.replaceAll(".", "\\.")}/`).test(browser), "step 6: 打開你的島民證明 opens the card's page in the browser");
  const page = await fetch(`${backend.origin}/p/${shortId}`);
  const html = await page.text();
  check(page.status === 200 && html.includes("@alice"), `the Worker's page of the card, /p/${shortId}, lists @alice`);
  // The card's ordinal as its page writes it: the proof log's, which the answer to the submission gave the app.
  const ordinal = /<p class="ordinal">第 ([0-9,]+) 張島民證明<\/p>/.exec(html)?.[1] ?? "";
  check(ordinal !== "", `the card's page writes its ordinal "${ordinal}"`);
  await backToApp();
  // The system's share sheet, with the sentence and, on the line under it, the address of the card's page (Android 10
  // shows the text it is given at its top).
  press(say("app_done.share"));
  const text = `${say("done.share_text", { ordinal })}\nhttp://${SITE}/p/${shortId}`;
  const shared = await waitText(text, "the share sheet with the sentence and the card's address", 20_000);
  check(/act=android\.intent\.action\.CHOOSER/.test(emulator.shell("dumpsys activity activities")), "step 6: 分享 opens the system's share sheet");
  check(textsOf(visible()).filter((t) => t.includes(SITE)).length === 1 && shared.text === text, "step 6: what is shared is the sentence with the card's ordinal and the card's address");
  emulator.shell("input keyevent KEYCODE_BACK");
  await backToApp();
  press(say("done.restart"));

  // A card proof again, the same day: nothing changed.
  const again = await cardProof({
    what: "a card proof again: nothing changed; another card at the last tap first",
    name: "again",
    thorough: false,
    otherCardAtLastTap: true,
    accounts: {
      lead: [say("accounts.current") + say("accounts.last_card_proof_today")],
      rowLines: [say("accounts.row_no_switches_yet", { switches_left: 5 }), say("accounts.row_today")],
      notes: [say("accounts.how_refresh"), say("accounts.how_change") + more],
      absent: [say("accounts.none_yet")],
    },
    type: null,
    current: "alice",
    confirm: { intro: say("confirm.intro_single"), account: HANDLE.alice, under: say("kinds.unchanged"), button: say("confirm.button_refresh"), shows: [say("confirm.listed_single", { platform: THREADS }), later], absent: [say("confirm.withdraw_stays")] },
    done: { title: say("done.refresh"), shows: [], absent: [say("done.new_card"), say("done.withdrawn_link")], card: true, reminder: [...reminderSays(today), say("app_done.reminder_change")] },
    date: today,
  });
  check(again === shortId, "the same card has the same short ID");
  press(say("done.restart"));

  // The next day, by the back end's clock and the emulator's.
  await setClocks(new Date(`${tomorrow}T12:00:00+08:00`));

  // A switch: @alice gives way to @bob.
  await cardProof({
    what: "the next day, a switch: @bob in place of @alice",
    name: "switch",
    thorough: false,
    accounts: {
      lead: [say("accounts.current") + say("accounts.last_card_proof", { days_ago: 1 })],
      rowLines: [say("accounts.row_no_switches_yet", { switches_left: 5 })],
      notes: [say("accounts.how_refresh"), say("accounts.how_change") + more],
      absent: [say("accounts.row_today")],
    },
    type: "bob",
    current: "alice",
    confirm: {
      intro: say("confirm.intro_single"),
      account: HANDLE.bob,
      under: say("kinds.switch", { previous: HANDLE.alice }) + say("confirm.uses_switch", { switches_left: 4 }),
      button: say("confirm.button_declare_single"),
      shows: [say("confirm.listed_single", { platform: THREADS }), later],
      absent: [say("confirm.withdraw_stays")],
    },
    done: { title: say("done.changed"), shows: [], absent: [say("done.new_card"), say("done.withdrawn_link")], card: true, reminder: [...reminderSays(tomorrow), say("app_done.reminder_change")] },
    date: tomorrow,
  });
  press(say("done.restart"));

  // A withdrawal: the row cleared.
  await cardProof({
    what: "a withdrawal: the row cleared",
    name: "withdrawal",
    thorough: false,
    accounts: {
      lead: [say("accounts.current") + say("accounts.last_card_proof_today")],
      rowLines: [say("accounts.row_switches", { switches_used: 1, switches_left: 4 }), say("accounts.row_today")],
      notes: [say("accounts.how_refresh"), say("accounts.how_change") + more],
      absent: [],
    },
    type: "",
    current: "bob",
    confirm: {
      intro: say("confirm.intro_withdraw_all"),
      account: HANDLE.bob,
      under: say("kinds.withdraw"),
      button: say("confirm.button_withdraw_all"),
      shows: [say("confirm.withdraw_stays"), say("confirm.later_withdraw") + say("confirm.permanent")],
      absent: [say("confirm.listed_single", { platform: THREADS }), later],
    },
    done: { title: say("done.withdraw_all"), shows: [say("done.withdrawn_link")], absent: [say("done.new_card")], card: false, reminder: [] },
    date: tomorrow,
  });

  await reminderComes(weeksAfter(tomorrow, 12));

  // What the app's requests say of the phone: nothing. Not Android's own User-Agent, which names the model and the version.
  check(JSON.stringify([...userAgents]) === JSON.stringify(["iamreal"]), `every request of the app to the API and the CRL archive calls itself "iamreal" and nothing more: ${JSON.stringify([...userAgents])}`);

  // What the app left on the emulator: the highest CRL number it used, and nothing else; the reminder's file, turned off, is empty. No PIN, no file of a card proof.
  const stored = emulator.shell(`find /data/data/${APP} -type f`).split("\n").map((l) => l.trim()).filter(Boolean).filter((f) => f !== REMINDER_FILE);
  check(JSON.stringify(stored) === JSON.stringify([`/data/data/${APP}/shared_prefs/highest_crl_number.xml`]), `the app's storage holds the CRL numbers it used and nothing else: ${JSON.stringify(stored)}`);
  check(!/<string|<int|<long|<boolean/.test(reminderStored()), `the reminder's file, turned off, holds nothing: ${reminderStored()}`);
  check(emulator.shell(`grep -r -l ${PIN} /data/data/${APP} /sdcard 2>/dev/null; true`).trim() === "", "the PIN is in no file of the app's or of the shared storage");
} catch (e) {
  check(false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  // The emulator as it was: its own clock, network, density and keyboard setting, the port no longer forwarded, adb not root.
  try {
    emulator.shell(`date @${Math.floor(Date.now() / 1000)}; settings put global auto_time 1; svc wifi enable; svc data enable`);
    emulator.shell(`wm size reset; wm density reset; am force-stop ${APP}`);
    if (/^[01]$/.test(imeBefore)) emulator.shell(`settings put secure show_ime_with_hard_keyboard ${imeBefore}`);
    emulator.adb("reverse", "--remove", `tcp:${DEVICE_PORT}`);
    emulator.adb("unroot");
  } catch {
    // The emulator is gone: nothing to put back.
  }
  for (const res of waitingTaps) res.writeHead(204).end();
  front.closeAllConnections();
  await new Promise((r) => front.close(r));
}

// With every check passed, app-backend.ts goes on to iamreal-verify.
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
