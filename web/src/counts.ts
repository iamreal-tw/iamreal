// The counts the card proof page sends (spec/counts.md; ADR-0032,
// ADR-0039): which step a card proof reached, and why it stopped. One
// request to `POST /api/v1/counts` for each, whose answer nobody reads.
//
// - Every value is a code of the table (protocol/src/counts.ts), chosen
//   here, or one of two random IDs. Nothing of a failure but its code: not
//   the text a card, the component, the browser or the server gave, not a
//   file's path, not a date (`reasonOf`). No account, no scoped ID, nothing
//   read from the card.
// - The card proof device ID is 16 random bytes kept in `localStorage`
//   with the date it was made on; 31 days after that date it is replaced,
//   and the old one is not kept anywhere. The submission of a record
//   carries it too (api.ts). The attempt ID is 16 random bytes kept in
//   memory, and dropped when the card proof stops or is done.
// - The browser and the operating system are sent as one of a few names,
//   worked out here from the `User-Agent`, with the versions it holds
//   (`versionsOf`); the text itself is not sent in a count.
// - The card reader's name is the one field the component reports for it,
//   sent only in its form (letters, digits and spaces, at most 64), with
//   every count of the attempt once it is known.
// - How long a timed step took is one of a few durations (`tookOf`), never
//   the time.
// - Sending never holds the card proof up: nothing waits for the request,
//   and one that fails is not sent again. The request is marked to be kept
//   alive, so that the last count of a page being left is still sent.
import { type Day, formatDay, parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import { type Browser, COUNT_ID, type CardProofAction, type Os, READER, REASONS, type Reason, type Step, type TimedStep, VERSION, tookOf } from "iamreal-protocol/counts.ts";
import type { Fetch } from "./api.ts";
import type { Stop } from "./flow.ts";

/** Where the card proof device ID is kept in `localStorage`: `<ID>.<the date it was made on>`. */
export const DEVICE_ID_KEY = "iamreal.card_proof_device_id";

/** After how many days a card proof device ID is replaced, counted from the date it was made on. */
export const DEVICE_ID_DAYS = 31;

/** What the counts use of `localStorage`. */
export interface IdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** 16 random bytes as 32 hex digits. */
const newId = (random: (bytes: Uint8Array) => Uint8Array): string => hex(random(new Uint8Array(16)));

/**
 * The card proof device ID on `today`: the stored one if it was made less
 * than 31 days ago, otherwise a new one, written over the old. A stored
 * value that cannot be read, or is dated after today, is replaced too.
 * If the storage cannot be read or written (a browser that refuses it),
 * `fallback` is used: an ID that lasts as long as the page.
 */
export function deviceIdOn(today: Day, storage: IdStorage, random: (bytes: Uint8Array) => Uint8Array, fallback: () => string): string {
  try {
    const stored = /^([0-9a-f]{32})\.(\d{4}-\d{2}-\d{2})$/.exec(storage.getItem(DEVICE_ID_KEY) ?? "");
    const made = stored === null ? null : parseDay(stored[2]!);
    if (stored !== null && made !== null && made <= today && today - made < DEVICE_ID_DAYS) return stored[1]!;
    const id = newId(random);
    storage.setItem(DEVICE_ID_KEY, `${id}.${formatDay(today)}`);
    return id;
  } catch {
    return fallback();
  }
}

/** The browser and the operating system as the table names them, from a `User-Agent`. What it cannot tell is `other`. */
export function familiesOf(userAgent: string): { browser: Browser; os: Os } {
  const has = (re: RegExp): boolean => re.test(userAgent);
  const browser: Browser = has(/\bEdg(?:e|A|iOS)?\//)
    ? "edge"
    : has(/\bSamsungBrowser\//)
      ? "samsung"
      : has(/\b(?:OPR|Opera)\//)
        ? "other"
        : has(/\b(?:Firefox|FxiOS)\//)
          ? "firefox"
          : has(/\b(?:Chrome|CriOS)\//)
            ? "chrome"
            : has(/\bVersion\/[\d.]+ .*Safari\//)
              ? "safari"
              : "other";
  const os: Os = has(/\bAndroid\b/) ? "android" : has(/\b(?:iPhone|iPad|iPod)\b/) ? "ios" : has(/\bWindows NT\b/) ? "windows" : has(/\bCrOS\b/) ? "chromeos" : has(/\bMac OS X\b|\bMacintosh\b/) ? "macos" : has(/\bLinux\b/) ? "linux" : "other";
  return { browser, os };
}

/** Where each browser of the table writes its version in a `User-Agent`: the major version is the first number. */
const BROWSER_VERSION: Readonly<Record<Browser, RegExp | null>> = {
  edge: /\bEdg(?:e|A|iOS)?\/(\d+)/,
  samsung: /\bSamsungBrowser\/(\d+)/,
  firefox: /\b(?:Firefox|FxiOS)\/(\d+)/,
  chrome: /\b(?:Chrome|CriOS)\/(\d+)/,
  safari: /\bVersion\/(\d+)/,
  other: null,
};

/**
 * The browser's and the system's versions, from a `User-Agent`, as far as
 * it holds them (ADR-0032; the `User-Agent` only, and nothing else the
 * browser could be asked):
 *
 * - The browser: its major version, and nothing after it. A browser the
 *   table does not name has none.
 * - The system: only where the `User-Agent` holds the true one. Windows'
 *   NT number (10.0 is Windows 10 or 11), iOS, and Android in a browser
 *   that is not Chromium's. Not macOS (every browser writes 10.15), not
 *   ChromeOS, and not Android in Chrome, Edge or Samsung Internet: their
 *   `User-Agent` holds a frozen value (Android 10), and none is better than a
 *   false one.
 *
 * A value not in the form of a version (VERSION) is left out, not shortened.
 */
export function versionsOf(userAgent: string): { browser_version?: string; os_version?: string } {
  const { browser, os } = familiesOf(userAgent);
  const out: { browser_version?: string; os_version?: string } = {};
  const major = BROWSER_VERSION[browser]?.exec(userAgent)?.[1];
  if (major !== undefined && VERSION.test(major)) out.browser_version = major;
  const chromium = browser === "chrome" || browser === "edge" || browser === "samsung";
  const system =
    os === "windows"
      ? /\bWindows NT (\d+\.\d+)/.exec(userAgent)?.[1]
      : os === "ios"
        ? /\bOS (\d+(?:_\d+){0,2}) like Mac OS X/.exec(userAgent)?.[1]?.replaceAll("_", ".")
        : os === "android" && !chromium
          ? /\bAndroid (\d+(?:\.\d+){0,2})/.exec(userAgent)?.[1]
          : undefined;
  if (system !== undefined && VERSION.test(system)) out.os_version = system;
  return out;
}

/** The codes the server answers that the table has a reason for. */
const SERVER_REASONS: ReadonlySet<string> = new Set(Object.keys(REASONS).filter((r) => r.startsWith("server_")));

/**
 * The reason code of a stop: chosen from the table by the stop's own codes,
 * and by nothing else it holds. A stop's detail, path, dates, platform and
 * request ID are not read here.
 */
export function reasonOf(stop: Stop): Reason {
  switch (stop.code) {
    case "card":
      return stop.card;
    case "certificate":
      switch (stop.problem) {
        case "no_certificate":
          return "no_certificate";
        case "expired":
          return "cert_expired";
        case "not_yet_valid":
          return "cert_not_yet_valid";
        case "not_citizen_primary":
          return "cert_not_citizen_primary";
        case "unsupported_format":
          return "cert_unsupported_format";
        case "unknown_issuer":
          return "cert_unknown_issuer";
        case "ambiguous_certificate":
          return "cert_ambiguous";
      }
    // eslint-disable-next-line no-fallthrough
    case "revocation":
      return stop.problem.code;
    case "blocked":
      return `blocked_${stop.reason}`;
    case "server": {
      const reason = `server_${stop.server}`;
      return SERVER_REASONS.has(reason) ? (reason as Reason) : "server_other";
    }
    case "revoked":
    case "card_signature":
    case "challenge_malformed":
    case "challenge_not_today":
    case "idle":
    case "artifact":
    case "engine":
    case "proof_check":
    case "username":
    case "date_changed":
    case "state":
      return stop.code;
  }
}

/** What the flow tells the counts (flow.ts). */
export interface FlowCounts {
  /**
   * A card proof begins: the card is about to be read for it. One that
   * the page's opening began and whose card was not read yet goes on; any
   * other is over, however it ended.
   */
  begin(): void;
  /** The card proof reached a step. A step is sent once in a card proof. */
  step(step: Step): void;
  /** The card proof stopped, and is over. */
  stop(reason: Reason): void;
  /** A step did not pass and can be tried again. */
  retry(reason: Reason): void;
  /** An action of the cardholder's. */
  action(action: CardProofAction): void;
  /** A timed step was done, after `ms` milliseconds: sent as its duration, not the time. */
  duration(step: TimedStep, ms: number): void;
  /**
   * The card reader the card was read in, as the component names it: kept
   * for the rest of the attempt and sent with each of its counts. A name not
   * in its form (READER) is none, and is not shortened or rewritten.
   */
  reader(name: string | null): void;
  /** The card proof device ID, for the submission of a record; null if none could be made. */
  deviceId(): string | null;
}

export interface CountsDeps {
  /** The page's own origin (api.ts, `sameOriginFetch`). */
  fetch: Fetch;
  /** `localStorage`. */
  storage: IdStorage;
  /** Milliseconds since the epoch. */
  clock: () => number;
  /** `crypto.getRandomValues`. */
  random: (bytes: Uint8Array) => Uint8Array;
  /** `navigator.userAgent`: read here for the two names, and not sent. */
  userAgent: string;
}

/** The counts of the card proofs made on one page. */
export function cardProofCounts(deps: CountsDeps): FlowCounts {
  const { browser, os } = familiesOf(deps.userAgent);
  const versions = versionsOf(deps.userAgent);
  /** For a browser whose storage cannot be used: one ID while the page is open. */
  let pageId: string | null = null;
  const deviceId = (): string => deviceIdOn(taiwanDay(deps.clock()), deps.storage, deps.random, () => (pageId ??= newId(deps.random)));
  /** The attempt under way, the steps sent in it and its card reader's name; null when the next count begins one. */
  type Attempt = { id: string; steps: Set<Step>; reader: string | null };
  let attempt: Attempt | null = null;
  const current = (): Attempt => (attempt ??= { id: newId(deps.random), steps: new Set(), reader: null });

  const send = (members: Record<string, string>): void => {
    try {
      const device = deviceId();
      const { id, reader } = current();
      if (!COUNT_ID.test(device) || !COUNT_ID.test(id)) return;
      const body = JSON.stringify({ client: "web", ...members, device_id: device, attempt_id: id, browser, os, ...versions, ...(reader !== null && { reader }) });
      // Not awaited, and its failure is nobody's: a count never holds a card proof up, and is not sent again.
      void Promise.resolve()
        .then(() => deps.fetch("/api/v1/counts", { method: "POST", body, keepalive: true }))
        .then((res) => res.body?.cancel())
        .catch(() => undefined);
    } catch {
      // A count that cannot be made is not sent.
    }
  };

  return {
    begin() {
      if (attempt?.steps.has("read")) attempt = null;
    },
    step(step) {
      try {
        const now = current();
        if (now.steps.has(step)) return;
        now.steps.add(step);
      } catch {
        // Without a random source there is no attempt, and no count.
        return;
      }
      send({ event: "step", step });
      if (step === "done") attempt = null;
    },
    stop(reason) {
      send({ event: "stop", reason });
      attempt = null;
    },
    retry(reason) {
      send({ event: "retry", reason });
    },
    action(action) {
      send({ event: "action", action });
    },
    duration(step, ms) {
      const took = tookOf(ms);
      if (took !== null) send({ event: "duration", step, took });
    },
    reader(name) {
      try {
        current().reader = name !== null && READER.test(name) ? name : null;
      } catch {
        // Without a random source there is no attempt, and no count to carry it.
      }
    },
    deviceId() {
      try {
        const id = deviceId();
        return COUNT_ID.test(id) ? id : null;
      } catch {
        return null;
      }
    },
  };
}
