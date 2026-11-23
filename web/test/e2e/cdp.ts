// A small Chrome DevTools Protocol client for the headless browser tests:
// Node's own WebSocket, no package. It starts Chrome with a fresh profile,
// attaches to every target the page opens (its workers, the component's
// window) and records every request each of them makes, so a test can check
// where the page connected to. Clicks are real mouse events (the browser
// counts them as the cardholder's clicks, so a click may open one window).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Json = Record<string, any>;

export interface RequestSeen {
  url: string;
  method: string;
  /** The target that made it: its type and the URL it had when attached. */
  targetType: string;
  targetUrl: string;
  sessionId: string;
}

export interface ResponseSeen {
  url: string;
  status: number;
  headers: Record<string, string>;
  requestId: string;
}

export class Browser {
  private ws!: WebSocket;
  private proc!: ChildProcess;
  private profile!: string;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
  private readonly listeners: ((method: string, params: Json, sessionId?: string) => void)[] = [];
  readonly sessions = new Map<string, { type: string; url: string; targetId: string }>();
  readonly requests: RequestSeen[] = [];
  readonly responses: ResponseSeen[] = [];
  readonly logs: { level: string; source: string; text: string; url?: string }[] = [];

  static async launch(o: { dir: string; headless?: boolean; args?: string[] }): Promise<Browser> {
    const b = new Browser();
    b.profile = mkdtempSync(join(o.dir, "profile-"));
    const args = [
      ...(o.headless === false ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${b.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--window-size=1280,900",
      ...(o.args ?? []),
      "about:blank",
    ];
    b.proc = spawn(CHROME, args, { stdio: "ignore" });
    const portFile = join(b.profile, "DevToolsActivePort");
    const t0 = Date.now();
    while (!existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2) {
      if (Date.now() - t0 > 20_000) throw new Error("Chrome did not start");
      await sleep(100);
    }
    const [port, path] = readFileSync(portFile, "utf8").split("\n");
    b.ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => {
      b.ws.onopen = () => resolve();
      b.ws.onerror = () => reject(new Error("cannot connect to Chrome"));
    });
    b.ws.onmessage = (ev) => b.onMessage(JSON.parse(String(ev.data)));
    b.on((method, params, sessionId) => b.record(method, params, sessionId));
    await b.send("Target.setDiscoverTargets", { discover: true });
    await b.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    return b;
  }

  private onMessage(m: Json): void {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
      return;
    }
    for (const l of this.listeners) l(m.method, m.params, m.sessionId);
  }

  on(f: (method: string, params: Json, sessionId?: string) => void): () => void {
    this.listeners.push(f);
    return () => this.listeners.splice(this.listeners.indexOf(f), 1);
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = this.nextId++;
    const msg: Json = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  /** Every target that attaches (pages, popups, workers, their workers): record its requests, attach to its children, let it run. */
  private record(method: string, params: Json, sessionId?: string): void {
    if (method === "Target.attachedToTarget") {
      const s = params.sessionId as string;
      const info = params.targetInfo as Json;
      this.sessions.set(s, { type: info.type, url: info.url, targetId: info.targetId });
      const go = async () => {
        await this.send("Network.enable", {}, s).catch(() => undefined);
        if (info.type === "page") {
          await this.send("Log.enable", {}, s).catch(() => undefined);
          await this.send("Page.enable", {}, s).catch(() => undefined);
        }
        await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, s).catch(() => undefined);
        await this.send("Runtime.runIfWaitingForDebugger", {}, s).catch(() => undefined);
      };
      void go();
    } else if (method === "Network.requestWillBeSent" && sessionId) {
      const t = this.sessions.get(sessionId);
      this.requests.push({ url: params.request.url, method: params.request.method, targetType: t?.type ?? "?", targetUrl: t?.url ?? "?", sessionId });
    } else if (method === "Network.responseReceived" && sessionId) {
      const r = params.response as Json;
      this.responses.push({ url: r.url, status: r.status, headers: lower(r.headers), requestId: params.requestId });
    } else if (method === "Log.entryAdded") {
      const e = params.entry as Json;
      this.logs.push({ level: e.level, source: e.source, text: e.text, url: e.url });
    } else if (method === "Target.targetInfoChanged") {
      const info = params.targetInfo as Json;
      for (const v of this.sessions.values()) if (v.targetId === info.targetId) v.url = info.url;
    }
  }

  /** Opens a tab and returns its page. */
  async newPage(): Promise<Page> {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const t0 = Date.now();
    for (;;) {
      for (const [sessionId, s] of this.sessions) if (s.targetId === targetId) return new Page(this, sessionId, targetId);
      if (Date.now() - t0 > 10_000) throw new Error("the new tab did not attach");
      await sleep(50);
    }
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.send("Browser.close"), sleep(2000)]);
    } catch {
      // closing anyway
    }
    this.proc.kill();
    await sleep(300);
    rmSync(this.profile, { recursive: true, force: true });
  }
}

export class Page {
  readonly browser: Browser;
  readonly sessionId: string;
  readonly targetId: string;
  constructor(browser: Browser, sessionId: string, targetId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method: string, params: Json = {}): Promise<Json> {
    return this.browser.send(method, params, this.sessionId);
  }

  async goto(url: string): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.browser.on((m, _p, s) => {
        if (m === "Page.loadEventFired" && s === this.sessionId) {
          off();
          resolve();
        }
      });
    });
    await this.send("Page.navigate", { url });
    await loaded;
  }

  /** Evaluates an expression in the page and returns its value (JSON). */
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** Waits until the expression is truthy; returns its value. */
  async waitFor<T = any>(expression: string, what: string, timeoutMs = 60_000): Promise<T> {
    const t0 = Date.now();
    for (;;) {
      const v = await this.eval<T>(expression).catch(() => undefined);
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  /** A real mouse click in the middle of the element (scrolled into view). */
  async click(selector: string): Promise<void> {
    const box = await this.eval<{ x: number; y: number } | null>(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null;
      e.scrollIntoView({ block: "center" });
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`no element ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    }
  }

  /** Clicks the button whose text is `text`. */
  async clickButton(text: string): Promise<void> {
    const sel = await this.eval<string | null>(`(() => {
      const b = [...document.querySelectorAll("button")].filter((b) => b.textContent === ${JSON.stringify(text)});
      if (b.length !== 1) return null;
      b[0].setAttribute("data-click", "1");
      return '[data-click="1"]';
    })()`);
    if (!sel) throw new Error(`no single button "${text}"`);
    await this.click(sel);
    await this.eval(`document.querySelector('[data-click="1"]')?.removeAttribute("data-click")`);
  }

  /** Types into the element as keyboard input. */
  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.send("Input.insertText", { text });
  }

  text(selector = "main"): Promise<string> {
    return this.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
  }
}

function lower(h: Json): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
