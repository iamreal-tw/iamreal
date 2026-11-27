// The counts' script of the visitors' pages (site/count.js; spec/counts.md,
// ADR-0032, ADR-0039): it is the file scripts/site-files.ts writes from
// protocol/src/families.ts and count/visitor.js, and what it sends, run as
// a browser runs it, in a page made of the few things it touches. Every
// count it sends is one the table takes (protocol/src/counts.ts,
// `readCount`, the server's reader).
//
// That it does the same in a real browser, against the Worker, from the
// pages the Worker makes, is web/test/worker-card-proof.ts's to check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VISIT_ID_KEY, readCount } from "iamreal-protocol/counts.ts";
import { familiesOf } from "iamreal-protocol/families.ts";
import { COUNT_FILE, countScript } from "../scripts/site-files.ts";
import { WORKER_DIR } from "./build.ts";

const SCRIPT = readFileSync(join(WORKER_DIR, "site", COUNT_FILE), "utf8");
const CHROME_ON_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SHORT_ID = "7K2Q9FM4XD";
const ID = /^[0-9a-f]{32}$/;

test("site/count.js is the one scripts/site-files.ts writes from protocol/src/families.ts and count/visitor.js", () => {
  assert.equal(SCRIPT, countScript(), "run `node --experimental-strip-types scripts/site-files.ts` after a change of either, and commit site/count.js");
});

/** A tab's sessionStorage, or one that refuses to be used. */
class Storage {
  readonly kept = new Map<string, string>();
  readonly refuses: boolean;
  constructor(refuses = false) {
    this.refuses = refuses;
  }
  getItem(key: string): string | null {
    if (this.refuses) throw new Error("SecurityError");
    return this.kept.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.refuses) throw new Error("SecurityError");
    this.kept.set(key, value);
  }
}

/** An element as the script asks it: its data attributes, and the nearest one up from it marked `data-count`. */
class FakeElement {
  readonly dataset: Record<string, string>;
  readonly parent: FakeElement | null;
  constructor(dataset: Record<string, string>, parent: FakeElement | null = null) {
    this.dataset = dataset;
    this.parent = parent;
  }
  closest(selector: string): FakeElement | null {
    assert.equal(selector, "[data-count]");
    return this.dataset["count"] !== undefined ? this : (this.parent?.closest(selector) ?? null);
  }
}

interface Sent {
  readonly path: string;
  readonly init: RequestInit;
  readonly count: Record<string, string>;
}

