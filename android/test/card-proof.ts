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
//    Four paths are the test's own, for the fake build of the app:
//    /__test/issuers (the issuer keys), /__test/tap (which card is held to
//    the phone, src/fake/), /__test/pin (a card was handed a PIN) and
//    /__test/phone (whether the phone has NFC). For the minimum app version
//    it can also change the `min_app` of the back end's config on its way
//    to the app, or leave the config unanswered.
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
//    nothing of a card proof but the card proof device ID.
//    After the submission each step does one thing: step 6 hangs the link
//    (the whole of it, or for a card proof again only whether the link is
//    still there), step 7 is the reminder, step 8 is done and the
//    invitation to share. The withdrawal goes from step 5 to step 8.
// 5. The reminder (issue #297): step 7 offers it (這次不要, then 設定提醒 and 開啟提醒 on the screen it opens),
//    the screen of its interval and time, the card proofs after it set it
//    again, the settings show it. The emulator's clock is moved to the day
//    and the time of the reminder: the notification's words, "一週後再提醒我"
//    on it, the notification opening step 1 with the reminder's sentence,
//    and the reminder turned off in the settings, after which the app's
//    storage holds nothing of it. Every sentence is read from
//    design/copy/app.json and card-proof.json.
//
// 6. What interrupts a card proof (issue #171), before any record is made: a
//    card that leaves at each tap, a wrong PIN, the PIN on its way when the
//    card leaves (never sent again by itself), NFC turned off after step 2,
//    the app in the background and back, the 5 minutes (the emulator's clock
//    is moved), the app ended by the system. Then the minimum app version
//    (the sentence above step 1 before its start date, the screen in place
//    of step 1 from it on, a field that cannot be read, a config that does
//    not come) and a phone without NFC.
// 7. The maintainer stops taking card proofs, and takes them again (#394, #402;
//    app-backend.ts's PUT /__app-test/paused), before the first declaration:
//    the app opened while stopped (step 1's sentence in place of 下一步);
//    stopped after step 1, so that challenges answers paused, then records
//    does (stops.paused, and only 回到開頭); taken again, the first
//    declaration goes through.
// 8. Too many people (ADR-0026, #419), in the card proof again: the server
//    here answers a request as the Worker does when it turns one away
//    (429 rate_limited or 503 busy, Retry-After). The config of step 1 that
//    has no mark turned away: step 1 goes on as it was. The start
//    (config?start) turned away, busy then rate limited: step 1 stays and
//    says so above 下一步, and the app does not wait for a card. The config
//    the reading asks again, without the mark, turned away: the card is
//    read all the same. Then the card's state (step 3), the challenge and the submission (step 5)
//    turned away: 再試一次 sends the same request again, and the card is
//    held to the phone no more than in any card proof.
// 9. The counts (spec/counts.md, #433), as the server in between saw them:
//    every count is the app's and carries nothing of a card, an account or
//    a scoped ID; each card proof that was done sent every step of the
//    table once, and how long the CRL, the tree and the proof took; the
//    interruptions above were sent as their reasons, and a card that left
//    as an action with its tap; every submission carried the card proof
//    device ID the counts carry.
//
// With IAMREAL_STORE_SCREENS set to a directory, the first declaration also
// leaves there the four screenshots of the app's page on Google Play (#489;
// android/README.md, "商店頁的圖片").
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

/** The card that was read, leaving the phone at `where` (src/fake/…/FakeCard.kt): while it is read, while the PIN is on its way, or after it took the PIN. */
const leaving = (where: "reading" | "pin" | "signing"): string => JSON.stringify({ certificates: backend.certificates, key, pin: PIN, pause_ms: 0, leaves: where });
/** In place of a card: the phone's NFC is turned off, or the phone has none. */
const nfc = (what: "off" | "none"): string => JSON.stringify({ nfc: what });
/** A PIN the card does not take, as long as the card's. */
const WRONG_PIN = /^0+$/.test(PIN) ? "1".repeat(PIN.length) : "0".repeat(PIN.length);

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
/** The requests for a challenge that came (`POST /api/v1/challenges`), and whether the next one gets no answer: its connection is closed with the request read (issue #404). */
let challengesAsked = 0;
let dropNextChallenge = false;
/** Whether the phone the app is on has NFC (src/fake/…/FakeCard.kt asks once, when the app opens). */
let phoneHasNfc = true;
/**
 * What the app gets as the config's `min_app` in place of the back end's: a value, or "unanswered" for a config that does not
 * come. Undefined: the back end's own.
 */
let minApp: { value: unknown } | "unanswered" | undefined;
/**
 * The requests the server here turns away as too many, by `METHOD /path?query`: the next ones that come are answered as the
 * Worker answers one it turns away (docs/api/card-proof.md, "Rules for every endpoint"), not handed on. Each is taken once.
 */
const turnAway = new Map<string, { status: 429 | 503; code: "rate_limited" | "busy" }[]>();
/** How many requests came, by `METHOD /path?query`. */
const asked = new Map<string, number>();
/** The next request `line` that comes is turned away as too many. */
const away = (line: string, status: 429 | 503, code: "rate_limited" | "busy"): void => void turnAway.set(line, [...(turnAway.get(line) ?? []), { status, code }]);
/** What the app's requests called themselves (User-Agent), each once. */
const userAgents = new Set<string>();
/** The counts the app sent (`POST /api/v1/counts`), read, in the order they came. */
const countsSent: Record<string, unknown>[] = [];
/** The `device_id` of each submission (`POST /api/v1/records`), or null for one without it. */
const submittedDeviceIds: (string | null)[] = [];
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
    if (path === "/__test/phone") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ nfc: phoneHasNfc }));
    if (path === "/api/v1/config" && minApp === "unanswered") return void req.socket.destroy();
    if (path === "/api/v1/challenges" && req.method === "POST") {
      challengesAsked++;
      if (dropNextChallenge) {
        // As a connection the phone kept and something on the way has closed: the request goes out, and not a byte comes back.
        dropNextChallenge = false;
        for await (const _ of req) void _;
        return void req.socket.destroy();
      }
    }
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
    const line = `${req.method} ${req.url}`;
    asked.set(line, (asked.get(line) ?? 0) + 1);
    const turned = turnAway.get(line)?.shift();
    if (turned !== undefined) {
      for await (const _ of req) void _;
      return void res.writeHead(turned.status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "60" }).end(JSON.stringify({ error: turned.code }));
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.method === "POST" && (path === "/api/v1/counts" || path === "/api/v1/records")) {
      let said: Record<string, unknown> = {};
      try {
        said = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        // Not JSON: checked below as a count with nothing.
      }
      if (path === "/api/v1/counts") countsSent.push(said);
      else submittedDeviceIds.push(typeof said.device_id === "string" ? said.device_id : null);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length"].includes(k)) headers[k] = v;
    const answer = await fetch(backend.origin + (req.url ?? "/"), { method: req.method, headers, redirect: "manual", ...(chunks.length > 0 && { body: Buffer.concat(chunks) }) });
    const sent: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      // The body is sent as this server has it, whatever the back end's server did to send it.
      if (!["content-encoding", "transfer-encoding", "content-length", "connection"].includes(name)) sent[name] = value;
    });
    let body = Buffer.from(await answer.arrayBuffer());
    const given = minApp;
    if (path === "/api/v1/config" && typeof given === "object" && answer.status === 200) body = Buffer.from(JSON.stringify({ ...(JSON.parse(body.toString("utf8")) as object), min_app: given.value }));
    res.writeHead(answer.status, sent).end(body);
  } catch (e) {
    res.writeHead(502).end(String(e));
  }
});

// Connections the app keeps open stay open longer than Node's 5 seconds: at 5 the server closed one as the app sent a POST on it
// (step 5's challenge, about 5 seconds after step 3's card state), which Android's HttpURLConnection does not send again, and the card
// proof stopped with `network` (#402). 5 minutes is longer than any wait of this test between two requests of the app.
front.keepAliveTimeout = 300_000;

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

/**
 * Where to save the four screenshots of the app's page on Google Play (#489), when IAMREAL_STORE_SCREENS names a directory: the
 * first declaration's step 2 with the panel waiting for the card, step 3 with the PIN typed, step 4 with @alice typed, step 8. Each is
 * the emulator's whole screen as the test has it, a phone's (1080 by 2280, density 420), with the system's bar in its demo mode for
 * the moment: a set time, a full battery and signal, no notification.
 */
const STORE_SCREENS = process.env.IAMREAL_STORE_SCREENS;
/** The start of a broadcast to the demo mode of Android's system bar (SystemUI's "demo mode"). */
const DEMO_BROADCAST = "am broadcast -a com.android.systemui.demo -e command";
/** The emulator's setting that allows the demo mode, before the test changed it. */
let demoAllowedBefore = "";

