// Writes spec/vectors/counts.json (spec/counts.md). Run in protocol/:
//   node --experimental-strip-types test/generate/counts.ts
// The table is written from src/counts.ts; whether each case is taken is
// written here by hand. Before writing, each case is read with
// src/counts.ts; if one gives another result, nothing is written.
import { writeFileSync } from "node:fs";
import { BROWSERS, CARD_PROOF_ACTIONS, CLIENTS, DURATIONS, EVENTS, OSES, PAGES, REASONS, SOURCES, STEPS, TAPS, TIMED_STEPS, VISITOR_ACTIONS, readCount } from "../../src/counts.ts";

const DEVICE = "0123456789abcdef0123456789abcdef";
const ATTEMPT = "fedcba9876543210fedcba9876543210";
const VISIT = "00112233445566778899aabbccddeeff";
const web = { client: "web", device_id: DEVICE, attempt_id: ATTEMPT, browser: "chrome", os: "windows" };
const app = (client: "android" | "ios") => ({ client, device_id: DEVICE, attempt_id: ATTEMPT });
const visitor = { client: "web", visit_id: VISIT, browser: "safari", os: "ios" };

interface Case {
  readonly name: string;
  readonly count: unknown;
  readonly taken: boolean;
}
const taken = (name: string, count: unknown): Case => ({ name, count, taken: true });
const dropped = (name: string, count: unknown): Case => ({ name, count, taken: false });

