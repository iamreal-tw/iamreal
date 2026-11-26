// The clock of the headless browser test (ui.ts). The test, the Worker and
// the page each read a clock: the test to know what date the page should
// show, the Worker and the page to date what they do. They all run the
// machine's time plus the same offset, so they agree on the instant.
//
// They would still not agree on the date if each read the machine's time
// near midnight in Taiwan: the test could expect a day the page has left
// already (#219). So the offset starts every run at noon in Taiwan of the
// machine's date: a run, which takes minutes, would have to last twelve
// hours to see the date change by itself. The days the test moves its
// clocks ahead (ui.ts, `setDay`) come on top of it.

const DAY = 86_400_000;
const TAIWAN = 8 * 3_600_000;

/** Taiwan's date (UTC+8, no summer time) of an instant, as YYYY-MM-DD. */
export const taiwanDate = (ms: number): string => new Date(ms + TAIWAN).toISOString().slice(0, 10);

/** How long a run may take, at most, keeping its date: well under the twelve hours from noon to midnight. */
export const RUN_HOURS = 6;

/**
 * How far the test's clocks run ahead of the machine's (behind, if
 * negative) for a run that starts at `machineStart`: to noon in Taiwan of
 * that instant's date, within twelve hours either way.
 */
export function anchorOffset(machineStart: number): number {
  const midnight = Date.parse(`${taiwanDate(machineStart)}T00:00:00+08:00`);
  return midnight + DAY / 2 - machineStart;
}
