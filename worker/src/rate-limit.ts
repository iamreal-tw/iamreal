// The per-IP limits of ADR-0026, its third layer: Workers' Rate Limiting
// binding, one binding to a class of request, each with its own limit in
// wrangler.jsonc ("ratelimits"). What the binding counts is a key this
// file makes: the class and where the request came from. Below them, the
// site-wide limit, which is not a binding (`withinStarts`, starts.ts).
//
// - An IPv4 address is counted by itself; an IPv6 address by its /64, since
//   one machine usually has a whole /64 to take addresses from.
// - The classes are counted apart: a network that is stopped from one is
//   not stopped from another.
// - A request without an address, or from this computer itself (the
//   loopback addresses), is not counted. On Cloudflare every request has
//   `CF-Connecting-IP`, and it is never a loopback address; a local
//   workerd gives a request that carries none the loopback address it came
//   from, so the Worker run on a developer's computer, and a card proof
//   with a real card against it, are not limited.
//
// The binding answers yes or no and nothing else: not how many requests are
// left, nor when the count starts again. Its period here is 60 seconds, so
// a request that is turned away is told to come back in 60 (`Retry-After`),
// which is the longest it can take. The count is Cloudflare's and
// approximate
// (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):
// the limits stop one source's flood, they do not meter anyone. Measured on
// the test site, the count is one to each of Cloudflare's machines, not one
// to each location: 50 requests over one connection were turned away from
// the 30th on, 100 that each opened a connection were all let through. So
// these limits stop a network that sends many requests over one
// connection; one that opens a connection for each is for the WAF's rule,
// the second layer of ADR-0026 (README.md, "限流").
//
// Nothing is written for a request that is turned away, here or in the
// connection log (ADR-0022).

/** The classes of request that are counted apart. */
export type RateClass = "challenges" | "card_state" | "records" | "public_reads" | "pages" | "counts";

/** The binding of each class (wrangler.jsonc, "ratelimits"). */
const BINDINGS: Readonly<Record<RateClass, "RATE_CHALLENGES" | "RATE_CARD_STATE" | "RATE_RECORDS" | "RATE_PUBLIC_READS" | "RATE_PAGES" | "RATE_COUNTS">> = {
  challenges: "RATE_CHALLENGES",
  card_state: "RATE_CARD_STATE",
  records: "RATE_RECORDS",
  public_reads: "RATE_PUBLIC_READS",
  pages: "RATE_PAGES",
  counts: "RATE_COUNTS",
};

/** The period of every binding, in seconds, and so what `Retry-After` says. */
export const RETRY_AFTER_SECONDS = 60;

const IPV4 = /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

/**
 * The 8 groups of an IPv6 address as numbers, or null if the text is not
 * one: groups of 1 to 4 hex digits, at most one `::`, and in the last two
 * groups' place possibly an IPv4 address.
 */
