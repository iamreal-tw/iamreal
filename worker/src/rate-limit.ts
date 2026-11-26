// The per-IP limits of ADR-0026, its third layer: Workers' Rate Limiting
// binding, one binding to a class of request, each with its own limit in
// wrangler.jsonc ("ratelimits"). What the binding counts is a key this
// file makes: the class and where the request came from.
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
// which is the longest it can take. The count is Cloudflare's, apart in
// each of its locations and approximate
// (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):
// the limits stop one source's flood, they do not meter anyone.
//
// Nothing is written for a request that is turned away, here or in the
// connection log (ADR-0022).

/** The classes of request that are counted apart. */
export type RateClass = "challenges" | "card_state" | "records" | "public_reads" | "pages";

/** The binding of each class (wrangler.jsonc, "ratelimits"). */
const BINDINGS: Readonly<Record<RateClass, "RATE_CHALLENGES" | "RATE_CARD_STATE" | "RATE_RECORDS" | "RATE_PUBLIC_READS" | "RATE_PAGES">> = {
  challenges: "RATE_CHALLENGES",
  card_state: "RATE_CARD_STATE",
  records: "RATE_RECORDS",
  public_reads: "RATE_PUBLIC_READS",
  pages: "RATE_PAGES",
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
