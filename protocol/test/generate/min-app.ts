// Writes spec/vectors/min-app.json (spec/min-app.md). Run in protocol/:
//   node --experimental-strip-types test/generate/min-app.ts
// Every expected result is written here by hand. Before writing, each case
// is read with src/min-app.ts; if one gives another result, nothing is
// written.
import { writeFileSync } from "node:fs";
import { formatDay } from "../../src/date.ts";
import { type AppClient, minAppVerdict } from "../../src/min-app.ts";

type Result = "ok" | "ok_until" | "stop" | "unreadable";
const MIN = { android: { build: 12, from: "2027-03-01" }, ios: { build: 9, from: "2027-03-01" } };
const T: Record<string, [number, string]> = {
  before: [1803830399, "2027-02-28T23:59:59+08:00"],
  on: [1803830400, "2027-03-01T00:00:00+08:00"],
  week_before: [1803096000, "2027-02-20T12:00:00+08:00"],
  noon_on: [1803873600, "2027-03-01T12:00:00+08:00"],
  later: [1811822400, "2027-06-01T12:00:00+08:00"],
};
const c = (name: string, config: unknown, client: AppClient, app_build: number, t: keyof typeof T, result: Result, from?: string) => {
  const x: Record<string, unknown> = { name, config, client, app_build, now: T[t]![0], now_in_taiwan: T[t]![1], result };
  if (from !== undefined) x.from = from;
  return x;
};
const withEntry = (client: AppClient, entry: unknown) => ({ min_app: { ...MIN, [client]: entry } });
const cases = [
  // Read: the verdicts.
  c("android, smaller build, the last second before the start date", { min_app: MIN }, "android", 11, "before", "ok_until", "2027-03-01"),
  c("android, smaller build, the first second of the start date (still 2027-02-28 in UTC)", { min_app: MIN }, "android", 11, "on", "stop"),
  c("android, smaller build, a week before", { min_app: MIN }, "android", 11, "week_before", "ok_until", "2027-03-01"),
  c("android, smaller build, months after", { min_app: MIN }, "android", 11, "later", "stop"),
  c("android, much smaller build, on the start date", { min_app: MIN }, "android", 1, "noon_on", "stop"),
  c("android, equal build, on the start date", { min_app: MIN }, "android", 12, "on", "ok"),
  c("android, equal build, before the start date", { min_app: MIN }, "android", 12, "before", "ok"),
  c("android, larger build, on the start date", { min_app: MIN }, "android", 13, "on", "ok"),
  c("ios, smaller build, the last second before the start date", { min_app: MIN }, "ios", 8, "before", "ok_until", "2027-03-01"),
  c("ios, smaller build, the first second of the start date", { min_app: MIN }, "ios", 8, "on", "stop"),
  c("ios, equal build, on the start date", { min_app: MIN }, "ios", 9, "on", "ok"),
  c("ios reads its own number, not android's", { min_app: MIN }, "ios", 11, "on", "ok"),
  c("android reads its own number, not ios's", { min_app: MIN }, "android", 9, "on", "stop"),
  c("a start date in the past with the lowest build stops nothing", { min_app: { android: { build: 1, from: "2026-11-20" }, ios: { build: 1, from: "2026-11-20" } } }, "android", 1, "later", "ok"),
  c("the whole config as the server sends it", { crl_max_age_days: 3, platforms: [{ platform: "threads", display_name: "Threads", username_format: "[a-z0-9._]{1,30}" }], min_app: MIN }, "ios", 8, "week_before", "ok_until", "2027-03-01"),
  c("the largest build", withEntry("android", { build: 2100000000, from: "2027-03-01" }), "android", 2099999999, "on", "stop"),
  c("a start date on a leap day", withEntry("ios", { build: 9, from: "2028-02-29" }), "ios", 8, "later", "ok_until", "2028-02-29"),
  // Ignored.
  c("a member of min_app for another client is ignored", { min_app: { ...MIN, harmonyos: { build: 3, from: "2027-01-01" } } }, "android", 12, "on", "ok"),
  c("the other app's entry is not read, even when it cannot be read", { min_app: { android: MIN.android, ios: "nine" } }, "android", 11, "before", "ok_until", "2027-03-01"),
  c("the other app's entry is not read, even when it is missing", { min_app: { ios: MIN.ios } }, "ios", 9, "on", "ok"),
  c("a member of the entry other than build and from is ignored", withEntry("android", { build: 12, from: "2027-03-01", note: "anything" }), "android", 12, "on", "ok"),
  c("a member of the config other than min_app is ignored", { min_app: MIN, something_new: [1, 2] }, "android", 12, "on", "ok"),
  // Unreadable: the app does not go on.
  c("no min_app", { crl_max_age_days: 3, platforms: [] }, "android", 12, "on", "unreadable"),
  c("min_app is null", { min_app: null }, "android", 12, "on", "unreadable"),
  c("min_app is an array", { min_app: [MIN.android, MIN.ios] }, "android", 12, "on", "unreadable"),
  c("min_app is a string", { min_app: "12" }, "ios", 9, "on", "unreadable"),
  c("the config is not an object", [{ min_app: MIN }], "android", 12, "on", "unreadable"),
  c("no entry for this app", { min_app: { ios: MIN.ios } }, "android", 12, "on", "unreadable"),
  c("this app's entry is null", withEntry("android", null), "android", 12, "on", "unreadable"),
  c("this app's entry is a number", withEntry("ios", 9), "ios", 9, "on", "unreadable"),
  c("this app's entry is an array", withEntry("ios", [9, "2027-03-01"]), "ios", 9, "on", "unreadable"),
  c("the key is not lowercase", { min_app: { Android: MIN.android, ios: MIN.ios } }, "android", 12, "on", "unreadable"),
  c("no build", withEntry("android", { from: "2027-03-01" }), "android", 12, "on", "unreadable"),
  c("build is a string", withEntry("android", { build: "12", from: "2027-03-01" }), "android", 12, "on", "unreadable"),
  c("build is not a whole number", withEntry("android", { build: 12.5, from: "2027-03-01" }), "android", 13, "on", "unreadable"),
  c("build is 0", withEntry("android", { build: 0, from: "2027-03-01" }), "android", 12, "on", "unreadable"),
  c("build is negative", withEntry("ios", { build: -1, from: "2027-03-01" }), "ios", 9, "on", "unreadable"),
  c("build is above the largest", withEntry("android", { build: 2100000001, from: "2027-03-01" }), "android", 12, "on", "unreadable"),
  c("build is null", withEntry("ios", { build: null, from: "2027-03-01" }), "ios", 9, "on", "unreadable"),
  c("build is true", withEntry("ios", { build: true, from: "2027-03-01" }), "ios", 9, "on", "unreadable"),
  c("unreadable even when this app's build is larger", withEntry("android", { build: "1", from: "2027-03-01" }), "android", 99, "on", "unreadable"),
  c("no from", withEntry("android", { build: 12 }), "android", 12, "on", "unreadable"),
  c("from is null", withEntry("android", { build: 12, from: null }), "android", 13, "on", "unreadable"),
  c("from is a number", withEntry("android", { build: 12, from: 20270301 }), "android", 12, "on", "unreadable"),
  c("from without leading zeros", withEntry("ios", { build: 9, from: "2027-3-1" }), "ios", 9, "on", "unreadable"),
  c("from is a date that does not exist", withEntry("ios", { build: 9, from: "2027-02-30" }), "ios", 9, "on", "unreadable"),
  c("from carries a time", withEntry("android", { build: 12, from: "2027-03-01T00:00:00+08:00" }), "android", 12, "on", "unreadable"),
  c("from is after 2049", withEntry("android", { build: 12, from: "2050-01-01" }), "android", 12, "on", "unreadable"),
  c("from has a space after it", withEntry("android", { build: 12, from: "2027-03-01 " }), "android", 12, "on", "unreadable"),
];
for (const x of cases) {
  const v = minAppVerdict(x.config, x.client as AppClient, x.app_build as number, (x.now as number) * 1000);
  const got = v === null ? "unreadable" : v.kind === "ok_until" ? `ok_until ${formatDay(v.from)}` : v.kind;
  const want = x.result === "ok_until" ? `ok_until ${x.from}` : x.result;
  if (got !== want) throw new Error(`${x.name}: src/min-app.ts gives ${got}, the case says ${want}`);
}
const doc = {
  spec: "min-app",
  status: "draft",
  note: "Each case: the parsed body of GET /api/v1/config, the client (the app: android or ios), the app's own build number, the device clock's time (now: seconds since the epoch, UTC; now_in_taiwan only for reading), and the verdict. from is given for ok_until.",
  generated_by: "protocol/test/generate/min-app.ts",
  cases,
};
writeFileSync(new URL("../../../spec/vectors/min-app.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
