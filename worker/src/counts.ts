// The counts the back end takes (ADR-0032, ADR-0039; spec/counts.md):
// `POST /api/v1/counts` (api.ts) reads a count against the table and hands
// one that is taken to the object here, which is not the proof log's object
// and never asks it. The object holds the counts of the current minute in
// memory and writes each minute as one file into the bucket that is not
// public, under `count-events/`, where the bucket's lifecycle rule deletes
// after 31 days (README.md, "計數").
//
// - What reaches the object is a count as `readCount` rebuilt it, member by
//   member from the table, and how many a minute may hold. Nothing of the
//   request: no address, no header, no request ID. So a file holds no IP
//   address, and a count is in no connection log.
// - A minute's file says which minute it is (UTC, the time the counts were
//   received), the counts in the order they came, and how many more came
//   and were not kept. A count has no time of its own.
// - A minute holds `COUNT_EVENTS_PER_MINUTE` counts at most. One over that
//   is not kept: the file only says how many there were. How much is
//   stored is not up to whoever sends counts.
// - The minute in memory is lost when the object is stopped (a deploy, or
//   Cloudflare moving it). The counts are for the operator to look at and
//   decide nothing: none is made up for.
// - Cloudflare takes an object that is idle out of memory, after 10 seconds
//   for one that can hibernate, and what it held in memory is then gone; a
//   timer that is still to run keeps it in memory
//   (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/,
//   read 2026-11-26: "No setTimeout/setInterval scheduled callbacks are
//   set" among the conditions of hibernation). So a minute that holds counts
//   has a timer that runs when it is over and writes it. The alarm, which
//   is stored, is set as well: it writes the minute if the timer did not.
import { DurableObject } from "cloudflare:workers";
import { now } from "#target";
import type { Count } from "iamreal-protocol/counts.ts";

/**
 * Under this prefix, and under no other, the bucket's lifecycle rule
 * deletes the counts after 31 days. The totals, which are kept, are under
 * `count-totals/`; the connection log is under `connection/`. None of the
 * three names begins with another.
 */
export const COUNT_EVENTS_PREFIX = "count-events/";

/** Where the date of the oldest file of counts is published, in the bucket of the public data. */
export const COUNT_EVENTS_OLDEST_KEY = "count-events/oldest.json";

/** The most counts a minute may be set to hold. */
const MOST_PER_MINUTE = 100_000;

/**
 * How many counts a minute holds (`COUNT_EVENTS_PER_MINUTE`, wrangler.jsonc):
 * plain digits, 0 to 100,000. Throws for anything else: a setting that
 * cannot be read keeps no count rather than any number of them.
 */
export function countsPerMinuteOf(env: Env): number {
  const set: unknown = (env as { COUNT_EVENTS_PER_MINUTE?: unknown }).COUNT_EVENTS_PER_MINUTE;
  if (typeof set !== "string" || !/^(0|[1-9][0-9]{0,5})$/.test(set) || Number(set) > MOST_PER_MINUTE) throw new Error("COUNT_EVENTS_PER_MINUTE is not a number of counts");
  return Number(set);
}

/** The minute of a time, in UTC: `2026-11-26T14:05Z`. */
export const minuteOf = (time: Date): string => `${time.toISOString().slice(0, 16)}Z`;

/** The key of a minute's file: the prefix, its date, then the minute, so that a day's files list in order. */
export const keyOfMinute = (minute: string): string => `${COUNT_EVENTS_PREFIX}${minute.slice(0, 10)}/${minute}.json`;

/** A minute's file: the minute, its counts, and how many more came than it holds. */
export const minuteFile = (minute: string, counts: readonly Count[], dropped: number): string => `${JSON.stringify({ minute, counts, dropped })}\n`;

/** The one object that takes the counts of this environment. */
export function countsOf(env: Env): DurableObjectStub<Counts> {
  return env.COUNTS.get(env.COUNTS.idFromName("counts"));
}

export class Counts extends DurableObject<Env> {
  /** The minute the counts in memory are of, or null when there are none. */
  #minute: string | null = null;
  #counts: Count[] = [];
  #dropped = 0;
  /** The timer that writes the minute in memory when it is over, and keeps the object in memory until then. */
  #timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Takes one count: kept in memory until its minute is over, or, in a
   * minute that already holds `perMinute`, only counted.
   */
  async add(count: Count, perMinute: number): Promise<void> {
    const minute = minuteOf(now());
    // The alarm is what writes a minute; this is for one that rang late, or not at all.
    if (this.#minute !== null && this.#minute !== minute) await this.#write();
    // Kept before anything is awaited: what follows cannot lose it.
    this.#minute ??= minute;
    if (this.#counts.length < perMinute) this.#counts.push(count);
    else this.#dropped++;
    this.#writeWhenOver();
    await this.#ringAfterThisMinute();
  }

  /** Rings when a minute is over: writes it. If counts of a later minute are held by then, it rings again for them. */
  override async alarm(): Promise<void> {
    if (this.#minute !== null && this.#minute !== minuteOf(now())) await this.#write();
    if (this.#minute !== null) await this.#ringAfterThisMinute();
  }

  /** How long until a second after the clock's minute ends, in milliseconds. */
  static #untilOver(): number {
    return 61_000 - (Date.now() % 60_000);
  }

  /** Starts the timer that writes the minute in memory once it is over, unless it runs already. */
  #writeWhenOver(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void (async () => {
        if (this.#minute !== null && this.#minute !== minuteOf(now())) await this.#write();
        // Counts of a minute that is not over yet (they came since, or the clock is a test's): again when it is.
        if (this.#minute !== null) this.#writeWhenOver();
      })();
    }, Counts.#untilOver());
  }

  /**
   * Sets the alarm for a second after the clock's minute ends, unless one
   * is set. An alarm that cannot be set is one line in the live log: the
   * timer writes the minute all the same.
   */
  async #ringAfterThisMinute(): Promise<void> {
    try {
      if ((await this.ctx.storage.getAlarm()) !== null) return;
      await this.ctx.storage.setAlarm(Date.now() + Counts.#untilOver());
    } catch (e) {
      console.error(JSON.stringify({ event: "count_events_alarm_not_set", error: e instanceof Error ? e.name : "unknown" }));
    }
  }

  /**
   * Writes the minute in memory as its file, and holds nothing from then
   * on. What is in memory is taken before the bucket is asked: a count
   * that comes while the file is written is the next minute's. A file that
   * could not be written is one line in the live log, with the minute and
   * the error's class, and its counts are gone.
   */
  async #write(): Promise<void> {
    const minute = this.#minute;
    if (minute === null) return;
    const text = minuteFile(minute, this.#counts, this.#dropped);
    this.#minute = null;
    this.#counts = [];
    this.#dropped = 0;
    try {
      await this.env.CONNECTION_LOG.put(keyOfMinute(minute), text, { httpMetadata: { contentType: "application/json" } });
    } catch (e) {
      console.error(JSON.stringify({ event: "count_events_not_written", minute, error: e instanceof Error ? e.name : "unknown" }));
    }
  }
}
