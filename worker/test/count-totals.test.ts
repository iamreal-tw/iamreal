// The counts' totals (ADR-0032, ADR-0039; issue #435): the hourly schedule
// reads the files of counts and writes totals that are kept. Against the
// whole Worker in the local workerd (test/harness.ts): known counts are put
// into the bucket that is not public as the counts' object writes them, the
// clock is moved, the schedule runs once, and what it wrote is read back.
// Records and the connection log are made the way a card proof makes them,
// with the verifier that judges a proof by its first byte (test/records.ts).
//
// The tests pin what a file of totals holds, exactly: a member more is a
// failure.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { shortId } from "iamreal-protocol/scoped-id.ts";
import { type TestWorker, startWorker } from "./harness.ts";
import { day, freshProofLog, newCard, publishG3, sub } from "./records.ts";

let worker: TestWorker;
let root: string;

before(async () => {
  worker = await startWorker();
  await worker.setVerifier("stand-in");
});
after(() => worker.close());

beforeEach(async () => {
  await freshProofLog(worker);
  root = await publishG3(worker);
  await worker.emptyConnectionLog();
});

/** The day most tests count: the day of START (noon in Taiwan) in UTC. */
const D = "2026-11-20";
/** The first run after which D is totalled: 2 hours after it ends. */
const AFTER_D = "2026-11-21T02:00:00Z";

const VISIT = "11111111111111111111111111111111";
const DEVICE = "22222222222222222222222222222222";
const IDS = { visit: VISIT, device: DEVICE, attempts: ["a0000000000000000000000000000000", "a1111111111111111111111111111111", "a2222222222222222222222222222222", "a3333333333333333333333333333333"] };

const visitor = (more: Record<string, string>): Record<string, string> => ({ client: "web", ...more, visit_id: VISIT, browser: "chrome", os: "windows" });
const page = (name: string, more: Record<string, string> = {}): Record<string, string> => visitor({ event: "page", page: name, ...more });
/** A count of the web page's card proof `attempt`, with the versions and the reader it may carry. */
const web = (attempt: string, more: Record<string, string>): Record<string, string> => ({
  client: "web",
  ...more,
  device_id: DEVICE,
  attempt_id: attempt,
  browser: "chrome",
  os: "windows",
  browser_version: "131.0",
  os_version: "10.0",
  reader: "ACS ACR39U",
});
/** A count of an app's card proof `attempt`. */
const app = (client: "android" | "ios", attempt: string, more: Record<string, string>, versions: { os?: string; app?: string } = { os: "15", app: "1.0.0" }): Record<string, string> => ({
  client,
  ...more,
  device_id: DEVICE,
  attempt_id: attempt,
  ...(versions.os !== undefined && { os_version: versions.os }),
  ...(versions.app !== undefined && { app_version: versions.app }),
});

/** Puts a minute's file of counts into the bucket, as the counts' object writes it (src/counts.ts). */
async function putMinute(minute: string, counts: Record<string, string>[], dropped = 0): Promise<void> {
  await worker.putInConnectionLogBucket(`count-events/${minute.slice(0, 10)}/${minute}.json`, `${JSON.stringify({ minute, counts, dropped })}\n`);
}

/**
 * Runs the schedule once at this time (UTC). The CRL mirror's round fails
 * (the fake MOICA has no G2 CRL, test/records.ts): the totals are made
 * all the same, and wrote no line of trouble.
 */
async function runAt(time: string): Promise<void> {
  await worker.setClock(new Date(time));
  const lines = worker.logLines().length;
  await worker.runSchedule();
  assert.deepEqual(worker.logLines().slice(lines).filter((l) => l.includes("count_totals")), []);
}

/** The files of the bucket that is not public, by key. */
async function privateFiles(): Promise<Map<string, { text: string; entry: Record<string, unknown> }>> {
  return new Map((await worker.connectionLog()).map((o) => [o.key, { text: o.text, entry: o.entry }]));
}
async function stored(key: string): Promise<any> {
  return (await privateFiles()).get(key)?.entry;
}
const dayFile = (day = D): Promise<any> => stored(`count-totals/day/${day}.json`);
const monthFile = (month = D.slice(0, 7)): Promise<any> => stored(`count-totals/month/${month}.json`);

