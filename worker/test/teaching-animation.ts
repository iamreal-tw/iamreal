// Reading the timelines of the teaching animations (design/motion/) and their
// answers (spec/vectors/teaching-animation.json) for the tests, and comparing
// two states as the answers are meant to be compared: numbers within the
// file's tolerance, everything else the same.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HangState, HangTimeline, SenseState, SenseTimeline } from "../src/teaching-animation.ts";
import { WORKER_DIR } from "./build.ts";

export const MOTION_DIR = join(WORKER_DIR, "..", "design", "motion");
export const VECTORS_FILE = join(WORKER_DIR, "..", "spec", "vectors", "teaching-animation.json");

/** Numbers of two states this near are the same number (the answers are written to six decimals). */
export const TOLERANCE = 0.000001;

export interface Vectors {
  description: string;
  timelines: { hang: string; sense: string };
  tolerance: number;
  hang: { name: string; variant: string; seconds: number; state: HangState }[];
  sense: { name: string; variant: string; seconds: number; state: SenseState }[];
}

export const hangTimeline = (): HangTimeline => JSON.parse(readFileSync(join(MOTION_DIR, "hang.json"), "utf8")) as HangTimeline;
export const senseTimeline = (): SenseTimeline => JSON.parse(readFileSync(join(MOTION_DIR, "sense.json"), "utf8")) as SenseTimeline;
export const vectors = (): Vectors => JSON.parse(readFileSync(VECTORS_FILE, "utf8")) as Vectors;

/** Where `got` differs from `want`, as a path into the state; null when they are the same. */
export function difference(got: unknown, want: unknown, tolerance: number, path = "state"): string | null {
  if (typeof got === "number" && typeof want === "number") return Math.abs(got - want) <= tolerance ? null : `${path}: ${got}, not ${want}`;
  if (got === null || want === null || typeof got !== "object" || typeof want !== "object") return got === want ? null : `${path}: ${JSON.stringify(got)}, not ${JSON.stringify(want)}`;
  const a = got as Record<string, unknown>;
  const b = want as Record<string, unknown>;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(key in a)) return `${path}.${key}: missing`;
    if (!(key in b)) return `${path}.${key}: not in the answer`;
    const d = difference(a[key], b[key], tolerance, `${path}.${key}`);
    if (d !== null) return d;
  }
  return null;
}
