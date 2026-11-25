// The emulator, as the test drives it: `adb` to one emulator, named by its
// serial, and the screen read with `uiautomator dump`, the way
// web/test/e2e/cdp.ts reads a page. Nothing here is linked into the app,
// and nothing is ever sent to a device that is not an emulator.
import { execFileSync } from "node:child_process";

export interface Node {
  text: string;
  id: string;
  /** What a screen reader reads for the node (content-desc), when the app gives it one. */
  description: string;
  clickable: boolean;
  enabled: boolean;
  /** The middle of the node on the screen, in pixels. */
  x: number;
  y: number;
  top: number;
  bottom: number;
}

const unescape = (s: string): string => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export class Emulator {
  readonly serial: string;
  readonly #adb: string;
  #height = 0;
  #width = 0;

  constructor(adb: string, serial: string) {
    // Only an emulator: a phone on a cable is never given a command.
    if (!/^emulator-\d+$/.test(serial)) throw new Error(`${serial} is not an emulator`);
    this.#adb = adb;
    this.serial = serial;
  }

  /** The serial of the one emulator that is running; IAMREAL_EMULATOR names it when there are several. */
  static find(adb: string): Emulator {
    const named = process.env.IAMREAL_EMULATOR;
    if (named !== undefined) return new Emulator(adb, named);
    const running = execFileSync(adb, ["devices"], { encoding: "utf8" }).split("\n").map((l) => l.split("\t")).filter(([serial, state]) => /^emulator-\d+$/.test(serial ?? "") && state === "device").map(([serial]) => serial!);
    if (running.length !== 1) throw new Error(`${running.length} emulators are running: start one (android/README.md), or name one with IAMREAL_EMULATOR`);
    return new Emulator(adb, running[0]!);
  }

  adb(...args: string[]): string {
    return execFileSync(this.#adb, ["-s", this.serial, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
  }

  shell(command: string): string {
    return this.adb("shell", command);
  }

  /** The size of the screen in pixels. */
  size(): { width: number; height: number } {
    if (this.#height === 0) {
      const m = /(\d+)x(\d+)\s*$/.exec(this.shell("wm size").trim());
      if (!m) throw new Error("no screen size");
      this.#width = Number(m[1]);
      this.#height = Number(m[2]);
    }
    return { width: this.#width, height: this.#height };
  }

  /** Every node on the screen that has a text or a name. */
  dump(): Node[] {
    let xml = "";
    for (let i = 0; i < 5 && !xml.includes("<hierarchy"); i++) {
      try {
        xml = this.adb("exec-out", "uiautomator", "dump", "/dev/tty");
      } catch {
        xml = "";
      }
    }
    if (!xml.includes("<hierarchy")) throw new Error("the screen could not be read");
    const nodes: Node[] = [];
    for (const m of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
      const attr = (name: string): string => unescape(new RegExp(`(?:^| )${name}="([^"]*)"`).exec(m[1]!)?.[1] ?? "");
      const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr("bounds"));
      if (!b) continue;
      const [left, top, right, bottom] = b.slice(1).map(Number) as [number, number, number, number];
      const text = attr("text");
      const id = attr("resource-id");
      if (text === "" && id === "") continue;
      nodes.push({ text, id, description: attr("content-desc"), clickable: attr("clickable") === "true", enabled: attr("enabled") === "true", x: (left + right) >> 1, y: (top + bottom) >> 1, top, bottom });
    }
    return nodes;
  }

  /** The screen as a PNG. */
  screenshot(): Buffer {
    return execFileSync(this.#adb, ["-s", this.serial, "exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 });
  }

  tap(node: { x: number; y: number }): void {
    this.shell(`input tap ${node.x} ${node.y}`);
  }

  /** Moves what is on the screen up by about a third of it. */
  scrollDown(): void {
    const { width, height } = this.size();
    this.shell(`input swipe ${width >> 1} ${Math.round(height * 0.7)} ${width >> 1} ${Math.round(height * 0.3)} 300`);
  }

  /** Moves what is on the screen down by about a third of it. */
  scrollUp(): void {
    const { width, height } = this.size();
    this.shell(`input swipe ${width >> 1} ${Math.round(height * 0.3)} ${width >> 1} ${Math.round(height * 0.7)} 300`);
  }

  /** Types into the field that has the focus. Letters, digits, `.` and `_` only. */
  type(text: string): void {
    if (!/^[A-Za-z0-9._]+$/.test(text)) throw new Error("not typed: only letters, digits, . and _");
    this.shell(`input text ${text}`);
  }

  /** Deletes `n` characters before the end of the field that has the focus. */
  erase(n: number): void {
    if (n > 0) this.shell(`input keyevent 123 ${Array(n).fill("67").join(" ")}`);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
