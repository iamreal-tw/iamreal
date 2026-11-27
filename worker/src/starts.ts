// The object that keeps the site-wide limit of ADR-0026: how many card
// proofs have started in the current minute, for the whole site
// (rate-limit.ts, `withinStarts`, asks it). One object for the environment,
// so the count is one, wherever a request comes in: a Rate Limiting binding
// keeps a count on each of Cloudflare's machines, and a minute of starts
// spread over many of them passed the binding's limit many times over
// (README.md, "全站的總量上限").
//
// - It is an object of its own, not the counts' object (counts.ts): counts
//   may come in as fast as each network's limit lets them, and an object
//   overloaded by them must not be the one a card proof starts through.
// - The minutes are those of the clock (UTC). A start that is turned away is
//   not counted, so a minute of refusals does not lengthen the wait.
// - The count is held in memory and nothing is stored: a write for each
//   start would cost more than the count is worth. Cloudflare takes an idle
//   object out of memory after 10 seconds, unless a timer is still to run
//   (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/;
//   counts.ts does the same), so a minute that has a start has a timer that
//   runs out when the minute is over: a burst, then 10 quiet seconds, does
//   not start the minute again at zero. When the object is stopped all the
//   same (a deploy, Cloudflare moving it), the minute starts again at zero:
//   that lets more start, never fewer.
import { DurableObject } from "cloudflare:workers";
import { now } from "#target";

export class Starts extends DurableObject<Env> {
  /** The minute the count is of, as minutes since the epoch, or null before the first start. */
  #minute: number | null = null;
  #started = 0;
  /** The timer that keeps the object in memory until the minute of the count is over. */
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** Whether one more card proof may start this minute, of at most `perMinute`; counts it if it may. */
  start(perMinute: number): boolean {
    const minute = Math.floor(now().getTime() / 60_000);
    if (minute !== this.#minute) {
      this.#minute = minute;
      this.#started = 0;
    }
    if (this.#started >= perMinute) return false;
    this.#started++;
    this.#keepUntilOver();
    return true;
  }

  /** Starts the timer that runs out when the clock's minute is over, unless it runs already. */
  #keepUntilOver(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => (this.#timer = null), 60_000 - (Date.now() % 60_000));
  }
}