/** Submits a record of `card` with this card proof device ID, and waits for its object in the connection log. */
async function submitFrom(card: string, device: string | null): Promise<void> {
  const before = (await worker.connectionLog()).filter((o) => o.key.startsWith("connection/")).length;
  const s = await sub(worker, card, root, "threads:alice");
  const res = await worker.fetch("/api/v1/records", { method: "POST", body: JSON.stringify({ ...s, ...(device !== null && { device_id: device }) }), headers: { "CF-Connecting-IP": "203.0.113.9" } });
  assert.equal(res.status, 201, await res.text());
  for (const until = Date.now() + 5_000; Date.now() < until; await new Promise((r) => setTimeout(r, 50))) {
    if ((await worker.connectionLog()).filter((o) => o.key.startsWith("connection/")).length > before) return;
  }
  assert.fail("the connection log has no object for the submission");
}

describe("a day's totals", () => {
  test("the pages opened in a day, by kind; every kind of the table is there, with 0 for one nobody opened", async () => {
    await putMinute(`${D}T10:00Z`, [page("home"), page("home"), page("faq")]);
    await runAt(AFTER_D);
    const day = await dayFile();
    assert.equal(day.date, D);
    assert.deepEqual(day.pages, { home: 2, card: 0, account: 0, proof_log: 0, faq: 1, verify: 0, check: 0, prepare: 0, privacy: 0, hang: 0 });
    assert.deepEqual(day.browsers, { chrome: 3, edge: 0, firefox: 0, safari: 0, samsung: 0, other: 0 });
    assert.deepEqual(day.oses, { windows: 3, macos: 0, linux: 0, chromeos: 0, android: 0, ios: 0, other: 0 });
    assert.deepEqual(day.clients, { web: 3, android: 0, ios: 0 });
    assert.deepEqual([day.minutes, day.dropped], [1, 0]);
  });

  test("a day is not totalled before 2 hours after it ends, and once it is, its file is not written again", async () => {
    await putMinute(`${D}T10:00Z`, [page("home")]);
    await runAt("2026-11-21T01:59:00Z");
    assert.equal(await dayFile(), undefined);
    await runAt(AFTER_D);
    const first = (await privateFiles()).get(`count-totals/day/${D}.json`)!.text;
    // A count that turns up later changes nothing: the day was totalled.
    await putMinute(`${D}T11:00Z`, [page("home")]);
    await runAt("2026-11-21T03:00:00Z");
    assert.equal((await privateFiles()).get(`count-totals/day/${D}.json`)!.text, first);
  });

  test("the steps, reasons, actions and durations of each client, every code the table has for it, and the counts a minute did not keep", async () => {
    const [a] = IDS.attempts;
    await putMinute(
      `${D}T10:00Z`,
      [
        web(a!, { event: "step", step: "open" }),
        web(a!, { event: "step", step: "read" }),
        web(a!, { event: "retry", reason: "no_card" }),
        web(a!, { event: "duration", step: "crl", took: "1s_3s" }),
        app("android", a!, { event: "action", action: "tap_dropped", tap: "2" }),
        app("ios", a!, { event: "stop", reason: "nfc_off" }),
        visitor({ event: "action", action: "copy_proof_link" }),
      ],
      5,
    );
    await runAt(AFTER_D);
    const day = await dayFile();
    assert.equal(day.dropped, 5);
    assert.equal(day.steps.web.open, 1);
    assert.equal(day.steps.web.component, 0);
    assert.ok(!("component" in day.steps.android), "a step the table has only for the web page");
    assert.equal(day.retries.web.no_card, 1);
    assert.equal(day.stops.ios.nfc_off, 1);
    assert.ok(!("nfc_off" in day.stops.web));
    assert.deepEqual(day.durations.web.crl, { lt_1s: 0, "1s_3s": 1, "3s_10s": 0, "10s_30s": 0, "30s_60s": 0, "1m_3m": 0, gt_3m: 0 });
    assert.equal(day.actions.android.tap_dropped, 1);
    assert.deepEqual(day.taps_dropped, { android: { 1: 0, 2: 1, 3: 0 }, ios: { 1: 0, 2: 0, 3: 0 } });
    assert.equal(day.actions.web.copy_proof_link, 1);
    assert.deepEqual(day.clients, { web: 5, android: 1, ios: 1 });
  });

  test("an attempt's steps are joined: tried again and then done is one attempt done; one across midnight is the day's it began on", async () => {
    const [retried, gaveUp, late, before] = IDS.attempts;
    // Began the day before, went on into the day: its counts are the day's, the attempt is not.
    await putMinute("2026-11-19T23:50Z", [web(before!, { event: "step", step: "open" })]);
    await putMinute(`${D}T00:05Z`, [web(before!, { event: "step", step: "read" })]);
    await putMinute(`${D}T10:00Z`, [web(retried!, { event: "step", step: "open" }), web(retried!, { event: "step", step: "read" }), web(gaveUp!, { event: "step", step: "open" })]);
    await putMinute(`${D}T10:01Z`, [web(retried!, { event: "retry", reason: "pin_incorrect" }), web(gaveUp!, { event: "stop", reason: "no_reader" })]);
    await putMinute(`${D}T10:02Z`, [web(retried!, { event: "step", step: "pin" }), web(retried!, { event: "step", step: "done" })]);
    // Began before midnight, done after it.
    await putMinute(`${D}T23:58Z`, [web(late!, { event: "step", step: "open" })]);
    await putMinute("2026-11-21T00:03Z", [web(late!, { event: "step", step: "done" })]);
    await runAt(AFTER_D);
    const { started, done, reached } = (await dayFile()).attempts.web;
    assert.deepEqual([started, done], [3, 2]);
    assert.deepEqual([reached.open, reached.read, reached.pin, reached.done, reached.component], [3, 1, 1, 2, 0]);
    // The steps as they came, in the day: the one that began before is there, the one after midnight is not.
    assert.deepEqual([(await dayFile()).steps.web.read, (await dayFile()).steps.web.done], [2, 1]);
  });

  test("an hour with no count ends an attempt: a count with its ID after that is another attempt", async () => {
    const [a] = IDS.attempts;
    await putMinute(`${D}T10:00Z`, [web(a!, { event: "step", step: "open" })]);
    await putMinute(`${D}T11:01Z`, [web(a!, { event: "step", step: "open" })]);
    await runAt(AFTER_D);
    assert.equal((await dayFile()).attempts.web.started, 2);
  });

  test("the domains visitors came from, by kind of page; the 100 that came most often by themselves, the rest as other", async () => {
    const counts: Record<string, string>[] = [];
    // 101 domains: d0 came 101 times, d1 100 times, …, d100 once; d100 is the one left out.
    for (let i = 0; i <= 100; i++) for (let n = 0; n < 101 - i; n++) counts.push(page(n % 2 === 0 ? "home" : "card", { source: `d${i}.example`, ...(n % 2 === 1 && { short_id: "7K2Q9FM4XD" }) }));
    counts.push(page("faq"), page("faq", { source: "threads.net" }));
    await putMinute(`${D}T10:00Z`, counts);
    await runAt(AFTER_D);
    const { sources } = await dayFile();
    assert.deepEqual(Object.keys(sources), ["home", "card", "account", "proof_log", "faq", "verify", "check", "prepare", "privacy", "hang"]);
    const kept = new Set(Object.values(sources).flatMap((s: any) => Object.keys(s.domains)));
    assert.deepEqual([...kept].sort(), Array.from({ length: 100 }, (_, i) => `d${i}.example`).sort());
    assert.deepEqual([sources.home.domains["d0.example"], sources.card.domains["d0.example"]], [51, 50]);
    assert.deepEqual([sources.home.domains["d99.example"], sources.card.domains["d99.example"]], [1, 1]);
    // d100 and threads.net came once each, fewer than the hundredth.
    assert.deepEqual(sources.home, { none: 0, domains: sources.home.domains, other: 1 });
    assert.deepEqual(sources.card.other, 0);
    assert.deepEqual(sources.faq, { none: 1, domains: {}, other: 1 });
    assert.deepEqual(sources.account, { none: 0, domains: {}, other: 0 });
  });
});

