// The counts (spec/counts.md; ADR-0032, ADR-0039): the table every value of
// a count is chosen from, and the one reader that says whether a count is
// taken. The server reads what it receives with `readCount`; the card proof
// page builds what it sends from the same table, and its tests read what it
// sent with the same reader.
//
// A count holds nothing but what is here: codes of the table, three random
// IDs, and four values checked by their format (a short ID, version
// numbers, a card reader's name, the domain a visitor came from). No time, no account, no scoped ID, nothing
// read from a card, a certificate or a CRL, and no text of an error.

/** The clients (GLOSSARY, "client"). */
export const CLIENTS = ["web", "android", "ios"] as const;
export type Client = (typeof CLIENTS)[number];

const ALL: readonly Client[] = CLIENTS;
const WEB: readonly Client[] = ["web"];
const APPS: readonly Client[] = ["android", "ios"];

/** Which clients a code of the table is for. */
type Codes = Readonly<Record<string, readonly Client[]>>;

/** What a count says happened. */
export const EVENTS = ["page", "step", "stop", "retry", "action", "duration"] as const;
export type CountEvent = (typeof EVENTS)[number];

/** The kinds of visitors' pages (worker/src/visitor.ts names them the same). `card` is a proof page, and carries its short ID. */
export const PAGES = ["home", "card", "account", "proof_log", "faq", "verify", "check", "prepare", "privacy", "hang"] as const;

/**
 * The steps of a card proof, in the order a card proof reaches them (the
 * checks from `config` to `tree` run together and come in any order).
 * `component` is the card reader's component of the web page.
 */
export const STEPS = {
  open: ALL,
  read: ALL,
  component: WEB,
  certificates: ALL,
  certificate: ALL,
  config: ALL,
  circuit: ALL,
  engine: ALL,
  crl: ALL,
  tree: ALL,
  checked: ALL,
  pin: ALL,
  scope_signed: ALL,
  state: ALL,
  chosen: ALL,
  confirmed: ALL,
  challenge: ALL,
  code_signed: ALL,
  proved: ALL,
  done: ALL,
} as const satisfies Codes;
export type Step = keyof typeof STEPS;

/** Why a card proof stopped (`stop`), or why a step must be tried again (`retry`). */
export const REASONS = {
  // The card.
  component_unreachable: WEB,
  no_reader: WEB,
  no_card: WEB,
  popup_blocked: WEB,
  nfc_off: APPS,
  no_nfc: APPS,
  no_tap: APPS,
  tap_cancelled: APPS,
  other_card: APPS,
  pin_maybe_received: APPS,
  channel: APPS,
  first_generation: APPS,
  pin_incorrect: ALL,
  card_locked: ALL,
  card_error: ALL,
  card_signature: ALL,
  // The certificate.
  no_certificate: ALL,
  cert_expired: ALL,
  cert_not_yet_valid: ALL,
  cert_not_citizen_primary: ALL,
  cert_unsupported_format: ALL,
  cert_unknown_issuer: ALL,
  cert_ambiguous: ALL,
  // The CRL.
  crl_unavailable: ALL,
  crl_hash: ALL,
  crl_unusable: ALL,
  crl_rollback: ALL,
  crl_stale: ALL,
  revoked: ALL,
  // The device's own work.
  artifact: ALL,
  engine: ALL,
  proof_check: ALL,
  challenge_malformed: ALL,
  challenge_not_today: ALL,
  date_changed: ALL,
  idle: ALL,
  state: ALL,
  app_too_old: APPS,
  // The list.
  username: ALL,
  blocked_switch_limit: ALL,
  blocked_empty: ALL,
  blocked_daily_limit: ALL,
  // The server: no answer, an answer the device cannot read, or the code it answered.
  server_network: ALL,
  server_malformed_response: ALL,
  server_paused: ALL,
  server_rate_limited: ALL,
  server_busy: ALL,
  server_internal: ALL,
  server_crl_stale: ALL,
  server_challenge_unknown: ALL,
  server_challenge_used: ALL,
  server_challenge_attempts: ALL,
  server_proof: ALL,
  server_root: ALL,
  server_date_order: ALL,
  server_empty: ALL,
  server_switch_limit: ALL,
  server_daily_limit: ALL,
  server_switch_restricted: ALL,
  server_malformed: ALL,
  server_scope: ALL,
  server_platform: ALL,
  server_other: ALL,
} as const satisfies Codes;
export type Reason = keyof typeof REASONS;

