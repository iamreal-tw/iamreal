// The minimum app version (spec/min-app.md): how an app reads `min_app` from
// the server's `config` and whether this build may do a card proof. The web
// page does not read it; the server writes it (worker/src/min-app.ts) and
// its tests read what it sends with this.
import { type Day, parseDay, taiwanDay } from "./date.ts";

/** The apps' platforms: the member names of `min_app`. */
export type AppPlatform = "android" | "ios";

/** One app's entry of `min_app`. */
export interface MinAppEntry {
  /** The lowest build that may still do a card proof. */
  readonly build: number;
  /** The date in Taiwan the bound starts on. */
  readonly from: Day;
}

/** The largest `versionCode` Google Play allows; `build` is at most this. */
export const MAX_BUILD = 2_100_000_000;

export type MinAppVerdict =
  /** The app goes on as usual. */
  | { readonly kind: "ok" }
  /** The app goes on as usual, and says that from `from` this version can no longer do a card proof. */
  | { readonly kind: "ok_until"; readonly from: Day }
  /** The app does not ask for the PIN or read the card: it must be updated. */
  | { readonly kind: "stop" };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The entry of `platform` in the parsed body of `config`, or null if the
 * field cannot be read (spec/min-app.md, "Reading it"). Every other member
 * is ignored.
 */
export function readMinAppEntry(config: unknown, platform: AppPlatform): MinAppEntry | null {
  if (!isObject(config) || !Object.hasOwn(config, "min_app")) return null;
  const minApp = config["min_app"];
  if (!isObject(minApp) || !Object.hasOwn(minApp, platform)) return null;
  const entry = minApp[platform];
  if (!isObject(entry)) return null;
  const { build, from } = entry;
  if (typeof build !== "number" || !Number.isInteger(build) || build < 1 || build > MAX_BUILD) return null;
  const day = typeof from === "string" ? parseDay(from) : null;
  return day === null ? null : { build, from: day };
}

/**
 * The verdict for an app of `platform` whose own build is `appBuild`, at the
 * device clock's `nowMs` (milliseconds since the epoch), from the parsed body
 * of `config`; null when the field cannot be read, and the app does not go on
 * (spec/min-app.md, "What the app does").
 */
export function readMinApp(config: unknown, platform: AppPlatform, appBuild: number, nowMs: number): MinAppVerdict | null {
  const entry = readMinAppEntry(config, platform);
  if (entry === null) return null;
  if (appBuild >= entry.build) return { kind: "ok" };
  return taiwanDay(nowMs) < entry.from ? { kind: "ok_until", from: entry.from } : { kind: "stop" };
}