describe("each proof page: by month, only short IDs the proof log has", () => {
  test("opened, download the app, start a card proof, from the visitors' counts; a short ID the proof log does not have is not there; how many pages were opened how often", async () => {
    const card = newCard();
    const other = newCard();
    await submitFrom(card, null);
    await submitFrom(other, null);
    const id = shortId(card);
    const counts = [
      ...Array.from({ length: 12 }, () => page("card", { short_id: id })),
      visitor({ event: "action", action: "download_app_android", short_id: id }),
      visitor({ event: "action", action: "download_app_ios", short_id: id }),
      visitor({ event: "action", action: "start_card_proof", short_id: id }),
      // On a page that is not a proof page, an action carries no short ID.
      visitor({ event: "action", action: "start_card_proof" }),
      // A short ID made up: counted as a page, never as a proof page of its own.
      page("card", { short_id: "7K2Q9FM4XD" }),
      visitor({ event: "action", action: "start_card_proof", short_id: "7K2Q9FM4XD" }),
    ];
    await putMinute(`${D}T10:00Z`, counts);
    await runAt(AFTER_D);
    const day = await dayFile();
    assert.equal(day.pages.card, 13);
    assert.deepEqual(day.card_pages, { cards: 2, opened: { 0: 1, "1_9": 0, "10_99": 1, "100_or_more": 0 } });
    assert.deepEqual((await monthFile()).cards, { [id]: { opened: 12, download_app: 2, start_card_proof: 1 } });
    // The day's file holds no short ID: a page's numbers are kept by month only.
    assert.ok(!(await privateFiles()).get(`count-totals/day/${D}.json`)!.text.includes(id));
  });

  test("the days of a month add up, each once", async () => {
    const card = newCard();
    await submitFrom(card, null);
    const id = shortId(card);
    await putMinute(`${D}T10:00Z`, [page("card", { short_id: id })]);
    await putMinute("2026-11-21T10:00Z", [page("card", { short_id: id }), page("card", { short_id: id })]);
    await runAt(AFTER_D);
    await runAt("2026-11-22T02:00:00Z");
    await runAt("2026-11-22T03:00:00Z");
    const month = await monthFile();
    assert.deepEqual(month.days, [D, "2026-11-21"]);
    assert.deepEqual(month.cards[id], { opened: 3, download_app: 0, start_card_proof: 0 });
  });
});