/** The actions of a card proof. `tap_dropped` carries which tap it was (`tap`). */
export const CARD_PROOF_ACTIONS = {
  tap_dropped: APPS,
  resubmit: ALL,
} as const satisfies Codes;
export type CardProofAction = keyof typeof CARD_PROOF_ACTIONS;

/** The actions of a visitor on a page. */
export const VISITOR_ACTIONS = {
  start_card_proof: WEB,
  download_app_android: WEB,
  download_app_ios: WEB,
  copy_proof_link: WEB,
} as const satisfies Codes;

/** The taps of an app's card proof: reading the certificate, signing the scope string, signing the declaration code. */
export const TAPS = ["1", "2", "3"] as const;

/** The steps whose time is counted (`duration`). */
export const TIMED_STEPS = { crl: ALL, tree: ALL, proved: ALL } as const satisfies Codes;
export type TimedStep = keyof typeof TIMED_STEPS;

/** How long a timed step took: under 1 s, 1 to 3 s, … over 3 minutes. */
export const DURATIONS = ["lt_1s", "1s_3s", "3s_10s", "10s_30s", "30s_60s", "1m_3m", "gt_3m"] as const;
export type Duration = (typeof DURATIONS)[number];

/** Where each of DURATIONS but the last ends, in milliseconds: a duration holds its start and not its end. */
const DURATION_ENDS_MS = [1_000, 3_000, 10_000, 30_000, 60_000, 180_000] as const;

/**
 * The duration of a timed step that took `ms` milliseconds (spec/counts.md,
 * "Durations"). A time below 0, or one that is not a finite number (a clock
 * that went back, or none), is no duration: null, and no count is sent.
 */
export function tookOf(ms: number): Duration | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const i = DURATION_ENDS_MS.findIndex((end) => ms < end);
  return DURATIONS[i === -1 ? DURATIONS.length - 1 : i]!;
}

/**
 * Where a visitor came from, as far as it is told apart for now: with a
 * `Referer` or without. The classes of apps' built-in browsers wait for a
 * measurement (ADR-0032). A page's count says the first by its `source`, the
 * `Referer`'s domain, and the second by having none.
 */
export const SOURCES = ["none", "domain"] as const;

/** Browsers and operating systems, without versions. */
export const BROWSERS = ["chrome", "edge", "firefox", "safari", "samsung", "other"] as const;
export type Browser = (typeof BROWSERS)[number];
export const OSES = ["windows", "macos", "linux", "chromeos", "android", "ios", "other"] as const;
export type Os = (typeof OSES)[number];

/**
 * Where a visitor's page keeps the visit ID, in the tab's `sessionStorage`
 * (worker/site/count.js). The card proof page takes it away when it opens,
 * without reading it: a visitor's page opened after a card proof has a new
 * one (ADR-0039, "過卡之後換造訪編號").
 */
export const VISIT_ID_KEY = "iamreal.visit_id";

/** A random ID: 16 bytes as 32 lowercase hex digits (`visit_id`, `device_id`, `attempt_id`). */
export const COUNT_ID = /^[0-9a-f]{32}$/;
/** A short ID as a page writes it: 10 characters of the base32 alphabet (spec/scoped-id.md). */
const SHORT_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/;
/** A version number: digits and dots, at most four parts of at most five digits. */
export const VERSION = /^[0-9]{1,5}(?:\.[0-9]{1,5}){0,3}$/;
/** A card reader's name: letters, digits and spaces, 1 to 64 of them. */
export const READER = /^[A-Za-z0-9 ]{1,64}$/;
/** The domain a visitor came from (`source`): lowercase ASCII letters, digits, dots and hyphens, 1 to 253 of them, the longest a domain name is written in. */
export const SOURCE = /^[a-z0-9.-]{1,253}$/;

/** A count that was taken: its members in the order of spec/counts.md, and no other. */
export type Count = Readonly<Record<string, string>>;

/** The members of a count, in the one order a taken count is written in. */
const ORDER = ["client", "event", "page", "short_id", "source", "step", "reason", "action", "tap", "took", "visit_id", "device_id", "attempt_id", "browser", "os", "browser_version", "os_version", "app_version", "reader"] as const;
type Member = (typeof ORDER)[number];

const has = (list: readonly string[], x: string | undefined): boolean => x !== undefined && list.includes(x);
const isFor = (codes: Codes, code: string | undefined, client: string): boolean => code !== undefined && Object.hasOwn(codes, code) && codes[code]!.includes(client as Client);

