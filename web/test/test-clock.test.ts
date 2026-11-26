// The clock of the headless browser test (test/e2e/clock.ts): its dates do
// not change while it runs, whenever it starts, so that what it expects and
// what the page shows fall on the same date (#219: a run that crossed
// midnight in Taiwan failed two checks).
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_HOURS, anchorOffset, taiwanDate } from "./e2e/clock.ts";

const at = (iso: string): number => Date.parse(iso);
const HOUR = 3_600_000;

test("Taiwan's date of an instant: UTC+8, the day changing at 16:00 UTC", () => {
  assert.equal(taiwanDate(at("2026-11-20T15:59:59Z")), "2026-11-20");
  assert.equal(taiwanDate(at("2026-11-20T16:00:00Z")), "2026-11-21");
});

test("a run that starts one second before midnight in Taiwan keeps its date for as long as a run takes", () => {
  const start = at("2026-11-20T23:59:59+08:00");
  const offset = anchorOffset(start);
  // The test's clocks start at noon in Taiwan of the machine's date.
  assert.equal(start + offset, at("2026-11-20T12:00:00+08:00"));
  for (let ms = 0; ms <= RUN_HOURS * HOUR; ms += 60_000) assert.equal(taiwanDate(start + ms + offset), "2026-11-20", `${ms / 60_000} minutes in`);
  // The machine's own clock has moved to the next day by then; the test's has not.
  assert.equal(taiwanDate(start + 2_000), "2026-11-21");
});

test("whenever a run starts, its clocks start at noon in Taiwan of that date, and keep the date for RUN_HOURS", () => {
  for (const iso of ["2026-11-20T00:00:00+08:00", "2026-11-20T00:00:01+08:00", "2026-11-20T11:59:59+08:00", "2026-11-20T12:00:00+08:00", "2026-11-20T18:30:00+08:00", "2026-11-20T23:59:59.999+08:00"]) {
    const start = at(iso);
    const offset = anchorOffset(start);
    assert.equal(start + offset, at("2026-11-20T12:00:00+08:00"), iso);
    assert.equal(taiwanDate(start + RUN_HOURS * HOUR + offset), "2026-11-20", iso);
  }
  // A run longer than 12 hours would cross midnight: RUN_HOURS stays below it.
  assert.ok(RUN_HOURS < 12);
});