/** Runs site/count.js in a page: what its <script> element says, the `Referer` it was opened with, the tab's storage. */
function open(o: { script: Record<string, string> | null; referrer?: string; storage?: Storage; userAgent?: string; fetchFails?: boolean }) {
  const sent: Sent[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const storage = o.storage ?? new Storage();
  const fetch = (path: string, init: RequestInit): Promise<Response> => {
    if (o.fetchFails === true) return Promise.reject(new TypeError("Failed to fetch"));
    sent.push({ path, init, count: JSON.parse(init.body as string) as Record<string, string> });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  const document = { currentScript: o.script === null ? null : new FakeElement(o.script), referrer: o.referrer ?? "" };
  const addEventListener = (type: string, listener: (event: unknown) => void): void => void listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  new Function("document", "sessionStorage", "navigator", "fetch", "addEventListener", "Element", SCRIPT)(document, storage, { userAgent: o.userAgent ?? CHROME_ON_WINDOWS }, fetch, addEventListener, FakeElement);
  const fire = (type: string, event: unknown = {}): void => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  return {
    sent,
    storage,
    show: () => fire("pageshow"),
    press: (target: FakeElement) => fire("click", { target }),
  };
}

/** Every count sent: each one the table takes, as it was sent, to this origin's counts. */
function counts(sent: readonly Sent[]): Record<string, string>[] {
  for (const { path, init, count } of sent) {
    assert.equal(path, "/api/v1/counts");
    assert.deepEqual([init.method, init.credentials, init.referrerPolicy, init.keepalive], ["POST", "omit", "no-referrer", true]);
    assert.notEqual(readCount(count), null, `the table takes ${JSON.stringify(count)}`);
  }
  return sent.map((s) => s.count);
}

test("a page sends which page it is once, as it opens, with the visit ID and the two names; not again when the browser shows it from its back-forward cache", () => {
  const page = open({ script: { page: "faq" }, referrer: "https://l.threads.com/?u=https%3A%2F%2Fiamreal.tw%2Ffaq&e=AT0" });
  const [first] = counts(page.sent);
  const visit = first!["visit_id"]!;
  assert.match(visit, ID);
  assert.deepEqual(first, { client: "web", event: "page", page: "faq", source: "l.threads.com", visit_id: visit, browser: "chrome", os: "windows" });
  assert.equal(page.storage.kept.get(VISIT_ID_KEY), visit, "kept in the tab's sessionStorage");
  page.show();
  assert.equal(page.sent.length, 1);
});

test("the source is the domain of the Referer and nothing else of it; a Referer whose host is not in its form, or none, is no source", () => {
  const cases: [string, string | undefined][] = [
    ["https://www.threads.com/@alice/post/123?xmt=abc", "www.threads.com"],
    ["http://localhost:8787/somewhere", "localhost"],
    ["https://203.0.113.7/", "203.0.113.7"],
    ["https://島民.tw/", "xn--klt846a.tw"],
    ["https://[2001:db8::1]/", undefined],
    ["android-app://com.instagram.barcelona/", "com.instagram.barcelona"],
    ["", undefined],
    ["not an address", undefined],
  ];
  for (const [referrer, source] of cases) {
    const page = open({ script: { page: "home" }, referrer });
    page.show();
    assert.equal(counts(page.sent)[0]!["source"], source, referrer);
  }
});

test("the page of a card: its short ID, on its page and on every action pressed on it", () => {
  const page = open({ script: { page: "card", shortId: SHORT_ID } });
  page.show();
  const button = new FakeElement({ count: "start_card_proof" });
  page.press(new FakeElement({}, button));
  const [shown, pressed] = counts(page.sent);
  assert.equal(shown!["short_id"], SHORT_ID);
  assert.deepEqual(pressed, { client: "web", event: "action", action: "start_card_proof", short_id: SHORT_ID, visit_id: shown!["visit_id"], browser: "chrome", os: "windows" });
});

test("an action is sent when what is marked data-count, or anything inside it, is pressed; nothing for anything else", () => {
  const page = open({ script: { page: "hang" } });
  page.press(new FakeElement({}));
  page.press(new FakeElement({ copy: "x" }));
  assert.deepEqual(counts(page.sent).map((c) => c["event"]), ["page"]);
  page.press(new FakeElement({ count: "copy_proof_link" }));
  assert.deepEqual(
    counts(page.sent).map((c) => [c["event"], c["action"], c["short_id"]]),
    [
      ["page", undefined, undefined],
      ["action", "copy_proof_link", undefined],
    ],
  );
});

test("the visit ID lasts while the tab keeps it; once the card proof page took it away, the next count has a new one", () => {
  const storage = new Storage();
  const first = open({ script: { page: "home" }, storage });
  first.show();
  const second = open({ script: { page: "faq" }, storage });
  second.show();
  const [a, b] = [counts(first.sent)[0]!["visit_id"], counts(second.sent)[0]!["visit_id"]];
  assert.equal(a, b, "one visit across the tab's pages");
  // The card proof page opens in this tab (web/src/counts.ts, endVisit); back on the page, from the back-forward cache, a button is pressed.
  storage.kept.delete(VISIT_ID_KEY);
  second.show();
  second.press(new FakeElement({ count: "start_card_proof" }));
  assert.equal(second.sent.length, 2);
  const c = counts(second.sent)[1]!["visit_id"];
  assert.match(c!, ID);
  assert.notEqual(c, a);
  assert.equal(storage.kept.get(VISIT_ID_KEY), c);
});

test("a stored value that is not a visit ID is replaced", () => {
  const storage = new Storage();
  storage.kept.set(VISIT_ID_KEY, "0123456789abcdef0123456789abcdeX");
  const page = open({ script: { page: "home" }, storage });
  page.show();
  const visit = counts(page.sent)[0]!["visit_id"]!;
  assert.match(visit, ID);
  assert.equal(storage.kept.get(VISIT_ID_KEY), visit);
});

test("a tab whose sessionStorage cannot be used: one visit ID while the page is open", () => {
  const page = open({ script: { page: "home" }, storage: new Storage(true) });
  page.show();
  page.press(new FakeElement({ count: "start_card_proof" }));
  const [shown, pressed] = counts(page.sent);
  assert.match(shown!["visit_id"]!, ID);
  assert.equal(pressed!["visit_id"], shown!["visit_id"]);
});

test("the browser and the operating system are named as the card proof page names them", () => {
  for (const userAgent of [
    CHROME_ON_WINDOWS,
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22B83 Barcelona 361.0.0.30.106",
    "curl/8.7.1",
  ]) {
    const page = open({ script: { page: "home" }, userAgent });
    page.show();
    const [count] = counts(page.sent);
    assert.deepEqual({ browser: count!["browser"], os: count!["os"] }, familiesOf(userAgent), userAgent);
  }
});

test("a page that does not say which page it is sends nothing; a request that fails is nobody's failure", () => {
  const unnamed = open({ script: {} });
  unnamed.show();
  unnamed.press(new FakeElement({ count: "start_card_proof" }));
  const withoutElement = open({ script: null });
  withoutElement.show();
  assert.deepEqual([unnamed.sent, withoutElement.sent], [[], []]);
  const failing = open({ script: { page: "home" }, fetchFails: true });
  assert.doesNotThrow(() => failing.show());
});