/**
 * What each member must be, given the rest of the count: true if this
 * count has it right. A member that is not asked for here is one the
 * count may not have.
 */
type Rule = (value: string, count: Readonly<Record<string, string>>) => boolean;

/** The members a visitor's count has besides its own. */
const VISITOR: Readonly<Partial<Record<Member, Rule>>> = {
  visit_id: (v) => COUNT_ID.test(v),
  browser: (v) => has(BROWSERS, v),
  os: (v) => has(OSES, v),
};

/** The members a card proof's count has besides its own, and those it may have (`OPTIONAL`). */
const CARD_PROOF: Readonly<Partial<Record<Member, Rule>>> = {
  device_id: (v) => COUNT_ID.test(v),
  attempt_id: (v) => COUNT_ID.test(v),
  browser: (v, c) => c["client"] === "web" && has(BROWSERS, v),
  os: (v, c) => c["client"] === "web" && has(OSES, v),
  browser_version: (v, c) => c["client"] === "web" && VERSION.test(v),
  os_version: (v) => VERSION.test(v),
  app_version: (v, c) => c["client"] !== "web" && VERSION.test(v),
  reader: (v, c) => c["client"] === "web" && READER.test(v),
};

/** Members a count may leave out. `browser` and `os` only where the client is an app, which has none. */
const optional = (member: Member, client: string, event: string): boolean =>
  member === "browser_version" ||
  member === "os_version" ||
  member === "app_version" ||
  member === "reader" ||
  member === "source" ||
  (member === "short_id" && event === "action") ||
  ((member === "browser" || member === "os") && client !== "web");

/** The rules of one count's members, by what it says happened; null if it says nothing the table has. */
function rulesOf(c: Readonly<Record<string, string>>): Readonly<Partial<Record<Member, Rule>>> | null {
  const client = c["client"]!;
  switch (c["event"]) {
    case "page":
      if (client !== "web") return null;
      return { page: (v) => has(PAGES, v), ...(c["page"] === "card" && { short_id: (v: string) => SHORT_ID.test(v) }), source: (v) => SOURCE.test(v), ...VISITOR };
    case "step":
      return { step: (v) => isFor(STEPS, v, client), ...CARD_PROOF };
    case "stop":
    case "retry":
      return { reason: (v) => isFor(REASONS, v, client), ...CARD_PROOF };
    case "duration":
      return { step: (v) => isFor(TIMED_STEPS, v, client), took: (v) => has(DURATIONS, v), ...CARD_PROOF };
    case "action":
      // Pressed on a proof page, a visitor's action carries the page's short ID too.
      if (isFor(VISITOR_ACTIONS, c["action"], client)) return { action: () => true, short_id: (v) => SHORT_ID.test(v), ...VISITOR };
      if (!isFor(CARD_PROOF_ACTIONS, c["action"], client)) return null;
      return { action: () => true, ...(c["action"] === "tap_dropped" && { tap: (v: string) => has(TAPS, v) }), ...CARD_PROOF };
    default:
      return null;
  }
}

/**
 * Reads a parsed count (spec/counts.md, "Taking a count"): the count as it
 * is kept, or null if it is dropped. It is dropped whole when anything in
 * it is not as the table has it: a member the count may not have, one it
 * must have and has not, a value that is no string, a code the table has
 * not or has for another client, an ID or a version or a reader's name not
 * in its format.
 */
export function readCount(parsed: unknown): Count | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const given = parsed as Record<string, unknown>;
  // Without a prototype: a member named `__proto__` is a member like any other, and one the table has not.
  const count = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(given)) {
    if (typeof value !== "string") return null;
    count[name] = value;
  }
  if (!has(CLIENTS, count["client"])) return null;
  const rules = rulesOf(count);
  if (rules === null) return null;
  const members: readonly string[] = ["client", "event", ...Object.keys(rules)];
  for (const name of Object.keys(count)) if (!members.includes(name)) return null;
  const kept: Record<string, string> = {};
  for (const member of ORDER) {
    const value = count[member];
    if (member === "client" || member === "event") kept[member] = value!;
    else {
      const rule = rules[member];
      if (rule === undefined) continue;
      if (value === undefined) {
        if (optional(member, count["client"]!, count["event"]!)) continue;
        return null;
      }
      if (!rule(value, count)) return null;
      kept[member] = value;
    }
  }
  return kept;
}

/** `readCount` of a text: null also when the text is not JSON. */
export function readCountText(text: string): Count | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return readCount(parsed);
}