/** Puts the system's bar in its demo mode for the store's screenshots, or takes it out and puts the setting back as it was. */
function demoStatusBar(on: boolean): void {
  if (STORE_SCREENS === undefined) return;
  if (!on) {
    emulator.shell(`${DEMO_BROADCAST} exit`);
    // Not set ("null") is off, as 0 is.
    emulator.shell(`settings put global sysui_demo_allowed ${demoAllowedBefore === "1" ? 1 : 0}`);
    return;
  }
  if (demoAllowedBefore === "") demoAllowedBefore = emulator.shell("settings get global sysui_demo_allowed").trim();
  emulator.shell(
    [
      "settings put global sysui_demo_allowed 1",
      `${DEMO_BROADCAST} enter`,
      `${DEMO_BROADCAST} clock -e hhmm 0900`,
      `${DEMO_BROADCAST} battery -e level 100 -e plugged false`,
      `${DEMO_BROADCAST} network -e wifi show -e level 4 -e fully true`,
      `${DEMO_BROADCAST} network -e mobile show -e datatype none -e level 4 -e fully true`,
      `${DEMO_BROADCAST} notifications -e visible false`,
    ].join("; "),
  );
}

/**
 * The screen as `file` of STORE_SCREENS, if it is set, from the top of the step (`fromTop`) or as it is (a panel over the step).
 * Checks it is one Google Play takes for a phone: a PNG of 24-bit colour with no alpha, each side 320 to 3,840 pixels, the long side
 * at most 2.3 times the short (https://support.google.com/googleplay/android-developer/answer/9866151).
 */
