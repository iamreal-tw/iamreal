// A fake server that answers as docs/api/card-proof.md says, and logs every
// request it gets. Tests change one answer at a time to something the device
// must not accept, then check that the device stopped and that no request
// carried the reason. Used in Node (as a fetch) and by the headless browser
// test's HTTP server.
//
// It keeps a small roster of its own, for one card: what the default answers
// to card-state and to a submission say, by the event rules of
// spec/roster-rules.md (src/spec/roster-rules.ts), so that card proofs one
// after the other see each other. It verifies nothing: no proof, no
// challenge, no root. A test that sets `cardState` answers card-state with it
// as it is, and the default submission's kinds are then computed against it
// (and the roster of its own is left as it was).
import { sha256Hex } from "../../src/bytes.ts";
import { encodeBase32 } from "../../src/spec/base32.ts";
import { type Day, formatDay, parseDay, taiwanDay } from "../../src/spec/date.ts";
import { type SlotState, applyKind, dailyLimitReached, listOutcome } from "../../src/spec/roster-rules.ts";

export interface LoggedRequest {
  method: string;
  path: string;
  body: string;
}

/** A row of the platform table as `config` sends it. */
export interface PlatformTableRow {
  platform: string;
  display_name: string;
  username_format: string;
}

/** The test roster's table (spec/scope.md), as server/ sends it. */
export const TEST_PLATFORMS: readonly PlatformTableRow[] = [
  { platform: "test-example", display_name: "Example (no real service)", username_format: "[a-z0-9-]{1,20}" },
  { platform: "threads", display_name: "Threads", username_format: "[a-z0-9._]{1,30}" },
];

export interface BackendOptions {
  /** Static files by path: the mirror (/crl/...), circuits, CRS. */
  files: Map<string, Uint8Array>;
  clock: () => number;
  /** The challenge to issue; by default today's date and 16 random bytes. */
  challenge?: () => unknown;
  crlMaxAgeDays?: unknown;
  /** The platform table of `config`; TEST_PLATFORMS by default. */
  platforms?: unknown;
  /** The whole body of `config`, as it is; overrides the two above. */
  config?: unknown;
  /** The answer to card-state, as it is; by default the roster of its own. */
  cardState?: Record<string, unknown>;
  /** The answer to a submission; by default 201 with the kinds of the roster of its own. */
  submit?: (body: Record<string, unknown>) => { status: number; body: unknown };
}

export interface Answer {
  status: number;
  type: string;
  bytes: Uint8Array;
}

interface Card {
  lastCardProof: Day | null;
  proofsOnLastDate: number;
  slots: Map<string, SlotState>;
}

const emptyCard = (platforms: readonly string[]): Card => ({
  lastCardProof: null,
  proofsOnLastDate: 0,
  slots: new Map(platforms.map((p) => [p, { current: null, lastDeclared: null, switchCount: 0, correctionDate: null }])),
});

/** A card-state answer, read back into the roster's terms (loosely: it is the test's own). */
function cardOf(answer: Record<string, unknown>): Card {
  const day = (x: unknown): Day | null => (typeof x === "string" ? parseDay(x) : null);
  const slots = new Map<string, SlotState>();
  const platforms = typeof answer.platforms === "object" && answer.platforms !== null ? (answer.platforms as Record<string, Record<string, unknown>>) : {};
  for (const [p, e] of Object.entries(platforms)) {
    if (typeof e !== "object" || e === null) continue;
    const current = typeof e.current === "string" ? e.current : null;
    slots.set(p, {
      current,
      lastDeclared: typeof e.last_declared === "string" ? e.last_declared : current,
      switchCount: typeof e.switch_count === "number" ? e.switch_count : 0,
      correctionDate: day(e.correction_date),
    });
  }
  return { lastCardProof: day(answer.last_card_proof), proofsOnLastDate: typeof answer.proofs_on_last_date === "number" ? answer.proofs_on_last_date : 0, slots };
}

export class FakeBackend {
  readonly log: LoggedRequest[] = [];
  readonly submissions: Record<string, unknown>[] = [];
  readonly opts: BackendOptions;
  /** The roster of its own: one card. */
  card: Card;

  constructor(opts: BackendOptions) {
    this.opts = opts;
    this.card = emptyCard(this.table().map((r) => r.platform));
  }

