// A fake server that answers as docs/api/card-proof.md says, and logs every
// request it gets. Tests change one answer at a time to something the device
// must not accept, then check that the device stopped and that no request
// carried the reason. Used in Node (as a fetch) and by the headless browser
// test's HTTP server.
//
// It keeps a small proof log of its own, for one card: what the default answers
// to card-state and to a submission say, by the record rules
// (spec/record-rules.md, applyRecord of protocol/src/record-rules.ts), so
// that card proofs one after the other see each other. It verifies nothing:
// no proof, no challenge, no root. A test that sets `cardState` answers card-state with it
// as it is, and the default submission's kinds are then computed against it
// (and the proof log of its own is left as it was).
import { sha256Hex } from "iamreal-protocol/bytes.ts";
import { encodeBase32 } from "iamreal-protocol/base32.ts";
import { type Day, formatDay, parseDay, taiwanDay } from "iamreal-protocol/date.ts";
import type { PlatformRow } from "iamreal-protocol/platforms.ts";
import { type CardState, type SlotState, applyRecord, newCard } from "iamreal-protocol/record-rules.ts";
import { isAnyUsername, parseUsernameFormat } from "iamreal-protocol/username-format.ts";

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

/** The test log's table (spec/scope.md), as `config` sends it. */
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
  /** The answer to card-state, as it is; by default the proof log of its own. */
  cardState?: Record<string, unknown>;
  /** The answer to a submission; by default 201 with the kinds of the proof log of its own. */
  submit?: (body: Record<string, unknown>) => { status: number; body: unknown };
}

export interface Answer {
  status: number;
  type: string;
  bytes: Uint8Array;
}

/** A card-state answer, read back into the proof log's terms (loosely: it is the test's own). */
function cardOf(answer: Record<string, unknown>): CardState {
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
  /** The proof log of its own: one card. */
  card: CardState;

  constructor(opts: BackendOptions) {
    this.opts = opts;
    this.card = newCard(this.rows());
  }

  /**
   * The platform table of this server's proof log, as it sends it: the one of
   * its `config` (`config` whole, else `platforms`), or TEST_PLATFORMS when
   * the test made that answer something that is not a table.
   */
  private table(): readonly PlatformTableRow[] {
    const o = this.opts;
    const sent = "config" in o ? (o.config as { platforms?: unknown } | null)?.platforms : o.platforms;
    const rows = Array.isArray(sent) ? sent.filter((r): r is PlatformTableRow => typeof r === "object" && r !== null && typeof r.platform === "string") : [];
    return rows.length > 0 ? rows : TEST_PLATFORMS;
  }

  /**
   * The same table as the rows the record rules take. A test gives a row a
   * format no device reads to see what the device does; this server then
   * checks the usernames of that platform as any username.
   */
  private rows(): PlatformRow[] {
    return this.table().map((r) => ({
      platform: r.platform,
      displayName: String(r.display_name),
      format: parseUsernameFormat(r.username_format) ?? { text: String(r.username_format), min: 1, max: Number.MAX_SAFE_INTEGER, accepts: isAnyUsername },
    }));
  }

  /** The card-state answer of the proof log of its own. */
  stateAnswer(): Record<string, unknown> {
    const c = this.card;
    return {
      last_card_proof: c.lastCardProof === null ? null : formatDay(c.lastCardProof),
      proofs_on_last_date: c.proofsOnLastDate,
      platforms: Object.fromEntries(
        [...c.slots].map(([p, s]) => [p, { current: s.current, last_declared: s.lastDeclared, switch_count: s.switchCount, correction_date: s.correctionDate === null ? null : formatDay(s.correctionDate) }]),
      ),
      count: this.submissions.length,
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
    // The record rules for a proof log of one card, on this server's platform
    // table, with the answers this server does not check: the record
    // verifies, its challenge is new, its root is recognized. A list that is
    // not a record's (a platform outside the table, a username outside its
    // platform's format) makes applyRecord throw.
    const o = applyRecord({
      platforms: this.rows(),
      record: { accounts, date: d, verifies: true },
      card,
      latestValidDate: card.lastCardProof,
      challengeUsed: false,
      crlDates: [d],
    });
    if (!o.result.valid) return this.json(400, { error: o.result.reason });
    const kinds = o.result.kinds.map((k) => ({
      platform: k.platform,
      kind: k.kind,
      username: k.kind === "withdraw" ? card.slots.get(k.platform)!.current! : list.get(k.platform)!,
      account_cards: k.kind === "withdraw" ? 0 : 1,
    }));
    if (own) this.card = o.card;
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
      // An answer of its own (an error such as 503 paused): { status, body } as it is.
      if (typeof c === "object" && c !== null && "status" in c) {
        const a = c as unknown as { status: number; body: unknown };
        return this.json(a.status, a.body);
      }
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