const cases: Case[] = [
  // Taken: a card proof.
  taken("web, a step", { ...web, event: "step", step: "read" }),
  taken("web, the step only the web page has", { ...web, event: "step", step: "component" }),
  taken("web, the last step", { ...web, event: "step", step: "done" }),
  taken("android, a step, with no browser and no operating system", { ...app("android"), event: "step", step: "certificates" }),
  taken("ios, a step", { ...app("ios"), event: "step", step: "scope_signed" }),
  taken("web, stopped: no card reader", { ...web, event: "stop", reason: "no_reader" }),
  taken("web, stopped: the certificate is on the CRL", { ...web, event: "stop", reason: "revoked" }),
  taken("web, stopped: a code the server answered", { ...web, event: "stop", reason: "server_challenge_attempts" }),
  taken("web, to be tried again: the PIN was wrong", { ...web, event: "retry", reason: "pin_incorrect" }),
  taken("web, to be tried again: the browser blocked the window", { ...web, event: "retry", reason: "popup_blocked" }),
  taken("android, stopped: NFC is off", { ...app("android"), event: "stop", reason: "nfc_off" }),
  taken("ios, stopped: another card at the second tap", { ...app("ios"), event: "stop", reason: "other_card" }),
  taken("ios, stopped: the app is too old", { ...app("ios"), event: "stop", reason: "app_too_old" }),
  taken("ios, the card left during the second tap", { ...app("ios"), event: "action", action: "tap_dropped", tap: "2" }),
  taken("android, the card left during the first tap", { ...app("android"), event: "action", action: "tap_dropped", tap: "1" }),
  taken("web, the record sent again", { ...web, event: "action", action: "resubmit" }),
  taken("web, how long the proof took", { ...web, event: "duration", step: "proved", took: "10s_30s" }),
  taken("android, how long the tree took", { ...app("android"), event: "duration", step: "tree", took: "lt_1s" }),
  taken("web, with versions and the card reader's name", { ...web, event: "step", step: "pin", browser_version: "131.0.6778.86", os_version: "10.0", reader: "Generic Smart Card Reader 0" }),
  taken("ios, with versions", { ...app("ios"), event: "step", step: "done", os_version: "18.1.1", app_version: "1.4" }),
  taken("the members in another order", { step: "read", os: "macos", browser: "firefox", attempt_id: ATTEMPT, device_id: DEVICE, event: "step", client: "web" }),
  // Taken: a visitor.
  taken("a page", { ...visitor, event: "page", page: "home" }),
  taken("a proof page, with its short ID", { ...visitor, event: "page", page: "card", short_id: "7K2Q9FM4XD" }),
  taken("an account's page, without the account", { ...visitor, event: "page", page: "account" }),
  taken("a visitor's action", { ...visitor, event: "action", action: "start_card_proof" }),
  taken("a visitor's action on a proof page", { ...visitor, event: "action", action: "download_app_ios" }),
  // Dropped: not a count at all.
  dropped("not an object", [{ ...web, event: "step", step: "read" }]),
  dropped("null", null),
  dropped("a string", "step"),
  dropped("an empty object", {}),
  dropped("no client", { device_id: DEVICE, attempt_id: ATTEMPT, browser: "chrome", os: "windows", event: "step", step: "read" }),
  dropped("no event", { ...web, step: "read" }),
  dropped("a client the table has not", { ...web, client: "desktop", event: "step", step: "read" }),
  dropped("an event the table has not", { ...web, event: "error", step: "read" }),
  dropped("a value that is a number", { ...app("ios"), event: "action", action: "tap_dropped", tap: 2 }),
  dropped("a value that is null", { ...web, event: "step", step: "read", reader: null }),
  dropped("a value that is an object", { ...web, event: "step", step: { code: "read" } }),
  // Dropped: a code the table has not, or has for another client.
  dropped("a step the table has not", { ...web, event: "step", step: "reading" }),
  dropped("a step in capitals", { ...web, event: "step", step: "READ" }),
  dropped("the web page's step from an app", { ...app("android"), event: "step", step: "component" }),
  dropped("a reason the table has not", { ...web, event: "stop", reason: "out_of_memory" }),
  dropped("an app's reason from the web page", { ...web, event: "stop", reason: "nfc_off" }),
  dropped("the web page's reason from an app", { ...app("ios"), event: "stop", reason: "popup_blocked" }),
  dropped("a reason that is an error's text", { ...web, event: "stop", reason: "TypeError: Cannot read properties of undefined" }),
  dropped("an action the table has not", { ...web, event: "action", action: "share" }),
  dropped("an app's action from the web page", { ...web, event: "action", action: "tap_dropped", tap: "1" }),
  dropped("a tap that is no tap", { ...app("ios"), event: "action", action: "tap_dropped", tap: "4" }),
  dropped("a dropped tap without which tap", { ...app("ios"), event: "action", action: "tap_dropped" }),
  dropped("a tap with another action", { ...app("ios"), event: "action", action: "resubmit", tap: "1" }),
  dropped("a duration of a step that is not timed", { ...web, event: "duration", step: "pin", took: "lt_1s" }),
  dropped("a duration in milliseconds", { ...web, event: "duration", step: "proved", took: "12345" }),
  dropped("a duration without how long", { ...web, event: "duration", step: "proved" }),
  dropped("a browser the table has not", { ...web, browser: "netscape", event: "step", step: "read" }),
  dropped("a whole User-Agent as the browser", { ...web, browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", event: "step", step: "read" }),
  dropped("an operating system the table has not", { ...web, os: "windows 11", event: "step", step: "read" }),
  dropped("a page the table has not", { ...visitor, event: "page", page: "admin" }),
  dropped("a page from an app", { client: "android", visit_id: VISIT, event: "page", page: "home" }),
  // Dropped: a member the count must have, or may not have.
  dropped("a step with a reason", { ...web, event: "step", step: "read", reason: "no_reader" }),
  dropped("a stop without a reason", { ...web, event: "stop" }),
  dropped("a stop with a step", { ...web, event: "stop", reason: "no_reader", step: "read" }),
  dropped("a member the table has not", { ...web, event: "step", step: "read", note: "anything" }),
  dropped("a member named __proto__", { ...web, event: "step", step: "read", ["__proto__"]: "anything" }),
  dropped("a member named constructor", { ...web, event: "step", step: "read", constructor: "anything" }),
  dropped("a step named after a method of every object", { ...web, event: "step", step: "toString" }),
  dropped("a reason named constructor", { ...web, event: "stop", reason: "constructor" }),
  dropped("a time", { ...web, event: "step", step: "read", time: "2026-11-16T12:00:00Z" }),
  dropped("an account", { ...web, event: "step", step: "done", username: "alice" }),
  dropped("a scoped ID", { ...web, event: "step", step: "state", scoped_id: "7K2Q9FM4XD" }),
  dropped("an error's message", { ...web, event: "stop", reason: "card_error", message: "0x76100006" }),
  dropped("a card proof without the device ID", { client: "web", attempt_id: ATTEMPT, browser: "chrome", os: "windows", event: "step", step: "read" }),
  dropped("a card proof without the attempt ID", { client: "web", device_id: DEVICE, browser: "chrome", os: "windows", event: "step", step: "read" }),
  dropped("a card proof with a visit ID", { ...web, visit_id: VISIT, event: "step", step: "read" }),
  dropped("a page with the device ID", { ...visitor, device_id: DEVICE, event: "page", page: "home" }),
  dropped("a page without the visit ID", { client: "web", browser: "safari", os: "ios", event: "page", page: "home" }),
  dropped("a web count without the browser", { client: "web", device_id: DEVICE, attempt_id: ATTEMPT, os: "windows", event: "step", step: "read" }),
  dropped("a web count without the operating system", { client: "web", device_id: DEVICE, attempt_id: ATTEMPT, browser: "chrome", event: "step", step: "read" }),
  dropped("an app's count with a browser", { ...app("android"), browser: "chrome", event: "step", step: "read" }),
  dropped("an app's count with a card reader", { ...app("android"), reader: "ACS ACR122U", event: "step", step: "read" }),
  dropped("a web count with an app version", { ...web, app_version: "1.4", event: "step", step: "read" }),
  dropped("a page with a version", { ...visitor, browser_version: "17.4", event: "page", page: "home" }),
  dropped("a proof page without its short ID", { ...visitor, event: "page", page: "card" }),
  dropped("a short ID on another page", { ...visitor, event: "page", page: "home", short_id: "7K2Q9FM4XD" }),
  dropped("a short ID on a card proof", { ...web, event: "step", step: "done", short_id: "7K2Q9FM4XD" }),
  // Dropped: a format.
  dropped("an ID of 31 digits", { ...web, device_id: DEVICE.slice(1), event: "step", step: "read" }),
  dropped("an ID in capitals", { ...web, attempt_id: ATTEMPT.toUpperCase(), event: "step", step: "read" }),
  dropped("an ID that is a UUID", { ...web, device_id: "01234567-89ab-cdef-0123-456789abcdef", event: "step", step: "read" }),
  dropped("a visit ID that is no hex", { ...visitor, visit_id: "g".repeat(32), event: "page", page: "home" }),
  dropped("a short ID in lowercase", { ...visitor, event: "page", page: "card", short_id: "7k2q9fm4xd" }),
  dropped("a short ID of 9 characters", { ...visitor, event: "page", page: "card", short_id: "7K2Q9FM4X" }),
  dropped("a short ID with a letter the alphabet has not", { ...visitor, event: "page", page: "card", short_id: "7K2Q9FM4XU" }),
  dropped("a version with a letter", { ...web, event: "step", step: "read", browser_version: "131.0b2" }),
  dropped("a version of five parts", { ...web, event: "step", step: "read", browser_version: "1.2.3.4.5" }),
  dropped("a version that ends in a dot", { ...app("ios"), event: "step", step: "read", os_version: "18.1." }),
  dropped("a version with a part of six digits", { ...app("ios"), event: "step", step: "read", app_version: "1.123456" }),
  dropped("an empty version", { ...web, event: "step", step: "read", os_version: "" }),
  dropped("a card reader's name with a hyphen", { ...web, event: "step", step: "read", reader: "ACS ACR-122U" }),
  dropped("a card reader's name of 65 characters", { ...web, event: "step", step: "read", reader: "A".repeat(65) }),
  dropped("a card reader's name with a character outside ASCII", { ...web, event: "step", step: "read", reader: "讀卡機" }),
  dropped("an empty card reader's name", { ...web, event: "step", step: "read", reader: "" }),
];

for (const c of cases) {
  const kept = readCount(c.count);
  if ((kept !== null) !== c.taken) throw new Error(`"${c.name}" is written as ${c.taken ? "taken" : "dropped"}, and src/counts.ts says otherwise`);
}

/**
 * How long a timed step took, in milliseconds, and the duration it is: each
 * end of the table's durations on both sides, written out by hand (the
 * durations are "under 1 second", "1 second to under 3", …). Below 0 is none.
 */
const durationsOf: { ms: number; took: string | null }[] = [
  { ms: 0, took: "lt_1s" },
  { ms: 999, took: "lt_1s" },
  { ms: 1000, took: "1s_3s" },
  { ms: 2999.5, took: "1s_3s" },
  { ms: 3000, took: "3s_10s" },
  { ms: 9999, took: "3s_10s" },
  { ms: 10000, took: "10s_30s" },
  { ms: 29999, took: "10s_30s" },
  { ms: 30000, took: "30s_60s" },
  { ms: 59999, took: "30s_60s" },
  { ms: 60000, took: "1m_3m" },
  { ms: 179999, took: "1m_3m" },
  { ms: 180000, took: "gt_3m" },
  { ms: 3600000, took: "gt_3m" },
  { ms: -1, took: null },
];

const file = {
  spec: "counts",
  status: "draft",
  note: "table: every code of spec/counts.md and the clients it is for, as an implementation has it. cases: a parsed count, and whether it is taken or dropped whole. durations_of: how long a timed step took, in milliseconds, and the duration it is (null: none).",
  generated_by: "protocol/test/generate/counts.ts",
  table: {
    clients: CLIENTS,
    events: EVENTS,
    pages: PAGES,
    steps: STEPS,
    reasons: REASONS,
    card_proof_actions: CARD_PROOF_ACTIONS,
    visitor_actions: VISITOR_ACTIONS,
    taps: TAPS,
    timed_steps: TIMED_STEPS,
    durations: DURATIONS,
    sources: SOURCES,
    browsers: BROWSERS,
    oses: OSES,
  },
  cases,
  durations_of: durationsOf,
};
writeFileSync(new URL("../../../spec/vectors/counts.json", import.meta.url), `${JSON.stringify(file, null, 2)}\n`);
console.log(`${cases.length} cases`);