describe("the card proofs by month: by version, browser, system and card reader", () => {
  test("each value's attempts, those done, and the reasons; attempts that carried no value; no threshold", async () => {
    const [a, b, c, d] = IDS.attempts;
    await putMinute(`${D}T10:00Z`, [
      web(a!, { event: "step", step: "open" }),
      web(a!, { event: "retry", reason: "no_card" }),
      web(a!, { event: "step", step: "done" }),
      web(b!, { event: "step", step: "open" }),
      web(b!, { event: "stop", reason: "no_reader" }),
      app("android", c!, { event: "step", step: "open" }),
      app("android", c!, { event: "stop", reason: "no_tap" }),
      app("ios", d!, { event: "step", step: "open" }, { app: "1.0.1" }),
    ]);
    await runAt(AFTER_D);
    const { card_proofs } = await monthFile();
    const both = { attempts: 2, done: 1, stops: { no_reader: 1 }, retries: { no_card: 1 } };
    const empty = { attempts: 0, done: 0, stops: {}, retries: {} };
    assert.deepEqual(card_proofs.web, {
      browser: { values: { "chrome 131.0": both }, none: empty, other: empty },
      os: { values: { "windows 10.0": both }, none: empty, other: empty },
      reader: { values: { "ACS ACR39U": both }, none: empty, other: empty },
    });
    assert.deepEqual(card_proofs.android.os_version, { values: { 15: { attempts: 1, done: 0, stops: { no_tap: 1 }, retries: {} } }, none: empty, other: empty });
    assert.deepEqual(card_proofs.ios.os_version, { values: {}, none: { attempts: 1, done: 0, stops: {}, retries: {} }, other: empty });
    assert.deepEqual(card_proofs.ios.app_version.values, { "1.0.1": { attempts: 1, done: 0, stops: {}, retries: {} } });
  });
});

