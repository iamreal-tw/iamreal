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
// 4. Goes through the eight steps the way a cardholder does (taps and typing,
//    the screen read with uiautomator), four times with the same card: a
//    first declaration (the field filled) and a card proof again today
//    (更新島民證明); the next day another account (改成別的帳號) and its
//    withdrawal (收回對 @bob 的宣告); the back end's clock and the emulator's
//    are moved a day on. Every sentence it expects on a screen is read from
//    design/copy/card-proof.json. Twice a card with another certificate is
//    held to the phone at a tap that would hand over the PIN (the second,
//    the third): it gets none. Twice a card the secure channel cannot be
//    made with is held there: no PIN goes, the PIN typed is dropped, and
//    the tap is not offered again. At the end the app's storage holds
//    nothing of a card proof.
//    After the submission each step does one thing: step 6 hangs the link
//    (the whole of it, or for a card proof again only whether the link is
//    still there), step 7 is the reminder, step 8 is done and the
//    invitation to share. The withdrawal goes from step 5 to step 8.
// 5. The reminder (issue #297): step 7 offers it (這次不要, then 開啟提醒),
//    the screen of its interval and time, the card proofs after it set it
//    again, the settings show it. The emulator's clock is moved to the day
//    and the time of the reminder: the notification's words, "一週後再提醒我"
//    on it, the notification opening step 1 with the reminder's sentence,
//    and the reminder turned off in the settings, after which the app's
//    storage holds nothing of it. Every sentence is read from
//    design/copy/app.json and card-proof.json.
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
/** What step 7 says of a reminder that is offered, or on, for the day 12 weeks after `date` (design/copy/card-proof.md, "7. 提醒"). */
const reminderSays = (date: string): string[] => [
  say("app_done.reminder_title"),
  say("app_reminder.why"),
  say("app_done.reminder_next_about", { day: dayText(weeksAfter(date, 12)), time: NINE, interval: app("interval.weeks_12") }),
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
/** The card that was read, but the secure channel cannot be made with it: it stops before any PIN goes (card/GpkiCard.kt makes the channel while it reads). */
const cardWithoutChannel = JSON.stringify({ certificates: backend.certificates, key, pin: PIN, pause_ms: 0, no_channel: true });

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

/** "第 2 步，共 8 步": the same from step 1 on. */
const step = (n: number): string => say("common.step", { step: n, steps: 8 });
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
  /**
   * What step 4 shows as it opens, and what is done on it (design/copy/card-proof.md, "4. 你的帳號"):
   * fill: the card declares nothing, the account is typed into the field; refresh: 更新島民證明; switch: 改成別的帳號, then the account typed
   * (`after`: what the screen says once it is pressed); withdraw: 收回對 @alice 的宣告.
   */
  accounts: { shows: string[]; absent: string[]; act: { do: "fill"; type: string } | { do: "refresh" } | { do: "switch"; type: string; after: string[] } | { do: "withdraw" } };
  /** At the last tap, another card is held to the phone first. */
  otherCardAtLastTap?: boolean;
  /** The account the card declares before: "" for none. */
  current: string;
  confirm: { intro: string; account: string; under: string; button: string; shows: string[]; absent: string[] };
  /** The step that comes after the submission: 6, or 8 for a card proof that withdrew everything. */
  after: 6 | 8;
  date: string;
}