async function storeShot(file: string, fromTop = true): Promise<void> {
  if (STORE_SCREENS === undefined) return;
  if (fromTop) toTop();
  demoStatusBar(true);
  await sleep(1_000);
  const png = emulator.screenshotRgb();
  demoStatusBar(false);
  mkdirSync(STORE_SCREENS, { recursive: true });
  writeFileSync(join(STORE_SCREENS, file), png);
  // The PNG's signature, then its header (IHDR): the width, the height, the bits of a sample and the colour type (2: RGB, no alpha).
  const signed = png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.toString("latin1", 12, 16) === "IHDR";
  const [width, height] = signed ? [png.readUInt32BE(16), png.readUInt32BE(20)] : [0, 0];
  check(signed && png[24] === 8 && png[25] === 2, `the store's screenshot ${file} is a PNG of 24-bit colour with no alpha`);
  const [short, long] = [Math.min(width, height), Math.max(width, height)];
  check(short >= 320 && long <= 3_840 && long <= 2.3 * short, `the store's screenshot ${file} is ${width}x${height}: each side 320 to 3,840 pixels, the long side at most 2.3 times the short`);
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

/** Scrolls the step back to its top. */
function toTop(): void {
  let before = "";
  for (let i = 0; i < 12; i++) {
    const now = JSON.stringify(visible().map((n) => [n.text, n.top]));
    if (now === before) break;
    before = now;
    emulator.scrollUp();
  }
}

/** Finds a node, scrolling for it: down to the end of the step, then back up to its top. */
function find(match: (n: Node) => boolean, what: string): Node {
  let last: Node[] = [];
  for (const scroll of [() => emulator.scrollDown(), () => emulator.scrollUp()]) {
    let before = "";
    let unmoved = 0;
    for (let i = 0; i < 14; i++) {
      last = visible();
      const node = last.find(match);
      // Not one that only peeks over an edge of the screen.
      if (node && node.bottom < emulator.size().height - 80 && node.top > 80) return node;
      const now = JSON.stringify(last.map((n) => [n.text, n.top]));
      // The end of the step: the screen did not move, twice. Once is not enough: a swipe made while a demonstration is being
      // drawn (steps 2 and 6) is now and then lost on a busy emulator.
      unmoved = now === before ? unmoved + 1 : 0;
      if (unmoved === 2) break;
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
const READ_ITEMS = [say("read.server"), say("app_read.certificate"), say("read.check"), say("read.crl")];
const PROGRESS_ITEMS = [say("progress.server"), say("app_progress.sign"), say("app_progress.compute", { seconds: 10 }), say("progress.submit")];

/** The panel of a tap, while the card is read or signs: what it says in turn (design/copy/card-proof.md, "app：感應的面板"). */
async function tapWithPanel(o: { signs: boolean; store?: string }): Promise<void> {
  await waitText(say("app_panel.android_wait_title"), "the panel");
  shot("panel-waiting");
  if (o.store !== undefined) await storeShot(o.store, false);
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
  /** The server turns requests away as too many people (section 8): step 1's config, the start, the card's state, the challenge, the submission. */
  turnedAway?: boolean;
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
  if (p.turnedAway) await turnedAwayAtStart();
  press(say("common.next"));

  // Step 2
  await waitText(step(2), "step 2");
  if (p.thorough) {
    // The demonstration of where the card goes (design/copy/card-proof.md, "示範"): one element to a screen reader; it plays by itself
    // when the step comes up, three rounds, and 停止播放 goes straight to its rest: the card in place.
    {
      const picture = find((n) => n.id === "sense-demo", "the demonstration of step 2");
      check(picture.description === say("app_demo.sense_android"), `step 2's demonstration reads as its one sentence of the copy ("${picture.description.slice(0, 20)}…")`);
      const [stop, replay] = [say("app_demo.stop"), say("app_demo.replay")];
      const says = (label: string): boolean => textsOf(visible()).includes(label);
      check(says(stop) && !says(replay), "step 2: the demonstration plays by itself, and its button says 停止播放");
      press(stop);
      await waitText(replay, "step 2's demonstration stopped", 10_000);
      check(says(replay) && !says(stop), "step 2: 停止播放 stops the demonstration, and its button says 再看一次");
      // Pressing the picture itself does what its words in the corner say.
      emulator.tap(find((n) => n.id === "sense-demo", "the demonstration of step 2"));
      await waitText(stop, "step 2's demonstration played again by pressing it", 10_000);
      emulator.tap(find((n) => n.id === "sense-demo", "the demonstration of step 2"));
      await waitText(replay, "step 2's demonstration stopped by pressing it", 10_000);
      check(true, "step 2: pressing the demonstration plays it again, and stops it");
      if (RECORD_SENSE !== undefined) {
        emulator.adb("emu", "screenrecord", "start", "--fps", "60", "--bit-rate", "12M", "--time-limit", "40", RECORD_SENSE);
        await sleep(1_000);
        press(replay);
        await sleep(28_000);
        emulator.adb("emu", "screenrecord", "stop");
        await waitText(replay, "step 2's demonstration at rest after its three rounds", 10_000);
        check(true, `step 2: the demonstration came to rest by itself after its rounds, recorded as ${RECORD_SENSE}`);
      }
      toTop();
    }
    shot("step-2");
    await designShot("card-proof-app-2-read-android-phone.png");
    {
      // Before the card is read: 感應卡片 on the first screen, right under the demonstration, beside 上一步; the list under them.
      toTop();
      const now = visible();
      const tapCard = now.find((n) => n.text === say("app_read.tap_card"));
      const back = now.find((n) => n.text === say("common.back"));
      const picture = now.find((n) => n.id === "sense-demo");
      if (check(tapCard !== undefined && back !== undefined && picture !== undefined && tapCard.bottom < emulator.size().height, "step 2: 感應卡片 is on the first screen, without scrolling")) {
        check(picture!.bottom < tapCard!.top, "step 2: 感應卡片 is under the demonstration");
        check(Math.abs(tapCard!.y - back!.y) < 40 && back!.x < tapCard!.x, `step 2: 上一步 and 感應卡片 are side by side, 上一步 on the left (${back!.x},${back!.y} and ${tapCard!.x},${tapCard!.y})`);
        const first = find((n) => n.text === READ_ITEMS[0], "the first item of step 2's list");
        check(tapCard!.bottom < first.top, "step 2: the list is under the buttons until the card is read");
        toTop();
      }
    }
    const s = wholeScreen();
    shows(s, "step 2", [say("read.title"), say("app_read.how_android"), say("app_demo.replay"), ...READ_ITEMS, say("common.back"), say("app_read.tap_card")]);
    check(![say("read.component"), say("read.reader"), say("read.certificate")].some((x) => s.includes(x)), "step 2's list has no item of MOICA's component or a card reader");
    // Where on its back differs from one Android phone to another: nothing here says the middle, or not to move the card.
    check(!s.some((t) => t.includes(say("app_read.spot_iphone")) || t === say("app_read.how", { spot: say("app_read.spot_iphone") })), "step 2 does not say where on the phone's back, nor the iPhone's sentence that says not to move the card");
  }
  // The challenge the reading asks for, before the CRL's index (#553), turned away: that is no stop, and step 5 asks for its own.
  const challengesAtReading = asked.get("POST /api/v1/challenges") ?? 0;
  if (p.turnedAway) away("POST /api/v1/challenges", 429, "rate_limited");
  press(say("app_read.tap_card"));
  if (p.thorough) await tapWithPanel({ signs: false, store: "phone-1-read.png" });
  else await tap();
  await waitText(say("app_read.lift"), "step 2's list to end", 120_000);
  if (p.turnedAway) check((asked.get("POST /api/v1/challenges") ?? 0) - challengesAtReading === 1 && (turnAway.get("POST /api/v1/challenges") ?? []).length === 0, "step 2: the reading asked for a challenge, and was turned away");
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
      shows(s, "step 3", [say("pin.title"), say("pin.card_read"), say("pin.label"), say("pin.purpose_single", { platform: THREADS }), say("app_pin.stays"), say("common.back"), say("pin.confirm_card")]);
      check(!s.includes(say("pin.stays")) && !s.includes(say("pin.pin_characters")), "step 3 says 這支手機, and nothing about characters a PIN may not have");
      // Who can look the card's accounts up with the card and the PIN is step 5's to say, once.
      check(!s.some((t) => t.includes(say("pin.label")) && t !== say("pin.label") && t !== say("pin.title") && t !== say("pin.purpose_single", { platform: THREADS }) && t !== say("app_pin.stays")), "step 3 has the two points and no third");
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
  if (p.thorough && (DESIGN_SCREENS !== undefined || STORE_SCREENS !== undefined)) {
    hideKeyboard();
    await designShot("card-proof-app-3-pin-phone.png");
    await storeShot("phone-2-pin.png");
  }
  {
    const s = wholeScreen();
    check(!s.some((t) => t.includes(PIN)), "step 3: the PIN typed is not on the screen");
    check(!s.includes(say("app_pin.need_pin")) && !s.includes(say("app_pin.pin_format")), "step 3: with a PIN typed, no 請輸入 PIN。 and no sentence of the PIN's form");
  }
  if (p.turnedAway) away("POST /api/v1/card-state", 503, "busy");
  press(say("pin.confirm_card"));
  if (p.thorough) await tapWithPanel({ signs: true });
  else await tap();
  if (p.turnedAway) await turnedAwayAtCardState();

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
      shows(s, "step 4", [THREADS, "@", say("app_accounts.preview"), say("accounts.preview_note_single", { platform: THREADS }), say("common.next")]);
      for (const a of [say("accounts.refresh"), say("accounts.switch"), say("accounts.declared_now")]) check(!s.includes(a), `step 4, nothing declared, does not say "${a}"`);
      check(field("account-threads").text === "", "step 4: the field is empty");
    } else {
      // An account declared: it is written out, with the main button and the two other things to do; no field.
      const account = `@${p.current}`;
      shows(s, "step 4", [say("accounts.declared_now"), account, say("accounts.refresh"), say("accounts.refresh_note"), say("accounts.switch"), say("accounts.withdraw", { account })]);
      check(field("current-threads").text === account, `step 4: the card declares ${account}`);
      check(!s.includes(say("common.next")) && !s.includes(say("app_accounts.preview")) && !s.includes(say("common.back")), "step 4, an account declared: no field, no 下一步, no 上一步");
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
    if (p.thorough) await storeShot("phone-3-accounts.png");
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
      shows(s, "step 4, after 改成別的帳號,", [step(4), say("accounts.title_single", { platform: THREADS }), inline, say("accounts.switch"), THREADS, "@", say("app_accounts.preview"), ...act.after, say("accounts.preview_note_single_counted", { platform: THREADS }), say("common.next"), say("common.back"), say("common.cancel")]);
      check(!s.includes(say("accounts.refresh")) && !s.includes(say("accounts.declared_now")), "step 4, after 改成別的帳號: no 更新島民證明");
      check(field("account-threads").text === "", "step 4, after 改成別的帳號: the field is empty");
    }
    // An empty field goes nowhere: withdrawing is the other thing to do.
    press(say("common.next"));
    await waitText(say("accounts.need_one"), "step 4: the sentence for an empty field", 10_000);
    // 上一步: back to what the card declares; then again.
    press(say("common.back"));
    await waitText(say("accounts.refresh"), "step 4 again, after 上一步", 10_000);
    check(!textsOf(visible()).includes(inline), "step 4: 上一步 goes back to what the card declares");
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
  if (p.turnedAway) {
    away("POST /api/v1/challenges", 429, "rate_limited");
    away("POST /api/v1/records", 503, "busy");
  }
  press(p.confirm.button);
  await waitText(say("progress.title"), "step 5, in progress");
  if (p.turnedAway) await turnedAwayAtStepFive(say("progress.server"), "the challenge");
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
  if (p.turnedAway) await turnedAwayAtStepFive(say("progress.submit"), "the submission");

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
/** The button of step 6 that opens the profile: its short words, beside 複製證明連結. A screen reader reads done.open_profile, with the account. */
const OPEN = say("hang.open_threads", { platform: THREADS });
/** What only the whole step 6 has. */
const wholeHang = (_account: string): string[] => [
  say("hang.title_single", { platform: THREADS }),
  say("hang.copy"),
  OPEN,
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

/** Where IAMREAL_RECORD_SENSE says to keep a recording of step 2's demonstration, played once from its start to its rest (android/README.md). */
const RECORD_SENSE = process.env.IAMREAL_RECORD_SENSE;

/** Where IAMREAL_RECORD says to keep a recording of step 6's demonstration, played once from its start (android/README.md). */
const RECORD = process.env.IAMREAL_RECORD;

/**
 * The demonstration of step 6 (design/copy/card-proof.md, "示範"): to a screen reader one element with its one sentence; in its corner
 * small words, 停止播放 while it plays and 再看一次 otherwise. It plays by itself once it is on the screen; 停止播放 goes straight to its last frame.
 * Leaves it stopped, at its last frame. `record`: with IAMREAL_RECORD set, it is played once more from its start and recorded.
 */
async function demonstration(record: boolean): Promise<void> {
  const picture = find((n) => n.id === "hang-demo", "the demonstration of step 6");
  check(picture.description === say("app_demo.hang"), `step 6's demonstration reads as its one sentence of the copy ("${picture.description.slice(0, 20)}…")`);
  const [stop, replay] = [say("app_demo.stop"), say("app_demo.replay")];
  // On the screen it has started; a test that got here late finds it played out, and plays it again.
  field("hang-demo-button");
  const says = (label: string): boolean => textsOf(visible()).includes(label);
  if (says(replay)) {
    press(replay);
    await waitText(stop, "the demonstration playing again", 10_000);
  }
  check(says(stop) && !says(replay), "step 6: while the demonstration plays its button says 停止播放");
  press(stop);
  await waitText(replay, "the demonstration stopped", 10_000);
  check(says(replay) && !says(stop), "step 6: 停止播放 stops the demonstration, and its button says 再看一次");
  if (record && RECORD !== undefined) {
    // The emulator's own recording, from the host: the one inside it cannot read the screen (no hardware encoder).
    emulator.adb("emu", "screenrecord", "start", "--fps", "60", "--bit-rate", "12M", "--time-limit", "40", RECORD);
    await sleep(1_000);
    press(replay);
    await sleep(23_000);
    emulator.adb("emu", "screenrecord", "stop");
    await waitText(replay, "the demonstration played to its end", 10_000);
    check(true, `step 6: the demonstration played to its end by itself, recorded as ${RECORD}`);
  }
}

/**
 * Step 6 (design/copy/card-proof.md, "6. 掛上去", app). `short`: a card proof again, asked only whether the link is still there, then
 * 重新掛上連結 for the whole of it. `newCard`: the card's first record. `buttons`: presses what opens something outside the app.
 * Leaves the whole step 6 on the screen.
 */
async function hangStep(o: { name: string; shortId: string; account: string; date: string; short: boolean; newCard: boolean; buttons?: boolean; design?: string; record?: boolean }): Promise<void> {
  const link = `${SITE}/p/${o.shortId}`;
  const recorded = say("done.recorded_on", { date: o.date });
  if (o.short) {
    shot(`step-6-${o.name}-short`);
    await designShot("card-proof-app-6-hang-short-phone.png");
    const s = wholeScreen();
    shows(s, "step 6, the short one,", [step(6), recorded, say("hang.still_there_single", { platform: THREADS }), link, LOOK, WHY, say("hang.rehang"), say("common.next")]);
    {
      const now = visible();
      const rehang = now.find((n) => n.text === say("hang.rehang"));
      const next = now.find((n) => n.text === say("common.next"));
      check(rehang !== undefined && next !== undefined && Math.abs(rehang.y - next.y) < 40 && rehang.x < next.x, `step 6, the short one: 下一步 on the right, the way to the whole step on its left (${rehang?.x},${rehang?.y} and ${next?.x},${next?.y})`);
    }
    for (const a of [...wholeHang(o.account), say("hang.new_card"), say("common.back"), ...neverAfter(o.account)]) check(!s.includes(a), `step 6, the short one, does not say "${a.slice(0, 40)}"`);
    press(LOOK);
    await sleep(4_000);
    check(onTop().includes(`dat=http://${link}`), "step 6, the short one: 打開你的島民證明 opens the card's page in the browser");
    await backToApp(6);
    press(say("hang.rehang"));
    await waitText(say("hang.copy"), "the whole step 6, after 重新掛上連結", 10_000);
    // 上一步 goes back to the short one, and the way to the whole step is there again.
    press(say("common.back"));
    await waitText(say("hang.rehang"), "the short step 6 again, after 上一步", 10_000);
    check(!textsOf(visible()).includes(say("hang.copy")), "step 6: 上一步 of the whole step goes back to the short one");
    press(say("hang.rehang"));
    await waitText(say("hang.copy"), "the whole step 6, again", 10_000);
  }
  await demonstration(o.record === true);
  toTop();
  shot(`step-6-${o.name}`);
  if (o.design !== undefined) await designShot(o.design);
  const s = wholeScreen();
  shows(s, "step 6", [step(6), recorded, ...wholeHang(o.account), WHY, link, say("app_demo.replay"), say("common.next"), ...(o.newCard ? [say("hang.new_card")] : [])]);
  // The words drawn in the demonstration are not read: a screen reader gets its one sentence, and the four steps in words.
  check(!s.includes(say("app_demo_hang.found")) && !s.includes(say("app_demo_hang.row_bio")), "step 6: what is drawn in the demonstration is not read");
  {
    // The two buttons side by side, above the demonstration.
    // All three as one look at the screen has them, from the step's top: the picture starts under the buttons, and may go on below the screen.
    toTop();
    const now = visible();
    const copy = now.find((n) => n.text === say("hang.copy"));
    const open = now.find((n) => n.text === OPEN);
    const picture = now.find((n) => n.id === "hang-demo");
    if (check(copy !== undefined && open !== undefined && picture !== undefined, "step 6: the two buttons and the top of the demonstration are on the screen together")) {
      check(Math.abs(copy!.y - open!.y) < 40 && copy!.x < open!.x, `step 6: 複製證明連結 and 打開 Threads are side by side (${copy!.x},${copy!.y} and ${open!.x},${open!.y})`);
      check(copy!.bottom < picture!.top && open!.bottom < picture!.top, "step 6: the two buttons are above the demonstration");
      const told = say("done.open_profile", { account: o.account, platform: THREADS });
      check(open!.description === told, `step 6: 打開 Threads reads to a screen reader as "${told}" ("${open!.description}")`);
    }
  }
  check(!s.includes(app("settings.open")), "step 6 has no 設定 in its header");
  // 上一步 only where the whole step was reached from the short one: back to it.
  if (o.short) check(s.includes(say("common.back")), "step 6, reached from the short one, has 上一步");
  const absent = [...(o.short ? [] : [say("common.back")]), say("hang.rehang"), say("done.withdrawn_link"), say("done.share", { platform: THREADS }), say("app_done.reminder_title"), say("finish.done"), ...(o.newCard ? [] : [say("hang.new_card")]), ...neverAfter(o.account)];
  for (const a of absent) check(!s.includes(a), `step 6 does not say "${a.slice(0, 40)}"`);
  if (o.buttons) {
    press(say("hang.copy"));
    await waitText(say("done.copied"), "the button after the link was copied", 10_000);
    check(true, "step 6: 複製證明連結 turns into 已複製");
    press(OPEN);
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
  for (const a of [say("app_done.reminder_set"), say("app_reminder.skip")]) check(!s.includes(a), `step 7, the reminder on, does not say "${a.slice(0, 30)}"`);
  check(storedDay() === weeksAfter(date, 12), `the card proof set the reminder again, 12 weeks on: ${storedDay()}`);
}

/**
 * Step 8 (design/copy/card-proof.md, "8. 完成和分享", app): the title, the card in small, the card's ordinal and the invitation to share.
 * Returns the ordinal the screen wrote.
 */
async function finishStep(o: { name: string; shortId: string; account: string; title: string; design?: string; store?: string }): Promise<string> {
  await waitText(step(8), "step 8");
  shot(`step-8-${o.name}`);
  if (o.design !== undefined) await designShot(o.design);
  if (o.store !== undefined) await storeShot(o.store);
  const s = wholeScreen();
  const invited = new RegExp(`^${say("finish.ordinal", { ordinal: "([0-9,]+)" })}${say("finish.invite")}$`);
  const ordinal = s.map((t) => invited.exec(t)?.[1]).find((x) => x !== undefined) ?? "";
  check(ordinal !== "", `step 8 writes the card's ordinal before the invitation: 第 ${ordinal} 張`);
  shows(s, "step 8", [
    step(8), o.title, say("done.proof"), o.account, `${say("confirm.short_id_label")} ${say("confirm.short_id", { short_id: o.shortId })}`,
    say("done.share", { platform: THREADS }), say("common.back"), say("finish.done"),
  ]);
  check(visible().some((n) => n.description === say("app_done.share_other")), "step 8: beside 分享到 Threads, the share symbol, read as 用其他 app 分享");
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
  // The PIN is kept: the same tap again, with the card that was read.
  check(!textsOf(visible()).includes(say("pin.confirm_card")), "step 3, another card: the button is 再感應一次, not 確認卡片");
  press(say("app_read.tap_again"));
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

/** The app out of sight and back in front, where it was left. */
async function awayAndBack(): Promise<void> {
  emulator.shell("input keyevent KEYCODE_HOME");
  await sleep(1_500);
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  await sleep(1_000);
}

/** The emulator's clock alone, in seconds since 1970: the back end's is left as it is. */
const emulatorNow = (): number => Number(emulator.shell("date +%s").trim());

/**
 * What interrupts a card proof, before any record (issue #171; design/copy/card-proof.md, the app's stops of steps 2, 3 and 5): each
 * tap is made again alone, and the PIN is sent again only when the card took it once.
 */
async function interruptions(): Promise<void> {
  console.log("\na card that leaves, a wrong PIN, NFC turned off, the background, the 5 minutes, the app ended");
  const again = say("app_read.tap_again");
  await waitText(step(1), "step 1");
  press(say("common.next"));
  await waitText(step(2), "step 2");

  // Tap 1: the card leaves while it is read.
  press(say("app_read.tap_card"));
  await hold(leaving("reading"));
  await waitText(say("app_stops.read_dropped_android"), "step 2: Android's sentence for a card that left", 20_000);
  shows(wholeScreen(), "step 2, the card left,", [say("common.halted"), again]);
  press(again);
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end, at the tap made again", 120_000);
  press(say("common.next"));
  await waitText(step(3), "step 3");

  // A PIN the card does not take: gone, typed again.
  let handed = pinsHanded;
  emulator.tap(field("pin"));
  emulator.type(WRONG_PIN);
  press(say("pin.confirm_card"));
  await tap();
  await waitText(say("pin.pin_incorrect"), "step 3: the sentence for a wrong PIN", 20_000);
  check(field("pin").text === "" && pinsHanded === handed + 1, "step 3, a wrong PIN: the field is empty, the card was handed it once");
  check(!textsOf(visible()).includes(again), "step 3, a wrong PIN: no 再感應一次");

  // The card leaves while the PIN is on its way, and never took a PIN before: not sent again, typed again.
  handed = pinsHanded;
  emulator.tap(field("pin"));
  emulator.type(PIN);
  press(say("pin.confirm_card"));
  await hold(leaving("pin"));
  await waitText(say("app_stops.pin_maybe_received"), "step 3: the sentence for a PIN that may have reached the card", 20_000);
  await sleep(2_000);
  {
    const s = textsOf(visible());
    check(pinsHanded === handed + 1 && waitingTaps.length === 0, "step 3, the PIN on its way: handed once, and the app waits for no card by itself");
    check(field("pin").text === "" && !s.includes(again), "step 3, the PIN on its way: the field is empty, no 再感應一次");
  }
  press(say("pin.confirm_card"));
  await waitText(say("app_pin.need_pin"), "step 3: the sentence for an empty PIN, after the PIN was dropped", 10_000);
  check(waitingTaps.length === 0, "step 3, the PIN on its way: 確認卡片 without a PIN brings no tap");

  // The card took the PIN, then left: the PIN is kept, the tap is made again.
  emulator.tap(field("pin"));
  emulator.type(PIN);
  press(say("pin.confirm_card"));
  await hold(leaving("signing"));
  await waitText(say("app_stops.dropped_pin_kept"), "step 3: the sentence for a card that left after the PIN", 20_000);
  {
    const s = wholeScreen();
    shows(s, "step 3, the card left after the PIN,", [again, say("common.back")]);
    check(!s.includes(say("pin.confirm_card")), "step 3, the card left after the PIN: 再感應一次 in the place of 確認卡片");
  }
  // In the background and back within the 5 minutes: as it was left.
  await awayAndBack();
  await waitText(again, "step 3 again, after the background, with 再感應一次", 20_000);
  // 取消 on the panel of the tap made again: the PIN stays kept, 確認卡片 and an open field do not come back.
  press(again);
  await waitText(say("app_panel.android_wait_title"), "the panel of the tap made again");
  press(say("common.cancel"));
  for (let i = 0; i < 50 && waitingTaps.length > 0; i++) await sleep(100);
  await waitText(again, "step 3 again, after 取消 on the panel", 10_000);
  check(!textsOf(visible()).includes(say("pin.confirm_card")), "step 3, the PIN kept, 取消 on the panel: still 再感應一次, not 確認卡片");
  // NFC turned off since step 2: no PIN goes, the tap is made again.
  handed = pinsHanded;
  press(again);
  await hold(nfc("off"));
  await waitText(say("app_stops.nfc_off_tap"), "step 3: the sentence for NFC turned off", 20_000);
  press(again);
  await hold(otherCard);
  await waitText(say("app_stops.other_card"), "step 3: the sentence for another card, at the tap made again", 20_000);
  check(pinsHanded === handed, "step 3: with NFC off, and with another card, no PIN was handed over");
  // The card leaves while the PIN is on its way again; it took this PIN before, so the PIN is kept.
  press(again);
  await hold(leaving("pin"));
  await waitText(say("app_stops.dropped_pin_kept"), "step 3: a PIN the card took before is kept when the card leaves as it is sent", 20_000);
  check(textsOf(visible()).includes(again), "step 3: 再感應一次 again");
  press(again);
  await tap();
  await waitText(step(4), "step 4, with the PIN typed once since it was last dropped", 120_000);
  check(pinsHanded === handed + 2, "step 3: the PIN in memory was handed to the card at each tap made again");

  // Tap 3.
  emulator.tap(field("account-threads"));
  emulator.type("alice");
  hideKeyboard();
  press(say("common.next"));
  await waitText(say("confirm.title"), "step 5");
  press(say("confirm.button_declare_single"));
  await waitText(say("progress.title"), "step 5, in progress");
  await hold(leaving("signing"));
  await waitText(say("app_stops.dropped"), "step 5: the sentence for a card that left", 20_000);
  shows(wholeScreen(), "step 5, the card left,", [step(5), say("common.halted"), again, say("common.cancel")]);
  handed = pinsHanded;
  press(again);
  await hold(otherCard);
  await waitText(say("app_stops.other_card_declare"), "step 5: the sentence for another card", 20_000);
  press(again);
  await hold(nfc("off"));
  await waitText(say("app_stops.nfc_off_tap"), "step 5: the sentence for NFC turned off", 20_000);
  check(pinsHanded === handed, "step 5: with another card, and with NFC off, no PIN was handed over");
  press(again);
  await hold(leaving("pin"));
  await waitText(say("app_stops.dropped"), "step 5: the card leaving as the PIN is sent is a card that left", 20_000);
  {
    const s = wholeScreen();
    check(s.includes(again) && !s.includes(say("accounts.restart")), "step 5, the card left as the PIN was sent: 再感應一次, the PIN is kept");
  }

  // More than 5 minutes since the second tap: the PIN is dropped, back to step 1, which says why.
  const before = emulatorNow();
  const started = Date.now();
  emulator.shell(`date @${before + 6 * 60}`);
  await awayAndBack();
  await waitText(say("app_before.idle"), "step 1 with the sentence of the 5 minutes", 20_000);
  {
    const nodes = visible();
    const top = (text: string): number => nodes.find((n) => n.text === text)?.top ?? Number.NaN;
    check(top(say("app_before.idle")) < top(step(1)), "step 1, after the 5 minutes: the sentence is above everything of the step");
  }
  shot("step-1-idle");
  emulator.shell(`date @${before + Math.round((Date.now() - started) / 1000)}`);
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end", 120_000);
  press(say("common.next"));
  await waitText(step(3), "step 3");
  check(field("pin").text === "", "after the 5 minutes: the PIN is typed again");
  // The 5 minutes count from the PIN's first character: a PIN left in the field that long is not handed to a card.
  emulator.tap(field("pin"));
  emulator.type(PIN);
  {
    const at = emulatorNow();
    const since = Date.now();
    handed = pinsHanded;
    emulator.shell(`date @${at + 6 * 60}`);
    press(say("pin.confirm_card"));
    await waitText(say("app_before.idle"), "step 1 with the sentence of the 5 minutes, from a PIN left in the field", 20_000);
    check(waitingTaps.length === 0 && pinsHanded === handed, "a PIN left in the field for 5 minutes: 確認卡片 waits for no card, no PIN handed over");
    emulator.shell(`date @${at + Math.round((Date.now() - since) / 1000)}`);
  }
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end", 120_000);
  press(say("common.next"));
  await waitText(step(3), "step 3");
  emulator.tap(field("pin"));
  emulator.type(PIN);
  press(say("pin.confirm_card"));
  await tap();
  await waitText(step(4), "step 4", 120_000);

  // In the background and back within the 5 minutes of the PIN: step 4 as it was left, and the last tap is made with the PIN in memory.
  await awayAndBack();
  await waitText(step(4), "step 4 again, after the background", 20_000);
  check(!textsOf(visible()).includes(say("app_before.idle")), "step 4, back within the 5 minutes: nothing dropped");
  emulator.tap(field("account-threads"));
  emulator.type("alice");
  hideKeyboard();
  press(say("common.next"));
  await waitText(say("confirm.title"), "step 5");
  // The last tap, with a card that does not take this PIN (its PIN was changed since the second tap): the card proof is over.
  handed = pinsHanded;
  press(say("confirm.button_declare_single"));
  await waitText(say("progress.title"), "step 5, in progress");
  await hold(JSON.stringify({ certificates: backend.certificates, key, pin: WRONG_PIN, pause_ms: 0 }));
  await waitText(say("pin.pin_incorrect"), "step 5: the sentence for a PIN the card refuses", 20_000);
  {
    const s = wholeScreen();
    check(pinsHanded === handed + 1, "step 5, back from the background: the PIN in memory was handed to the card");
    check(s.includes(say("accounts.restart")) && !s.includes(again), "step 5, a PIN the card refuses: only 回到開頭");
  }
  press(say("accounts.restart"));
  await waitText(step(1), "step 1 again, after 回到開頭", 20_000);
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end", 120_000);
  press(say("common.next"));
  await waitText(step(3), "step 3");
  emulator.tap(field("pin"));
  emulator.type(PIN);
  press(say("pin.confirm_card"));
  await tap();
  await waitText(step(4), "step 4", 120_000);

  // The app ended by the system, with a PIN in memory: from step 1, with nothing said.
  emulator.shell(`am force-stop ${APP}`);
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  await waitText(step(1), "step 1, after the app was ended", 20_000);
  check(!textsOf(visible()).includes(say("app_before.idle")), "the app ended and opened again: step 1, without the sentence of the 5 minutes");
  check(waitingTaps.length === 0, "the app ended and opened again: it waits for no card");
  taps = 0;
}

/** Android's store, as the copy's {store} (design/copy/card-proof.md). */
const STORE = "Google Play";
const STORE_PAGE = "dat=https://play.google.com/store/apps/details?id=tw.iamreal.app";

/**
 * The minimum app version and a phone without NFC (issue #171; ADR-0035; design/copy/card-proof.md, "1. 開始之前", app). The fake
 * build is build 2,000,000, as the development build (app/build.gradle.kts, buildNumbers); the test writes the `min_app` the app
 * is given, one above it.
 */
async function oldVersionAndNoNfc(): Promise<void> {
  console.log("\nthe minimum app version, a config that cannot be read or does not come, a phone without NFC");
  const bound = (from: string): { value: unknown } => ({ value: { android: { build: 2_000_001, from }, ios: { build: 1, from: today } } });
  const soon = say("app_before.update_soon", { min_app_from: tomorrow, store: STORE });
  const update = say("app_before.update", { store: STORE });
  const domain = `127.0.0.1:${DEVICE_PORT}`;
  await waitText(step(1), "step 1");
  check(!textsOf(visible()).includes(update), "step 1, a build the config takes: nothing about updating");

  // Older than the minimum, before its start date: said above step 1, and the card proof goes on.
  minApp = bound(tomorrow);
  await awayAndBack();
  await waitText(soon, "step 1 with the sentence of the minimum version", 20_000);
  {
    const nodes = visible();
    const top = (text: string): number => nodes.find((n) => n.text === text)?.top ?? Number.NaN;
    check(top(soon) < top(step(1)), "step 1, before the start date: the sentence is above everything of the step");
    shows(wholeScreen(), "step 1, before the start date,", [soon, update, step(1), say("before.title"), say("common.next")]);
  }
  shot("step-1-update-soon");
  press(update);
  await sleep(2_000);
  check(onTop().includes(STORE_PAGE), "step 1, before the start date: the button opens the app's page of Google Play outside the app");
  await backToApp(1);

  // The start date comes with step 1 on the screen: the tap of step 2 is not made, and step 1 is replaced.
  const before = emulatorNow();
  const started = Date.now();
  emulator.shell(`date @${Math.floor(Date.parse(`${tomorrow}T00:00:30+08:00`) / 1000)}`);
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await waitText(say("app_before.too_old_title"), "the screen in place of step 1, from step 2", 20_000);
  check(waitingTaps.length === 0, "from the start date: step 2 stops before it waits for a card");
  emulator.shell(`date @${before + Math.round((Date.now() - started) / 1000)}`);
  await awayAndBack();
  await waitText(soon, "step 1 again, the clock back before the start date", 20_000);

  // The start date comes after the card was read: step 3 asks no card for the PIN.
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end, before the start date", 120_000);
  press(say("common.next"));
  await waitText(step(3), "step 3");
  {
    const at = emulatorNow();
    const since = Date.now();
    const handedBefore = pinsHanded;
    // Before the PIN is typed: its own 5 minutes are not what stops this tap.
    emulator.shell(`date @${Math.floor(Date.parse(`${tomorrow}T00:00:30+08:00`) / 1000)}`);
    emulator.tap(field("pin"));
    emulator.type(PIN);
    press(say("pin.confirm_card"));
    await waitText(say("app_before.too_old_title"), "the screen in place of step 1, from step 3", 20_000);
    check(waitingTaps.length === 0 && pinsHanded === handedBefore, "from the start date: step 3 stops before it waits for a card, no PIN handed over");
    emulator.shell(`date @${at + Math.round((Date.now() - since) / 1000)}`);
  }
  await awayAndBack();
  await waitText(soon, "step 1 again, the clock back before the start date", 20_000);

  // From the start date on: step 1 is replaced, nothing of a card proof can be reached.
  minApp = bound(today);
  await awayAndBack();
  await waitText(say("app_before.too_old_title"), "the screen in place of step 1", 20_000);
  {
    const s = wholeScreen();
    shows(s, "an old version", [say("app_before.too_old", { min_app_from: today }), say("app_before.nothing_sent"), update, say("app_before.or_reader", { domain })]);
    check(![step(1), say("before.title"), say("common.next"), say("app_read.tap_card")].some((x) => s.includes(x)), "an old version: no step, no 下一步");
  }
  shot("step-1-too-old");
  press(update);
  await sleep(2_000);
  check(onTop().includes(STORE_PAGE), "an old version: the button opens the app's page of Google Play outside the app");
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  await waitText(say("app_before.too_old_title"), "the app again, still replaced", 20_000);

  // A minimum version the app cannot read: step 1 as usual, and step 2 stops before the card, as for any config it cannot read.
  minApp = { value: "2" };
  await awayAndBack();
  await waitText(step(1), "step 1, with a minimum version that cannot be read", 20_000);
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await waitText(say("stops.server_unreadable", { code: "malformed_response" }), "step 2: the sentence for a config that cannot be read", 20_000);
  check(waitingTaps.length === 0, "a minimum version that cannot be read: step 2 stops before it waits for a card");
  // A config that does not come.
  minApp = "unanswered";
  press(say("app_read.restart"));
  await waitText(say("stops.server_unreadable", { code: "network" }), "step 2: the sentence for a server that does not answer", 40_000);
  check(waitingTaps.length === 0, "a config that does not come: step 2 stops before it waits for a card");
  // The back end's own again: the card is read.
  minApp = undefined;
  press(say("app_read.restart"));
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end, with the back end's own config", 120_000);
  press(say("common.back"));
  await waitText(step(1), "step 1");

  // A phone whose NFC is not there when the card is asked for: step 1 is replaced.
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await hold(nfc("none"));
  await waitText(say("app_before.no_nfc_title"), "the screen in place of step 1, from step 2", 20_000);
  // The app sends its counts one after the other, off the card proof's way: its stop is let arrive before the app is ended below.
  for (let i = 0; i < 100 && !countsSent.some((c) => c.event === "stop" && c.reason === "no_nfc"); i++) await sleep(100);
  // A phone without NFC, as the app opens.
  phoneHasNfc = false;
  emulator.shell(`am force-stop ${APP}`);
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  await waitText(say("app_before.no_nfc_title"), "the screen in place of step 1, as the app opens", 20_000);
  {
    const s = wholeScreen();
    shows(s, "a phone without NFC", [say("app_before.no_nfc"), say("app_before.no_nfc_reader", { domain })]);
    check(![step(1), say("before.title"), say("common.next"), say("app_read.tap_card")].some((x) => s.includes(x)), "a phone without NFC: no step, no 下一步");
  }
  shot("step-1-no-nfc");
  // The site's name is the link to it: the one way left.
  emulator.tap(find((n) => n.id === "open-site", "the site's name"));
  await sleep(2_000);
  check(onTop().includes(`dat=http://${SITE}`), "a phone without NFC: the site's name opens the site in the browser");
  phoneHasNfc = true;
  emulator.shell(`am force-stop ${APP}`);
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  await waitText(step(1), "step 1, on a phone with NFC", 20_000);
  taps = 0;
}

// 5. The reminder ---------------------------------------------------------------------

/** Where the app keeps the reminder (src/main/…/reminder/Phone.kt), and what is in it. */
const REMINDER_FILE = `/data/data/${APP}/shared_prefs/reminder.xml`;

/** The members a count of the app may have (spec/counts.md, "A count"). */
const APP_COUNT_MEMBERS = new Set(["client", "event", "step", "reason", "action", "tap", "took", "device_id", "attempt_id", "os_version", "app_version", "model"]);
/** The steps every card proof that is done reaches, each once (spec/counts.md, "Steps": the app's). */
const APP_STEPS = ["open", "read", "config", "certificates", "certificate", "crl", "tree", "circuit", "engine", "pin", "checked", "scope_signed", "state", "chosen", "confirmed", "challenge", "code_signed", "proved", "done"];

/** What the counts the app sent say (8.): what is in them, every step of each card proof that was done, and the interruptions. */
function countsChecked(shortId: string): void {
  check(countsSent.length > 0, `the app sent counts: ${countsSent.length}`);
  const text = (c: Record<string, unknown>): string => JSON.stringify(c);
  for (const c of countsSent) {
    const extra = Object.keys(c).filter((k) => !APP_COUNT_MEMBERS.has(k));
    if (!check(c.client === "android" && extra.length === 0 && Object.values(c).every((v) => typeof v === "string"), `a count is the Android app's, with the members of the table only: ${text(c)}`)) return;
  }
  // Nothing of the card, the accounts, the scoped ID or the PIN.
  const all = JSON.stringify(countsSent);
  for (const never of ["alice", "bob", shortId, PIN, NAME, ...backend.certificates.map((c) => c.slice(0, 16))]) check(!all.includes(never), `no count holds "${never}"`);
  // The phone's system as it gives it: the emulator's Android 10; the fake build's version, `dev`, is no version and is left out.
  check(countsSent.every((c) => c.os_version === "10" && c.app_version === undefined && typeof c.model === "string" && /^[A-Za-z0-9 \-_.,()+]{1,32}$/.test(c.model)), `every count carries Android's version, 10, and the emulator's model, and no app version: ${text(countsSent[0]!)}`);
  // Each attempt's counts: one device ID for all of them.
  const attempts = new Map<string, Record<string, unknown>[]>();
  for (const c of countsSent) attempts.set(c.attempt_id as string, [...(attempts.get(c.attempt_id as string) ?? []), c]);
  for (const [id, cs] of attempts) check(new Set(cs.map((c) => c.device_id)).size === 1 && /^[0-9a-f]{32}$/.test(id), `an attempt's counts carry one device ID (${id})`);
  // Each card proof that was done: every step once, and the three timed steps.
  const done = [...attempts.values()].filter((cs) => cs.some((c) => c.event === "step" && c.step === "done"));
  check(done.length === 4, `the card proofs that were done sent their step done: ${done.length}`);
  for (const cs of done) {
    const steps = cs.filter((c) => c.event === "step").map((c) => c.step as string);
    // `open` is step 1's: a card proof begun again while step 1 stayed (turned away at its start, 8.) has none of its own.
    const expected = steps[0] === "open" ? APP_STEPS : APP_STEPS.filter((s) => s !== "open");
    check(JSON.stringify([...steps].sort()) === JSON.stringify([...expected].sort()) && steps.at(-1) === "done", `a card proof that was done sent each step once, from open or read to done: ${steps.join(",")}`);
    const timed = cs.filter((c) => c.event === "duration").map((c) => c.step as string).sort();
    check(JSON.stringify(timed) === JSON.stringify(["crl", "proved", "tree"]), `and how long the CRL, the tree and the proof took: ${timed.join(",")}`);
    check(!cs.some((c) => c.event === "stop"), "and no stop");
  }
  // The interruptions of 6. and the stops of 7., by their codes; a card that left as an action, with its tap.
  const said = new Set(countsSent.map((c) => (c.event === "action" ? `action:${c.action}:${c.tap}` : c.event === "stop" || c.event === "retry" ? `${c.event}:${c.reason}` : "")));
  for (const expected of ["retry:other_card", "retry:pin_incorrect", "retry:channel", "stop:channel", "stop:idle", "stop:app_too_old", "stop:no_nfc", "stop:server_paused", "action:tap_dropped:1", "action:tap_dropped:2", "action:tap_dropped:3"]) {
    check(said.has(expected), `the counts say ${expected}`);
  }
  // Every submission carried the card proof device ID of the counts.
  const ids = new Set(countsSent.map((c) => c.device_id));
  check(submittedDeviceIds.length >= 4 && submittedDeviceIds.every((id) => id !== null && ids.has(id)), `every submission carried the card proof device ID the counts carry: ${JSON.stringify(submittedDeviceIds)}`);
}
const reminderStored = (): string => emulator.shell(`cat ${REMINDER_FILE} 2>/dev/null; true`);
const storedDay = (): string | undefined => /<string name="day">([0-9-]+)<\/string>/.exec(reminderStored())?.[1];

/**
 * Step 7 of the first card proof, which offers the reminder (design/copy/card-proof.md, "7. 提醒"): 這次不要 stores nothing and goes on;
 * back from step 8, 設定提醒 opens the screen of its interval and time, left without saving; 設定提醒 again and 開啟提醒 there sets
 * the defaults and comes back to step 7, which shows the reminder that is on and waits for 下一步. Leaves step 7 on the screen, the
 * reminder on.
 */
async function reminderOffered(shortId: string): Promise<void> {
  console.log("\nstep 7: the reminder, offered");
  await waitText(step(7), "step 7");
  {
    shot("step-7-first");
    await designShot("card-proof-app-7-reminder-phone.png");
    const s = wholeScreen();
    shows(s, "step 7", [step(7), ...reminderSays(today), say("app_done.reminder_set"), say("common.back"), say("app_reminder.skip")]);
    for (const a of [say("common.next"), say("app_reminder.adjust"), say("hang.copy"), say("finish.done")]) check(!s.includes(a), `step 7 does not say "${a.slice(0, 30)}"`);
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
  await waitText(say("app_done.reminder_set"), "step 7 again, from step 8", 10_000);
  check(textsOf(visible()).includes(step(7)), "step 8: 上一步 goes back to step 7");
  press(say("app_done.reminder_set"));
  await waitText(app("reminder.from_today"), "the screen of the interval and the time");
  check(!/<string/.test(reminderStored()), "設定提醒 stores nothing of the reminder: the screen of the interval and the time does, on 開啟提醒");
  const next = (weeks: number): string => app("reminder.next", { day: dayText(weeksAfter(today, weeks)), time: NINE });
  {
    shot("reminder-schedule");
    await designShot("app-reminder-2-schedule-phone.png");
    const s = wholeScreen();
    shows(s, "the screen of the interval and the time", [
      app("reminder.title"), app("reminder.from_today"), app("reminder.how_often"), app("reminder.weeks_4"), app("reminder.weeks_12"), app("reminder.suggested"),
      app("reminder.weeks_26"), app("reminder.pick_date"), app("reminder.when"), app("reminder.time"), NINE, app("reminder.change"), next(12),
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
  await waitText(say("app_done.reminder_set"), "step 7 again, from the screen of the interval and the time", 10_000);
  check(!/<string/.test(reminderStored()), "the screen of the interval and the time, left with 取消, stores nothing");
  // 設定提醒, then 開啟提醒 there as it opens: the defaults (this Android asks nothing before it lets an app notify), and back to
  // step 7, which waits for 下一步.
  press(say("app_done.reminder_set"));
  await waitText(app("reminder.from_today"), "the screen of the interval and the time, again");
  press(app("reminder.turn_on"));
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
      app("settings.next"), dayText(weeksAfter(today, 12)), app("settings.about"), app("settings.version"), app("settings.faq"),
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
  await interruptions();
  await oldVersionAndNoNfc();
  // Card proofs stopped and taken again (#394, #402): the first declaration below is the card proof that goes through after.
  await stoppedTakingCardProofs();

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
  await hangStep({ name: "first", shortId, account: HANDLE.alice, date: today, short: false, newCard: true, buttons: true, design: "card-proof-app-6-hang-phone.png", record: true });
  press(say("common.next"));
  await reminderOffered(shortId);
  press(say("common.next"));
  const ordinal = await finishStep({ name: "first", shortId, account: HANDLE.alice, title: say("finish.first"), design: "card-proof-app-8-done-phone.png", store: "phone-4-done.png" });
  await settingsFromLastStep();
  const page = await fetch(`${backend.origin}/p/${shortId}`);
  const html = await page.text();
  check(page.status === 200 && html.includes("@alice"), `the Worker's page of the card, /p/${shortId}, lists @alice`);
  // The card's ordinal as its page writes it: the proof log's, which the answer to the submission gave the app.
  check(/<p class="ordinal">第 ([0-9,]+) 張島民證明<\/p>/.exec(html)?.[1] === ordinal, `the card's page writes the same ordinal, 第 ${ordinal} 張`);
  // Threads's composer, the sentence and, on the line under it, the address of the card's page filled in: its web intent, opened
  // outside the app (the emulator has no Threads, so the browser).
  const text = `${say("done.share_text", { ordinal })}\nhttp://${SITE}/p/${shortId}`;
  press(say("done.share", { platform: THREADS }));
  await sleep(2_000);
  check(onTop().includes(`dat=https://www.threads.com/intent/post?text=${encodeURIComponent(text)}`), "step 8: 分享到 Threads opens Threads's composer with the text filled in");
  await backToApp(8);
  // The share symbol: the system's share sheet, with the same text (Android 10 shows the text it is given at its top).
  emulator.tap(find((n) => n.description === say("app_done.share_other"), "the share symbol"));
  const shared = await waitText(text, "the share sheet with the sentence and the card's address", 20_000);
  check(/act=android\.intent\.action\.CHOOSER/.test(emulator.shell("dumpsys activity activities")), "step 8: the share symbol opens the system's share sheet");
  check(textsOf(visible()).filter((t) => t.includes(SITE)).length === 1 && shared.text === text, "step 8: what is shared is the sentence with the card's ordinal and the card's address");
  emulator.shell("input keyevent KEYCODE_BACK");
  await backToApp(8);
  // 完成: step 1.
  press(say("finish.done"));
  await waitText(step(1), "step 1 again, after 完成", 10_000);
  check(true, "step 8: 完成 goes back to step 1");

  // A card proof again, the same day: 更新島民證明, nothing typed.
  const again = await cardProof({
    what: "a card proof again: 更新島民證明; another card at the last tap first; too many people on the way",
    name: "again",
    thorough: false,
    otherCardAtLastTap: true,
    turnedAway: true,
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
  // The first request for this card proof's challenge, the reading's (#553), gets no answer: the app asks once more by itself, and the card proof goes on (#404).
  const challengesBefore = challengesAsked;
  dropNextChallenge = true;
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
  check(!dropNextChallenge && challengesAsked - challengesBefore === 2, `step 2: the challenge that got no answer was asked for once more, and the card proof went on (${challengesAsked - challengesBefore} requests)`);
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

  countsChecked(shortId);

  // What the app left on the emulator: the highest CRL number it used and the card proof device ID, and nothing else; the reminder's file,
  // turned off, is empty. No PIN, no file of a card proof.
  const stored = emulator.shell(`find /data/data/${APP} -type f`).split("\n").map((l) => l.trim()).filter(Boolean).filter((f) => f !== REMINDER_FILE).sort();
  check(JSON.stringify(stored) === JSON.stringify([`/data/data/${APP}/shared_prefs/card_proof_device_id.xml`, `/data/data/${APP}/shared_prefs/highest_crl_number.xml`]), `the app's storage holds the CRL numbers it used and the card proof device ID, and nothing else: ${JSON.stringify(stored)}`);
  const kept = emulator.shell(`cat /data/data/${APP}/shared_prefs/card_proof_device_id.xml`);
  const keptIds = [...kept.matchAll(/>([0-9a-f]{32})\.(\d{4}-\d{2}-\d{2})</g)];
  check(keptIds.length === 1 && (kept.match(/[0-9a-f]{32}/g) ?? []).length === 1, `the card proof device ID is kept once, with the date it was made on, and no other: ${kept.replace(/\s+/g, " ")}`);
  check(!/<string|<int|<long|<boolean/.test(reminderStored()), `the reminder's file, turned off, holds nothing: ${reminderStored()}`);
  check(emulator.shell(`grep -r -l ${PIN} /data/data/${APP} /sdcard 2>/dev/null; true`).trim() === "", "the PIN is in no file of the app's or of the shared storage");
} catch (e) {
  check(false, e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  // The emulator as it was: its own clock, network, density and keyboard setting, the port no longer forwarded, adb not root.
  try {
    emulator.shell(`date @${Math.floor(Date.now() / 1000)}; settings put global auto_time 1; svc wifi enable; svc data enable`);
    emulator.shell(`wm size reset; wm density reset; am force-stop ${APP}`);
    demoStatusBar(false);
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

// 7. Card proofs stopped ---------------------------------------------------------------
// (Called in section 4, before the first declaration.)

/** The maintainer stops taking card proofs, or takes them again: the back end's setting (app-backend.ts, PUT /__app-test/paused). */
async function setPaused(paused: boolean): Promise<void> {
  const res = await fetch(`${backend.origin}/__app-test/paused`, { method: "PUT", body: String(paused) });
  if (res.status !== 204) throw new Error(`stopping or taking card proofs: HTTP ${res.status}`);
}

/** The app in front again (MainActivity.onResume): step 1 asks the server's config again. */
function bringBack(): void {
  emulator.shell("input keyevent KEYCODE_HOME");
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
}

/** Step 1 as it is while card proofs are stopped: its sentence in place of 下一步 (design/copy/card-proof.md, step 1). */
async function stepOneStopped(where: string): Promise<void> {
  await waitText(say("before.paused"), `${where}: step 1's sentence for card proofs stopped`, 20_000);
  const s = wholeScreen();
  shows(s, `${where}, step 1,`, [step(1), say("before.title"), say("before.paused"), say("before.why_physical")]);
  check(!s.includes(say("common.next")), `${where}: step 1 has no 下一步`);
}

/** From step 1 to step 5's button, the card read and the PIN handed over, @alice typed into the empty field. */
async function toDeclare(): Promise<void> {
  await waitText(say("common.next"), "step 1's 下一步", 20_000);
  press(say("common.next"));
  await waitText(step(2), "step 2");
  press(say("app_read.tap_card"));
  await tap();
  await waitText(say("app_read.lift"), "step 2's list to end", 120_000);
  press(say("common.next"));
  await waitText(step(3), "step 3");
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
}

/** Step 5 stopped at `item` with the server's paused: its sentence and request ID, and only 回到開頭; then back to step 1, which says so. */
async function stepFiveStopped(item: string, where: string): Promise<void> {
  await waitText(say("stops.paused"), `${where}: stops.paused`, 120_000);
  const s = wholeScreen();
  shows(s, `${where}, step 5,`, [step(5), item, say("common.halted"), say("stops.paused"), say("accounts.restart")]);
  // Stopped at that item: 停在這裡 after its label, the sentence after it.
  const halted = s.indexOf(say("common.halted"));
  check(halted > 0 && s[halted - 1] === item && s[halted + 1] === say("stops.paused"), `${where}: stopped at "${item}" with stops.paused (${JSON.stringify(s.slice(Math.max(0, halted - 1), halted + 2))})`);
  check(s.some((t) => new RegExp(`^${say("stops.request_id", { request_id: "[0-9A-Za-z-]+" })}$`).test(t)), `${where}: the request ID under the sentence`);
  for (const a of [say("progress.retry"), say("app_read.tap_again"), say("app_read.restart"), say("common.cancel"), say("stops.submit_failed")]) check(!s.includes(a), `${where}: step 5 does not offer or say "${a}"`);
  shot(`paused-5-${where.replaceAll(" ", "-")}`);
  press(say("accounts.restart"));
  await stepOneStopped(`${where}, 回到開頭`);
}

async function stoppedTakingCardProofs(): Promise<void> {
  console.log("\ncard proofs stopped by the maintainer, and taken again");
  // The app opened while card proofs are stopped.
  await setPaused(true);
  emulator.shell(`am force-stop ${APP}`);
  emulator.shell(`am start -n ${APP}/tw.iamreal.app.MainActivity`);
  await stepOneStopped("opened while card proofs are stopped");
  shot("paused-1-before");
  await designShot("card-proof-app-1-paused-phone.png");

  // Taken again while the app was away: step 1 asks again as it comes back.
  await setPaused(false);
  bringBack();
  await waitText(say("common.next"), "step 1's 下一步, card proofs taken again", 20_000);
  check(!textsOf(visible()).includes(say("before.paused")), "card proofs taken again: step 1 no longer says they are stopped");

  // Stopped after step 1: challenges answers paused. The card has signed nothing. The challenge the reading asks for (#553) is
  // turned away, so that step 5 asks for its own.
  away("POST /api/v1/challenges", 503, "busy");
  await toDeclare();
  check((turnAway.get("POST /api/v1/challenges") ?? []).length === 0, "a challenge was asked for by step 4 (the reading's), and was turned away");
  await setPaused(true);
  const handed = pinsHanded;
  press(say("confirm.button_declare_single"));
  await stepFiveStopped(say("progress.server"), "challenges paused");
  check(pinsHanded === handed, "challenges paused: the card was not handed the PIN at the last tap");

  // Stopped once the challenge was issued: records answers paused, after the card signed and the proof was computed.
  await setPaused(false);
  bringBack();
  await toDeclare();
  press(say("confirm.button_declare_single"));
  await waitText(say("progress.title"), "step 5, in progress");
  // The app waits for the card once it has the challenge.
  for (let i = 0; i < 300 && waitingTaps.length === 0; i++) await sleep(100);
  check(waitingTaps.length > 0, "records paused: the app got the challenge and waits for the card");
  await setPaused(true);
  await tap();
  await stepFiveStopped(say("progress.submit"), "records paused");

  // Taken again: the first declaration below goes through.
  await setPaused(false);
  bringBack();
  await waitText(say("common.next"), "step 1's 下一步, card proofs taken again", 20_000);
  taps = 0;
}

// 8. Too many people ---------------------------------------------------------------
// (Called from cardProof, for the card proof again.)

/** Step 1: the config without the mark turned away goes unnoticed; the start turned away keeps step 1, and says so above 下一步. */
async function turnedAwayAtStart(): Promise<void> {
  console.log("too many people: step 1");
  // The config step 1 asks as the app comes back, turned away: step 1 is as it was (docs/api/card-proof.md, `config`).
  const plain = asked.get("GET /api/v1/config") ?? 0;
  away("GET /api/v1/config", 429, "rate_limited");
  bringBack();
  for (let i = 0; i < 100 && (asked.get("GET /api/v1/config") ?? 0) === plain; i++) await sleep(100);
  await waitText(say("common.next"), "step 1's 下一步, its config turned away", 20_000);
  check((turnAway.get("GET /api/v1/config") ?? []).length === 0, "step 1 asked its config as the app came back, and it was turned away");
  for (const a of [say("before.busy"), say("before.paused")]) check(!textsOf(visible()).includes(a), `step 1's config turned away: step 1 does not say "${a}"`);

  for (const [status, code] of [[503, "busy"], [429, "rate_limited"]] as const) {
    const starts = asked.get("GET /api/v1/config?start") ?? 0;
    const tapsBefore = taps;
    away("GET /api/v1/config?start", status, code);
    press(say("common.next"));
    await waitText(say("before.busy"), `step 1: too many people (${status})`, 20_000);
    const s = wholeScreen();
    shows(s, `step 1, the start turned away (${status}),`, [step(1), say("before.title"), say("before.busy"), say("common.next")]);
    check(s.indexOf(say("before.busy")) === s.indexOf(say("common.next")) - 1, `step 1, ${status}: the sentence is right above 下一步`);
    check((asked.get("GET /api/v1/config?start") ?? 0) === starts + 1, `step 1, ${status}: 下一步 asked config with the mark of a start, once`);
    await sleep(1_000);
    check(waitingTaps.length === 0 && taps === tapsBefore && !textsOf(visible()).includes(step(2)), `step 1, ${status}: still step 1, and the app does not wait for a card`);
    if (status === 503) {
      shot("busy-1-before");
      await designShot("card-proof-app-1-busy-phone.png");
    }
  }
  // The start goes through below; the config the reading asks again, without the mark, is turned away: the card proof goes on.
  away("GET /api/v1/config", 429, "rate_limited");
}

/** Step 3: the card signed, its state turned away; 再試一次 asks again, the card not held to the phone again, and on to step 4. */
async function turnedAwayAtCardState(): Promise<void> {
  console.log("too many people: step 3");
  check((turnAway.get("GET /api/v1/config") ?? []).length === 0, "step 2: the reading's config was turned away, and the card was read all the same");
  await waitText(say("stops.too_many"), "step 3: the card's state turned away", 60_000);
  const s = wholeScreen();
  shows(s, "step 3, the card's state turned away,", [step(3), say("stops.too_many"), say("progress.retry"), say("common.back")]);
  check(!s.includes(say("pin.confirm_card")) && !s.includes(say("app_read.tap_again")), "step 3, the card's state turned away: 再試一次 in place of 確認卡片, and no tap offered");
  check(field("pin").text === "", "step 3, the card's state turned away: the PIN's field is empty");
  shot("busy-3-pin");
  await designShot("card-proof-app-3-busy-phone.png");
  const [tapsBefore, handed, states] = [taps, pinsHanded, asked.get("POST /api/v1/card-state") ?? 0];
  press(say("progress.retry"));
  await waitText(step(4), "step 4, after 再試一次", 60_000);
  check(taps === tapsBefore && pinsHanded === handed && waitingTaps.length === 0, "step 3, 再試一次: the card was not held to the phone again, nor handed the PIN");
  check((asked.get("POST /api/v1/card-state") ?? 0) === states + 1, "step 3, 再試一次: the card's state asked once more");
}

/** Step 5 stopped at `item` (`what` turned away): stops.too_many, 再試一次 and 取消; 再試一次 sends it again, and the card proof goes on. */
async function turnedAwayAtStepFive(item: string, what: string): Promise<void> {
  console.log(`too many people: step 5, ${what}`);
  await waitText(say("stops.too_many"), `step 5: ${what} turned away`, 300_000);
  const s = wholeScreen();
  shows(s, `step 5, ${what} turned away,`, [step(5), item, say("common.halted"), say("stops.too_many"), say("progress.retry"), say("common.cancel")]);
  const halted = s.indexOf(say("common.halted"));
  check(halted > 0 && s[halted - 1] === item && s[halted + 1] === say("stops.too_many"), `step 5, ${what} turned away: stopped at "${item}" (${JSON.stringify(s.slice(Math.max(0, halted - 1), halted + 2))})`);
  for (const a of [say("app_read.tap_again"), say("accounts.restart"), say("stops.submit_failed")]) check(!s.includes(a), `step 5, ${what} turned away: does not offer or say "${a}"`);
  shot(`busy-5-${what.replaceAll(" ", "-")}`);
  if (what === "the challenge") await designShot("card-proof-app-5-busy-phone.png");
  const [tapsBefore, handed] = [taps, pinsHanded];
  press(say("progress.retry"));
  if (what === "the challenge") {
    // The challenge asked for again; the card has signed nothing yet, and the last tap comes now.
    await waitText(say("app_panel.android_wait_title"), "step 5, 再試一次: the panel of the last tap", 60_000);
    check(pinsHanded === handed, "step 5, the challenge turned away: the card was not handed the PIN before 再試一次");
  } else {
    await sleep(1_000);
    check(taps === tapsBefore && pinsHanded === handed && waitingTaps.length === 0, "step 5, 再試一次 after the submission: the card was not held to the phone again");
  }
}