describe("the devices that sent several different cards in a month: from the connection log", () => {
  /** Totals every day of November 2026 from D on, and the month with them. */
  async function closeNovember(): Promise<any> {
    for (let n = 21; n <= 30; n++) {
      // Two days a run at most: twice for each day is more than enough.
      await runAt(`2026-11-${String(n).padStart(2, "0")}T02:00:00Z`);
      await runAt(`2026-11-${String(n).padStart(2, "0")}T03:00:00Z`);
    }
    await runAt("2026-12-01T02:00:00Z");
    return monthFile();
  }

  test("a device that sent 2 cards, one that sent 3, one that sent the same card twice; counts that carry made-up IDs change nothing", async () => {
    const two = "d2000000000000000000000000000000";
    const three = "d3000000000000000000000000000000";
    const same = "d1000000000000000000000000000000";
    const [x, y, z, w] = [newCard(), newCard(), newCard(), newCard()];
    await submitFrom(x, two);
    await submitFrom(y, two);
    await submitFrom(x, three);
    await submitFrom(z, three);
    await submitFrom(w, three);
    await submitFrom(w, same);
    await submitFrom(w, same);
    await submitFrom(y, null);
    // Counts anyone could send, with card proof device IDs of every sort: not where the number comes from.
    await putMinute(`${D}T10:00Z`, [web(IDS.attempts[0]!, { event: "step", step: "done" }), { ...web(IDS.attempts[1]!, { event: "step", step: "done" }), device_id: two }]);
    await runAt(AFTER_D);
    const devices = (await stored(`count-events/${D}/devices.json`)) as { date: string; devices: Record<string, string[]> };
    assert.deepEqual(devices, { date: D, devices: { [same]: [w], [two]: [x, y].sort(), [three]: [x, z, w].sort() } });
    // Not until the month is over.
    assert.equal((await monthFile()).devices, null);
    const month = await closeNovember();
    assert.equal(month.days.length, 11);
    assert.deepEqual(month.devices, { days: month.days, cards_2: 1, cards_3_or_more: 1 });
  });

  test("a device's cards on two days of the month are one device's", async () => {
    const dev = "d4000000000000000000000000000000";
    await submitFrom(newCard(), dev);
    await putMinute(`${D}T10:00Z`, [page("home")]);
    await runAt(AFTER_D);
    // Five days on, with that day's CRL (test/records.ts).
    await day(worker, 5);
    await submitFrom(newCard(), dev);
    assert.deepEqual((await closeNovember()).devices.cards_2, 1);
  });

  test("a file of devices is deleted when 31 days have passed since its day began; in a month of 31 days, its first day is no longer counted", async () => {
    const dev = "d5000000000000000000000000000000";
    const file = (day: string, cards: string[]): Promise<void> => worker.putInConnectionLogBucket(`count-events/${day}/devices.json`, `${JSON.stringify({ date: day, devices: { [dev]: cards } })}\n`);
    // December has 31 days: the files of the 1st and the 15th, as runs then wrote them.
    await file("2026-12-01", ["c1"]);
    await file("2026-12-15", ["c2"]);
    await putMinute("2026-12-30T10:00Z", [page("home")]);
    await putMinute("2026-12-31T10:00Z", [page("home")]);
    await runAt("2027-01-01T00:00:00Z");
    // 31 days since the 1st began: its file is gone, the others stay.
    const keys = [...(await privateFiles()).keys()];
    assert.ok(!keys.includes("count-events/2026-12-01/devices.json"));
    assert.ok(keys.includes("count-events/2026-12-15/devices.json"));
    await runAt("2027-01-01T02:00:00Z");
    const month = await monthFile("2026-12");
    assert.deepEqual(month.devices, { days: ["2026-12-15", "2026-12-30", "2026-12-31"], cards_2: 0, cards_3_or_more: 0 });
  });

  test("in a month of 30 days its first day's file is still there when the month is over", async () => {
    const dev = "d6000000000000000000000000000000";
    await worker.putInConnectionLogBucket("count-events/2026-11-01/devices.json", `${JSON.stringify({ date: "2026-11-01", devices: { [dev]: ["c1"] } })}\n`);
    await worker.putInConnectionLogBucket("count-events/2026-11-30/devices.json", `${JSON.stringify({ date: "2026-11-30", devices: { [dev]: ["c2"] } })}\n`);
    await putMinute(`${D}T10:00Z`, [page("home")]);
    await runAt(AFTER_D);
    const month = await closeNovember();
    assert.equal(month.devices.cards_2, 1);
    assert.deepEqual(month.devices.days[0], "2026-11-01");
  });
});