/** One card proof, from step 1 to the step after the submission (`p.after`), which is left on the screen. Returns the short ID the screens showed. */
async function cardProof(p: Proof): Promise<string> {
  console.log(`\n${p.what}`);
  const tapsBefore = taps;

  // Step 1
  await waitText(step(1), "step 1");
  if (p.thorough) {
    shot("step-1");
    await designShot("card-proof-app-1-before-phone.png");
    const s = wholeScreen();
    shows(s, "step 1", [say("common.service_name"), say("before.title"), say("before.prepare_card"), say("before.citizens_only"), say("before.why_physical"), say("before.how_to_get"), say("common.next")]);
    check(!s.includes(say("before.one_proof")) && !s.includes(say("before.listed_together")) && !s.includes(say("common.back")), "step 1 has no 上一步, and with one platform not the sentences about several");
    check(!s.includes(say("before.duration")), "step 1 does not say the web's sentence of a card reader and 3 minutes");
    check(!s.includes(say("before.why_physical_card")) && !s.includes(say("before.find_office")), "step 1: the two questions are closed");
    // The two questions, opened: the second has the two ways out of the app, for someone without a card yet.
    press(say("before.why_physical"));
    press(say("before.how_to_get"));
    shows(wholeScreen(), "step 1, the questions opened,", [say("before.why_physical_card"), say("before.why_physical_mobile"), say("before.how_to_get_counter"), say("before.find_office"), say("before.how_to_get_moica")]);
    press(say("before.find_office"));
    await sleep(2_000);
    {
      // The phone's map app, searching for the offices; this emulator has none, so the same search on a map's site, in its browser.
      const top = onTop();
      const office = encodeURIComponent("戶政事務所");
      check(top.includes(`dat=geo:0,0?q=${office}`) || top.includes(`dat=https://www.google.com/maps/search/?api=1&query=${office}`), "step 1: 找附近的戶政事務所 opens a map's search for 戶政事務所 outside the app");
      check(!new RegExp(`mResumedActivity.*${APP.replaceAll(".", "\\.")}/`).test(top), "step 1: the map's search is on top, not the app");
    }
    emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
    find((n) => n.text === step(1) || n.text === say("before.find_office"), "the app again, still at step 1");
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
      shows(s, "step 3", [say("pin.title"), say("pin.card_read"), say("pin.label"), say("pin.purpose"), say("app_pin.stays"), say("common.back"), say("pin.confirm_card")]);
      check(!s.includes(say("pin.stays")) && !s.includes(say("pin.pin_characters")), "step 3 says 這支手機, and nothing about characters a PIN may not have");
      // Who can look the card's accounts up with the card and the PIN is step 5's to say, once.
      check(!s.some((t) => t.includes(say("pin.label")) && t !== say("pin.label") && t !== say("pin.title") && t !== say("pin.purpose") && t !== say("app_pin.stays")), "step 3 has the two points and no third");
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
  const act = p.accounts.act;
  {
    shot(`step-4-${p.name}`);
    const s = wholeScreen();
    shows(s, "step 4", [say("accounts.title_single", { platform: THREADS }), ...p.accounts.shows, say("common.cancel")]);
    for (const a of [...p.accounts.absent, say("accounts.title"), say("accounts.edit_list"), say("accounts.switches_limited"), say("accounts.preview")]) check(!s.includes(a), `step 4 does not say "${a.slice(0, 40)}"`);
    if (p.current === "") {
      // Nothing declared: the field, and nothing of what a card with an account can do.
      shows(s, "step 4", [THREADS, "@", say("app_accounts.preview"), say("app_accounts.preview_note", { platform: THREADS }), say("common.next")]);
      for (const a of [say("accounts.refresh"), say("accounts.switch"), say("accounts.declared_now")]) check(!s.includes(a), `step 4, nothing declared, does not say "${a}"`);
      check(field("account-threads").text === "", "step 4: the field is empty");
    } else {
      // An account declared: it is written out, with the main button and the two other things to do; no field.
      const account = `@${p.current}`;
      shows(s, "step 4", [say("accounts.declared_now"), account, say("accounts.refresh"), say("accounts.refresh_note"), say("accounts.switch"), say("accounts.withdraw", { account })]);
      check(field("current-threads").text === account, `step 4: the card declares ${account}`);
      check(!s.includes(say("common.next")) && !s.includes(say("app_accounts.preview")) && !s.includes(say("accounts.keep")), "step 4, an account declared: no field, no 下一步");
    }
  }
  /** Types an account into the Threads field, which is empty. */
  const typeAccount = (account: string): void => {
    emulator.tap(field("account-threads"));
    emulator.type(account);
    hideKeyboard();
    check(field("account-threads").text === account, `step 4: the field now holds "${account}"`);
    check(!textsOf(visible()).includes(say("accounts.need_one")), "step 4: once an account is typed, 請至少填一個帳號。 is gone");
  };
  if (act.do === "fill") {
    if (p.thorough) {
      // Nothing typed: 下一步 goes nowhere.
      press(say("common.next"));
      await waitText(say("accounts.need_one"), "step 4: the sentence for an empty list", 10_000);
      check(true, "step 4: with nothing typed, 下一步 stays and says 請至少填一個帳號。");
    }
    typeAccount(act.type);
    if (p.thorough) await designShot("card-proof-app-4-accounts-phone.png");
    press(say("common.next"));
  } else if (act.do === "refresh") {
    press(say("accounts.refresh"));
  } else if (act.do === "withdraw") {
    press(say("accounts.withdraw", { account: `@${p.current}` }));
  } else {
    const inline = say("accounts.declared_inline", { account: `@${p.current}` });
    press(say("accounts.switch"));
    await waitText(inline, "step 4 after 改成別的帳號", 10_000);
    {
      shot(`step-4-${p.name}-field`);
      const s = wholeScreen();
      shows(s, "step 4, after 改成別的帳號,", [step(4), say("accounts.title_single", { platform: THREADS }), inline, say("accounts.switch"), THREADS, "@", say("app_accounts.preview"), ...act.after, say("app_accounts.preview_note", { platform: THREADS }), say("common.next"), say("accounts.keep"), say("common.cancel")]);
      check(!s.includes(say("accounts.refresh")) && !s.includes(say("accounts.declared_now")), "step 4, after 改成別的帳號: no 更新島民證明");
      check(field("account-threads").text === "", "step 4, after 改成別的帳號: the field is empty");
    }
    // An empty field goes nowhere: withdrawing is the other thing to do.
    press(say("common.next"));
    await waitText(say("accounts.need_one"), "step 4: the sentence for an empty field", 10_000);
    // 不改了: back to what the card declares; then again.
    press(say("accounts.keep"));
    await waitText(say("accounts.refresh"), "step 4 again, after 不改了", 10_000);
    check(!textsOf(visible()).includes(inline), "step 4: 不改了 goes back to what the card declares");
    press(say("accounts.switch"));
    await waitText(inline, "step 4 after 改成別的帳號, again", 10_000);
    typeAccount(act.type);
    press(say("common.next"));
  }

  // Step 5
  await waitText(say("confirm.title"), "step 5");
  let shortId = "";
  {
    shot(`step-5-${p.name}`);
    if (p.thorough) await designShot("card-proof-app-5-confirm-phone.png");
    const s = wholeScreen();
    shows(s, "step 5", [step(5), p.confirm.intro, THREADS, p.confirm.account, p.confirm.under, say("confirm.date"), p.date, say("confirm.short_id_label"), say("confirm.not_identifiable", { platform: THREADS }), ...p.confirm.shows, say("common.back"), p.confirm.button, say("common.cancel")]);
    // With one platform: nothing of a list of several.
    for (const a of [...p.confirm.absent, say("confirm.intro"), say("confirm.listed_together"), say("confirm.withdraw_stays")]) check(!s.includes(a), `step 5 does not say "${a.slice(0, 40)}…"`);
    const opening = new RegExp(`^${say("confirm.short_id", { short_id: "([0-9A-Z]{10})" })}$`);
    shortId = s.map((t) => opening.exec(t)?.[1]).find((x) => x !== undefined) ?? "";
    check(shortId !== "", `step 5 shows how the card's short ID begins: ${shortId}`);
  }
  if (act.do === "fill" || act.do === "switch") {
    // 上一步: the screen of step 4 the button was pressed on, the field as it was typed.
    press(say("common.back"));
    await waitText(step(4), "step 4 again, from step 5", 10_000);
    check(field("account-threads").text === act.type, `step 5: 上一步 goes back to step 4 with "${act.type}" still in the field`);
    press(say("common.next"));
    await waitText(say("confirm.title"), "step 5 again");
  } else {
    // 上一步: what the card declares, as before the button was pressed; the same button again.
    press(say("common.back"));
    await waitText(say("accounts.refresh"), "step 4 again, from step 5", 10_000);
    check(field("current-threads").text === `@${p.current}`, "step 5: 上一步 goes back to what the card declares");
    press(act.do === "refresh" ? say("accounts.refresh") : say("accounts.withdraw", { account: `@${p.current}` }));
    await waitText(say("confirm.title"), "step 5 again");
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

  // Recorded: the step after the submission.
  await waitText(step(p.after), `step ${p.after}`, 300_000);
  check(taps - tapsBefore === 3, `the card was held to the phone three times (${taps - tapsBefore})`);
  return shortId;
}

/** The activity on top of the screen, and the address it was opened with, as the system reports them. */
const onTop = (): string => emulator.shell("dumpsys activity activities").split("\n").filter((l) => /mResumedActivity|^\s*Intent \{ act=android.intent.action.VIEW/.test(l)).join("\n");
/** Back in the app from what it opened outside: where it was left, the step `n`. */
const backToApp = async (n: number): Promise<void> => {
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  // The step is where it was scrolled to: its first line may be above the screen.
  find((x) => x.text === step(n), `the app again, still at step ${n}`);
};

/** The sentence of step 6 that opens the card's page, and the short step 6's. */
const HUNG = say("done.hung", { open_proof: say("done.open_proof") });
const LOOK = say("hang.look", { open_proof: say("done.open_proof") });
const WHY = say("hang.why_single");
/** What only the whole step 6 has. */
const wholeHang = (account: string): string[] => [
  say("hang.title_single", { platform: THREADS }),
  say("hang.copy"),
  say("done.open_profile", { account, platform: THREADS }),
  say("done.step_edit"),
  say("done.step_link"),
  say("done.step_add"),
  say("done.step_paste"),
  HUNG,
  say("done.hung_done"),
];
/** What no step after the submission says when the server's answer was read and is what step 5 said, nor anything of the web's QR code and computer. */
const neverAfter = (account: string): string[] => [
  say("done.unplug"),
  say("done.mismatch"),
  say("done.recorded"),
  say("done.kinds_unreadable"),
  say("done.recorded_only"),
  say("done.other_cards", { account }),
  say("done.by_phone"),
  say("done.by_phone_scan"),
  say("done.on_computer"),
  say("done.return_title"),
  say("done.return_note"),
];

/**
 * Step 6 (design/copy/card-proof.md, "6. 掛上去", app). `short`: a card proof again, asked only whether the link is still there, then
 * 沒有看到連結，重新掛上 for the whole of it. `newCard`: the card's first record. `buttons`: presses what opens something outside the app.
 * Leaves the whole step 6 on the screen.
 */
async function hangStep(o: { name: string; shortId: string; account: string; date: string; short: boolean; newCard: boolean; buttons?: boolean; design?: string }): Promise<void> {
  const link = `${SITE}/p/${o.shortId}`;
  const recorded = say("done.recorded_on", { date: o.date });
  if (o.short) {
    shot(`step-6-${o.name}-short`);
    await designShot("card-proof-app-6-hang-short-phone.png");
    const s = wholeScreen();
    shows(s, "step 6, the short one,", [step(6), recorded, say("hang.still_there_single", { platform: THREADS }), link, LOOK, WHY, say("hang.rehang"), say("common.next")]);
    for (const a of [...wholeHang(o.account), say("hang.new_card"), say("common.back"), ...neverAfter(o.account)]) check(!s.includes(a), `step 6, the short one, does not say "${a.slice(0, 40)}"`);
    press(LOOK);
    await sleep(4_000);
    check(onTop().includes(`dat=http://${link}`), "step 6, the short one: 打開你的島民證明 opens the card's page in the browser");
    await backToApp(6);
    press(say("hang.rehang"));
    await waitText(say("hang.copy"), "the whole step 6, after 沒有看到連結，重新掛上", 10_000);
  }
  shot(`step-6-${o.name}`);
  if (o.design !== undefined) await designShot(o.design);
  const s = wholeScreen();
  shows(s, "step 6", [step(6), recorded, ...wholeHang(o.account), WHY, link, say("common.next"), ...(o.newCard ? [say("hang.new_card")] : [])]);
  check(!s.includes(app("settings.open")), "step 6 has no 設定 in its header");
  const absent = [say("common.back"), say("hang.rehang"), say("done.withdrawn_link"), say("done.share", { platform: THREADS }), say("app_done.reminder_title"), say("finish.done"), ...(o.newCard ? [] : [say("hang.new_card")]), ...neverAfter(o.account)];
  for (const a of absent) check(!s.includes(a), `step 6 does not say "${a.slice(0, 40)}"`);
  if (o.buttons) {
    press(say("hang.copy"));
    await waitText(say("done.copied"), "the button after the link was copied", 10_000);
    check(true, "step 6: 複製證明連結 turns into 已複製");
    press(say("done.open_profile", { account: o.account, platform: THREADS }));
    await sleep(2_000);
    check(onTop().includes(`dat=https://www.threads.com/${o.account}`), `step 6: 打開 ${o.account} 的 Threads 個人檔案 opens https://www.threads.com/${o.account} outside the app`);
    await backToApp(6);
    press(HUNG);
    await sleep(4_000);
    const browser = onTop();
    check(browser.includes(`dat=http://${link}`) && !new RegExp(`mResumedActivity.*${APP.replaceAll(".", "\\.")}/`).test(browser), "step 6: 打開你的島民證明 opens the card's page in the browser");
    await backToApp(6);
  }
}

/** Step 7 with a reminder that is on (design/copy/card-proof.md, "7. 提醒"): the day it was set again for, 下一步, no 這次不要. `date`: the day of the card proof. */
async function remindOn(name: string, date: string, design?: string): Promise<void> {
  await waitText(step(7), "step 7");
  shot(`step-7-${name}`);
  if (design !== undefined) await designShot(design);
  const s = wholeScreen();
  shows(s, "step 7, the reminder on,", [step(7), ...reminderSays(date), say("common.next"), say("common.back"), say("app_reminder.adjust")]);
  check(!s.includes(app("settings.open")), "step 7 has no 設定 in its header");
  for (const a of [say("app_done.reminder_turn_on"), say("app_reminder.skip"), say("app_reminder.denied"), say("app_reminder.settings")]) check(!s.includes(a), `step 7, the reminder on, does not say "${a.slice(0, 30)}"`);
  check(storedDay() === weeksAfter(date, 12), `the card proof set the reminder again, 12 weeks on: ${storedDay()}`);
}

/**
 * Step 8 (design/copy/card-proof.md, "8. 完成和分享", app): the title, the card in small, the card's ordinal and the invitation to share.
 * Returns the ordinal the screen wrote.
 */
async function finishStep(o: { name: string; shortId: string; account: string; title: string; design?: string }): Promise<string> {
  await waitText(step(8), "step 8");
  shot(`step-8-${o.name}`);
  if (o.design !== undefined) await designShot(o.design);
  const s = wholeScreen();
  const invited = new RegExp(`^${say("finish.ordinal", { ordinal: "([0-9,]+)" })}${say("finish.invite")}$`);
  const ordinal = s.map((t) => invited.exec(t)?.[1]).find((x) => x !== undefined) ?? "";
  check(ordinal !== "", `step 8 writes the card's ordinal before the invitation: 第 ${ordinal} 張`);
  shows(s, "step 8", [
    step(8), o.title, say("done.proof"), o.account, `${say("confirm.short_id_label")} ${say("confirm.short_id", { short_id: o.shortId })}`,
    say("finish.thanks"), say("done.share", { platform: THREADS }), say("common.back"), say("finish.done"),
  ]);
  for (const a of [say("hang.copy"), say("app_done.reminder_title"), say("common.next"), say("finish.unlink_single", { platform: THREADS }), ...neverAfter(o.account)]) check(!s.includes(a), `step 8 does not say "${a.slice(0, 40)}"`);
  return ordinal;
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

/**
 * Before any record: a card the secure channel cannot be made with, at each tap that would hand over the PIN (design/copy/card-proof.md, "3. 輸入 PIN" and
 * "5. 確認", app; issue #365). The sentence sends the cardholder to a card reader, so the tap is not offered again with the PIN kept: at step 3 the PIN is gone
 * and is typed again; at step 5 everything is dropped, and the only button goes back to step 1.
 */
async function noSecureChannel(): Promise<void> {
  console.log("\na card the secure channel cannot be made with, at the second tap and at the third");
  const channel = say("app_stops.channel");
  await waitText(step(1), "step 1");
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end", 120_000);
  press(say("common.next"));
  await waitText(step(3), "step 3");
  emulator.tap(field("pin"));
  emulator.type(PIN);
  const handed = pinsHanded;
  press(say("pin.confirm_card"));
  await hold(cardWithoutChannel);
  await waitText(channel, "step 3: the sentence for a card without a secure channel", 20_000);
  {
    const s = wholeScreen();
    shows(s, "step 3, no secure channel,", [step(3), channel, say("common.back"), say("pin.confirm_card")]);
    check(!s.includes(say("app_read.tap_again")) && !s.includes(say("app_read.restart")), "step 3, no secure channel: no 再感應一次");
    check(field("pin").text === "", `step 3, no secure channel: the PIN's field is empty ("${field("pin").text}")`);
    check(pinsHanded === handed, "step 3, no secure channel: the card was not handed the PIN");
  }
  // The PIN is gone: 確認卡片 brings no panel and no tap until it is typed again.
  press(say("pin.confirm_card"));
  await waitText(say("app_pin.need_pin"), "step 3: the sentence for an empty PIN, after the channel failed", 10_000);
  check(waitingTaps.length === 0 && !textsOf(visible()).includes(say("app_panel.android_wait_title")), "step 3, no secure channel: 確認卡片 with the PIN gone brings no panel and no tap");
  // Typed again, with a card whose channel works: on to step 4.
  emulator.tap(field("pin"));
  emulator.type(PIN);
  press(say("pin.confirm_card"));
  await tap();
  await waitText(step(4), "step 4", 120_000);
  emulator.tap(field("account-threads"));
  emulator.type("alice");
  hideKeyboard();
  press(say("common.next"));
  await waitText(say("confirm.title"), "step 5");
  const handedBefore = pinsHanded;
  press(say("confirm.button_declare_single"));
  await waitText(say("progress.title"), "step 5, in progress");
  await hold(cardWithoutChannel);
  await waitText(channel, "step 5: the sentence for a card without a secure channel", 20_000);
  {
    const s = wholeScreen();
    shows(s, "step 5, no secure channel,", [step(5), say("common.halted"), channel, say("accounts.restart")]);
    check(!s.includes(say("app_read.tap_again")) && !s.includes(say("common.cancel")), "step 5, no secure channel: only 回到開頭, no 再感應一次 and no 取消");
    check(pinsHanded === handedBefore, "step 5, no secure channel: the card was not handed the PIN");
  }
  press(say("accounts.restart"));
  await waitText(step(1), "step 1 again, after 回到開頭", 20_000);
  check(waitingTaps.length === 0, "step 5, no secure channel: 回到開頭 goes back to step 1, with no tap waiting");
  taps = 0;
}

// 5. The reminder ---------------------------------------------------------------------

/** Where the app keeps the reminder (src/main/…/reminder/Phone.kt), and what is in it. */
const REMINDER_FILE = `/data/data/${APP}/shared_prefs/reminder.xml`;
const reminderStored = (): string => emulator.shell(`cat ${REMINDER_FILE} 2>/dev/null; true`);
const storedDay = (): string | undefined => /<string name="day">([0-9-]+)<\/string>/.exec(reminderStored())?.[1];

/**
 * Step 7 of the first card proof, which offers the reminder (design/copy/card-proof.md, "7. 提醒"): 這次不要 stores nothing and goes on;
 * back from step 8, the screen of its interval and time, left without saving; 開啟提醒 sets the defaults and goes on; back again, step 7
 * shows the reminder that is on. Leaves step 7 on the screen, the reminder on.
 */
async function reminderOffered(shortId: string): Promise<void> {
  console.log("\nstep 7: the reminder, offered");
  await waitText(step(7), "step 7");
  {
    shot("step-7-first");
    await designShot("card-proof-app-7-reminder-phone.png");
    const s = wholeScreen();
    shows(s, "step 7", [step(7), ...reminderSays(today), say("app_done.reminder_turn_on"), say("common.back"), say("app_reminder.adjust"), say("app_reminder.skip")]);
    for (const a of [say("common.next"), say("app_reminder.denied"), say("app_reminder.settings"), say("hang.copy"), say("finish.done")]) check(!s.includes(a), `step 7 does not say "${a.slice(0, 30)}"`);
  }
  // 上一步: step 6 as it was left; then on again.
  press(say("common.back"));
  await waitText(say("hang.copy"), "step 6 again, from step 7", 10_000);
  check(textsOf(visible()).includes(step(6)), "step 7: 上一步 goes back to step 6");
  press(say("common.next"));
  await waitText(step(7), "step 7 again");
  // 這次不要: nothing stored, on to step 8.
  press(say("app_reminder.skip"));
  await waitText(step(8), "step 8, after 這次不要", 10_000);
  check(!/<string/.test(reminderStored()), "這次不要 stores nothing of a reminder");
  // 上一步 of step 8: step 7, which offers the reminder again.
  press(say("common.back"));
  await waitText(say("app_done.reminder_turn_on"), "step 7 again, from step 8", 10_000);
  check(textsOf(visible()).includes(step(7)), "step 8: 上一步 goes back to step 7");
  press(say("app_reminder.adjust"));
  await waitText(app("reminder.from_today"), "the screen of the interval and the time");
  check(!/<string/.test(reminderStored()), "before 開啟提醒 the phone stores nothing of the reminder");
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
  // Left without saving: step 7 as it was, nothing stored.
  press(app("reminder.cancel"));
  await waitText(say("app_done.reminder_turn_on"), "step 7 again, from the screen of the interval and the time", 10_000);
  check(!/<string/.test(reminderStored()), "the screen of the interval and the time, left with 取消, stores nothing");
  // 開啟提醒: the defaults, and on to step 8 (this Android asks nothing before it lets an app notify).
  press(say("app_done.reminder_turn_on"));
  await waitText(step(8), "step 8, after 開啟提醒", 10_000);
  press(say("common.back"));
  await remindOn("first-on", today, "card-proof-app-7-reminder-on-phone.png");
  check(storedDay() === weeksAfter(today, 12), `the phone stores the day of the next reminder: ${storedDay()}`);
  const kept = [...reminderStored().matchAll(/name="([a-z]+)"/g)].map((m) => m[1]).sort();
  check(JSON.stringify(kept) === JSON.stringify(["day", "interval", "on", "time"]), `the phone stores the reminder's four things and nothing else: ${JSON.stringify(kept)}`);
  check(!reminderStored().includes(shortId) && !reminderStored().includes("alice"), "the reminder's file has no short ID and no account");

}

/** The settings, from step 8's header (design/copy/app.md, "設定"), with the reminder on. Back at step 8. */
async function settingsFromLastStep(): Promise<void> {
  check(textsOf(visible()).includes(app("settings.open")), "step 8 has 設定 in its header");
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
  await waitText(step(8), "step 8 again, from the settings", 10_000);
  check(true, "the settings: 返回 goes back to step 8");
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
  /** Step 5's two points when the list is not empty, and its three when it is. */
  const holder = say("confirm.holder_later", { platform: THREADS, cannot_delete: say("confirm.cannot_delete") });
  const WITHDRAWN = [say("confirm.history_stays"), say("confirm.holder_later_withdraw")];

  await anotherCardThenCancel();
  await noSecureChannel();

  // A first declaration: @alice.
  const shortId = await cardProof({
    what: "a first declaration: @alice",
    name: "first",
    thorough: true,
    accounts: { shows: [say("accounts.none_yet"), say("accounts.fill_one_single", { platform: THREADS })], absent: [say("accounts.row_unused"), say("accounts.nothing_now")], act: { do: "fill", type: "alice" } },
    current: "",
    confirm: { intro: say("confirm.intro_public"), account: HANDLE.alice, under: say("kinds.first"), button: say("confirm.button_declare_single"), shows: [holder], absent: WITHDRAWN },
    after: 6,
    date: today,
  });

  // Step 6, the whole of it: the card's first record. Then the reminder, offered; then step 8.
  await hangStep({ name: "first", shortId, account: HANDLE.alice, date: today, short: false, newCard: true, buttons: true, design: "card-proof-app-6-hang-phone.png" });
  press(say("common.next"));
  await reminderOffered(shortId);
  press(say("common.next"));
  const ordinal = await finishStep({ name: "first", shortId, account: HANDLE.alice, title: say("finish.first"), design: "card-proof-app-8-done-phone.png" });
  await settingsFromLastStep();
  const page = await fetch(`${backend.origin}/p/${shortId}`);
  const html = await page.text();
  check(page.status === 200 && html.includes("@alice"), `the Worker's page of the card, /p/${shortId}, lists @alice`);
  // The card's ordinal as its page writes it: the proof log's, which the answer to the submission gave the app.
  check(/<p class="ordinal">第 ([0-9,]+) 張島民證明<\/p>/.exec(html)?.[1] === ordinal, `the card's page writes the same ordinal, 第 ${ordinal} 張`);
  // The system's share sheet, with the sentence and, on the line under it, the address of the card's page (Android 10
  // shows the text it is given at its top).
  press(say("done.share", { platform: THREADS }));
  const text = `${say("done.share_text", { ordinal })}\nhttp://${SITE}/p/${shortId}`;
  const shared = await waitText(text, "the share sheet with the sentence and the card's address", 20_000);
  check(/act=android\.intent\.action\.CHOOSER/.test(emulator.shell("dumpsys activity activities")), "step 8: 分享到 Threads opens the system's share sheet");
  check(textsOf(visible()).filter((t) => t.includes(SITE)).length === 1 && shared.text === text, "step 8: what is shared is the sentence with the card's ordinal and the card's address");
  emulator.shell("input keyevent KEYCODE_BACK");
  await backToApp(8);
  // 完成: step 1.
  press(say("finish.done"));
  await waitText(step(1), "step 1 again, after 完成", 10_000);
  check(true, "step 8: 完成 goes back to step 1");

  // A card proof again, the same day: 更新島民證明, nothing typed.
  const again = await cardProof({
    what: "a card proof again: 更新島民證明; another card at the last tap first",
    name: "again",
    thorough: false,
    otherCardAtLastTap: true,
    accounts: { shows: [say("accounts.last_proof_today")], absent: [say("accounts.none_yet")], act: { do: "refresh" } },
    current: "alice",
    confirm: { intro: say("confirm.intro_public"), account: HANDLE.alice, under: say("kinds.unchanged"), button: say("confirm.button_refresh"), shows: [holder], absent: WITHDRAWN },
    after: 6,
    date: today,
  });
  check(again === shortId, "the same card has the same short ID");
  // Step 6 asks only whether the link is still there; step 7 shows the reminder set again; step 8 says it was updated.
  await hangStep({ name: "again", shortId, account: HANDLE.alice, date: today, short: true, newCard: false });
  press(say("common.next"));
  await remindOn("again", today);
  press(say("common.next"));
  await finishStep({ name: "again", shortId, account: HANDLE.alice, title: say("done.refresh") });
  press(say("finish.done"));

  // The next day, by the back end's clock and the emulator's.
  await setClocks(new Date(`${tomorrow}T12:00:00+08:00`));

  // 改成別的帳號: @alice gives way to @bob.
  const switched = await cardProof({
    what: "the next day, 改成別的帳號: @bob in place of @alice",
    name: "switch",
    thorough: false,
    accounts: {
      shows: [say("accounts.last_proof", { days_ago: 1 })],
      absent: [say("accounts.last_proof_today")],
      // What the change does, and the switches left after it: said only now.
      act: { do: "switch", type: "bob", after: [say("accounts.switch_effect", { account: HANDLE.alice }) + say("accounts.switch_limit", { switches_left: 4 })] },
    },
    current: "alice",
    confirm: {
      intro: say("confirm.intro_public"),
      account: HANDLE.bob,
      under: say("kinds.switch", { previous: HANDLE.alice }) + say("confirm.uses_switch", { switches_left: 4 }),
      button: say("confirm.button_declare_single"),
      shows: [holder],
      absent: WITHDRAWN,
    },
    after: 6,
    date: tomorrow,
  });
  // Another account: the whole step 6 (not a new card), the reminder from the new day, and step 8 names the account.
  await hangStep({ name: "switch", shortId: switched, account: HANDLE.bob, date: tomorrow, short: false, newCard: false });
  press(say("common.next"));
  await remindOn("switch", tomorrow);
  press(say("common.next"));
  await finishStep({ name: "switch", shortId: switched, account: HANDLE.bob, title: say("finish.switched", { account: HANDLE.bob }), design: "card-proof-app-8-done-switch-phone.png" });
  press(say("finish.done"));

  // 收回對 @bob 的宣告.
  await cardProof({
    what: "a withdrawal: 收回對 @bob 的宣告",
    name: "withdrawal",
    thorough: false,
    accounts: { shows: [say("accounts.last_proof_today")], absent: [], act: { do: "withdraw" } },
    current: "bob",
    confirm: {
      intro: say("confirm.intro_withdraw_all"),
      account: HANDLE.bob,
      under: say("kinds.withdraw"),
      button: say("confirm.button_withdraw", { account: HANDLE.bob }),
      shows: WITHDRAWN,
      absent: [holder, say("confirm.intro_public")],
    },
    after: 8,
    date: tomorrow,
  });
  // Everything withdrawn: from step 5 straight to step 8. Nothing to hang, to be reminded of or to share, and no way back.
  {
    shot("step-8-withdrawal");
    await designShot("card-proof-app-8-withdraw-phone.png");
    const s = wholeScreen();
    shows(s, "step 8, everything withdrawn,", [step(8), say("done.withdraw_all"), say("done.recorded_on", { date: tomorrow }), say("finish.unlink_single", { platform: THREADS }), say("finish.done")]);
    const absent = [
      say("common.back"), say("common.next"), say("done.share", { platform: THREADS }), say("finish.thanks"), say("app_done.reminder_title"), say("done.withdrawn_link"),
      ...wholeHang(HANDLE.bob), LOOK, ...neverAfter(HANDLE.bob),
    ];
    for (const a of absent) check(!s.includes(a), `step 8, everything withdrawn, does not say "${a.slice(0, 40)}"`);
    check(storedDay() === weeksAfter(tomorrow, 12), `the reminder that is on is set again by this card proof too: ${storedDay()}`);
  }

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
