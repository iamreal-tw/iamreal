// The operator's page of the fixed files (test/operator-page-fixture.ts),
// opened in a headless Chrome (#436): every request the page makes is
// recorded, and the check fails on any but the file itself; then the whole
// page is drawn at a desktop's width into design/screens/. Not part of
// `pnpm test`: it needs Chrome.
//
//   node --experimental-strip-types test/operator-page-browser.ts
//   (CHROME=<path> if Chrome is not where macOS puts it)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_DAYS, gather, pageOf } from "../scripts/operator-page.ts";
import { fixtureSources } from "./operator-page-fixture.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SCREEN = join(import.meta.dirname, "..", "..", "design", "screens", "operator-page-desktop.png");
const WIDTH = 1280;

const dir = mkdtempSync(join(tmpdir(), "iamreal-operator-page-"));
const file = join(dir, "operator-page.html");
writeFileSync(file, pageOf(await gather(fixtureSources(), { days: DEFAULT_DAYS, now: new Date("2026-11-27T03:00:00Z") })));
const url = pathToFileURL(file).href;

const profile = join(dir, "profile");
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "about:blank"], { stdio: "ignore" });
try {
  // The port Chrome chose, from the file it writes into the profile.
  let port = "";
  for (let i = 0; i < 100 && port === ""; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!;
    } catch {
      // not yet
    }
  }
  if (port === "") throw new Error("Chrome did not start");
  const target = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === "page")!;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let next = 0;
  const waiting = new Map<number, (v: any) => void>();
  const requests: string[] = [];
  let loaded: () => void = () => undefined;
  const load = new Promise<void>((r) => (loaded = r));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id !== undefined) waiting.get(msg.id)?.(msg.result);
    else if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
    else if (msg.method === "Page.loadEventFired") loaded();
  });
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((r) => {
      const id = ++next;
      waiting.set(id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Network.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await load;
  await new Promise((r) => setTimeout(r, 500));

  const others = requests.filter((r) => r !== url);
  console.log(`requests: ${JSON.stringify(requests)}`);
  if (others.length > 0) {
    console.error(`FAIL   the page asked for more than itself: ${JSON.stringify(others)}`);
    process.exitCode = 1;
  } else console.log("ok     the page asked for nothing but itself");

  const { cssContentSize } = await send("Page.getLayoutMetrics");
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: WIDTH, height: Math.ceil(cssContentSize.height), scale: 1 } });
  writeFileSync(SCREEN, Buffer.from(shot.data, "base64"));
  console.log(`${SCREEN}: ${WIDTH} × ${Math.ceil(cssContentSize.height)}`);
  ws.close();
} finally {
  chrome.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}