function ipv6Groups(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [i, piece] of pieces.entries()) {
      if (last && i === pieces.length - 1 && IPV4.test(piece)) {
        const [a, b, c, d] = piece.split(".").map(Number) as [number, number, number, number];
        out.push(a * 256 + b, c * 256 + d);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) out.push(parseInt(piece, 16));
      else return null;
    }
    return out;
  };
  const head = groupsOf(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groupsOf(halves[1]!, true) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  // `::` stands for one group of zeros at least.
  if (head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

/**
 * What an address is counted as: an IPv4 address as it is, an IPv6 address
 * as its first 64 bits, written one way whatever way the address was
 * written. An IPv4 address written as IPv6 (`::ffff:192.0.2.1`) is that
 * IPv4 address. Null for a text that is no address: nothing is counted
 * under a key someone could make up.
 */
export function networkOf(ip: string): string | null {
  if (IPV4.test(ip)) return ip;
  const groups = ipv6Groups(ip);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** Whether a network (`networkOf`) is this computer's own: 127.0.0.0/8, or the /64 of `::1`. */
const isLoopback = (network: string): boolean => network.startsWith("127.") || network === "0:0:0:0::/64";

/**
 * The key a request is counted under: its class and its network; null for
 * a request that is not counted (no address, a loopback address). One
 * function makes it, so that a later kind of key (a key issued to a caller
 * of a lookup API, ADR-0026) changes this and nothing else.
 */
export function rateKey(kind: RateClass, ip: string | null): string | null {
  const network = ip === null ? null : networkOf(ip);
  return network === null || isLoopback(network) ? null : `${kind}:${network}`;
}

/**
 * Whether this request is within its class's limit, and counts it. A
 * request that has no key is. If the binding fails or is not there, the
 * request is let through, and one line in the live log says which class
 * is not limited: a limit that cannot be asked must not stop everyone, and
 * must not go unnoticed either. The line has nothing of the request.
 */
export async function withinLimit(env: Env, kind: RateClass, request: Request): Promise<boolean> {
  const key = rateKey(kind, request.headers.get("CF-Connecting-IP"));
  if (key === null) return true;
  try {
    return (await env[BINDINGS[kind]].limit({ key })).success;
  } catch (e) {
    console.error(JSON.stringify({ event: "rate_limit_unavailable", class: kind, error: e instanceof Error ? e.name : "unknown" }));
    return true;
  }
}

/**
 * The site-wide limit of ADR-0026: how many card proofs may start in a
 * minute, whoever starts them. A card proof starts when the cardholder
 * presses the button that begins it, and the client then asks for
 * `GET /api/v1/config?start` (docs/api/card-proof.md); only that request
 * is counted here, so the count is of people starting, not of the other
 * times a client asks for `config`. A request without an address is
 * counted too: there is no network to leave out.
 *
 * Not a binding like the limits above: with one key for the whole site, the
 * binding's count on each of Cloudflare's machines let a minute's limit
 * through on every machine a request came in on (README.md, "全站的總量上限").
 * The count is kept by one Durable Object of its own (starts.ts), so it is
 * one for the whole site, every location together.
 */
const STARTS_OBJECT = "starts";

/** The most card proofs a minute may be set to let start. */
const MOST_STARTS_PER_MINUTE = 100_000;

/**
 * How many card proofs may start in a minute (`CARD_PROOF_STARTS_PER_MINUTE`,
 * wrangler.jsonc): plain digits, 0 to 100,000. Throws for anything else.
 */
function startsPerMinuteOf(env: Env): number {
  const set: unknown = (env as { CARD_PROOF_STARTS_PER_MINUTE?: unknown }).CARD_PROOF_STARTS_PER_MINUTE;
  if (typeof set !== "string" || !/^(0|[1-9][0-9]{0,5})$/.test(set) || Number(set) > MOST_STARTS_PER_MINUTE) throw new Error("CARD_PROOF_STARTS_PER_MINUTE is not a number of starts");
  return Number(set);
}

/**
 * Whether one more card proof may start this minute, and counts it. An
 * object that fails or is not there, or a setting that cannot be read, lets
 * it start, and says so in the live log, as a binding of the limits above
 * does. An overloaded object is one of those: the proof log's object, asked
 * next, answers `busy` itself when it is overloaded (api.ts).
 */
export async function withinStarts(env: Env): Promise<boolean> {
  try {
    const perMinute = startsPerMinuteOf(env);
    return await env.STARTS.get(env.STARTS.idFromName(STARTS_OBJECT)).start(perMinute);
  } catch (e) {
    console.error(JSON.stringify({ event: "rate_limit_unavailable", class: "starts", error: e instanceof Error ? e.name : "unknown" }));
    return true;
  }
}

/**
 * Whether a call to the proof log's object was turned away because the
 * object is overloaded: Cloudflare sets `overloaded` on such an error, and
 * says not to retry it at once
 * (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).
 * The API answers `503` `busy` and a page answers the page of too many
 * people (ADR-0026, "Durable Object 撐不住時").
 */
export function isOverloaded(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; typeof x === "object" && x !== null && depth < 4; x = (x as { cause?: unknown }).cause, depth++) {
    if ((x as { overloaded?: unknown }).overloaded === true) return true;
  }
  return false;
}