describe("what the totals hold, and how they are kept", () => {
  /** A day with every kind of count, IDs of every kind, and records submitted from a device. */
  async function busyDay(): Promise<string> {
    const card = newCard();
    await submitFrom(card, DEVICE);
    await submitFrom(newCard(), DEVICE);
    const id = shortId(card);
    const [a, b] = IDS.attempts;
    await putMinute(`${D}T10:00Z`, [
      page("card", { short_id: id, source: "threads.net" }),
      visitor({ event: "action", action: "start_card_proof", short_id: id }),
      web(a!, { event: "step", step: "open" }),
      web(a!, { event: "stop", reason: "no_card" }),
      app("android", b!, { event: "step", step: "done" }),
      app("android", b!, { event: "duration", step: "proved", took: "10s_30s" }),
    ]);
    await runAt(AFTER_D);
    return id;
  }

  test("no file of totals holds an IP address, a visit ID, a card proof device ID or an attempt ID, nor a request ID", async () => {
    await busyDay();
    const files = await privateFiles();
    const totals = [...files].filter(([k]) => k.startsWith("count-totals/"));
    assert.deepEqual(totals.map(([k]) => k).sort(), [`count-totals/day/${D}.json`, "count-totals/month/2026-11.json"]);
    const connection = [...files].filter(([k]) => k.startsWith("connection/")).map(([, f]) => f.entry as { ip: string; request_id: string });
    assert.ok(connection.length > 0);
    for (const [key, file] of totals) {
      for (const id of [VISIT, DEVICE, ...IDS.attempts]) assert.ok(!file.text.includes(id), `${key} holds ${id}`);
      for (const c of connection) {
        assert.ok(!file.text.includes(c.ip), `${key} holds an IP address`);
        assert.ok(!file.text.includes(c.request_id), `${key} holds a request ID`);
      }
      // Nothing that looks like an ID: 32 hex digits.
      assert.doesNotMatch(file.text, /[0-9a-f]{32}/, key);
    }
    // The card proof device ID is in the day's file of devices, which is deleted with the counts.
    assert.ok(files.get(`count-events/${D}/devices.json`)!.text.includes(DEVICE));
  });

  test("the same period run twice gives the same totals; a day totalled again after a run broke off is not added to its month twice", async () => {
    await busyDay();
    const totalsOf = async (): Promise<string> =>
      JSON.stringify(
        [...(await privateFiles())].filter(([k]) => k.startsWith("count-totals/") || k.endsWith("/devices.json")).map(([k, f]) => [k, f.text]),
      );
    const once = await totalsOf();
    await runAt(AFTER_D);
    assert.equal(await totalsOf(), once);
    // As if the last run had stopped after the month's file and before the day's.
    await worker.deleteInConnectionLogBucket(`count-totals/day/${D}.json`);
    await runAt("2026-11-21T03:00:00Z");
    assert.equal(await totalsOf(), once);
  });

  test("the date of the earliest day's totals is published every hour; nothing else of them", async () => {
    await runAt(AFTER_D);
    const read = async (): Promise<string> => new TextDecoder().decode((await worker.files("count-totals/oldest.json"))[0]!.bytes);
    assert.equal(await read(), `{"checked":"${AFTER_D.replace("Z", ".000Z")}","oldest":null}\n`);
    await busyDay();
    await runAt("2026-11-21T03:00:00Z");
    assert.equal(await read(), `{"checked":"2026-11-21T03:00:00.000Z","oldest":"${D}"}\n`);
    const [file] = await worker.files("count-totals/oldest.json");
    assert.deepEqual([file!.cacheControl, file!.contentType], ["public, max-age=60", "application/json"]);
  });

  test("a file of counts that cannot be read is left out, with its key in the live log", async () => {
    await putMinute(`${D}T10:00Z`, [page("home")]);
    await worker.putInConnectionLogBucket(`count-events/${D}/${D}T10:01Z.json`, "not json");
    await worker.setClock(new Date(AFTER_D));
    const lines = worker.logLines().length;
    await worker.runSchedule();
    assert.deepEqual(
      worker.logLines().slice(lines).filter((l) => l.includes("count_totals")).map((l) => JSON.parse(l.slice(l.indexOf("{")))),
      [{ event: "count_totals_file_unreadable", key: `count-events/${D}/${D}T10:01Z.json` }],
    );
    // Out of the way of the reading below, which reads every object as JSON.
    await worker.deleteInConnectionLogBucket(`count-events/${D}/${D}T10:01Z.json`);
    assert.equal((await dayFile()).pages.home, 1);
  });
});