  private table(): readonly PlatformTableRow[] {
    return Array.isArray(this.opts.platforms) ? (this.opts.platforms as PlatformTableRow[]) : TEST_PLATFORMS;
  }

  /** The card-state answer of the roster of its own. */
  stateAnswer(): Record<string, unknown> {
    const c = this.card;
    return {
      last_card_proof: c.lastCardProof === null ? null : formatDay(c.lastCardProof),
      proofs_on_last_date: c.proofsOnLastDate,
      platforms: Object.fromEntries(
        [...c.slots].map(([p, s]) => [p, { current: s.current, last_declared: s.lastDeclared, switch_count: s.switchCount, correction_date: s.correctionDate === null ? null : formatDay(s.correctionDate) }]),
      ),
      count: this.submissions.length,
      head: "a".repeat(64),
    };
  }

  private json(status: number, body: unknown): Answer {
    return { status, type: "application/json", bytes: new TextEncoder().encode(JSON.stringify(body)) };
  }

  /** The default answer to a submission: the event rules against the card's state. */
  private async accept(body: Record<string, unknown>, raw: string): Promise<Answer> {
    const own = this.opts.cardState === undefined;
    const card = own ? this.card : cardOf(this.opts.cardState!);
    const accounts = Array.isArray(body.accounts) ? (body.accounts as { platform: string; username: string }[]) : [];
    const list = new Map(accounts.map((a) => [a.platform, a.username]));
    const d = parseDay(String(body.challenge).slice(0, 10)) ?? taiwanDay(this.opts.clock());
    const o = listOutcome(card.slots, list, d);
    if (!o.valid) return this.json(400, { error: o.reason });
    if (dailyLimitReached(card, d)) return this.json(400, { error: "daily_limit" });
    const kinds = o.kinds.map((k) => ({
      platform: k.platform,
      kind: k.kind,
      username: k.kind === "withdraw" ? card.slots.get(k.platform)!.current! : list.get(k.platform)!,
      account_cards: k.kind === "withdraw" ? 0 : 1,
    }));
    if (own) {
      for (const k of o.kinds) card.slots.set(k.platform, applyKind(card.slots.get(k.platform) ?? { current: null, lastDeclared: null, switchCount: 0, correctionDate: null }, k.kind, list.get(k.platform) ?? null, d));
      if (card.lastCardProof === null || d > card.lastCardProof) [card.lastCardProof, card.proofsOnLastDate] = [d, 1];
      else if (d === card.lastCardProof) card.proofsOnLastDate++;
    }
    return this.json(201, { seq: this.submissions.length, record_hash: await sha256Hex(new TextEncoder().encode(raw)), kinds });
  }

  async handle(method: string, path: string, body: string): Promise<Answer> {
    this.log.push({ method, path, body });
    const o = this.opts;
    if (method === "GET" && o.files.has(path)) {
      const type = path.endsWith(".json") ? "application/json" : "application/octet-stream";
      return { status: 200, type, bytes: o.files.get(path)! };
    }
    if (method === "GET" && path === "/api/v1/config") {
      if ("config" in o) return this.json(200, o.config);
      return this.json(200, { crl_max_age_days: o.crlMaxAgeDays ?? 3, platforms: "platforms" in o ? o.platforms : TEST_PLATFORMS });
    }
    if (method === "POST" && path === "/api/v1/challenges") {
      const c = o.challenge ? o.challenge() : `${formatDay(taiwanDay(o.clock()))}.${encodeBase32(crypto.getRandomValues(new Uint8Array(16)))}`;
      return this.json(200, { challenge: c });
    }
    if (method === "POST" && path === "/api/v1/card-state") {
      return this.json(200, o.cardState ?? this.stateAnswer());
    }
    if (method === "POST" && path === "/api/v1/records") {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      this.submissions.push(parsed);
      if (o.submit) {
        const r = o.submit(parsed);
        return this.json(r.status, r.body);
      }
      return this.accept(parsed, body);
    }
    return this.json(404, { error: "not_found" });
  }

  /** The device's fetch, answered by this backend. */
  fetch = async (path: string, init?: { method: "GET" | "POST"; body?: string }): Promise<Response> => {
    const a = await this.handle(init?.method ?? "GET", path, init?.body ?? "");
    return new Response(a.bytes as BodyInit, { status: a.status, headers: { "Content-Type": a.type } });
  };
}
