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
// - The count is held in memory and nothing is stored. When the object is
//   stopped (a deploy, Cloudflare moving it, or 10 seconds with no start,
//   https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
//   the minute starts again at zero: that lets more start, never fewer, and
//   10 seconds with no start is a minute far below any limit.
import { DurableObject } from "cloudflare:workers";
import { now } from "#target";

export class Starts extends DurableObject<Env> {
  /** The minute the count is of, as minutes since the epoch, or null before the first start. */
  #minute: number | null = null;
  #started = 0;

  /** Whether one more card proof may start this minute, of at most `perMinute`; counts it if it may. */
  start(perMinute: number): boolean {
    const minute = Math.floor(now().getTime() / 60_000);
    if (minute !== this.#minute) {
      this.#minute = minute;
      this.#started = 0;
    }
    if (this.#started >= perMinute) return false;
    this.#started++;
    return true;
  }
}
